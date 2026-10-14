import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import api from '../../api';
import { Button, Card, ErrorNote, Field, MoneyInput, PageHeader, Select, TextInput } from '../../components/ui/kit';
import { GST_STATE_LIST, stateLabel } from '../../lib/gstStates';
import { formatINR } from '../../lib/money';
import { apiErrorMessage } from '../../lib/utils';
import type { Customer, CustomerRow, ProductRow } from '../customers/api';
import { dateLabel, useSettings, type PaymentTerm } from '../settings/api';
import { SALES_KEYS, useSalesDoc, type Preview, type SalesDoc, type SalesDocType } from './api';

type Line = { invProductId: string; description: string; hsnSac: string; qty: string; unit: string; rate: string; discountPct: string; gstRate: string; sourceLineId: string; priceSource: string };
type Form = {
  docType: 'proforma' | 'tax_invoice'; docDate: string; kind: 'outlet' | 'one_off'; companyId: string; branchId: string; shipToBranchId: string;
  name: string; address: string; state: string; gstin: string; phone: string; email: string;
  customerPoNo: string; customerPoDate: string; validUntil: string; paymentTermId: string; salesPerson: string; notes: string; lines: Line[];
};

const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const emptyLine = (): Line => ({ invProductId: '', description: '', hsnSac: '', qty: '1', unit: 'Nos', rate: '', discountPct: '', gstRate: '18', sourceLineId: '', priceSource: '' });
const blank = (docType: Form['docType']): Form => ({
  docType, docDate: today(), kind: 'outlet', companyId: '', branchId: '', shipToBranchId: '', name: '', address: '', state: '', gstin: '', phone: '', email: '',
  customerPoNo: '', customerPoDate: '', validUntil: '', paymentTermId: '', salesPerson: '', notes: '', lines: [emptyLine()],
});
const n = (v: string) => (v.trim() ? v.trim() : null);

function fromDoc(d: SalesDoc): Form {
  return {
    docType: d.docType as Form['docType'], docDate: d.docDate, kind: d.customerKind === 'outlet' ? 'outlet' : 'one_off', companyId: d.crmCompanyId ?? '', branchId: d.crmBranchId ?? '',
    shipToBranchId: d.shipToBranchId && d.shipToBranchId !== d.crmBranchId ? d.shipToBranchId : '',
    name: d.billTo.name, address: d.billTo.address, state: d.billTo.stateCode ?? '', gstin: d.billTo.gstin ?? '', phone: d.billTo.phone ?? '', email: d.billTo.email ?? '',
    customerPoNo: d.customerPoNo ?? '', customerPoDate: d.customerPoDate ?? '', validUntil: d.validUntil ?? '', paymentTermId: d.paymentTermId ?? '', salesPerson: d.salesPerson ?? '', notes: d.notes ?? '',
    lines: d.lines.map((l) => ({ invProductId: l.invProductId ?? '', description: l.description, hsnSac: l.hsnSac ?? '', qty: l.qty, unit: l.unit, rate: l.rate ?? '', discountPct: l.discountPct === '0' ? '' : l.discountPct, gstRate: String(Number(l.gstRate)), sourceLineId: l.sourceLineId ?? '', priceSource: l.priceSource ?? '' })),
  };
}

function body(f: Form) {
  return {
    docType: f.docType, docDate: f.docDate,
    customer: f.kind === 'outlet'
      ? { kind: 'outlet', companyId: f.companyId, branchId: f.branchId, shipToBranchId: n(f.shipToBranchId) }
      : { kind: 'one_off', name: f.name, address: f.address, state: f.state, gstin: n(f.gstin), phone: n(f.phone), email: n(f.email) },
    customerPoNo: n(f.customerPoNo), customerPoDate: n(f.customerPoDate), validUntil: f.docType === 'proforma' ? n(f.validUntil) : null, paymentTermId: n(f.paymentTermId),
    salesPerson: n(f.salesPerson), notes: n(f.notes),
    lines: f.lines.map((l) => ({ invProductId: n(l.invProductId), description: n(l.description), hsnSac: n(l.hsnSac), qty: l.qty, unit: n(l.unit), rate: n(l.rate), discountPct: n(l.discountPct), gstRate: n(l.gstRate), sourceLineId: n(l.sourceLineId), priceSource: n(l.priceSource) })),
  };
}

