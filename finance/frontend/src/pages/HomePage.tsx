import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import api from '../api';
import { SpendByCategory } from './SpendByCategory';
import { Card, PageHeader } from '../components/ui/kit';
import { useAuth } from '../context/auth';
import { formatDateTime } from '../lib/format';
import { formatINR } from '../lib/money';
import { cn } from '../lib/utils';
import { monthLabel } from './settings/api';

type Month = {
  month: string; operatingIncome: string; operatingExpense: string; cogs: string; interest: string; grossBurn: string;
  netBurn: string; capex: string; financingIn: string; financingOut: string; taxPaid: string; otherIn: string; otherOut: string;
};
type Home = {
  asOf: string; fy: string;
  cash: { total: string; accounts: { id: string; bankName: string; accountNumberMasked: string; balance: string; lastTxnDate: string | null; lastImportedAt: string | null }[] };
  cashCredit: { drawn: string; headroom: string; liquidity: string } | null;
  thisMonth: Month; lastThreeMonths: Month[];
  runway: { kind: 'months'; months: string; averageNetBurn: string } | { kind: 'cash_positive'; averageNetBurn: string };
  capex: { thisMonth: string; fy: string };
  funding: { fy: string; bySubCategory: { name: string; amount: string }[] };
  months: Month[];
  payables: { overdue: string; dueThisWeek: string; msmeAtRisk: number };
  founders: { founderUserId: string; founderName: string; owed: string; waiting: string }[];
  orderToBank: { inTransit: string | null; overdue: number; openDiscrepancies: number } | null;
  receivables: { outstanding: string; overdue: string; open: number } | null;
  debt: { totalDebt: string; cap: string; headroom: string; breached: boolean } | null;
  actions: { claimsToApprove: number; review: number; uncategorisedLastThree: number; staleStatements: { id: string; name: string; lastImportedAt: string | null }[]; missingDocuments: number; pendingBankApprovals: number; tdsToDeposit: { month: string; amount: string; dueDate: string; overdue: boolean }[] };
};

const short = (v: string) => formatINR(v, { decimals: false });

/** Bars drawn from text amounts: the browser only needs proportions, not money arithmetic. */
const ratio = (v: string, max: number) => (max > 0 ? Math.max(0, Number(v)) / max : 0);

function Kpi({ label, value, hint, tone, to }: { label: string; value: string; hint?: string; tone?: 'good' | 'bad'; to?: string }) {
  const card = (
    <Card className="p-3 sm:p-4 h-full">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={cn('text-xl sm:text-2xl font-semibold num mt-0.5', tone === 'good' && 'text-emerald-700', tone === 'bad' && 'text-red-700')}>{value}</div>
      {hint && <div className="text-xs text-gray-500 mt-0.5">{hint}</div>}
    </Card>
  );
  return to ? <Link to={to} className="block hover:opacity-90">{card}</Link> : card;
}

