import type { TxnNature } from '@prisma/client';
import { prisma } from '../config/database';
import { lastCompleteMonths, monthFigures, runway, type Flow, type MonthFigures } from '../lib/burn';
import { ccHeadroom } from '../lib/cashCredit';
import { dateText, parseDate } from '../lib/dates';
import { fyMonths, fyRange, monthStart, todayIST } from '../lib/fy';
import { accrualFlows, billAccrualAmount } from '../lib/accrual';
import { Decimal, moneyText } from '../lib/money';
import { missingDocuments } from './missingDocs.service';
import { payable as tdsPayable } from './tds.service';
import { balances as founderBalances } from './claim.service';
import { apAgeing, dueList } from './payment.service';
import { chaseList } from './bill.service';
import { moneyInTransit, openDiscrepancyCount } from './recon.service';
import { expectedInvoiceReceipts, outstandingList } from './receivables.service';
import { covenant, expectedLoanPayments } from './funding.service';
import { forecastWeeks, weekIndex } from '../lib/forecast';
import { daysOverdue, msmeAlert } from '../lib/payables';

/**
 * M12 dashboards: F130 home (D01-D07, D09, D10, D32, D38), F131 category x month (D11-D13) in cash
 * or accrual view (BR-35), F132 payables (D16-D25) and F136 the 13-week cash forecast (D33).
 * Cash figures come from categorised bank rows (split rows by their lines, ignored rows never)
 * plus approved founder claims on their expense date (BR-27).
 */

export const STALE_STATEMENT_DAYS = 7;

export type FlowView = 'cash' | 'accrual';
type FlowRow = Flow & { categoryId: string | null; subCategoryId: string | null; date: string; source: 'bank' | 'bill' | 'claim' };

/** Bank flows with a nature between two dates, split rows replaced by their lines. */
async function bankFlows(from: string, to: string, accountIds?: string[]): Promise<(FlowRow & { linked: boolean })[]> {
  const rows = await prisma.bankTxn.findMany({
    where: {
      txnDate: { gte: parseDate(from), lte: parseDate(to) },
      status: { notIn: ['ignored', 'review'] },
      ...(accountIds && { bankAccountId: { in: accountIds } }),
    },
    include: { splits: { where: { isArchived: false } } },
  });
  const out: (FlowRow & { linked: boolean })[] = [];
  for (const t of rows) {
    const date = dateText(t.txnDate)!;
    const month = monthStart(date);
    const direction = t.debit.greaterThan(0) ? 'out' as const : 'in' as const;
    // BR-35: a row that pays a vendor document is that document; the accrual view counts the document.
    const linked = t.linkedDocType === 'PaymentOut';
    if (t.status === 'split') {
      for (const s of t.splits) out.push({ date, month, direction, nature: s.nature, amount: s.amount, categoryId: s.categoryId, subCategoryId: s.subCategoryId, source: 'bank', linked });
    } else if (t.nature) {
      out.push({ date, month, direction, nature: t.nature, amount: direction === 'out' ? t.debit : t.credit, categoryId: t.categoryId, subCategoryId: t.subCategoryId, source: 'bank', linked });
    }
  }
  return out;
}

/** BR-27: approved founder claims are spending on their expense date (cash and accrual views). */
async function claimFlows(from: string, to: string): Promise<FlowRow[]> {
  const claims = await prisma.expenseClaim.findMany({ where: { status: { in: ['approved', 'reimbursed'] }, expenseDate: { gte: parseDate(from), lte: parseDate(to) } } });
  return claims.map((c) => {
    const date = dateText(c.expenseDate)!;
    return { date, month: monthStart(date), direction: 'out' as const, nature: c.nature, amount: c.amount, categoryId: c.categoryId, subCategoryId: c.subCategoryId, source: 'claim' as const };
  });
}

