import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import api from '../../api';
import { Card, Chip, PageHeader, Select, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { formatINR } from '../../lib/money';
import { cn } from '../../lib/utils';
import { dateLabel } from '../settings/api';
import { DOC_STATUSES, DOC_STATUS_TONE, DOC_TYPES, type BillRow } from './api';

type Totals = { count: number; taxableValue: string; gst: string; totalValue: string; tdsAmount: string; netPayable: string; outstanding: string };
type Chase = { chaseAfterDays: number; rows: (BillRow & { ageDays: number; advancePaid: string; due: boolean })[]; totals: { awaiting: number; advancesWithoutTaxInvoice: string; toChase: number } };

const VIEWS = [['all', 'All documents'], ['open', 'Open'], ['overdue', 'Overdue'], ['chase', 'Awaiting tax invoice']] as const;

function BillLine({ b, extra }: { b: BillRow; extra?: string }) {
  return (
    <Link to={`/bills/${b.id}`} className="block px-3 sm:px-4 py-3 hover:bg-gray-50/70">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <div className="font-medium text-gray-900 truncate">{b.vendorName} · {b.docTypeLabel} {b.docNumber}</div>
          <div className="text-xs text-gray-500">
            {dateLabel(b.docDate)}{b.poNumber ? ` · ${b.poNumber}` : ''}{b.dueDate && b.outstanding !== '0.00' ? ` · due ${dateLabel(b.dueDate)}` : ''}{extra ? ` · ${extra}` : ''}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="num font-medium">{formatINR(b.totalValue)}</div>
            {b.outstanding !== '0.00' && <div className={cn('text-xs num', b.overdue ? 'text-red-700' : 'text-gray-500')}>owed {formatINR(b.outstanding, { decimals: false })}</div>}
          </div>
          <div className="flex flex-col items-end gap-1">
            <Chip tone={DOC_STATUS_TONE[b.status]}>{b.statusLabel}</Chip>
            {b.overdue && <Chip tone="red">Overdue</Chip>}
            {b.msme && <Chip tone="amber">MSME</Chip>}
          </div>
        </div>
      </div>
    </Link>
  );
}

// F050 vendor document register (the old Vendor Invoice Register), with the F059 chase list.
export function BillsPage() {
  const [params, setParams] = useSearchParams();
  const { hasPermission } = useAuth();
  const view = (params.get('view') ?? 'all') as (typeof VIEWS)[number][0];
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { replace: true }); };
  const filters = { q: params.get('q') ?? '', status: params.get('status') ?? '', docType: params.get('docType') ?? '' };

  const list = useQuery({
    enabled: view !== 'chase',
    queryKey: ['bills', view, filters],
    queryFn: async () => (await api.get<{ data: { rows: BillRow[]; totals: Totals } }>('/bills', {
      params: { ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), overdue: view === 'overdue' ? '1' : undefined, open: view === 'open' ? '1' : undefined },
    })).data.data,
  });
  const chase = useQuery({ enabled: view === 'chase', queryKey: ['bills-chase'], queryFn: async () => (await api.get<{ data: Chase }>('/bills/chase')).data.data });

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <PageHeader
        title="Vendor bills"
        subtitle="Quotes, proformas, tax invoices and notes from vendors, with TDS and what is still owed."
        action={hasPermission('financeBills', 'edit') && (
          <Link to="/bills/new" className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium bg-[#0c2c55] text-white hover:bg-[#0e3261]">
            <Plus className="w-4 h-4" /> Enter document
          </Link>
        )}
      />
      <nav className="flex gap-1 overflow-x-auto -mx-3 px-3 sm:mx-0 sm:px-0 border-b border-gray-200">
        {VIEWS.map(([k, label]) => (
          <button key={k} onClick={() => set('view', k === 'all' ? '' : k)}
            className={cn('shrink-0 px-3 py-2 text-sm border-b-2 -mb-px', view === k ? 'border-[#0c2c55] text-[#0c2c55] font-medium' : 'border-transparent text-gray-500 hover:text-gray-800')}>
            {label}
          </button>
        ))}
      </nav>

      {view !== 'chase' && (
        <>
          <Card className="p-3 sm:p-4 grid grid-cols-1 sm:grid-cols-4 gap-2">
            <TextInput placeholder="Search vendor or number" value={filters.q} onChange={(e) => set('q', e.target.value)} className="sm:col-span-2" />
            <Select value={filters.docType} onChange={(e) => set('docType', e.target.value)} aria-label="Type">
              <option value="">Any type</option>
              {DOC_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
            <Select value={filters.status} onChange={(e) => set('status', e.target.value)} aria-label="Status">
              <option value="">Any status</option>
              {DOC_STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Card>
          {list.data && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Card className="p-3"><div className="text-xs text-gray-500">Documents</div><div className="text-lg font-semibold">{list.data.totals.count}</div></Card>
              <Card className="p-3"><div className="text-xs text-gray-500">Total value</div><div className="text-lg font-semibold num">{formatINR(list.data.totals.totalValue, { decimals: false })}</div><div className="text-xs text-gray-500 num">GST {formatINR(list.data.totals.gst, { decimals: false })}</div></Card>
              <Card className="p-3"><div className="text-xs text-gray-500">TDS</div><div className="text-lg font-semibold num">{formatINR(list.data.totals.tdsAmount, { decimals: false })}</div></Card>
              <Card className="p-3"><div className="text-xs text-gray-500">Still owed</div><div className="text-lg font-semibold num text-red-700">{formatINR(list.data.totals.outstanding, { decimals: false })}</div></Card>
            </div>
          )}
          {list.isLoading && <p className="text-sm text-gray-500">Loading…</p>}
          {list.data?.rows.length === 0 && <Card className="p-4 text-sm text-gray-500">No vendor documents here yet.</Card>}
          {!!list.data?.rows.length && <Card className="divide-y divide-gray-100">{list.data.rows.map((b) => <BillLine key={b.id} b={b} />)}</Card>}
        </>
      )}

      {view === 'chase' && chase.data && (
        <>
          <p className="text-sm text-gray-600">
            Quotes and proformas still waiting for the vendor's tax invoice. GST input credit cannot be claimed until it arrives (BR-10).
            Those older than {chase.data.chaseAfterDays} days are marked to chase (Settings &gt; Company).
          </p>
          <div className="grid grid-cols-3 gap-2">
            <Card className="p-3"><div className="text-xs text-gray-500">Waiting</div><div className="text-lg font-semibold">{chase.data.totals.awaiting}</div></Card>
            <Card className="p-3"><div className="text-xs text-gray-500">To chase</div><div className="text-lg font-semibold text-amber-700">{chase.data.totals.toChase}</div></Card>
            <Card className="p-3"><div className="text-xs text-gray-500">Paid without tax invoice</div><div className="text-lg font-semibold num">{formatINR(chase.data.totals.advancesWithoutTaxInvoice, { decimals: false })}</div></Card>
          </div>
          {chase.data.rows.length === 0 ? <Card className="p-4 text-sm text-gray-500">Nothing is waiting for a tax invoice.</Card> : (
            <Card className="divide-y divide-gray-100">
              {chase.data.rows.map((b) => <BillLine key={b.id} b={b} extra={`${b.ageDays} days${b.due ? ' · chase now' : ''}`} />)}
            </Card>
          )}
        </>
      )}
    </div>
  );
}
