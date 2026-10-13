import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import api from '../../api';
import { Button, Card, ErrorNote, Field, MoneyInput, PageHeader, Select, TextInput } from '../../components/ui/kit';
import { GST_STATE_LIST } from '../../lib/gstStates';
import { formatINR } from '../../lib/money';
import { apiErrorMessage } from '../../lib/utils';
import { CategoryFields } from '../bank/CategoryFields';
import { useCategories } from '../bank/ledgerApi';
import type { Po } from '../purchases/api';
import { GST_MODE_LABEL } from '../purchases/api';
import { useSettings, type GstRate, type PaymentTerm, type TdsSection } from '../settings/api';
import type { VendorListRow } from '../vendors/types';
import { DOC_TYPES, useBill, type Bill, type BillPreview, type DocType } from './api';

type Line = { poLineId: string; description: string; hsnSac: string; qty: string; unit: string; rate: string; discount: string; gstRate: string; typedGst: boolean; cgst: string; sgst: string; igst: string };
type Tds = { change: boolean; applicable: boolean; sectionId: string; rate: string; amount: string; overrideReason: string };
type Form = {
  docType: DocType; vendorId: string; docNumber: string; docDate: string; receivedDate: string; poId: string; replacesDocumentId: string;
  againstDocumentId: string; placeOfSupplyState: string; reverseCharge: boolean; lines: Line[]; otherCharges: string; roundOff: string;
  tds: Tds; categoryId: string; subCategoryId: string; paymentTermId: string; dueDate: string; itcEligible: boolean; notes: string;
};

const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const emptyLine = (gstRate = '18'): Line => ({ poLineId: '', description: '', hsnSac: '', qty: '1', unit: 'Nos', rate: '', discount: '', gstRate, typedGst: false, cgst: '', sgst: '', igst: '' });
const noTds: Tds = { change: false, applicable: false, sectionId: '', rate: '', amount: '', overrideReason: '' };
const blank = (): Form => ({
  docType: 'tax_invoice', vendorId: '', docNumber: '', docDate: today(), receivedDate: '', poId: '', replacesDocumentId: '', againstDocumentId: '',
  placeOfSupplyState: '', reverseCharge: false, lines: [emptyLine()], otherCharges: '', roundOff: '', tds: noTds,
  categoryId: '', subCategoryId: '', paymentTermId: '', dueDate: '', itcEligible: true, notes: '',
});

function linesFrom(ls: { poLineId?: string | null; id?: string; description: string; hsnSac: string | null; qty: string; unit: string; rate: string; discount: string; gstRate: string }[], fromPo: boolean): Line[] {
  return ls.map((l) => ({
    ...emptyLine(String(Number(l.gstRate))), poLineId: fromPo ? l.id ?? '' : l.poLineId ?? '', description: l.description, hsnSac: l.hsnSac ?? '',
    qty: l.qty, unit: l.unit, rate: l.rate, discount: l.discount === '0.00' ? '' : l.discount,
  }));
}

function fromBill(b: Bill): Form {
  const typed = !!b.taxMismatch;
  return {
    docType: b.docType, vendorId: b.vendorId, docNumber: b.docNumber, docDate: b.docDate, receivedDate: b.receivedDate ?? '', poId: b.poId ?? '',
    replacesDocumentId: b.replaces?.id ?? '', againstDocumentId: b.against?.id ?? '', placeOfSupplyState: b.placeOfSupplyState, reverseCharge: b.reverseCharge,
    lines: b.lines.map((l) => ({ ...linesFrom([l], false)[0], typedGst: typed, cgst: typed ? l.cgst : '', sgst: typed ? l.sgst : '', igst: typed ? l.igst : '' })),
    otherCharges: b.otherCharges === '0.00' ? '' : b.otherCharges, roundOff: b.roundOff,
    tds: b.tds.overrideReason || (b.tds.suggestion && b.tds.suggestion.applicable !== b.tds.applicable)
      ? { change: true, applicable: b.tds.applicable, sectionId: b.tds.sectionId ?? '', rate: b.tds.rate, amount: b.tds.amount, overrideReason: b.tds.overrideReason ?? '' }
      : { ...noTds, sectionId: b.tds.sectionId ?? '' },
    categoryId: b.categoryId ?? '', subCategoryId: b.subCategoryId ?? '', paymentTermId: b.paymentTermId ?? '', dueDate: b.dueDate ?? '',
    itcEligible: b.itcEligible, notes: b.notes ?? '',
  };
}

