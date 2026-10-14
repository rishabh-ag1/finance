import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Plus } from 'lucide-react';
import api from '../../api';
import { Button, Card, Chip, ErrorNote, Field, Modal, PageHeader, Select, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { formatINR } from '../../lib/money';
import { apiErrorMessage, cn } from '../../lib/utils';
import { CUSTOMER_KEYS, KINDS, type PriceListDetail, type PriceListRow, type ProductRow } from './api';

const TABS = [['products', 'Products'], ['lists', 'Price lists']] as const;

// F120 products from bloc-inv.
function ProductsTab() {
  const [q, setQ] = useState('');
  const { data } = useQuery({ queryKey: ['products'], queryFn: async () => (await api.get<{ data: { priceLists: { id: string; name: string; taxInclusive: boolean }[]; rows: ProductRow[] } }>('/products')).data.data });
  if (!data) return <p className="text-sm text-gray-500">Loading…</p>;
  const rows = data.rows.filter((p) => !q || `${p.name} ${p.sku} ${p.hsn ?? ''} ${p.aliases.join(' ')}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="space-y-3">
      <Card className="p-3 sm:p-4"><TextInput placeholder="Search name, SKU, HSN or 'also sold as' code" value={q} onChange={(e) => setQ(e.target.value)} /></Card>
      <p className="text-xs text-gray-500">Products, HSN, GST rate, price and unit cost are kept in bloc-inv; change them there. Prices per price list are set on the Price lists tab.</p>
      {rows.length === 0 && <Card className="p-4 text-sm text-gray-500">{data.rows.length ? 'No product matches.' : 'No products yet (or Finance is not connected to bloc-inv yet).'}</Card>}
      {!!rows.length && (
        <Card className="divide-y divide-gray-100">
          {rows.map((p) => (
            <div key={p.id} className={cn('px-3 sm:px-4 py-3', !p.isActive && 'opacity-50')}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-gray-900 truncate">{p.name}{!p.isActive && ' (inactive)'}</div>
                  <div className="text-xs text-gray-500 truncate">{p.sku} · HSN {p.hsn ?? '—'} · GST {Number(p.gstRate)}%{p.unitCost ? ` · cost ${formatINR(p.unitCost)}` : ''}{p.aliases.length ? ` · also ${p.aliases.join(', ')}` : ''}</div>
                  {data.priceLists.length > 0 && (
                    <div className="text-xs text-gray-600 mt-0.5">{data.priceLists.map((l) => `${l.name}: ${p.prices[l.id] ? formatINR(p.prices[l.id]) : '—'}`).join(' · ')}</div>
                  )}
                  {p.problems.map((x) => <div key={x} className="flex items-center gap-1 text-xs text-amber-800 mt-0.5"><AlertTriangle className="w-3.5 h-3.5 shrink-0" />{x}</div>)}
                </div>
                <div className="text-right shrink-0">
                  <div className="num font-medium">{formatINR(p.priceExclTax)}</div>
                  <div className="text-[11px] text-gray-500">before GST</div>
                </div>
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

function NewListModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: '', kind: 'horeca', taxInclusive: false });
  const save = useMutation({
    mutationFn: async () => (await api.post<{ data: PriceListDetail }>('/price-lists', f)).data.data,
    onSuccess: () => { for (const k of CUSTOMER_KEYS) qc.invalidateQueries({ queryKey: [k] }); onClose(); },
  });
  return (
    <Modal title="New price list" onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>Back</Button><Button disabled={f.name.trim().length < 2 || save.isPending} onClick={() => save.mutate()}>Create</Button></>}>
      <Field label="Name"><TextInput autoFocus placeholder="HoReCa 2026" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Kind"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
      <Field label="Prices are">
        <Select value={f.taxInclusive ? 'incl' : 'excl'} onChange={(e) => setF({ ...f, taxInclusive: e.target.value === 'incl' })}>
          <option value="excl">Before GST</option><option value="incl">Including GST (MRP style)</option>
        </Select>
      </Field>
      <ErrorNote>{save.isError && apiErrorMessage(save.error, 'Could not create it')}</ErrorNote>
    </Modal>
  );
}

// F121 price lists.
function ListsTab() {
  const { hasPermission } = useAuth();
  const [adding, setAdding] = useState(false);
  const { data } = useQuery({ queryKey: ['price-lists'], queryFn: async () => (await api.get<{ data: PriceListRow[] }>('/price-lists')).data.data });
  return (
    <div className="space-y-3">
      {hasPermission('financeCustomers', 'edit') && <div className="text-right"><Button onClick={() => setAdding(true)}><Plus className="w-4 h-4 inline mr-1" />New price list</Button></div>}
      {data?.length === 0 && <Card className="p-4 text-sm text-gray-500">No price lists yet. Without one, invoice lines start from bloc-inv's price before GST.</Card>}
      {!!data?.length && (
        <Card className="divide-y divide-gray-100">
          {data.map((l) => (
            <Link key={l.id} to={`/products/price-lists/${l.id}`} className={cn('block px-3 sm:px-4 py-3 hover:bg-gray-50/70', !l.isActive && 'opacity-50')}>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-gray-900 truncate">{l.name}{!l.isActive && ' (archived)'}</div>
                  <div className="text-xs text-gray-500">{l.kindLabel} · {l.taxInclusive ? 'including GST' : 'before GST'} · {l.items ?? 0} price{l.items === 1 ? '' : 's'} · {l.customers} customer{l.customers === 1 ? '' : 's'}</div>
                </div>
                <Chip tone="gray">{l.kindLabel}</Chip>
              </div>
            </Link>
          ))}
        </Card>
      )}
      {adding && <NewListModal onClose={() => setAdding(false)} />}
    </div>
  );
}

// M11 Products & price lists.
export function ProductsPage() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.find(([k]) => k === params.get('tab'))?.[0] ?? 'products';
  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <PageHeader title="Products & prices" subtitle="Products from bloc-inv; the price each kind of customer pays." />
      <nav className="flex gap-1 border-b border-gray-200">
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setParams({ tab: k })} className={cn('px-3 py-2 text-sm border-b-2 -mb-px', tab === k ? 'border-[#0c2c55] text-[#0c2c55] font-medium' : 'border-transparent text-gray-500 hover:text-gray-800')}>{label}</button>
        ))}
      </nav>
      {tab === 'products' ? <ProductsTab /> : <ListsTab />}
    </div>
  );
}