/** BR-35: vendor bills on their bill date at what they cost (GST only when it cannot be claimed back). */
async function billFlows(from: string, to: string): Promise<FlowRow[]> {
  const docs = await prisma.vendorDocument.findMany({
    where: { docType: { in: ['tax_invoice', 'debit_note', 'credit_note'] }, status: { notIn: ['cancelled', 'replaced'] }, nature: { not: null }, docDate: { gte: parseDate(from), lte: parseDate(to) } },
  });
  return docs.map((d) => {
    const date = dateText(d.docDate)!;
    const cost = billAccrualAmount({ taxableValue: d.taxableValue, otherCharges: d.otherCharges, gst: d.cgst.plus(d.sgst).plus(d.igst), itcEligible: d.itcEligible });
    return { date, month: monthStart(date), direction: 'out' as const, nature: d.nature!, amount: d.docType === 'credit_note' ? cost.negated() : cost, categoryId: d.categoryId, subCategoryId: d.subCategoryId, source: 'bill' as const };
  });
}

/**
 * Money flows between two dates. Cash view: bank rows plus approved founder claims. Accrual view
 * (BR-35): bills plus claims plus bank rows that do not pay a bill. Filtering by bank account
 * leaves claims and bills out (they belong to no account).
 */
async function loadFlows(from: string, to: string, accountIds?: string[], view: FlowView = 'cash'): Promise<FlowRow[]> {
  const bank = await bankFlows(from, to, accountIds);
  const claims = accountIds ? [] : await claimFlows(from, to);
  if (view === 'cash') return [...bank.map(({ linked: _l, ...f }) => f), ...claims];
  const bills = accountIds ? [] : await billFlows(from, to);
  return accrualFlows(bank, [...bills, ...claims]);
}

function figuresView(f: MonthFigures) {
  return Object.fromEntries(Object.entries(f).map(([k, v]) => [k, typeof v === 'string' ? v : moneyText(v as Decimal)]));
}

/** Last balance of an account on or before a date (opening balance when nothing is imported). */
async function balanceOn(accountId: string, openingBalance: Decimal, asOf: Date) {
  const last = await prisma.bankTxn.findFirst({
    where: { bankAccountId: accountId, txnDate: { lte: asOf }, balance: { not: null } },
    orderBy: [{ txnDate: 'desc' }, { seq: 'desc' }],
  });
  return { balance: last?.balance ?? openingBalance, lastTxnDate: last ? dateText(last.txnDate) : null };
}

