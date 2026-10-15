import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../api';
import { HistoryPanel } from '../../components/HistoryPanel';
import { Attachments } from '../../components/Attachments';
import { Button, Card, Chip, ErrorNote, Facts, Field, Modal, PageHeader, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { formatDateTime } from '../../lib/format';
import { formatINR } from '../../lib/money';
import { apiErrorMessage } from '../../lib/utils';
import { NATURE_LABEL } from '../bank/ledgerApi';
import { dateLabel } from '../settings/api';
import { CLAIM_KEYS, CLAIM_STATUS_TONE, useClaim, type ClaimDetail } from './api';

// F150 claim detail: receipt, approve (the other founder), reject, withdraw.
export function ClaimPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { hasPermission, user } = useAuth();
  const canEdit = hasPermission('financeClaims', 'edit');
  const { data: c, isLoading } = useClaim(id);
  const [asking, setAsking] = useState<'reject' | 'withdraw' | null>(null);
  const [reason, setReason] = useState('');
  const act = useMutation({
    mutationFn: async ({ action, payload }: { action: string; payload?: object }) => (await api.post<{ data: ClaimDetail }>(`/claims/${id}/${action}`, payload ?? {})).data.data,
    onSuccess: (d) => { qc.setQueryData(['claim', id], d); for (const k of CLAIM_KEYS) qc.invalidateQueries({ queryKey: [k] }); setAsking(null); setReason(''); },
  });

  if (isLoading || !c) return <p className="text-sm text-gray-500">Loading…</p>;
  const mine = c.founderUserId === user?.id;
  const waiting = c.status === 'submitted';

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <PageHeader
        title={`${c.vendorName} · ${formatINR(c.amount)}`}
        subtitle={`Paid by ${c.founderName} on ${dateLabel(c.expenseDate)}`}
        action={<Chip tone={CLAIM_STATUS_TONE[c.status]}>{c.statusLabel}</Chip>}
      />
      {c.statusReason && <p className="text-sm text-gray-600">Reason: {c.statusReason}</p>}

      {canEdit && waiting && (
        <div className="flex flex-wrap gap-2">
          <Link to={`/claims/${c.id}/edit`} className="inline-flex items-center px-3.5 py-2 rounded-lg text-sm font-medium bg-white border border-gray-200 text-gray-800 hover:bg-gray-50">Edit</Link>
          {!mine && <Button disabled={act.isPending || !c.hasReceipt} title={c.hasReceipt ? undefined : 'Attach the receipt first'} onClick={() => act.mutate({ action: 'approve' })}>Approve</Button>}
          {!mine && <Button variant="danger" onClick={() => setAsking('reject')}>Reject</Button>}
          {mine && <Button variant="danger" onClick={() => setAsking('withdraw')}>Withdraw</Button>}
        </div>
      )}
      {waiting && mine && <p className="text-sm text-gray-600">The other founder approves this claim.</p>}
      {waiting && !c.hasReceipt && <p className="text-sm text-amber-800 bg-amber-50 rounded-lg px-3 py-2">Attach the receipt or bill below before it can be approved.</p>}
      <ErrorNote>{act.isError && !asking && apiErrorMessage(act.error, 'That did not work')}</ErrorNote>

      <Card className="p-4 sm:p-6">
        <Facts items={[
          { label: 'Category', value: `${c.categoryName}${c.subCategoryName ? ` / ${c.subCategoryName}` : ''} (${NATURE_LABEL[c.nature]})` },
          { label: 'Paid from', value: c.paidFrom },
          { label: 'GST invoice', value: c.hasGstInvoice ? 'Yes, in the company\'s name' : 'No' },
          { label: 'What it was for', value: c.description },
          ...(c.approvedByName ? [{ label: 'Approved by', value: `${c.approvedByName}${c.approvedAt ? `, ${formatDateTime(c.approvedAt)}` : ''}` }] : []),
          ...(c.reimbursement ? [{ label: 'Paid back', value: <Link to={`/claims/reimbursements/${c.reimbursement.id}`} className="text-blue-700 hover:underline">{c.reimbursement.reimbursementNo} on {dateLabel(c.reimbursement.paidDate)} ({c.reimbursement.statusLabel})</Link> }] : []),
        ]} />
      </Card>

      <Card className="p-4 sm:p-6 space-y-2">
        <h2 className="font-semibold text-gray-900">Receipt</h2>
        <Attachments recordType="ExpenseClaim" recordId={c.id} kinds={['receipt', 'bill', 'proof', 'other']} onChange={() => qc.invalidateQueries({ queryKey: ['claim', id] })} />
      </Card>

      {asking && (
        <Modal title={asking === 'reject' ? 'Reject this claim' : 'Withdraw this claim'} onClose={() => setAsking(null)} footer={<>
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
