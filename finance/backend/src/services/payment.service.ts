import type { BankTxn, PaymentAllocation, PaymentOut, PaymentStatus, Prisma, Vendor } from '@prisma/client';
import { prisma } from '../config/database';
import { withAudit, type AuditContext, type Tx } from '../lib/audit';
import { dateText, parseDate } from '../lib/dates';
import { fyLabel, todayIST } from '../lib/fy';
import { UserError } from '../lib/http';
import { Decimal, formatINR, moneyText } from '../lib/money';
import { AGEING_LABEL, ageingBucket, daysOverdue, matchBankRow, msmeAlert, type AgeingBucket } from '../lib/payables';
import { suggestTds, type TdsSuggestion } from '../lib/tds';
import { DOC_STATUS_LABEL, DOC_TYPE_LABEL, refreshDocAmounts, refreshPoBilling } from './bill.service';
import { takeNumber } from './numbering.service';
import { getCompany } from './settings.service';
import { syncPaymentTds } from './tds.service';
import { bankRecentlyChanged } from './vendor.service';

/**
 * M06 Payables & payments out (F060-F067). Every rupee of a payment lands on a tax invoice or,
 * as an advance, on a quote / proforma / PO (F061). TDS on an advance is deducted when it is paid
 * (BR-11). A payment gets its PMT number when recorded as paid, and is matched to its bank row by
 * UTR, else amount + date + name (BR-08). A recorded payment is never edited: it is marked failed.
 */

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  requested: 'Waiting for approval', approved: 'To pay', paid: 'Paid', reconciled: 'In bank statement', failed: 'Failed', cancelled: 'Cancelled',
};
export const PAYMENT_MODES = ['neft', 'rtgs', 'imps', 'upi', 'ift', 'cheque', 'cash', 'other'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

const zero = () => new Decimal(0);
const text = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
const RECORDED: PaymentStatus[] = ['paid', 'reconciled'];
const money = (v: string, field: string) => {
  const clean = String(v ?? '').replace(/[,\s₹]/g, '');
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(clean)) throw new UserError(`${field} is not a valid amount: ${v}`);
  return new Decimal(clean);
};

export type AllocationInput = {
  docId?: string | null;
  poId?: string | null;
  /** What this settles: for an advance, cash + TDS deducted on it. */
  gross: string;
  /** Advances only. Empty = take the suggestion; anything different needs overrideReason. */
  tds?: { applicable: boolean; sectionId?: string | null; rate?: string | null; amount?: string | null; overrideReason?: string | null } | null;
};
export type PaymentInput = { vendorId: string; purpose?: string | null; allocations: AllocationInput[]; notes?: string | null };
export type RecordInput = { paidDate: string; mode: PaymentMode; fromBankAccountId: string; utr?: string | null };

// ---------- Working out allocations ----------

/** Advances this FY to the vendor under the section, as TDS bases (taxed / not taxed). */
async function advanceFyBefore(vendorId: string, sectionId: string, fy: string, excludePaymentId: string | null) {
  const range = { gte: parseDate(`20${fy.slice(0, 2)}-04-01`), lte: parseDate(`20${fy.slice(3, 5)}-03-31`) };
  const bills = await prisma.vendorDocument.findMany({ where: { vendorId, fyLabel: fy, docType: 'tax_invoice', status: { not: 'cancelled' } } });
  const advances = await prisma.paymentAllocation.findMany({
    where: { isArchived: false, appliedToDocId: null, payment: { vendorId, status: { in: RECORDED }, paidDate: range, ...(excludePaymentId ? { id: { not: excludePaymentId } } : {}) } },
  });
  let taxedBase = zero(); let untaxedBase = zero();
  for (const b of bills) {
    if (b.tdsApplicable && b.tdsSectionId === sectionId) taxedBase = taxedBase.plus(b.tdsBase);
    else if (!b.tdsApplicable) untaxedBase = untaxedBase.plus(b.taxableValue);
  }
  for (const a of advances) {
    if (a.tdsSectionId === sectionId && a.tdsAmount.greaterThan(0)) taxedBase = taxedBase.plus(a.tdsBase);
  }
  return { taxedBase, untaxedBase };
}

type Planned = {
  docId: string | null; poId: string | null; label: string; isAdvance: boolean; gross: Decimal; amount: Decimal;
  tdsAmount: Decimal; tdsSectionId: string | null; tdsBase: Decimal; tdsRate: Decimal; tdsSuggestion: TdsSuggestion | null; tdsOverrideReason: string | null;
};

