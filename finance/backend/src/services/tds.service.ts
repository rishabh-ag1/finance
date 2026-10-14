import ExcelJS from 'exceljs';
import type { Prisma, TdsEntry, TdsEntryStatus } from '@prisma/client';
import { prisma } from '../config/database';
import { withAudit, type AuditContext, type Tx } from '../lib/audit';
import { dateText, parseDate } from '../lib/dates';
import { DEDUCTEE_LABEL } from '../lib/deductee';
import { fyLabel, fyQuarter, fyRange, monthStart, todayIST } from '../lib/fy';
import { UserError } from '../lib/http';
import { Decimal, formatINR, moneyText } from '../lib/money';
import { challanProblems, suggestDeductions, tdsDueDate, tdsLateInterest } from '../lib/tdsRegister';
import { getCompany } from './settings.service';

/**
 * M07 TDS tracker (F070-F075). Deductions are never typed: they follow the tax invoices' TDS and the
 * TDS deducted on advances (BR-11). A challan links deductions and its OPT/CBDT bank row (BR-14);
 * a deposited deduction is fixed (database trigger). Returns and Form 16A are marked by a person.
 */

export const TDS_STATUS_LABEL: Record<TdsEntryStatus, string> = {
  deducted: 'Deducted, to deposit', deposited: 'Deposited', return_filed: 'Return filed', certificate_issued: 'Form 16A issued', cancelled: 'Cancelled',
};
const zero = () => new Decimal(0);
const LIVE: TdsEntryStatus[] = ['deducted', 'deposited', 'return_filed', 'certificate_issued'];

// ---------- Keeping the register in step (BR-11) ----------

type EntryFacts = { vendorId: string; sectionId: string; deductionDate: string; baseAmount: Decimal; rate: Decimal; tdsAmount: Decimal };

async function upsertEntry(tx: Tx, sourceType: 'bill' | 'advance', sourceId: string, facts: EntryFacts | null) {
  const existing = await tx.tdsEntry.findUnique({ where: { sourceType_sourceId: { sourceType, sourceId } } });
  if (!facts) {
    if (existing && existing.status === 'deducted') await tx.tdsEntry.update({ where: { id: existing.id }, data: { status: 'cancelled', statusReason: 'TDS removed from its source' } });
    else if (existing && existing.status !== 'cancelled') throw new UserError('The TDS on this is already deposited in a challan; it cannot be removed here. Correct it with the CA.');
    return;
  }
  const vendor = await tx.vendor.findUniqueOrThrow({ where: { id: facts.vendorId } });
  const data = {
    vendorId: facts.vendorId, pan: vendor.pan, deducteeType: vendor.deducteeType, sectionId: facts.sectionId,
    deductionDate: parseDate(facts.deductionDate), baseAmount: facts.baseAmount, rate: facts.rate, tdsAmount: facts.tdsAmount,
    month: parseDate(monthStart(facts.deductionDate)), quarter: fyQuarter(facts.deductionDate), fyLabel: fyLabel(facts.deductionDate),
  };
  if (!existing) {
    const company = await getCompany();
    await tx.tdsEntry.create({ data: { entityId: company.id, sourceType, sourceId, ...data } });
    return;
  }
  const same = existing.tdsAmount.equals(data.tdsAmount) && existing.baseAmount.equals(data.baseAmount) && existing.sectionId === data.sectionId
    && dateText(existing.deductionDate) === facts.deductionDate && existing.vendorId === data.vendorId && existing.rate.equals(data.rate);
  if (existing.status === 'cancelled') {
    await tx.tdsEntry.update({ where: { id: existing.id }, data: { ...data, status: 'deducted', statusReason: null, challanId: null } });
  } else if (!same) {
    if (existing.status !== 'deducted') throw new UserError('The TDS on this is already deposited in a challan; its amount, base, section and date cannot change. Correct it with the CA.');
    await tx.tdsEntry.update({ where: { id: existing.id }, data });
  }
}

