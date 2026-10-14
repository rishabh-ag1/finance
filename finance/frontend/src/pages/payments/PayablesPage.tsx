import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import api from '../../api';
import { Button, Card, Chip, PageHeader, Select, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { formatINR } from '../../lib/money';
import { cn } from '../../lib/utils';
import { dateLabel } from '../settings/api';
import { PAYMENT_STATUSES, PAYMENT_STATUS_TONE, type PaymentRow } from './api';

type DueRow = {
  id: string; docType: string; docTypeLabel: string; docNumber: string; vendorId: string; vendorName: string; status: string; statusLabel: string;
  dueDate: string | null; daysOverdue: number; group: 'overdue' | 'this_week' | 'later'; owed: string; requested: string; okToPay: boolean; isAdvance: boolean;
  msme: { level: 'day30' | 'day40' | 'breached'; limitDate: string; days: number } | null;
};
type Due = { rows: DueRow[]; totals: { overdue: string; thisWeek: string; later: string; msmeAtRisk: number } };
type Overview = {
  fy: string;
  received: { count: number; value: string; netPayable: string };
  paid: { count: number; amount: string };
  outstanding: string;
  overdue: string;
  byStatus: { paid: number; partiallyPaid: number; unpaid: number };
  withoutTaxInvoice: { amount: string; documents: number; toChase: number; poAdvances: string };
  noPo: { count: number; value: string };
  ageing: Ageing;
  msme: { amount: string; rows: { id: string; docNumber: string; vendorName: string; msmeType: string; outstanding: string; daysSinceAcceptance: number; limitDate: string; level: 'day30' | 'day40' | 'breached' }[] };
};
type Ageing = {
  asOf: string; buckets: { key: string; label: string }[];
  rows: { vendorId: string; vendorName: string; buckets: Record<string, string>; advances: string; total: string }[];
  totals: { buckets: Record<string, string>; advances: string; total: string };
};

const TABS = [['overview', 'Overview'], ['due', 'Due list'], ['payments', 'Payments'], ['ageing', 'Ageing']] as const;
const GROUP_LABEL = { overdue: 'Overdue', this_week: 'Due in the next 7 days', later: 'Later' } as const;
const MSME_TEXT = { day30: 'MSME: 30 days', day40: 'MSME: 40 days', breached: 'MSME: past the limit' } as const;

function DueTab() {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const [picked, setPicked] = useState<string[]>([]);
  const { data } = useQuery({ queryKey: ['payables-due'], queryFn: async () => (await api.get<{ data: Due }>('/payments/due')).data.data });
  if (!data) return <p className="text-sm text-gray-500">Loading…</p>;
  const pickedRows = data.rows.filter((r) => picked.includes(r.id));
  const sameVendor = new Set(pickedRows.map((r) => r.vendorId)).size <= 1;
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const canPay = hasPermission('financePayments', 'edit');

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Card className="p-3"><div className="text-xs text-gray-500">Overdue</div><div className="text-lg font-semibold num text-red-700">{formatINR(data.totals.overdue, { decimals: false })}</div></Card>
        <Card className="p-3"><div className="text-xs text-gray-500">Next 7 days</div><div className="text-lg font-semibold num">{formatINR(data.totals.thisWeek, { decimals: false })}</div></Card>
        <Card className="p-3"><div className="text-xs text-gray-500">Later</div><div className="text-lg font-semibold num">{formatINR(data.totals.later, { decimals: false })}</div></Card>
        <Card className="p-3"><div className="text-xs text-gray-500">MSME at risk</div><div className="text-lg font-semibold text-amber-700">{data.totals.msmeAtRisk}</div></Card>
      </div>
      {canPay && picked.length > 0 && (
        <Card className="p-3 flex flex-wrap items-center justify-between gap-2 sticky top-2 z-10">
          <span className="text-sm">{picked.length} chosen{!sameVendor && <span className="text-red-700"> · one payment is for one vendor</span>}</span>
          <Button disabled={!sameVendor} onClick={() => navigate(`/payments/new?vendorId=${pickedRows[0].vendorId}&docIds=${picked.join(',')}`)}>Pay these</Button>
        </Card>
      )}
      {data.rows.length === 0 && <Card className="p-4 text-sm text-gray-500">Nothing is owed to vendors.</Card>}
      {(['overdue', 'this_week', 'later'] as const).map((g) => {
        const rows = data.rows.filter((r) => r.group === g);
        if (!rows.length) return null;
        return (
          <div key={g} className="space-y-1">
            <h2 className="text-sm font-semibold text-gray-700">{GROUP_LABEL[g]}</h2>
            <Card className="divide-y divide-gray-100">
              {rows.map((r) => (
                <div key={r.id} className="px-3 sm:px-4 py-3 flex items-center gap-3">
                  {canPay && <input type="checkbox" aria-label={`Choose ${r.docNumber}`} disabled={!r.okToPay} checked={picked.includes(r.id)} onChange={() => toggle(r.id)} />}
                  <Link to={`/bills/${r.id}`} className="flex-1 min-w-0 hover:underline">
                    <span className="block font-medium text-gray-900 truncate">{r.vendorName} · {r.docTypeLabel} {r.docNumber}</span>
                    <span className="block text-xs text-gray-500">
                      {r.isAdvance ? 'Advance to pay' : r.dueDate ? `Due ${dateLabel(r.dueDate)}${r.daysOverdue ? ` · ${r.daysOverdue} day${r.daysOverdue === 1 ? '' : 's'} late` : ''}` : 'No due date'}
                      {!r.okToPay && ' · not marked OK to pay'}{r.requested !== '0.00' && ` · ${formatINR(r.requested, { decimals: false })} requested`}
                    </span>
                  </Link>
                  <div className="text-right">
                    <div className="num font-medium">{formatINR(r.owed)}</div>
                    <div className="flex gap-1 justify-end">{r.msme && <Chip tone={r.msme.level === 'breached' ? 'red' : 'amber'}>{MSME_TEXT[r.msme.level]}</Chip>}</div>
                  </div>
                </div>
              ))}
            </Card>
          </div>
        );
      })}
    </div>
  );
}

