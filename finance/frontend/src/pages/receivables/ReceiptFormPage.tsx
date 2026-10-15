import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../../api';
import { Button, Card, ErrorNote, Field, MoneyInput, PageHeader, Select, TextInput } from '../../components/ui/kit';
import { formatINR } from '../../lib/money';
import { apiErrorMessage } from '../../lib/utils';
import type { CustomerRow } from '../customers/api';
import { dateLabel, useSettings, type BankAccount } from '../settings/api';
import { RECEIPT_MODES, RECEIVABLE_KEYS, type OpenDoc, type Receipt } from './api';

const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
type Form = { kind: 'company' | 'name'; companyId: string; customerName: string; receiptDate: string; mode: string; toBankAccountId: string; reference: string; amount: string; bankCharges: string; notes: string; alloc: Record<string, { amount: string; tds: string }> };

function useDebounced<T>(value: T, ms = 400): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

function body(f: Form) {
  return {
    receiptDate: f.receiptDate, companyId: f.kind === 'company' ? f.companyId || null : null, customerName: f.kind === 'name' ? f.customerName.trim() || null : null,
    mode: f.mode, toBankAccountId: f.toBankAccountId || null, reference: f.reference.trim() || null, amount: f.amount || '0', bankCharges: f.bankCharges || null, notes: f.notes.trim() || null,
    allocations: Object.entries(f.alloc).filter(([, a]) => a.amount && Number(a.amount) > 0).map(([docId, a]) => ({ docId, amount: a.amount, tds: a.tds || null })),
  };
}