async function plan(input: PaymentInput, opts: { excludePaymentId: string | null; date: string }) {
  const vendor = await prisma.vendor.findUnique({ where: { id: input.vendorId }, include: { bankAccounts: true } });
  if (!vendor) throw new UserError('Vendor not found', 404);
  if (vendor.status === 'blocked') throw new UserError(`${vendor.displayName} is blocked: no new payments (${vendor.statusReason ?? 'see the vendor page'})`);
  if (!input.allocations.length) throw new UserError('Say what this payment is for: a bill, or an advance against a quote, proforma or PO');
  const section = vendor.defaultTdsSectionId ? await prisma.tdsSection.findUnique({ where: { id: vendor.defaultTdsSectionId } }) : null;
  const warnings: string[] = [];
  const seen = new Set<string>();
  const planned: Planned[] = [];
  // Other open requests already earmarked against the same documents.
  const pending = async (where: Prisma.PaymentAllocationWhereInput) => (await prisma.paymentAllocation.findMany({
    where: { ...where, isArchived: false, payment: { status: { in: ['requested', 'approved'] }, ...(opts.excludePaymentId ? { id: { not: opts.excludePaymentId } } : {}) } },
  })).reduce((s, a) => s.plus(a.amount).plus(a.tdsAmount), zero());

  for (const [i, a] of input.allocations.entries()) {
    const gross = money(a.gross, `Line ${i + 1} amount`);
    if (gross.isZero()) throw new UserError(`Line ${i + 1}: the amount must be more than zero`);
    const key = a.docId ?? a.poId ?? '';
    if (!key || (a.docId && a.poId)) throw new UserError(`Line ${i + 1}: choose one bill, proforma or PO`);
    if (seen.has(key)) throw new UserError(`Line ${i + 1}: the same document twice`);
    seen.add(key);

    let label: string; let isAdvance: boolean; let taxableShare: Decimal;
    if (a.docId) {
      const d = await prisma.vendorDocument.findUnique({ where: { id: a.docId } });
      if (!d || d.vendorId !== vendor.id) throw new UserError(`Line ${i + 1}: that document is not from ${vendor.displayName}`);
      label = `${DOC_TYPE_LABEL[d.docType]} ${d.docNumber}`;
      if (d.docType === 'tax_invoice') {
        if (d.status === 'received') throw new UserError(`${label} is not marked OK to pay yet`);
        if (d.status === 'disputed') throw new UserError(`${label} is on hold (${d.statusReason ?? 'disputed'}); release the hold first`);
        if (!['approved', 'partially_paid'].includes(d.status)) throw new UserError(`${label} is ${DOC_STATUS_LABEL[d.status].toLowerCase()}`);
        const room = d.outstanding.minus(await pending({ docId: d.id }));
        if (gross.greaterThan(room)) throw new UserError(`${label}: ${formatINR(gross)} is more than the ${formatINR(room)} still owed`);
        isAdvance = false; taxableShare = zero();
      } else if (d.docType === 'quote' || d.docType === 'proforma') {
        if (d.status !== 'awaiting_tax_invoice') throw new UserError(`${label} is ${DOC_STATUS_LABEL[d.status].toLowerCase()}; pay its tax invoice instead`);
        const room = d.totalValue.minus(d.paidAmount).minus(await pending({ docId: d.id }));
        if (gross.greaterThan(room)) throw new UserError(`${label}: ${formatINR(gross)} is more than the ${formatINR(room)} not yet paid`);
        isAdvance = true; taxableShare = d.totalValue.isZero() ? new Decimal(1) : d.taxableValue.dividedBy(d.totalValue);
      } else {
        throw new UserError(`${label}: debit and credit notes are settled through their invoice`);
      }
    } else {
      const po = await prisma.purchaseOrder.findUnique({ where: { id: a.poId! } });
      if (!po || po.vendorId !== vendor.id) throw new UserError(`Line ${i + 1}: that PO is not for ${vendor.displayName}`);
      label = `Advance on ${po.poNumber ?? 'draft PO'}`;
      if (!['approved', 'sent', 'partially_billed'].includes(po.status)) throw new UserError(`${po.poNumber ?? 'This PO'} is not open for advances`);
      const room = po.total.minus(po.paidTotal).minus(await pending({ poId: po.id }));
      if (gross.greaterThan(room)) throw new UserError(`${label}: ${formatINR(gross)} is more than the ${formatINR(room)} left on the PO`);
      isAdvance = true; taxableShare = po.total.isZero() ? new Decimal(1) : po.taxable.dividedBy(po.total);
    }

    // BR-11: TDS on an advance when it is paid; base = the advance without its GST share.
    let tds = { tdsAmount: zero(), tdsSectionId: null as string | null, tdsBase: zero(), tdsRate: zero(), tdsSuggestion: null as TdsSuggestion | null, tdsOverrideReason: null as string | null };
    if (isAdvance) {
      const base = gross.times(taxableShare).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      const s = suggestTds({
        section: section && { id: section.id, label: `${section.codeOldAct} ${section.nature}`, rateIndividual: section.rateIndividual, rateOthers: section.rateOthers, rateNoPan: section.rateNoPan, singleThreshold: section.singleThreshold, annualThreshold: section.annualThreshold },
        deducteeType: vendor.deducteeType, base, date: opts.date,
        fyBefore: section ? await advanceFyBefore(vendor.id, section.id, fyLabel(opts.date), opts.excludePaymentId) : { taxedBase: zero(), untaxedBase: zero() },
        ldc: vendor.ldcRate ? { number: vendor.ldcNumber, rate: vendor.ldcRate, validFrom: dateText(vendor.ldcValidFrom), validTo: dateText(vendor.ldcValidTo), limit: vendor.ldcLimit } : null,
      });
      const t = a.tds;
      if (!t) {
        tds = { tdsAmount: new Decimal(s.amount), tdsSectionId: s.applicable ? s.sectionId : null, tdsBase: new Decimal(s.base), tdsRate: new Decimal(s.rate), tdsSuggestion: s, tdsOverrideReason: null };
      } else if (!t.applicable) {
        tds = { ...tds, tdsSuggestion: s, tdsOverrideReason: text(t.overrideReason) };
      } else {
        const sectionId = t.sectionId ?? s.sectionId;
        if (!sectionId) throw new UserError(`${label}: choose the TDS section`);
        const rate = new Decimal(t.rate || s.rate);
        const amount = t.amount ? money(t.amount, 'TDS amount') : base.times(rate).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        tds = { tdsAmount: amount, tdsSectionId: sectionId, tdsBase: base, tdsRate: rate, tdsSuggestion: s, tdsOverrideReason: text(t.overrideReason) };
      }
      const differs = tds.tdsAmount.equals(s.amount) === false || (tds.tdsAmount.greaterThan(0) && tds.tdsSectionId !== s.sectionId);
      if (differs && !tds.tdsOverrideReason) {
        throw new UserError(`${label}: TDS differs from the suggestion (${s.applicable ? formatINR(s.amount) : 'none'}: ${s.reason}). Give a reason for the change.`);
      }
      if (!differs) tds.tdsOverrideReason = null;
      if (tds.tdsAmount.greaterThanOrEqualTo(gross)) throw new UserError(`${label}: TDS cannot be the whole amount`);
    }
    planned.push({ docId: a.docId ?? null, poId: a.poId ?? null, label, isAdvance, gross, amount: gross.minus(tds.tdsAmount), ...tds });
  }

  if (bankRecentlyChanged(vendor.bankAccounts)) warnings.push(`${vendor.displayName}'s bank details changed in the last 30 days. Confirm them by phone before paying (BR-16).`);
  if (!vendor.bankAccounts.some((b) => b.status === 'approved')) warnings.push(`No approved bank account on file for ${vendor.displayName}.`);
  const amount = planned.reduce((s, p) => s.plus(p.amount), zero());
  const tdsAmount = planned.reduce((s, p) => s.plus(p.tdsAmount), zero());
  return { vendor, planned, amount, tdsAmount, warnings };
}