export async function home(opts: { asOf?: string; accountIds?: string[] } = {}) {
  const asOf = opts.asOf ?? todayIST();
  const asOfDate = parseDate(asOf);
  const fy = fyRange(asOf);
  const accounts = await prisma.bankAccount.findMany({
    where: { isArchived: false, owner: 'Entelechy', ...(opts.accountIds && { id: { in: opts.accountIds } }) },
    orderBy: { createdAt: 'asc' },
  });

  // D01 cash: business current accounts and wallets; cash credit is a liability (BR-50).
  let cash = new Decimal(0);
  const cashAccounts = [];
  let ccHeadroomTotal = new Decimal(0);
  let ccDrawn = new Decimal(0);
  let hasCc = false;
  for (const a of accounts) {
    const b = await balanceOn(a.id, a.openingBalance, asOfDate);
    const lastImport = await prisma.bankImportBatch.findFirst({ where: { bankAccountId: a.id }, orderBy: { importedAt: 'desc' } });
    if (a.accountType === 'business_current' || a.accountType === 'wallet') {
      cash = cash.plus(b.balance);
      cashAccounts.push({
        id: a.id, bankName: a.bankName, accountNumberMasked: `•••• ${a.accountNumber.slice(-4)}`, accountType: a.accountType,
        balance: moneyText(b.balance), lastTxnDate: b.lastTxnDate, lastImportedAt: lastImport?.importedAt ?? null,
      });
    } else if (a.accountType === 'cash_credit' && a.sanctionedLimit) {
      hasCc = true;
      // A CC statement shows the drawn amount as a negative balance; drawn = -balance.
      const drawn = b.balance.isNegative() ? b.balance.negated() : new Decimal(0);
      ccDrawn = ccDrawn.plus(drawn);
      ccHeadroomTotal = ccHeadroomTotal.plus(ccHeadroom(a.sanctionedLimit, a.drawingPower, drawn));
    }
  }

  // Monthly figures for the FY and for the three complete months used by runway.
  const lastThree = lastCompleteMonths(asOf);
  const from = lastThree[0] < fy.from ? lastThree[0] : fy.from;
  const flows = await loadFlows(from, asOf < fy.to ? asOf : fy.to, opts.accountIds);
  const months = fyMonths(asOf).filter((m) => m <= monthStart(asOf)).map((m) => monthFigures(m, flows));
  const lastThreeFigures = lastThree.map((m) => monthFigures(m, flows));
  const r = runway(cash, lastThreeFigures.map((f) => f.netBurn));
  const thisMonth = monthFigures(monthStart(asOf), flows);
  const fyCapex = months.reduce((s, f) => s.plus(f.capex), new Decimal(0));

  // D06 funding received this FY, by sub-category (capital, loan...).
  const subs = new Map((await prisma.subCategory.findMany({ include: { category: true } })).map((s) => [s.id, s]));
  const funding = new Map<string, Decimal>();
  for (const x of flows.filter((y) => y.direction === 'in' && y.nature === 'financing_in' && y.date >= fy.from)) {
    const label = x.subCategoryId ? subs.get(x.subCategoryId)?.name ?? 'Other' : 'Other';
    funding.set(label, (funding.get(label) ?? new Decimal(0)).plus(x.amount));
  }

  // D10 action items.
  const review = await prisma.bankTxn.count({ where: { status: { in: ['review', 'suggested'] }, ...(opts.accountIds && { bankAccountId: { in: opts.accountIds } }) } });
  const uncategorisedLastThree = await prisma.bankTxn.count({
    where: { status: 'review', txnDate: { gte: parseDate(lastThree[0]), lt: parseDate(monthStart(asOf)) }, ...(opts.accountIds && { bankAccountId: { in: opts.accountIds } }) },
  });
  const staleStatements = cashAccounts
    .filter((a) => {
      const last = a.lastImportedAt ? a.lastImportedAt.getTime() : 0;
      return Date.now() - last > STALE_STATEMENT_DAYS * 86_400_000;
    })
    .map((a) => ({ id: a.id, name: `${a.bankName} ${a.accountNumberMasked}`, lastImportedAt: a.lastImportedAt }));
  const missing = await missingDocuments();
  const pendingBankApprovals = await prisma.vendorBankAccount.count({ where: { status: 'pending' } });
  // D09: TDS deducted and not yet deposited, by month, with its due date (BR-13).
  const tdsToDeposit = (await tdsPayable()).map((m) => ({ month: m.month, amount: m.amount, dueDate: m.dueDate, overdue: m.overdue }));
  // D07 payables due in 7 days / overdue; D32 owed to each founder.
  const due = await dueList();
  const founders = (await founderBalances()).filter((f) => new Decimal(f.owed ?? 0).greaterThan(0) || new Decimal(f.waiting ?? 0).greaterThan(0));
  const claimsToApprove = await prisma.expenseClaim.count({ where: { status: 'submitted' } });
  // F130 / F197: money paid by customers and not yet in the bank, and open order-to-bank mismatches.
  let orderToBank: { inTransit: string | null; overdue: number; openDiscrepancies: number } | null = null;
  try {
    const t = await moneyInTransit();
    const overdue = [t.paidAtGateway, t.deliveredAwaitingRemittance, t.settledNotInBank, t.remittedNotInBank].reduce((n, x) => n + x.overdue, 0);
    orderToBank = { inTransit: t.total, overdue, openDiscrepancies: await openDiscrepancyCount() };
  } catch (error) {
    console.error('Order-to-bank figures left out of Home:', error);
  }

  // D08: what customers owe on issued invoices, and how much of it is overdue (BR-22).
  let receivables: { outstanding: string; overdue: string; open: number } | null = null;
  try {
    const o = await outstandingList();
    receivables = { outstanding: o.totals.outstanding, overdue: o.totals.overdue, open: o.rows.length };
  } catch (error) {
    console.error('Receivables left out of Home:', error);
  }

  // D31: total debt against the Mesa cap (BR-28).
  let debt: { totalDebt: string; cap: string; headroom: string; breached: boolean } | null = null;
  try {
    const c = await covenant();
    debt = { totalDebt: c.totalDebt, cap: c.cap, headroom: c.headroom, breached: c.breached };
  } catch (error) {
    console.error('Debt left out of Home:', error);
  }

  return {
    asOf,
    fy: fy.label,
    cash: { total: moneyText(cash), accounts: cashAccounts },
    cashCredit: hasCc ? { drawn: moneyText(ccDrawn), headroom: moneyText(ccHeadroomTotal), liquidity: moneyText(cash.plus(ccHeadroomTotal)) } : null,
    thisMonth: figuresView(thisMonth),
    lastThreeMonths: lastThreeFigures.map(figuresView),
    runway: r.kind === 'months'
      ? { kind: 'months', months: r.months.toFixed(1), averageNetBurn: moneyText(r.averageNetBurn) }
      : { kind: 'cash_positive', averageNetBurn: moneyText(r.averageNetBurn) },
    capex: { thisMonth: moneyText(thisMonth.capex), fy: moneyText(fyCapex) },
    funding: { fy: moneyText([...funding.values()].reduce((s, x) => s.plus(x), new Decimal(0))), bySubCategory: [...funding.entries()].map(([name, amount]) => ({ name, amount: moneyText(amount) })) },
    months: months.map(figuresView),
    payables: { overdue: due.totals.overdue, dueThisWeek: due.totals.thisWeek, msmeAtRisk: due.totals.msmeAtRisk },
    founders,
    orderToBank,
    receivables,
    debt,
    actions: {
      claimsToApprove,
      review,
      uncategorisedLastThree,
      staleStatements,
      missingDocuments: missing.count,
      pendingBankApprovals,
      tdsToDeposit,
    },
  };
}

