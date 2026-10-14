import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../../api';
import { Button, Card, Chip, ErrorNote, Facts, Field, Modal, MoneyInput, PageHeader, Select, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { formatINR } from '../../lib/money';
import { apiErrorMessage } from '../../lib/utils';
import { dateLabel, useSettings, type PaymentTerm, type TdsSection } from '../settings/api';
import { CHANNELS, CUSTOMER_KEYS, type Customer, type OwnProfile, type Outlet, type PriceListRow } from './api';

type Form = { paymentTermId: string; creditLimit: string; invoiceEmails: string; deductsTds: '' | 'yes' | 'no'; tdsSectionId: string; priceListId: string; channel: string; billToBranchId: string; notes: string };
const toForm = (p: OwnProfile | null): Form => ({
  paymentTermId: p?.paymentTermId ?? '', creditLimit: p?.creditLimit ?? '', invoiceEmails: (p?.invoiceEmails ?? []).join(', '),
  deductsTds: p?.deductsTds === null || p?.deductsTds === undefined ? '' : p.deductsTds ? 'yes' : 'no', tdsSectionId: p?.tdsSectionId ?? '',
  priceListId: p?.priceListId ?? '', channel: p?.channel ?? '', billToBranchId: p?.billToBranchId ?? '', notes: p?.notes ?? '',
});

/** F081: the company's fields, or one outlet's overrides (empty = same as the company). */
function ProfileModal({ customer, outlet, onClose }: { customer: Customer; outlet: Outlet | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: terms } = useSettings<PaymentTerm[]>('payment-terms');
  const { data: sections } = useSettings<TdsSection[]>('tds-sections');
  const { data: lists } = useQuery({ queryKey: ['price-lists'], queryFn: async () => (await api.get<{ data: PriceListRow[] }>('/price-lists')).data.data });
  const [f, setF] = useState<Form>(toForm(outlet ? outlet.own : customer.own));
  const inherit = outlet ? 'Same as the company' : 'Default';
  const save = useMutation({
    mutationFn: async () => {
      const body = {
        paymentTermId: f.paymentTermId || null, creditLimit: f.creditLimit || null, invoiceEmails: f.invoiceEmails.split(/[,\s]+/).filter(Boolean),
        deductsTds: f.deductsTds === '' ? null : f.deductsTds === 'yes', tdsSectionId: f.tdsSectionId || null, priceListId: f.priceListId || null,
        channel: f.channel || null, billToBranchId: f.billToBranchId || null, notes: f.notes || null,
      };
      const path = outlet ? `/customers/${customer.id}/outlets/${outlet.id}/profile` : `/customers/${customer.id}/profile`;
      return (await api.put<{ data: Customer }>(path, body)).data.data;
    },
    onSuccess: (d) => { qc.setQueryData(['customer', customer.id], d); for (const k of CUSTOMER_KEYS) qc.invalidateQueries({ queryKey: [k] }); onClose(); },
  });
  return (
    <Modal title={outlet ? `Finance fields: ${outlet.name}` : `Finance fields: ${customer.name}`} onClose={onClose} footer={<>
      <Button variant="secondary" onClick={onClose}>Back</Button>
      <Button disabled={save.isPending} onClick={() => save.mutate()}>Save</Button>
    </>}>
      {outlet && <p className="text-sm text-gray-600">Leave a field empty to use the company's.</p>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Payment terms">
          <Select value={f.paymentTermId} onChange={(e) => setF({ ...f, paymentTermId: e.target.value })}>
            <option value="">{outlet ? inherit : 'Default (On delivery)'}</option>
            {terms?.filter((t) => t.isActive).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </Select>
        </Field>
        {!outlet && <Field label="Credit limit (₹)" hint="Empty: no limit"><MoneyInput value={f.creditLimit} onChange={(e) => setF({ ...f, creditLimit: e.target.value })} /></Field>}
        <Field label="Price list">
          <Select value={f.priceListId} onChange={(e) => setF({ ...f, priceListId: e.target.value })}>
            <option value="">{outlet ? inherit : 'None (bloc-inv price)'}</option>
            {lists?.filter((l) => l.isActive).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        </Field>
        <Field label="Channel">
          <Select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>
            <option value="">{outlet ? inherit : 'Default (HoReCa)'}</option>
            {CHANNELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </Field>
        <Field label="Deducts TDS on our invoices?">
          <Select value={f.deductsTds} onChange={(e) => setF({ ...f, deductsTds: e.target.value as Form['deductsTds'] })}>
            <option value="">{outlet ? inherit : 'Default (No)'}</option><option value="no">No</option><option value="yes">Yes</option>
          </Select>
        </Field>
        {f.deductsTds === 'yes' && (
          <Field label="Under section">
            <Select value={f.tdsSectionId} onChange={(e) => setF({ ...f, tdsSectionId: e.target.value })}>
              <option value="">Choose</option>
              {sections?.filter((s) => s.isActive).map((s) => <option key={s.id} value={s.id}>{s.codeOldAct} · {s.nature}</option>)}
            </Select>
          </Field>
        )}
        {outlet && (
          <Field label="Bill invoices to">
            <Select value={f.billToBranchId} onChange={(e) => setF({ ...f, billToBranchId: e.target.value })}>
              <option value="">This outlet</option>
              {customer.outlets.filter((o) => o.id !== outlet.id).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Invoice e-mails" hint="Comma separated" className="sm:col-span-2"><TextInput value={f.invoiceEmails} onChange={(e) => setF({ ...f, invoiceEmails: e.target.value })} /></Field>
        <Field label="Notes" className="sm:col-span-2"><TextInput value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      </div>
      <ErrorNote>{save.isError && apiErrorMessage(save.error, 'Could not save')}</ErrorNote>
    </Modal>
  );
}

// F082 customer overview (F081 fields, outlets, people, CRM orders).
export function CustomerPage() {
  const { id } = useParams();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('financeCustomers', 'edit');
  const [editing, setEditing] = useState<Outlet | 'company' | null>(null);
  const { data: c, isLoading } = useQuery({ queryKey: ['customer', id], queryFn: async () => (await api.get<{ data: Customer }>(`/customers/${id}`)).data.data });
  if (isLoading || !c) return <p className="text-sm text-gray-500">Loading…</p>;
  const p = c.profile;
  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <PageHeader title={c.name} subtitle={`${c.outlets.length} outlet${c.outlets.length === 1 ? '' : 's'} · from the CRM`} action={<Chip tone="gray">{p.channelLabel}</Chip>} />
      <Card className="p-4 sm:p-6 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold text-gray-900">Finance fields</h2>
          {canEdit && <Button variant="secondary" onClick={() => setEditing('company')}>Edit</Button>}
        </div>
        <Facts items={[
          { label: 'Payment terms', value: p.paymentTerms },
          { label: 'Credit limit', value: p.creditLimit ? formatINR(p.creditLimit) : 'None' },
          { label: 'Price list', value: p.priceList ?? 'None: bloc-inv price before tax' },
          { label: 'Deducts TDS', value: p.deductsTds ? `Yes${p.tdsSection ? `, ${p.tdsSection}` : ''}` : 'No' },
          { label: 'Invoice e-mails', value: p.invoiceEmails.join(', ') || null },
          { label: 'Outstanding', value: 'Comes with invoicing' },
        ]} />
      </Card>

      <Card className="p-4 sm:p-6 space-y-2">
        <h2 className="font-semibold text-gray-900">Outlets</h2>
        <ul className="divide-y divide-gray-100 text-sm">
          {c.outlets.map((o) => (
            <li key={o.id} className={`py-2.5 flex items-start justify-between gap-2 ${o.isActive ? '' : 'opacity-50'}`}>
              <span className="min-w-0">
                <span className="block font-medium text-gray-900">{o.name}{!o.isActive && ' (inactive)'}</span>
                <span className="block text-xs text-gray-500">{o.address || 'No address in the CRM'}{o.stateName ? ` · ${o.stateName} (${o.stateCode})` : o.state ? ` · ${o.state} (state not recognised)` : ''}</span>
                <span className="block text-xs text-gray-500">
                  {o.gstin ? `GSTIN ${o.gstin}` : 'No GSTIN: invoices go out as B2C; ask sales to capture it in the CRM'}
                  {o.gstinProblem && <span className="text-red-700"> · {o.gstinProblem}</span>}
                  {o.hasOwnProfile && ` · ${o.profile.paymentTerms}${o.profile.billToBranchId ? `, billed to ${c.outlets.find((x) => x.id === o.profile.billToBranchId)?.name ?? 'another outlet'}` : ''}`}
                </span>
              </span>
              <span className="flex flex-col items-end gap-1 shrink-0">
                <Chip tone={o.invoiceType === 'B2B' ? 'blue' : 'gray'}>{o.invoiceType}</Chip>
                {canEdit && <button className="text-xs text-blue-700 hover:underline" onClick={() => setEditing(o)}>Edit</button>}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      {c.contacts.length > 0 && (
        <Card className="p-4 sm:p-6 space-y-2">
          <h2 className="font-semibold text-gray-900">People</h2>
          <ul className="divide-y divide-gray-100 text-sm">
            {c.contacts.map((x) => <li key={x.id} className="py-2">{x.name ?? '—'}{x.role ? ` (${x.role.toLowerCase()})` : ''} · {x.phone}{x.email ? ` · ${x.email}` : ''}</li>)}
          </ul>
        </Card>
      )}

      <Card className="p-4 sm:p-6 space-y-2">
        <h2 className="font-semibold text-gray-900">Orders in the last 12 months</h2>
        {c.orders.length === 0 && <p className="text-sm text-gray-500">None.</p>}
        <ul className="divide-y divide-gray-100 text-sm">
          {c.orders.map((o) => (
            <li key={o.orderNumber} className="py-2 flex justify-between gap-2">
              <Link to={`/order-to-bank/orders/${encodeURIComponent(o.orderNumber)}`} className="text-blue-700 hover:underline min-w-0 truncate">{o.orderNumber} · {dateLabel(o.orderDate)} · {o.status}</Link>
              <span className="num">{formatINR(o.totalAmount)}</span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-gray-500">Proformas, invoices, receipts and the customer statement are added with invoicing and receivables.</p>
      </Card>

      {editing && <ProfileModal customer={c} outlet={editing === 'company' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
