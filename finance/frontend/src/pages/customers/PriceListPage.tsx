import { useState } from 'react';
import { useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../../api';
import { Button, Card, Chip, ErrorNote, Field, Modal, MoneyInput, PageHeader, Select, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { formatINR } from '../../lib/money';
import { apiErrorMessage, cn } from '../../lib/utils';
import { dateLabel } from '../settings/api';
import { CUSTOMER_KEYS, type PriceListDetail, type ProductRow } from './api';

const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

// F121 one price list: prices by product and date; a new price ends the previous one.
export function PriceListPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('financeCustomers', 'edit');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [f, setF] = useState({ invProductId: '', price: '', minQty: '1', effectiveFrom: today() });
  const { data: l, isLoading } = useQuery({ queryKey: ['price-list', id], queryFn: async () => (await api.get<{ data: PriceListDetail }>(`/price-lists/${id}`)).data.data });
  const { data: products } = useQuery({ enabled: adding, queryKey: ['products'], queryFn: async () => (await api.get<{ data: { rows: ProductRow[] } }>('/products')).data.data });
  const done = (d: PriceListDetail) => { qc.setQueryData(['price-list', id], d); for (const k of CUSTOMER_KEYS) qc.invalidateQueries({ queryKey: [k] }); setAdding(false); setRemoving(null); setReason(''); };
  const add = useMutation({ mutationFn: async () => (await api.post<{ data: PriceListDetail }>(`/price-lists/${id}/prices`, { ...f, minQty: Number(f.minQty) || 1 })).data.data, onSuccess: done });
  const archive = useMutation({ mutationFn: async () => (await api.post<{ data: PriceListDetail }>(`/price-items/${removing}/archive`, { reason })).data.data, onSuccess: done });

  if (isLoading || !l) return <p className="text-sm text-gray-500">Loading…</p>;
  const shown = l.items.filter((i) => !i.isArchived);
  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <PageHeader title={l.name} subtitle={`${l.kindLabel} price list · prices ${l.taxInclusive ? 'include GST' : 'are before GST'}`}
        action={canEdit && l.isActive && <Button onClick={() => setAdding(true)}>Add a price</Button>} />
      <p className="text-sm text-gray-600">A price is never changed in place: add the new price from its date and the old one ends the day before. Invoices take the price in force on the invoice date for the quantity ordered.</p>
      {shown.length === 0 && <Card className="p-4 text-sm text-gray-500">No prices yet.</Card>}
      {shown.length > 0 && (
        <Card className="divide-y divide-gray-100">
          {shown.map((i) => (
            <div key={i.id} className={cn('px-3 sm:px-4 py-3 flex items-start justify-between gap-2', !i.current && !i.upcoming && 'opacity-60')}>
              <div className="min-w-0">
                <div className="font-medium text-gray-900 truncate">{i.productName}</div>
                <div className="text-xs text-gray-500">{i.sku}{i.minQty > 1 ? ` · from ${i.minQty} units` : ''} · {dateLabel(i.effectiveFrom)} to {i.effectiveTo ? dateLabel(i.effectiveTo) : 'open'}</div>
                {l.taxInclusive && i.rateBeforeGst && <div className="text-xs text-gray-500">Invoice rate before GST {formatINR(i.rateBeforeGst)}</div>}
              </div>
              <div className="text-right shrink-0 space-y-1">
                <div className="num font-medium">{formatINR(i.price)}</div>
                <Chip tone={i.current ? 'green' : i.upcoming ? 'blue' : 'gray'}>{i.current ? 'In force' : i.upcoming ? 'Upcoming' : 'Ended'}</Chip>
                {canEdit && <button className="block text-xs text-gray-500 hover:underline ml-auto" onClick={() => setRemoving(i.id)}>Remove (mistake)</button>}
              </div>
            </div>
          ))}
        </Card>
      )}

      {adding && (
        <Modal title="Add a price" onClose={() => setAdding(false)} footer={<><Button variant="secondary" onClick={() => setAdding(false)}>Back</Button><Button disabled={!f.invProductId || !f.price || add.isPending} onClick={() => add.mutate()}>Add</Button></>}>
          <Field label="Product">
            <Select value={f.invProductId} onChange={(e) => setF({ ...f, invProductId: e.target.value })}>
              <option value="">Choose</option>
              {products?.rows.filter((p) => p.isActive).map((p) => <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>)}
            </Select>
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label={`Price ${l.taxInclusive ? 'incl. GST' : 'before GST'} (₹)`}><MoneyInput value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></Field>
            <Field label="From quantity"><TextInput type="number" min={1} value={f.minQty} onChange={(e) => setF({ ...f, minQty: e.target.value })} /></Field>
            <Field label="From date"><TextInput type="date" value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} /></Field>
          </div>
          <ErrorNote>{add.isError && apiErrorMessage(add.error, 'Could not add it')}</ErrorNote>
        </Modal>
      )}
      {removing && (
        <Modal title="Remove a price entered by mistake" onClose={() => setRemoving(null)} footer={<><Button variant="secondary" onClick={() => setRemoving(null)}>Back</Button><Button variant="danger" disabled={reason.trim().length < 3 || archive.isPending} onClick={() => archive.mutate()}>Remove</Button></>}>
          <p className="text-sm text-gray-600">To change a real price, add the new price from its date instead.</p>
          <Field label="Reason"><TextInput autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <ErrorNote>{archive.isError && apiErrorMessage(archive.error, 'Could not remove it')}</ErrorNote>
        </Modal>
      )}
    </div>
  );
}