function useDebounced<T>(value: T, ms = 400): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

// F090 / F093 proforma and tax invoice entry (also edits a draft).
export function SalesFormPage({ mode }: { mode: 'new' | 'edit' }) {
  const { id } = useParams();
  const [params] = useSearchParams();
  const { data: existing } = useSalesDoc(mode === 'edit' ? id : undefined);
  if (mode === 'edit') return existing ? <SalesForm key={existing.id} id={id} initial={fromDoc(existing)} /> : <p className="text-sm text-gray-500">Loading…</p>;
  const f = blank((params.get('type') as SalesDocType) === 'proforma' ? 'proforma' : 'tax_invoice');
  if (params.get('companyId')) Object.assign(f, { companyId: params.get('companyId') });
  return <SalesForm initial={f} />;
}

function SalesForm({ id, initial }: { id?: string; initial: Form }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [f, setF] = useState<Form>(initial);
  const { data: terms } = useSettings<PaymentTerm[]>('payment-terms');
  const { data: customers } = useQuery({ queryKey: ['customers', ''], queryFn: async () => (await api.get<{ data: CustomerRow[] }>('/customers')).data.data });
  const { data: customer } = useQuery({ enabled: !!f.companyId, queryKey: ['customer', f.companyId], queryFn: async () => (await api.get<{ data: Customer }>(`/customers/${f.companyId}`)).data.data });
  const { data: products } = useQuery({ queryKey: ['products'], queryFn: async () => (await api.get<{ data: { rows: ProductRow[] } }>('/products')).data.data.rows.filter((p) => p.isActive) });

  const customerReady = f.kind === 'outlet' ? !!f.companyId && !!f.branchId : !!f.name.trim() && !!f.address.trim() && !!f.state;
  const ready = customerReady && f.lines.length > 0 && f.lines.every((l) => l.qty.trim() && (l.invProductId || (l.description.trim() && l.rate.trim())));
  const debounced = useDebounced(JSON.stringify(body(f)));
  const previewQuery = useQuery({
    queryKey: ['sales-preview', debounced], enabled: ready, retry: false,
    queryFn: async () => (await api.post<{ data: Preview }>('/sales/preview', JSON.parse(debounced))).data.data,
  });
  const preview = ready ? previewQuery.data ?? null : null;

  const save = useMutation({
    mutationFn: async () => (id ? (await api.put<{ data: SalesDoc }>(`/sales/${id}`, body(f))).data.data : (await api.post<{ data: SalesDoc }>('/sales', body(f))).data.data),
    onSuccess: (d) => { for (const k of SALES_KEYS) qc.invalidateQueries({ queryKey: [k] }); qc.setQueryData(['sales-doc', d.id], d); navigate(`/sales/${d.id}`); },
  });
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF({ ...f, [k]: v });
  const setLine = (i: number, patch: Partial<Line>) => set('lines', f.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const isPi = f.docType === 'proforma';

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <PageHeader title={`${id ? 'Edit draft' : 'New'} ${isPi ? 'proforma invoice' : 'tax invoice'}`} subtitle="Saved as a draft without a number. The number is taken when you issue it." />

      <Card className="p-4 sm:p-6 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {!id && (
            <Field label="Document">
              <Select value={f.docType} onChange={(e) => set('docType', e.target.value as Form['docType'])}>
                <option value="tax_invoice">Tax invoice</option><option value="proforma">Proforma invoice</option>
              </Select>
            </Field>
          )}
          <Field label="Date"><TextInput type="date" max={today()} value={f.docDate} onChange={(e) => set('docDate', e.target.value)} /></Field>
          {isPi && <Field label="Valid until"><TextInput type="date" value={f.validUntil} onChange={(e) => set('validUntil', e.target.value)} /></Field>}
          <Field label="Customer is">
            <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Form['kind'] })}>
              <option value="outlet">A customer in the CRM</option><option value="one_off">Someone else (typed)</option>
            </Select>
          </Field>
        </div>

        {f.kind === 'outlet' ? (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Customer">
              <Select value={f.companyId} onChange={(e) => setF({ ...f, companyId: e.target.value, branchId: '', shipToBranchId: '' })}>
                <option value="">Choose</option>
                {customers?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label="Outlet">
              <Select value={f.branchId} disabled={!customer} onChange={(e) => set('branchId', e.target.value)}>
                <option value="">Choose</option>
                {customer?.outlets.filter((o) => o.isActive).map((o) => <option key={o.id} value={o.id}>{o.name} · {o.invoiceType}</option>)}
              </Select>
            </Field>
            <Field label="Ship to">
              <Select value={f.shipToBranchId} disabled={!customer} onChange={(e) => set('shipToBranchId', e.target.value)}>
                <option value="">Same outlet</option>
                {customer?.outlets.filter((o) => o.isActive && o.id !== f.branchId).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </Select>
            </Field>
            {customers?.length === 0 && <p className="text-sm text-amber-800 sm:col-span-3">No customers from the CRM yet. Use "Someone else (typed)" or add the customer in the CRM.</p>}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Name"><TextInput value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
            <Field label="Address" className="sm:col-span-2"><TextInput value={f.address} onChange={(e) => set('address', e.target.value)} /></Field>
            <Field label="State">
              <Select value={f.state} onChange={(e) => set('state', e.target.value)}>
                <option value="">Choose</option>
                {GST_STATE_LIST.map(([code, name]) => <option key={code} value={code}>{name} ({code})</option>)}
              </Select>
            </Field>
            <Field label="GSTIN" hint="Leave empty for an unregistered customer (B2C)"><TextInput value={f.gstin} onChange={(e) => set('gstin', e.target.value.toUpperCase())} /></Field>
            <Field label="Phone"><TextInput value={f.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <Field label="Their PO no"><TextInput value={f.customerPoNo} onChange={(e) => set('customerPoNo', e.target.value)} /></Field>
          <Field label="PO date"><TextInput type="date" value={f.customerPoDate} onChange={(e) => set('customerPoDate', e.target.value)} /></Field>
          <Field label="Payment terms">
            <Select value={f.paymentTermId} onChange={(e) => set('paymentTermId', e.target.value)}>
              <option value="">Customer's terms</option>
              {terms?.filter((t) => t.isActive).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </Select>
          </Field>
          <Field label="Sales person"><TextInput value={f.salesPerson} onChange={(e) => set('salesPerson', e.target.value)} /></Field>
        </div>
      </Card>

      <Card className="p-4 sm:p-6 space-y-3">
        <h2 className="font-semibold text-gray-900">Lines</h2>
        {f.lines.map((l, i) => {
          const p = preview?.lines[i];
          return (
            <div key={i} className="rounded-lg border border-gray-200 p-3 space-y-2">
              <div className="grid grid-cols-1 sm:grid-cols-6 gap-2">
                <Field label="Product" className="sm:col-span-3">
                  <Select value={l.invProductId} disabled={!!l.sourceLineId} onChange={(e) => setLine(i, { invProductId: e.target.value, description: '', hsnSac: '', rate: '', priceSource: '' })}>
                    <option value="">Typed line (no product)</option>
                    {products?.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.sku})</option>)}
                  </Select>
                </Field>
                <Field label="Qty"><TextInput inputMode="decimal" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} /></Field>
                <Field label="Rate before GST" hint={!l.rate && p ? `${formatINR(p.rate)} from ${p.priceSource}` : undefined}><MoneyInput value={l.rate} placeholder={l.invProductId ? 'Price list' : '0.00'} onChange={(e) => setLine(i, { rate: e.target.value, priceSource: '' })} /></Field>
                <Field label="Disc %"><TextInput inputMode="decimal" value={l.discountPct} onChange={(e) => setLine(i, { discountPct: e.target.value })} /></Field>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-6 gap-2">
                <Field label="Description" className="sm:col-span-3"><TextInput value={l.description} placeholder={l.invProductId ? 'Product name' : ''} onChange={(e) => setLine(i, { description: e.target.value })} /></Field>
                <Field label="HSN / SAC"><TextInput value={l.hsnSac} placeholder={l.invProductId ? 'From bloc-inv' : ''} onChange={(e) => setLine(i, { hsnSac: e.target.value })} /></Field>
                <Field label="Unit"><TextInput value={l.unit} onChange={(e) => setLine(i, { unit: e.target.value })} /></Field>
                <Field label="GST %"><TextInput inputMode="decimal" value={l.gstRate} onChange={(e) => setLine(i, { gstRate: e.target.value })} /></Field>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-600">{p ? `Taxable ${formatINR(p.taxable)} + GST ${formatINR(p.tax)} = ${formatINR(p.lineTotal)}` : ''}</span>
                {f.lines.length > 1 && !l.sourceLineId && <button type="button" className="text-gray-500 hover:text-red-700" onClick={() => set('lines', f.lines.filter((_, j) => j !== i))} aria-label="Remove line"><Trash2 className="w-4 h-4" /></button>}
              </div>
            </div>
          );
        })}
        {!f.lines.some((l) => l.sourceLineId) && <Button variant="secondary" onClick={() => set('lines', [...f.lines, emptyLine()])}><Plus className="w-4 h-4 inline mr-1" />Add line</Button>}
      </Card>

      {preview && (
        <Card className="p-4 sm:p-6 space-y-2">
          <div className="flex flex-wrap justify-between gap-2 text-sm">
            <span>{preview.supplyType.toUpperCase()} · place of supply {stateLabel(preview.placeOfSupply)} · {preview.gstMode === 'igst' ? 'IGST' : 'CGST + SGST'}{preview.dueDate && f.docType === 'tax_invoice' ? ` · due ${dateLabel(preview.dueDate)}` : ''}{preview.paymentTerms ? ` · ${preview.paymentTerms}` : ''}</span>
            <span className="font-semibold num">Total {formatINR(preview.totals.total)}</span>
          </div>
          <div className="text-xs text-gray-500">Taxable {formatINR(preview.totals.taxable)}{preview.gstMode === 'igst' ? ` · IGST ${formatINR(preview.totals.igst)}` : ` · CGST ${formatINR(preview.totals.cgst)} · SGST ${formatINR(preview.totals.sgst)}`}{preview.totals.roundOff !== '0.00' ? ` · round off ${preview.totals.roundOff}` : ''} · {preview.amountInWords}</div>
          {[...preview.warnings, ...preview.problems.map((x) => `To fix before issue: ${x}`)].map((w) => <p key={w} className="flex items-start gap-2 text-sm text-amber-900 bg-amber-50 rounded-lg px-3 py-2"><AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />{w}</p>)}
        </Card>
      )}
      <ErrorNote>{(previewQuery.isError && apiErrorMessage(previewQuery.error, 'Could not work out the totals')) || (save.isError && apiErrorMessage(save.error, 'Could not save'))}</ErrorNote>
      <Field label="Notes (not printed)"><TextInput value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={() => navigate(-1)}>Back</Button>
        <Button disabled={!ready || save.isPending} onClick={() => save.mutate()}>Save draft</Button>
      </div>
    </div>
  );
}
