import type { BankTxn, Prisma, Receipt, ReceiptAllocation, SalesDocument } from '@prisma/client';
import { prisma } from '../config/database';
import { crmCompanies } from '../crm/reader';
import { withAudit, type AuditContext, type Tx } from '../lib/audit';
import { dateText, parseDate } from '../lib/dates';
import { fyLabel, todayIST } from '../lib/fy';
import { UserError } from '../lib/http';
import { Decimal, moneyText } from '../lib/money';
import { AGEING_LABEL, matchBankRow, nameSimilarity, type AgeingBucket } from '../lib/payables';
import { checkReceipt, dso, invoicePayment, suggestInvoicesForCredit, type OpenInvoice } from '../lib/receivables';
import { takeNumber } from './numbering.service';
import { getCompany } from './settings.service';

/**
 * M10 Receivables (F110-F117, F133, D08). A receipt (RCT) records money from a customer: what
 * reached the bank, TDS the customer deducted (BR-41) and gateway charges (BR-39). It is allocated
 * to tax invoices, or held against a proforma as an advance (BR-33); what is left is a customer
 * advance. Invoice payment states are computed from allocations and issued credit notes.
 * Razorpay settlements, COD remittances and direct order payments settle the D2C invoices of their
 * orders by themselves once matched to the bank (BR-39, BR-40); the bank credit stays linked to the
 * settlement, so it is counted once.
 */

export const RECEIPT_MODES = ['neft', 'rtgs', 'imps', 'upi', 'cheque', 'cash', 'razorpay', 'cod', 'other'] as const;
export type ReceiptMode = (typeof RECEIPT_MODES)[number];
export const MODE_LABEL: Record<string, string> = { neft: 'NEFT', rtgs: 'RTGS', imps: 'IMPS', upi: 'UPI', cheque: 'Cheque', cash: 'Cash', razorpay: 'Razorpay', cod: 'COD remittance', other: 'Other' };
export const PAYMENT_STATE_LABEL: Record<string, string> = { unpaid: 'Unpaid', partly_paid: 'Partly paid', paid: 'Paid' };

const zero = () => new Decimal(0);
const text = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
const sum = <T>(xs: T[], f: (x: T) => Decimal) => xs.reduce((s, x) => s.plus(f(x)), zero());
const DAY = 86_400_000;
const shift = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const num = (v: string | null | undefined, field: string) => {
  const clean = String(v ?? '').replace(/[,\s₹]/g, '');
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(clean)) throw new UserError(`${field} is not a valid amount: ${v}`);
  return new Decimal(clean);
};
const billName = (d: SalesDocument) => (d.billTo as { name: string }).name;
/** Customers are CRM companies; D2C buyers and one-off customers are known by name. */
export const customerKey = (d: { crmCompanyId: string | null; billTo?: unknown; customerName?: string }) =>
  d.crmCompanyId ? `company:${d.crmCompanyId}` : `name:${(d.customerName ?? (d.billTo as { name: string }).name).trim().toLowerCase()}`;

// ---------- Money against documents ----------

export type DocMoney = { received: Decimal; tds: Decimal; credited: Decimal };

/** Received (without TDS), TDS and credit notes against each document. */
export async function docMoney(docIds: string[], db: Tx | typeof prisma = prisma): Promise<Map<string, DocMoney>> {
  const out = new Map<string, DocMoney>(docIds.map((id) => [id, { received: zero(), tds: zero(), credited: zero() }]));
  if (!docIds.length) return out;
  const allocs = await db.receiptAllocation.findMany({ where: { docId: { in: docIds }, isArchived: false, receipt: { status: 'recorded' } } });
  for (const a of allocs) {
    const m = out.get(a.docId)!;
    m.received = m.received.plus(a.amount.minus(a.tds));
    m.tds = m.tds.plus(a.tds);
  }
  const cns = await db.salesDocument.findMany({ where: { againstInvoiceId: { in: docIds }, docType: 'credit_note', status: 'issued' } });
  for (const c of cns) out.get(c.againstInvoiceId!)!.credited = out.get(c.againstInvoiceId!)!.credited.plus(c.total);
  return out;
}

export type PaymentView = ReturnType<typeof invoicePayment> & { received: string; tds: string; credited: string; stateLabel: string };

/** Payment state of tax invoices (and advances held on proformas). */
export async function paymentViews(docs: SalesDocument[], today = todayIST(), db: Tx | typeof prisma = prisma): Promise<Map<string, PaymentView>> {
  const money = await docMoney(docs.map((d) => d.id), db);
  const out = new Map<string, PaymentView>();
  for (const d of docs) {
    const m = money.get(d.id)!;
    const p = invoicePayment({ total: d.total, received: m.received, tds: m.tds, credited: m.credited, dueDate: d.docType === 'tax_invoice' ? dateText(d.dueDate) : null, today });
    out.set(d.id, { ...p, received: m.received.toFixed(2), tds: m.tds.toFixed(2), credited: m.credited.toFixed(2), stateLabel: PAYMENT_STATE_LABEL[p.state] });
  }
  return out;
}

const OPEN_INVOICES: Prisma.SalesDocumentWhereInput = { docType: 'tax_invoice', status: 'issued' };

/** Every issued tax invoice with something still owed, with its payment state. */
async function openInvoiceRows(where: Prisma.SalesDocumentWhereInput = {}, today = todayIST()) {
  const docs = await prisma.salesDocument.findMany({ where: { ...OPEN_INVOICES, ...where }, orderBy: [{ dueDate: 'asc' }, { docDate: 'asc' }] });
  const pay = await paymentViews(docs, today);
  return docs.map((d) => ({ d, p: pay.get(d.id)! })).filter((x) => x.p.state !== 'paid');
}

/** F083: outstanding and the oldest overdue of a company, for the credit-limit warning. */
export async function customerExposure(companyId: string) {
  const rows = await openInvoiceRows({ crmCompanyId: companyId });
  return { outstanding: sum(rows, (x) => new Decimal(x.p.outstanding)), oldestOverdueDays: Math.max(0, ...rows.map((x) => x.p.daysOverdue)) };
}

// ---------- F110 outstanding list ----------

