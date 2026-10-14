import type { TxnNature } from '@prisma/client';
import { prisma } from '../config/database';
import { lastCompleteMonths, monthFigures, runway, type Flow, type MonthFigures } from '../lib/burn';
import { ccHeadroom } from '../lib/cashCredit';
import { dateText, parseDate } from '../lib/dates';
import { fyMonths, fyRange, monthStart, todayIST } from '../lib/fy';
import { Decimal, moneyText } from '../lib/money';
import { missingDocuments } from './missingDocs.service';
import { payable as tdsPayable } from './tds.service';

/**
 * M12 dashboards, Phase 1 slice: F130 home (D01-D06, D10, D38) and F131 category x month
 * (D11-D13), cash view only (accrual view needs bills and invoices, Phase 2/3). Every figure
 * comes from categorised bank rows; split rows count by their lines; ignored rows never count.
 */

export const STALE_STATEMENT_DAYS = 7;

type FlowRow = Flow & { categoryId: string | null; subCategoryId: string | null; date: string };

/** Bank flows with a nature between two dates, split rows replaced by their lines. */
async function loadFlows(from: string, to: string, accountIds?: string[]): Promise<FlowRow[]> {
  const rows = await prisma.bankTxn.findMany({
    where: {
      txnDate: { gte: parseDate(from), lte: parseDate(to) },
      status: { notIn: ['ignored', 'review'] },
      ...(accountIds && { bankAccountId: { in: accountIds } }),
    },
    include: { splits: { where: { isArchived: false } } },
  });
  const out: FlowRow[] = [];
  for (const t of rows) {
    const date = dateText(t.txnDate)!;
    const month = monthStart(date);
    const direction = t.debit.greaterThan(0) ? 'out' as const : 'in' as const;
    if (t.status === 'split') {
      for (const s of t.splits) out.push({ date, month, direction, nature: s.nature, amount: s.amount, categoryId: s.categoryId, subCategoryId: s.subCategoryId });
    } else if (t.nature) {
      out.push({ date, month, direction, nature: t.nature, amount: direction === 'out' ? t.debit : t.credit, categoryId: t.categoryId, subCategoryId: t.subCategoryId });
    }
  }
  return out;
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
    actions: {
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
export async function categoryPivot(opts: { fy?: string; kind?: 'expense' | 'income' | 'capex'; accountIds?: string[] } = {}) {
  const kind = opts.kind ?? 'expense';
  const anyDay = opts.fy && /^\d{2}-\d{2}$/.test(opts.fy) ? `20${opts.fy.slice(0, 2)}-04-01` : todayIST();
  const fy = fyRange(anyDay);
  const months = fyMonths(anyDay);
  const flows = (await loadFlows(fy.from, fy.to, opts.accountIds))
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