function PaymentsTab() {
  const [params, setParams] = useSearchParams();
  const f = { q: params.get('q') ?? '', status: params.get('status') ?? '' };
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { replace: true }); };
  const { data } = useQuery({
    queryKey: ['payments', f],
    queryFn: async () => (await api.get<{ data: { rows: PaymentRow[]; totals: { count: number; paid: string; tds: string; toPay: string; notInBank: string } } }>('/payments', { params: { q: f.q || undefined, status: f.status || undefined } })).data.data,
  });
  return (
    <div className="space-y-3">
      <Card className="p-3 sm:p-4 grid grid-cols-1 sm:grid-cols-3 gap-2">
        <TextInput placeholder="Search PMT number, UTR or vendor" value={f.q} onChange={(e) => set('q', e.target.value)} className="sm:col-span-2" />
        <Select value={f.status} onChange={(e) => set('status', e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          {PAYMENT_STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
      </Card>
      {data && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Card className="p-3"><div className="text-xs text-gray-500">Paid</div><div className="text-lg font-semibold num">{formatINR(data.totals.paid, { decimals: false })}</div></Card>
          <Card className="p-3"><div className="text-xs text-gray-500">TDS on advances</div><div className="text-lg font-semibold num">{formatINR(data.totals.tds, { decimals: false })}</div></Card>
          <Card className="p-3"><div className="text-xs text-gray-500">To pay</div><div className="text-lg font-semibold num">{formatINR(data.totals.toPay, { decimals: false })}</div></Card>
          <Card className="p-3"><div className="text-xs text-gray-500">Not in a statement yet</div><div className="text-lg font-semibold num text-amber-700">{formatINR(data.totals.notInBank, { decimals: false })}</div></Card>
        </div>
      )}
      {data?.rows.length === 0 && <Card className="p-4 text-sm text-gray-500">No payments yet.</Card>}
      {!!data?.rows.length && (
        <Card className="divide-y divide-gray-100">
          {data.rows.map((p) => (
            <Link key={p.id} to={`/payments/${p.id}`} className="block px-3 sm:px-4 py-3 hover:bg-gray-50/70">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-gray-900 truncate">{p.paymentNo ?? 'Request'} · {p.vendorName}</div>
                  <div className="text-xs text-gray-500">{p.paidDate ? dateLabel(p.paidDate) : `asked ${dateLabel(p.requestDate)}`}{p.mode ? ` · ${p.mode.toUpperCase()}` : ''}{p.utr ? ` · ${p.utr}` : ''}</div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="num font-medium">{formatINR(p.amount)}</span>
                  <Chip tone={PAYMENT_STATUS_TONE[p.status]}>{p.statusLabel}</Chip>
                </div>
              </div>
            </Link>
          ))}
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value, hint, to, tone }: { label: string; value: string; hint?: string; to?: string; tone?: 'red' | 'amber' }) {
  const body = (
    <Card className="p-3 h-full">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={cn('text-lg font-semibold num', tone === 'red' && 'text-red-700', tone === 'amber' && 'text-amber-700')}>{value}</div>
      {hint && <div className="text-xs text-gray-500">{hint}</div>}
    </Card>
  );
  return to ? <Link to={to} className="block hover:opacity-90">{body}</Link> : body;
}

// F132 payables dashboard (D16-D25).
function OverviewTab() {
  const { data: o } = useQuery({ queryKey: ['payables-overview'], queryFn: async () => (await api.get<{ data: Overview }>('/dashboard/payables')).data.data });
  if (!o) return <p className="text-sm text-gray-500">Loading…</p>;
  const short = (v: string) => formatINR(v, { decimals: false });
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-gray-700">FY {o.fy}</h2>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <Stat label="Documents received" value={String(o.received.count)} hint="Quotes, proformas and tax invoices" to="/bills" />
        <Stat label="Invoiced value" value={short(o.received.value)} hint={`Net payable ${short(o.received.netPayable)}`} />
        <Stat label="Paid incl. advances" value={short(o.paid.amount)} hint={`${o.paid.count} payment(s)`} to="/payables?tab=payments" />
        <Stat label="Invoices with no PO" value={String(o.noPo.count)} hint={short(o.noPo.value)} to="/bills" />
      </div>
      <h2 className="text-sm font-semibold text-gray-700 pt-1">Now</h2>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <Stat label="Outstanding" value={short(o.outstanding)} hint={`${o.byStatus.unpaid} unpaid · ${o.byStatus.partiallyPaid} part paid · ${o.byStatus.paid} paid`} to="/payables?tab=due" />
        <Stat label="Overdue" value={short(o.overdue)} tone={o.overdue !== '0.00' ? 'red' : undefined} to="/payables?tab=ageing" />
        <Stat label="Paid with no tax invoice yet" value={short(o.withoutTaxInvoice.amount)} hint={`${o.withoutTaxInvoice.documents} document(s), ${o.withoutTaxInvoice.toChase} to chase · PO advances ${short(o.withoutTaxInvoice.poAdvances)}`} tone={o.withoutTaxInvoice.toChase > 0 ? 'amber' : undefined} to="/bills?view=chase" />
        <Stat label="MSME exposure" value={short(o.msme.amount)} hint={`${o.msme.rows.length} bill(s) 30+ days after acceptance`} tone={o.msme.rows.length ? 'amber' : undefined} />
      </div>
      {o.msme.rows.length > 0 && (
        <Card className="divide-y divide-gray-100">
          <div className="px-3 sm:px-4 py-2 text-sm font-semibold text-gray-700">MSME: pay within 45 days of acceptance (BR-25)</div>
          {o.msme.rows.map((r) => (
            <Link key={r.id} to={`/bills/${r.id}`} className="px-3 sm:px-4 py-2.5 flex items-center justify-between gap-2 hover:bg-gray-50/70">
              <span className="min-w-0">
                <span className="block font-medium text-gray-900 truncate">{r.vendorName} · {r.docNumber}</span>
                <span className="block text-xs text-gray-500">{r.daysSinceAcceptance} days since accepted · pay by {dateLabel(r.limitDate)}</span>
              </span>
              <span className="text-right">
                <span className="block num font-medium">{formatINR(r.outstanding)}</span>
                <Chip tone={r.level === 'breached' ? 'red' : 'amber'}>{MSME_TEXT[r.level]}</Chip>
              </span>
            </Link>
          ))}
        </Card>
      )}
    </div>
  );
}

function AgeingTab() {
  const { data } = useQuery({ queryKey: ['ap-ageing'], queryFn: async () => (await api.get<{ data: Ageing }>('/payments/ageing')).data.data });
  if (!data) return <p className="text-sm text-gray-500">Loading…</p>;
  const cell = (v: string) => (v === '0.00' ? <span className="text-gray-300">–</span> : formatINR(v, { decimals: false }));
  return (
    <div className="space-y-2">
      <p className="text-sm text-gray-600">What is owed per vendor, by days past the due date, as of {dateLabel(data.asOf)}. Advances not yet set against a tax invoice are shown apart (BR-24).</p>
      {data.rows.length === 0 ? <Card className="p-4 text-sm text-gray-500">Nothing is owed.</Card> : (
        <Card className="overflow-x-auto">
          <table className="min-w-full text-xs sm:text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="sticky left-0 bg-gray-50 text-left font-medium px-3 py-2">Vendor</th>
                {data.buckets.map((b) => <th key={b.key} className="text-right font-medium px-2 py-2 whitespace-nowrap">{b.label}</th>)}
                <th className="text-right font-medium px-3 py-2">Owed</th>
                <th className="text-right font-medium px-3 py-2 whitespace-nowrap">Advances</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.rows.map((r) => (
                <tr key={r.vendorId}>
                  <td className="sticky left-0 bg-white px-3 py-1.5"><Link to={`/bills?view=open&q=${encodeURIComponent(r.vendorName)}`} className="hover:underline">{r.vendorName}</Link></td>
                  {data.buckets.map((b) => <td key={b.key} className={cn('text-right num px-2 py-1.5 whitespace-nowrap', b.key !== 'not_due' && r.buckets[b.key] !== '0.00' && 'text-red-700')}>{cell(r.buckets[b.key])}</td>)}
                  <td className="text-right num px-3 py-1.5 font-medium whitespace-nowrap">{cell(r.total)}</td>
                  <td className="text-right num px-3 py-1.5 whitespace-nowrap">{cell(r.advances)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-gray-50 font-semibold">
              <tr>
                <td className="sticky left-0 bg-gray-50 px-3 py-2">Total</td>
                {data.buckets.map((b) => <td key={b.key} className="text-right num px-2 py-2 whitespace-nowrap">{cell(data.totals.buckets[b.key])}</td>)}
                <td className="text-right num px-3 py-2 whitespace-nowrap">{cell(data.totals.total)}</td>
                <td className="text-right num px-3 py-2 whitespace-nowrap">{cell(data.totals.advances)}</td>
              </tr>
            </tfoot>
          </table>
        </Card>
      )}
    </div>
  );
}

// F132 overview (D16-D25), F060 due list, F065 payment log, F067 AP ageing.
export function PayablesPage() {
  const [params, setParams] = useSearchParams();
  const { hasPermission } = useAuth();
  const tab = (TABS.find(([k]) => k === params.get('tab'))?.[0] ?? 'overview');
  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <PageHeader
        title="Payables"
        subtitle="What is owed to vendors, what has been paid, and how late it is."
        action={hasPermission('financePayments', 'edit') && (
          <Link to="/payments/new" className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium bg-[#0c2c55] text-white hover:bg-[#0e3261]"><Plus className="w-4 h-4" /> New payment</Link>
        )}
      />
      <nav className="flex gap-1 overflow-x-auto -mx-3 px-3 sm:mx-0 sm:px-0 border-b border-gray-200">
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setParams({ tab: k })} className={cn('shrink-0 px-3 py-2 text-sm border-b-2 -mb-px', tab === k ? 'border-[#0c2c55] text-[#0c2c55] font-medium' : 'border-transparent text-gray-500 hover:text-gray-800')}>{label}</button>
        ))}
      </nav>
      {tab === 'overview' && <OverviewTab />}
      {tab === 'due' && <DueTab />}
      {tab === 'payments' && <PaymentsTab />}
      {tab === 'ageing' && <AgeingTab />}
    </div>
  );
}
