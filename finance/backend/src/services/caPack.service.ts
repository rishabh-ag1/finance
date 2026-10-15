import ExcelJS from 'exceljs';
import type { Attachment } from '@prisma/client';
import { prisma } from '../config/database';
import { crmCompanies } from '../crm/reader';
import { b2cSummary, hsnSummary, tieOut, type GstLine } from '../lib/caPack';
import { dateText, parseDate } from '../lib/dates';
import { todayIST } from '../lib/fy';
import { UserError } from '../lib/http';
import { Decimal } from '../lib/money';
import { NATURE_LABELS } from '../lib/nature';
import { getCompany } from './settings.service';

/**
 * M17 CA pack (F180, F181). One Excel workbook per month for the CA, who keeps the books in Tally
 * (Q16): bank transactions with category, party, GST and TDS; vendor bills; sales invoices; credit
 * notes; receipts; payments; TDS; funding; and the GST working (outward by invoice, B2C by state,
 * HSN summary tied to the invoices, inward with input credit). Every row with a file links to it.
 */

const zero = () => new Decimal(0);
const n = (d: Decimal | null | undefined) => (d ? Number(d.toFixed(2)) : 0);
const sum = <T>(xs: T[], f: (x: T) => Decimal) => xs.reduce((s, x) => s.plus(f(x)), zero());

function monthRange(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new UserError('Choose a month (YYYY-MM)');
  const from = `${month}-01`;
  const [y, m] = month.split('-').map(Number);
  const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { from, to, gte: parseDate(from), lte: parseDate(to) };
}

