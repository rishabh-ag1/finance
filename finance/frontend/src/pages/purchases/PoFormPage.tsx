import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import api from '../../api';
import { Button, Card, ErrorNote, Field, MoneyInput, PageHeader, Select, TextInput } from '../../components/ui/kit';
import { GST_STATES, stateLabel } from '../../lib/gstStates';
import { formatINR } from '../../lib/money';
import { apiErrorMessage } from '../../lib/utils';
import { useSettings, type GstRate, type PaymentTerm } from '../settings/api';
import type { VendorListRow } from '../vendors/types';
import { GST_MODE_LABEL, useDeliveryAddresses, usePo, usePurchaseItems, type Po, type PoPreview } from './api';

type Line = { purchaseItemId: string; description: string; hsnSac: string; qty: string; unit: string; rate: string; discount: string; gstRate: string };
type Form = {
  vendorId: string; poDate: string; expectedDeliveryDate: string; deliveryAddressId: string; deliveryAddress: string; placeOfSupplyState: string;
  quoteRef: string; paymentTermId: string; paymentTermsText: string; milestones: { label: string; percent: string }[]; termsText: string; notes: string;
  lines: Line[];
};

const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const emptyLine = (gstRate = '18'): Line => ({ purchaseItemId: '', description: '', hsnSac: '', qty: '1', unit: 'Nos', rate: '', discount: '', gstRate });

function fromPo(p: Po): Form {
  return {
    vendorId: p.vendorId, poDate: p.poDate, expectedDeliveryDate: p.expectedDeliveryDate ?? '', deliveryAddressId: p.deliveryAddressId ?? '',
    deliveryAddress: p.deliveryAddress, placeOfSupplyState: p.placeOfSupplyState, quoteRef: p.quoteRef ?? '', paymentTermId: p.paymentTermId ?? '',
    paymentTermsText: p.paymentTermsText ?? '', milestones: p.milestones, termsText: p.termsText ?? '', notes: p.notes ?? '',
    lines: p.lines.map((l) => ({
      purchaseItemId: l.purchaseItemId ?? '', description: l.description, hsnSac: l.hsnSac ?? '', qty: l.qty, unit: l.unit, rate: l.rate,
      discount: l.discount === '0.00' ? '' : l.discount, gstRate: String(Number(l.gstRate)),
    })),
  };
}

/** Body the API expects: empty strings become null, numbers stay text. */
function body(f: Form) {
  const n = (v: string) => (v.trim() ? v.trim() : null);
  return {
    vendorId: f.vendorId, poDate: f.poDate, expectedDeliveryDate: n(f.expectedDeliveryDate), deliveryAddressId: n(f.deliveryAddressId),
    deliveryAddress: f.deliveryAddressId ? null : n(f.deliveryAddress), placeOfSupplyState: f.deliveryAddressId ? null : n(f.placeOfSupplyState),
    quoteRef: n(f.quoteRef), paymentTermId: n(f.paymentTermId), paymentTermsText: n(f.paymentTermsText),
    milestones: f.milestones.filter((m) => m.label.trim() || m.percent.trim()), termsText: n(f.termsText), notes: n(f.notes),
    lines: f.lines.map((l) => ({ ...l, purchaseItemId: n(l.purchaseItemId), hsnSac: n(l.hsnSac), discount: l.discount.trim() || '0', qty: l.qty.trim(), rate: l.rate.trim() })),
  };
}

/** The value, once it has stopped changing for a moment. */
function useDebounced<T>(value: T, ms = 400): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// F041-F043 PO form. Also used to edit a draft and to amend an issued PO (F046, with a reason).
export function PoFormPage({ mode }: { mode: 'new' | 'edit' | 'amend' }) {
  const { id } = useParams();
  const { data: existing } = usePo(mode === 'new' ? undefined : id);
  const { data: addresses } = useDeliveryAddresses();
  if (mode !== 'new') return existing ? <PoForm key={existing.id} mode={mode} id={id} existing={existing} initial={fromPo(existing)} /> : <p className="text-sm text-gray-500">Loading…</p>;
  if (!addresses) return <p className="text-sm text-gray-500">Loading…</p>;
  const first = addresses.find((a) => a.isActive);
  return <PoForm mode="new" initial={{
    vendorId: '', poDate: today(), expectedDeliveryDate: '', deliveryAddressId: first?.id ?? '', deliveryAddress: '', placeOfSupplyState: '',
    quoteRef: '', paymentTermId: '', paymentTermsText: '', milestones: [], termsText: '', notes: '', lines: [emptyLine()],
  }} />;
}

