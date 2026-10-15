import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../../api';
import { HistoryPanel } from '../../components/HistoryPanel';
import { Attachments } from '../../components/Attachments';
import { Button, Card, Chip, ErrorNote, Facts, Field, Modal, MoneyInput, PageHeader, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { formatINR } from '../../lib/money';
import { apiErrorMessage, cn } from '../../lib/utils';
import { dateLabel } from '../settings/api';
import { FUNDING_KEYS, type Candidate, type Loan } from './api';

const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

function RepaymentForm({ loan, onClose }: { loan: Loan; onClose: () => void }) {
  const qc = useQueryClient();
  const [date, setDate] = useState(today());
  const { data: s } = useQuery({ queryKey: ['loan', loan.id, 'suggest', date], queryFn: async () => (await api.get<{ data: { instalmentId: string | null; principal: string; interest: string; note: string } | null }>(`/loans/${loan.id}/suggest-repayment`, { params: { date } })).data.data });
  const [own, setOwn] = useState<{ principal: string; interest: string } | null>(null);
  const v = own ?? { principal: s?.principal ?? '', interest: s?.interest ?? '' };
  const [reference, setReference] = useState('');
  const save = useMutation({
    mutationFn: async () => (await api.post(`/loans/${loan.id}/repayments`, { paidDate: date, principal: v.principal || '0', interest: v.interest || null, instalmentId: own ? null : s?.instalmentId ?? null, reference: reference || null })).data.data,
    onSuccess: () => { for (const k of FUNDING_KEYS) qc.invalidateQueries({ queryKey: [k] }); onClose(); },
  });
  return (
    <Modal title={`Repayment to ${loan.lender}`} onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button disabled={save.isPending} onClick={() => save.mutate()}>Record</Button></>}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Date paid"><TextInput type="date" value={date} onChange={(e) => { setDate(e.target.value); setOwn(null); }} /></Field>
        <Field label="UTR / reference"><TextInput value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
        <Field label="Principal (₹)" hint="Financing out, not an expense"><MoneyInput value={v.principal} onChange={(e) => setOwn({ ...v, principal: e.target.value })} /></Field>
        <Field label="Interest (₹)" hint="An expense (Interest)"><MoneyInput value={v.interest} onChange={(e) => setOwn({ ...v, interest: e.target.value })} /></Field>
      </div>
      {s?.note && <p className="text-xs text-gray-500 mt-2">{s.note}</p>}
      <p className="text-xs text-gray-500 mt-1">The bank debit of principal + interest links by itself when the statement is imported, split into principal and interest.</p>
      <ErrorNote>{save.isError && apiErrorMessage(save.error, 'Not recorded')}</ErrorNote>
    </Modal>
  );
}

function LinkRows({ path, amount, onDone }: { path: string; amount: string; onDone: () => void }) {
  const { data } = useQuery({ queryKey: ['loan', 'candidates', path], queryFn: async () => (await api.get<{ data: Candidate[] }>(`${path}/bank-candidates`)).data.data });
  const link = useMutation({ mutationFn: async (txnId: string) => (await api.post(`${path}/link`, { txnId })).data.data, onSuccess: onDone });
  if (!data) return null;
  if (!data.length) return <p className="text-xs text-gray-500">No free bank row of {formatINR(amount)} within 15 days.</p>;
  return (
    <ul className="divide-y divide-gray-100 text-sm">
      {data.map((c) => (
        <li key={c.id} className="py-1.5 flex justify-between gap-2">
          <span className="truncate">{dateLabel(c.txnDate)} · {c.counterpartyName ?? c.narration}</span>
          <Button variant="secondary" disabled={link.isPending} onClick={() => link.mutate(c.id)}>Link</Button>
        </li>
      ))}
      {link.isError && <li className="text-red-700 text-xs">{apiErrorMessage(link.error, 'Not linked')}</li>}
    </ul>
  );
}