function plannedView(p: Planned) {
  return {
    docId: p.docId, poId: p.poId, label: p.label, isAdvance: p.isAdvance, gross: moneyText(p.gross), amount: moneyText(p.amount),
    tdsAmount: moneyText(p.tdsAmount), tdsRate: p.tdsRate.toFixed(2), tdsBase: moneyText(p.tdsBase), tdsSuggestion: p.tdsSuggestion, tdsOverrideReason: p.tdsOverrideReason,
  };
}

/** F061 preview: what leaves the bank, TDS on advances, warnings; nothing saved. */
export async function previewPayment(input: PaymentInput, paymentId: string | null = null) {
  const { planned, amount, tdsAmount, warnings } = await plan(input, { excludePaymentId: paymentId, date: todayIST() });
  return { allocations: planned.map(plannedView), amount: moneyText(amount), tdsAmount: moneyText(tdsAmount), warnings };
}

async function writeAllocations(tx: Tx, paymentId: string, planned: Planned[]) {
  await tx.paymentAllocation.updateMany({ where: { paymentId, isArchived: false }, data: { isArchived: true } });
  for (const p of planned) {
    await tx.paymentAllocation.create({
      data: {
        paymentId, docId: p.docId, poId: p.poId, amount: p.amount, tdsAmount: p.tdsAmount, tdsSectionId: p.tdsSectionId,
        tdsBase: p.tdsBase, tdsRate: p.tdsRate, tdsSuggestion: (p.tdsSuggestion ?? undefined) as Prisma.InputJsonValue | undefined, tdsOverrideReason: p.tdsOverrideReason,
      },
    });
  }
}

async function approvalBand(tx: Tx, amount: Decimal) {
  const bands = await tx.approvalRule.findMany({ where: { appliesTo: 'payment', isEnabled: true } });
  return bands.find((b) => amount.greaterThanOrEqualTo(b.amountFrom) && (!b.amountTo || amount.lessThanOrEqualTo(b.amountTo))) ?? null;
}

/** F061: a payment request. With approvals off (Q9) it is ready to pay at once. */
export async function createPayment(ctx: AuditContext, input: PaymentInput, record?: RecordInput) {
  const { planned, amount, tdsAmount, warnings } = await plan(input, { excludePaymentId: null, date: record?.paidDate ?? todayIST() });
  const company = await getCompany();
  const p = await withAudit({ ...ctx, reason: ctx.reason ?? planned.find((x) => x.tdsOverrideReason)?.tdsOverrideReason ?? 'Payment requested' }, async (tx) => {
    const band = await approvalBand(tx, amount);
    const created = await tx.paymentOut.create({
      data: { entityId: company.id, vendorId: input.vendorId, purpose: text(input.purpose), requestDate: parseDate(todayIST()), requestedBy: ctx.userId, amount, tdsAmount, status: band ? 'requested' : 'approved', notes: text(input.notes) },
    });
    await writeAllocations(tx, created.id, planned);
    return created;
  });
  if (record && p.status === 'approved') return { ...(await recordPaid(ctx, p.id, record)), saveWarnings: warnings };
  return { ...(await getPayment(p.id)), saveWarnings: warnings };
}

export async function updatePayment(ctx: AuditContext, id: string, input: PaymentInput) {
  const p = await loadPayment(id);
  if (!['requested', 'approved'].includes(p.status)) throw new UserError('A recorded payment cannot be edited; mark it failed instead');
  if (input.vendorId !== p.vendorId) throw new UserError('The vendor of a payment cannot change; cancel it and start again');
  const { planned, amount, tdsAmount, warnings } = await plan(input, { excludePaymentId: id, date: todayIST() });
  await withAudit({ ...ctx, reason: ctx.reason ?? 'Payment request edited' }, async (tx) => {
    const band = await approvalBand(tx, amount);
    // BR-26: an edit resets any approval.
    await tx.paymentOut.update({ where: { id }, data: { amount, tdsAmount, purpose: text(input.purpose), notes: text(input.notes), approvals: [], status: band ? 'requested' : 'approved' } });
    await writeAllocations(tx, id, planned);
  });
  return { ...(await getPayment(id)), saveWarnings: warnings };
}

async function loadPayment(id: string) {
  const p = await prisma.paymentOut.findUnique({ where: { id } });
  if (!p) throw new UserError('Payment not found', 404);
  return p;
}

/** BR-26 (off at launch): the requester cannot approve; a two-founder band needs two people. */
export async function approvePayment(ctx: AuditContext, id: string) {
  await withAudit({ ...ctx, reason: ctx.reason ?? 'Payment approved' }, async (tx) => {
    const [p] = await tx.$queryRaw<PaymentOut[]>`select * from finance."PaymentOut" where id = ${id} for update`;
    if (!p || p.status !== 'requested') throw new UserError('This payment is not waiting for approval');
    if (p.requestedBy === ctx.userId) throw new UserError('The person who asked for a payment cannot approve it');
    const approvals = (p.approvals as { userId: string; at: string }[]) ?? [];
    if (approvals.some((a) => a.userId === ctx.userId)) throw new UserError('You have already approved this payment');
    const next = [...approvals, { userId: ctx.userId, at: new Date().toISOString() }];
    const band = await approvalBand(tx, new Decimal(p.amount));
    await tx.paymentOut.update({ where: { id }, data: { approvals: next, status: band && next.length < band.approversRequired ? 'requested' : 'approved' } });
  });
  return getPayment(id);
}