export async function outstandingList(f: { companyId?: string; overdueOnly?: boolean; q?: string } = {}) {
  const today = todayIST();
  let rows = await openInvoiceRows(f.companyId ? { crmCompanyId: f.companyId } : {}, today);
  if (f.overdueOnly) rows = rows.filter((x) => x.p.overdue);
  const q = f.q?.trim().toLowerCase();
  if (q) rows = rows.filter((x) => `${x.d.docNumber} ${billName(x.d)} ${x.d.crmOrderNumber ?? ''}`.toLowerCase().includes(q));
  const reminders = await prisma.receivableReminder.findMany({ where: { docId: { in: rows.map((x) => x.d.id) } }, orderBy: { sharedOn: 'desc' } });
  return {
    rows: rows.map(({ d, p }) => ({
      id: d.id, docNumber: d.docNumber, docDate: dateText(d.docDate), dueDate: dateText(d.dueDate), customerName: billName(d), crmCompanyId: d.crmCompanyId, crmOrderNumber: d.crmOrderNumber,
      supplyType: d.supplyType, source: d.source, total: d.total.toFixed(2), ...p, lastReminder: dateText(reminders.find((r) => r.docId === d.id)?.sharedOn ?? null),
    })),
    totals: { outstanding: sum(rows, (x) => new Decimal(x.p.outstanding)).toFixed(2), overdue: sum(rows.filter((x) => x.p.overdue), (x) => new Decimal(x.p.outstanding)).toFixed(2) },
  };
}

// ---------- F111 / F112 receipts ----------

export type AllocationInput = { docId: string; amount: string; tds?: string | null };
export type ReceiptInput = {
  receiptDate: string; companyId?: string | null; customerName?: string | null; mode: ReceiptMode; toBankAccountId?: string | null; reference?: string | null;
  amount: string; bankCharges?: string | null; tdsSectionId?: string | null; notes?: string | null; allocations: AllocationInput[]; bankTxnId?: string | null;
};

/** What each document can still take: a tax invoice its outstanding; a proforma its total less advances held. */
async function openFor(docIds: string[]) {
  const docs = await prisma.salesDocument.findMany({ where: { id: { in: docIds } } });
  const money = await docMoney(docIds);
  return new Map(docs.map((d) => {
    const m = money.get(d.id)!;
    return [d.id, { d, open: Decimal.max(d.total.minus(m.received).minus(m.tds).minus(m.credited), zero()) }];
  }));
}

async function companyDeductsTds(companyId: string | null) {
  if (!companyId) return false;
  const p = await prisma.customerProfile.findFirst({ where: { crmCompanyId: companyId, crmBranchId: null } });
  return !!p?.deductsTds;
}

async function planReceipt(input: ReceiptInput) {
  const date = dateText(parseDate(input.receiptDate, 'Receipt date'))!;
  if (date > todayIST()) throw new UserError('The receipt date cannot be in the future');
  if (!RECEIPT_MODES.includes(input.mode)) throw new UserError('Choose how the money came');
  const amount = num(input.amount, 'Amount received');
  const charges = text(input.bankCharges) ? num(input.bankCharges, 'Bank charges') : zero();
  const allocs = input.allocations.filter((a) => text(a.amount) && !num(a.amount, 'Allocated amount').isZero());
  const open = await openFor(allocs.map((a) => a.docId));
  const companyId = text(input.companyId);
  let customerName = text(input.customerName);
  if (companyId) {
    const c = (await crmCompanies({ ids: [companyId] }))[0];
    if (!c) throw new UserError('Customer not found in the CRM');
    customerName = c.name;
  }
  const planned = allocs.map((a) => {
    const o = open.get(a.docId);
    if (!o) throw new UserError('That invoice was not found');
    const d = o.d;
    if (d.status !== 'issued' || (d.docType !== 'tax_invoice' && d.docType !== 'proforma')) throw new UserError(`${d.docNumber ?? 'A draft'}: only issued tax invoices and proformas take receipts`);
    if (companyId ? d.crmCompanyId !== companyId : d.crmCompanyId !== null || (customerName && billName(d).trim().toLowerCase() !== customerName.toLowerCase())) {
      throw new UserError(`${d.docNumber} is billed to ${billName(d)}, not this customer`);
    }
    customerName ??= billName(d);
    return { doc: d, open: o.open, amount: num(a.amount, `${d.docNumber} amount`), tds: text(a.tds) ? num(a.tds, `${d.docNumber} TDS`) : zero() };
  });
  if (!customerName) throw new UserError('Choose the customer');
  const tds = sum(planned, (p) => p.tds);
  if (tds.greaterThan(0) && !(await companyDeductsTds(companyId))) throw new UserError('This customer is not set to deduct TDS: switch "Deducts TDS" on in Customers first (BR-41)');
  for (const p of planned) if (p.tds.greaterThan(p.amount)) throw new UserError(`${p.doc.docNumber}: TDS is more than the amount settled`);
  const check = checkReceipt({ amount, tds, charges, allocations: planned.map((p) => ({ amount: p.amount, outstanding: p.open, label: p.doc.docNumber ?? 'Draft' })) });
  if (amount.plus(tds).plus(charges).isZero()) check.problems.unshift('Enter the amount received');
  return { date, amount, charges, tds, planned, customerName, companyId, check };
}

export async function previewReceipt(input: ReceiptInput) {
  const p = await planReceipt(input);
  return { customerName: p.customerName, tds: p.tds.toFixed(2), total: p.check.total, advance: p.check.advance, problems: p.check.problems };
}

const MATCHABLE_CREDIT: Prisma.BankTxnWhereInput = { linkedDocId: null, credit: { gt: 0 }, status: { in: ['review', 'suggested', 'categorised'] } };

async function revenueCategory(tx: Tx, sub: string) {
  const c = await tx.category.findFirst({ where: { name: 'Revenue' }, include: { subCategories: true } });
  if (!c) return null;
  const s = c.subCategories.find((x) => x.name === sub) ?? null;
  return { categoryId: c.id, subCategoryId: s?.id ?? null, nature: s?.natureOverride ?? c.natureDefault };
}

async function linkRow(tx: Tx, r: Receipt, row: BankTxn, by: string) {
  const cat = await revenueCategory(tx, r.crmCompanyId ? 'HoReCa B2B Invoice Receipt' : 'Direct Transfer');
  const keep = row.status === 'categorised';
  await tx.bankTxn.update({
    where: { id: row.id },
    data: {
      linkedDocType: 'Receipt', linkedDocId: r.id, partyType: 'customer', partyId: r.crmCompanyId,
      ...(keep || !cat ? {} : { ...cat, status: 'suggested', categorisationReason: `Matched ${r.receiptNo} (${by === 'utr' ? 'UTR' : by === 'manual' ? 'linked by hand' : 'amount, date and name'})` }),
    },
  });
  await tx.receipt.update({ where: { id: r.id }, data: { bankTxnId: row.id, matchedBy: by } });
}

async function unlinkRow(tx: Tx, txnId: string) {
  const row = await tx.bankTxn.findUnique({ where: { id: txnId } });
  if (!row || row.linkedDocType !== 'Receipt') return;
  const wasSuggestion = row.status === 'suggested' && row.categorisationReason?.startsWith('Matched ');
  await tx.bankTxn.update({ where: { id: txnId }, data: { linkedDocType: null, linkedDocId: null, ...(wasSuggestion ? { status: 'review', categoryId: null, subCategoryId: null, nature: null, categorisationReason: null } : {}) } });
}