/** A tax invoice's TDS, deducted when the bill is booked (BR-11). */
export async function syncBillTds(tx: Tx, docId: string) {
  const d = await tx.vendorDocument.findUniqueOrThrow({ where: { id: docId } });
  const live = d.docType === 'tax_invoice' && d.tdsApplicable && d.tdsAmount.greaterThan(0) && d.tdsSectionId && !['cancelled', 'replaced'].includes(d.status);
  await upsertEntry(tx, 'bill', docId, live ? {
    vendorId: d.vendorId, sectionId: d.tdsSectionId!, deductionDate: dateText(d.docDate)!, baseAmount: d.tdsBase, rate: d.tdsRate, tdsAmount: d.tdsAmount,
  } : null);
}

/** TDS deducted on advances when a payment is recorded (BR-11); cancelled if the payment fails. */
export async function syncPaymentTds(tx: Tx, paymentId: string) {
  const p = await tx.paymentOut.findUniqueOrThrow({ where: { id: paymentId }, include: { allocations: true } });
  const recorded = p.status === 'paid' || p.status === 'reconciled';
  for (const a of p.allocations) {
    const live = recorded && !a.isArchived && a.tdsAmount.greaterThan(0) && a.tdsSectionId && p.paidDate;
    await upsertEntry(tx, 'advance', a.id, live ? {
      vendorId: p.vendorId, sectionId: a.tdsSectionId!, deductionDate: dateText(p.paidDate)!, baseAmount: a.tdsBase, rate: a.tdsRate, tdsAmount: a.tdsAmount,
    } : null);
  }
}

/** Fills the register for bills and payments entered before it existed (safe to run again). */
export async function backfillTdsEntries(ctx: AuditContext) {
  const docs = await prisma.vendorDocument.findMany({ where: { docType: 'tax_invoice', tdsApplicable: true, tdsAmount: { gt: 0 } }, select: { id: true } });
  const pays = await prisma.paymentOut.findMany({ where: { status: { in: ['paid', 'reconciled'] }, tdsAmount: { gt: 0 } }, select: { id: true } });
  await withAudit({ ...ctx, reason: ctx.reason ?? 'TDS register filled from bills and payments' }, async (tx) => {
    for (const d of docs) await syncBillTds(tx, d.id);
    for (const p of pays) await syncPaymentTds(tx, p.id);
  }, { timeoutMs: 120_000 });
  return { bills: docs.length, payments: pays.length };
}

// ---------- Register views (F070, F071) ----------

async function sources(entries: TdsEntry[]) {
  const billIds = entries.filter((e) => e.sourceType === 'bill').map((e) => e.sourceId);
  const allocIds = entries.filter((e) => e.sourceType === 'advance').map((e) => e.sourceId);
  const [bills, allocs, vendors, sections, challans] = await Promise.all([
    prisma.vendorDocument.findMany({ where: { id: { in: billIds } }, select: { id: true, docNumber: true } }),
    prisma.paymentAllocation.findMany({ where: { id: { in: allocIds } }, include: { payment: { select: { id: true, paymentNo: true } } } }),
    prisma.vendor.findMany({ where: { id: { in: [...new Set(entries.map((e) => e.vendorId))] } }, select: { id: true, displayName: true, legalName: true } }),
    prisma.tdsSection.findMany(),
    prisma.tdsChallan.findMany({ where: { id: { in: entries.map((e) => e.challanId).filter(Boolean) as string[] } } }),
  ]);
  return { bills: new Map(bills.map((b) => [b.id, b])), allocs: new Map(allocs.map((a) => [a.id, a])), vendors: new Map(vendors.map((v) => [v.id, v])), sections: new Map(sections.map((s) => [s.id, s])), challans: new Map(challans.map((c) => [c.id, c])) };
}