/** F063: record the payment as made. Takes the PMT number and settles the documents. */
export async function recordPaid(ctx: AuditContext, id: string, r: RecordInput) {
  if (!PAYMENT_MODES.includes(r.mode)) throw new UserError('Choose how it was paid');
  const utr = text(r.utr);
  if (!utr && r.mode !== 'cash') throw new UserError('Enter the UTR / reference from the bank (or cheque number)');
  const paidDate = dateText(parseDate(r.paidDate, 'Paid on'))!;
  if (paidDate > todayIST()) throw new UserError('The payment date cannot be in the future');
  const account = await prisma.bankAccount.findUnique({ where: { id: r.fromBankAccountId } });
  if (!account) throw new UserError('Choose the account it was paid from');
  const p = await loadPayment(id);
  if (p.status !== 'approved') throw new UserError(p.status === 'requested' ? 'This payment is waiting for approval' : `This payment is ${PAYMENT_STATUS_LABEL[p.status].toLowerCase()}`);
  // Re-check every allocation against what is owed now (other payments may have landed since).
  const allocs = await prisma.paymentAllocation.findMany({ where: { paymentId: id, isArchived: false } });
  await plan({ vendorId: p.vendorId, purpose: p.purpose, notes: p.notes, allocations: allocs.map((a) => ({
    docId: a.docId, poId: a.poId, gross: a.amount.plus(a.tdsAmount).toFixed(2),
    tds: a.tdsAmount.greaterThan(0) || a.tdsOverrideReason ? { applicable: a.tdsAmount.greaterThan(0), sectionId: a.tdsSectionId, rate: a.tdsRate.toFixed(2), amount: a.tdsAmount.toFixed(2), overrideReason: a.tdsOverrideReason ?? 'as requested' } : null,
  })) }, { excludePaymentId: id, date: paidDate });

  await withAudit({ ...ctx, reason: ctx.reason ?? 'Payment recorded' }, async (tx) => {
    const paymentNo = await takeNumber(tx, p.entityId, 'payment', paidDate);
    await tx.paymentOut.update({ where: { id }, data: { paymentNo, status: 'paid', paidDate: parseDate(paidDate), mode: r.mode, fromBankAccountId: account.id, utr, paidBy: ctx.userId, paidAt: new Date() } });
    await settle(tx, id);
    await syncPaymentTds(tx, id);
    await matchToStatement(tx, id);
  });
  return getPayment(id);
}

/** Refresh every document and PO a payment touches. */
async function settle(tx: Tx, paymentId: string) {
  const allocs = await tx.paymentAllocation.findMany({ where: { paymentId } });
  const docIds = new Set<string>(); const poIds = new Set<string>();
  for (const a of allocs) {
    if (a.docId) docIds.add(a.docId);
    if (a.appliedToDocId) docIds.add(a.appliedToDocId);
    if (a.poId) poIds.add(a.poId);
  }
  for (const d of docIds) {
    await refreshDocAmounts(tx, d);
    const doc = await tx.vendorDocument.findUniqueOrThrow({ where: { id: d } });
    if (doc.poId) poIds.add(doc.poId);
  }
  for (const po of poIds) await refreshPoBilling(tx, po);
}

export async function cancelPayment(ctx: AuditContext, id: string) {
  if (!ctx.reason?.trim()) throw new UserError('Say why the payment is not going ahead');
  const p = await loadPayment(id);
  if (!['requested', 'approved'].includes(p.status)) throw new UserError('A recorded payment cannot be cancelled; mark it failed instead');
  await withAudit(ctx, (tx) => tx.paymentOut.update({ where: { id }, data: { status: 'cancelled', statusReason: ctx.reason } }));
  return getPayment(id);
}

/** Failed / reversed: the bank returned the money. The number stays; the documents are owed again. */
export async function markFailed(ctx: AuditContext, id: string) {
  if (!ctx.reason?.trim()) throw new UserError('Say what happened (e.g. "returned by the bank: wrong account")');
  const p = await loadPayment(id);
  if (!RECORDED.includes(p.status)) throw new UserError('Only a recorded payment can be marked failed');
  await withAudit(ctx, async (tx) => {
    if (p.bankTxnId) await unlinkRow(tx, p.bankTxnId);
    await tx.paymentOut.update({ where: { id }, data: { status: 'failed', statusReason: ctx.reason, bankTxnId: null, matchedBy: null } });
    await tx.paymentAllocation.updateMany({ where: { paymentId: id, isArchived: false }, data: { isArchived: true } });
    await settle(tx, id);
    await syncPaymentTds(tx, id);
  });
  return getPayment(id);
}

// ---------- BR-09: applying PO advances to a tax invoice ----------

/** Advances paid against a PO (or a quote / proforma of it) that no tax invoice has used yet. */
export async function openAdvancesFor(docId: string) {
  const d = await prisma.vendorDocument.findUnique({ where: { id: docId } });
  if (!d || d.docType !== 'tax_invoice') throw new UserError('Advances are applied to tax invoices');
  if (!d.poId) return [];
  const allocs = await prisma.paymentAllocation.findMany({
    where: { poId: d.poId, appliedToDocId: null, isArchived: false, payment: { status: { in: RECORDED } } },
    include: { payment: true },
  });
  return allocs.map((a) => ({ id: a.id, paymentNo: a.payment.paymentNo, paidDate: dateText(a.payment.paidDate), gross: moneyText(a.amount.plus(a.tdsAmount)), tdsAmount: moneyText(a.tdsAmount) }));
}