// F111 / F112: record money from a customer and set it against invoices (what is left is an advance).
export function ReceiptFormPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [f, setF] = useState<Form>({
    kind: params.get('name') ? 'name' : 'company', companyId: params.get('companyId') ?? '', customerName: params.get('name') ?? '', receiptDate: today(), mode: 'neft',
    toBankAccountId: '', reference: '', amount: '', bankCharges: '', notes: '', alloc: {},
  });
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const { data: customers } = useQuery({ queryKey: ['customers', ''], queryFn: async () => (await api.get<{ data: CustomerRow[] }>('/customers')).data.data });
  const { data: accounts } = useSettings<BankAccount[]>('bank-accounts');
  const who = f.kind === 'company' ? f.companyId : f.customerName.trim();
  const { data: docs } = useQuery({
    enabled: !!who, queryKey: ['receivables', 'open-docs', f.kind, who],
    queryFn: async () => (await api.get<{ data: OpenDoc[] }>('/receivables/open-docs', { params: f.kind === 'company' ? { companyId: f.companyId } : { name: f.customerName.trim() } })).data.data,
  });
  const debounced = useDebounced(JSON.stringify(body(f)));
  const preview = useQuery({
    queryKey: ['receipt-preview', debounced], enabled: !!who && !!f.amount, retry: false,
    queryFn: async () => (await api.post<{ data: { customerName: string; tds: string; total: string; advance: string; problems: string[] } }>('/receipts/preview', JSON.parse(debounced))).data.data,
  });
  const save = useMutation({
    mutationFn: async () => (await api.post<{ data: Receipt }>('/receipts', body(f))).data.data,
    onSuccess: (r) => { for (const k of RECEIVABLE_KEYS) qc.invalidateQueries({ queryKey: [k] }); navigate(`/receipts/${r.id}`); },
  });
  const preset = params.get('docId');
  const setAlloc = (id: string, k: 'amount' | 'tds', v: string) => setF((x) => ({ ...x, alloc: { ...x.alloc, [id]: { amount: x.alloc[id]?.amount ?? '', tds: x.alloc[id]?.tds ?? '', [k]: v } } }));
  const businessAccounts = accounts?.filter((a) => a.owner === 'Entelechy') ?? [];

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <PageHeader title="New receipt" subtitle={<><Link to="/receivables?tab=receipts" className="text-[#0c2c55] hover:underline">Receivables</Link> › money received from a customer</>} />
      <Card className="p-4 sm:p-6 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Customer">
          <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Form['kind'], alloc: {} })}>
            <option value="company">A customer in the CRM</option><option value="name">A D2C buyer or one-off customer (by name)</option>
          </Select>
        </Field>
        {f.kind === 'company' ? (
          <Field label="Company">
            <Select value={f.companyId} onChange={(e) => setF({ ...f, companyId: e.target.value, alloc: {} })}>
              <option value="">Choose…</option>{customers?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
        ) : (
          <Field label="Name as on the invoice"><TextInput value={f.customerName} onChange={(e) => setF({ ...f, customerName: e.target.value, alloc: {} })} /></Field>
        )}
        <Field label="Date received"><TextInput type="date" value={f.receiptDate} onChange={(e) => set('receiptDate', e.target.value)} /></Field>
        <Field label="How"><Select value={f.mode} onChange={(e) => set('mode', e.target.value)}>{RECEIPT_MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
        <Field label="Amount received (₹)" hint="What reached the bank, after any TDS"><MoneyInput value={f.amount} onChange={(e) => set('amount', e.target.value)} /></Field>
        <Field label="Into account">
          <Select value={f.toBankAccountId} onChange={(e) => set('toBankAccountId', e.target.value)}>
            <option value="">{f.mode === 'cash' ? 'Cash (not banked yet)' : 'Choose…'}</option>{businessAccounts.map((a) => <option key={a.id} value={a.id}>{a.bankName} {a.accountNumberMasked}</option>)}
          </Select>
        </Field>
        <Field label="UTR / cheque number"><TextInput value={f.reference} onChange={(e) => set('reference', e.target.value)} /></Field>
        <Field label="Bank charges (₹)" hint="Deducted by the bank or gateway"><MoneyInput value={f.bankCharges} onChange={(e) => set('bankCharges', e.target.value)} /></Field>
        <Field label="Notes" className="sm:col-span-2"><TextInput value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
      </Card>

      {!!who && (
        <Card className="p-4 sm:p-6 space-y-3">
          <h2 className="font-semibold text-gray-900">Set against</h2>
          <p className="text-sm text-gray-600">Each line settles an invoice: the amount includes any TDS the customer deducted on it (BR-41). A proforma takes the amount as an advance, moved to its tax invoice when issued. Whatever is left stays as an advance.</p>
          {docs?.length === 0 && <p className="text-sm text-gray-500">No open invoices or proformas: the whole receipt becomes an advance.</p>}
          <div className="divide-y divide-gray-100">
            {docs?.map((d) => (
              <div key={d.id} className={`py-2 grid grid-cols-2 sm:grid-cols-[1fr_9rem_8rem] gap-2 items-end ${preset === d.id ? 'bg-amber-50/60' : ''}`}>
                <div className="col-span-2 sm:col-span-1 min-w-0 text-sm">
                  <div className="font-medium truncate">{d.docNumber} {d.docType === 'proforma' && <span className="text-xs text-gray-500">(proforma)</span>}</div>
                  <div className="text-xs text-gray-500">{dateLabel(d.docDate)} · owes {formatINR(d.outstanding)}{d.daysOverdue ? ` · ${d.daysOverdue} day(s) late` : ''}{' '}
                    <button type="button" className="text-[#0c2c55] hover:underline" onClick={() => setAlloc(d.id, 'amount', d.outstanding)}>Settle in full</button>
                  </div>
                </div>
                <Field label="Amount settled"><MoneyInput value={f.alloc[d.id]?.amount ?? ''} onChange={(e) => setAlloc(d.id, 'amount', e.target.value)} /></Field>
                <Field label="of which TDS"><MoneyInput value={f.alloc[d.id]?.tds ?? ''} onChange={(e) => setAlloc(d.id, 'tds', e.target.value)} /></Field>
              </div>
            ))}
          </div>
          {preview.data && (
            <p className="text-sm text-gray-700">
              Total {formatINR(preview.data.total)} (received + TDS {formatINR(preview.data.tds)} + charges){preview.data.advance !== '0.00' ? `; ${formatINR(preview.data.advance)} stays as an advance` : ''}.
            </p>
          )}
          {preview.data?.problems.map((p) => <p key={p} className="text-sm text-red-700">{p}</p>)}
          <ErrorNote>{(preview.isError && apiErrorMessage(preview.error, 'Check the receipt')) || (save.isError && apiErrorMessage(save.error, 'Could not save'))}</ErrorNote>
          <div className="text-right"><Button disabled={save.isPending || !f.amount || !!preview.data?.problems.length} onClick={() => save.mutate()}>Record receipt</Button></div>
        </Card>
      )}
    </div>
  );
}
