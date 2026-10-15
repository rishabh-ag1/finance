import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import api from '../../api';
import { HistoryPanel } from '../../components/HistoryPanel';
import { Attachments } from '../../components/Attachments';
import { Button, Card, Chip, ErrorNote, Facts, Field, Modal, PageHeader, Select, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { formatDateTime } from '../../lib/format';
import { formatINR } from '../../lib/money';
import { apiErrorMessage } from '../../lib/utils';
import { dateLabel, useSettings, type BankAccount } from '../settings/api';
import { MODES, PAYMENT_STATUS_TONE, usePayment, type Payment } from './api';

type Candidate = { id: string; txnDate: string; counterpartyName: string | null; utr: string | null; debit: string; narration: string };
const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const MATCHED_BY: Record<string, string> = { utr: 'by UTR', amount_date_name: 'by amount, date and name', manual: 'by hand' };

// F063-F065 payment detail: approve, record, link to the bank row, fail or cancel.
export function PaymentPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('financePayments', 'edit');
  const { data: p, isLoading } = usePayment(id);
  const { data: accounts } = useSettings<BankAccount[]>('bank-accounts');
  const [asking, setAsking] = useState<'cancel' | 'failed' | 'unlink' | null>(null);
  const [reason, setReason] = useState('');
  const [rec, setRec] = useState({ paidDate: today(), mode: 'neft', fromBankAccountId: '', utr: '' });
  const { data: candidates } = useQuery({
    enabled: !!p && p.status === 'paid', queryKey: ['payment-candidates', id],
    queryFn: async () => (await api.get<{ data: Candidate[] }>(`/payments/${id}/bank-candidates`)).data.data,
  });

  const act = useMutation({
    mutationFn: async ({ action, payload }: { action: string; payload?: object }) => (await api.post<{ data: Payment }>(`/payments/${id}/${action}`, payload ?? {})).data.data,
    onSuccess: (d) => {
      qc.setQueryData(['payment', id], d);
      for (const k of ['payments', 'payables-due', 'bills', 'bill', 'po', 'ap-ageing', 'payment-candidates', 'ledger']) qc.invalidateQueries({ queryKey: [k] });
      setAsking(null); setReason('');
    },
  });

  if (isLoading || !p) return <p className="text-sm text-gray-500">Loading…</p>;
  const businessAccounts = (accounts ?? []).filter((a) => a.isActive && !a.isArchived && a.owner === 'Entelechy');

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <PageHeader
        title={p.paymentNo ?? 'Payment request'}
        subtitle={<Link to={`/vendors/${p.vendorId}`} className="hover:underline">{p.vendorName}</Link>}
        action={<Chip tone={PAYMENT_STATUS_TONE[p.status]}>{p.statusLabel}</Chip>}
      />
      {p.warnings.map((w) => <p key={w} className="flex items-start gap-2 text-sm text-amber-900 bg-amber-50 rounded-lg px-3 py-2"><AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {w}</p>)}
      {p.statusReason && <p className="text-sm text-gray-600">Reason: {p.statusReason}</p>}

      {canEdit && (
        <div className="flex flex-wrap gap-2">
          {['requested', 'approved'].includes(p.status) && <Link to={`/payments/${p.id}/edit`} className="inline-flex items-center px-3.5 py-2 rounded-lg text-sm font-medium bg-white border border-gray-200 text-gray-800 hover:bg-gray-50">Edit</Link>}
          {p.status === 'requested' && <Button disabled={act.isPending} onClick={() => act.mutate({ action: 'approve' })}>Approve</Button>}
          {['requested', 'approved'].includes(p.status) && <Button variant="danger" onClick={() => setAsking('cancel')}>Cancel</Button>}
          {['paid', 'reconciled'].includes(p.status) && <Button variant="danger" onClick={() => setAsking('failed')}>Mark failed</Button>}
          {p.status === 'reconciled' && <Button variant="secondary" onClick={() => setAsking('unlink')}>Unlink bank row</Button>}
        </div>
      )}
      <ErrorNote>{act.isError && !asking && apiErrorMessage(act.error, 'That did not work')}</ErrorNote>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <Card className="p-3"><div className="text-xs text-gray-500">Leaves the bank</div><div className="font-semibold num">{formatINR(p.amount)}</div></Card>
        <Card className="p-3"><div className="text-xs text-gray-500">TDS deducted</div><div className="font-semibold num">{formatINR(p.tdsAmount)}</div></Card>
        <Card className="p-3 col-span-2 sm:col-span-1"><div className="text-xs text-gray-500">Vendor's bank</div><div className="text-sm">{p.vendorBank ? `${p.vendorBank.accountName} · ${p.vendorBank.accountNumberMasked} · ${p.vendorBank.ifsc}` : <span className="text-amber-700">None approved</span>}</div></Card>
      </div>

      {p.status === 'approved' && canEdit && (
        <Card className="p-4 sm:p-6 space-y-3">
          <h2 className="font-semibold text-gray-900">Record the payment</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Paid on"><TextInput type="date" value={rec.paidDate} onChange={(e) => setRec({ ...rec, paidDate: e.target.value })} /></Field>
            <Field label="How"><Select value={rec.mode} onChange={(e) => setRec({ ...rec, mode: e.target.value })}>{MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
            <Field label="From account">
              <Select value={rec.fromBankAccountId} onChange={(e) => setRec({ ...rec, fromBankAccountId: e.target.value })}>
                <option value="">Choose</option>
                {businessAccounts.map((a) => <option key={a.id} value={a.id}>{a.bankName} {a.accountNumberMasked}</option>)}
              </Select>
            </Field>
            <Field label="UTR / reference"><TextInput value={rec.utr} onChange={(e) => setRec({ ...rec, utr: e.target.value })} /></Field>
          </div>
          <div className="text-right"><Button disabled={act.isPending || !rec.fromBankAccountId} onClick={() => act.mutate({ action: 'record', payload: { ...rec, utr: rec.utr || null } })}>Record payment</Button></div>
        </Card>
      )}

      <Card className="p-4 sm:p-6">
        <Facts items={[
          { label: 'Paid on', value: p.paidDate ? dateLabel(p.paidDate) : null },
          { label: 'How', value: p.mode ? `${MODES.find(([v]) => v === p.mode)?.[1] ?? p.mode}${p.fromBankAccount ? ` from ${p.fromBankAccount}` : ''}` : null },
          { label: 'UTR / reference', value: p.utr },
          { label: 'Purpose', value: p.purpose },
          { label: 'Asked by', value: `${p.requestedBy} on ${dateLabel(p.requestDate)}` },
          ...(p.paidBy ? [{ label: 'Recorded by', value: `${p.paidBy}${p.paidAt ? `, ${formatDateTime(p.paidAt)}` : ''}` }] : []),
          ...(p.approvals.length ? [{ label: 'Approved by', value: p.approvals.map((a) => a.name).join(', ') }] : []),
          ...(p.bankRow ? [{ label: 'Bank statement', value: <Link to={`/ledger?accountId=${p.fromBankAccountId}&from=${p.bankRow.txnDate}&to=${p.bankRow.txnDate}`} className="text-blue-700 hover:underline">{dateLabel(p.bankRow.txnDate)} · {p.bankRow.counterpartyName} · {formatINR(p.bankRow.debit)} ({MATCHED_BY[p.matchedBy ?? ''] ?? 'linked'})</Link> }] : []),
        ]} />
      </Card>

      <Card className="p-4 sm:p-6 space-y-2">
        <h2 className="font-semibold text-gray-900">What it pays</h2>
        <ul className="divide-y divide-gray-100 text-sm">
          {p.allocations.map((a) => (
            <li key={a.id} className={`py-2 ${a.isArchived ? 'opacity-50 line-through' : ''}`}>
              <div className="flex justify-between gap-2">
                <span>{a.docId ? <Link to={`/bills/${a.docId}`} className="text-blue-700 hover:underline">{a.label}</Link> : <Link to={`/purchase-orders/${a.poId}`} className="text-blue-700 hover:underline">{a.label}</Link>}{a.isAdvance && ' (advance)'}</span>
                <span className="num">{formatINR(a.gross)}</span>
              </div>
              {a.tdsAmount !== '0.00' && <div className="text-xs text-gray-500">TDS {formatINR(a.tdsAmount)} at {a.tdsRate}% ({a.tdsSection}){a.tdsOverrideReason ? ` · changed: ${a.tdsOverrideReason}` : ''}; paid out {formatINR(a.amount)}</div>}
              {a.appliedTo && <div className="text-xs text-gray-500">Now set against <Link to={`/bills/${a.appliedTo.id}`} className="underline">{a.appliedTo.label}</Link></div>}
            </li>
          ))}
        </ul>
      </Card>

      {p.status === 'paid' && canEdit && (
        <Card className="p-4 sm:p-6 space-y-2">
          <h2 className="font-semibold text-gray-900">Link to the bank statement</h2>
          {candidates?.length === 0 && <p className="text-sm text-gray-500">No bank row of {formatINR(p.amount)} within 10 days yet. Import the statement; the link is made by itself when the UTR or amount, date and name agree.</p>}
          <ul className="divide-y divide-gray-100 text-sm">
            {candidates?.map((c) => (
              <li key={c.id} className="py-2 flex items-center justify-between gap-2">
                <span className="min-w-0"><span className="block">{dateLabel(c.txnDate)} · {c.counterpartyName ?? '—'} · {formatINR(c.debit)}</span><span className="block text-[11px] text-gray-400 font-mono truncate">{c.narration}</span></span>
                <Button variant="secondary" disabled={act.isPending} onClick={() => act.mutate({ action: 'link', payload: { txnId: c.id } })}>Link</Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="p-4 sm:p-6 space-y-2">
        <h2 className="font-semibold text-gray-900">Proof</h2>
        <Attachments recordType="PaymentOut" recordId={p.id} kinds={['proof', 'other']} />
      </Card>

      {asking && (
        <Modal title={asking === 'cancel' ? 'Cancel this payment' : asking === 'failed' ? 'Mark this payment failed' : 'Unlink the bank row'} onClose={() => setAsking(null)} footer={<>
          <Button variant="secondary" onClick={() => setAsking(null)}>Back</Button>
          <Button variant="danger" disabled={reason.trim().length < 3 || act.isPending} onClick={() => act.mutate({ action: asking === 'unlink' ? 'unlink' : asking, payload: { reason } })}>Confirm</Button>
        </>}>
          <p className="text-sm text-gray-600">
            {asking === 'cancel' && 'The request is kept, marked Cancelled.'}
            {asking === 'failed' && `Use this when the bank returned the money. ${p.paymentNo} stays in the log; the bills it paid are owed again.`}
            {asking === 'unlink' && 'The bank row goes back to the review queue if its category came from this payment.'}
          </p>
          <Field label="Reason"><TextInput autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <ErrorNote>{act.isError && apiErrorMessage(act.error, 'That did not work')}</ErrorNote>
        </Modal>
      )}
      <HistoryPanel recordId={id!} />
    </div>
  );
}