const PIVOT_NATURES: Record<'expense' | 'income' | 'capex', TxnNature[]> = {
  expense: ['operating_expense', 'cogs', 'interest'],
  income: ['operating_income'],
  capex: ['capex'],
};

/**
 * F131 category x month (D11 expense, D12 income) with month-on-month change (D13). Rows are
 * categories with their sub-categories; each cell drills down to the ledger.
 */
export async function categoryPivot(opts: { fy?: string; kind?: 'expense' | 'income' | 'capex'; accountIds?: string[]; view?: FlowView } = {}) {
  const kind = opts.kind ?? 'expense';
  const view = opts.view ?? 'cash';
  const anyDay = opts.fy && /^\d{2}-\d{2}$/.test(opts.fy) ? `20${opts.fy.slice(0, 2)}-04-01` : todayIST();
  const fy = fyRange(anyDay);
  const months = fyMonths(anyDay);
  const flows = (await loadFlows(fy.from, fy.to, opts.accountIds, view))
    .filter((f) => PIVOT_NATURES[kind].includes(f.nature) && f.direction === (kind === 'income' ? 'in' : 'out'));

  const cats = new Map((await prisma.category.findMany()).map((c) => [c.id, c]));
  const subs = new Map((await prisma.subCategory.findMany()).map((s) => [s.id, s]));
  type Row = { id: string; name: string; values: Decimal[]; subs: Map<string, { id: string; name: string; values: Decimal[] }> };
  const rows = new Map<string, Row>();
  const empty = () => months.map(() => new Decimal(0));
  for (const f of flows) {
    const i = months.indexOf(f.month);
    if (i < 0) continue;
    const catId = f.categoryId ?? 'none';
    const row = rows.get(catId) ?? { id: catId, name: cats.get(catId)?.name ?? 'No category', values: empty(), subs: new Map() };
    row.values[i] = row.values[i].plus(f.amount);
    const subId = f.subCategoryId ?? 'none';
    const sub = row.subs.get(subId) ?? { id: subId, name: subs.get(subId)?.name ?? '(no sub-category)', values: empty() };
    sub.values[i] = sub.values[i].plus(f.amount);
    row.subs.set(subId, sub);
    rows.set(catId, row);
  }

  const totals = empty();
  for (const r of rows.values()) r.values.forEach((v, i) => { totals[i] = totals[i].plus(v); });

  // D13: this month vs last month, using the latest month that has ended or is running.
  const current = Math.max(0, months.indexOf(monthStart(todayIST() < fy.to ? todayIST() : fy.to)));
  const mom = (values: Decimal[]) => {
    if (current === 0) return null;
    const prev = values[current - 1];
    if (prev.isZero()) return null; // guard: last month = 0
    return values[current].minus(prev).dividedBy(prev).times(100).toFixed(0);
  };
  const sum = (v: Decimal[]) => v.reduce((s, x) => s.plus(x), new Decimal(0));

  return {
    fy: fy.label,
    kind,
    view,
    months,
    currentMonth: months[current],
    rows: [...rows.values()]
      .sort((a, b) => sum(b.values).comparedTo(sum(a.values)))
      .map((r) => ({
        categoryId: r.id,
        name: r.name,
        values: r.values.map((v) => moneyText(v)),
        total: moneyText(sum(r.values)),
        momPercent: mom(r.values),
        subCategories: [...r.subs.values()]
          .sort((a, b) => sum(b.values).comparedTo(sum(a.values)))
          .map((s) => ({ subCategoryId: s.id, name: s.name, values: s.values.map((v) => moneyText(v)), total: moneyText(sum(s.values)) })),
      })),
    totals: totals.map((v) => moneyText(v)),
    grandTotal: moneyText(sum(totals)),
  };
}