export async function applyAdvance(ctx: AuditContext, docId: string, allocationId: string) {
  const d = await prisma.vendorDocument.findUnique({ where: { id: docId } });
  const a = await prisma.paymentAllocation.findUnique({ where: { id: allocationId }, include: { payment: true } });
  if (!d || !a || d.docType !== 'tax_invoice' || !a.poId || a.poId !== d.poId || a.appliedToDocId || a.isArchived || !RECORDED.includes(a.payment.status)) {
    throw new UserError('That advance cannot be applied to this invoice');
  }
  if (['cancelled', 'paid', 'replaced'].includes(d.status)) throw new UserError(`This invoice is ${DOC_STATUS_LABEL[d.status].toLowerCase()}`);
  if (a.amount.plus(a.tdsAmount).greaterThan(d.outstanding)) throw new UserError(`The advance (${formatINR(a.amount.plus(a.tdsAmount))}) is more than the ${formatINR(d.outstanding)} still owed on this invoice`);
  await withAudit({ ...ctx, reason: ctx.reason ?? 'PO advance applied to tax invoice' }, async (tx) => {
    await tx.paymentAllocation.update({ where: { id: allocationId }, data: { appliedToDocId: docId, appliedAt: new Date() } });
    await refreshDocAmounts(tx, docId);
    await refreshPoBilling(tx, d.poId!);
  });
}

export async function unapplyAdvance(ctx: AuditContext, docId: string, allocationId: string) {
  const a = await prisma.paymentAllocation.findUnique({ where: { id: allocationId } });
  if (!a || a.appliedToDocId !== docId || !a.poId) throw new UserError('That advance is not applied to this invoice');
  const d = await prisma.vendorDocument.findUniqueOrThrow({ where: { id: docId } });
  if (['cancelled', 'replaced'].includes(d.status)) throw new UserError('This invoice is closed');
  await withAudit({ ...ctx, reason: ctx.reason ?? 'PO advance taken off the tax invoice' }, async (tx) => {
    await tx.paymentAllocation.update({ where: { id: allocationId }, data: { appliedToDocId: null, appliedAt: null } });
    // A paid invoice is reopened by its own figures.
    await tx.vendorDocument.update({ where: { id: docId }, data: { status: d.status === 'paid' ? 'partially_paid' : d.status } });
    await refreshDocAmounts(tx, docId);
    await refreshPoBilling(tx, d.poId!);
  });
}

// ---------- BR-08 / BR-05 step 1: bank matching ----------

async function vendorNames(vendorId: string) {
  const v = await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });
  return [v.displayName, v.legalName, v.tradeName, ...v.bankNames].filter(Boolean) as string[];
}

/** The category a matched bank row takes: the document's, else the vendor's default (BR-05 step 1). */
async function categoryFor(tx: Tx, paymentId: string, vendor: Vendor) {
  const allocs = await tx.paymentAllocation.findMany({ where: { paymentId, isArchived: false }, orderBy: { amount: 'desc' } });
  for (const a of allocs) {
    const d = a.docId ? await tx.vendorDocument.findUnique({ where: { id: a.docId } }) : null;
    if (d?.categoryId) return { categoryId: d.categoryId, subCategoryId: d.subCategoryId, nature: d.nature };
  }
  if (vendor.defaultCategoryId) {
    const c = await tx.category.findUnique({ where: { id: vendor.defaultCategoryId }, include: { subCategories: true } });
    const sub = c?.subCategories.find((s) => s.id === vendor.defaultSubCategoryId);
    if (c) return { categoryId: c.id, subCategoryId: sub?.id ?? null, nature: sub?.natureOverride ?? c.natureDefault };
  }
  return null;
}

async function linkRow(tx: Tx, payment: PaymentOut, row: BankTxn, by: string) {
  const vendor = await tx.vendor.findUniqueOrThrow({ where: { id: payment.vendorId } });
  const cat = await categoryFor(tx, payment.id, vendor);
  const keepPersonCategory = row.status === 'categorised';
  await tx.bankTxn.update({
    where: { id: row.id },
    data: {
      linkedDocType: 'PaymentOut', linkedDocId: payment.id, partyType: 'vendor', partyId: vendor.id,
      ...(keepPersonCategory || !cat ? {} : { categoryId: cat.categoryId, subCategoryId: cat.subCategoryId, nature: cat.nature, status: 'suggested', categorisationReason: `Matched ${payment.paymentNo} (${by === 'utr' ? 'UTR' : by === 'manual' ? 'linked by hand' : 'amount, date and name'})` }),
    },
  });
  await tx.paymentOut.update({ where: { id: payment.id }, data: { bankTxnId: row.id, matchedBy: by, status: 'reconciled' } });
}

async function unlinkRow(tx: Tx, txnId: string) {
  const row = await tx.bankTxn.findUnique({ where: { id: txnId } });
  if (!row) return;
  const wasSuggestion = row.status === 'suggested' && row.categorisationReason?.startsWith('Matched ');
  await tx.bankTxn.update({
    where: { id: txnId },
    data: { linkedDocType: null, linkedDocId: null, ...(wasSuggestion ? { status: 'review', categoryId: null, subCategoryId: null, nature: null, categorisationReason: null } : {}) },
  });
}

const MATCHABLE_ROW: Prisma.BankTxnWhereInput = { linkedDocId: null, debit: { gt: 0 }, status: { in: ['review', 'suggested', 'categorised'] } };

