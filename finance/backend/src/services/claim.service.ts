import type { BankTxn, ExpenseClaim, ExpenseClaimStatus, Prisma, Reimbursement, ReimbursementStatus, TxnNature, User } from '@prisma/client';
import { prisma } from '../config/database';
import { withAudit, type AuditContext, type Tx } from '../lib/audit';
import { founderBalances } from '../lib/claims';
import { dateText, parseDate } from '../lib/dates';
import { todayIST } from '../lib/fy';
import { UserError } from '../lib/http';
import { Decimal, moneyText } from '../lib/money';
import { matchBankRow } from '../lib/payables';
import { presentKinds } from './attachment.service';
import { takeNumber } from './numbering.service';
import { PAYMENT_MODES, type PaymentMode } from './payment.service';
import { getCompany } from './settings.service';

/**
 * M14 Founder expenses & reimbursements (F150, F151, D32; BR-27). A founder who paid a company
 * expense personally submits a claim with the receipt; the other founder approves it. An approved
 * claim is a payable to the founder and counts as spending on the expense date. A reimbursement
 * (PMT number) pays one or more approved claims back and is matched to its bank debit, which is
 * categorised Founder Reimbursement (nature Reimbursement, outside burn: the expense already counted).
 * Money a founder puts INTO the company is never a claim: it is capital or a loan (Founder Funds).
 */

export const CLAIM_STATUS_LABEL: Record<ExpenseClaimStatus, string> = {
  submitted: 'Waiting for approval', approved: 'To reimburse', reimbursed: 'Reimbursed', rejected: 'Rejected', cancelled: 'Withdrawn',
};
export const REIMBURSEMENT_STATUS_LABEL: Record<ReimbursementStatus, string> = { paid: 'Paid', reconciled: 'In bank statement', failed: 'Failed' };
/** Natures a claim may carry: spending only. */
const CLAIM_NATURES: TxnNature[] = ['operating_expense', 'cogs', 'capex', 'interest'];
/** Files that count as the receipt (F150 receipt upload*). */
const RECEIPT_KINDS = ['receipt', 'bill', 'proof', 'other'];
const COUNTED: ExpenseClaimStatus[] = ['approved', 'reimbursed'];

const text = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
const money = (v: string, field: string) => {
  const clean = String(v ?? '').replace(/[,\s₹]/g, '');
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(clean)) throw new UserError(`${field} is not a valid amount: ${v}`);
  const d = new Decimal(clean);
  if (!d.greaterThan(0)) throw new UserError(`${field} must be more than zero`);
  return d;
};
const fullName = (u: Pick<User, 'firstName' | 'lastName'>) => `${u.firstName} ${u.lastName}`.trim();

export type ClaimInput = {
  founderUserId?: string | null;
  expenseDate: string;
  paidFrom: string;
  vendorName: string;
  description?: string | null;
  amount: string;
  hasGstInvoice: boolean;
  categoryId: string;
  subCategoryId?: string | null;
};
export type ReimburseInput = { founderUserId: string; claimIds: string[]; paidDate: string; mode: PaymentMode; fromBankAccountId: string; utr?: string | null; notes?: string | null };

/** Founders who can hold claims: the app's active users (v1: Rishabh and Arnav). */
export async function founders() {
  const users = await prisma.user.findMany({ where: { isActive: true }, orderBy: { firstName: 'asc' } });
  return users.map((u) => ({ id: u.id, name: fullName(u) }));
}