// ---------- F132 payables dashboard (D16-D25) ----------

const OPEN_BILL = ['received', 'approved', 'partially_paid', 'disputed'];

export async function payables(opts: { fy?: string } = {}) {
  const anyDay = opts.fy && /^\d{2}-\d{2}$/.test(opts.fy) ? `20${opts.fy.slice(0, 2)}-04-01` : todayIST();
  const fy = fyRange(anyDay);
  const today = todayIST();
  const inFy = { gte: parseDate(fy.from), lte: parseDate(fy.to) };
  const zero = () => new Decimal(0);
  const sum = <T>(rows: T[], f: (r: T) => Decimal) => rows.reduce((s, r) => s.plus(f(r)), zero());

  // D16-D18: documents received in the FY. A replaced quote / proforma is left out: its tax
  // invoice carries the same value.
  const docs = await prisma.vendorDocument.findMany({ where: { docType: { in: ['quote', 'proforma', 'tax_invoice'] }, status: { notIn: ['cancelled', 'replaced'] }, docDate: inFy } });
  // D19: cash paid in the FY, advances included.
  const paid = await prisma.paymentOut.findMany({ where: { status: { in: ['paid', 'reconciled'] }, paidDate: inFy } });
  // D20, D21: every tax invoice, whatever its date; open ones still owe money.
  const invoices = await prisma.vendorDocument.findMany({ where: { docType: 'tax_invoice', status: { notIn: ['cancelled', 'replaced'] } }, include: { vendor: true } });
  const open = invoices.filter((d) => OPEN_BILL.includes(d.status) && d.outstanding.greaterThan(0));
  // D22: advances with no tax invoice yet (BR-10), and PO advances not yet applied to a tax invoice (BR-09).
  const chase = await chaseList();
  const poAdvances = await prisma.paymentAllocation.findMany({ where: { isArchived: false, appliedToDocId: null, poId: { not: null }, payment: { status: { in: ['paid', 'reconciled'] } } } });
  // D23: tax invoices dated in the FY with no PO.
  const noPo = invoices.filter((d) => !d.poId && d.docDate >= parseDate(fy.from) && d.docDate <= parseDate(fy.to));
  // D25: owed to micro / small vendors 30+ days after acceptance (45-day limit, BR-25).
  const msme = open
    .map((d) => ({ d, alert: msmeAlert({ msmeType: d.vendor.msmeType, acceptedOn: dateText(d.receivedDate ?? d.docDate)!, dueDate: dateText(d.dueDate) }, today) }))
    .filter((x) => x.alert.level !== 'none');

  return {
    fy: fy.label,
    received: { count: docs.length, value: moneyText(sum(docs, (d) => d.totalValue)), netPayable: moneyText(sum(docs, (d) => d.netPayable)) },
    paid: { count: paid.length, amount: moneyText(sum(paid, (p) => p.amount)) },
    outstanding: moneyText(sum(open, (d) => d.outstanding)),
    overdue: moneyText(sum(open.filter((d) => daysOverdue(dateText(d.dueDate), today) > 0), (d) => d.outstanding)),
    byStatus: {
      paid: invoices.filter((d) => d.status === 'paid').length,
      partiallyPaid: invoices.filter((d) => d.status === 'partially_paid').length,
      unpaid: invoices.filter((d) => ['received', 'approved', 'disputed'].includes(d.status)).length,
    },
    withoutTaxInvoice: {
      amount: chase.totals.advancesWithoutTaxInvoice,
      documents: chase.totals.awaiting,
      toChase: chase.totals.toChase,
      poAdvances: moneyText(sum(poAdvances, (a) => a.amount.plus(a.tdsAmount))),
    },
    noPo: { count: noPo.length, value: moneyText(sum(noPo, (d) => d.totalValue)) },
    ageing: await apAgeing(),
    msme: {
      amount: moneyText(sum(msme, (x) => x.d.outstanding)),
      rows: msme
        .sort((a, b) => a.alert.limitDate.localeCompare(b.alert.limitDate))
        .map(({ d, alert }) => ({ id: d.id, docNumber: d.docNumber, vendorName: d.vendor.displayName, msmeType: d.vendor.msmeType, outstanding: moneyText(d.outstanding), daysSinceAcceptance: alert.daysSinceAcceptance, limitDate: alert.limitDate, level: alert.level })),
    },
  };
}