const toCandidate = (r: BankTxn) => ({ id: r.id, bankAccountId: r.bankAccountId, txnDate: dateText(r.txnDate)!, debit: r.credit, utr: r.utr, counterpartyName: r.counterpartyName, narrationRaw: r.narrationRaw });

/** BR-38 the other way round: a recorded receipt finds its bank credit (UTR, else amount + date + name). */
async function matchToStatement(tx: Tx, r: Receipt) {
  if (r.bankTxnId || r.mode === 'cash' || r.source !== 'manual' || r.amount.isZero()) return false;
  const rows = await tx.bankTxn.findMany({
    where: { ...MATCHABLE_CREDIT, credit: r.amount, ...(r.toBankAccountId ? { bankAccountId: r.toBankAccountId } : {}),
      OR: [{ txnDate: { gte: new Date(r.receiptDate.getTime() - 3 * DAY), lte: new Date(r.receiptDate.getTime() + 3 * DAY) } }, ...(r.reference ? [{ utr: r.reference }, { narrationRaw: { contains: r.reference } }] : [])] },
  });
  const m = matchBankRow({ amount: r.amount, paidDate: dateText(r.receiptDate)!, utr: r.reference, bankAccountId: r.toBankAccountId, vendorNames: [r.customerName] }, rows.map(toCandidate));
  if (!m) return false;
  await linkRow(tx, r, rows.find((x) => x.id === m.txnId)!, m.by);
  return true;
}

/** On statement import: new credits that are recorded receipts take the receipt (before the rules). */
export async function matchReceiptsForTxns(tx: Tx, txnIds: string[]): Promise<number> {
  if (!txnIds.length) return 0;
  const rows = await tx.bankTxn.findMany({ where: { id: { in: txnIds }, ...MATCHABLE_CREDIT } });
  if (!rows.length) return 0;
  const open = await tx.receipt.findMany({ where: { status: 'recorded', source: 'manual', bankTxnId: null, mode: { not: 'cash' }, amount: { in: [...new Set(rows.map((r) => r.credit.toFixed(2)))].map((v) => new Decimal(v)) } } });
  let n = 0;
  const taken = new Set<string>();
  for (const r of open) {
    const free = rows.filter((x) => !taken.has(x.id));
    const m = matchBankRow({ amount: r.amount, paidDate: dateText(r.receiptDate)!, utr: r.reference, bankAccountId: r.toBankAccountId, vendorNames: [r.customerName] }, free.map(toCandidate));
    if (!m) continue;
    await linkRow(tx, r, free.find((x) => x.id === m.txnId)!, m.by);
    taken.add(m.txnId);
    n += 1;
  }
  return n;
}

export async function createReceipt(ctx: AuditContext, input: ReceiptInput, extra: { source?: 'manual' | 'settlement' | 'order_bank'; settlementLineId?: string; orderBankLinkId?: string; crmOrderNumber?: string | null; gstOnCharges?: Decimal } = {}) {
  const p = await planReceipt(input);
  if (p.check.problems.length) throw new UserError(p.check.problems.join('; '));
  const bankRow = input.bankTxnId ? await prisma.bankTxn.findUnique({ where: { id: input.bankTxnId } }) : null;
  if (input.bankTxnId) {
    if (!bankRow || bankRow.linkedDocId || !bankRow.credit.equals(p.amount)) throw new UserError('That bank row is not a free credit of the same amount');
    if (!['review', 'suggested', 'categorised'].includes(bankRow.status)) throw new UserError('That bank row is split, a transfer or ignored');
  }
  const company = await getCompany();
  const r = await withAudit({ ...ctx, reason: ctx.reason ?? `Receipt from ${p.customerName}` }, async (tx) => {
    const receiptNo = await takeNumber(tx, company.id, 'receipt', p.date);
    const row = await tx.receipt.create({
      data: {
        entityId: company.id, receiptNo, receiptDate: parseDate(p.date), crmCompanyId: p.companyId, customerName: p.customerName!, mode: input.mode,
        toBankAccountId: text(input.toBankAccountId) ?? bankRow?.bankAccountId ?? null, reference: text(input.reference), amount: p.amount, tds: p.tds, tdsSectionId: text(input.tdsSectionId),
        bankCharges: p.charges, gstOnCharges: extra.gstOnCharges ?? zero(), source: extra.source ?? 'manual', settlementLineId: extra.settlementLineId ?? null,
        orderBankLinkId: extra.orderBankLinkId ?? null, crmOrderNumber: extra.crmOrderNumber ?? null, notes: text(input.notes),
        bankTxnId: extra.source === 'order_bank' ? input.bankTxnId ?? null : null, matchedBy: extra.source === 'order_bank' ? 'order' : null,
      },
    });
    if (p.planned.length) await tx.receiptAllocation.createMany({ data: p.planned.map((a) => ({ receiptId: row.id, docId: a.doc.id, amount: a.amount, tds: a.tds })) });
    if (bankRow && extra.source !== 'order_bank') await linkRow(tx, row, bankRow, 'manual');
    else if (!bankRow) await matchToStatement(tx, row);
    return row;
  });
  return getReceipt(r.id);
}

async function loadReceipt(id: string) {
  const r = await prisma.receipt.findUnique({ where: { id }, include: { allocations: { where: { isArchived: false } } } });
  if (!r) throw new UserError('Receipt not found', 404);
  return r;
}

/** Allocate what is left of a receipt (an advance) to invoices or a proforma. */
export async function allocateReceipt(ctx: AuditContext, id: string, allocations: AllocationInput[]) {
  const r = await loadReceipt(id);
  if (r.status !== 'recorded') throw new UserError('This receipt is cancelled');
  const free = r.amount.plus(r.tds).plus(r.bankCharges).minus(sum(r.allocations, (a) => a.amount));
  const open = await openFor(allocations.map((a) => a.docId));
  const planned = allocations.map((a) => {
    const o = open.get(a.docId);
    if (!o || o.d.status !== 'issued' || !['tax_invoice', 'proforma'].includes(o.d.docType)) throw new UserError('Only issued tax invoices and proformas take receipts');
    if (r.crmCompanyId ? o.d.crmCompanyId !== r.crmCompanyId : billName(o.d).trim().toLowerCase() !== r.customerName.trim().toLowerCase()) throw new UserError(`${o.d.docNumber} is billed to ${billName(o.d)}, not ${r.customerName}`);
    return { doc: o.d, open: o.open, amount: num(a.amount, `${o.d.docNumber} amount`) };
  });
  const check = checkReceipt({ amount: free, tds: zero(), charges: zero(), allocations: planned.map((p) => ({ amount: p.amount, outstanding: p.open, label: p.doc.docNumber ?? '' })) });
  if (check.problems.length) throw new UserError(check.problems.join('; ').replace('received (with TDS and charges)', 'left on the receipt'));
  await withAudit({ ...ctx, reason: ctx.reason ?? `Advance on ${r.receiptNo} allocated` }, (tx) => tx.receiptAllocation.createMany({ data: planned.map((p) => ({ receiptId: id, docId: p.doc.id, amount: p.amount })) }));
  return getReceipt(id);
}