function entryView(e: TdsEntry, s: Awaited<ReturnType<typeof sources>>, ratePerMonth: Decimal, today: string) {
  const sec = s.sections.get(e.sectionId);
  const ch = e.challanId ? s.challans.get(e.challanId) : null;
  const deduction = dateText(e.deductionDate)!;
  const late = tdsLateInterest({ amount: e.tdsAmount, deductionDate: deduction, depositDate: ch ? dateText(ch.depositDate) : null, today, ratePerMonth });
  const bill = e.sourceType === 'bill' ? s.bills.get(e.sourceId) : null;
  const alloc = e.sourceType === 'advance' ? s.allocs.get(e.sourceId) : null;
  return {
    id: e.id, status: e.status, statusLabel: TDS_STATUS_LABEL[e.status],
    vendorId: e.vendorId, vendorName: s.vendors.get(e.vendorId)?.displayName ?? '', pan: e.pan, deducteeType: DEDUCTEE_LABEL[e.deducteeType],
    sectionId: e.sectionId, section: sec ? `${sec.codeOldAct} ${sec.nature}` : '', sectionCode: sec?.codeOldAct ?? '',
    source: bill ? { kind: 'bill' as const, id: bill.id, label: `Bill ${bill.docNumber}` } : alloc ? { kind: 'advance' as const, id: alloc.payment.id, label: `Advance ${alloc.payment.paymentNo ?? ''}`.trim() } : null,
    deductionDate: deduction, month: dateText(e.month), quarter: e.quarter, fyLabel: e.fyLabel,
    baseAmount: moneyText(e.baseAmount), rate: e.rate.toFixed(2), tdsAmount: moneyText(e.tdsAmount),
    dueDate: tdsDueDate(deduction), lateMonths: late.months, lateInterest: late.interest,
    challan: ch ? { id: ch.id, serial: ch.challanSerial, bsrCode: ch.bsrCode, depositDate: dateText(ch.depositDate) } : null,
  };
}

export async function register(f: { fy?: string; quarter?: number; vendorId?: string; status?: string; sectionId?: string } = {}) {
  const company = await getCompany();
  const today = todayIST();
  const where: Prisma.TdsEntryWhereInput = {
    ...(f.fy ? { fyLabel: f.fy } : {}), ...(f.quarter ? { quarter: f.quarter } : {}), ...(f.vendorId ? { vendorId: f.vendorId } : {}),
    ...(f.status ? { status: f.status as TdsEntryStatus } : { status: { not: 'cancelled' } }), ...(f.sectionId ? { sectionId: f.sectionId } : {}),
  };
  const entries = await prisma.tdsEntry.findMany({ where, orderBy: [{ deductionDate: 'desc' }, { createdAt: 'desc' }], take: 2000 });
  const s = await sources(entries);
  const rows = entries.map((e) => entryView(e, s, company.tdsLateInterestRate, today));
  const live = entries.filter((e) => LIVE.includes(e.status));
  const sumOf = (fn: (e: TdsEntry) => boolean) => moneyText(live.filter(fn).reduce((acc, e) => acc.plus(e.tdsAmount), zero()));
  return { rows, totals: { count: rows.length, deducted: sumOf(() => true), toDeposit: sumOf((e) => e.status === 'deducted'), deposited: sumOf((e) => e.status !== 'deducted') } };
}

/** F071 / BR-13: TDS still to deposit, by month, with due dates and late interest so far. */
export async function payable() {
  const company = await getCompany();
  const today = todayIST();
  const open = await prisma.tdsEntry.findMany({ where: { status: 'deducted' }, orderBy: { deductionDate: 'asc' } });
  const months = new Map<string, TdsEntry[]>();
  for (const e of open) months.set(dateText(e.month)!, [...(months.get(dateText(e.month)!) ?? []), e]);
  return [...months.entries()].map(([month, es]) => {
    const due = tdsDueDate(month);
    const amount = es.reduce((s, e) => s.plus(e.tdsAmount), zero());
    const interest = es.reduce((s, e) => s.plus(tdsLateInterest({ amount: e.tdsAmount, deductionDate: dateText(e.deductionDate)!, depositDate: null, today, ratePerMonth: company.tdsLateInterestRate }).interest), zero());
    const daysLeft = Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
    const bySection = new Map<string, Decimal>();
    for (const e of es) bySection.set(e.sectionId, (bySection.get(e.sectionId) ?? zero()).plus(e.tdsAmount));
    return { month, dueDate: due, daysLeft, overdue: daysLeft < 0, count: es.length, amount: moneyText(amount), interestSoFar: moneyText(interest), bySection: [...bySection.entries()].map(([sectionId, a]) => ({ sectionId, amount: moneyText(a) })) };
  });
}