function body(f: Form) {
  const n = (v: string) => (v.trim() ? v.trim() : null);
  return {
    docType: f.docType, vendorId: f.vendorId, docNumber: f.docNumber, docDate: f.docDate, receivedDate: n(f.receivedDate), poId: n(f.poId),
    replacesDocumentId: n(f.replacesDocumentId), againstDocumentId: n(f.againstDocumentId), placeOfSupplyState: n(f.placeOfSupplyState),
    reverseCharge: f.reverseCharge, otherCharges: n(f.otherCharges), roundOff: n(f.roundOff),
    lines: f.lines.map((l) => ({
      poLineId: n(l.poLineId), description: l.description, hsnSac: n(l.hsnSac), qty: l.qty.trim(), unit: n(l.unit), rate: l.rate.trim(),
      discount: l.discount.trim() || '0', gstRate: l.gstRate, cgst: l.typedGst ? n(l.cgst) : null, sgst: l.typedGst ? n(l.sgst) : null, igst: l.typedGst ? n(l.igst) : null,
    })),
    tds: f.docType === 'tax_invoice' && f.tds.change
      ? { applicable: f.tds.applicable, sectionId: n(f.tds.sectionId), rate: n(f.tds.rate), amount: n(f.tds.amount), overrideReason: n(f.tds.overrideReason) }
      : null,
    categoryId: n(f.categoryId), subCategoryId: n(f.subCategoryId), paymentTermId: n(f.paymentTermId), dueDate: n(f.dueDate),
    itcEligible: f.itcEligible, notes: n(f.notes),
  };
}

function useDebounced<T>(value: T, ms = 400): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

// F051-F057 vendor document entry. Also used to edit, to enter the tax invoice for a proforma,
// and to enter a debit / credit note against an invoice.
export function BillFormPage({ mode }: { mode: 'new' | 'edit' }) {
  const { id } = useParams();
  const [params] = useSearchParams();
  const { data: existing } = useBill(mode === 'edit' ? id : undefined);
  const replaces = params.get('replaces') ?? undefined;
  const against = params.get('against') ?? undefined;
  const poId = params.get('poId') ?? undefined;
  const { data: source } = useBill(replaces ?? against);
  const { data: po } = useQuery({ enabled: !!poId, queryKey: ['po', poId], queryFn: async () => (await api.get<{ data: Po }>(`/purchases/pos/${poId}`)).data.data });

  if (mode === 'edit') return existing ? <BillForm key={existing.id} id={id} initial={fromBill(existing)} /> : <p className="text-sm text-gray-500">Loading…</p>;
  if ((replaces || against) && !source) return <p className="text-sm text-gray-500">Loading…</p>;
  if (poId && !po) return <p className="text-sm text-gray-500">Loading…</p>;

  const f = blank();
  if (source && replaces) Object.assign(f, { vendorId: source.vendorId, poId: source.poId ?? '', replacesDocumentId: source.id, placeOfSupplyState: source.placeOfSupplyState, lines: linesFrom(source.lines, false) });
  if (source && against) Object.assign(f, { docType: (params.get('type') as DocType) ?? 'credit_note', vendorId: source.vendorId, againstDocumentId: source.id, placeOfSupplyState: source.placeOfSupplyState });
  if (po) Object.assign(f, { vendorId: po.vendorId, poId: po.id, placeOfSupplyState: po.placeOfSupplyState, lines: linesFrom(po.lines, true) });
  if (params.get('vendorId')) f.vendorId = params.get('vendorId')!;
  return <BillForm initial={f} />;
}