export async function removeAllocation(ctx: AuditContext, allocationId: string) {
  const a = await prisma.receiptAllocation.findUnique({ where: { id: allocationId }, include: { receipt: true } });
  if (!a || a.isArchived) throw new UserError('Allocation not found', 404);
  const reason = ctx.reason?.trim();
  if (!reason) throw new UserError('Say why the allocation is removed');
  await withAudit({ ...ctx, reason }, (tx) => tx.receiptAllocation.update({ where: { id: allocationId }, data: { isArchived: true, archivedReason: reason } }));
  return getReceipt(a.receiptId);
}

export async function cancelReceipt(ctx: AuditContext, id: string) {
  const r = await loadReceipt(id);
  if (r.status === 'cancelled') throw new UserError('This receipt is already cancelled');
  const reason = ctx.reason?.trim();
  if (!reason) throw new UserError('Say why the receipt is cancelled');
  await withAudit({ ...ctx, reason }, async (tx) => {
    await tx.receiptAllocation.updateMany({ where: { receiptId: id, isArchived: false }, data: { isArchived: true, archivedReason: `Receipt cancelled: ${reason}` } });
    if (r.bankTxnId && r.source === 'manual') await unlinkRow(tx, r.bankTxnId);
    await tx.receipt.update({ where: { id }, data: { status: 'cancelled', statusReason: reason, ...(r.source === 'manual' ? { bankTxnId: null, matchedBy: null } : {}) } });
  });
  return getReceipt(id);
}

/** BR-33: advances held on a proforma move onto the tax invoice made from it, up to what it owes. */
export async function applyProformaAdvances(ctx: AuditContext, invoiceId: string) {
  const inv = await prisma.salesDocument.findUnique({ where: { id: invoiceId } });
  if (!inv?.proformaId || inv.docType !== 'tax_invoice' || inv.status !== 'issued') return 0;
  const held = await prisma.receiptAllocation.findMany({ where: { docId: inv.proformaId, isArchived: false, receipt: { status: 'recorded' } }, orderBy: { createdAt: 'asc' } });
  if (!held.length) return 0;
  let moved = 0;
  await withAudit({ ...ctx, reason: `Advance applied to ${inv.docNumber} (BR-33)` }, async (tx) => {
    let owed = new Decimal((await paymentViews([inv], todayIST(), tx)).get(inv.id)!.outstanding);
    for (const a of held) {
      if (owed.lessThanOrEqualTo(0)) break;
      const take = Decimal.min(a.amount, owed);
      const tds = Decimal.min(a.tds, take);
      await tx.receiptAllocation.update({ where: { id: a.id }, data: { isArchived: true, archivedReason: `Applied to ${inv.docNumber}` } });
      await tx.receiptAllocation.create({ data: { receiptId: a.receiptId, docId: inv.id, amount: take, tds, movedFromId: a.id } });
      if (a.amount.greaterThan(take)) await tx.receiptAllocation.create({ data: { receiptId: a.receiptId, docId: a.docId, amount: a.amount.minus(take), tds: a.tds.minus(tds), movedFromId: a.id } });
      owed = owed.minus(take);
      moved += 1;
    }
  });
  return moved;
}

// ---------- BR-39 / BR-40 / F195: orders paid through Razorpay, COD or a direct transfer ----------

/** Receipts for the D2C invoices of orders whose money reached the bank. Safe to run again. */
export async function settleOrderInvoices(ctx: AuditContext) {
  const invoices = await prisma.salesDocument.findMany({ where: { ...OPEN_INVOICES, crmOrderNumber: { not: null } } });
  if (!invoices.length) return 0;
  const pay = await paymentViews(invoices);
  const open = invoices.filter((d) => pay.get(d.id)!.state !== 'paid');
  const byOrder = new Map(open.map((d) => [d.crmOrderNumber!, d]));
  if (!byOrder.size) return 0;
  const orderNumbers = [...byOrder.keys()];
  const done = await prisma.receipt.findMany({ where: { OR: [{ settlementLineId: { not: null } }, { orderBankLinkId: { not: null } }] }, select: { settlementLineId: true, orderBankLinkId: true } });
  const usedLines = new Set(done.map((r) => r.settlementLineId));
  const usedLinks = new Set(done.map((r) => r.orderBankLinkId));
  let n = 0;
  const lines = await prisma.settlementLine.findMany({ where: { orderNumber: { in: orderNumbers }, type: { in: ['payment', 'cod'] }, batch: { bankTxnId: { not: null } } }, include: { batch: true } });
  for (const l of lines.filter((x) => !usedLines.has(x.id))) {
    const inv = byOrder.get(l.orderNumber!)!;
    const owed = new Decimal((await paymentViews([inv])).get(inv.id)!.outstanding);
    const charges = Decimal.max(l.fee.plus(l.taxOnFee), zero());
    const total = l.net.plus(charges);
    if (total.lessThanOrEqualTo(0)) continue;
    await createReceipt({ ...ctx, reason: `${l.batch.source === 'razorpay' ? 'Razorpay settlement' : 'COD remittance'} ${l.batch.externalId} for order ${l.orderNumber}` }, {
      receiptDate: dateText(l.batch.settledOn)!, companyId: inv.crmCompanyId, customerName: billName(inv), mode: l.batch.source === 'razorpay' ? 'razorpay' : 'cod',
      reference: l.batch.utr ?? l.batch.externalId, amount: l.net.toFixed(2), bankCharges: charges.toFixed(2),
      allocations: owed.greaterThan(0) ? [{ docId: inv.id, amount: Decimal.min(total, owed).toFixed(2) }] : [],
    }, { source: 'settlement', settlementLineId: l.id, crmOrderNumber: l.orderNumber, gstOnCharges: Decimal.max(l.taxOnFee, zero()) });
    n += 1;
  }
  const links = await prisma.orderBankLink.findMany({ where: { orderNumber: { in: orderNumbers }, isArchived: false } });
  for (const k of links.filter((x) => !usedLinks.has(x.id))) {
    const inv = byOrder.get(k.orderNumber)!;
    const owed = new Decimal((await paymentViews([inv])).get(inv.id)!.outstanding);
    const row = await prisma.bankTxn.findUnique({ where: { id: k.bankTxnId } });
    await createReceipt({ ...ctx, reason: `Direct payment for order ${k.orderNumber}` }, {
      receiptDate: dateText(row?.txnDate ?? k.createdAt)!, companyId: inv.crmCompanyId, customerName: billName(inv), mode: 'upi', reference: row?.utr ?? null,
      toBankAccountId: row?.bankAccountId ?? null, amount: k.amount.toFixed(2), bankTxnId: k.bankTxnId,
      allocations: owed.greaterThan(0) ? [{ docId: inv.id, amount: Decimal.min(k.amount, owed).toFixed(2) }] : [],
    }, { source: 'order_bank', orderBankLinkId: k.id, crmOrderNumber: k.orderNumber });
    n += 1;
  }
  return n;
}