// F130 home dashboard (D01-D07, D09, D10, D32, D38). Cash view from the bank ledger and approved founder claims.
export function HomePage() {
  const { user, hasPermission } = useAuth();
  const { data: h, isLoading } = useQuery({
    queryKey: ['dashboard-home'],
    queryFn: async () => (await api.get<{ data: Home }>('/dashboard/home')).data.data,
  });

  if (isLoading || !h) return <p className="text-sm text-gray-500">Loading…</p>;

  const lastMonth = h.lastThreeMonths[h.lastThreeMonths.length - 1];
  // With no statement imported, burn is zero and runway would wrongly read 'Cash positive'.
  const noData = h.cash.accounts.every((a) => !a.lastTxnDate);
  const max = Math.max(1, ...h.months.flatMap((m) => [Number(m.grossBurn), Number(m.operatingIncome), Number(m.capex)]));
  const actions = [
    h.orderToBank && h.orderToBank.openDiscrepancies > 0 && { text: `${h.orderToBank.openDiscrepancies} order-to-bank mismatch(es) to look at`, to: '/order-to-bank?tab=discrepancies' },
    h.orderToBank && h.orderToBank.overdue > 0 && { text: `${h.orderToBank.overdue} order payment(s) overdue from Razorpay, Shiprocket or the bank`, to: '/order-to-bank' },
    h.actions.claimsToApprove > 0 && { text: `${h.actions.claimsToApprove} founder claim(s) waiting for approval`, to: '/claims?status=submitted' },
    h.actions.review > 0 && { text: `${h.actions.review} bank row${h.actions.review === 1 ? '' : 's'} to review`, to: '/review' },
    h.actions.uncategorisedLastThree > 0 && { text: `${h.actions.uncategorisedLastThree} row(s) of the last 3 months have no category, so burn may be understated`, to: '/review' },
    h.actions.staleStatements.length > 3 && { text: `${h.actions.staleStatements.length} accounts have no statement imported in the last 7 days`, to: '/import' },
    ...(h.actions.staleStatements.length > 3 ? [] : h.actions.staleStatements).map((s) => ({ text: `${s.name}: no statement imported ${s.lastImportedAt ? `since ${formatDateTime(s.lastImportedAt)}` : 'yet'}`, to: '/import' })),
    h.actions.pendingBankApprovals > 0 && { text: `${h.actions.pendingBankApprovals} vendor bank change(s) waiting for approval`, to: '/vendors' },
    ...h.actions.tdsToDeposit.map((t) => ({ text: `TDS of ${monthLabel(t.month)}: ${formatINR(t.amount)} ${t.overdue ? 'was due' : 'due'} ${monthLabel(t.dueDate.slice(0, 8) + '01').replace(/^\w+/, (m) => `${Number(t.dueDate.slice(8))} ${m}`)}`, to: '/tds' })),
    h.actions.missingDocuments > 0 && { text: `${h.actions.missingDocuments} record(s) missing documents`, to: '/documents' },
  ].filter(Boolean) as { text: string; to: string }[];

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <PageHeader title={`Hello, ${user?.firstName}`} subtitle={`FY ${h.fy} · cash view from the bank ledger, as of ${monthLabel(h.asOf.slice(0, 8) + '01').replace(/^\w+/, (m) => `${Number(h.asOf.slice(8))} ${m}`)}`} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
        <Kpi label="Cash in business accounts" value={short(h.cash.total)} hint={h.cashCredit ? `Liquidity with CC headroom ${short(h.cashCredit.liquidity)}` : `${h.cash.accounts.length} account(s)`} />
        <Kpi
          label="Runway"
          value={noData ? '—' : h.runway.kind === 'cash_positive' ? 'Cash positive' : `${h.runway.months} months`}
          hint={noData ? 'Import a statement first' : `Avg net burn ${short(h.runway.averageNetBurn)}/month (last 3 months)`}
          tone={noData ? undefined : h.runway.kind === 'cash_positive' ? 'good' : Number(h.runway.months) < 6 ? 'bad' : undefined}
        />
        <Kpi label={`Net burn ${monthLabel(lastMonth.month)}`} value={short(lastMonth.netBurn)} hint={`Gross ${short(lastMonth.grossBurn)} · income ${short(lastMonth.operatingIncome)}`} />
        <Kpi label="Capex this FY" value={short(h.capex.fy)} hint="Tooling, equipment, patents: not in burn" />
      </div>

      {hasPermission('financePayments', 'view') && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
          <Kpi label="Payables overdue" value={short(h.payables.overdue)} tone={h.payables.overdue !== '0.00' ? 'bad' : undefined} hint={h.payables.msmeAtRisk ? `${h.payables.msmeAtRisk} MSME bill(s) near 45 days` : 'Approved bills and advances'} to="/payables?tab=due" />
          <Kpi label="Payables due in 7 days" value={short(h.payables.dueThisWeek)} to="/payables?tab=due" />
          {h.founders.map((f) => (
            <Kpi key={f.founderUserId} label={`Owed to ${f.founderName}`} value={short(f.owed)} hint={f.waiting !== '0.00' ? `${short(f.waiting)} waiting for approval` : 'Approved claims not yet paid back'} to="/claims" />
          ))}
          {h.founders.length === 0 && <Kpi label="Cash forecast" value="13 weeks" hint="What is due each week" to="/forecast" />}
          {h.receivables && hasPermission('financeReceivables', 'view') && <Kpi label="Customers owe" value={short(h.receivables.outstanding)} tone={h.receivables.overdue !== '0.00' ? 'bad' : undefined} hint={h.receivables.overdue !== '0.00' ? `${short(h.receivables.overdue)} overdue` : `${h.receivables.open} open invoice(s)`} to="/receivables?tab=outstanding" />}
          {h.debt && hasPermission('financeFunding', 'view') && <Kpi label="Debt vs Mesa cap" value={short(h.debt.totalDebt)} tone={h.debt.breached ? 'bad' : undefined} hint={h.debt.breached ? 'Above the cap' : `Room ${short(h.debt.headroom)} of ${short(h.debt.cap)}`} to="/funding" />}
          {h.orderToBank && hasPermission('financeOrders', 'view') && <Kpi label="Money in transit" value={short(h.orderToBank.inTransit ?? '0')} hint="Paid by customers, not yet in the bank" tone={h.orderToBank.overdue ? 'bad' : undefined} to="/order-to-bank" />}
        </div>
      )}

      {hasPermission('financeHome', 'view') && <SpendByCategory />}

      {actions.length > 0 && (
        <Card className="p-3 sm:p-4">
          <h2 className="font-semibold text-gray-900 mb-2">Needs attention</h2>
          <ul className="space-y-1">
            {actions.map((a) => (
              <li key={a.text}>
                <Link to={a.to} className="flex items-center gap-2 text-sm text-amber-900 hover:underline">
                  <AlertTriangle className="w-4 h-4 shrink-0" /> <span className="flex-1">{a.text}</span> <ArrowRight className="w-4 h-4 shrink-0" />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="p-3 sm:p-4 space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-semibold text-gray-900">Month by month</h2>
          <div className="flex flex-wrap gap-3 text-xs text-gray-600">
            <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-sm bg-red-400" />Gross burn</span>
            <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-sm bg-emerald-500" />Operating income</span>
            <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-sm bg-amber-400" />Capex</span>
          </div>
        </div>
        <ul className="space-y-1.5">
          {h.months.map((m) => (
            <li key={m.month} className="grid grid-cols-[3.5rem_1fr_auto] items-center gap-2 text-xs">
              <Link to={`/ledger?from=${m.month}&to=${m.month.slice(0, 8)}${new Date(Date.UTC(Number(m.month.slice(0, 4)), Number(m.month.slice(5, 7)), 0)).getUTCDate()}`} className="text-gray-600 hover:underline">
                {monthLabel(m.month).replace(' 20', " '")}
              </Link>
              <div className="space-y-0.5">
                <div className="h-2 rounded-sm bg-red-400" style={{ width: `${ratio(m.grossBurn, max) * 100}%` }} title={`Gross burn ${short(m.grossBurn)}`} />
                <div className="h-2 rounded-sm bg-emerald-500" style={{ width: `${ratio(m.operatingIncome, max) * 100}%` }} title={`Operating income ${short(m.operatingIncome)}`} />
                <div className="h-2 rounded-sm bg-amber-400" style={{ width: `${ratio(m.capex, max) * 100}%` }} title={`Capex ${short(m.capex)}`} />
              </div>
              <div className="text-right num text-gray-700 w-24">{short(m.netBurn)}<span className="block text-[10px] text-gray-400">net burn</span></div>
            </li>
          ))}
        </ul>
        <p className="text-xs text-gray-500">
          Burn = operating expense + COGS + interest. Capex, loans, tax deposits, transfers and related-party money are shown apart (BR-37). <Link to="/analytics" className="text-blue-700 underline">Category analytics</Link>
        </p>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Card className="p-3 sm:p-4">
          <h2 className="font-semibold text-gray-900 mb-2">Bank accounts</h2>
          <ul className="divide-y divide-gray-100 text-sm">
            {h.cash.accounts.map((a) => (
              <li key={a.id} className="py-2 flex justify-between gap-2">
                <Link to={`/ledger?accountId=${a.id}`} className="min-w-0 hover:underline">
                  <span className="block truncate">{a.bankName} {a.accountNumberMasked}</span>
                  <span className="block text-xs text-gray-500">{a.lastTxnDate ? `Last row ${a.lastTxnDate}` : 'No statement imported yet'}</span>
                </Link>
                <span className="num whitespace-nowrap">{formatINR(a.balance)}</span>
              </li>
            ))}
          </ul>
          {h.cashCredit && <p className="text-xs text-gray-500 mt-2">Cash credit drawn {short(h.cashCredit.drawn)}, headroom {short(h.cashCredit.headroom)}. Runway uses cash only.</p>}
        </Card>
        <Card className="p-3 sm:p-4">
          <h2 className="font-semibold text-gray-900 mb-2">Funding received FY {h.fy}</h2>
          <div className="text-xl font-semibold num">{short(h.funding.fy)}</div>
          <ul className="mt-2 text-sm text-gray-600 space-y-0.5">
            {h.funding.bySubCategory.map((f) => <li key={f.name} className="flex justify-between gap-2"><span>{f.name}</span><span className="num">{short(f.amount)}</span></li>)}
            {h.funding.bySubCategory.length === 0 && <li>None recorded yet.</li>}
          </ul>
          <p className="text-xs text-gray-500 mt-2">Capital and loans are financing, never income.</p>
        </Card>
      </div>
    </div>
  );
}