async function checkedFields(input: ClaimInput) {
  const expenseDate = dateText(parseDate(input.expenseDate, 'Expense date'))!;
  if (expenseDate > todayIST()) throw new UserError('The expense date cannot be in the future');
  const paidFrom = text(input.paidFrom);
  if (!paidFrom) throw new UserError('Say which personal account or card paid it');
  const vendorName = text(input.vendorName);
  if (!vendorName) throw new UserError('Enter who was paid');
  const category = await prisma.category.findUnique({ where: { id: input.categoryId }, include: { subCategories: true } });
  if (!category || !category.isActive) throw new UserError('Choose a category');
  const sub = input.subCategoryId ? category.subCategories.find((s) => s.id === input.subCategoryId && s.isActive) : null;
  if (input.subCategoryId && !sub) throw new UserError('That sub-category is not under the category');
  const nature = sub?.natureOverride ?? category.natureDefault;
  if (!CLAIM_NATURES.includes(nature)) {
    throw new UserError(category.name === 'Founder Funds'
      ? 'Money a founder puts into the company is not a claim: record it as capital or a loan (Founder Funds)'
      : 'A claim is for a company expense: choose an expense, COGS, capex or interest category');
  }
  return { expenseDate, paidFrom, vendorName, nature, amount: money(input.amount, 'Amount'), categoryId: category.id, subCategoryId: sub?.id ?? null };
}

async function loadClaim(id: string) {
  const c = await prisma.expenseClaim.findUnique({ where: { id } });
  if (!c) throw new UserError('Claim not found', 404);
  return c;
}

/** F150: add a claim. A founder may enter it for the other founder (who then cannot approve it). */
export async function createClaim(ctx: AuditContext, input: ClaimInput) {
  const f = await checkedFields(input);
  const founderUserId = input.founderUserId || ctx.userId;
  const founder = await prisma.user.findUnique({ where: { id: founderUserId } });
  if (!founder || !founder.isActive) throw new UserError('Choose the founder who paid');
  const company = await getCompany();
  const c = await withAudit({ ...ctx, reason: ctx.reason ?? 'Expense claim submitted' }, (tx) => tx.expenseClaim.create({
    data: {
      entityId: company.id, founderUserId, expenseDate: parseDate(f.expenseDate), paidFrom: f.paidFrom, vendorName: f.vendorName,
      description: text(input.description), amount: f.amount, hasGstInvoice: input.hasGstInvoice, categoryId: f.categoryId,
      subCategoryId: f.subCategoryId, nature: f.nature, status: 'submitted',
    },
  }));
  return getClaim(c.id);
}

export async function updateClaim(ctx: AuditContext, id: string, input: ClaimInput) {
  const c = await loadClaim(id);
  if (c.status !== 'submitted') throw new UserError('Only a claim waiting for approval can be edited');
  if (input.founderUserId && input.founderUserId !== c.founderUserId) throw new UserError('The founder of a claim cannot change; withdraw it and add a new one');
  const f = await checkedFields(input);
  await withAudit({ ...ctx, reason: ctx.reason ?? 'Expense claim edited' }, (tx) => tx.expenseClaim.update({
    where: { id },
    data: {
      expenseDate: parseDate(f.expenseDate), paidFrom: f.paidFrom, vendorName: f.vendorName, description: text(input.description),
      amount: f.amount, hasGstInvoice: input.hasGstInvoice, categoryId: f.categoryId, subCategoryId: f.subCategoryId, nature: f.nature,
    },
  }));
  return getClaim(id);
}

/** BR-27: approved by someone other than the founder, with the receipt attached. */
export async function approveClaim(ctx: AuditContext, id: string) {
  const c = await loadClaim(id);
  if (c.status !== 'submitted') throw new UserError(`This claim is ${CLAIM_STATUS_LABEL[c.status].toLowerCase()}`);
  if (c.founderUserId === ctx.userId) throw new UserError('The other founder approves your claim');
  const kinds = await presentKinds('ExpenseClaim', id);
  if (!RECEIPT_KINDS.some((k) => kinds.has(k))) throw new UserError('Attach the receipt or bill before approving');
  await withAudit({ ...ctx, reason: ctx.reason ?? 'Expense claim approved' }, (tx) => tx.expenseClaim.update({
    where: { id }, data: { status: 'approved', approvedBy: ctx.userId, approvedAt: new Date() },
  }));
  return getClaim(id);
}