// ---------- F113 bank credits ----------

async function suggestionPool() {
  const rows = await openInvoiceRows();
  const companyIds = [...new Set(rows.map((x) => x.d.crmCompanyId).filter(Boolean) as string[])];
  const companies = new Map((await crmCompanies({ ids: companyIds })).map((c) => [c.id, c]));
  const profiles = await prisma.customerProfile.findMany({ where: { crmCompanyId: { in: companyIds }, crmBranchId: null } });
  return rows.map(({ d, p }): OpenInvoice & { customerName: string; companyId: string | null } => ({
    id: d.id, docNumber: d.docNumber, outstanding: new Decimal(p.outstanding), taxable: d.taxable, dueDate: dateText(d.dueDate),
    customerNames: [billName(d), ...(d.crmCompanyId ? [companies.get(d.crmCompanyId)?.name ?? ''] : [])].filter(Boolean),
    deductsTds: !!profiles.find((x) => x.crmCompanyId === d.crmCompanyId)?.deductsTds, customerName: billName(d), companyId: d.crmCompanyId,
  }));
}

/** BR-38: bank credits not yet explained, each with up to 3 invoices it may pay. */
export async function unmatchedCredits() {
  const rows = await prisma.bankTxn.findMany({ where: { ...MATCHABLE_CREDIT, txnDate: { gte: parseDate(shift(todayIST(), -120)) } }, orderBy: { txnDate: 'desc' }, take: 200 });
  const pool = await suggestionPool();
  return rows.map((r) => {
    const s = suggestInvoicesForCredit({ amount: r.credit, date: dateText(r.txnDate)!, counterparty: r.counterpartyName ?? r.narrationRaw }, pool);
    return {
      id: r.id, txnDate: dateText(r.txnDate), credit: r.credit.toFixed(2), counterpartyName: r.counterpartyName, narration: r.narrationRaw, utr: r.utr,
      suggestions: s.map((x) => ({ ...x, customerName: pool.find((p) => p.id === x.invoiceId)!.customerName })),
    };
  }).filter((r) => r.suggestions.length);
}

/** BR-38 for one bank credit (from the bank ledger, or the credits list). */
export async function creditSuggestions(txnId: string) {
  const r = await prisma.bankTxn.findUnique({ where: { id: txnId } });
  if (!r || r.credit.lessThanOrEqualTo(0)) throw new UserError('That bank row is not a credit', 404);
  const pool = await suggestionPool();
  const s = suggestInvoicesForCredit({ amount: r.credit, date: dateText(r.txnDate)!, counterparty: r.counterpartyName ?? r.narrationRaw }, pool);
  return { id: r.id, txnDate: dateText(r.txnDate), credit: r.credit.toFixed(2), counterpartyName: r.counterpartyName, linked: !!r.linkedDocId, suggestions: s.map((x) => ({ ...x, customerName: pool.find((p) => p.id === x.invoiceId)!.customerName })) };
}

/** Record the receipt a bank credit stands for (from a BR-38 suggestion): allocated to the invoice, linked to the row. */
export async function receiptFromCredit(ctx: AuditContext, txnId: string, f: { docId: string; tds?: string | null; tdsSectionId?: string | null }) {
  const row = await prisma.bankTxn.findUnique({ where: { id: txnId } });
  if (!row || row.credit.lessThanOrEqualTo(0)) throw new UserError('That bank row is not a credit');
  const inv = await prisma.salesDocument.findUnique({ where: { id: f.docId } });
  if (!inv) throw new UserError('Invoice not found', 404);
  const tds = text(f.tds) ? num(f.tds, 'TDS') : zero();
  const owed = new Decimal((await paymentViews([inv])).get(inv.id)!.outstanding);
  const settle = Decimal.min(row.credit.plus(tds), owed);
  return createReceipt({ ...ctx, reason: ctx.reason ?? `Bank credit of ${dateText(row.txnDate)} recorded as a receipt` }, {
    receiptDate: dateText(row.txnDate)!, companyId: inv.crmCompanyId, customerName: billName(inv), mode: /UPI/i.test(row.narrationRaw) ? 'upi' : /RTGS/i.test(row.narrationRaw) ? 'rtgs' : /IMPS/i.test(row.narrationRaw) ? 'imps' : 'neft',
    reference: row.utr, amount: row.credit.toFixed(2), tdsSectionId: f.tdsSectionId ?? null, bankTxnId: row.id,
    allocations: [{ docId: inv.id, amount: settle.toFixed(2), tds: tds.toFixed(2) }],
  });
}

export async function receiptBankCandidates(id: string) {
  const r = await loadReceipt(id);
  const rows = await prisma.bankTxn.findMany({
    where: { ...MATCHABLE_CREDIT, credit: r.amount, ...(r.toBankAccountId ? { bankAccountId: r.toBankAccountId } : {}), txnDate: { gte: new Date(r.receiptDate.getTime() - 10 * DAY), lte: new Date(r.receiptDate.getTime() + 10 * DAY) } },
    orderBy: { txnDate: 'asc' },
  });
  return rows.map((x) => ({ id: x.id, txnDate: dateText(x.txnDate), counterpartyName: x.counterpartyName, utr: x.utr, credit: moneyText(x.credit), narration: x.narrationRaw }));
}

export async function linkReceiptRow(ctx: AuditContext, id: string, txnId: string) {
  const r = await loadReceipt(id);
  if (r.status !== 'recorded' || r.bankTxnId || r.source !== 'manual') throw new UserError('Only a recorded receipt that is not yet linked can be linked');
  const row = await prisma.bankTxn.findUnique({ where: { id: txnId } });
  if (!row || row.linkedDocId || !row.credit.equals(r.amount)) throw new UserError('That bank row is not a free credit of the same amount');
  await withAudit({ ...ctx, reason: ctx.reason ?? 'Receipt linked to bank row by hand' }, (tx) => linkRow(tx, r, row, 'manual'));
  return getReceipt(id);
}