function BillForm({ id, initial }: { id?: string; initial: Form }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [f, setF] = useState<Form>(initial);
  const { data: cats } = useCategories();
  const { data: terms } = useSettings<PaymentTerm[]>('payment-terms');
  const { data: gstRates } = useSettings<GstRate[]>('gst-rates');
  const { data: sections } = useSettings<TdsSection[]>('tds-sections');
  const { data: vendors } = useQuery({ queryKey: ['vendors-all'], queryFn: async () => (await api.get<{ data: { vendors: VendorListRow[] } }>('/vendors')).data.data.vendors.filter((v) => !v.isArchived) });
  const { data: pos } = useQuery({
    enabled: !!f.vendorId, queryKey: ['pos-for-bill', f.vendorId],
    queryFn: async () => (await api.get<{ data: { rows: { id: string; poNumber: string | null; status: string; balanceToBill: string }[] } }>('/purchases/pos', { params: { vendorId: f.vendorId } })).data.data.rows.filter((p) => p.poNumber && ['approved', 'sent', 'partially_billed'].includes(p.status) || p.id === f.poId),
    retry: false,
  });
  const { data: invoices } = useQuery({
    enabled: !!f.vendorId && ['credit_note', 'debit_note'].includes(f.docType), queryKey: ['invoices-for-note', f.vendorId],
    queryFn: async () => (await api.get<{ data: { rows: { id: string; docNumber: string; status: string; docType: string }[] } }>('/bills', { params: { vendorId: f.vendorId, docType: 'tax_invoice' } })).data.data.rows.filter((r) => r.status !== 'cancelled'),
  });
  const rates = useMemo(() => [...new Set((gstRates ?? []).filter((r) => r.isCurrent).map((r) => String(Number(r.rate))))].sort((a, b) => Number(a) - Number(b)), [gstRates]);

  const ready = !!f.vendorId && !!f.docNumber.trim() && f.lines.every((l) => l.description.trim() && l.qty.trim() && l.rate.trim());
  const debounced = useDebounced(JSON.stringify(body(f)));
  const previewQuery = useQuery({
    queryKey: ['bill-preview', id, debounced], enabled: ready, retry: false,
    queryFn: async () => (await api.post<{ data: BillPreview }>('/bills/preview', JSON.parse(debounced), { params: { id } })).data.data,
  });
  const preview = ready ? previewQuery.data ?? null : null;

  const save = useMutation({
    mutationFn: async () => (id ? (await api.put<{ data: Bill }>(`/bills/${id}`, body(f))).data.data : (await api.post<{ data: Bill }>('/bills', body(f))).data.data),
    onSuccess: (b) => { qc.invalidateQueries({ queryKey: ['bills'] }); qc.invalidateQueries({ queryKey: ['po'] }); qc.setQueryData(['bill', b.id], b); navigate(`/bills/${b.id}`); },
  });

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF({ ...f, [k]: v });
  const setLine = (i: number, patch: Partial<Line>) => set('lines', f.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const setTds = (patch: Partial<Tds>) => set('tds', { ...f.tds, ...patch });
  const isNote = ['credit_note', 'debit_note'].includes(f.docType);
  const sug = preview?.tdsSuggestion;
  const mode = preview?.gstMode;

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <PageHeader title={id ? 'Edit vendor document' : f.replacesDocumentId ? 'Enter the tax invoice' : 'Enter vendor document'}
        subtitle="Type it as printed on the vendor's document. GST, TDS and the due date are worked out for you to check." />

      <Card className="p-4 sm:p-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Type">
          <Select value={f.docType} disabled={!!id || !!f.replacesDocumentId} onChange={(e) => set('docType', e.target.value as DocType)}>
            {DOC_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </Field>
        <Field label="Vendor">
          <Select value={f.vendorId} disabled={!!f.replacesDocumentId || !!f.againstDocumentId} onChange={(e) => setF({ ...f, vendorId: e.target.value, poId: '' })}>
            <option value="">Choose a vendor</option>
            {vendors?.map((v) => <option key={v.id} value={v.id}>{v.displayName}{v.gstin ? ` · ${v.gstin}` : ''}</option>)}
          </Select>
        </Field>
        <Field label="Vendor's document number"><TextInput value={f.docNumber} onChange={(e) => set('docNumber', e.target.value)} placeholder="e.g. 040 or PI0037" /></Field>
        <Field label="Document date"><TextInput type="date" value={f.docDate} onChange={(e) => set('docDate', e.target.value)} /></Field>
        {!isNote && (
          <Field label="Purchase order" hint="Linking a PO fills its billed amount (BR-17).">
            <Select value={f.poId} onChange={(e) => set('poId', e.target.value)}>
              <option value="">No PO</option>
              {pos?.map((p) => <option key={p.id} value={p.id}>{p.poNumber} · to bill {formatINR(p.balanceToBill, { decimals: false })}</option>)}
            </Select>
          </Field>
        )}
        {isNote && (
          <Field label="Against invoice">
            <Select value={f.againstDocumentId} onChange={(e) => set('againstDocumentId', e.target.value)}>
              <option value="">Choose the invoice</option>
              {invoices?.map((d) => <option key={d.id} value={d.id}>{d.docNumber}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Received on"><TextInput type="date" value={f.receivedDate} onChange={(e) => set('receivedDate', e.target.value)} /></Field>
        <Field label="Place of supply" hint={mode ? GST_MODE_LABEL[mode] : 'Delivery state; decides CGST + SGST or IGST.'}>
          <Select value={f.placeOfSupplyState} onChange={(e) => set('placeOfSupplyState', e.target.value)}>
            <option value="">From the PO, else Karnataka (29)</option>
            {GST_STATE_LIST.map(([c, n]) => <option key={c} value={c}>{n} ({c})</option>)}
          </Select>
        </Field>
        <label className="flex items-center gap-2 text-sm self-end pb-2"><input type="checkbox" checked={f.reverseCharge} onChange={(e) => set('reverseCharge', e.target.checked)} /> Reverse charge</label>
      </Card>

      <Card className="p-4 sm:p-6 space-y-3">
        <h2 className="font-semibold text-gray-900">Lines</h2>
        {f.lines.map((l, i) => (
          <div key={i} className="grid grid-cols-2 sm:grid-cols-12 gap-2 items-end border-b border-gray-100 pb-3">
            <Field label={`Item ${i + 1}`} className="col-span-2 sm:col-span-5"><TextInput value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} /></Field>
            <Field label="HSN/SAC" className="sm:col-span-2"><TextInput value={l.hsnSac} onChange={(e) => setLine(i, { hsnSac: e.target.value })} /></Field>
            <Field label="Qty" className="sm:col-span-2"><TextInput inputMode="decimal" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} /></Field>
            <Field label="Unit" className="sm:col-span-3"><TextInput value={l.unit} onChange={(e) => setLine(i, { unit: e.target.value })} /></Field>
            <Field label="Rate (excl. GST)" className="sm:col-span-3"><MoneyInput value={l.rate} onChange={(e) => setLine(i, { rate: e.target.value })} /></Field>
            <Field label="Discount (₹)" className="sm:col-span-2"><MoneyInput value={l.discount} onChange={(e) => setLine(i, { discount: e.target.value })} /></Field>
            <Field label="GST %" className="sm:col-span-2">
              <Select value={l.gstRate} onChange={(e) => setLine(i, { gstRate: e.target.value })}>{rates.map((r) => <option key={r} value={r}>{r}%</option>)}</Select>
            </Field>
            <div className="sm:col-span-4 text-sm text-right num text-gray-700">
              {preview?.lines[i] ? <>Taxable {formatINR(preview.lines[i].taxable)} · GST {formatINR(preview.lines[i].tax)}<br /><b>{formatINR(preview.lines[i].lineTotal)}</b></> : '—'}
            </div>
            <div className="sm:col-span-1 text-right">
              {f.lines.length > 1 && <button type="button" aria-label={`Remove line ${i + 1}`} className="text-gray-400 hover:text-red-600 p-2" onClick={() => set('lines', f.lines.filter((_, j) => j !== i))}><Trash2 className="w-4 h-4" /></button>}
            </div>
            <label className="col-span-2 sm:col-span-12 flex items-center gap-2 text-xs text-gray-600">
              <input type="checkbox" checked={l.typedGst} onChange={(e) => setLine(i, { typedGst: e.target.checked })} /> GST on the document differs: type it as printed
            </label>
            {l.typedGst && (
              <div className="col-span-2 sm:col-span-12 grid grid-cols-3 gap-2">
                <Field label="CGST"><MoneyInput value={l.cgst} onChange={(e) => setLine(i, { cgst: e.target.value })} /></Field>
                <Field label="SGST"><MoneyInput value={l.sgst} onChange={(e) => setLine(i, { sgst: e.target.value })} /></Field>
                <Field label="IGST"><MoneyInput value={l.igst} onChange={(e) => setLine(i, { igst: e.target.value })} /></Field>
              </div>
            )}
          </div>
        ))}
        <Button variant="secondary" onClick={() => set('lines', [...f.lines, emptyLine(f.lines[f.lines.length - 1]?.gstRate)])}><Plus className="w-4 h-4 inline -mt-0.5" /> Add line</Button>

        <div className="grid grid-cols-2 gap-2 sm:w-1/2 sm:ml-auto">
          <Field label="Other charges (no GST)" hint="e.g. government fees"><MoneyInput value={f.otherCharges} onChange={(e) => set('otherCharges', e.target.value)} /></Field>
          <Field label="Round off" hint="As printed; empty = to the rupee"><MoneyInput value={f.roundOff} onChange={(e) => set('roundOff', e.target.value)} /></Field>
        </div>
        {preview && (
          <div className="border-t border-gray-100 pt-3 text-sm space-y-1 sm:w-1/2 sm:ml-auto">
            <div className="flex justify-between"><span>Taxable value</span><span className="num">{formatINR(preview.taxableValue)}</span></div>
            {preview.gstMode === 'cgst_sgst' && <><div className="flex justify-between"><span>CGST</span><span className="num">{formatINR(preview.cgst)}</span></div><div className="flex justify-between"><span>SGST</span><span className="num">{formatINR(preview.sgst)}</span></div></>}
            {preview.gstMode === 'igst' && <div className="flex justify-between"><span>IGST</span><span className="num">{formatINR(preview.igst)}</span></div>}
            {preview.otherCharges !== '0.00' && <div className="flex justify-between"><span>Other charges</span><span className="num">{formatINR(preview.otherCharges)}</span></div>}
            {preview.roundOff !== '0.00' && <div className="flex justify-between"><span>Round off</span><span className="num">{formatINR(preview.roundOff)}</span></div>}
            <div className="flex justify-between font-semibold border-t border-gray-200 pt-1"><span>Total</span><span className="num">{formatINR(preview.totalValue)}</span></div>
            {f.docType === 'tax_invoice' && <div className="flex justify-between"><span>TDS</span><span className="num">- {formatINR(preview.tds.amount)}</span></div>}
            {f.docType === 'tax_invoice' && <div className="flex justify-between font-semibold"><span>Net payable</span><span className="num">{formatINR(preview.netPayable)}</span></div>}
          </div>
        )}
        {preview?.warnings.map((w) => <p key={w} className="text-xs text-amber-800 bg-amber-50 rounded px-2 py-1">{w}</p>)}
        {ready && previewQuery.isError && <ErrorNote>{apiErrorMessage(previewQuery.error, 'Could not work out the totals')}</ErrorNote>}
      </Card>

      {f.docType === 'tax_invoice' && (
        <Card className="p-4 sm:p-6 space-y-3">
          <h2 className="font-semibold text-gray-900">TDS</h2>
          {sug && <p className="text-sm text-gray-700">{sug.applicable ? <>Suggested <b className="num">{formatINR(sug.amount)}</b> on {formatINR(sug.base)}: </> : <>No TDS suggested: </>}{sug.reason}</p>}
          <p className="text-xs text-gray-500">Rates and thresholds are the old-Act values until the CA confirms them (Q15).</p>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.tds.change} onChange={(e) => setTds({ change: e.target.checked, applicable: sug?.applicable ?? true, sectionId: f.tds.sectionId || sug?.sectionId || '', rate: sug?.rate ?? '', amount: '' })} /> Deduct differently from the suggestion</label>
          {f.tds.change && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={f.tds.applicable} onChange={(e) => setTds({ applicable: e.target.checked })} /> Deduct TDS on this bill</label>
              {f.tds.applicable && <>
                <Field label="Section" className="sm:col-span-2">
                  <Select value={f.tds.sectionId} onChange={(e) => setTds({ sectionId: e.target.value })}>
                    <option value="">Choose</option>
                    {sections?.filter((s) => s.isActive).map((s) => <option key={s.id} value={s.id}>{s.codeOldAct} {s.nature}</option>)}
                  </Select>
                </Field>
                <Field label="Rate %"><TextInput inputMode="decimal" value={f.tds.rate} onChange={(e) => setTds({ rate: e.target.value })} /></Field>
                <Field label="Amount (empty = base x rate)"><MoneyInput value={f.tds.amount} onChange={(e) => setTds({ amount: e.target.value })} /></Field>
              </>}
              <Field label="Reason for the change" className="sm:col-span-2"><TextInput value={f.tds.overrideReason} onChange={(e) => setTds({ overrideReason: e.target.value })} placeholder="e.g. vendor gave a lower deduction certificate" /></Field>
            </div>
          )}
        </Card>
      )}

      <Card className="p-4 sm:p-6 space-y-4">
        {cats && <CategoryFields compact hideNature cats={cats} value={{ categoryId: f.categoryId || preview?.categoryId || '', subCategoryId: f.subCategoryId || (f.categoryId ? '' : preview?.subCategoryId ?? ''), nature: '' }} onChange={(v) => setF({ ...f, categoryId: v.categoryId, subCategoryId: v.subCategoryId })} />}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Payment term" hint="Empty = the vendor's default">
            <Select value={f.paymentTermId} onChange={(e) => set('paymentTermId', e.target.value)}>
              <option value="">Vendor's default</option>
              {terms?.filter((t) => t.isActive).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </Select>
          </Field>
          <Field label="Due date" hint={preview?.dueDate ? `Worked out: ${preview.dueDate}` : 'Document date + term (BR-23)'}>
            <TextInput type="date" value={f.dueDate} onChange={(e) => set('dueDate', e.target.value)} />
          </Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.itcEligible} onChange={(e) => set('itcEligible', e.target.checked)} /> GST input credit can be claimed (for the CA)</label>
          <Field label="Note" className="sm:col-span-2"><TextInput value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
        </div>
      </Card>

      <ErrorNote>{save.isError && apiErrorMessage(save.error, 'Could not save')}</ErrorNote>
      <div className="flex flex-wrap justify-end gap-2 pb-6">
        <Link to={id ? `/bills/${id}` : '/bills'} className="px-3.5 py-2 rounded-lg text-sm font-medium bg-white border border-gray-200 text-gray-800 hover:bg-gray-50">Cancel</Link>
        <Button disabled={save.isPending || !ready} onClick={() => save.mutate()}>Save</Button>
      </div>
      <p className="text-xs text-gray-500 text-right">Attach the vendor's file on the next screen.</p>
    </div>
  );
}
