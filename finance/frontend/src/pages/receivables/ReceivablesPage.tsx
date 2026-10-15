import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import api from '../../api';
import { Button, Card, Chip, ErrorNote, PageHeader, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { formatINR } from '../../lib/money';
import { apiErrorMessage, cn } from '../../lib/utils';
import { dateLabel } from '../settings/api';
import { BUCKETS, PAY_TONE, RECEIVABLE_KEYS, type Ageing, type Credit, type Dashboard, type OutstandingRow, type ReceiptRow } from './api';

const TABS = [['overview', 'Overview'], ['outstanding', 'Outstanding'], ['ageing', 'Ageing'], ['receipts', 'Receipts'], ['credits', 'Bank credits'], ['tds', 'Customer TDS']] as const;
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });
const cell = (v: string) => (v === '0.00' ? <span className="text-gray-300">–</span> : formatINR(v, { decimals: false }));

function OverviewTab() {
  const { data } = useQuery({ queryKey: ['receivables', 'dashboard'], queryFn: async () => (await api.get<{ data: Dashboard }>('/receivables/dashboard')).data.data });
  if (!data) return <p className="text-sm text-gray-500">Loading…</p>;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Card className="p-3"><div className="text-xs text-gray-500">Outstanding</div><div className="text-lg font-semibold num">{formatINR(data.outstanding, { decimals: false })}</div><div className="text-xs text-gray-500">{data.invoicesOpen} invoice(s)</div></Card>
        <Card className="p-3"><div className="text-xs text-gray-500">Overdue</div><div className={cn('text-lg font-semibold num', data.overdue !== '0.00' && 'text-red-700')}>{formatINR(data.overdue, { decimals: false })}</div></Card>
        <Card className="p-3"><div className="text-xs text-gray-500">Days sales outstanding</div><div className="text-lg font-semibold">{data.dso ?? '–'}</div><div className="text-xs text-gray-500">Last 90 days of sales</div></Card>
        <Card className="p-3"><div className="text-xs text-gray-500">Advances held</div><div className="text-lg font-semibold num">{formatINR(data.advances, { decimals: false })}</div></Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4 space-y-2">
          <h2 className="font-semibold text-gray-900">Top debtors</h2>
          {data.topDebtors.length === 0 && <p className="text-sm text-gray-500">Nobody owes anything.</p>}
          <ul className="divide-y divide-gray-100 text-sm">
            {data.topDebtors.map((d) => (
              <li key={d.name} className="py-2 flex justify-between gap-2">
                <span className="truncate">{d.companyId ? <Link to={`/customers/${d.companyId}`} className="hover:underline">{d.name}</Link> : d.name}</span>
                <span className="num shrink-0">{formatINR(d.total, { decimals: false })}{d.overdue !== '0.00' && <span className="text-red-700 text-xs"> ({formatINR(d.overdue, { decimals: false })} late)</span>}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card className="p-4 space-y-2">
          <h2 className="font-semibold text-gray-900">Collections by month</h2>
          <table className="w-full text-sm table-fixed">
            <thead><tr className="text-xs text-gray-500 text-left"><th className="py-1 w-[22%]">Month</th><th className="text-right">Received</th><th className="text-right">TDS</th><th className="text-right">Gateway fees</th></tr></thead>
            <tbody className="divide-y divide-gray-100">
              {data.collections.map((c) => (
                <tr key={c.month}><td className="py-1.5">{monthName(c.month)}</td><td className="text-right num">{cell(c.received)}</td><td className="text-right num">{cell(c.tds)}</td><td className="text-right num">{cell(c.gatewayCharges)}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-gray-500">Gateway fees include GST on the fee (input credit): {formatINR(data.collections.reduce((s, c) => s + Number(c.gstOnCharges), 0).toFixed(2))} over these months.</p>
        </Card>
      </div>
    </div>
  );
}

function OutstandingTab() {
  const [overdue, setOverdue] = useState(false);
  const [q, setQ] = useState('');
  const { data } = useQuery({ queryKey: ['receivables', 'outstanding', overdue, q], queryFn: async () => (await api.get<{ data: { rows: OutstandingRow[]; totals: { outstanding: string; overdue: string } } }>('/receivables/outstanding', { params: { overdue: overdue ? '1' : undefined, q: q || undefined } })).data.data });
  return (
    <div className="space-y-3">
      <Card className="p-3 flex flex-wrap items-center gap-3">
        <TextInput placeholder="Invoice, customer, order" value={q} onChange={(e) => setQ(e.target.value)} className="flex-1 min-w-40" />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={overdue} onChange={(e) => setOverdue(e.target.checked)} /> Overdue only</label>
      </Card>
      {data && <p className="text-sm text-gray-600">{formatINR(data.totals.outstanding)} owed, {formatINR(data.totals.overdue)} of it overdue.</p>}
      {data?.rows.length === 0 && <Card className="p-4 text-sm text-gray-500">Nothing is owed.</Card>}
      {!!data?.rows.length && (
        <Card className="divide-y divide-gray-100">
          {data.rows.map((r) => (
            <Link key={r.id} to={`/sales/${r.id}`} className="block px-3 sm:px-4 py-3 hover:bg-gray-50/70">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-gray-900 truncate">{r.docNumber} · {r.customerName}</div>
                  <div className="text-xs text-gray-500 truncate">
                    {r.dueDate ? `Due ${dateLabel(r.dueDate)}` : 'No due date'}{r.overdue ? ` · ${r.daysOverdue} day(s) late` : ''}{r.crmOrderNumber ? ` · ${r.crmOrderNumber}` : ''}{r.lastReminder ? ` · reminded ${dateLabel(r.lastReminder)}` : ''}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className={cn('num font-medium', r.overdue && 'text-red-700')}>{formatINR(r.outstanding)}</div>
                  <Chip tone={PAY_TONE[r.state]}>{r.stateLabel}</Chip>
                </div>
              </div>
            </Link>
          ))}
        </Card>
      )}
    </div>
  );
}

function AgeingTab() {
  const { data } = useQuery({ queryKey: ['receivables', 'ageing'], queryFn: async () => (await api.get<{ data: Ageing }>('/receivables/ageing')).data.data });
  if (!data) return <p className="text-sm text-gray-500">Loading…</p>;
  return (
    <div className="space-y-2">
      <p className="text-sm text-gray-600">What each customer owes by days past the due date. Advances (money received and not yet set against a tax invoice) are shown apart (BR-24).</p>
      {data.rows.length === 0 ? <Card className="p-4 text-sm text-gray-500">Nothing is owed.</Card> : (
        <Card className="overflow-x-auto">
          <table className="min-w-full text-xs sm:text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="sticky left-0 bg-gray-50 text-left font-medium px-3 py-2">Customer</th>
                {BUCKETS.map((b) => <th key={b} className="text-right font-medium px-2 py-2 whitespace-nowrap">{data.labels[b]}</th>)}
                <th className="text-right font-medium px-3 py-2">Owed</th>
                <th className="text-right font-medium px-3 py-2">Advances</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.rows.map((r) => (
                <tr key={r.key}>
                  <td className="sticky left-0 bg-white px-3 py-1.5 max-w-40 truncate">{r.companyId ? <Link to={`/customers/${r.companyId}`} className="hover:underline">{r.name}</Link> : r.name}</td>
                  {BUCKETS.map((b) => <td key={b} className={cn('text-right num px-2 py-1.5 whitespace-nowrap', b !== 'not_due' && r.buckets[b] !== '0.00' && 'text-red-700')}>{cell(r.buckets[b])}</td>)}
                  <td className="text-right num px-3 py-1.5 font-medium whitespace-nowrap">{cell(r.total)}</td>
                  <td className="text-right num px-3 py-1.5 whitespace-nowrap">{cell(r.advances)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-gray-50 font-semibold">
              <tr>
                <td className="sticky left-0 bg-gray-50 px-3 py-2">Total</td>
                {BUCKETS.map((b) => <td key={b} className="text-right num px-2 py-2 whitespace-nowrap">{cell(data.totals[b])}</td>)}
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

function ReceiptsTab() {
  const [q, setQ] = useState('');
  const { data } = useQuery({ queryKey: ['receipts', q], queryFn: async () => (await api.get<{ data: ReceiptRow[] }>('/receipts', { params: { q: q || undefined } })).data.data });
  return (
    <div className="space-y-3">
      <Card className="p-3"><TextInput placeholder="Receipt number, customer, UTR, order" value={q} onChange={(e) => setQ(e.target.value)} /></Card>
      {data?.length === 0 && <Card className="p-4 text-sm text-gray-500">No receipts yet.</Card>}
      {!!data?.length && (
        <Card className="divide-y divide-gray-100">
          {data.map((r) => (
            <Link key={r.id} to={`/receipts/${r.id}`} className="block px-3 sm:px-4 py-3 hover:bg-gray-50/70">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-gray-900 truncate">{r.receiptNo} · {r.customerName}</div>
                  <div className="text-xs text-gray-500 truncate">{dateLabel(r.receiptDate)} · {r.modeLabel}{r.reference ? ` · ${r.reference}` : ''}{r.crmOrderNumber ? ` · ${r.crmOrderNumber}` : ''}{r.tds !== '0.00' ? ` · TDS ${formatINR(r.tds)}` : ''}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="num font-medium">{formatINR(r.amount)}</div>
                  {r.status === 'cancelled' ? <Chip tone="red">Cancelled</Chip> : r.advance !== '0.00' ? <Chip tone="blue">Advance {formatINR(r.advance, { decimals: false })}</Chip> : <Chip tone={r.inBank || r.source !== 'manual' ? 'green' : 'amber'}>{r.inBank || r.source !== 'manual' ? 'In bank' : 'Not in bank yet'}</Chip>}
                </div>
              </div>
            </Link>
          ))}
        </Card>
      )}
    </div>
  );
}

function CreditsTab() {
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('financeReceivables', 'edit');
  const { data } = useQuery({ queryKey: ['receivables', 'credits'], queryFn: async () => (await api.get<{ data: Credit[] }>('/receivables/credits')).data.data });
  const record = useMutation({
    mutationFn: async (v: { txnId: string; docId: string; tds: string }) => (await api.post(`/receivables/credits/${v.txnId}/receipt`, { docId: v.docId, tds: v.tds })).data.data,
    onSuccess: () => { for (const k of RECEIVABLE_KEYS) qc.invalidateQueries({ queryKey: [k] }); },
  });
  if (!data) return <p className="text-sm text-gray-500">Loading…</p>;
  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600">Bank credits of the last 120 days that are not yet explained, with the invoices they most likely pay (BR-38: the amount owed, or owed less TDS at 1, 2 or 10%; the name in the narration).</p>
      <ErrorNote>{record.isError && apiErrorMessage(record.error, 'Could not record the receipt')}</ErrorNote>
      {data.length === 0 && <Card className="p-4 text-sm text-gray-500">No credits waiting for an invoice.</Card>}
      {data.map((c) => (
        <Card key={c.id} className="p-3 sm:p-4 space-y-2">
          <div className="flex justify-between gap-2">
            <div className="min-w-0"><div className="font-medium truncate">{c.counterpartyName ?? 'Credit'} · {dateLabel(c.txnDate)}</div><div className="text-xs text-gray-500 truncate">{c.narration}</div></div>
            <div className="num font-semibold shrink-0">{formatINR(c.credit)}</div>
          </div>
          <ul className="space-y-1">
            {c.suggestions.map((s) => (
              <li key={s.invoiceId} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg bg-gray-50 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <Link to={`/sales/${s.invoiceId}`} className="font-medium hover:underline">{s.docNumber}</Link> · {s.customerName}
                  <div className="text-xs text-gray-500">{s.why}{s.tds !== '0.00' ? `: receipt ${formatINR(s.receipt)} + TDS ${formatINR(s.tds)}` : ''}{s.settles ? ', settles it' : ', part payment'} · {Math.round(s.confidence * 100)}% sure</div>
                </div>
                {canEdit && <Button variant="secondary" className="shrink-0" disabled={record.isPending} onClick={() => record.mutate({ txnId: c.id, docId: s.invoiceId, tds: s.tds })}>Record receipt</Button>}
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

function TdsTab() {
  const { data } = useQuery({ queryKey: ['receivables', 'tds'], queryFn: async () => (await api.get<{ data: { customerName: string; quarter: string; tds: string; receipts: string[] }[] }>('/receivables/tds')).data.data });
  if (!data) return <p className="text-sm text-gray-500">Loading…</p>;
  return (
    <div className="space-y-2">
      <p className="text-sm text-gray-600">TDS customers deducted from what they paid, by quarter, to check against Form 26AS / AIS (BR-41). Only customers set to deduct TDS can have it.</p>
      {data.length === 0 ? <Card className="p-4 text-sm text-gray-500">No TDS deducted by customers yet.</Card> : (
        <Card className="divide-y divide-gray-100 text-sm">
          {data.map((t) => (
            <div key={`${t.customerName}-${t.quarter}`} className="px-3 sm:px-4 py-2 flex justify-between gap-2">
              <div className="min-w-0"><div className="truncate">{t.customerName}</div><div className="text-xs text-gray-500 truncate">FY {t.quarter} · {t.receipts.join(', ')}</div></div>
              <div className="num font-medium shrink-0">{formatINR(t.tds)}</div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

// M10 Receivables (F110-F117, F133).
export function ReceivablesPage() {
  const [params, setParams] = useSearchParams();
  const { hasPermission } = useAuth();
  const tab = TABS.find(([k]) => k === params.get('tab'))?.[0] ?? 'overview';
  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <PageHeader
        title="Receivables"
        subtitle="What customers owe, what has come in, and how late it is."
        action={hasPermission('financeReceivables', 'edit') && (
          <Link to="/receipts/new" className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium bg-[#0c2c55] text-white hover:bg-[#0e3261]"><Plus className="w-4 h-4" /> Receipt</Link>
        )}
      />
      <nav className="flex gap-1 overflow-x-auto -mx-3 px-3 sm:mx-0 sm:px-0 border-b border-gray-200">
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setParams({ tab: k })} className={cn('shrink-0 px-3 py-2 text-sm border-b-2 -mb-px', tab === k ? 'border-[#0c2c55] text-[#0c2c55] font-medium' : 'border-transparent text-gray-500 hover:text-gray-800')}>{label}</button>
        ))}
      </nav>
      {tab === 'overview' && <OverviewTab />}
      {tab === 'outstanding' && <OutstandingTab />}
      {tab === 'ageing' && <AgeingTab />}
      {tab === 'receipts' && <ReceiptsTab />}
      {tab === 'credits' && <CreditsTab />}
      {tab === 'tds' && <TdsTab />}
    </div>
  );
}