export async function unlinkReceiptRow(ctx: AuditContext, id: string) {
  const r = await loadReceipt(id);
  if (!r.bankTxnId || r.source !== 'manual') throw new UserError('This receipt is not linked to a bank row');
  if (!ctx.reason?.trim()) throw new UserError('Say why the link is wrong');
  await withAudit(ctx, async (tx) => {
    await unlinkRow(tx, r.bankTxnId!);
    await tx.receipt.update({ where: { id }, data: { bankTxnId: null, matchedBy: null } });
  });
  return getReceipt(id);
}

// ---------- Views ----------

function receiptRow(r: Receipt & { allocations: ReceiptAllocation[] }) {
  const allocated = sum(r.allocations, (a) => a.amount);
  return {
    id: r.id, receiptNo: r.receiptNo, receiptDate: dateText(r.receiptDate), customerName: r.customerName, crmCompanyId: r.crmCompanyId, mode: r.mode, modeLabel: MODE_LABEL[r.mode] ?? r.mode,
    reference: r.reference, amount: r.amount.toFixed(2), tds: r.tds.toFixed(2), bankCharges: r.bankCharges.toFixed(2), gstOnCharges: r.gstOnCharges.toFixed(2),
    total: r.amount.plus(r.tds).plus(r.bankCharges).toFixed(2), allocated: allocated.toFixed(2),
    advance: (r.status === 'recorded' ? Decimal.max(r.amount.plus(r.tds).plus(r.bankCharges).minus(allocated), zero()) : zero()).toFixed(2),
    source: r.source, crmOrderNumber: r.crmOrderNumber, inBank: !!r.bankTxnId, status: r.status, statusReason: r.statusReason,
  };
}

export async function listReceipts(f: { companyId?: string; q?: string; from?: string; to?: string; status?: string } = {}) {
  const where: Prisma.ReceiptWhereInput = {
    ...(f.companyId ? { crmCompanyId: f.companyId } : {}), ...(f.status ? { status: f.status } : {}),
    ...(f.from || f.to ? { receiptDate: { ...(f.from ? { gte: parseDate(f.from) } : {}), ...(f.to ? { lte: parseDate(f.to) } : {}) } } : {}),
  };
  const rows = await prisma.receipt.findMany({ where, include: { allocations: { where: { isArchived: false } } }, orderBy: [{ receiptDate: 'desc' }, { createdAt: 'desc' }], take: 500 });
  const q = f.q?.trim().toLowerCase();
  return rows.map(receiptRow).filter((r) => !q || `${r.receiptNo} ${r.customerName} ${r.reference ?? ''} ${r.crmOrderNumber ?? ''}`.toLowerCase().includes(q));
}

export async function getReceipt(id: string) {
  const r = await prisma.receipt.findUnique({ where: { id }, include: { allocations: { orderBy: { createdAt: 'asc' } } } });
  if (!r) throw new UserError('Receipt not found', 404);
  const active = r.allocations.filter((a) => !a.isArchived);
  const docs = new Map((await prisma.salesDocument.findMany({ where: { id: { in: r.allocations.map((a) => a.docId) } } })).map((d) => [d.id, d]));
  const bank = r.bankTxnId ? await prisma.bankTxn.findUnique({ where: { id: r.bankTxnId } }) : null;
  const account = r.toBankAccountId ? await prisma.bankAccount.findUnique({ where: { id: r.toBankAccountId } }) : null;
  return {
    ...receiptRow({ ...r, allocations: active }), notes: r.notes, matchedBy: r.matchedBy, toBankAccountId: r.toBankAccountId, toBankAccount: account ? `${account.bankName} ${account.accountNumber.slice(-4)}` : null,
    bankRow: bank ? { id: bank.id, txnDate: dateText(bank.txnDate), credit: moneyText(bank.credit), narration: bank.narrationRaw } : null,
    allocations: r.allocations.map((a) => {
      const d = docs.get(a.docId);
      return { id: a.id, docId: a.docId, docNumber: d?.docNumber ?? null, docType: d?.docType ?? null, amount: a.amount.toFixed(2), tds: a.tds.toFixed(2), isArchived: a.isArchived, archivedReason: a.archivedReason };
    }),
  };
}

/** Receipts and the state of one sales document, for its page. */
export async function docReceivable(docId: string) {
  const d = await prisma.salesDocument.findUnique({ where: { id: docId } });
  if (!d || d.status !== 'issued' || d.docType === 'credit_note') return null;
  const p = (await paymentViews([d])).get(d.id)!;
  const allocs = await prisma.receiptAllocation.findMany({ where: { docId, isArchived: false, receipt: { status: 'recorded' } }, include: { receipt: true }, orderBy: { createdAt: 'asc' } });
  const reminders = await prisma.receivableReminder.findMany({ where: { docId }, orderBy: { sharedOn: 'desc' } });
  return {
    ...p, receipts: allocs.map((a) => ({ allocationId: a.id, receiptId: a.receiptId, receiptNo: a.receipt.receiptNo, receiptDate: dateText(a.receipt.receiptDate), amount: a.amount.toFixed(2), tds: a.tds.toFixed(2), mode: MODE_LABEL[a.receipt.mode] })),
    reminders: reminders.map((r) => ({ sharedOn: dateText(r.sharedOn), channel: r.channel, note: r.note })),
  };
}

/** Open invoices and proformas of a customer, for the receipt form. */
export async function openDocsFor(f: { companyId?: string | null; name?: string | null }) {
  const where: Prisma.SalesDocumentWhereInput = { status: 'issued', docType: { in: ['tax_invoice', 'proforma'] }, ...(f.companyId ? { crmCompanyId: f.companyId } : { crmCompanyId: null }) };
  let docs = await prisma.salesDocument.findMany({ where, orderBy: [{ dueDate: 'asc' }, { docDate: 'asc' }] });
  if (!f.companyId) docs = f.name ? docs.filter((d) => billName(d).trim().toLowerCase() === f.name!.trim().toLowerCase()) : [];
  const pay = await paymentViews(docs);
  return docs.map((d) => ({ d, p: pay.get(d.id)! })).filter((x) => x.p.state !== 'paid').map(({ d, p }) => ({
    id: d.id, docType: d.docType, docNumber: d.docNumber, docDate: dateText(d.docDate), dueDate: dateText(d.dueDate), total: d.total.toFixed(2), taxable: d.taxable.toFixed(2),
    outstanding: p.outstanding, daysOverdue: p.daysOverdue, customerName: billName(d),
  }));
}

// ---------- F117 ageing, BR-41 TDS, F133 dashboard ----------

const BUCKETS: AgeingBucket[] = ['not_due', '1_30', '31_60', '61_90', '90_plus'];