// ---------- Challans (F072, BR-14) ----------

export type ChallanInput = {
  challanSerial: string; bsrCode: string; depositDate: string; entryIds: string[];
  interest?: string | null; fee?: string | null; total: string; bankTxnId?: string | null; notes?: string | null;
};

const amount = (v: string | null | undefined, field: string) => {
  const clean = String(v ?? '').replace(/[,\s₹]/g, '');
  if (!clean) return zero();
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(clean)) throw new UserError(`${field} is not a valid amount`);
  return new Decimal(clean);
};

/** Bank rows that look like TDS deposits (OPT/CBDT) and are not yet linked to a challan. */
const TDS_ROW: Prisma.BankTxnWhereInput = { debit: { gt: 0 }, linkedDocId: null, status: { not: 'ignored' }, narrationRaw: { startsWith: 'OPT/CBDT' } };

export async function recordChallan(ctx: AuditContext, input: ChallanInput) {
  const serial = input.challanSerial.trim(); const bsr = input.bsrCode.trim();
  if (!/^\d{7}$/.test(bsr)) throw new UserError('The BSR code has 7 digits');
  if (!serial) throw new UserError('Enter the challan serial number');
  const depositDate = dateText(parseDate(input.depositDate, 'Deposit date'))!;
  if (depositDate > todayIST()) throw new UserError('The deposit date cannot be in the future');
  if (!input.entryIds.length) throw new UserError('Choose the deductions this challan pays');
  const entries = await prisma.tdsEntry.findMany({ where: { id: { in: input.entryIds } } });
  if (entries.length !== input.entryIds.length) throw new UserError('A chosen deduction was not found');
  if (entries.some((e) => e.status !== 'deducted')) throw new UserError('A chosen deduction is already deposited or cancelled');
  const sections = new Set(entries.map((e) => e.sectionId));
  if (sections.size > 1) throw new UserError('A challan pays one section; record one challan per section (ITNS 281)');
  if (entries.some((e) => dateText(e.deductionDate)! > depositDate)) throw new UserError('A deduction is dated after the deposit');
  const same = await prisma.tdsChallan.findFirst({ where: { bsrCode: bsr, challanSerial: serial, depositDate: parseDate(depositDate) } });
  if (same) throw new UserError(`Challan ${bsr} / ${serial} of ${depositDate} is already recorded`);
  const tdsAmount = entries.reduce((s, e) => s.plus(e.tdsAmount), zero());
  const interest = amount(input.interest, 'Interest'); const fee = amount(input.fee, 'Fee'); const total = amount(input.total, 'Total');
  const problems = challanProblems({ tds: tdsAmount, interest, fee, total, linked: tdsAmount });
  if (problems.length) throw new UserError(problems.join('. '));

  let bankTxnId = input.bankTxnId || null;
  if (bankTxnId) {
    const row = await prisma.bankTxn.findUnique({ where: { id: bankTxnId } });
    if (!row || row.linkedDocId || !row.debit.equals(total)) throw new UserError(`That bank row is not a free debit of ${formatINR(total)}`);
  } else {
    // BR-14: the OPT/CBDT row of the same amount within 3 days of the deposit.
    const near = await prisma.bankTxn.findMany({ where: { ...TDS_ROW, debit: total, txnDate: { gte: parseDate(shift(depositDate, -3)), lte: parseDate(shift(depositDate, 3)) } } });
    const best = near.sort((a, b) => Math.abs(a.txnDate.getTime() - Date.parse(depositDate)) - Math.abs(b.txnDate.getTime() - Date.parse(depositDate)));
    if (best.length === 1 || (best.length > 1 && best[0].txnDate.getTime() !== best[1].txnDate.getTime())) bankTxnId = best[0].id;
  }
  const company = await getCompany();
  const ch = await withAudit({ ...ctx, reason: ctx.reason ?? 'TDS challan recorded' }, async (tx) => {
    const c = await tx.tdsChallan.create({
      data: { entityId: company.id, challanSerial: serial, bsrCode: bsr, depositDate: parseDate(depositDate), sectionId: [...sections][0], tdsAmount, interest, fee, total, bankTxnId, notes: input.notes?.trim() || null },
    });
    await tx.tdsEntry.updateMany({ where: { id: { in: input.entryIds } }, data: { challanId: c.id, status: 'deposited' } });
    if (bankTxnId) await linkBankRow(tx, bankTxnId, c.id);
    return c;
  });
  return getChallan(ch.id);
}