/** Looks for the bank row of a recorded payment among rows already imported. */
async function matchToStatement(tx: Tx, paymentId: string) {
  const p = await tx.paymentOut.findUniqueOrThrow({ where: { id: paymentId } });
  if (p.status !== 'paid' || !p.paidDate) return false;
  const from = new Date(p.paidDate.getTime() - 3 * 86_400_000);
  const rows = await tx.bankTxn.findMany({
    where: { ...MATCHABLE_ROW, debit: p.amount, ...(p.fromBankAccountId ? { bankAccountId: p.fromBankAccountId } : {}),
      OR: [{ txnDate: { gte: from, lte: new Date(p.paidDate.getTime() + 3 * 86_400_000) } }, ...(p.utr ? [{ utr: p.utr }, { narrationRaw: { contains: p.utr } }] : [])] },
  });
  const m = matchBankRow(
    { amount: p.amount, paidDate: dateText(p.paidDate)!, utr: p.utr, bankAccountId: p.fromBankAccountId, vendorNames: await vendorNames(p.vendorId) },
    rows.map((r) => ({ id: r.id, bankAccountId: r.bankAccountId, txnDate: dateText(r.txnDate)!, debit: r.debit, utr: r.utr, counterpartyName: r.counterpartyName, narrationRaw: r.narrationRaw })),
  );
  if (!m) return false;
  await linkRow(tx, p, rows.find((r) => r.id === m.txnId)!, m.by);
  return true;
}

/** BR-05 step 1 on import: new bank debits are matched to recorded payments before the rules run. */
export async function matchPaymentsForTxns(tx: Tx, txnIds: string[]): Promise<number> {
  if (!txnIds.length) return 0;
  const rows = await tx.bankTxn.findMany({ where: { id: { in: txnIds }, ...MATCHABLE_ROW } });
  if (!rows.length) return 0;
  const open = await tx.paymentOut.findMany({ where: { status: 'paid', bankTxnId: null, amount: { in: [...new Set(rows.map((r) => r.debit.toFixed(2)))].map((v) => new Decimal(v)) } } });
  let matched = 0;
  const taken = new Set<string>();
  for (const p of open) {
    const candidates = rows.filter((r) => !taken.has(r.id));
    const m = matchBankRow(
      { amount: p.amount, paidDate: dateText(p.paidDate)!, utr: p.utr, bankAccountId: p.fromBankAccountId, vendorNames: await vendorNames(p.vendorId) },
      candidates.map((r) => ({ id: r.id, bankAccountId: r.bankAccountId, txnDate: dateText(r.txnDate)!, debit: r.debit, utr: r.utr, counterpartyName: r.counterpartyName, narrationRaw: r.narrationRaw })),
    );
    if (!m) continue;
    await linkRow(tx, p, candidates.find((r) => r.id === m.txnId)!, m.by);
    taken.add(m.txnId);
    matched += 1;
  }
  return matched;
}

/** Bank rows a person could link to this payment: same amount, same account, within 10 days. */
export async function bankCandidates(id: string) {
  const p = await loadPayment(id);
  if (p.status !== 'paid' || !p.paidDate) return [];
  const rows = await prisma.bankTxn.findMany({
    where: { ...MATCHABLE_ROW, debit: p.amount, ...(p.fromBankAccountId ? { bankAccountId: p.fromBankAccountId } : {}),
      txnDate: { gte: new Date(p.paidDate.getTime() - 10 * 86_400_000), lte: new Date(p.paidDate.getTime() + 10 * 86_400_000) } },
    orderBy: { txnDate: 'asc' },
  });
  return rows.map((r) => ({ id: r.id, txnDate: dateText(r.txnDate), counterpartyName: r.counterpartyName, utr: r.utr, debit: moneyText(r.debit), narration: r.narrationRaw }));
}

export async function linkBankRow(ctx: AuditContext, id: string, txnId: string) {
  const p = await loadPayment(id);
  if (p.status !== 'paid') throw new UserError('Only a recorded payment that is not yet linked can be linked');
  const row = await prisma.bankTxn.findUnique({ where: { id: txnId } });
  if (!row || row.linkedDocId || !row.debit.equals(p.amount)) throw new UserError('That bank row is not a free debit of the same amount');
  if (!['review', 'suggested', 'categorised'].includes(row.status)) throw new UserError('That bank row is split, a transfer or ignored');
  await withAudit({ ...ctx, reason: ctx.reason ?? 'Payment linked to bank row by hand' }, (tx) => linkRow(tx, p, row, 'manual'));
  return getPayment(id);
}

export async function unlinkBankRow(ctx: AuditContext, id: string) {
  const p = await loadPayment(id);
  if (p.status !== 'reconciled' || !p.bankTxnId) throw new UserError('This payment is not linked to a bank row');
  if (!ctx.reason?.trim()) throw new UserError('Say why the link is wrong');
  await withAudit(ctx, async (tx) => {
    await unlinkRow(tx, p.bankTxnId!);
    await tx.paymentOut.update({ where: { id }, data: { bankTxnId: null, matchedBy: null, status: 'paid' } });
  });
  return getPayment(id);
}

// ---------- Views (F060, F065, F067) ----------

function paymentRow(p: PaymentOut & { vendor: Vendor }) {
  return {
    id: p.id, paymentNo: p.paymentNo, vendorId: p.vendorId, vendorName: p.vendor.displayName, status: p.status, statusLabel: PAYMENT_STATUS_LABEL[p.status],
    requestDate: dateText(p.requestDate), paidDate: dateText(p.paidDate), amount: moneyText(p.amount), tdsAmount: moneyText(p.tdsAmount),
    mode: p.mode, utr: p.utr, purpose: p.purpose, reconciled: p.status === 'reconciled',
  };
}