/** Advances: receipts not yet used on a tax invoice (held on proformas or unallocated), per customer. */
async function advancesByCustomer() {
  const receipts = await prisma.receipt.findMany({ where: { status: 'recorded' }, include: { allocations: { where: { isArchived: false } } } });
  const invoiceIds = new Set((await prisma.salesDocument.findMany({ where: { id: { in: receipts.flatMap((r) => r.allocations.map((a) => a.docId)) }, docType: 'tax_invoice' }, select: { id: true } })).map((d) => d.id));
  const out = new Map<string, { name: string; companyId: string | null; amount: Decimal }>();
  for (const r of receipts) {
    const used = sum(r.allocations.filter((a) => invoiceIds.has(a.docId)), (a) => a.amount);
    const left = r.amount.plus(r.tds).plus(r.bankCharges).minus(used);
    if (left.lessThanOrEqualTo(0)) continue;
    const k = customerKey(r);
    const cur = out.get(k) ?? { name: r.customerName, companyId: r.crmCompanyId, amount: zero() };
    cur.amount = cur.amount.plus(left);
    out.set(k, cur);
  }
  return out;
}

/** BR-24: outstanding by customer in Not due / 1-30 / 31-60 / 61-90 / 90+, with advances apart. */
export async function arAgeing() {
  const rows = await openInvoiceRows();
  const adv = await advancesByCustomer();
  const by = new Map<string, { key: string; name: string; companyId: string | null; buckets: Record<AgeingBucket, Decimal>; total: Decimal }>();
  for (const { d, p } of rows) {
    const k = customerKey(d);
    const cur = by.get(k) ?? { key: k, name: d.crmCompanyId ? '' : billName(d), companyId: d.crmCompanyId, buckets: Object.fromEntries(BUCKETS.map((b) => [b, zero()])) as Record<AgeingBucket, Decimal>, total: zero() };
    cur.buckets[p.bucket!] = cur.buckets[p.bucket!].plus(p.outstanding);
    cur.total = cur.total.plus(p.outstanding);
    by.set(k, cur);
  }
  for (const [k, a] of adv) if (!by.has(k)) by.set(k, { key: k, name: a.name, companyId: a.companyId, buckets: Object.fromEntries(BUCKETS.map((b) => [b, zero()])) as Record<AgeingBucket, Decimal>, total: zero() });
  const companies = new Map((await crmCompanies({ ids: [...by.values()].map((x) => x.companyId).filter(Boolean) as string[] })).map((c) => [c.id, c.name]));
  const list = [...by.values()].map((x) => ({
    key: x.key, companyId: x.companyId, name: x.companyId ? companies.get(x.companyId) ?? '(not in the CRM)' : x.name,
    buckets: Object.fromEntries(BUCKETS.map((b) => [b, x.buckets[b].toFixed(2)])) as Record<AgeingBucket, string>, total: x.total.toFixed(2), advances: (adv.get(x.key)?.amount ?? zero()).toFixed(2),
  })).sort((a, b) => Number(b.total) - Number(a.total));
  const totals = Object.fromEntries(BUCKETS.map((b) => [b, sum(list, (x) => new Decimal(x.buckets[b])).toFixed(2)]));
  return { labels: AGEING_LABEL, rows: list, totals: { ...totals, total: sum(list, (x) => new Decimal(x.total)).toFixed(2), advances: sum(list, (x) => new Decimal(x.advances)).toFixed(2) } };
}

const quarterOf = (date: string) => {
  const m = Number(date.slice(5, 7));
  return `${fyLabel(date)} Q${m >= 4 && m <= 6 ? 1 : m >= 7 && m <= 9 ? 2 : m >= 10 && m <= 12 ? 3 : 4}`;
};

/** BR-41: TDS customers deducted, per customer per quarter (to match with Form 26AS / AIS). */
export async function customerTds() {
  const rs = await prisma.receipt.findMany({ where: { status: 'recorded', tds: { gt: 0 } }, orderBy: { receiptDate: 'asc' } });
  const by = new Map<string, { customerName: string; quarter: string; tds: Decimal; receipts: string[] }>();
  for (const r of rs) {
    const q = quarterOf(dateText(r.receiptDate)!);
    const k = `${customerKey(r)}|${q}`;
    const cur = by.get(k) ?? { customerName: r.customerName, quarter: q, tds: zero(), receipts: [] };
    cur.tds = cur.tds.plus(r.tds);
    cur.receipts.push(r.receiptNo);
    by.set(k, cur);
  }
  return [...by.values()].map((x) => ({ ...x, tds: x.tds.toFixed(2) }));
}

const monthKey = (d: Date) => dateText(d)!.slice(0, 7);

/** F133 receivables dashboard and D08. */
export async function receivablesDashboard() {
  const today = todayIST();
  const rows = await openInvoiceRows({}, today);
  const outstanding = sum(rows, (x) => new Decimal(x.p.outstanding));
  const overdue = sum(rows.filter((x) => x.p.overdue), (x) => new Decimal(x.p.outstanding));
  const from90 = parseDate(shift(today, -90));
  const sales = await prisma.salesDocument.findMany({ where: { status: 'issued', docType: { in: ['tax_invoice', 'credit_note'] }, docDate: { gte: from90 } } });
  const sales90 = sum(sales, (d) => (d.docType === 'credit_note' ? d.total.negated() : d.total));
  const ageing = await arAgeing();
  const since = parseDate(`${shift(today, -150).slice(0, 7)}-01`);
  const receipts = await prisma.receipt.findMany({ where: { status: 'recorded', receiptDate: { gte: since } } });
  const months = [...new Set([...Array(6).keys()].map((i) => { const dt = new Date(Date.parse(`${today.slice(0, 7)}-01T00:00:00Z`)); dt.setUTCMonth(dt.getUTCMonth() - (5 - i)); return dt.toISOString().slice(0, 7); }))];
  return {
    outstanding: outstanding.toFixed(2), overdue: overdue.toFixed(2), invoicesOpen: rows.length, dso: dso(outstanding, sales90, 90), advances: ageing.totals.advances,
    topDebtors: ageing.rows.filter((r) => Number(r.total) > 0).slice(0, 5).map((r) => ({ name: r.name, companyId: r.companyId, total: r.total, overdue: (Number(r.total) - Number(r.buckets.not_due)).toFixed(2) })),
    collections: months.map((m) => {
      const these = receipts.filter((r) => monthKey(r.receiptDate) === m);
      return { month: m, received: sum(these, (r) => r.amount).toFixed(2), tds: sum(these, (r) => r.tds).toFixed(2), gatewayCharges: sum(these, (r) => r.bankCharges).toFixed(2), gstOnCharges: sum(these, (r) => r.gstOnCharges).toFixed(2) };
    }),
    ageingTotals: ageing.totals,
  };
}

