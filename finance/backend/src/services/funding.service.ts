import type { BankTxn, CapitalReceipt, Loan, LoanInstalment, LoanRepayment, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { withAudit, type AuditContext, type Tx } from '../lib/audit';
import { dateText, parseDate } from '../lib/dates';
import { fyRange, todayIST } from '../lib/fy';
import { UserError } from '../lib/http';
import { accruedInterest, addMonths, covenantCheck, flexibleState, loanSchedule, shareApplicationAlert } from '../lib/loans';
import { Decimal, moneyText } from '../lib/money';
import { matchBankRow } from '../lib/payables';
import { getCompany } from './settings.service';

/**
 * M13 Funding & Loans (F140-F143, BR-28). Capital receipts (paid-up capital, share application
 * money and its allotment), the loan register (EMI, bullet, flexible), schedules and repayments
 * split into principal (Financing out) and interest (Interest), and the covenant check of total
 * debt against the Mesa cap. Bank rows are linked to these records like payments (BR-08).
 */

export const CAPITAL_TYPES = ['paid_up_capital', 'share_application_money'] as const;
export const CAPITAL_TYPE_LABEL: Record<string, string> = { paid_up_capital: 'Paid-up capital', share_application_money: 'Share application money' };
export const REPAYMENT_TYPES = ['emi', 'bullet', 'flexible'] as const;
export const REPAYMENT_TYPE_LABEL: Record<string, string> = { emi: 'EMI', bullet: 'Bullet', flexible: 'Flexible (repay any time)' };

const zero = () => new Decimal(0);
const text = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
const DAY = 86_400_000;
const num = (v: string | null | undefined, field: string) => {
  const clean = String(v ?? '').replace(/[,\s₹%]/g, '');
  if (!/^\d{1,12}(\.\d{1,3})?$/.test(clean)) throw new UserError(`${field} is not a valid number: ${v}`);
  return new Decimal(clean);
};
const sum = <T>(xs: T[], f: (x: T) => Decimal) => xs.reduce((s, x) => s.plus(f(x)), zero());

// ---------- Settings and covenant (F143) ----------

async function setting() {
  const company = await getCompany();
  return (await prisma.fundingSetting.findUnique({ where: { entityId: company.id } })) ?? { id: null, entityId: company.id, debtCap: new Decimal(4500000), countSanctionedLimit: false };
}

export async function getFundingSetting() {
  const s = await setting();
  return { debtCap: s.debtCap.toFixed(2), countSanctionedLimit: s.countSanctionedLimit };
}

export async function saveFundingSetting(ctx: AuditContext, input: { debtCap: string; countSanctionedLimit: boolean }) {
  const cap = num(input.debtCap, 'Debt cap');
  if (cap.lessThanOrEqualTo(0)) throw new UserError('Enter the debt cap');
  const company = await getCompany();
  await withAudit({ ...ctx, reason: ctx.reason ?? 'Debt cap changed' }, (tx) => tx.fundingSetting.upsert({
    where: { entityId: company.id }, create: { entityId: company.id, debtCap: cap, countSanctionedLimit: input.countSanctionedLimit }, update: { debtCap: cap, countSanctionedLimit: input.countSanctionedLimit },
  }));
  return getFundingSetting();
}

/** Principal repaid and what is left on a loan. */
function loanBalance(l: Loan, repayments: LoanRepayment[]) {
  const repaid = sum(repayments.filter((r) => r.status === 'recorded'), (r) => r.principal);
  return { repaid, balance: Decimal.max(l.disbursedAmount.minus(repaid), zero()) };
}

/** Cash credit drawn (or sanctioned, if the agreement counts limits; Q14) from the CC accounts' latest balance. */
async function cashCreditDebt(countSanctioned: boolean) {
  const ccs = await prisma.bankAccount.findMany({ where: { accountType: 'cash_credit', isArchived: false } });
  let total = zero();
  for (const a of ccs) {
    if (countSanctioned && a.sanctionedLimit) { total = total.plus(a.sanctionedLimit); continue; }
    const last = await prisma.bankTxn.findFirst({ where: { bankAccountId: a.id }, orderBy: [{ txnDate: 'desc' }, { seq: 'desc' }] });
    const bal = last?.balance ?? a.openingBalance;
    if (bal.isNegative()) total = total.plus(bal.negated());
  }
  return total;
}

/** BR-28: total debt against the cap, optionally with a new loan being added. */
export async function covenant(adding: Decimal = zero()) {
  const s = await setting();
  const loans = await prisma.loan.findMany({ where: { status: 'active', countsTowardCovenant: true }, include: { repayments: true } });
  const loansOutstanding = sum(loans, (l) => loanBalance(l, l.repayments).balance);
  const cc = await cashCreditDebt(s.countSanctionedLimit);
  return { ...covenantCheck({ loansOutstanding, cashCreditDrawn: cc, cap: s.debtCap, adding }), loansOutstanding: loansOutstanding.toFixed(2), cashCredit: cc.toFixed(2), countSanctionedLimit: s.countSanctionedLimit };
}

// ---------- Bank rows ----------

const FREE: Prisma.BankTxnWhereInput = { linkedDocId: null, status: { in: ['review', 'suggested', 'categorised'] } };

async function categoryIds(tx: Tx, category: string, sub: string | null) {
  const c = await tx.category.findFirst({ where: { name: category }, include: { subCategories: true } });
  if (!c) return null;
  const s = sub ? c.subCategories.find((x) => x.name === sub) ?? null : null;
  return { categoryId: c.id, subCategoryId: s?.id ?? null, nature: s?.natureOverride ?? c.natureDefault };
}

async function linkSimple(tx: Tx, row: BankTxn, docType: string, docId: string, partyType: 'lender' | 'founder', cat: Awaited<ReturnType<typeof categoryIds>>, why: string) {
  const keep = row.status === 'categorised';
  await tx.bankTxn.update({ where: { id: row.id }, data: { linkedDocType: docType, linkedDocId: docId, partyType, ...(keep || !cat ? {} : { ...cat, status: 'suggested', categorisationReason: why }) } });
}

/** A repayment's bank debit: split into principal (Financing out) and interest (Interest) when both. */
async function linkRepaymentRow(tx: Tx, r: LoanRepayment, row: BankTxn, by: string, lender: string) {
  const why = `Matched repayment to ${lender} (${by === 'manual' ? 'linked by hand' : by === 'utr' ? 'UTR' : 'amount, date and name'})`;
  const principal = await categoryIds(tx, 'Financing', 'Loan Principal Repaid');
  const interest = await categoryIds(tx, 'Financing', 'Loan Interest');
  if (r.interest.greaterThan(0) && r.principal.greaterThan(0) && principal && interest) {
    await tx.txnSplit.updateMany({ where: { bankTxnId: row.id, isArchived: false }, data: { isArchived: true } });
    await tx.txnSplit.create({ data: { bankTxnId: row.id, lineNo: 1, amount: r.principal, ...principal, partyType: 'lender', description: `Principal to ${lender}`, linkedDocType: 'LoanRepayment', linkedDocId: r.id } });
    await tx.txnSplit.create({ data: { bankTxnId: row.id, lineNo: 2, amount: r.interest, ...interest, partyType: 'lender', description: `Interest to ${lender}`, linkedDocType: 'LoanRepayment', linkedDocId: r.id } });
    await tx.bankTxn.update({ where: { id: row.id }, data: { linkedDocType: 'LoanRepayment', linkedDocId: r.id, partyType: 'lender', status: 'split', categoryId: null, subCategoryId: null, nature: null, categorisationReason: `${why}: principal and interest` } });
  } else {
    await linkSimple(tx, row, 'LoanRepayment', r.id, 'lender', r.interest.greaterThan(0) && r.principal.isZero() ? interest : principal, why);
  }
  await tx.loanRepayment.update({ where: { id: r.id }, data: { bankTxnId: row.id, matchedBy: by } });
}

async function unlinkRow(tx: Tx, txnId: string) {
  const row = await tx.bankTxn.findUnique({ where: { id: txnId } });
  if (!row) return;
  const ours = row.categorisationReason?.startsWith('Matched ');
  if (row.status === 'split' && ours) {
    await tx.txnSplit.updateMany({ where: { bankTxnId: txnId, isArchived: false }, data: { isArchived: true } });
    await tx.bankTxn.update({ where: { id: txnId }, data: { linkedDocType: null, linkedDocId: null, status: 'review', categorisationReason: 'Funding link removed' } });
    return;
  }
  await tx.bankTxn.update({ where: { id: txnId }, data: { linkedDocType: null, linkedDocId: null, ...(row.status === 'suggested' && ours ? { status: 'review', categoryId: null, subCategoryId: null, nature: null, categorisationReason: null } : {}) } });
}

const capitalCategory = (tx: Tx, holder: string) => tx.category.findFirst({ where: { name: 'Founder Funds' }, include: { subCategories: true } }).then((c) => {
  if (!c) return null;
  const first = holder.trim().split(/\s+/)[0]?.toLowerCase();
  const s = c.subCategories.find((x) => first && x.name.toLowerCase().includes(first)) ?? null;
  return { categoryId: c.id, subCategoryId: s?.id ?? null, nature: s?.natureOverride ?? c.natureDefault };
});

const asCandidate = (r: BankTxn, credit: boolean) => ({ id: r.id, bankAccountId: r.bankAccountId, txnDate: dateText(r.txnDate)!, debit: credit ? r.credit : r.debit, utr: r.utr, counterpartyName: r.counterpartyName ?? r.narrationRaw, narrationRaw: r.narrationRaw });

/** On statement import: rows that are recorded capital, loan money in, or repayments. */
export async function matchFundingForTxns(tx: Tx, txnIds: string[]) {
  if (!txnIds.length) return 0;
  const rows = await tx.bankTxn.findMany({ where: { id: { in: txnIds }, ...FREE } });
  if (!rows.length) return 0;
  let n = 0;
  const taken = new Set<string>();
  const pick = (amount: Decimal, date: string, names: string[], credit: boolean) => {
    const free = rows.filter((r) => !taken.has(r.id) && (credit ? r.credit.greaterThan(0) : r.debit.greaterThan(0)));
    const m = matchBankRow({ amount, paidDate: date, utr: null, bankAccountId: null, vendorNames: names }, free.map((r) => asCandidate(r, credit)));
    return m ? free.find((r) => r.id === m.txnId)! : null;
  };
  for (const c of await tx.capitalReceipt.findMany({ where: { status: 'recorded', bankTxnId: null } })) {
    const row = pick(c.amount, dateText(c.receiptDate)!, [c.holderName], true);
    if (!row) continue;
    await linkSimple(tx, row, 'CapitalReceipt', c.id, 'founder', await capitalCategory(tx, c.holderName), `Matched ${CAPITAL_TYPE_LABEL[c.type].toLowerCase()} from ${c.holderName}`);
    await tx.capitalReceipt.update({ where: { id: c.id }, data: { bankTxnId: row.id, matchedBy: 'amount_date_name' } });
    taken.add(row.id); n += 1;
  }
  for (const l of await tx.loan.findMany({ where: { status: { not: 'cancelled' }, bankTxnId: null } })) {
    const row = pick(l.disbursedAmount, dateText(l.disbursedDate)!, [l.lender], true);
    if (!row) continue;
    await linkSimple(tx, row, 'Loan', l.id, 'lender', await categoryIds(tx, 'Financing', 'Loan Received'), `Matched loan from ${l.lender}`);
    await tx.loan.update({ where: { id: l.id }, data: { bankTxnId: row.id, matchedBy: 'amount_date_name' } });
    taken.add(row.id); n += 1;
  }
  for (const r of await tx.loanRepayment.findMany({ where: { status: 'recorded', bankTxnId: null }, include: { loan: true } })) {
    const row = pick(r.principal.plus(r.interest), dateText(r.paidDate)!, [r.loan.lender], false);
    if (!row) continue;
    await linkRepaymentRow(tx, r, row, 'amount_date_name', r.loan.lender);
    taken.add(row.id); n += 1;
  }
  return n;
}

/** Free bank rows near a date with this amount (credit or debit), for linking by hand. */
async function candidates(amount: Decimal, date: Date, credit: boolean) {
  const rows = await prisma.bankTxn.findMany({ where: { ...FREE, ...(credit ? { credit: amount } : { debit: amount }), txnDate: { gte: new Date(date.getTime() - 15 * DAY), lte: new Date(date.getTime() + 15 * DAY) } }, orderBy: { txnDate: 'asc' } });
  return rows.map((r) => ({ id: r.id, txnDate: dateText(r.txnDate), counterpartyName: r.counterpartyName, amount: moneyText(credit ? r.credit : r.debit), narration: r.narrationRaw }));
}

async function freeRow(txnId: string, amount: Decimal, credit: boolean) {
  const row = await prisma.bankTxn.findUnique({ where: { id: txnId } });
  if (!row || row.linkedDocId || !(credit ? row.credit : row.debit).equals(amount)) throw new UserError(`That bank row is not a free ${credit ? 'credit' : 'debit'} of the same amount`);
  if (!['review', 'suggested', 'categorised'].includes(row.status)) throw new UserError('That bank row is split, a transfer or ignored');
  return row;
}

// ---------- F140 capital ----------

export type CapitalInput = { holderName: string; founderUserId?: string | null; receiptDate: string; amount: string; type: string; allotmentDate?: string | null; sharesAllotted?: number | null; notes?: string | null; bankTxnId?: string | null };

function capitalRow(c: CapitalReceipt, today = todayIST()) {
  const alert = c.type === 'share_application_money' && c.status === 'recorded' ? shareApplicationAlert({ receivedOn: dateText(c.receiptDate)!, allotmentDate: dateText(c.allotmentDate) }, today) : null;
  return {
    id: c.id, holderName: c.holderName, receiptDate: dateText(c.receiptDate), amount: c.amount.toFixed(2), type: c.type, typeLabel: CAPITAL_TYPE_LABEL[c.type],
    allotmentDate: dateText(c.allotmentDate), sharesAllotted: c.sharesAllotted, allotted: c.type === 'paid_up_capital' || !!c.allotmentDate, pendingAllotment: alert,
    inBank: !!c.bankTxnId, bankTxnId: c.bankTxnId, status: c.status, statusReason: c.statusReason, notes: c.notes,
  };
}

export async function listCapital() {
  const rows = await prisma.capitalReceipt.findMany({ orderBy: [{ receiptDate: 'desc' }, { createdAt: 'desc' }] });
  return rows.map((c) => capitalRow(c));
}

export async function createCapital(ctx: AuditContext, input: CapitalInput) {
  if (!text(input.holderName)) throw new UserError('Whose money is it?');
  if (!CAPITAL_TYPES.includes(input.type as (typeof CAPITAL_TYPES)[number])) throw new UserError('Choose paid-up capital or share application money');
  const amount = num(input.amount, 'Amount');
  if (amount.lessThanOrEqualTo(0)) throw new UserError('Enter the amount');
  const date = parseDate(input.receiptDate, 'Date received');
  if (dateText(date)! > todayIST()) throw new UserError('The date cannot be in the future');
  const row = input.bankTxnId ? await freeRow(input.bankTxnId, amount, true) : null;
  const company = await getCompany();
  const c = await withAudit({ ...ctx, reason: ctx.reason ?? `${CAPITAL_TYPE_LABEL[input.type]} from ${input.holderName.trim()}` }, async (tx) => {
    const c = await tx.capitalReceipt.create({
      data: {
        entityId: company.id, holderName: input.holderName.trim(), founderUserId: text(input.founderUserId), receiptDate: date, amount, type: input.type,
        allotmentDate: input.allotmentDate ? parseDate(input.allotmentDate, 'Allotment date') : null, sharesAllotted: input.sharesAllotted ?? null, notes: text(input.notes),
      },
    });
    if (row) {
      await linkSimple(tx, row, 'CapitalReceipt', c.id, 'founder', await capitalCategory(tx, c.holderName), `Matched ${CAPITAL_TYPE_LABEL[c.type].toLowerCase()} from ${c.holderName} (linked by hand)`);
      await tx.capitalReceipt.update({ where: { id: c.id }, data: { bankTxnId: row.id, matchedBy: 'manual' } });
    }
    return c;
  });
  return capitalRow((await prisma.capitalReceipt.findUnique({ where: { id: c.id } }))!);
}

/** Share application money allotted as shares (date and number of shares). */
export async function allotCapital(ctx: AuditContext, id: string, f: { allotmentDate: string; sharesAllotted: number }) {
  const c = await prisma.capitalReceipt.findUnique({ where: { id } });
  if (!c || c.status !== 'recorded') throw new UserError('Capital receipt not found', 404);
  if (!Number.isInteger(f.sharesAllotted) || f.sharesAllotted <= 0) throw new UserError('Enter the number of shares allotted');
  await withAudit({ ...ctx, reason: ctx.reason ?? `Shares allotted to ${c.holderName}` }, (tx) => tx.capitalReceipt.update({ where: { id }, data: { allotmentDate: parseDate(f.allotmentDate, 'Allotment date'), sharesAllotted: f.sharesAllotted } }));
  return capitalRow((await prisma.capitalReceipt.findUnique({ where: { id } }))!);
}

export async function cancelCapital(ctx: AuditContext, id: string) {
  const c = await prisma.capitalReceipt.findUnique({ where: { id } });
  if (!c || c.status !== 'recorded') throw new UserError('Capital receipt not found', 404);
  const reason = ctx.reason?.trim();
  if (!reason) throw new UserError('Say why it is cancelled');
  await withAudit({ ...ctx, reason }, async (tx) => {
    if (c.bankTxnId) await unlinkRow(tx, c.bankTxnId);
    await tx.capitalReceipt.update({ where: { id }, data: { status: 'cancelled', statusReason: reason, bankTxnId: null, matchedBy: null } });
  });
  return capitalRow((await prisma.capitalReceipt.findUnique({ where: { id } }))!);
}

export async function capitalCandidates(id: string) {
  const c = await prisma.capitalReceipt.findUnique({ where: { id } });
  if (!c) throw new UserError('Capital receipt not found', 404);
  return candidates(c.amount, c.receiptDate, true);
}

export async function linkCapital(ctx: AuditContext, id: string, txnId: string) {
  const c = await prisma.capitalReceipt.findUnique({ where: { id } });
  if (!c || c.status !== 'recorded' || c.bankTxnId) throw new UserError('Only a recorded receipt not yet linked can be linked');
  const row = await freeRow(txnId, c.amount, true);
  await withAudit({ ...ctx, reason: ctx.reason ?? 'Capital receipt linked to bank row by hand' }, async (tx) => {
    await linkSimple(tx, row, 'CapitalReceipt', c.id, 'founder', await capitalCategory(tx, c.holderName), `Matched ${CAPITAL_TYPE_LABEL[c.type].toLowerCase()} from ${c.holderName} (linked by hand)`);
    await tx.capitalReceipt.update({ where: { id }, data: { bankTxnId: row.id, matchedBy: 'manual' } });
  });
  return capitalRow((await prisma.capitalReceipt.findUnique({ where: { id } }))!);
}

// ---------- F141 / F142 loans ----------

export type LoanInput = {
  lender: string; reference?: string | null; sanctionAmount: string; disbursedAmount: string; disbursedDate: string; interestRate?: string | null;
  repaymentType: string; tenureMonths: number; moratoriumMonths?: number | null; firstDueDate?: string | null; countsTowardCovenant?: boolean; notes?: string | null; bankTxnId?: string | null;
};

function planLoan(input: LoanInput) {
  if (!text(input.lender)) throw new UserError('Enter the lender');
  if (!REPAYMENT_TYPES.includes(input.repaymentType as (typeof REPAYMENT_TYPES)[number])) throw new UserError('Choose EMI, bullet or flexible');
  const sanction = num(input.sanctionAmount, 'Sanctioned amount');
  const disbursed = num(input.disbursedAmount, 'Amount received');
  if (disbursed.lessThanOrEqualTo(0) || disbursed.greaterThan(sanction)) throw new UserError('The amount received must be above zero and not more than the sanctioned amount');
  const tenure = Number(input.tenureMonths);
  if (!Number.isInteger(tenure) || tenure < 1 || tenure > 360) throw new UserError('Enter the tenure in months (1 to 360)');
  const moratorium = Number(input.moratoriumMonths ?? 0);
  if (!Number.isInteger(moratorium) || moratorium < 0 || moratorium > 60) throw new UserError('The moratorium is 0 to 60 months');
  const rate = text(input.interestRate) ? num(input.interestRate, 'Interest rate') : null;
  if (input.repaymentType !== 'flexible' && rate === null) throw new UserError('An EMI or bullet loan needs its interest rate for the schedule');
  const disbursedDate = dateText(parseDate(input.disbursedDate, 'Date received'))!;
  const firstDue = input.repaymentType === 'flexible' ? null : text(input.firstDueDate) ? dateText(parseDate(input.firstDueDate!, 'First instalment date'))! : addMonths(disbursedDate, 1);
  const schedule = firstDue ? loanSchedule({ type: input.repaymentType as 'emi' | 'bullet', principal: disbursed, annualRate: rate!, months: tenure, firstDue, moratoriumMonths: moratorium }) : [];
  const finalDue = schedule.length ? schedule[schedule.length - 1].dueDate : addMonths(disbursedDate, tenure);
  return { sanction, disbursed, tenure, moratorium, rate, disbursedDate, firstDue, schedule, finalDue };
}

/** What a new loan would look like, with the covenant check (warn, do not block; BR-28). */
export async function previewLoan(input: LoanInput) {
  const p = planLoan(input);
  const counts = input.countsTowardCovenant ?? true;
  return { finalDueDate: p.finalDue, schedule: p.schedule, covenant: await covenant(counts ? p.disbursed : zero()) };
}

export async function createLoan(ctx: AuditContext, input: LoanInput) {
  const p = planLoan(input);
  if (p.disbursedDate > todayIST()) throw new UserError('The date received cannot be in the future');
  const row = input.bankTxnId ? await freeRow(input.bankTxnId, p.disbursed, true) : null;
  const company = await getCompany();
  const loan = await withAudit({ ...ctx, reason: ctx.reason ?? `Loan from ${input.lender.trim()}` }, async (tx) => {
    const l = await tx.loan.create({
      data: {
        entityId: company.id, lender: input.lender.trim(), reference: text(input.reference), sanctionAmount: p.sanction, disbursedAmount: p.disbursed, disbursedDate: parseDate(p.disbursedDate),
        interestRate: p.rate, repaymentType: input.repaymentType, tenureMonths: p.tenure, moratoriumMonths: p.moratorium, firstDueDate: p.firstDue ? parseDate(p.firstDue) : null,
        finalDueDate: parseDate(p.finalDue), countsTowardCovenant: input.countsTowardCovenant ?? true, notes: text(input.notes),
      },
    });
    if (p.schedule.length) await tx.loanInstalment.createMany({ data: p.schedule.map((s) => ({ loanId: l.id, instalmentNo: s.instalmentNo, dueDate: parseDate(s.dueDate), openingBalance: new Decimal(s.openingBalance), principal: new Decimal(s.principal), interest: new Decimal(s.interest), total: new Decimal(s.total), closingBalance: new Decimal(s.closingBalance) })) });
    if (row) {
      await linkSimple(tx, row, 'Loan', l.id, 'lender', await categoryIds(tx, 'Financing', 'Loan Received'), `Matched loan from ${l.lender} (linked by hand)`);
      await tx.loan.update({ where: { id: l.id }, data: { bankTxnId: row.id, matchedBy: 'manual' } });
    }
    return l;
  });
  return getLoan(loan.id);
}

/** Terms that can change after entry (rate from the agreement, notes); a schedule with no repayments is rebuilt. */
export async function updateLoanTerms(ctx: AuditContext, id: string, f: { interestRate?: string | null; reference?: string | null; notes?: string | null; countsTowardCovenant?: boolean }) {
  const l = await prisma.loan.findUnique({ where: { id }, include: { repayments: { where: { status: 'recorded' } } } });
  if (!l || l.status === 'cancelled') throw new UserError('Loan not found', 404);
  const rate = text(f.interestRate) ? num(f.interestRate, 'Interest rate') : null;
  const rateChanged = (rate?.toString() ?? null) !== (l.interestRate?.toString() ?? null);
  if (rateChanged && l.repaymentType !== 'flexible' && l.repayments.length) throw new UserError('Repayments are recorded against this schedule: the rate cannot change now');
  if (l.repaymentType !== 'flexible' && rate === null) throw new UserError('An EMI or bullet loan needs its interest rate');
  await withAudit({ ...ctx, reason: ctx.reason ?? 'Loan terms changed' }, async (tx) => {
    await tx.loan.update({ where: { id }, data: { interestRate: rate, reference: text(f.reference), notes: text(f.notes), countsTowardCovenant: f.countsTowardCovenant ?? l.countsTowardCovenant } });
    if (rateChanged && l.repaymentType !== 'flexible' && l.firstDueDate) {
      const s = loanSchedule({ type: l.repaymentType as 'emi' | 'bullet', principal: l.disbursedAmount, annualRate: rate!, months: l.tenureMonths, firstDue: dateText(l.firstDueDate)!, moratoriumMonths: l.moratoriumMonths });
      await tx.loanInstalment.updateMany({ where: { loanId: id, isArchived: false }, data: { isArchived: true } });
      await tx.loanInstalment.createMany({ data: s.map((x) => ({ loanId: id, instalmentNo: x.instalmentNo, dueDate: parseDate(x.dueDate), openingBalance: new Decimal(x.openingBalance), principal: new Decimal(x.principal), interest: new Decimal(x.interest), total: new Decimal(x.total), closingBalance: new Decimal(x.closingBalance) })) });
    }
  });
  return getLoan(id);
}

export async function cancelLoan(ctx: AuditContext, id: string) {
  const l = await prisma.loan.findUnique({ where: { id }, include: { repayments: { where: { status: 'recorded' } } } });
  if (!l || l.status === 'cancelled') throw new UserError('Loan not found', 404);
  if (l.repayments.length) throw new UserError('Repayments are recorded: cancel them first');
  const reason = ctx.reason?.trim();
  if (!reason) throw new UserError('Say why the loan is cancelled');
  await withAudit({ ...ctx, reason }, async (tx) => {
    if (l.bankTxnId) await unlinkRow(tx, l.bankTxnId);
    await tx.loan.update({ where: { id }, data: { status: 'cancelled', statusReason: reason, bankTxnId: null, matchedBy: null } });
  });
  return getLoan(id);
}

function loanView(l: Loan & { repayments: LoanRepayment[]; schedule: LoanInstalment[] }, today = todayIST()) {
  const { repaid, balance } = loanBalance(l, l.repayments);
  const recorded = l.repayments.filter((r) => r.status === 'recorded');
  const paidIds = new Set(recorded.map((r) => r.instalmentId).filter(Boolean));
  const schedule = l.schedule.filter((s) => !s.isArchived).sort((a, b) => a.instalmentNo - b.instalmentNo);
  const next = schedule.find((s) => !paidIds.has(s.id)) ?? null;
  const flex = flexibleState({ disbursed: l.disbursedAmount, disbursedDate: dateText(l.disbursedDate)!, finalDueDate: dateText(l.finalDueDate)!, principalRepaid: repaid }, today);
  return {
    id: l.id, lender: l.lender, reference: l.reference, sanctionAmount: l.sanctionAmount.toFixed(2), disbursedAmount: l.disbursedAmount.toFixed(2), disbursedDate: dateText(l.disbursedDate),
    interestRate: l.interestRate?.toString() ?? null, repaymentType: l.repaymentType, repaymentTypeLabel: REPAYMENT_TYPE_LABEL[l.repaymentType], tenureMonths: l.tenureMonths,
    moratoriumMonths: l.moratoriumMonths, firstDueDate: dateText(l.firstDueDate), finalDueDate: dateText(l.finalDueDate), countsTowardCovenant: l.countsTowardCovenant,
    principalRepaid: repaid.toFixed(2), interestPaid: sum(recorded, (r) => r.interest).toFixed(2), balance: balance.toFixed(2), daysToFinalDue: flex.daysToFinalDue,
    overdue: l.status === 'active' && (flex.overdue || (!!next && dateText(next.dueDate)! < today)),
    nextDue: next ? { instalmentNo: next.instalmentNo, dueDate: dateText(next.dueDate), total: next.total.toFixed(2) } : l.repaymentType === 'flexible' && balance.greaterThan(0) ? { instalmentNo: null, dueDate: dateText(l.finalDueDate), total: balance.toFixed(2) } : null,
    inBank: !!l.bankTxnId, status: l.status, statusReason: l.statusReason, notes: l.notes,
    schedule: schedule.map((s) => ({ id: s.id, instalmentNo: s.instalmentNo, dueDate: dateText(s.dueDate), openingBalance: s.openingBalance.toFixed(2), principal: s.principal.toFixed(2), interest: s.interest.toFixed(2), total: s.total.toFixed(2), closingBalance: s.closingBalance.toFixed(2), paid: paidIds.has(s.id) })),
    repayments: l.repayments.sort((a, b) => (a.paidDate < b.paidDate ? 1 : -1)).map((r) => ({
      id: r.id, paidDate: dateText(r.paidDate), principal: r.principal.toFixed(2), interest: r.interest.toFixed(2), total: r.principal.plus(r.interest).toFixed(2),
      instalmentNo: schedule.find((s) => s.id === r.instalmentId)?.instalmentNo ?? null, inBank: !!r.bankTxnId, reference: r.reference, status: r.status, statusReason: r.statusReason,
    })),
  };
}

export async function listLoans() {
  const loans = await prisma.loan.findMany({ include: { repayments: true, schedule: true }, orderBy: { disbursedDate: 'desc' } });
  return loans.map((l) => { const v = loanView(l); return { ...v, schedule: undefined, repayments: undefined }; });
}

export async function getLoan(id: string) {
  const l = await prisma.loan.findUnique({ where: { id }, include: { repayments: true, schedule: true } });
  if (!l) throw new UserError('Loan not found', 404);
  return { ...loanView(l), covenant: await covenant() };
}

/** The repayment to suggest: the next instalment, or for a flexible loan the interest accrued since the last payment. */
export async function suggestRepayment(id: string, paidDate = todayIST()) {
  const l = await prisma.loan.findUnique({ where: { id }, include: { repayments: { where: { status: 'recorded' } }, schedule: { where: { isArchived: false } } } });
  if (!l) throw new UserError('Loan not found', 404);
  const v = loanView({ ...l, repayments: l.repayments, schedule: l.schedule });
  if (l.repaymentType !== 'flexible') {
    const s = l.schedule.find((x) => x.instalmentNo === v.nextDue?.instalmentNo);
    return s ? { instalmentId: s.id, principal: s.principal.toFixed(2), interest: s.interest.toFixed(2), note: `Instalment ${s.instalmentNo} due ${dateText(s.dueDate)}` } : null;
  }
  const last = [dateText(l.disbursedDate)!, ...l.repayments.map((r) => dateText(r.paidDate)!)].sort().pop()!;
  return { instalmentId: null, principal: v.balance, interest: accruedInterest(new Decimal(v.balance), l.interestRate, last, paidDate), note: l.interestRate ? `Interest at ${l.interestRate}% on ${v.balance} from ${last} (simple, actual days / 365) [Verify with the lender's statement]` : 'No interest rate entered: enter the interest from the lender\'s statement' };
}

export type RepaymentInput = { paidDate: string; principal: string; interest?: string | null; instalmentId?: string | null; reference?: string | null; notes?: string | null; bankTxnId?: string | null };

export async function recordRepayment(ctx: AuditContext, loanId: string, input: RepaymentInput) {
  const l = await prisma.loan.findUnique({ where: { id: loanId }, include: { repayments: true, schedule: { where: { isArchived: false } } } });
  if (!l || l.status !== 'active') throw new UserError('Repayments are recorded on an active loan');
  const principal = num(input.principal || '0', 'Principal');
  const interest = text(input.interest) ? num(input.interest, 'Interest') : zero();
  if (principal.plus(interest).isZero()) throw new UserError('Enter the principal and / or interest paid');
  const { balance } = loanBalance(l, l.repayments);
  if (principal.greaterThan(balance)) throw new UserError(`The principal is more than the Rs ${balance.toFixed(2)} still owed`);
  const date = dateText(parseDate(input.paidDate, 'Date paid'))!;
  if (date > todayIST()) throw new UserError('The date cannot be in the future');
  if (date < dateText(l.disbursedDate)!) throw new UserError('A repayment cannot be before the loan was received');
  if (input.instalmentId) {
    if (!l.schedule.some((s) => s.id === input.instalmentId)) throw new UserError('That instalment is not on this loan');
    if (l.repayments.some((r) => r.status === 'recorded' && r.instalmentId === input.instalmentId)) throw new UserError('That instalment is already paid');
  }
  const row = input.bankTxnId ? await freeRow(input.bankTxnId, principal.plus(interest), false) : null;
  const company = await getCompany();
  await withAudit({ ...ctx, reason: ctx.reason ?? `Repayment to ${l.lender}` }, async (tx) => {
    const r = await tx.loanRepayment.create({ data: { entityId: company.id, loanId, paidDate: parseDate(date), principal, interest, instalmentId: input.instalmentId ?? null, reference: text(input.reference), notes: text(input.notes) } });
    if (row) await linkRepaymentRow(tx, r, row, 'manual', l.lender);
    else await matchFundingForTxns(tx, (await tx.bankTxn.findMany({ where: { ...FREE, debit: principal.plus(interest), txnDate: { gte: new Date(Date.parse(`${date}T00:00:00Z`) - 3 * DAY), lte: new Date(Date.parse(`${date}T00:00:00Z`) + 3 * DAY) } }, select: { id: true } })).map((x) => x.id));
    if (principal.equals(balance)) await tx.loan.update({ where: { id: loanId }, data: { status: 'closed', statusReason: `Repaid in full on ${date}` } });
  });
  return getLoan(loanId);
}

export async function cancelRepayment(ctx: AuditContext, id: string) {
  const r = await prisma.loanRepayment.findUnique({ where: { id }, include: { loan: true } });
  if (!r || r.status !== 'recorded') throw new UserError('Repayment not found', 404);
  const reason = ctx.reason?.trim();
  if (!reason) throw new UserError('Say why the repayment is cancelled');
  await withAudit({ ...ctx, reason }, async (tx) => {
    if (r.bankTxnId) await unlinkRow(tx, r.bankTxnId);
    await tx.loanRepayment.update({ where: { id }, data: { status: 'cancelled', statusReason: reason, bankTxnId: null, matchedBy: null } });
    if (r.loan.status === 'closed') await tx.loan.update({ where: { id: r.loanId }, data: { status: 'active', statusReason: null } });
  });
  return getLoan(r.loanId);
}

export async function loanCandidates(id: string) {
  const l = await prisma.loan.findUnique({ where: { id } });
  if (!l) throw new UserError('Loan not found', 404);
  return candidates(l.disbursedAmount, l.disbursedDate, true);
}

export async function repaymentCandidates(id: string) {
  const r = await prisma.loanRepayment.findUnique({ where: { id } });
  if (!r) throw new UserError('Repayment not found', 404);
  return candidates(r.principal.plus(r.interest), r.paidDate, false);
}

export async function linkLoan(ctx: AuditContext, id: string, txnId: string) {
  const l = await prisma.loan.findUnique({ where: { id } });
  if (!l || l.status === 'cancelled' || l.bankTxnId) throw new UserError('Only a loan not yet linked can be linked');
  const row = await freeRow(txnId, l.disbursedAmount, true);
  await withAudit({ ...ctx, reason: ctx.reason ?? 'Loan linked to bank row by hand' }, async (tx) => {
    await linkSimple(tx, row, 'Loan', l.id, 'lender', await categoryIds(tx, 'Financing', 'Loan Received'), `Matched loan from ${l.lender} (linked by hand)`);
    await tx.loan.update({ where: { id }, data: { bankTxnId: row.id, matchedBy: 'manual' } });
  });
  return getLoan(id);
}

export async function linkRepayment(ctx: AuditContext, id: string, txnId: string) {
  const r = await prisma.loanRepayment.findUnique({ where: { id }, include: { loan: true } });
  if (!r || r.status !== 'recorded' || r.bankTxnId) throw new UserError('Only a recorded repayment not yet linked can be linked');
  const row = await freeRow(txnId, r.principal.plus(r.interest), false);
  await withAudit({ ...ctx, reason: ctx.reason ?? 'Repayment linked to bank row by hand' }, (tx) => linkRepaymentRow(tx, r, row, 'manual', r.loan.lender));
  return getLoan(r.loanId);
}

// ---------- Overview, Home, forecast ----------

/** Bank rows that look like funding (founders' or lenders' money, Financing / Founder Funds) and are not linked yet. */
export async function unexplainedRows() {
  const cats = await prisma.category.findMany({ where: { name: { in: ['Financing', 'Founder Funds'] } } });
  const rows = await prisma.bankTxn.findMany({ where: { ...FREE, OR: [{ categoryId: { in: cats.map((c) => c.id) } }, { partyType: { in: ['lender', 'founder'] } }] }, orderBy: { txnDate: 'desc' }, take: 100 });
  const catName = new Map(cats.map((c) => [c.id, c.name]));
  return rows.map((r) => ({ id: r.id, txnDate: dateText(r.txnDate), credit: moneyText(r.credit), debit: moneyText(r.debit), counterpartyName: r.counterpartyName, narration: r.narrationRaw, category: r.categoryId ? catName.get(r.categoryId) ?? null : null }));
}

export async function fundingOverview() {
  const today = todayIST();
  const fy = fyRange(today);
  const capital = (await prisma.capitalReceipt.findMany({ where: { status: 'recorded' } })).map((c) => capitalRow(c, today));
  const byHolder = new Map<string, { holderName: string; paidUp: Decimal; shareApplication: Decimal; pendingAllotment: Decimal }>();
  for (const c of capital) {
    const h = byHolder.get(c.holderName) ?? { holderName: c.holderName, paidUp: zero(), shareApplication: zero(), pendingAllotment: zero() };
    if (c.type === 'paid_up_capital') h.paidUp = h.paidUp.plus(c.amount); else h.shareApplication = h.shareApplication.plus(c.amount);
    if (!c.allotted) h.pendingAllotment = h.pendingAllotment.plus(c.amount);
    byHolder.set(c.holderName, h);
  }
  const loans = (await listLoans()).filter((l) => l.status !== 'cancelled');
  const inFy = (d: string | null) => !!d && d >= fy.from && d <= fy.to;
  return {
    fy: fy.label,
    capital: {
      total: sum(capital, (c) => new Decimal(c.amount)).toFixed(2), thisFy: sum(capital.filter((c) => inFy(c.receiptDate)), (c) => new Decimal(c.amount)).toFixed(2),
      byHolder: [...byHolder.values()].map((h) => ({ holderName: h.holderName, paidUp: h.paidUp.toFixed(2), shareApplication: h.shareApplication.toFixed(2), pendingAllotment: h.pendingAllotment.toFixed(2) })),
      allotmentOverdue: capital.filter((c) => c.pendingAllotment?.overdue).map((c) => ({ id: c.id, holderName: c.holderName, amount: c.amount, receiptDate: c.receiptDate, days: c.pendingAllotment!.days })),
    },
    loans: {
      outstanding: sum(loans.filter((l) => l.status === 'active'), (l) => new Decimal(l.balance)).toFixed(2), receivedThisFy: sum(loans.filter((l) => inFy(l.disbursedDate)), (l) => new Decimal(l.disbursedAmount)).toFixed(2),
      active: loans.filter((l) => l.status === 'active').length, overdue: loans.filter((l) => l.overdue).length,
      nextDue: loans.filter((l) => l.status === 'active' && l.nextDue).map((l) => ({ id: l.id, lender: l.lender, ...l.nextDue! })).sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : 1))[0] ?? null,
    },
    covenant: await covenant(),
    unexplained: (await unexplainedRows()).length,
  };
}

/** F136: unpaid instalments by due date, and flexible loans' balance on their final date. */
export async function expectedLoanPayments() {
  const loans = await prisma.loan.findMany({ where: { status: 'active' }, include: { repayments: true, schedule: true } });
  const out: { date: string; amount: string; label: string; loanId: string }[] = [];
  for (const l of loans) {
    const v = loanView(l);
    if (l.repaymentType === 'flexible') {
      if (new Decimal(v.balance).greaterThan(0)) out.push({ date: v.finalDueDate!, amount: v.balance, label: `${l.lender}: repay by ${v.finalDueDate}`, loanId: l.id });
      continue;
    }
    for (const s of v.schedule.filter((x) => !x.paid)) out.push({ date: s.dueDate!, amount: s.total, label: `${l.lender} instalment ${s.instalmentNo}`, loanId: l.id });
  }
  return out;
}