export async function listPayments(f: { vendorId?: string; status?: string; q?: string; from?: string; to?: string } = {}) {
  const where: Prisma.PaymentOutWhereInput = {
    ...(f.vendorId ? { vendorId: f.vendorId } : {}),
    ...(f.status ? { status: f.status as PaymentStatus } : {}),
    ...(f.from || f.to ? { OR: [{ paidDate: { ...(f.from ? { gte: parseDate(f.from) } : {}), ...(f.to ? { lte: parseDate(f.to) } : {}) } }, { paidDate: null, requestDate: { ...(f.from ? { gte: parseDate(f.from) } : {}), ...(f.to ? { lte: parseDate(f.to) } : {}) } }] } : {}),
    ...(f.q ? { AND: [{ OR: [{ paymentNo: { contains: f.q, mode: 'insensitive' } }, { utr: { contains: f.q, mode: 'insensitive' } }, { vendor: { displayName: { contains: f.q, mode: 'insensitive' } } }] }] } : {}),
  };
  const rows = await prisma.paymentOut.findMany({ where, include: { vendor: true }, orderBy: [{ paidDate: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }], take: 1000 });
  const sumOf = (st: PaymentStatus[], k: 'amount' | 'tdsAmount') => moneyText(rows.filter((r) => st.includes(r.status)).reduce((s, r) => s.plus(r[k]), zero()));
  return {
    rows: rows.map(paymentRow),
    totals: { count: rows.length, paid: sumOf(RECORDED, 'amount'), tds: sumOf(RECORDED, 'tdsAmount'), toPay: sumOf(['requested', 'approved'], 'amount'), notInBank: sumOf(['paid'], 'amount') },
  };
}

export async function getPayment(id: string) {
  const p = await prisma.paymentOut.findUnique({ where: { id }, include: { vendor: { include: { bankAccounts: true } }, allocations: { orderBy: { createdAt: 'asc' } } } });
  if (!p) throw new UserError('Payment not found', 404);
  const docIds = p.allocations.flatMap((a) => [a.docId, a.appliedToDocId]).filter(Boolean) as string[];
  const [docs, pos, account, row, users, sections] = await Promise.all([
    prisma.vendorDocument.findMany({ where: { id: { in: docIds } } }),
    prisma.purchaseOrder.findMany({ where: { id: { in: p.allocations.map((a) => a.poId).filter(Boolean) as string[] } } }),
    p.fromBankAccountId ? prisma.bankAccount.findUnique({ where: { id: p.fromBankAccountId } }) : null,
    p.bankTxnId ? prisma.bankTxn.findUnique({ where: { id: p.bankTxnId } }) : null,
    prisma.user.findMany({ where: { id: { in: [p.requestedBy, p.paidBy, ...(p.approvals as { userId: string }[]).map((a) => a.userId)].filter(Boolean) as string[] } } }),
    prisma.tdsSection.findMany(),
  ]);
  const name = (uid: string | null) => { const u = users.find((x) => x.id === uid); return u ? `${u.firstName} ${u.lastName}`.trim() : uid; };
  const doc = (did: string | null) => docs.find((d) => d.id === did);
  const current = p.vendor.bankAccounts.find((b) => b.status === 'approved');
  const warnings: string[] = [];
  if (bankRecentlyChanged(p.vendor.bankAccounts)) warnings.push(`${p.vendor.displayName}'s bank details changed in the last 30 days. Confirm them by phone before paying (BR-16).`);
  if (!current && ['requested', 'approved'].includes(p.status)) warnings.push(`No approved bank account on file for ${p.vendor.displayName}.`);
  if (p.status === 'paid') warnings.push('Not yet seen in a bank statement. It links by itself when the statement is imported, or link it by hand below.');
  return {
    ...paymentRow(p),
    statusReason: p.statusReason, notes: p.notes,
    fromBankAccount: account ? `${account.bankName} •••• ${account.accountNumber.slice(-4)}` : null, fromBankAccountId: p.fromBankAccountId,
    vendorBank: current ? { accountName: current.accountName, accountNumberMasked: `•••• ${current.accountNumber.slice(-4)}`, ifsc: current.ifsc, bankName: current.bankName } : null,
    requestedBy: name(p.requestedBy), paidBy: name(p.paidBy), paidAt: p.paidAt,
    approvals: (p.approvals as { userId: string; at: string }[]).map((a) => ({ name: name(a.userId), at: a.at })),
    matchedBy: p.matchedBy,
    bankRow: row && { id: row.id, txnDate: dateText(row.txnDate), counterpartyName: row.counterpartyName, debit: moneyText(row.debit), utr: row.utr, status: row.status },
    allocations: p.allocations.filter((a) => !a.isArchived || p.status === 'failed').map((a: PaymentAllocation) => {
      const d = doc(a.docId); const po = pos.find((x) => x.id === a.poId); const applied = doc(a.appliedToDocId);
      const sec = sections.find((s) => s.id === a.tdsSectionId);
      return {
        id: a.id, docId: a.docId, poId: a.poId,
        label: d ? `${DOC_TYPE_LABEL[d.docType]} ${d.docNumber}` : `Advance on ${po?.poNumber ?? 'PO'}`,
        isAdvance: !d || d.docType !== 'tax_invoice',
        gross: moneyText(a.amount.plus(a.tdsAmount)), amount: moneyText(a.amount), tdsAmount: moneyText(a.tdsAmount), tdsRate: a.tdsRate.toFixed(2),
        tdsSection: sec ? `${sec.codeOldAct} ${sec.nature}` : null, tdsOverrideReason: a.tdsOverrideReason,
        appliedTo: applied ? { id: applied.id, label: `${DOC_TYPE_LABEL[applied.docType]} ${applied.docNumber}` } : null,
        isArchived: a.isArchived,
      };
    }),
    warnings,
  };
}