/** Rejected by the other founder (not a company expense), or withdrawn by the founder. */
export async function closeClaim(ctx: AuditContext, id: string, how: 'rejected' | 'cancelled') {
  if (!ctx.reason?.trim()) throw new UserError(how === 'rejected' ? 'Say why the claim is rejected' : 'Say why the claim is withdrawn');
  const c = await loadClaim(id);
  if (c.status !== 'submitted') throw new UserError('Only a claim waiting for approval can be rejected or withdrawn');
  if (how === 'rejected' && c.founderUserId === ctx.userId) throw new UserError('Withdraw your own claim instead of rejecting it');
  if (how === 'cancelled' && c.founderUserId !== ctx.userId) throw new UserError('Only the founder who made the claim can withdraw it; reject it instead');
  await withAudit(ctx, (tx) => tx.expenseClaim.update({ where: { id }, data: { status: how, statusReason: ctx.reason } }));
  return getClaim(id);
}

// ---------- F151: reimbursement ----------

/** F151: pay one or more approved claims of one founder. The amount is their total. */
export async function reimburse(ctx: AuditContext, r: ReimburseInput) {
  if (!r.claimIds.length) throw new UserError('Choose the claims this pays');
  if (!PAYMENT_MODES.includes(r.mode)) throw new UserError('Choose how it was paid');
  const utr = text(r.utr);
  if (!utr && r.mode !== 'cash') throw new UserError('Enter the UTR / reference from the bank');
  const paidDate = dateText(parseDate(r.paidDate, 'Paid on'))!;
  if (paidDate > todayIST()) throw new UserError('The payment date cannot be in the future');
  const account = await prisma.bankAccount.findUnique({ where: { id: r.fromBankAccountId } });
  if (!account || account.owner !== 'Entelechy') throw new UserError('Choose the company account it was paid from');
  const claims = await prisma.expenseClaim.findMany({ where: { id: { in: r.claimIds } } });
  if (claims.length !== new Set(r.claimIds).size) throw new UserError('A chosen claim was not found');
  for (const c of claims) {
    if (c.founderUserId !== r.founderUserId) throw new UserError('All the claims must be the same founder\'s');
    if (c.status !== 'approved') throw new UserError(`A claim of ${moneyText(c.amount)} is ${CLAIM_STATUS_LABEL[c.status].toLowerCase()}, not approved`);
  }
  const amount = claims.reduce((s, c) => s.plus(c.amount), new Decimal(0));
  const company = await getCompany();
  const id = await withAudit({ ...ctx, reason: ctx.reason ?? 'Founder reimbursed' }, async (tx) => {
    const reimbursementNo = await takeNumber(tx, company.id, 'payment', paidDate);
    const created = await tx.reimbursement.create({
      data: { entityId: company.id, reimbursementNo, founderUserId: r.founderUserId, amount, paidDate: parseDate(paidDate), mode: r.mode, fromBankAccountId: account.id, utr, status: 'paid', notes: text(r.notes) },
    });
    await tx.expenseClaim.updateMany({ where: { id: { in: r.claimIds } }, data: { status: 'reimbursed', reimbursementId: created.id } });
    await matchToStatement(tx, created.id);
    return created.id;
  });
  return getReimbursement(id);
}

/** The bank returned it: the number stays, the claims are owed again. */
export async function markReimbursementFailed(ctx: AuditContext, id: string) {
  if (!ctx.reason?.trim()) throw new UserError('Say what happened (e.g. "returned by the bank")');
  const r = await loadReimbursement(id);
  if (r.status === 'failed') throw new UserError('This reimbursement is already marked failed');
  await withAudit(ctx, async (tx) => {
    if (r.bankTxnId) await unlinkRow(tx, r.bankTxnId);
    await tx.reimbursement.update({ where: { id }, data: { status: 'failed', statusReason: ctx.reason, bankTxnId: null, matchedBy: null } });
    await tx.expenseClaim.updateMany({ where: { reimbursementId: id }, data: { status: 'approved', reimbursementId: null } });
  });
  return getReimbursement(id);
}

