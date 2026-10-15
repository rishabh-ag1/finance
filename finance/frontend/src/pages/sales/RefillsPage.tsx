import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../../api';
import { Button, Card, Chip, ErrorNote, Field, Modal, MoneyInput, PageHeader, Select, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { formatINR } from '../../lib/money';
import { apiErrorMessage } from '../../lib/utils';
import type { Customer, CustomerRow, ProductRow } from '../customers/api';
import { dateLabel } from '../settings/api';
import { SALES_KEYS, STATUS_TONE } from './api';

type Plan = {
  id: string; crmCompanyId: string; crmBranchId: string; companyName: string; outletName: string; invProductId: string; productName: string;
  qty: string; rate: string | null; everyMonths: number; nextDate: string; isActive: boolean; notes: string | null; due: boolean;
  lastDoc: { id: string; docNumber: string | null; status: string; docDate: string } | null;
};
type Form = { crmCompanyId: string; crmBranchId: string; invProductId: string; qty: string; rate: string; everyMonths: number; nextDate: string; isActive: boolean; notes: string };
const blank: Form = { crmCompanyId: '', crmBranchId: '', invProductId: '', qty: '', rate: '', everyMonths: 1, nextDate: '', isActive: true, notes: '' };

function PlanForm({ plan, onClose }: { plan: Plan | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<Form>(plan ? { ...plan, rate: plan.rate ?? '', notes: plan.notes ?? '' } : blank);
  const { data: customers } = useQuery({ queryKey: ['customers', ''], queryFn: async () => (await api.get<{ data: CustomerRow[] }>('/customers')).data.data });
  const { data: customer } = useQuery({ enabled: !!f.crmCompanyId, queryKey: ['customer', f.crmCompanyId], queryFn: async () => (await api.get<{ data: Customer }>(`/customers/${f.crmCompanyId}`)).data.data });
  const { data: products } = useQuery({ queryKey: ['products'], queryFn: async () => (await api.get<{ data: { rows: ProductRow[] } }>('/products')).data.data.rows.filter((p) => p.isActive) });
  const save = useMutation({
    mutationFn: async () => {
      const body = { ...f, rate: f.rate || null, notes: f.notes || null };
      return plan ? api.put(`/refills/${plan.id}`, body) : api.post('/refills', body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['refills'] }); onClose(); },
  });
  return (
    <Modal title={plan ? 'Change refill plan' : 'New refill plan'} onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button disabled={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Customer">
          <Select value={f.crmCompanyId} onChange={(e) => setF({ ...f, crmCompanyId: e.target.value, crmBranchId: '' })}>
            <option value="">Choose…</option>{customers?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Outlet">
          <Select value={f.crmBranchId} disabled={!customer} onChange={(e) => setF({ ...f, crmBranchId: e.target.value })}>
            <option value="">Choose…</option>{customer?.outlets.filter((o) => o.isActive).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </Select>
        </Field>
        <Field label="Product" className="sm:col-span-2">
          <Select value={f.invProductId} onChange={(e) => setF({ ...f, invProductId: e.target.value })}>
            <option value="">Choose…</option>{products?.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.sku}</option>)}
          </Select>
        </Field>
        <Field label="Quantity per refill"><TextInput inputMode="decimal" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></Field>
        <Field label="Rate before GST (₹)" hint="Empty: the outlet's price list"><MoneyInput value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} /></Field>
        <Field label="Every">
          <Select value={f.everyMonths} onChange={(e) => setF({ ...f, everyMonths: Number(e.target.value) })}>
            {[1, 2, 3, 6, 12].map((m) => <option key={m} value={m}>{m === 1 ? 'Month' : `${m} months`}</option>)}
          </Select>
        </Field>
        <Field label="Next refill"><TextInput type="date" value={f.nextDate} onChange={(e) => setF({ ...f, nextDate: e.target.value })} /></Field>
        <Field label="Notes" className="sm:col-span-2"><TextInput value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        {plan && <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Active (untick to pause the plan)</label>}
      </div>
      <ErrorNote>{save.isError && apiErrorMessage(save.error, 'Could not save')}</ErrorNote>
    </Modal>
  );
}

// F099 sachet refill plans: each due cycle drafts a tax invoice to check and issue.
export function RefillsPage() {
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('financeSales', 'edit');
  const [editing, setEditing] = useState<Plan | 'new' | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['refills'], queryFn: async () => (await api.get<{ data: Plan[] }>('/refills')).data.data });
  const draft = useMutation({
    mutationFn: async () => (await api.post<{ data: { made: { docId: string }[]; failed: { planId: string; error: string }[] } }>('/refills/draft-due')).data.data,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['refills'] }); for (const k of SALES_KEYS) qc.invalidateQueries({ queryKey: [k] }); },
  });
  const due = data?.filter((p) => p.due) ?? [];
  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <PageHeader
        title="Refill plans"
        subtitle={<><Link to="/sales" className="text-[#0c2c55] hover:underline">Invoices</Link> › sachet refills sold to outlets on a cycle</>}
        action={canEdit && <Button onClick={() => setEditing('new')}>New plan</Button>}
      />
      <Card className="p-4 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm text-gray-700">{due.length ? `${due.length} refill${due.length === 1 ? '' : 's'} due` : 'No refills due today.'}</div>
          {canEdit && due.length > 0 && <Button disabled={draft.isPending} onClick={() => draft.mutate()}>Draft due refills</Button>}
        </div>
        <p className="text-xs text-gray-500">Drafts are checked and issued from Invoices. The dispatch order for a refill is still made in the CRM.</p>
        {draft.data && <p className="text-sm text-gray-700">{draft.data.made.length} drafted{draft.data.failed.length ? `; not drafted: ${draft.data.failed.map((x) => x.error).join('; ')}` : ''}.</p>}
        <ErrorNote>{draft.isError && apiErrorMessage(draft.error, 'Could not draft')}</ErrorNote>
      </Card>
      {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
      {data?.length === 0 && <Card className="p-4 text-sm text-gray-500">No refill plans yet.</Card>}
      {!!data?.length && (
        <Card className="divide-y divide-gray-100">
          {data.map((p) => (
            <div key={p.id} className="px-3 sm:px-4 py-3 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-medium text-gray-900 truncate">{p.companyName}{p.outletName ? ` (${p.outletName})` : ''}</div>
                <div className="text-sm text-gray-600 truncate">{p.qty} × {p.productName} · {p.rate ? `${formatINR(p.rate)} each` : 'price list rate'} · every {p.everyMonths === 1 ? 'month' : `${p.everyMonths} months`}</div>
                <div className="text-xs text-gray-500">
                  Next {dateLabel(p.nextDate)}
                  {p.lastDoc && <> · last <Link to={`/sales/${p.lastDoc.id}`} className="text-[#0c2c55] hover:underline">{p.lastDoc.docNumber ?? 'draft'}</Link> {dateLabel(p.lastDoc.docDate)}</>}
                </div>
              </div>
              <div className="text-right shrink-0 space-y-1">
                <div>{!p.isActive ? <Chip>Paused</Chip> : p.due ? <Chip tone="amber">Due</Chip> : <Chip tone="green">Active</Chip>}</div>
                {p.lastDoc && <div><Chip tone={STATUS_TONE[p.lastDoc.status] ?? 'gray'}>{p.lastDoc.status}</Chip></div>}
                {canEdit && <Button variant="ghost" onClick={() => setEditing(p)}>Change</Button>}
              </div>
            </div>
          ))}
        </Card>
      )}
      {editing && <PlanForm plan={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
