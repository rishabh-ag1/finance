import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../../api';
import { HistoryPanel } from '../../components/HistoryPanel';
import { Attachments } from '../../components/Attachments';
import { Button, Card, Chip, ErrorNote, Facts, Field, Modal, PageHeader, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { formatINR } from '../../lib/money';
import { apiErrorMessage } from '../../lib/utils';
import { MODES } from '../payments/api';
import { dateLabel } from '../settings/api';
import { CLAIM_KEYS, CLAIM_STATUS_TONE, REIMBURSEMENT_TONE, type ReimbursementDetail } from './api';

type Candidate = { id: string; txnDate: string; counterpartyName: string | null; utr: string | null; debit: string; narration: string };
const MATCHED_BY: Record<string, string> = { utr: 'by UTR', amount_date_name: 'by amount, date and name', manual: 'by hand' };

// F151 reimbursement detail: the claims it paid, the bank row, mark failed.
export function ReimbursementPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('financeClaims', 'edit');
  const [asking, setAsking] = useState<'failed' | 'unlink' | null>(null);
  const [reason, setReason] = useState('');
  const { data: r, isLoading } = useQuery({ queryKey: ['reimbursement', id], queryFn: async () => (await api.get<{ data: ReimbursementDetail }>(`/claims/reimbursements/${id}`)).data.data });
  const { data: candidates } = useQuery({
    enabled: r?.status === 'paid', queryKey: ['reimbursement-candidates', id],
    queryFn: async () => (await api.get<{ data: Candidate[] }>(`/claims/reimbursements/${id}/bank-candidates`)).data.data,
  });
  const act = useMutation({
    mutationFn: async ({ action, payload }: { action: string; payload?: object }) => (await api.post<{ data: ReimbursementDetail }>(`/claims/reimbursements/${id}/${action}`, payload ?? {})).data.data,
    onSuccess: (d) => { qc.setQueryData(['reimbursement', id], d); for (const k of [...CLAIM_KEYS, 'reimbursement-candidates']) qc.invalidateQueries({ queryKey: [k] }); setAsking(null); setReason(''); },
  });

  if (isLoading || !r) return <p className="text-sm text-gray-500">Loading…</p>;
  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <PageHeader title={`${r.reimbursementNo} · ${formatINR(r.amount)}`} subtitle={`Paid back to ${r.founderName}`} action={<Chip tone={REIMBURSEMENT_TONE[r.status]}>{r.statusLabel}</Chip>} />
      {r.statusReason && <p className="text-sm text-gray-600">Reason: {r.statusReason}{r.status === 'failed' && '. Its claims are back on the list to reimburse.'}</p>}
      {canEdit && r.status !== 'failed' && (
        <div className="flex flex-wrap gap-2">
          <Button variant="danger" onClick={() => setAsking('failed')}>Mark failed</Button>
          {r.status === 'reconciled' && <Button variant="secondary" onClick={() => setAsking('unlink')}>Unlink bank row</Button>}
        </div>
      )}
      <ErrorNote>{act.isError && !asking && apiErrorMessage(act.error, 'That did not work')}</ErrorNote>

      <Card className="p-4 sm:p-6">
        <Facts items={[
          { label: 'Paid on', value: dateLabel(r.paidDate) },
          { label: 'How', value: `${MODES.find(([v]) => v === r.mode)?.[1] ?? r.mode}${r.fromAccount ? ` from ${r.fromAccount}` : ''}` },
          { label: 'UTR / reference', value: r.utr },
          ...(r.bankRow ? [{ label: 'Bank statement', value: <Link to={`/ledger?from=${r.bankRow.txnDate}&to=${r.bankRow.txnDate}`} className="text-blue-700 hover:underline">{dateLabel(r.bankRow.txnDate)} · {r.bankRow.counterpartyName ?? '—'} · {formatINR(r.bankRow.debit)} ({MATCHED_BY[r.matchedBy ?? ''] ?? 'linked'})</Link> }] : []),
        ]} />
      </Card>

      {r.claims.length > 0 && (
        <Card className="p-4 sm:p-6 space-y-2">
          <h2 className="font-semibold text-gray-900">Claims it pays</h2>
          <ul className="divide-y divide-gray-100 text-sm">
            {r.claims.map((c) => (
              <li key={c.id} className="py-2 flex items-center justify-between gap-2">
                <Link to={`/claims/${c.id}`} className="min-w-0 text-blue-700 hover:underline truncate">{dateLabel(c.expenseDate)} · {c.vendorName}</Link>
                <span className="flex items-center gap-2"><span className="num">{formatINR(c.amount)}</span><Chip tone={CLAIM_STATUS_TONE[c.status]}>{c.statusLabel}</Chip></span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {r.status === 'paid' && canEdit && (
        <Card className="p-4 sm:p-6 space-y-2">
          <h2 className="font-semibold text-gray-900">Link to the bank statement</h2>
          {candidates?.length === 0 && <p className="text-sm text-gray-500">No bank row of {formatINR(r.amount)} within 10 days yet. Import the statement; the link is made by itself when the UTR or amount, date and name agree.</p>}
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
        <Attachments recordType="Reimbursement" recordId={r.id} kinds={['proof', 'other']} />
      </Card>

      {asking && (
        <Modal title={asking === 'failed' ? 'Mark this reimbursement failed' : 'Unlink the bank row'} onClose={() => setAsking(null)} footer={<>
          <Button variant="secondary" onClick={() => setAsking(null)}>Back</Button>
          <Button variant="danger" disabled={reason.trim().length < 3 || act.isPending} onClick={() => act.mutate({ action: asking, payload: { reason } })}>Confirm</Button>
        </>}>
          <Field label="Reason"><TextInput autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <ErrorNote>{act.isError && apiErrorMessage(act.error, 'That did not work')}</ErrorNote>
        </Modal>
      )}
      <HistoryPanel recordId={id!} />
    </div>
  );
}