function PoForm({ mode, id, existing, initial }: { mode: 'new' | 'edit' | 'amend'; id?: string; existing?: Po; initial: Form }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: addresses } = useDeliveryAddresses();
  const { data: items } = usePurchaseItems();
  const { data: terms } = useSettings<PaymentTerm[]>('payment-terms');
  const { data: gstRates } = useSettings<GstRate[]>('gst-rates');
  const { data: vendors } = useQuery({
    queryKey: ['vendors-for-po'],
    queryFn: async () => (await api.get<{ data: { vendors: VendorListRow[] } }>('/vendors')).data.data.vendors.filter((v) => v.status !== 'blocked' && !v.isArchived),
  });
  const rates = useMemo(() => [...new Set((gstRates ?? []).filter((r) => r.isCurrent).map((r) => String(Number(r.rate))))].sort((a, b) => Number(a) - Number(b)), [gstRates]);
  const [f, setF] = useState<Form>(initial);
  const [reason, setReason] = useState('');

  // Server-side preview of GST and totals, a moment after typing stops.
  const ready = !!f.vendorId && f.lines.every((l) => l.description.trim() && l.qty.trim() && l.rate.trim());
  const debounced = useDebounced(JSON.stringify(body(f)));
  const previewQuery = useQuery({
    queryKey: ['po-preview', debounced],
    enabled: ready,
    retry: false,
    queryFn: async () => (await api.post<{ data: PoPreview }>('/purchases/pos/preview', JSON.parse(debounced))).data.data,
  });
  const preview = ready ? previewQuery.data ?? null : null;
  const previewError = ready && previewQuery.isError ? apiErrorMessage(previewQuery.error, 'Could not work out the totals') : '';

  const save = useMutation({
    mutationFn: async () => {
      const b = body(f);
      if (mode === 'new') return (await api.post<{ data: Po }>('/purchases/pos', b)).data.data;
      if (mode === 'edit') return (await api.put<{ data: Po }>(`/purchases/pos/${id}`, b)).data.data;
      return (await api.post<{ data: Po }>(`/purchases/pos/${id}/amend`, { ...b, reason })).data.data;
    },
    onSuccess: (po) => {
      qc.invalidateQueries({ queryKey: ['pos'] });
      qc.setQueryData(['po', po.id], po);
      navigate(`/purchase-orders/${po.id}`);
    },
  });

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF({ ...f, [k]: v });
  const setLine = (i: number, patch: Partial<Line>) => set('lines', f.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const pickItem = (i: number, name: string) => {
    const item = items?.find((it) => it.name.toLowerCase() === name.trim().toLowerCase());
    if (!item) { setLine(i, { description: name, purchaseItemId: '' }); return; }
    setLine(i, {
      description: item.name, purchaseItemId: item.id, hsnSac: item.hsnSac ?? f.lines[i].hsnSac, unit: item.unit,
      gstRate: item.defaultGstRate ? String(Number(item.defaultGstRate)) : f.lines[i].gstRate, rate: f.lines[i].rate || item.lastRate || '',
    });
  };
  const title = mode === 'new' ? 'New purchase order' : mode === 'edit' ? 'Edit draft PO' : `Amend ${existing?.poNumber ?? 'PO'}`;

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <PageHeader title={title} subtitle={mode === 'amend' ? 'The PO keeps its number; the revision goes up and the old version is kept with your reason.' : 'Saved as a draft. The PO number is given when you issue it.'} />

      <Card className="p-4 sm:p-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Vendor" className="sm:col-span-2">
          <Select value={f.vendorId} disabled={mode === 'amend'} onChange={(e) => set('vendorId', e.target.value)}>
            <option value="">Choose a vendor</option>
            {vendors?.map((v) => <option key={v.id} value={v.id}>{v.displayName}{v.gstin ? ` · ${v.gstin}` : ''}{v.status !== 'active' ? ` (${v.status.replace('_', ' ')})` : ''}</option>)}
          </Select>
        </Field>
        <Field label="PO date"><TextInput type="date" value={f.poDate} onChange={(e) => set('poDate', e.target.value)} /></Field>
        <Field label="Expected delivery"><TextInput type="date" value={f.expectedDeliveryDate} onChange={(e) => set('expectedDeliveryDate', e.target.value)} /></Field>
        <Field label="Deliver to" className="sm:col-span-2" hint="The delivery state is the place of supply: it decides CGST + SGST or IGST.">
          <Select value={f.deliveryAddressId} onChange={(e) => set('deliveryAddressId', e.target.value)}>
            {addresses?.filter((a) => a.isActive).map((a) => <option key={a.id} value={a.id}>{a.label} · {stateLabel(a.stateCode)}</option>)}
            <option value="">Other address…</option>
          </Select>
        </Field>
        {!f.deliveryAddressId && (
          <>
            <Field label="Delivery address" className="sm:col-span-2">
              <textarea className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm" rows={2} value={f.deliveryAddress} onChange={(e) => set('deliveryAddress', e.target.value)} />
            </Field>
            <Field label="Delivery state">
              <Select value={f.placeOfSupplyState} onChange={(e) => set('placeOfSupplyState', e.target.value)}>
                <option value="">Choose</option>
                {Object.entries(GST_STATES).map(([c, n]) => <option key={c} value={c}>{n} ({c})</option>)}
              </Select>
            </Field>
          </>
        )}
        <Field label="Vendor's quote number"><TextInput value={f.quoteRef} onChange={(e) => set('quoteRef', e.target.value)} placeholder="e.g. Q-040" /></Field>
      </Card>

      <Card className="p-4 sm:p-6 space-y-3">
        <h2 className="font-semibold text-gray-900">Lines</h2>
        <datalist id="purchase-items">{items?.map((it) => <option key={it.id} value={it.name} />)}</datalist>
        {f.lines.map((l, i) => (
          <div key={i} className="grid grid-cols-2 sm:grid-cols-12 gap-2 items-end border-b border-gray-100 pb-3">
            <Field label={`Item ${i + 1}`} className="col-span-2 sm:col-span-5">
              <TextInput list="purchase-items" value={l.description} onChange={(e) => pickItem(i, e.target.value)} placeholder="From the catalogue or free text" />
            </Field>
            <Field label="HSN/SAC" className="sm:col-span-2"><TextInput value={l.hsnSac} onChange={(e) => setLine(i, { hsnSac: e.target.value })} /></Field>
            <Field label="Qty" className="sm:col-span-2"><TextInput inputMode="decimal" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} /></Field>
            <Field label="Unit" className="sm:col-span-3"><TextInput value={l.unit} onChange={(e) => setLine(i, { unit: e.target.value })} /></Field>
            <Field label="Rate (excl. GST)" className="sm:col-span-3"><MoneyInput value={l.rate} onChange={(e) => setLine(i, { rate: e.target.value })} /></Field>
            <Field label="Discount (₹)" className="sm:col-span-2"><MoneyInput value={l.discount} onChange={(e) => setLine(i, { discount: e.target.value })} /></Field>
            <Field label="GST %" className="sm:col-span-2">
              <Select value={l.gstRate} onChange={(e) => setLine(i, { gstRate: e.target.value })}>
                {rates.map((r) => <option key={r} value={r}>{r}%</option>)}
              </Select>
            </Field>
            <div className="sm:col-span-4 text-sm text-right num text-gray-700">
              {preview?.lines[i] ? <>Taxable {formatINR(preview.lines[i].taxable)} · GST {formatINR(preview.lines[i].tax)}<br /><b>{formatINR(preview.lines[i].lineTotal)}</b></> : '—'}
            </div>
            <div className="sm:col-span-1 text-right">
              {f.lines.length > 1 && <button type="button" aria-label={`Remove line ${i + 1}`} className="text-gray-400 hover:text-red-600 p-2" onClick={() => set('lines', f.lines.filter((_, j) => j !== i))}><Trash2 className="w-4 h-4" /></button>}
            </div>
          </div>
        ))}
        <Button variant="secondary" onClick={() => set('lines', [...f.lines, emptyLine(f.lines[f.lines.length - 1]?.gstRate)])}><Plus className="w-4 h-4 inline -mt-0.5" /> Add line</Button>

        {preview && (
          <div className="border-t border-gray-100 pt-3 text-sm space-y-1 sm:w-1/2 sm:ml-auto">
            <div className="text-xs text-gray-500">{GST_MODE_LABEL[preview.gstMode]}</div>
            <div className="flex justify-between"><span>Taxable value</span><span className="num">{formatINR(preview.taxable)}</span></div>
            {preview.gstMode === 'cgst_sgst' && <>
              <div className="flex justify-between"><span>CGST</span><span className="num">{formatINR(preview.cgst)}</span></div>
              <div className="flex justify-between"><span>SGST</span><span className="num">{formatINR(preview.sgst)}</span></div>
            </>}
            {preview.gstMode === 'igst' && <div className="flex justify-between"><span>IGST</span><span className="num">{formatINR(preview.igst)}</span></div>}
            {preview.roundOff !== '0.00' && <div className="flex justify-between"><span>Round off</span><span className="num">{formatINR(preview.roundOff)}</span></div>}
            <div className="flex justify-between font-semibold border-t border-gray-200 pt-1"><span>Total</span><span className="num">{formatINR(preview.total)}</span></div>
            <div className="text-xs text-gray-500">{preview.amountInWords}</div>
            {preview.warnings.map((w) => <p key={w} className="text-xs text-amber-800 bg-amber-50 rounded px-2 py-1">{w}</p>)}
          </div>
        )}
        {previewError && <ErrorNote>{previewError}</ErrorNote>}
      </Card>

      <Card className="p-4 sm:p-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Payment term">
          <Select value={f.paymentTermId} onChange={(e) => set('paymentTermId', e.target.value)}>
            <option value="">None</option>
            {terms?.filter((t) => t.isActive).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </Select>
        </Field>
        <Field label="Payment terms note"><TextInput value={f.paymentTermsText} onChange={(e) => set('paymentTermsText', e.target.value)} placeholder="e.g. balance within 7 days of delivery" /></Field>
        <div className="sm:col-span-2 space-y-2">
          <div className="text-sm text-gray-700">Payment milestones <span className="text-gray-400">(optional; must add up to 100%)</span></div>
          {f.milestones.map((m, i) => (
            <div key={i} className="flex gap-2">
              <TextInput className="w-24" inputMode="decimal" placeholder="%" value={m.percent} onChange={(e) => set('milestones', f.milestones.map((x, j) => (j === i ? { ...x, percent: e.target.value } : x)))} />
              <TextInput placeholder="advance / on delivery / on T1 approval" value={m.label} onChange={(e) => set('milestones', f.milestones.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
              <button type="button" aria-label="Remove milestone" className="text-gray-400 hover:text-red-600 px-1" onClick={() => set('milestones', f.milestones.filter((_, j) => j !== i))}><Trash2 className="w-4 h-4" /></button>
            </div>
          ))}
          <Button variant="ghost" onClick={() => set('milestones', [...f.milestones, { label: '', percent: '' }])}>+ Add milestone</Button>
        </div>
        <Field label="Terms and conditions (printed)" className="sm:col-span-2">
          <textarea className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm" rows={3} value={f.termsText} onChange={(e) => set('termsText', e.target.value)} />
        </Field>
        <Field label="Internal note (not printed)" className="sm:col-span-2"><TextInput value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
        {mode === 'amend' && (
          <Field label="What changed and why" className="sm:col-span-2"><TextInput value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. quantity raised to 2 sets after the vendor's revised quote" /></Field>
        )}
      </Card>

      <ErrorNote>{save.isError && apiErrorMessage(save.error, 'Could not save')}</ErrorNote>
      <div className="flex flex-wrap justify-end gap-2 pb-6">
        <Link to={id ? `/purchase-orders/${id}` : '/purchase-orders'} className="px-3.5 py-2 rounded-lg text-sm font-medium bg-white border border-gray-200 text-gray-800 hover:bg-gray-50">Cancel</Link>
        <Button disabled={save.isPending || !ready || (mode === 'amend' && reason.trim().length < 3)} onClick={() => save.mutate()}>
          {mode === 'amend' ? 'Save amendment and reprint' : 'Save draft'}
        </Button>
      </div>
    </div>
  );
}