/** Where a CA can open a file: the Drive file, or the app's download link while files are local (D11). */
export function fileLink(a: Pick<Attachment, 'id' | 'storage' | 'storageKey'> | null | undefined) {
  if (!a) return null;
  if (a.storage === 'drive') return `https://drive.google.com/file/d/${a.storageKey}/view`;
  return `${(process.env.PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? 3100}/api`).replace(/\/$/, '')}/attachments/${a.id}/file`;
}

async function filesFor(recordType: string, ids: string[]) {
  if (!ids.length) return new Map<string, Attachment>();
  const rows = await prisma.attachment.findMany({ where: { recordType, recordId: { in: ids }, isArchived: false }, orderBy: { createdAt: 'asc' } });
  const out = new Map<string, Attachment>();
  for (const r of rows) if (!out.has(r.recordId)) out.set(r.recordId, r);
  return out;
}

async function collect(month: string) {
  const r = monthRange(month);
  const inMonth = (field: string) => ({ [field]: { gte: r.gte, lte: r.lte } });

  // Bank transactions of the company's own accounts.
  const txns = await prisma.bankTxn.findMany({
    where: { ...inMonth('txnDate'), bankAccount: { owner: 'Entelechy' } },
    include: { bankAccount: true, splits: { where: { isArchived: false }, orderBy: { lineNo: 'asc' } } }, orderBy: [{ bankAccountId: 'asc' }, { txnDate: 'asc' }, { seq: 'asc' }],
  });
  const cats = new Map((await prisma.category.findMany({ include: { subCategories: true } })).flatMap((c) => [[c.id, c.name] as [string, string], ...c.subCategories.map((s) => [s.id, s.name] as [string, string])]));
  const vendorIds = new Set(txns.filter((t) => t.partyType === 'vendor' && t.partyId).map((t) => t.partyId!));
  const companyIds = new Set(txns.filter((t) => t.partyType === 'customer' && t.partyId).map((t) => t.partyId!));

  const bills = await prisma.vendorDocument.findMany({ where: { ...inMonth('docDate'), status: { notIn: ['cancelled'] } }, include: { vendor: true }, orderBy: { docDate: 'asc' } });
  bills.forEach((b) => vendorIds.add(b.vendorId));
  const payments = await prisma.paymentOut.findMany({ where: { ...inMonth('paidDate'), status: { in: ['paid', 'reconciled'] } }, include: { vendor: true, allocations: { where: { isArchived: false } } }, orderBy: { paidDate: 'asc' } });
  const docsPaid = new Map((await prisma.vendorDocument.findMany({ where: { id: { in: payments.flatMap((p) => p.allocations.map((a) => a.docId).filter(Boolean) as string[]) } } })).map((d) => [d.id, d]));
  const sales = await prisma.salesDocument.findMany({ where: { ...inMonth('docDate'), status: { in: ['issued', 'cancelled'] }, docType: { in: ['tax_invoice', 'credit_note'] } }, include: { lines: { where: { isArchived: false }, orderBy: { lineNo: 'asc' } } }, orderBy: [{ docDate: 'asc' }, { docNumber: 'asc' }] });
  const against = new Map((await prisma.salesDocument.findMany({ where: { id: { in: sales.map((s) => s.againstInvoiceId).filter(Boolean) as string[] } } })).map((d) => [d.id, d]));
  const receipts = await prisma.receipt.findMany({ where: { ...inMonth('receiptDate') }, include: { allocations: { where: { isArchived: false } } }, orderBy: { receiptDate: 'asc' } });
  const receiptDocs = new Map((await prisma.salesDocument.findMany({ where: { id: { in: receipts.flatMap((x) => x.allocations.map((a) => a.docId)) } } })).map((d) => [d.id, d]));
  const tds = await prisma.tdsEntry.findMany({ where: { ...inMonth('deductionDate'), status: { not: 'cancelled' } }, include: { challan: true }, orderBy: { deductionDate: 'asc' } });
  tds.forEach((t) => vendorIds.add(t.vendorId));
  const challans = await prisma.tdsChallan.findMany({ where: { ...inMonth('depositDate'), isCancelled: false } });
  const sections = new Map((await prisma.tdsSection.findMany()).map((s) => [s.id, s]));
  const capital = await prisma.capitalReceipt.findMany({ where: { ...inMonth('receiptDate'), status: 'recorded' } });
  const loansIn = await prisma.loan.findMany({ where: { ...inMonth('disbursedDate'), status: { not: 'cancelled' } } });
  const repayments = await prisma.loanRepayment.findMany({ where: { ...inMonth('paidDate'), status: 'recorded' }, include: { loan: true } });

  const vendors = new Map((await prisma.vendor.findMany({ where: { id: { in: [...vendorIds] } } })).map((v) => [v.id, v]));
  const companies = new Map((await crmCompanies({ ids: [...companyIds] })).map((c) => [c.id, c.name]));

  // What each bank row is linked to, by its document number.
  const ref = async (type: string | null, id: string | null): Promise<string | null> => {
    if (!type || !id) return null;
    switch (type) {
      case 'PaymentOut': return (await prisma.paymentOut.findUnique({ where: { id } }))?.paymentNo ?? null;
      case 'Receipt': return (await prisma.receipt.findUnique({ where: { id } }))?.receiptNo ?? null;
      case 'SettlementBatch': { const b = await prisma.settlementBatch.findUnique({ where: { id } }); return b ? `${b.source === 'razorpay' ? 'Razorpay' : 'COD'} ${b.externalId}` : null; }
      case 'CrmOrder': return `Order ${id}`;
      case 'Loan': { const l = await prisma.loan.findUnique({ where: { id } }); return l ? `Loan ${l.lender}` : null; }
      case 'LoanRepayment': { const x = await prisma.loanRepayment.findUnique({ where: { id }, include: { loan: true } }); return x ? `Repayment ${x.loan.lender}` : null; }
      case 'CapitalReceipt': { const c = await prisma.capitalReceipt.findUnique({ where: { id } }); return c ? `Capital ${c.holderName}` : null; }
      case 'TdsChallan': { const c = await prisma.tdsChallan.findUnique({ where: { id } }); return c ? `Challan ${c.bsrCode}-${c.challanSerial}` : null; }
      case 'Reimbursement': return (await prisma.reimbursement.findUnique({ where: { id } }))?.reimbursementNo ?? null;
      default: return type;
    }
  };
  const statementFiles = await filesFor('BankImportBatch', [...new Set(txns.map((t) => t.batchId).filter(Boolean) as string[])]);
  const linkedPayments = new Map((await prisma.paymentOut.findMany({ where: { id: { in: txns.filter((t) => t.linkedDocType === 'PaymentOut').map((t) => t.linkedDocId!) } }, include: { allocations: { where: { isArchived: false } } } })).map((p) => [p.id, p]));
  const linkedReceipts = new Map((await prisma.receipt.findMany({ where: { id: { in: txns.filter((t) => t.linkedDocType === 'Receipt').map((t) => t.linkedDocId!) } } })).map((x) => [x.id, x]));
  const billGst = new Map((await prisma.vendorDocument.findMany({ where: { id: { in: [...linkedPayments.values()].flatMap((p) => p.allocations.map((a) => a.docId).filter(Boolean) as string[]) } } })).map((d) => [d.id, d.cgst.plus(d.sgst).plus(d.igst)]));

  const bank: Record<string, unknown>[] = [];
  for (const t of txns) {
    const party = t.partyType === 'vendor' ? vendors.get(t.partyId ?? '')?.displayName : t.partyType === 'customer' ? companies.get(t.partyId ?? '') ?? null : t.counterpartyName;
    const linked = await ref(t.linkedDocType, t.linkedDocId);
    const p = t.linkedDocType === 'PaymentOut' ? linkedPayments.get(t.linkedDocId!) : null;
    const rc = t.linkedDocType === 'Receipt' ? linkedReceipts.get(t.linkedDocId!) : null;
    const gst = p ? sum(p.allocations.filter((a) => a.docId), (a) => billGst.get(a.docId!) ?? zero()) : null;
    const tdsAmt = p ? p.tdsAmount : rc ? rc.tds : null;
    const base = {
      date: dateText(t.txnDate), account: `${t.bankAccount.bankName} ${t.bankAccount.accountNumber.slice(-4)}`, narration: t.narrationRaw, utr: t.utr, party: party ?? t.counterpartyName,
      status: t.status, linked, gst: gst ? n(gst) : null, tds: tdsAmt ? n(tdsAmt) : null, notes: [t.description, t.notes].filter(Boolean).join(' · ') || null, manual: t.isManual ? 'Manual' : null,
      file: fileLink(t.batchId ? statementFiles.get(t.batchId) : null),
    };
    if (t.status === 'split' && t.splits.length) {
      for (const s of t.splits) {
        bank.push({ ...base, debit: t.debit.greaterThan(0) ? n(s.amount) : null, credit: t.credit.greaterThan(0) ? n(s.amount) : null, balance: null, category: cats.get(s.categoryId) ?? null, subCategory: s.subCategoryId ? cats.get(s.subCategoryId) ?? null : null, nature: NATURE_LABELS[s.nature] ?? s.nature, notes: [s.description, s.note].filter(Boolean).join(' · ') || base.notes, line: `Split line ${s.lineNo}` });
      }
    } else {
      bank.push({ ...base, debit: t.debit.greaterThan(0) ? n(t.debit) : null, credit: t.credit.greaterThan(0) ? n(t.credit) : null, balance: t.balance ? n(t.balance) : null, category: t.categoryId ? cats.get(t.categoryId) ?? null : null, subCategory: t.subCategoryId ? cats.get(t.subCategoryId) ?? null : null, nature: t.nature ? NATURE_LABELS[t.nature] ?? t.nature : null, line: null });
    }
  }

  const billFiles = await filesFor('VendorDocument', bills.map((b) => b.id));
  const billRows = bills.map((b) => ({
    type: b.docType.replace('_', ' '), number: b.docNumber, date: dateText(b.docDate), vendor: b.vendor.legalName ?? b.vendor.displayName, gstin: b.vendor.gstin, pan: b.vendor.pan, pos: b.placeOfSupplyState,
    reverseCharge: b.reverseCharge ? 'Yes' : 'No', taxable: n(b.taxableValue), cgst: n(b.cgst), sgst: n(b.sgst), igst: n(b.igst), other: n(b.otherCharges), roundOff: n(b.roundOff), total: n(b.totalValue),
    itc: b.itcEligible ? 'Yes' : 'No', tdsSection: b.tdsSectionId ? sections.get(b.tdsSectionId)?.codeOldAct ?? null : null, tds: n(b.tdsAmount), category: b.categoryId ? cats.get(b.categoryId) ?? null : null,
    subCategory: b.subCategoryId ? cats.get(b.subCategoryId) ?? null : null, status: b.status, file: fileLink(billFiles.get(b.id)),
  }));

  const pdfs = new Map((await prisma.attachment.findMany({ where: { id: { in: sales.map((s) => s.pdfAttachmentId).filter(Boolean) as string[] } } })).map((a) => [a.id, a]));
  const party = (d: (typeof sales)[number]) => d.billTo as { name: string; gstin: string | null };
  const invoices = sales.filter((d) => d.docType === 'tax_invoice');
  const credits = sales.filter((d) => d.docType === 'credit_note');
  const invoiceRows = invoices.map((d) => ({
    number: d.docNumber, date: dateText(d.docDate), customer: party(d).name, gstin: party(d).gstin, supply: d.supplyType.toUpperCase(), pos: d.placeOfSupply, crmOrder: d.crmOrderNumber,
    taxable: n(d.taxable), cgst: n(d.cgst), sgst: n(d.sgst), igst: n(d.igst), roundOff: n(d.roundOff), total: n(d.total), status: d.status === 'cancelled' ? `Cancelled: ${d.statusReason}` : 'Issued', file: fileLink(d.pdfAttachmentId ? pdfs.get(d.pdfAttachmentId) : null),
  }));
  const creditRows = credits.map((d) => ({
    number: d.docNumber, date: dateText(d.docDate), against: d.againstInvoiceId ? against.get(d.againstInvoiceId)?.docNumber ?? null : null, customer: party(d).name, gstin: party(d).gstin, reason: d.creditReason, supply: d.supplyType.toUpperCase(), pos: d.placeOfSupply,
    taxable: n(d.taxable), cgst: n(d.cgst), sgst: n(d.sgst), igst: n(d.igst), total: n(d.total), status: d.status === 'cancelled' ? `Cancelled: ${d.statusReason}` : 'Issued', file: fileLink(d.pdfAttachmentId ? pdfs.get(d.pdfAttachmentId) : null),
  }));

  const receiptRows = receipts.map((x) => ({
    number: x.receiptNo, date: dateText(x.receiptDate), customer: x.customerName, mode: x.mode, reference: x.reference, amount: n(x.amount), tds: n(x.tds), charges: n(x.bankCharges), gstOnCharges: n(x.gstOnCharges),
    against: x.allocations.map((a) => receiptDocs.get(a.docId)?.docNumber).filter(Boolean).join(', ') || 'Advance', crmOrder: x.crmOrderNumber, status: x.status === 'cancelled' ? `Cancelled: ${x.statusReason}` : 'Recorded',
  }));
  const paymentFiles = await filesFor('PaymentOut', payments.map((p) => p.id));
  const paymentRows = payments.map((p) => ({
    number: p.paymentNo, date: dateText(p.paidDate), vendor: p.vendor.legalName ?? p.vendor.displayName, mode: p.mode, utr: p.utr, amount: n(p.amount), tds: n(p.tdsAmount),
    against: p.allocations.map((a) => (a.docId ? docsPaid.get(a.docId)?.docNumber : 'PO advance')).filter(Boolean).join(', '), status: p.status, file: fileLink(paymentFiles.get(p.id)),
  }));
  const challanFiles = await filesFor('TdsChallan', challans.map((c) => c.id));
  const tdsRows = tds.map((t) => ({
    date: dateText(t.deductionDate), vendor: vendors.get(t.vendorId)?.legalName ?? vendors.get(t.vendorId)?.displayName ?? '', pan: t.pan, section: sections.get(t.sectionId)?.codeOldAct ?? '', base: n(t.baseAmount), rate: Number(t.rate.toString()), tds: n(t.tdsAmount),
    status: t.status, challan: t.challan ? `${t.challan.bsrCode}-${t.challan.challanSerial} ${dateText(t.challan.depositDate)}` : null, file: fileLink(t.challanId ? challanFiles.get(t.challanId) : null),
  }));
  const challanRows = challans.map((c) => ({ date: dateText(c.depositDate), bsr: c.bsrCode, serial: c.challanSerial, section: sections.get(c.sectionId)?.codeOldAct ?? '', tds: n(c.tdsAmount), interest: n(c.interest), fee: n(c.fee), total: n(c.total), file: fileLink(challanFiles.get(c.id)) }));

  const loanFiles = await filesFor('Loan', loansIn.map((l) => l.id));
  const fundingRows = [
    ...capital.map((c) => ({ date: dateText(c.receiptDate), kind: c.type === 'paid_up_capital' ? 'Paid-up capital' : 'Share application money', party: c.holderName, inflow: n(c.amount), principal: null, interest: null, note: c.allotmentDate ? `Allotted ${dateText(c.allotmentDate)}, ${c.sharesAllotted} shares` : null, file: null })),
    ...loansIn.map((l) => ({ date: dateText(l.disbursedDate), kind: 'Loan received', party: l.lender, inflow: n(l.disbursedAmount), principal: null, interest: null, note: `${l.repaymentType}, ${l.tenureMonths} months${l.interestRate ? `, ${l.interestRate}%` : ''}`, file: fileLink(loanFiles.get(l.id)) })),
    ...repayments.map((x) => ({ date: dateText(x.paidDate), kind: 'Loan repayment', party: x.loan.lender, inflow: null, principal: n(x.principal), interest: n(x.interest), note: x.reference, file: null })),
  ].sort((a, b) => (a.date! < b.date! ? -1 : 1));

  // F181 GST working: issued (not cancelled) invoices and credit notes.
  const live = sales.filter((d) => d.status === 'issued');
  const gstLines: GstLine[] = live.flatMap((d) => d.lines.map((l) => ({ hsnSac: l.hsnSac, gstRate: l.gstRate, qty: l.qty, taxable: l.taxable, cgst: l.cgst, sgst: l.sgst, igst: l.igst, isCredit: d.docType === 'credit_note' })));
  const hsn = hsnSummary(gstLines);
  const tie = tieOut(hsn, { invoicesTaxable: sum(live.filter((d) => d.docType === 'tax_invoice'), (d) => d.taxable), creditsTaxable: sum(live.filter((d) => d.docType === 'credit_note'), (d) => d.taxable) });
  const b2b = live.filter((d) => d.supplyType === 'b2b').map((d) => ({ type: d.docType === 'credit_note' ? 'Credit note' : 'Invoice', number: d.docNumber, date: dateText(d.docDate), gstin: party(d).gstin, customer: party(d).name, pos: d.placeOfSupply, taxable: n(d.taxable), cgst: n(d.cgst), sgst: n(d.sgst), igst: n(d.igst), total: n(d.total) }));
  const b2c = b2cSummary(live.filter((d) => d.supplyType === 'b2c').flatMap((d) => d.lines.map((l) => ({ placeOfSupply: d.placeOfSupply, gstRate: l.gstRate, taxable: l.taxable, cgst: l.cgst, sgst: l.sgst, igst: l.igst, isCredit: d.docType === 'credit_note' }))));
  const inward = bills.filter((b) => b.docType === 'tax_invoice' || b.docType === 'debit_note' || b.docType === 'credit_note').map((b) => {
    const s = b.docType === 'credit_note' ? -1 : 1;
    return { type: b.docType.replace('_', ' '), number: b.docNumber, date: dateText(b.docDate), vendor: b.vendor.legalName ?? b.vendor.displayName, gstin: b.vendor.gstin, taxable: n(b.taxableValue) * s, cgst: n(b.cgst) * s, sgst: n(b.sgst) * s, igst: n(b.igst) * s, itc: b.itcEligible ? 'Yes' : 'No', reverseCharge: b.reverseCharge ? 'Yes' : 'No' };
  });
  const gatewayGst = receipts.filter((x) => x.status === 'recorded' && x.gstOnCharges.greaterThan(0));
  if (gatewayGst.length) inward.push({ type: 'gateway fees', number: `${gatewayGst.length} settlement receipt(s)`, date: r.to, vendor: 'Razorpay (fees on settlements)', gstin: null, taxable: n(sum(gatewayGst, (x) => x.bankCharges.minus(x.gstOnCharges))), cgst: 0, sgst: 0, igst: n(sum(gatewayGst, (x) => x.gstOnCharges)), itc: 'Check Razorpay invoice', reverseCharge: 'No' });

  return {
    month, from: r.from, to: r.to, bank, bills: billRows, invoices: invoiceRows, credits: creditRows, receipts: receiptRows, payments: paymentRows, tds: tdsRows, challans: challanRows, funding: fundingRows,
    gst: { b2b, b2c, hsn, tie, inward },
  };
}

type Col = { header: string; key: string; width: number; money?: boolean };

function sheet(wb: ExcelJS.Workbook, name: string, cols: Col[], rows: Record<string, unknown>[], note?: string) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: note ? 2 : 1 }] });
  if (note) {
    ws.addRow([note]);
    ws.getRow(1).font = { italic: true, color: { argb: 'FF555555' } };
  }
  const head = ws.addRow(cols.map((c) => c.header));
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0C2C55' } }; });
  cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; if (c.money) ws.getColumn(i + 1).numFmt = '#,##0.00'; });
  for (const r of rows) {
    const row = ws.addRow(cols.map((c) => (c.key === 'file' ? null : r[c.key] ?? null)));
    const fi = cols.findIndex((c) => c.key === 'file');
    if (fi >= 0 && typeof r.file === 'string') row.getCell(fi + 1).value = { text: 'Open file', hyperlink: r.file };
  }
  return ws;
}

/** The figures the page shows before download: rows per sheet, totals and the HSN tie-out. */
export async function caPackSummary(month: string) {
  const d = await collect(month);
  return {
    month: d.month, from: d.from, to: d.to,
    counts: { bank: d.bank.length, bills: d.bills.length, invoices: d.invoices.length, credits: d.credits.length, receipts: d.receipts.length, payments: d.payments.length, tds: d.tds.length, funding: d.funding.length },
    unreviewed: d.bank.filter((x) => x.status === 'review' || x.status === 'suggested').length,
    withoutFile: d.bills.filter((b) => !b.file).length + d.invoices.filter((x) => !x.file).length,
    tie: d.gst.tie, hsn: d.gst.hsn,
  };
}

export async function caPackWorkbook(month: string): Promise<{ buffer: Buffer; fileName: string }> {
  const d = await collect(month);
  const company = await getCompany();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Entelechy Finance';
  wb.created = new Date();
  const label = new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const summary = wb.addWorksheet('Summary');
  summary.columns = [{ width: 42 }, { width: 22 }];
  [
    [`${company.legalName}: CA pack for ${label}`], [`GSTIN ${company.gstin ?? ''} · PAN ${company.pan ?? ''}`], [`Period ${d.from} to ${d.to}; made ${todayIST()} from the Finance app`], [],
    ['Sheet', 'Rows'], ['Bank transactions', d.bank.length], ['Vendor bills', d.bills.length], ['Sales invoices', d.invoices.length], ['Credit notes', d.credits.length], ['Receipts', d.receipts.length],
    ['Payments', d.payments.length], ['TDS deducted', d.tds.length], ['TDS challans', d.challans.length], ['Funding', d.funding.length], [],
    ['Bank rows not yet reviewed', d.bank.filter((x) => x.status === 'review' || x.status === 'suggested').length],
    ['HSN summary taxable', Number(d.gst.tie.hsnTaxable)], ['Invoices less credit notes, taxable', Number(d.gst.tie.documentsTaxable)], ['Difference', Number(d.gst.tie.difference)], [],
    ['The GST working is information for the CA, not a GSTR file. Files open from the "Open file" links.'],
  ].forEach((row) => summary.addRow(row));
  summary.getRow(1).font = { bold: true, size: 13 };
  summary.getRow(5).font = { bold: true };

  sheet(wb, 'Bank transactions', [
    { header: 'Date', key: 'date', width: 11 }, { header: 'Account', key: 'account', width: 16 }, { header: 'Narration', key: 'narration', width: 48 }, { header: 'UTR', key: 'utr', width: 16 },
    { header: 'Debit', key: 'debit', width: 13, money: true }, { header: 'Credit', key: 'credit', width: 13, money: true }, { header: 'Balance', key: 'balance', width: 14, money: true },
    { header: 'Category', key: 'category', width: 18 }, { header: 'Sub-category', key: 'subCategory', width: 22 }, { header: 'Nature', key: 'nature', width: 16 }, { header: 'Party', key: 'party', width: 24 },
    { header: 'Linked to', key: 'linked', width: 22 }, { header: 'GST in documents', key: 'gst', width: 13, money: true }, { header: 'TDS', key: 'tds', width: 11, money: true },
    { header: 'Split', key: 'line', width: 12 }, { header: 'Status', key: 'status', width: 11 }, { header: 'Entry', key: 'manual', width: 8 }, { header: 'Notes', key: 'notes', width: 30 }, { header: 'Statement', key: 'file', width: 11 },
  ], d.bank, 'Split rows appear once per line. "GST in documents" is the GST on the bills a payment settled; TDS is what was deducted on that payment or by the customer.');
  sheet(wb, 'Vendor bills', [
    { header: 'Type', key: 'type', width: 12 }, { header: 'Number', key: 'number', width: 16 }, { header: 'Date', key: 'date', width: 11 }, { header: 'Vendor', key: 'vendor', width: 28 }, { header: 'GSTIN', key: 'gstin', width: 17 },
    { header: 'PAN', key: 'pan', width: 12 }, { header: 'Place of supply', key: 'pos', width: 8 }, { header: 'Reverse charge', key: 'reverseCharge', width: 8 }, { header: 'Taxable', key: 'taxable', width: 13, money: true },
    { header: 'CGST', key: 'cgst', width: 11, money: true }, { header: 'SGST', key: 'sgst', width: 11, money: true }, { header: 'IGST', key: 'igst', width: 11, money: true }, { header: 'Other', key: 'other', width: 10, money: true },
    { header: 'Round off', key: 'roundOff', width: 9, money: true }, { header: 'Total', key: 'total', width: 13, money: true }, { header: 'ITC', key: 'itc', width: 6 }, { header: 'TDS section', key: 'tdsSection', width: 9 },
    { header: 'TDS', key: 'tds', width: 11, money: true }, { header: 'Category', key: 'category', width: 18 }, { header: 'Sub-category', key: 'subCategory', width: 20 }, { header: 'Status', key: 'status', width: 14 }, { header: 'File', key: 'file', width: 10 },
  ], d.bills);
  sheet(wb, 'Sales invoices', [
    { header: 'Number', key: 'number', width: 17 }, { header: 'Date', key: 'date', width: 11 }, { header: 'Customer', key: 'customer', width: 28 }, { header: 'GSTIN', key: 'gstin', width: 17 }, { header: 'B2B / B2C', key: 'supply', width: 8 },
    { header: 'Place of supply', key: 'pos', width: 8 }, { header: 'CRM order', key: 'crmOrder', width: 14 }, { header: 'Taxable', key: 'taxable', width: 13, money: true }, { header: 'CGST', key: 'cgst', width: 11, money: true },
    { header: 'SGST', key: 'sgst', width: 11, money: true }, { header: 'IGST', key: 'igst', width: 11, money: true }, { header: 'Round off', key: 'roundOff', width: 9, money: true }, { header: 'Total', key: 'total', width: 13, money: true },
    { header: 'Status', key: 'status', width: 22 }, { header: 'PDF', key: 'file', width: 10 },
  ], d.invoices);
  sheet(wb, 'Credit notes', [
    { header: 'Number', key: 'number', width: 16 }, { header: 'Date', key: 'date', width: 11 }, { header: 'Against invoice', key: 'against', width: 17 }, { header: 'Customer', key: 'customer', width: 26 }, { header: 'GSTIN', key: 'gstin', width: 17 },
    { header: 'Reason', key: 'reason', width: 14 }, { header: 'B2B / B2C', key: 'supply', width: 8 }, { header: 'Place of supply', key: 'pos', width: 8 }, { header: 'Taxable', key: 'taxable', width: 13, money: true },
    { header: 'CGST', key: 'cgst', width: 11, money: true }, { header: 'SGST', key: 'sgst', width: 11, money: true }, { header: 'IGST', key: 'igst', width: 11, money: true }, { header: 'Total', key: 'total', width: 13, money: true },
    { header: 'Status', key: 'status', width: 22 }, { header: 'PDF', key: 'file', width: 10 },
  ], d.credits);
  sheet(wb, 'Receipts', [
    { header: 'Number', key: 'number', width: 11 }, { header: 'Date', key: 'date', width: 11 }, { header: 'Customer', key: 'customer', width: 28 }, { header: 'Mode', key: 'mode', width: 10 }, { header: 'Reference', key: 'reference', width: 18 },
    { header: 'Received', key: 'amount', width: 13, money: true }, { header: 'TDS by customer', key: 'tds', width: 11, money: true }, { header: 'Gateway / bank charges', key: 'charges', width: 11, money: true },
    { header: 'GST on charges', key: 'gstOnCharges', width: 10, money: true }, { header: 'Against', key: 'against', width: 24 }, { header: 'CRM order', key: 'crmOrder', width: 14 }, { header: 'Status', key: 'status', width: 18 },
  ], d.receipts);
  sheet(wb, 'Payments', [
    { header: 'Number', key: 'number', width: 11 }, { header: 'Date', key: 'date', width: 11 }, { header: 'Vendor', key: 'vendor', width: 28 }, { header: 'Mode', key: 'mode', width: 8 }, { header: 'UTR', key: 'utr', width: 18 },
    { header: 'Paid', key: 'amount', width: 13, money: true }, { header: 'TDS deducted', key: 'tds', width: 11, money: true }, { header: 'Against', key: 'against', width: 28 }, { header: 'Status', key: 'status', width: 11 }, { header: 'Proof', key: 'file', width: 10 },
  ], d.payments);
  sheet(wb, 'TDS', [
    { header: 'Deducted on', key: 'date', width: 11 }, { header: 'Vendor', key: 'vendor', width: 28 }, { header: 'PAN', key: 'pan', width: 12 }, { header: 'Section', key: 'section', width: 8 }, { header: 'Base', key: 'base', width: 13, money: true },
    { header: 'Rate %', key: 'rate', width: 7 }, { header: 'TDS', key: 'tds', width: 11, money: true }, { header: 'Status', key: 'status', width: 12 }, { header: 'Challan', key: 'challan', width: 26 }, { header: 'Challan file', key: 'file', width: 10 },
  ], d.tds, 'TDS deducted this month (on bills, advances and payments). Challans deposited this month are on the TDS challans sheet.');
  sheet(wb, 'TDS challans', [
    { header: 'Deposited on', key: 'date', width: 11 }, { header: 'BSR code', key: 'bsr', width: 10 }, { header: 'Serial', key: 'serial', width: 8 }, { header: 'Section', key: 'section', width: 8 },
    { header: 'TDS', key: 'tds', width: 12, money: true }, { header: 'Interest', key: 'interest', width: 10, money: true }, { header: 'Fee', key: 'fee', width: 9, money: true }, { header: 'Total', key: 'total', width: 12, money: true }, { header: 'File', key: 'file', width: 10 },
  ], d.challans);
  sheet(wb, 'Funding', [
    { header: 'Date', key: 'date', width: 11 }, { header: 'What', key: 'kind', width: 22 }, { header: 'From / to', key: 'party', width: 26 }, { header: 'Money in', key: 'inflow', width: 13, money: true },
    { header: 'Principal repaid', key: 'principal', width: 13, money: true }, { header: 'Interest', key: 'interest', width: 11, money: true }, { header: 'Note', key: 'note', width: 32 }, { header: 'Agreement', key: 'file', width: 10 },
  ], d.funding);
  sheet(wb, 'GST outward B2B', [
    { header: 'Type', key: 'type', width: 11 }, { header: 'Number', key: 'number', width: 17 }, { header: 'Date', key: 'date', width: 11 }, { header: 'GSTIN', key: 'gstin', width: 17 }, { header: 'Customer', key: 'customer', width: 26 },
    { header: 'Place of supply', key: 'pos', width: 8 }, { header: 'Taxable', key: 'taxable', width: 13, money: true }, { header: 'CGST', key: 'cgst', width: 11, money: true }, { header: 'SGST', key: 'sgst', width: 11, money: true },
    { header: 'IGST', key: 'igst', width: 11, money: true }, { header: 'Total', key: 'total', width: 13, money: true },
  ], d.gst.b2b, 'Information for the CA, not a GSTR file. Cancelled documents are left out.');
  sheet(wb, 'GST outward B2C', [
    { header: 'Place of supply', key: 'placeOfSupply', width: 10 }, { header: 'Rate %', key: 'rate', width: 7 }, { header: 'Taxable', key: 'taxable', width: 14, money: true },
    { header: 'CGST', key: 'cgst', width: 12, money: true }, { header: 'SGST', key: 'sgst', width: 12, money: true }, { header: 'IGST', key: 'igst', width: 12, money: true },
  ], d.gst.b2c.map((x) => ({ ...x, taxable: Number(x.taxable), cgst: Number(x.cgst), sgst: Number(x.sgst), igst: Number(x.igst) })), 'B2C by place of supply and rate, credit notes subtracted.');
  const hsnWs = sheet(wb, 'HSN summary', [
    { header: 'HSN / SAC', key: 'hsn', width: 11 }, { header: 'Rate %', key: 'rate', width: 7 }, { header: 'Quantity', key: 'qty', width: 10 }, { header: 'Taxable', key: 'taxable', width: 14, money: true },
    { header: 'CGST', key: 'cgst', width: 12, money: true }, { header: 'SGST', key: 'sgst', width: 12, money: true }, { header: 'IGST', key: 'igst', width: 12, money: true }, { header: 'Total tax', key: 'tax', width: 12, money: true }, { header: 'Value', key: 'total', width: 14, money: true },
  ], d.gst.hsn.map((x) => ({ ...x, qty: Number(x.qty), taxable: Number(x.taxable), cgst: Number(x.cgst), sgst: Number(x.sgst), igst: Number(x.igst), tax: Number(x.tax), total: Number(x.total) })), 'Invoices less credit notes, by HSN and rate.');
  hsnWs.addRow([]);
  hsnWs.addRow(['Ties to invoices less credit notes', null, null, Number(d.gst.tie.documentsTaxable), null, null, null, null, d.gst.tie.ok ? 'OK' : `Difference ${d.gst.tie.difference}`]);
  sheet(wb, 'GST inward', [
    { header: 'Type', key: 'type', width: 13 }, { header: 'Number', key: 'number', width: 18 }, { header: 'Date', key: 'date', width: 11 }, { header: 'Vendor', key: 'vendor', width: 28 }, { header: 'GSTIN', key: 'gstin', width: 17 },
    { header: 'Taxable', key: 'taxable', width: 13, money: true }, { header: 'CGST', key: 'cgst', width: 11, money: true }, { header: 'SGST', key: 'sgst', width: 11, money: true }, { header: 'IGST', key: 'igst', width: 11, money: true },
    { header: 'ITC', key: 'itc', width: 18 }, { header: 'Reverse charge', key: 'reverseCharge', width: 8 },
  ], d.gst.inward, 'Vendor tax invoices and notes with GST, for the input credit check against GSTR-2B. Credit notes are negative.');

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, fileName: `CA pack ${company.brandName ?? 'Entelechy'} ${month}.xlsx` };
}