/** Challan form preview: TDS of the chosen deductions and the late interest due at that deposit date (BR-13). */
export async function previewChallan(entryIds: string[], depositDate: string) {
  const company = await getCompany();
  const entries = await prisma.tdsEntry.findMany({ where: { id: { in: entryIds } } });
  const tdsAmount = entries.reduce((s, e) => s.plus(e.tdsAmount), zero());
  const interest = entries.reduce((s, e) => s.plus(tdsLateInterest({ amount: e.tdsAmount, deductionDate: dateText(e.deductionDate)!, depositDate, ratePerMonth: company.tdsLateInterestRate }).interest), zero());
  return { tdsAmount: moneyText(tdsAmount), suggestedInterest: moneyText(interest), totalWithInterest: moneyText(tdsAmount.plus(interest)), sections: [...new Set(entries.map((e) => e.sectionId))].length };
}

function shift(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

async function linkBankRow(tx: Tx, txnId: string, challanId: string) {
  await tx.bankTxn.update({ where: { id: txnId }, data: { linkedDocType: 'TdsChallan', linkedDocId: challanId, partyType: 'govt' } });
}

export async function linkChallanBankRow(ctx: AuditContext, id: string, txnId: string) {
  const c = await loadChallan(id);
  if (c.bankTxnId) throw new UserError('This challan is already linked to a bank row');
  const row = await prisma.bankTxn.findUnique({ where: { id: txnId } });
  if (!row || row.linkedDocId || !row.debit.equals(c.total)) throw new UserError(`That bank row is not a free debit of ${formatINR(c.total)}`);
  await withAudit({ ...ctx, reason: ctx.reason ?? 'Challan linked to bank row' }, async (tx) => {
    await tx.tdsChallan.update({ where: { id }, data: { bankTxnId: txnId } });
    await linkBankRow(tx, txnId, id);
  });
  return getChallan(id);
}

/** Entered wrongly: the deductions go back to "to deposit". Not once its return is filed. */
export async function cancelChallan(ctx: AuditContext, id: string) {
  if (!ctx.reason?.trim()) throw new UserError('Say why the challan is cancelled');
  const c = await loadChallan(id);
  if (c.isCancelled) throw new UserError('Already cancelled');
  const filed = await prisma.tdsEntry.count({ where: { challanId: id, status: { in: ['return_filed', 'certificate_issued'] } } });
  if (filed) throw new UserError('Its deductions are in a filed return; correct it with the CA');
  await withAudit(ctx, async (tx) => {
    // The trigger keeps deposited figures fixed; going back to "deducted" only clears the link.
    for (const e of await tx.tdsEntry.findMany({ where: { challanId: id } })) {
      await tx.tdsEntry.update({ where: { id: e.id }, data: { status: 'deducted', challanId: null } });
    }
    if (c.bankTxnId) await tx.bankTxn.update({ where: { id: c.bankTxnId }, data: { linkedDocType: null, linkedDocId: null } });
    await tx.tdsChallan.update({ where: { id }, data: { isCancelled: true, statusReason: ctx.reason, bankTxnId: null } });
  });
  return getChallan(id);
}

async function loadChallan(id: string) {
  const c = await prisma.tdsChallan.findUnique({ where: { id } });
  if (!c) throw new UserError('Challan not found', 404);
  return c;
}

export async function getChallan(id: string) {
  const c = await prisma.tdsChallan.findUnique({ where: { id }, include: { entries: true } });
  if (!c) throw new UserError('Challan not found', 404);
  const company = await getCompany();
  const s = await sources(c.entries);
  const sec = await prisma.tdsSection.findUnique({ where: { id: c.sectionId } });
  const row = c.bankTxnId ? await prisma.bankTxn.findUnique({ where: { id: c.bankTxnId } }) : null;
  return {
    id: c.id, challanSerial: c.challanSerial, bsrCode: c.bsrCode, depositDate: dateText(c.depositDate), section: sec ? `${sec.codeOldAct} ${sec.nature}` : '',
    tdsAmount: moneyText(c.tdsAmount), interest: moneyText(c.interest), fee: moneyText(c.fee), total: moneyText(c.total),
    isCancelled: c.isCancelled, statusReason: c.statusReason, notes: c.notes,
    bankRow: row && { id: row.id, txnDate: dateText(row.txnDate), debit: moneyText(row.debit), narration: row.narrationRaw },
    entries: c.entries.map((e) => entryView(e, s, company.tdsLateInterestRate, todayIST())),
  };
}

export async function listChallans(fy?: string) {
  const range = fy ? fyRange(`20${fy.slice(0, 2)}-04-01`) : null;
  const rows = await prisma.tdsChallan.findMany({
    where: range ? { depositDate: { gte: parseDate(range.from), lte: parseDate(range.to) } } : {},
    include: { entries: { select: { id: true } } }, orderBy: { depositDate: 'desc' },
  });
  const sections = new Map((await prisma.tdsSection.findMany()).map((s) => [s.id, `${s.codeOldAct} ${s.nature}`]));
  return rows.map((c) => ({
    id: c.id, challanSerial: c.challanSerial, bsrCode: c.bsrCode, depositDate: dateText(c.depositDate), section: sections.get(c.sectionId) ?? '',
    total: moneyText(c.total), interest: moneyText(c.interest), deductions: c.entries.length, linkedToBank: !!c.bankTxnId, isCancelled: c.isCancelled,
  }));
}

/** OPT/CBDT bank rows with no challan yet, each with the deductions it most likely pays (BR-14). */
export async function unmatchedTdsRows() {
  const rows = await prisma.bankTxn.findMany({ where: TDS_ROW, orderBy: { txnDate: 'desc' }, take: 100 });
  const open = await prisma.tdsEntry.findMany({ where: { status: 'deducted' } });
  return rows.map((r) => {
    const before = open.filter((e) => e.deductionDate <= r.txnDate);
    const ids = suggestDeductions(r.debit, before.map((e) => ({ id: e.id, amount: e.tdsAmount, month: dateText(e.month)! })));
    return { id: r.id, txnDate: dateText(r.txnDate), debit: moneyText(r.debit), narration: r.narrationRaw, utr: r.utr, suggestedEntryIds: ids };
  });
}

// ---------- 26Q working and Form 16A (F073, F074) ----------

export async function quarterView(fy: string, quarter: number) {
  if (![1, 2, 3, 4].includes(quarter)) throw new UserError('Quarter is 1 to 4');
  const reg = await register({ fy, quarter });
  const filed = await prisma.tdsReturn.findUnique({ where: { fyLabel_quarter_form: { fyLabel: fy, quarter, form: '26Q' } } });
  const certs = await prisma.tdsCertificate.findMany({ where: { fyLabel: fy, quarter } });
  const vendors = new Map<string, { vendorId: string; vendorName: string; pan: string | null; tds: Decimal; count: number }>();
  for (const r of reg.rows) {
    const v = vendors.get(r.vendorId) ?? { vendorId: r.vendorId, vendorName: r.vendorName, pan: r.pan, tds: zero(), count: 0 };
    v.tds = v.tds.plus(r.tdsAmount ?? '0'); v.count += 1;
    vendors.set(r.vendorId, v);
  }
  const notDeposited = reg.rows.filter((r) => r.status === 'deducted').length;
  return {
    fy, quarter, rows: reg.rows, totals: reg.totals, notDeposited,
    filed: filed && { filedOn: dateText(filed.filedOn), ackNo: filed.ackNo, notes: filed.notes },
    vendors: [...vendors.values()].map((v) => {
      const c = certs.find((x) => x.vendorId === v.vendorId);
      return { vendorId: v.vendorId, vendorName: v.vendorName, pan: v.pan, tds: moneyText(v.tds), deductions: v.count, certificate: c && { id: c.id, certificateNo: c.certificateNo, issuedOn: dateText(c.issuedOn) } };
    }),
  };
}

/** F073: mark the quarter's 26Q filed. Every deduction of the quarter must be deposited first. */
export async function markReturnFiled(ctx: AuditContext, input: { fy: string; quarter: number; filedOn: string; ackNo: string; notes?: string | null }) {
  if (!input.ackNo.trim()) throw new UserError('Enter the acknowledgement number');
  const filedOn = dateText(parseDate(input.filedOn, 'Filed on'))!;
  const entries = await prisma.tdsEntry.findMany({ where: { fyLabel: input.fy, quarter: input.quarter, status: { not: 'cancelled' } } });
  if (!entries.length) throw new UserError('No deductions in this quarter');
  const open = entries.filter((e) => e.status === 'deducted');
  if (open.length) throw new UserError(`${open.length} deduction(s) of this quarter are not deposited yet`);
  const company = await getCompany();
  await withAudit({ ...ctx, reason: ctx.reason ?? `26Q Q${input.quarter} ${input.fy} filed` }, async (tx) => {
    const r = await tx.tdsReturn.create({ data: { entityId: company.id, fyLabel: input.fy, quarter: input.quarter, filedOn: parseDate(filedOn), ackNo: input.ackNo.trim(), notes: input.notes?.trim() || null } });
    await tx.tdsEntry.updateMany({ where: { id: { in: entries.filter((e) => e.status === 'deposited').map((e) => e.id) } }, data: { status: 'return_filed', returnId: r.id } });
  });
  return quarterView(input.fy, input.quarter);
}

/** F074: Form 16A given to a vendor for the quarter (after the return is filed). */
export async function markCertificateIssued(ctx: AuditContext, input: { fy: string; quarter: number; vendorId: string; issuedOn: string; certificateNo?: string | null }) {
  const entries = await prisma.tdsEntry.findMany({ where: { fyLabel: input.fy, quarter: input.quarter, vendorId: input.vendorId, status: { not: 'cancelled' } } });
  if (!entries.length) throw new UserError('No deductions for this vendor in the quarter');
  if (entries.some((e) => e.status !== 'return_filed' && e.status !== 'certificate_issued')) throw new UserError("File the quarter's return first; Form 16A comes from TRACES after filing");
  const company = await getCompany();
  await withAudit({ ...ctx, reason: ctx.reason ?? 'Form 16A issued' }, async (tx) => {
    const c = await tx.tdsCertificate.upsert({
      where: { vendorId_fyLabel_quarter: { vendorId: input.vendorId, fyLabel: input.fy, quarter: input.quarter } },
      update: { issuedOn: parseDate(input.issuedOn), certificateNo: input.certificateNo?.trim() || null },
      create: { entityId: company.id, vendorId: input.vendorId, fyLabel: input.fy, quarter: input.quarter, issuedOn: parseDate(input.issuedOn), certificateNo: input.certificateNo?.trim() || null },
    });
    await tx.tdsEntry.updateMany({ where: { id: { in: entries.map((e) => e.id) } }, data: { status: 'certificate_issued', certificateId: c.id } });
  });
  return quarterView(input.fy, input.quarter);
}

/** F073 export: the quarter's deductee list as the CA files it (one row per deduction). */
export async function quarterWorkbook(fy: string, quarter: number): Promise<Buffer> {
  const q = await quarterView(fy, quarter);
  const company = await getCompany();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(`26Q Q${quarter} ${fy}`);
  ws.addRow([`${company.legalName} - TDS deductee details, 26Q, Q${quarter} FY ${fy}`]).font = { bold: true };
  ws.addRow([`TAN ${company.tan ?? '(not on file)'} · PAN ${company.pan} · prepared ${todayIST()}`]);
  ws.addRow([]);
  const header = ws.addRow(['Section', 'Deductee', 'PAN', 'Deductee type', 'Date paid / credited', 'Amount paid / credited', 'TDS rate %', 'TDS deducted', 'Date of deduction', 'Challan BSR', 'Challan date', 'Challan serial', 'Source', 'Status']);
  header.font = { bold: true };
  for (const r of q.rows) {
    ws.addRow([r.sectionCode, r.vendorName, r.pan ?? 'PANNOTAVBL', r.deducteeType, r.deductionDate, Number(r.baseAmount), Number(r.rate), Number(r.tdsAmount), r.deductionDate,
      r.challan?.bsrCode ?? '', r.challan?.depositDate ?? '', r.challan?.serial ?? '', r.source?.label ?? '', r.statusLabel]);
  }
  ws.addRow([]);
  ws.addRow(['Total', '', '', '', '', null, null, Number(q.totals.deducted)]).font = { bold: true };
  for (const col of [6, 8]) ws.getColumn(col).numFmt = '#,##,##0.00';
  ws.columns.forEach((c) => { c.width = 16; });
  ws.getColumn(2).width = 32;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------- F075 / BR-12: FY totals per vendor and section against the thresholds ----------

export async function thresholds(fy?: string) {
  const label = fy ?? fyLabel(todayIST());
  const range = fyRange(`20${label.slice(0, 2)}-04-01`);
  const [vendors, sections, bills, advances] = await Promise.all([
    prisma.vendor.findMany({ where: { isArchived: false, defaultTdsSectionId: { not: null } } }),
    prisma.tdsSection.findMany(),
    prisma.vendorDocument.findMany({ where: { fyLabel: label, docType: 'tax_invoice', status: { not: 'cancelled' } } }),
    prisma.paymentAllocation.findMany({ where: { isArchived: false, appliedToDocId: null, payment: { status: { in: ['paid', 'reconciled'] }, paidDate: { gte: parseDate(range.from), lte: parseDate(range.to) } } }, include: { payment: true } }),
  ]);
  return vendors.map((v) => {
    const sec = sections.find((s) => s.id === v.defaultTdsSectionId)!;
    const vb = bills.filter((b) => b.vendorId === v.id);
    const va = advances.filter((a) => a.payment.vendorId === v.id && a.tdsBase.greaterThan(0));
    const credited = vb.reduce((s, b) => s.plus(b.taxableValue), zero()).plus(va.reduce((s, a) => s.plus(a.tdsBase), zero()));
    const tds = vb.reduce((s, b) => s.plus(b.tdsAmount), zero()).plus(va.reduce((s, a) => s.plus(a.tdsAmount), zero()));
    const limit = sec?.annualThreshold ?? null;
    const share = limit && !limit.isZero() ? credited.dividedBy(limit) : null;
    const status = !limit ? 'no_annual_limit' : credited.greaterThan(limit) ? 'crossed' : share && share.greaterThanOrEqualTo(0.8) ? 'near' : 'below';
    return {
      vendorId: v.id, vendorName: v.displayName, section: sec ? `${sec.codeOldAct} ${sec.nature}` : '', credited: moneyText(credited), tdsDeducted: moneyText(tds),
      annualThreshold: limit ? moneyText(limit) : null, singleThreshold: sec?.singleThreshold ? moneyText(sec.singleThreshold) : null,
      left: limit ? moneyText(Decimal.max(limit.minus(credited), 0)) : null, status,
    };
  }).sort((a, b) => ['crossed', 'near', 'below', 'no_annual_limit'].indexOf(a.status) - ['crossed', 'near', 'below', 'no_annual_limit'].indexOf(b.status));
}