async function loadReimbursement(id: string) {
  const r = await prisma.reimbursement.findUnique({ where: { id } });
  if (!r) throw new UserError('Reimbursement not found', 404);
  return r;
}

// ---------- BR-08 bank matching (same rule as vendor payments) ----------

const MATCHABLE_ROW: Prisma.BankTxnWhereInput = { linkedDocId: null, debit: { gt: 0 }, status: { in: ['review', 'suggested', 'categorised'] } };

async function founderNames(userId: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return [fullName(u), u.firstName];
}

async function reimbursementCategory(tx: Tx) {
  const c = await tx.category.findFirst({ where: { name: 'Founder Reimbursement' }, include: { subCategories: true } });
  if (!c) return null;
  const sub = c.subCategories.find((s) => s.name === 'Reimbursement to Founder') ?? null;
  return { categoryId: c.id, subCategoryId: sub?.id ?? null, nature: sub?.natureOverride ?? c.natureDefault };
}

async function linkRow(tx: Tx, r: Reimbursement, row: BankTxn, by: string) {
  const cat = await reimbursementCategory(tx);
  const keepPersonCategory = row.status === 'categorised';
  await tx.bankTxn.update({
    where: { id: row.id },
    data: {
      linkedDocType: 'Reimbursement', linkedDocId: r.id, partyType: 'founder', partyId: r.founderUserId,
      ...(keepPersonCategory || !cat ? {} : { ...cat, status: 'suggested', categorisationReason: `Matched ${r.reimbursementNo} (${by === 'utr' ? 'UTR' : by === 'manual' ? 'linked by hand' : 'amount, date and name'})` }),
    },
  });
  await tx.reimbursement.update({ where: { id: r.id }, data: { bankTxnId: row.id, matchedBy: by, status: 'reconciled' } });
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

const candidate = (r: BankTxn) => ({ id: r.id, bankAccountId: r.bankAccountId, txnDate: dateText(r.txnDate)!, debit: r.debit, utr: r.utr, counterpartyName: r.counterpartyName, narrationRaw: r.narrationRaw });

async function matchToStatement(tx: Tx, id: string) {
  const r = await tx.reimbursement.findUniqueOrThrow({ where: { id } });
  if (r.status !== 'paid') return false;
  const rows = await tx.bankTxn.findMany({
    where: { ...MATCHABLE_ROW, debit: r.amount, bankAccountId: r.fromBankAccountId,
      OR: [{ txnDate: { gte: new Date(r.paidDate.getTime() - 3 * 86_400_000), lte: new Date(r.paidDate.getTime() + 3 * 86_400_000) } }, ...(r.utr ? [{ utr: r.utr }, { narrationRaw: { contains: r.utr } }] : [])] },
  });
  const m = matchBankRow({ amount: r.amount, paidDate: dateText(r.paidDate)!, utr: r.utr, bankAccountId: r.fromBankAccountId, vendorNames: await founderNames(r.founderUserId) }, rows.map(candidate));
  if (!m) return false;
  await linkRow(tx, r, rows.find((x) => x.id === m.txnId)!, m.by);
  return true;
}

/** BR-05 step 1 on import: new debits that are recorded reimbursements take that link and category. */
export async function matchReimbursementsForTxns(tx: Tx, txnIds: string[]): Promise<number> {
  if (!txnIds.length) return 0;
  const rows = await tx.bankTxn.findMany({ where: { id: { in: txnIds }, ...MATCHABLE_ROW } });
  if (!rows.length) return 0;
  const open = await tx.reimbursement.findMany({ where: { status: 'paid', bankTxnId: null, amount: { in: [...new Set(rows.map((r) => r.debit.toFixed(2)))].map((v) => new Decimal(v)) } } });
  let matched = 0;
  const taken = new Set<string>();
  for (const r of open) {
    const free = rows.filter((x) => !taken.has(x.id));
    const m = matchBankRow({ amount: r.amount, paidDate: dateText(r.paidDate)!, utr: r.utr, bankAccountId: r.fromBankAccountId, vendorNames: await founderNames(r.founderUserId) }, free.map(candidate));
    if (!m) continue;
    await linkRow(tx, r, free.find((x) => x.id === m.txnId)!, m.by);
    taken.add(m.txnId);
    matched += 1;
  }
  return matched;
}

export async function reimbursementBankCandidates(id: string) {
  const r = await loadReimbursement(id);
  if (r.status !== 'paid') return [];
  const rows = await prisma.bankTxn.findMany({
    where: { ...MATCHABLE_ROW, debit: r.amount, bankAccountId: r.fromBankAccountId,
      txnDate: { gte: new Date(r.paidDate.getTime() - 10 * 86_400_000), lte: new Date(r.paidDate.getTime() + 10 * 86_400_000) } },
    orderBy: { txnDate: 'asc' },
  });
  return rows.map((x) => ({ id: x.id, txnDate: dateText(x.txnDate), counterpartyName: x.counterpartyName, utr: x.utr, debit: moneyText(x.debit), narration: x.narrationRaw }));
}

export async function linkReimbursementRow(ctx: AuditContext, id: string, txnId: string) {
  const r = await loadReimbursement(id);
  if (r.status !== 'paid') throw new UserError('Only a reimbursement that is not yet linked can be linked');
  const row = await prisma.bankTxn.findUnique({ where: { id: txnId } });
  if (!row || row.linkedDocId || !row.debit.equals(r.amount)) throw new UserError('That bank row is not a free debit of the same amount');
  if (!['review', 'suggested', 'categorised'].includes(row.status)) throw new UserError('That bank row is split, a transfer or ignored');
  await withAudit({ ...ctx, reason: ctx.reason ?? 'Reimbursement linked to bank row by hand' }, (tx) => linkRow(tx, r, row, 'manual'));
  return getReimbursement(id);
}

export async function unlinkReimbursementRow(ctx: AuditContext, id: string) {
  const r = await loadReimbursement(id);
  if (r.status !== 'reconciled' || !r.bankTxnId) throw new UserError('This reimbursement is not linked to a bank row');
  if (!ctx.reason?.trim()) throw new UserError('Say why the link is wrong');
  await withAudit(ctx, async (tx) => {
    await unlinkRow(tx, r.bankTxnId!);
    await tx.reimbursement.update({ where: { id }, data: { bankTxnId: null, matchedBy: null, status: 'paid' } });
  });
  return getReimbursement(id);
}

// ---------- Views ----------

async function lookups() {
  const [users, categories] = await Promise.all([
    prisma.user.findMany(),
    prisma.category.findMany({ include: { subCategories: true } }),
  ]);
  const userName = new Map(users.map((u) => [u.id, fullName(u)]));
  const catName = new Map(categories.map((c) => [c.id, c.name]));
  const subName = new Map(categories.flatMap((c) => c.subCategories.map((s) => [s.id, s.name] as const)));
  return { userName, catName, subName };
}

function claimRow(c: ExpenseClaim, l: Awaited<ReturnType<typeof lookups>>) {
  return {
    id: c.id, founderUserId: c.founderUserId, founderName: l.userName.get(c.founderUserId) ?? '—', expenseDate: dateText(c.expenseDate),
    paidFrom: c.paidFrom, vendorName: c.vendorName, description: c.description, amount: moneyText(c.amount), hasGstInvoice: c.hasGstInvoice,
    categoryId: c.categoryId, subCategoryId: c.subCategoryId, categoryName: l.catName.get(c.categoryId) ?? '—',
    subCategoryName: c.subCategoryId ? l.subName.get(c.subCategoryId) ?? null : null, nature: c.nature,
    status: c.status, statusLabel: CLAIM_STATUS_LABEL[c.status], statusReason: c.statusReason,
    approvedByName: c.approvedBy ? l.userName.get(c.approvedBy) ?? null : null, approvedAt: c.approvedAt, reimbursementId: c.reimbursementId,
  };
}

export async function listClaims(f: { founderUserId?: string; status?: string } = {}) {
  const l = await lookups();
  const rows = await prisma.expenseClaim.findMany({
    where: { ...(f.founderUserId && { founderUserId: f.founderUserId }), ...(f.status && { status: f.status as ExpenseClaimStatus }) },
    orderBy: [{ expenseDate: 'desc' }, { createdAt: 'desc' }],
  });
  return rows.map((c) => claimRow(c, l));
}

export async function getClaim(id: string) {
  const c = await loadClaim(id);
  const l = await lookups();
  const r = c.reimbursementId ? await prisma.reimbursement.findUnique({ where: { id: c.reimbursementId } }) : null;
  const kinds = await presentKinds('ExpenseClaim', id);
  return {
    ...claimRow(c, l),
    hasReceipt: RECEIPT_KINDS.some((k) => kinds.has(k)),
    reimbursement: r ? { id: r.id, reimbursementNo: r.reimbursementNo, paidDate: dateText(r.paidDate), status: r.status, statusLabel: REIMBURSEMENT_STATUS_LABEL[r.status] } : null,
  };
}

/** D32: owed to each founder = approved claims - reimbursements (BR-27). */
export async function balances() {
  const [list, claims, paid] = await Promise.all([
    founders(),
    prisma.expenseClaim.findMany({ where: { status: { in: ['submitted', 'approved', 'reimbursed'] } } }),
    prisma.reimbursement.findMany({ where: { status: { not: 'failed' } } }),
  ]);
  const b = founderBalances(
    claims.map((c) => ({ founderId: c.founderUserId, amount: c.amount, status: c.status })),
    paid.map((r) => ({ founderId: r.founderUserId, amount: r.amount })),
  );
  const empty = { claimed: '0.00', reimbursed: '0.00', owed: '0.00', waiting: '0.00' };
  return list.map((u) => {
    const v = b[u.id] ?? empty;
    return { founderUserId: u.id, founderName: u.name, claimed: moneyText(new Decimal(v.claimed)), reimbursed: moneyText(new Decimal(v.reimbursed)), owed: moneyText(new Decimal(v.owed)), waiting: moneyText(new Decimal(v.waiting)) };
  });
}

function reimbursementRow(r: Reimbursement, l: Awaited<ReturnType<typeof lookups>>) {
  return {
    id: r.id, reimbursementNo: r.reimbursementNo, founderUserId: r.founderUserId, founderName: l.userName.get(r.founderUserId) ?? '—',
    amount: moneyText(r.amount), paidDate: dateText(r.paidDate), mode: r.mode, utr: r.utr, status: r.status,
    statusLabel: REIMBURSEMENT_STATUS_LABEL[r.status], statusReason: r.statusReason, bankTxnId: r.bankTxnId, matchedBy: r.matchedBy,
  };
}

export async function listReimbursements() {
  const l = await lookups();
  const rows = await prisma.reimbursement.findMany({ orderBy: [{ paidDate: 'desc' }, { createdAt: 'desc' }] });
  return rows.map((r) => reimbursementRow(r, l));
}

export async function getReimbursement(id: string) {
  const r = await loadReimbursement(id);
  const l = await lookups();
  const claims = await prisma.expenseClaim.findMany({ where: { OR: [{ reimbursementId: id }] }, orderBy: { expenseDate: 'asc' } });
  const account = await prisma.bankAccount.findUnique({ where: { id: r.fromBankAccountId } });
  const row = r.bankTxnId ? await prisma.bankTxn.findUnique({ where: { id: r.bankTxnId } }) : null;
  return {
    ...reimbursementRow(r, l),
    fromAccount: account ? `${account.bankName} •••• ${account.accountNumber.slice(-4)}` : null,
    bankRow: row ? { id: row.id, txnDate: dateText(row.txnDate), counterpartyName: row.counterpartyName, debit: moneyText(row.debit) } : null,
    claims: claims.map((c) => claimRow(c, l)),
  };
}