// F141-F143 one loan: terms, balance, schedule, repayments, its bank rows and agreement.
export function LoanPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('financeFunding', 'edit');
  const [paying, setPaying] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);
  const [rate, setRate] = useState<string | null>(null);
  const { data: l } = useQuery({ queryKey: ['loan', id], queryFn: async () => (await api.get<{ data: Loan }>(`/loans/${id}`)).data.data });
  const refresh = () => { setLinking(null); for (const k of FUNDING_KEYS) qc.invalidateQueries({ queryKey: [k] }); };
  const act = useMutation({ mutationFn: async (a: { path: string; body?: object; method?: 'put' }) => (a.method === 'put' ? await api.put(a.path, a.body) : await api.post(a.path, a.body ?? {})).data.data, onSuccess: () => { setRate(null); refresh(); } });
  const withReason = (q: string, path: string) => { const reason = window.prompt(q); if (reason) act.mutate({ path, body: { reason } }); };
  if (!l) return <p className="text-sm text-gray-500">Loading…</p>;
  const active = l.status === 'active';
  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <PageHeader
        title={l.lender}
        subtitle={<><Link to="/funding?tab=loans" className="text-[#0c2c55] hover:underline">Funding & loans</Link> › {l.repaymentTypeLabel} loan of {dateLabel(l.disbursedDate)}</>}
        action={canEdit && active && <Button onClick={() => setPaying(true)}>Record repayment</Button>}
      />
      {l.status !== 'active' && <Card className={cn('p-3 text-sm', l.status === 'cancelled' ? 'text-red-700' : 'text-emerald-700')}>{l.status === 'closed' ? 'Repaid in full.' : `Cancelled: ${l.statusReason}`}</Card>}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Card className="p-3"><div className="text-xs text-gray-500">Still owed</div><div className="text-lg font-semibold num">{formatINR(l.balance)}</div></Card>
        <Card className="p-3"><div className="text-xs text-gray-500">Repay by</div><div className="text-lg font-semibold">{dateLabel(l.finalDueDate)}</div><div className={cn('text-xs', l.daysToFinalDue < 0 ? 'text-red-700' : 'text-gray-500')}>{l.daysToFinalDue >= 0 ? `${l.daysToFinalDue} days left` : `${-l.daysToFinalDue} days past`}</div></Card>
        <Card className="p-3"><div className="text-xs text-gray-500">Principal repaid</div><div className="text-lg font-semibold num">{formatINR(l.principalRepaid)}</div></Card>
        <Card className="p-3"><div className="text-xs text-gray-500">Interest paid</div><div className="text-lg font-semibold num">{formatINR(l.interestPaid)}</div></Card>
      </div>
      <Card className="p-4 sm:p-6 space-y-3">
        <Facts items={[
          { label: 'Received', value: <span className="num">{formatINR(l.disbursedAmount)} on {dateLabel(l.disbursedDate)}{l.sanctionAmount !== l.disbursedAmount ? ` (sanctioned ${formatINR(l.sanctionAmount)})` : ''}</span> },
          { label: 'Interest', value: l.interestRate ? `${l.interestRate}% a year` : 'Not entered yet' },
          { label: 'Term', value: `${l.tenureMonths} months${l.moratoriumMonths ? `, ${l.moratoriumMonths} months interest only first` : ''}` },
          ...(l.reference ? [{ label: 'Reference', value: l.reference }] : []),
          { label: 'Debt cap', value: l.countsTowardCovenant ? 'Counts toward the Mesa cap' : 'Left out of the cap' },
          { label: 'Bank', value: l.inBank ? <Chip tone="green">Money received is in the bank statement</Chip> : <span>Not linked to a bank credit yet {canEdit && l.status !== 'cancelled' && <button className="text-[#0c2c55] hover:underline" onClick={() => setLinking(`/loans/${l.id}`)}>Link</button>}</span> },
          ...(l.notes ? [{ label: 'Notes', value: l.notes }] : []),
        ]} />
        {linking === `/loans/${l.id}` && <LinkRows path={`/loans/${l.id}`} amount={l.disbursedAmount} onDone={refresh} />}
        {canEdit && l.status !== 'cancelled' && (
          <div className="flex flex-wrap items-end gap-2 pt-2 border-t border-gray-100">
            <Field label="Interest rate (% a year)" className="w-44"><MoneyInput value={rate ?? l.interestRate ?? ''} onChange={(e) => setRate(e.target.value)} /></Field>
            <Button variant="secondary" disabled={act.isPending || rate === null} onClick={() => act.mutate({ path: `/loans/${l.id}/terms`, method: 'put', body: { interestRate: rate || null, reference: l.reference, notes: l.notes, countsTowardCovenant: l.countsTowardCovenant } })}>Save rate</Button>
            <Button variant="ghost" disabled={act.isPending} onClick={() => act.mutate({ path: `/loans/${l.id}/terms`, method: 'put', body: { interestRate: l.interestRate, reference: l.reference, notes: l.notes, countsTowardCovenant: !l.countsTowardCovenant } })}>{l.countsTowardCovenant ? 'Leave out of the cap' : 'Count toward the cap'}</Button>
            {l.repayments.every((r) => r.status === 'cancelled') && <Button variant="danger" disabled={act.isPending} onClick={() => withReason('Why is this loan cancelled (entered in error)?', `/loans/${l.id}/cancel`)}>Cancel loan</Button>}
          </div>
        )}
        <ErrorNote>{act.isError && apiErrorMessage(act.error, 'That did not work')}</ErrorNote>
      </Card>

      <Card className="p-4 sm:p-6 space-y-2">
        <h2 className="font-semibold text-gray-900">Repayments</h2>
        {l.repayments.length === 0 && <p className="text-sm text-gray-500">None yet.</p>}
        <ul className="divide-y divide-gray-100 text-sm">
          {l.repayments.map((r) => (
            <li key={r.id} className={cn('py-2 space-y-1', r.status === 'cancelled' && 'opacity-50')}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div>{dateLabel(r.paidDate)}{r.instalmentNo ? ` · instalment ${r.instalmentNo}` : ''}{r.reference ? ` · ${r.reference}` : ''}</div>
                  <div className="text-xs text-gray-500">Principal {formatINR(r.principal)} · interest {formatINR(r.interest)}{r.status === 'cancelled' ? ` · cancelled: ${r.statusReason}` : ''}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="num font-medium">{formatINR(r.total)}</div>
                  {r.status === 'recorded' && (r.inBank ? <Chip tone="green">In bank</Chip> : canEdit ? <button className="text-xs text-[#0c2c55] hover:underline" onClick={() => setLinking(`/loan-repayments/${r.id}`)}>Link bank row</button> : <Chip>Not in bank yet</Chip>)}
                  {canEdit && r.status === 'recorded' && <div><Button variant="ghost" disabled={act.isPending} onClick={() => withReason('Why is this repayment cancelled?', `/loan-repayments/${r.id}/cancel`)}>Cancel</Button></div>}
                </div>
              </div>
              {linking === `/loan-repayments/${r.id}` && <LinkRows path={`/loan-repayments/${r.id}`} amount={r.total} onDone={refresh} />}
            </li>
          ))}
        </ul>
      </Card>

      {l.schedule.length > 0 && (
        <Card className="p-4 sm:p-6 space-y-2">
          <h2 className="font-semibold text-gray-900">Schedule</h2>
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs sm:text-sm">
              <thead className="text-gray-500 text-left"><tr><th className="py-1 pr-2">#</th><th className="pr-2">Due</th><th className="text-right pr-2">Principal</th><th className="text-right pr-2">Interest</th><th className="text-right pr-2">Instalment</th><th className="text-right pr-2">Left</th><th /></tr></thead>
              <tbody className="divide-y divide-gray-100">
                {l.schedule.map((s) => (
                  <tr key={s.id} className={cn(s.paid && 'text-gray-400')}>
                    <td className="py-1 pr-2">{s.instalmentNo}</td><td className="pr-2 whitespace-nowrap">{dateLabel(s.dueDate)}</td>
                    <td className="text-right num pr-2">{formatINR(s.principal)}</td><td className="text-right num pr-2">{formatINR(s.interest)}</td><td className="text-right num pr-2">{formatINR(s.total)}</td><td className="text-right num pr-2">{formatINR(s.closingBalance)}</td>
                    <td>{s.paid ? <Chip tone="green">Paid</Chip> : active && s.dueDate < today() ? <Chip tone="red">Due</Chip> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card className="p-4 sm:p-6 space-y-2">
        <h2 className="font-semibold text-gray-900">Agreement and letters</h2>
        <Attachments recordType="Loan" recordId={l.id} kinds={['agreement', 'proof', 'other']} />
      </Card>
      {paying && <RepaymentForm loan={l} onClose={() => setPaying(false)} />}
      <HistoryPanel recordId={id!} />
    </div>
  );
}