/** F060 due list: bills still owed and proformas with an advance to pay, by due date. */
export async function dueList() {
  const today = todayIST();
  const docs = await prisma.vendorDocument.findMany({
    where: { OR: [
      { docType: 'tax_invoice', status: { in: ['received', 'approved', 'partially_paid', 'disputed'] }, outstanding: { gt: 0 } },
      { docType: { in: ['quote', 'proforma'] }, status: 'awaiting_tax_invoice' },
    ] },
    include: { vendor: true },
    orderBy: [{ dueDate: 'asc' }, { docDate: 'asc' }],
  });
  const pendingAllocs = await prisma.paymentAllocation.findMany({ where: { docId: { in: docs.map((d) => d.id) }, isArchived: false, payment: { status: { in: ['requested', 'approved'] } } } });
  const weekEnd = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
  const rows = docs.map((d) => {
    const isAdvance = d.docType !== 'tax_invoice';
    const owed = isAdvance ? d.totalValue.minus(d.paidAmount) : d.outstanding;
    const due = dateText(d.dueDate);
    const over = daysOverdue(due, today);
    const msme = msmeAlert({ msmeType: d.vendor.msmeType, acceptedOn: dateText(d.receivedDate ?? d.docDate)!, dueDate: due }, today);
    const requested = pendingAllocs.filter((a) => a.docId === d.id).reduce((s, a) => s.plus(a.amount).plus(a.tdsAmount), zero());
    return {
      id: d.id, docType: d.docType, docTypeLabel: DOC_TYPE_LABEL[d.docType], docNumber: d.docNumber, vendorId: d.vendorId, vendorName: d.vendor.displayName,
      status: d.status, statusLabel: DOC_STATUS_LABEL[d.status], dueDate: due, daysOverdue: over,
      group: over > 0 ? 'overdue' as const : due && due <= weekEnd ? 'this_week' as const : 'later' as const,
      owed: moneyText(owed), requested: moneyText(requested), okToPay: d.status === 'approved' || d.status === 'partially_paid' || isAdvance,
      isAdvance, msme: msme.level === 'none' ? null : { level: msme.level, limitDate: msme.limitDate, days: msme.daysSinceAcceptance },
    };
  }).filter((r) => new Decimal(r.owed ?? 0).greaterThan(0));
  const sumOf = (g: string) => moneyText(rows.filter((r) => r.group === g).reduce((s, r) => s.plus(r.owed ?? 0), zero()));
  return { rows, totals: { overdue: sumOf('overdue'), thisWeek: sumOf('this_week'), later: sumOf('later'), msmeAtRisk: rows.filter((r) => r.msme).length } };
}

/** F067 / BR-24: what is owed per vendor by days past due, with unapplied advances apart. */
export async function apAgeing() {
  const today = todayIST();
  const docs = await prisma.vendorDocument.findMany({
    where: { docType: 'tax_invoice', status: { in: ['received', 'approved', 'partially_paid', 'disputed'] }, outstanding: { gt: 0 } },
    include: { vendor: true },
  });
  const advances = await prisma.paymentAllocation.findMany({
    where: { isArchived: false, appliedToDocId: null, payment: { status: { in: RECORDED } }, OR: [{ poId: { not: null } }, { docId: { not: null } }] },
    include: { payment: { include: { vendor: true } } },
  });
  const advDocs = new Map((await prisma.vendorDocument.findMany({ where: { id: { in: advances.map((a) => a.docId).filter(Boolean) as string[] } } })).map((d) => [d.id, d]));
  type Row = { vendorId: string; vendorName: string; buckets: Record<AgeingBucket, Decimal>; advances: Decimal; total: Decimal };
  const by = new Map<string, Row>();
  const get = (v: Vendor) => by.get(v.id) ?? by.set(v.id, { vendorId: v.id, vendorName: v.displayName, buckets: { not_due: zero(), '1_30': zero(), '31_60': zero(), '61_90': zero(), '90_plus': zero() }, advances: zero(), total: zero() }).get(v.id)!;
  for (const d of docs) {
    const r = get(d.vendor);
    const b = ageingBucket(daysOverdue(dateText(d.dueDate), today));
    r.buckets[b] = r.buckets[b].plus(d.outstanding);
    r.total = r.total.plus(d.outstanding);
  }
  for (const a of advances) {
    // Advances on replaced proformas were moved to their tax invoice; only open ones count here.
    const d = a.docId ? advDocs.get(a.docId) : null;
    if (d && d.docType === 'tax_invoice') continue;
    get(a.payment.vendor).advances = get(a.payment.vendor).advances.plus(a.amount).plus(a.tdsAmount);
  }
  const rows = [...by.values()].sort((x, y) => y.total.comparedTo(x.total));
  const col = (k: AgeingBucket) => moneyText(rows.reduce((s, r) => s.plus(r.buckets[k]), zero()));
  return {
    asOf: today,
    buckets: Object.entries(AGEING_LABEL).map(([key, label]) => ({ key, label })),
    rows: rows.map((r) => ({ vendorId: r.vendorId, vendorName: r.vendorName, buckets: Object.fromEntries(Object.entries(r.buckets).map(([k, v]) => [k, moneyText(v)])), advances: moneyText(r.advances), total: moneyText(r.total) })),
    totals: { buckets: Object.fromEntries((Object.keys(AGEING_LABEL) as AgeingBucket[]).map((k) => [k, col(k)])), advances: moneyText(rows.reduce((s, r) => s.plus(r.advances), zero())), total: moneyText(rows.reduce((s, r) => s.plus(r.total), zero())) },
  };
}

/** Payments touching one document (for the bill page). */
export async function paymentsForDoc(docId: string) {
  const allocs = await prisma.paymentAllocation.findMany({
    where: { OR: [{ docId }, { appliedToDocId: docId }] },
    include: { payment: true },
    orderBy: { createdAt: 'asc' },
  });
  return allocs.map((a) => ({
    paymentId: a.paymentId, paymentNo: a.payment.paymentNo, status: a.payment.status, statusLabel: PAYMENT_STATUS_LABEL[a.payment.status],
    paidDate: dateText(a.payment.paidDate), gross: moneyText(a.amount.plus(a.tdsAmount)), tdsAmount: moneyText(a.tdsAmount),
    how: a.docId === docId ? (a.appliedToDocId ? 'advance, moved to the tax invoice' : 'paid') : 'advance applied', isArchived: a.isArchived,
  }));
}
