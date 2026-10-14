import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import api from '../../api';
import { Button, Card, ErrorNote, Field, MoneyInput, PageHeader, Select, TextInput } from '../../components/ui/kit';
import { formatINR } from '../../lib/money';
import { apiErrorMessage } from '../../lib/utils';
import type { PoRow } from '../purchases/api';
import { useSettings, type BankAccount, type TdsSection } from '../settings/api';
import type { VendorListRow } from '../vendors/types';
import { MODES, usePayment, type Payment, type PaymentPreview } from './api';

type DueRow = { id: string; docTypeLabel: string; docNumber: string; vendorId: string; owed: string; okToPay: boolean; isAdvance: boolean };
type Alloc = { target: string; gross: string; tdsChange: boolean; tdsApplicable: boolean; tdsSectionId: string; tdsRate: string; tdsAmount: string; tdsReason: string };
type Form = { vendorId: string; purpose: string; notes: string; allocations: Alloc[]; recordNow: boolean; paidDate: string; mode: string; fromBankAccountId: string; utr: string };

const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const emptyAlloc = (target = '', gross = ''): Alloc => ({ target, gross, tdsChange: false, tdsApplicable: true, tdsSectionId: '', tdsRate: '', tdsAmount: '', tdsReason: '' });

function useDebounced<T>(value: T, ms = 400): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

function body(f: Form) {
  return {
    vendorId: f.vendorId, purpose: f.purpose.trim() || null, notes: f.notes.trim() || null,
    allocations: f.allocations.filter((a) => a.target).map((a) => ({
      ...(a.target.startsWith('po:') ? { poId: a.target.slice(3) } : { docId: a.target.slice(4) }),
      gross: a.gross.replace(/,/g, '').trim() || '0',
      tds: a.tdsChange ? { applicable: a.tdsApplicable, sectionId: a.tdsSectionId || null, rate: a.tdsRate || null, amount: a.tdsAmount || null, overrideReason: a.tdsReason || null } : null,
    })),
  };
}

// F061 / F063 new payment, or editing a request. Every line goes to a bill, or is an advance on a
// quote, proforma or PO.
export function PaymentFormPage({ mode }: { mode: 'new' | 'edit' }) {
  const { id } = useParams();
  const [params] = useSearchParams();
  const { data: existing } = usePayment(mode === 'edit' ? id : undefined);
  if (mode === 'edit') {
    if (!existing) return <p className="text-sm text-gray-500">Loading…</p>;
    return <PaymentForm id={id} initial={{
      vendorId: existing.vendorId, purpose: existing.purpose ?? '', notes: existing.notes ?? '', recordNow: false, paidDate: today(), mode: 'neft', fromBankAccountId: '', utr: '',
      allocations: existing.allocations.filter((a) => !a.isArchived).map((a) => ({
        ...emptyAlloc(a.poId ? `po:${a.poId}` : `doc:${a.docId}`, a.gross),
        ...(a.tdsOverrideReason ? { tdsChange: true, tdsApplicable: a.tdsAmount !== '0.00', tdsRate: a.tdsRate, tdsAmount: a.tdsAmount, tdsReason: a.tdsOverrideReason } : {}),
      })),
    }} />;
  }
  const docIds = (params.get('docIds') ?? params.get('docId') ?? '').split(',').filter(Boolean);
  const poId = params.get('poId');
  return <PaymentForm prefillDocs={docIds} initial={{
    vendorId: params.get('vendorId') ?? '', purpose: '', notes: '', recordNow: true, paidDate: today(), mode: 'neft', fromBankAccountId: '', utr: '',
    allocations: poId ? [emptyAlloc(`po:${poId}`)] : docIds.length ? docIds.map((d) => emptyAlloc(`doc:${d}`)) : [emptyAlloc()],
  }} />;
}

