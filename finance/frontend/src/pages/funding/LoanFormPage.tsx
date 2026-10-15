import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import api from '../../api';
import { Button, Card, ErrorNote, Field, MoneyInput, PageHeader, Select, TextInput } from '../../components/ui/kit';
import { formatINR } from '../../lib/money';
import { apiErrorMessage } from '../../lib/utils';
import { dateLabel } from '../settings/api';
import { FUNDING_KEYS, REPAYMENT_TYPES, type Covenant, type Instalment, type Loan } from './api';

function useDebounced<T>(value: T, ms = 400): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

type Form = { lender: string; reference: string; sanctionAmount: string; disbursedAmount: string; disbursedDate: string; interestRate: string; repaymentType: string; tenureMonths: string; moratoriumMonths: string; firstDueDate: string; countsTowardCovenant: boolean; notes: string };
const body = (f: Form) => ({
  lender: f.lender, reference: f.reference || null, sanctionAmount: f.sanctionAmount || f.disbursedAmount, disbursedAmount: f.disbursedAmount, disbursedDate: f.disbursedDate,
  interestRate: f.interestRate || null, repaymentType: f.repaymentType, tenureMonths: Number(f.tenureMonths), moratoriumMonths: Number(f.moratoriumMonths || 0),
  firstDueDate: f.repaymentType === 'flexible' ? null : f.firstDueDate || null, countsTowardCovenant: f.countsTowardCovenant, notes: f.notes || null,
});

// F141 a new loan: terms, the schedule it makes, and the covenant check before saving (BR-28).
export function LoanFormPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [f, setF] = useState<Form>({ lender: '', reference: '', sanctionAmount: '', disbursedAmount: '', disbursedDate: '', interestRate: '', repaymentType: 'flexible', tenureMonths: '', moratoriumMonths: '0', firstDueDate: '', countsTowardCovenant: true, notes: '' });
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const ready = !!f.lender && !!f.disbursedAmount && !!f.disbursedDate && !!f.tenureMonths;
  const debounced = useDebounced(JSON.stringify(body(f)));
  const preview = useQuery({
    queryKey: ['loan-preview', debounced], enabled: ready, retry: false,
    queryFn: async () => (await api.post<{ data: { finalDueDate: string; schedule: Omit<Instalment, 'id' | 'paid'>[]; covenant: Covenant } }>('/loans/preview', JSON.parse(debounced))).data.data,
  });
  const save = useMutation({ mutationFn: async () => (await api.post<{ data: Loan }>('/loans', body(f))).data.data, onSuccess: (l) => { for (const k of FUNDING_KEYS) qc.invalidateQueries({ queryKey: [k] }); navigate(`/funding/loans/${l.id}`); } });
  const p = preview.data;
  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <PageHeader title="New loan" subtitle={<><Link to="/funding?tab=loans" className="text-[#0c2c55] hover:underline">Funding & loans</Link> › from the loan agreement</>} />
      <Card className="p-4 sm:p-6 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Lender"><TextInput value={f.lender} onChange={(e) => set('lender', e.target.value)} placeholder="Neos Kosmos (Mesa)" /></Field>
        <Field label="Agreement / account reference"><TextInput value={f.reference} onChange={(e) => set('reference', e.target.value)} /></Field>
        <Field label="Amount received (₹)"><MoneyInput value={f.disbursedAmount} onChange={(e) => set('disbursedAmount', e.target.value)} /></Field>
        <Field label="Sanctioned (₹)" hint="Empty: same as received"><MoneyInput value={f.sanctionAmount} onChange={(e) => set('sanctionAmount', e.target.value)} /></Field>
        <Field label="Date received"><TextInput type="date" value={f.disbursedDate} onChange={(e) => set('disbursedDate', e.target.value)} /></Field>
        <Field label="Repayment"><Select value={f.repaymentType} onChange={(e) => set('repaymentType', e.target.value)}>{REPAYMENT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
        <Field label={f.repaymentType === 'flexible' ? 'Repay within (months)' : 'Tenure (months)'}><TextInput inputMode="numeric" value={f.tenureMonths} onChange={(e) => set('tenureMonths', e.target.value)} /></Field>
        <Field label="Interest rate (% a year)" hint={f.repaymentType === 'flexible' ? 'Optional until known from the agreement' : 'Needed for the schedule'}><MoneyInput value={f.interestRate} onChange={(e) => set('interestRate', e.target.value)} /></Field>
        {f.repaymentType !== 'flexible' && (
          <>
            <Field label="First instalment date" hint="Empty: a month after the money came"><TextInput type="date" value={f.firstDueDate} onChange={(e) => set('firstDueDate', e.target.value)} /></Field>
            <Field label="Moratorium (months, interest only)"><TextInput inputMode="numeric" value={f.moratoriumMonths} onChange={(e) => set('moratoriumMonths', e.target.value)} /></Field>
          </>
        )}
        <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={f.countsTowardCovenant} onChange={(e) => set('countsTowardCovenant', e.target.checked)} /> Counts toward the Mesa debt cap</label>
        <Field label="Notes" className="sm:col-span-2"><TextInput value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
      </Card>
      {p && (
        <Card className="p-4 sm:p-6 space-y-3">
          {p.covenant.warning
            ? <div className="flex gap-2 text-sm text-red-700"><AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /><span>{p.covenant.warning}. You can still save it.</span></div>
            : <p className="text-sm text-gray-700">Total debt with this loan: {formatINR(p.covenant.totalDebt)} of the {formatINR(p.covenant.cap)} cap.</p>}
          <p className="text-sm text-gray-700">Repay in full by <strong>{dateLabel(p.finalDueDate)}</strong>.</p>
          {p.schedule.length > 0 && (
            <div className="overflow-x-auto max-h-72">
              <table className="min-w-full text-xs sm:text-sm">
                <thead className="text-gray-500 text-left"><tr><th className="py-1 pr-2">#</th><th className="pr-2">Due</th><th className="text-right pr-2">Principal</th><th className="text-right pr-2">Interest</th><th className="text-right pr-2">Instalment</th><th className="text-right">Left</th></tr></thead>
                <tbody className="divide-y divide-gray-100">
                  {p.schedule.map((s) => <tr key={s.instalmentNo}><td className="py-1 pr-2">{s.instalmentNo}</td><td className="pr-2 whitespace-nowrap">{dateLabel(s.dueDate)}</td><td className="text-right num pr-2">{formatINR(s.principal)}</td><td className="text-right num pr-2">{formatINR(s.interest)}</td><td className="text-right num pr-2">{formatINR(s.total)}</td><td className="text-right num">{formatINR(s.closingBalance)}</td></tr>)}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
      <ErrorNote>{(preview.isError && apiErrorMessage(preview.error, 'Check the loan')) || (save.isError && apiErrorMessage(save.error, 'Not saved'))}</ErrorNote>
      <div className="text-right"><Button disabled={save.isPending || !ready || preview.isError} onClick={() => save.mutate()}>Save loan</Button></div>
    </div>
  );
}