/** F136: what customers owe, by due date (overdue counts as expected now). */
export async function expectedInvoiceReceipts() {
  const today = todayIST();
  const rows = await openInvoiceRows({ crmOrderNumber: null }, today);
  return rows.map(({ d, p }) => ({ date: p.overdue || !d.dueDate ? today : dateText(d.dueDate)!, amount: p.outstanding, label: `${d.docNumber} ${billName(d)}`, docId: d.id }));
}

// ---------- F116 reminders ----------

export async function reminderText(docId: string) {
  const d = await prisma.salesDocument.findUnique({ where: { id: docId } });
  if (!d || d.docType !== 'tax_invoice' || d.status !== 'issued') throw new UserError('Reminders are for issued tax invoices', 404);
  const p = (await paymentViews([d])).get(d.id)!;
  if (p.state === 'paid') throw new UserError('This invoice is paid');
  const company = await getCompany();
  const amount = `Rs ${Number(p.outstanding).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
  const due = dateText(d.dueDate);
  const stage = p.daysOverdue >= 30 ? 'is now more than 30 days overdue' : p.daysOverdue >= 15 ? 'is 15 days overdue' : p.daysOverdue >= 7 ? 'is a week overdue' : p.daysOverdue > 0 ? 'is overdue' : `is due${due ? ` on ${due}` : ''}`;
  return {
    stage: p.daysOverdue >= 30 ? '+30' : p.daysOverdue >= 15 ? '+15' : p.daysOverdue >= 7 ? '+7' : p.daysOverdue > 0 ? 'overdue' : 'due',
    text: `Hello ${billName(d)}, a gentle reminder from ${company.brandName ?? company.legalName}: invoice ${d.docNumber} of ${dateText(d.docDate)} has ${amount} outstanding and ${stage}. Please pay to our account or reply here if already paid. Thank you.`,
  };
}

export async function logReminder(ctx: AuditContext, docId: string, f: { channel: string; note?: string | null; sharedOn?: string | null }) {
  const d = await prisma.salesDocument.findUnique({ where: { id: docId } });
  if (!d || d.docType !== 'tax_invoice' || d.status !== 'issued') throw new UserError('Reminders are for issued tax invoices', 404);
  if (!['whatsapp', 'email', 'phone', 'other'].includes(f.channel)) throw new UserError('Choose how the reminder was sent');
  await withAudit({ ...ctx, reason: ctx.reason ?? `Reminder for ${d.docNumber}` }, (tx) => tx.receivableReminder.create({ data: { docId, channel: f.channel, note: text(f.note), sharedOn: parseDate(f.sharedOn ?? todayIST()) } }));
  return docReceivable(docId);
}

// ---------- F082 customer statement ----------

export type StatementLine = { date: string; kind: 'invoice' | 'credit_note' | 'receipt'; ref: string; detail: string; debit: string; credit: string; balance: string; docId?: string };

/** Invoices less credit notes and receipts for a CRM company; the closing balance ties to outstanding less advances. */
export async function customerStatement(companyId: string, from: string, to: string) {
  const c = (await crmCompanies({ ids: [companyId] }))[0];
  if (!c) throw new UserError('Customer not found in the CRM', 404);
  const docs = await prisma.salesDocument.findMany({ where: { crmCompanyId: companyId, status: 'issued', docType: { in: ['tax_invoice', 'credit_note'] }, docDate: { lte: parseDate(to) } } });
  const receipts = await prisma.receipt.findMany({ where: { crmCompanyId: companyId, status: 'recorded', receiptDate: { lte: parseDate(to) } } });
  type Item = { date: string; kind: StatementLine['kind']; ref: string; detail: string; debit: Decimal; credit: Decimal; docId?: string };
  const items: Item[] = [
    ...docs.map((d): Item => ({ date: dateText(d.docDate)!, kind: d.docType === 'credit_note' ? 'credit_note' : 'invoice', ref: d.docNumber!, detail: d.docType === 'credit_note' ? 'Credit note' : `Tax invoice${d.dueDate ? `, due ${dateText(d.dueDate)}` : ''}`, debit: d.docType === 'credit_note' ? zero() : d.total, credit: d.docType === 'credit_note' ? d.total : zero(), docId: d.id })),
    ...receipts.map((r): Item => ({ date: dateText(r.receiptDate)!, kind: 'receipt', ref: r.receiptNo, detail: `Received by ${MODE_LABEL[r.mode]}${r.reference ? ` (${r.reference})` : ''}${r.tds.greaterThan(0) ? `, TDS Rs ${r.tds.toFixed(2)}` : ''}${r.bankCharges.greaterThan(0) ? `, charges Rs ${r.bankCharges.toFixed(2)}` : ''}`, debit: zero(), credit: r.amount.plus(r.tds).plus(r.bankCharges) })),
  ].sort((a, b) => (a.date === b.date ? (a.kind === 'invoice' ? -1 : 1) : a.date < b.date ? -1 : 1));
  const before = items.filter((x) => x.date < from);
  let balance = sum(before, (x) => x.debit.minus(x.credit));
  const opening = balance;
  const lines: StatementLine[] = items.filter((x) => x.date >= from).map((x) => {
    balance = balance.plus(x.debit).minus(x.credit);
    return { date: x.date, kind: x.kind, ref: x.ref, detail: x.detail, debit: x.debit.toFixed(2), credit: x.credit.toFixed(2), balance: balance.toFixed(2), docId: x.docId };
  });
  const open = await openInvoiceRows({ crmCompanyId: companyId });
  return {
    customer: { id: c.id, name: c.name, gstins: [...new Set(c.branches.map((b) => b.gstNumber).filter(Boolean))] as string[] }, from, to,
    opening: opening.toFixed(2), closing: balance.toFixed(2), lines,
    outstanding: sum(open, (x) => new Decimal(x.p.outstanding)).toFixed(2), advances: ((await advancesByCustomer()).get(`company:${companyId}`)?.amount ?? zero()).toFixed(2),
  };
}

export async function statementPdf(companyId: string, from: string, to: string) {
  const s = await customerStatement(companyId, from, to);
  const company = await getCompany();
  const { statementHtml } = await import('../pdf/statement');
  const { renderPdf } = await import('../pdf/render');
  return {
    pdf: await renderPdf(statementHtml({ company: { legalName: company.legalName, address: company.registeredAddress, gstin: company.gstin ?? '', email: company.email }, customer: s.customer, from, to, opening: s.opening, closing: s.closing, outstanding: s.outstanding, advances: s.advances, lines: s.lines })),
    name: `Statement ${s.customer.name} ${from} to ${to}.pdf`,
  };
}