// ---------- F136 13-week cash forecast (D33) ----------

/** Cash in business current accounts and wallets on a date (D01). */
async function businessCash(asOf: string) {
  const accounts = await prisma.bankAccount.findMany({ where: { isArchived: false, owner: 'Entelechy', accountType: { in: ['business_current', 'wallet'] } } });
  let cash = new Decimal(0);
  for (const a of accounts) cash = cash.plus((await balanceOn(a.id, a.openingBalance, parseDate(asOf))).balance);
  return cash;
}

type ForecastItem = { week: number; kind: 'bill' | 'advance' | 'tds' | 'claims' | 'regular' | 'receipt' | 'loan'; label: string; date: string | null; amount: Decimal; link: string | null };

/**
 * D33: opening cash, then each week's expected payments. Dated items fall in their week (anything
 * already due, or with no date, in week 1). Spending that has no bill (salaries, rent,
 * subscriptions) is the weekly average of the last 3 complete months of operating bank outflows
 * that did not pay a bill. Receipts: money in transit from customers (M18, F197) on its expected
 * bank date. Invoice receipts (Phase 3), loan EMIs (Phase 3) and PO milestones (not dated) are
 * not in the weeks yet; open POs are shown beside them.
 */
export async function forecast(opts: { asOf?: string } = {}) {
  const today = opts.asOf ?? todayIST();
  const weeks = forecastWeeks(today);
  const items: ForecastItem[] = [];
  const add = (date: string | null, it: Omit<ForecastItem, 'week' | 'date'>) => {
    const week = date ? weekIndex(date, today) : 0;
    if (week !== null && it.amount.greaterThan(0)) items.push({ ...it, week, date });
  };

  for (const r of (await dueList()).rows) {
    add(r.dueDate, { kind: r.isAdvance ? 'advance' : 'bill', label: `${r.vendorName} ${r.docNumber}`, amount: new Decimal(r.owed ?? 0), link: `/bills/${r.id}` });
  }
  for (const m of await tdsPayable()) add(m.dueDate, { kind: 'tds', label: `TDS for ${m.month.slice(0, 7)}`, amount: new Decimal(m.amount ?? 0), link: '/tds' });
  for (const f of await founderBalances()) add(null, { kind: 'claims', label: `Owed to ${f.founderName}`, amount: new Decimal(f.owed ?? 0), link: '/claims' });
  // F197 feeds the forecast: Razorpay and COD money on its way, by expected bank date.
  try {
    for (const x of (await moneyInTransit()).expected) add(x.date, { kind: 'receipt', label: x.label, amount: new Decimal(x.amount ?? 0), link: '/order-to-bank' });
  } catch (error) {
    console.error('Order-to-bank figures left out of the forecast:', error);
  }
  // Loan instalments not yet paid, and flexible loans' balance on their final date (F142).
  for (const x of await expectedLoanPayments()) add(x.date, { kind: 'loan', label: x.label, amount: new Decimal(x.amount), link: `/funding/loans/${x.loanId}` });
  // Invoices not tied to a CRM order (those are counted above as money in transit), by due date.
  for (const x of await expectedInvoiceReceipts()) add(x.date, { kind: 'receipt', label: x.label, amount: new Decimal(x.amount), link: `/sales/${x.docId}` });

  // Regular spending without a bill: weekly average over the last 3 complete months (13 weeks).
  const lastThree = lastCompleteMonths(today);
  const end = new Date(Date.parse(`${monthStart(today)}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const bank = await bankFlows(lastThree[0], end);
  const regularTotal = bank
    .filter((f) => !f.linked && f.direction === 'out' && ['operating_expense', 'cogs', 'interest'].includes(f.nature))
    .reduce((s, f) => s.plus(f.amount), new Decimal(0));
  const regularWeekly = regularTotal.dividedBy(13).toDecimalPlaces(0);
  if (regularWeekly.greaterThan(0)) {
    weeks.forEach((_, i) => items.push({ week: i, kind: 'regular', label: 'Regular spending (no bill)', date: null, amount: regularWeekly, link: null }));
  }

  const opening = await businessCash(today);
  let running = opening;
  const rows = weeks.map((w, i) => {
    const these = items.filter((x) => x.week === i);
    const inflow = these.filter((x) => x.kind === 'receipt').reduce((s, x) => s.plus(x.amount), new Decimal(0));
    const out = these.filter((x) => x.kind !== 'receipt').reduce((s, x) => s.plus(x.amount), new Decimal(0));
    const start = running;
    running = running.plus(inflow).minus(out);
    return {
      ...w, opening: moneyText(start), receipts: moneyText(inflow), payments: moneyText(out), closing: moneyText(running),
      items: these.map((x) => ({ kind: x.kind, label: x.label, date: x.date, amount: moneyText(x.amount), link: x.link })),
    };
  });
  const openPos = await prisma.purchaseOrder.findMany({ where: { status: { in: ['approved', 'sent', 'partially_billed'] } } });
  const poUnbilled = openPos.reduce((s, p) => s.plus(Decimal.max(p.total.minus(p.billedTotal).minus(p.advanceTotal), 0)), new Decimal(0));
  const firstShort = rows.find((r) => new Decimal(r.closing ?? 0).isNegative());
  return {
    asOf: today,
    openingCash: moneyText(opening),
    regularWeekly: moneyText(regularWeekly),
    regularBasis: { from: lastThree[0], to: end, total: moneyText(regularTotal) },
    weeks: rows,
    closingCash: moneyText(running),
    firstShortWeek: firstShort ? firstShort.from : null,
    notIncluded: {
      openPurchaseOrders: { count: openPos.length, unbilled: moneyText(poUnbilled) },
    },
  };
}

// ---------- D39 spend by category on Home ----------

export type SpendPeriod = 'month' | '3m' | 'fy';
const lastDay = (monthFirst: string) => { const [y, m] = monthFirst.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

/** The period a Home chart covers, and the same-length period before it (none for the FY). */
function spendWindow(period: SpendPeriod, today: string) {
  if (period === 'month') {
    const from = monthStart(today);
    const prev = lastCompleteMonths(today, 1)[0];
    return { from, to: today, label: 'This month so far', prev: { from: prev, to: lastDay(prev), label: 'last month' } };
  }
  if (period === '3m') {
    const m = lastCompleteMonths(today, 6);
    return { from: m[3], to: lastDay(m[5]), label: 'Last 3 complete months', prev: { from: m[0], to: lastDay(m[2]), label: 'the 3 months before' } };
  }
  const fy = fyRange(today);
  return { from: fy.from, to: today, label: `FY ${fy.label} so far`, prev: null };
}

/**
 * D39: where the money goes. Operating expense, COGS and interest out by category for a period
 * (capex apart, as in burn), largest first, with each category's share and the change against the
 * period before, to see which verticals to grow or cut.
 */
export async function spendByCategory(opts: { period?: SpendPeriod; view?: FlowView } = {}) {
  const today = todayIST();
  const period = opts.period ?? '3m';
  const view = opts.view ?? 'cash';
  const w = spendWindow(period, today);
  const spend = (rows: FlowRow[]) => rows.filter((f) => PIVOT_NATURES.expense.includes(f.nature) && f.direction === 'out');
  const now = spend(await loadFlows(w.from, w.to, undefined, view));
  const before = w.prev ? spend(await loadFlows(w.prev.from, w.prev.to, undefined, view)) : [];
  const cats = new Map((await prisma.category.findMany()).map((c) => [c.id, c.name]));
  const subs = new Map((await prisma.subCategory.findMany()).map((s) => [s.id, s.name]));
  const by = new Map<string, { amount: Decimal; count: number; subs: Map<string, Decimal> }>();
  for (const f of now) {
    const k = f.categoryId ?? 'none';
    const r = by.get(k) ?? { amount: new Decimal(0), count: 0, subs: new Map() };
    r.amount = r.amount.plus(f.amount);
    r.count += 1;
    const sk = f.subCategoryId ?? 'none';
    r.subs.set(sk, (r.subs.get(sk) ?? new Decimal(0)).plus(f.amount));
    by.set(k, r);
  }
  const prevBy = new Map<string, Decimal>();
  for (const f of before) prevBy.set(f.categoryId ?? 'none', (prevBy.get(f.categoryId ?? 'none') ?? new Decimal(0)).plus(f.amount));
  const total = [...by.values()].reduce((s, r) => s.plus(r.amount), new Decimal(0));
  return {
    period, view, from: w.from, to: w.to, label: w.label, comparedWith: w.prev?.label ?? null,
    total: moneyText(total),
    rows: [...by.entries()].sort(([, a], [, b]) => b.amount.comparedTo(a.amount)).map(([id, r]) => {
      const prev = prevBy.get(id) ?? new Decimal(0);
      return {
        categoryId: id === 'none' ? null : id, name: id === 'none' ? 'Not categorised' : cats.get(id) ?? 'Unknown', amount: moneyText(r.amount),
        sharePercent: total.isZero() ? '0' : r.amount.dividedBy(total).times(100).toFixed(1), transactions: r.count,
        previous: w.prev ? moneyText(prev) : null,
        changePercent: w.prev && !prev.isZero() ? r.amount.minus(prev).dividedBy(prev).times(100).toFixed(0) : null,
        topSubCategories: [...r.subs.entries()].sort(([, a], [, b]) => b.comparedTo(a)).slice(0, 3).map(([sid, amt]) => ({ name: sid === 'none' ? '(no sub-category)' : subs.get(sid) ?? 'Unknown', amount: moneyText(amt) })),
      };
    }),
  };
}