function PaymentForm({ id, initial, prefillDocs = [] }: { id?: string; initial: Form; prefillDocs?: string[] }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [f, setF] = useState<Form>(initial);
  const { data: accounts } = useSettings<BankAccount[]>('bank-accounts');
  const { data: sections } = useSettings<TdsSection[]>('tds-sections');
  const { data: vendors } = useQuery({ queryKey: ['vendors-all'], queryFn: async () => (await api.get<{ data: { vendors: VendorListRow[] } }>('/vendors')).data.data.vendors.filter((v) => !v.isArchived && v.status !== 'blocked') });
  const { data: due } = useQuery({ queryKey: ['payables-due'], queryFn: async () => (await api.get<{ data: { rows: DueRow[] } }>('/payments/due')).data.data.rows });
  const { data: pos } = useQuery({
    enabled: !!f.vendorId, queryKey: ['pos-for-payment', f.vendorId], retry: false,
    queryFn: async () => (await api.get<{ data: { rows: PoRow[] } }>('/purchases/pos', { params: { vendorId: f.vendorId } })).data.data.rows.filter((p) => ['approved', 'sent', 'partially_billed'].includes(p.status)),
  });
  const docs = (due ?? []).filter((d) => d.vendorId === f.vendorId);
  const owedFor = (target: string) => docs.find((d) => `doc:${d.id}` === target)?.owed ?? '';

  // Prefilled bills start at what is owed on them.
  const [filled, setFilled] = useState(prefillDocs.length === 0);
  if (!filled && due) {
    setFilled(true);
    setF({ ...f, vendorId: f.vendorId || due.find((d) => d.id === prefillDocs[0])?.vendorId || '', allocations: f.allocations.map((a) => ({ ...a, gross: a.gross || owedFor(a.target) || (due.find((d) => `doc:${d.id}` === a.target)?.owed ?? '') })) });
  }

  const ready = !!f.vendorId && f.allocations.some((a) => a.target && Number(a.gross.replace(/,/g, '')) > 0);
  const debounced = useDebounced(JSON.stringify(body(f)));
  const preview = useQuery({
    queryKey: ['payment-preview', id, debounced], enabled: ready, retry: false,
    queryFn: async () => (await api.post<{ data: PaymentPreview }>('/payments/preview', JSON.parse(debounced), { params: { id } })).data.data,
  });
  const pv = ready ? preview.data : undefined;

  const save = useMutation({
    mutationFn: async () => {
      const b = body(f);
      if (id) return (await api.put<{ data: Payment }>(`/payments/${id}`, b)).data.data;
      const record = f.recordNow ? { paidDate: f.paidDate, mode: f.mode, fromBankAccountId: f.fromBankAccountId, utr: f.utr.trim() || null } : null;
      return (await api.post<{ data: Payment }>('/payments', { ...b, record })).data.data;
    },
    onSuccess: (p) => {
      for (const k of ['payments', 'payables-due', 'bills', 'bill', 'po', 'ap-ageing']) qc.invalidateQueries({ queryKey: [k] });
      qc.setQueryData(['payment', p.id], p);
      navigate(`/payments/${p.id}`);
    },
  });

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF({ ...f, [k]: v });
  const setAlloc = (i: number, patch: Partial<Alloc>) => set('allocations', f.allocations.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const businessAccounts = (accounts ?? []).filter((a) => a.isActive && !a.isArchived && a.owner === 'Entelechy');

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <PageHeader title={id ? 'Edit payment request' : 'New payment'} subtitle="Each line pays a bill, or is an advance against a quote, proforma or PO. TDS on advances is deducted now (BR-11)." />

      <Card className="p-4 sm:p-6 space-y-4">
        <Field label="Vendor">
          <Select value={f.vendorId} disabled={!!id} onChange={(e) => setF({ ...f, vendorId: e.target.value, allocations: [emptyAlloc()] })}>
            <option value="">Choose a vendor</option>
            {vendors?.map((v) => <option key={v.id} value={v.id}>{v.displayName}</option>)}
          </Select>
        </Field>
        {f.vendorId && f.allocations.map((a, i) => {
          const pa = pv?.allocations[i];
          return (
            <div key={i} className="border border-gray-100 rounded-lg p-3 space-y-2">
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_10rem_auto] gap-2 items-end">
                <Field label={`Line ${i + 1}: pays`}>
                  <Select value={a.target} onChange={(e) => setAlloc(i, { target: e.target.value, gross: owedFor(e.target.value) })}>
                    <option value="">Choose</option>
                    {docs.map((d) => <option key={d.id} value={`doc:${d.id}`} disabled={!d.okToPay}>{d.isAdvance ? 'Advance on ' : ''}{d.docTypeLabel} {d.docNumber} · owed {formatINR(d.owed, { decimals: false })}{d.okToPay ? '' : ' (not OK to pay yet)'}</option>)}
                    {pos?.map((p) => <option key={p.id} value={`po:${p.id}`}>Advance on {p.poNumber} · PO {formatINR(p.total, { decimals: false })}</option>)}
                  </Select>
                </Field>
                <Field label={pa?.isAdvance ? 'Advance (before TDS)' : 'Amount'}><MoneyInput value={a.gross} onChange={(e) => setAlloc(i, { gross: e.target.value })} /></Field>
                {f.allocations.length > 1 && <button type="button" aria-label={`Remove line ${i + 1}`} className="text-gray-400 hover:text-red-600 p-2" onClick={() => set('allocations', f.allocations.filter((_, j) => j !== i))}><Trash2 className="w-4 h-4" /></button>}
              </div>
              {pa?.isAdvance && (
                <div className="text-sm space-y-2 bg-gray-50 rounded-md p-2">
                  <p>{pa.tdsSuggestion?.applicable ? <>TDS suggested <b className="num">{formatINR(pa.tdsSuggestion.amount)}</b> on {formatINR(pa.tdsSuggestion.base)}: </> : 'No TDS suggested: '}{pa.tdsSuggestion?.reason}</p>
                  <p className="num">TDS {formatINR(pa.tdsAmount)} · paid out {formatINR(pa.amount)}</p>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={a.tdsChange} onChange={(e) => setAlloc(i, { tdsChange: e.target.checked, tdsSectionId: pa.tdsSuggestion?.sectionId ?? '', tdsRate: pa.tdsSuggestion?.rate ?? '' })} /> Deduct differently</label>
                  {a.tdsChange && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" checked={a.tdsApplicable} onChange={(e) => setAlloc(i, { tdsApplicable: e.target.checked })} /> Deduct TDS on this advance</label>
                      {a.tdsApplicable && <>
                        <Field label="Section" className="sm:col-span-2">
                          <Select value={a.tdsSectionId} onChange={(e) => setAlloc(i, { tdsSectionId: e.target.value })}>
                            <option value="">Choose</option>
                            {sections?.filter((s) => s.isActive).map((s) => <option key={s.id} value={s.id}>{s.codeOldAct} {s.nature}</option>)}
                          </Select>
                        </Field>
                        <Field label="Rate %"><TextInput inputMode="decimal" value={a.tdsRate} onChange={(e) => setAlloc(i, { tdsRate: e.target.value })} /></Field>
                        <Field label="TDS amount (empty = worked out)"><MoneyInput value={a.tdsAmount} onChange={(e) => setAlloc(i, { tdsAmount: e.target.value })} /></Field>
                      </>}
                      <Field label="Reason" className="sm:col-span-2"><TextInput value={a.tdsReason} onChange={(e) => setAlloc(i, { tdsReason: e.target.value })} /></Field>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {f.vendorId && <Button variant="secondary" onClick={() => set('allocations', [...f.allocations, emptyAlloc()])}><Plus className="w-4 h-4 inline -mt-0.5" /> Add line</Button>}
        {f.vendorId && docs.length === 0 && !pos?.length && <p className="text-sm text-gray-500">Nothing is owed to this vendor. Enter its bill or proforma first, or issue a PO to pay an advance against.</p>}

        {pv && (
          <div className="border-t border-gray-100 pt-3 text-sm space-y-1 sm:w-1/2 sm:ml-auto">
            {pv.tdsAmount !== '0.00' && <div className="flex justify-between"><span>TDS deducted</span><span className="num">{formatINR(pv.tdsAmount)}</span></div>}
            <div className="flex justify-between font-semibold"><span>Leaves the bank</span><span className="num">{formatINR(pv.amount)}</span></div>
          </div>
        )}
        {pv?.warnings.map((w) => <p key={w} className="flex items-start gap-2 text-sm text-amber-900 bg-amber-50 rounded-lg px-3 py-2"><AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {w}</p>)}
        {ready && preview.isError && <ErrorNote>{apiErrorMessage(preview.error, 'Could not work this out')}</ErrorNote>}
        <Field label="Purpose (internal)"><TextInput value={f.purpose} onChange={(e) => set('purpose', e.target.value)} placeholder="e.g. 40% advance for the T1 moulds" /></Field>
      </Card>

      {!id && (
        <Card className="p-4 sm:p-6 space-y-3">
          <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={f.recordNow} onChange={(e) => set('recordNow', e.target.checked)} /> Already paid: record it now</label>
          {!f.recordNow && <p className="text-sm text-gray-500">Saved as a payment to make. Record it when the money has gone.</p>}
          {f.recordNow && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Paid on"><TextInput type="date" value={f.paidDate} onChange={(e) => set('paidDate', e.target.value)} /></Field>
              <Field label="How">
                <Select value={f.mode} onChange={(e) => set('mode', e.target.value)}>{MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
              </Field>
              <Field label="From account">
                <Select value={f.fromBankAccountId} onChange={(e) => set('fromBankAccountId', e.target.value)}>
                  <option value="">Choose</option>
                  {businessAccounts.map((a) => <option key={a.id} value={a.id}>{a.bankName} {a.accountNumberMasked}</option>)}
                </Select>
              </Field>
              <Field label={f.mode === 'cheque' ? 'Cheque number' : 'UTR / reference'} hint="Used to find the payment in the bank statement (BR-08)."><TextInput value={f.utr} onChange={(e) => set('utr', e.target.value)} /></Field>
            </div>
          )}
        </Card>
      )}

      <ErrorNote>{save.isError && apiErrorMessage(save.error, 'Could not save')}</ErrorNote>
      <div className="flex flex-wrap justify-end gap-2 pb-6">
        <Link to={id ? `/payments/${id}` : '/payables'} className="px-3.5 py-2 rounded-lg text-sm font-medium bg-white border border-gray-200 text-gray-800 hover:bg-gray-50">Cancel</Link>
        <Button disabled={save.isPending || !ready || (f.recordNow && !id && !f.fromBankAccountId)} onClick={() => save.mutate()}>{id ? 'Save' : f.recordNow ? 'Record payment' : 'Save to pay later'}</Button>
      </div>
    </div>
  );
}
