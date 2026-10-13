import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import api from '../../api';
import { Card, Chip, PageHeader, Select, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { formatINR } from '../../lib/money';
import { dateLabel } from '../settings/api';
import { PO_STATUS_TONE, type PoRow, type PoStatus } from './api';

const STATUS_OPTIONS: [PoStatus, string][] = [
  ['draft', 'Draft'], ['pending_approval', 'Waiting for approval'], ['approved', 'Issued'], ['sent', 'Sent'],
  ['partially_billed', 'Partially billed'], ['fully_billed', 'Fully billed'], ['closed', 'Closed'], ['cancelled', 'Cancelled'],
];

// F040 PO register: the old PO Register sheet, with billed and paid computed.
export function PurchaseOrdersPage() {
  const [params, setParams] = useSearchParams();
  const { hasPermission } = useAuth();
  const status = params.get('status') ?? '';
  const q = params.get('q') ?? '';
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { replace: true }); };
  const { data, isLoading } = useQuery({
    queryKey: ['pos', status, q],
    queryFn: async () => (await api.get<{ data: { rows: PoRow[]; totals: { count: number; taxable: string; total: string; billedTaxable: string; paidTotal: string } } }>('/purchases/pos', { params: { status: status || undefined, q: q || undefined } })).data.data,
  });

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <PageHeader
        title="Purchase orders"
        subtitle="Drafts get a number only when issued. Billed and paid follow the vendor's documents and payments."
        action={hasPermission('financePurchases', 'edit') && (
          <Link to="/purchase-orders/new" className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium bg-[#0c2c55] text-white hover:bg-[#0e3261]">
            <Plus className="w-4 h-4" /> New PO
          </Link>
        )}
      />
      <Card className="p-3 sm:p-4 grid grid-cols-1 sm:grid-cols-3 gap-2">
        <TextInput placeholder="Search PO number, vendor, quote" value={q} onChange={(e) => set('q', e.target.value)} className="sm:col-span-2" />
        <Select value={status} onChange={(e) => set('status', e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
      </Card>

      {data && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Card className="p-3"><div className="text-xs text-gray-500">POs</div><div className="text-lg font-semibold">{data.totals.count}</div></Card>
          <Card className="p-3"><div className="text-xs text-gray-500">Value (taxable)</div><div className="text-lg font-semibold num">{formatINR(data.totals.taxable, { decimals: false })}</div></Card>
          <Card className="p-3"><div className="text-xs text-gray-500">Billed (taxable)</div><div className="text-lg font-semibold num">{formatINR(data.totals.billedTaxable, { decimals: false })}</div></Card>
          <Card className="p-3"><div className="text-xs text-gray-500">Paid</div><div className="text-lg font-semibold num">{formatINR(data.totals.paidTotal, { decimals: false })}</div></Card>
        </div>
      )}

      {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
      {data && data.rows.length === 0 && <Card className="p-4 text-sm text-gray-500">No purchase orders{status || q ? ' match these filters' : ' yet'}.</Card>}
      {data && data.rows.length > 0 && (
        <Card className="divide-y divide-gray-100">
          {data.rows.map((p) => (
            <Link key={p.id} to={`/purchase-orders/${p.id}`} className="block px-3 sm:px-4 py-3 hover:bg-gray-50/70">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <div className="min-w-0">
                  <div className="font-medium text-gray-900 truncate">
                    {p.poNumber ?? 'Draft'}{p.revisionNo > 0 && <span className="text-gray-500"> R{p.revisionNo}</span>} · {p.vendorName}
                  </div>
                  <div className="text-xs text-gray-500">{dateLabel(p.poDate)}{p.vendorGstin ? ` · ${p.vendorGstin}` : ''}</div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <div className="num font-medium">{formatINR(p.total)}</div>
                    {!['draft', 'cancelled'].includes(p.status) && <div className="text-xs text-gray-500 num">to bill {formatINR(p.balanceToBill, { decimals: false })}</div>}
                  </div>
                  <Chip tone={PO_STATUS_TONE[p.status]}>{p.statusLabel}</Chip>
                </div>
              </div>
            </Link>
          ))}
        </Card>
      )}
    </div>
  );
}
