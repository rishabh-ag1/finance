import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import api from '../../api';
import { Card, Chip, PageHeader, Select, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { formatINR } from '../../lib/money';
import { cn } from '../../lib/utils';
import { dateLabel } from '../settings/api';
import { DOC_TYPES, STATUSES, STATUS_TONE, type DocRow } from './api';

// F098 sales documents: proformas, tax invoices and credit notes.
export function SalesPage() {
  const [params, setParams] = useSearchParams();
  const { hasPermission } = useAuth();
  const f = { docType: params.get('docType') ?? '', status: params.get('status') ?? '', q: params.get('q') ?? '', supplyType: params.get('supplyType') ?? '', from: params.get('from') ?? '', to: params.get('to') ?? '' };
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { replace: true }); };
  const { data, isLoading } = useQuery({
    queryKey: ['sales', f],
    queryFn: async () => (await api.get<{ data: { rows: DocRow[]; totals: { invoiced: string; invoicedTax: string; credited: string; proformas: string } } }>('/sales', {
      params: Object.fromEntries(Object.entries(f).filter(([, v]) => v)),
    })).data.data,
  });
  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <PageHeader
        title="Invoices"
        subtitle="Proformas, tax invoices and credit notes. Numbers are taken only when a document is issued."
        action={hasPermission('financeSales', 'edit') && (
          <div className="flex flex-wrap gap-2 justify-end">
            <Link to="/sales/d2c" className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-white border border-gray-200 text-gray-800 hover:bg-gray-50">D2C</Link>
            <Link to="/sales/refills" className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-white border border-gray-200 text-gray-800 hover:bg-gray-50">Refills</Link>
            <Link to="/sales/new?type=proforma" className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-white border border-gray-200 text-gray-800 hover:bg-gray-50"><Plus className="w-4 h-4" /> Proforma</Link>
            <Link to="/sales/new?type=tax_invoice" className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-[#0c2c55] text-white hover:bg-[#0e3261]"><Plus className="w-4 h-4" /> Invoice</Link>
          </div>
        )}
      />
      <nav className="flex gap-1 overflow-x-auto -mx-3 px-3 sm:mx-0 sm:px-0 border-b border-gray-200">
        {[['', 'All'] as [string, string], ...DOC_TYPES].map(([k, label]) => (
          <button key={k} onClick={() => set('docType', k)} className={cn('shrink-0 px-3 py-2 text-sm border-b-2 -mb-px', f.docType === k ? 'border-[#0c2c55] text-[#0c2c55] font-medium' : 'border-transparent text-gray-500 hover:text-gray-800')}>{label}</button>
        ))}
      </nav>
      <Card className="p-3 sm:p-4 grid grid-cols-2 sm:grid-cols-5 gap-2">
        <TextInput placeholder="Number, customer, GSTIN, order" value={f.q} onChange={(e) => set('q', e.target.value)} className="col-span-2" />
        <Select value={f.status} onChange={(e) => set('status', e.target.value)} aria-label="Status"><option value="">Any status</option>{STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        <Select value={f.supplyType} onChange={(e) => set('supplyType', e.target.value)} aria-label="B2B or B2C"><option value="">B2B and B2C</option><option value="b2b">B2B</option><option value="b2c">B2C</option></Select>
        <TextInput type="date" aria-label="From" value={f.from} onChange={(e) => set('from', e.target.value)} />
      </Card>
      {data && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Card className="p-3"><div className="text-xs text-gray-500">Invoiced</div><div className="text-lg font-semibold num">{formatINR(data.totals.invoiced, { decimals: false })}</div></Card>
          <Card className="p-3"><div className="text-xs text-gray-500">GST on invoices</div><div className="text-lg font-semibold num">{formatINR(data.totals.invoicedTax, { decimals: false })}</div></Card>
          <Card className="p-3"><div className="text-xs text-gray-500">Credit notes</div><div className="text-lg font-semibold num">{formatINR(data.totals.credited, { decimals: false })}</div></Card>
          <Card className="p-3"><div className="text-xs text-gray-500">Proformas</div><div className="text-lg font-semibold num">{formatINR(data.totals.proformas, { decimals: false })}</div></Card>
        </div>
      )}
      {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
      {data?.rows.length === 0 && <Card className="p-4 text-sm text-gray-500">No documents yet.</Card>}
      {!!data?.rows.length && (
        <Card className="divide-y divide-gray-100">
          {data.rows.map((d) => (
            <Link key={d.id} to={`/sales/${d.id}`} className="block px-3 sm:px-4 py-3 hover:bg-gray-50/70">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-gray-900 truncate">{d.docNumber ?? `Draft ${d.docTypeLabel.toLowerCase()}`} · {d.customerName}</div>
                  <div className="text-xs text-gray-500 truncate">{d.docTypeLabel} · {dateLabel(d.docDate)} · {d.supplyType.toUpperCase()}{d.customerGstin ? ` · ${d.customerGstin}` : ''}{d.crmOrderNumber ? ` · ${d.crmOrderNumber}` : ''}{d.source !== 'manual' ? ` · ${d.sourceLabel}` : ''}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="num font-medium">{d.docType === 'credit_note' ? '−' : ''}{formatINR(d.total)}</div>
                  {d.payment ? <Chip tone={d.payment.overdue ? 'red' : d.payment.state === 'paid' ? 'green' : d.payment.state === 'partly_paid' ? 'blue' : 'amber'}>{d.payment.overdue ? `Overdue ${d.payment.daysOverdue}d` : d.payment.stateLabel}</Chip> : <Chip tone={STATUS_TONE[d.status] ?? 'gray'}>{d.statusLabel}</Chip>}
                </div>
              </div>
            </Link>
          ))}
        </Card>
      )}
    </div>
  );
}
