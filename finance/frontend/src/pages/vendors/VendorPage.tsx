import { useState } from 'react';
import { useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Circle } from 'lucide-react';
import api from '../../api';
import { Button, Card, Chip, ErrorNote, Facts, Field, Modal, PageHeader, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { formatDateTime } from '../../lib/format';
import { formatINR } from '../../lib/money';
import { apiErrorMessage } from '../../lib/utils';
import { dateLabel } from '../settings/api';
import { categoryText, isZero, useCategories } from '../bank/ledgerApi';
import { TxnPanel } from '../bank/TxnPanel';
import { VendorForm } from './VendorForm';
import { MSME_LABEL, STATUS_CHIP, TYPE_LABEL, type Vendor, type VendorStatus } from './types';

const BANK_CHIP = {
  approved: { text: 'Current', tone: 'green' },
  pending: { text: 'Waiting for approval', tone: 'amber' },
  rejected: { text: 'Rejected', tone: 'red' },
  superseded: { text: 'Replaced', tone: 'gray' },
} as const;

// F038 vendor 360: details, warnings, bank details (BR-16), documents (F036) and payments.
export function VendorPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const { user, hasPermission } = useAuth();
  const canEdit = hasPermission('financeVendors', 'edit');
  const { data: cats } = useCategories();
  const [editing, setEditing] = useState(false);
  const [bankForm, setBankForm] = useState(false);
  const [statusAsk, setStatusAsk] = useState<VendorStatus | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [openTxn, setOpenTxn] = useState<string | null>(null);
  const { data: v, isLoading } = useQuery({
    queryKey: ['vendor', id],
    queryFn: async () => (await api.get<{ data: Vendor }>(`/vendors/${id}`)).data.data,
  });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['vendor', id] }); qc.invalidateQueries({ queryKey: ['vendors'] }); };

  const setStatus = useMutation({
    mutationFn: async ({ status, reason }: { status: VendorStatus; reason?: string }) => api.post(`/vendors/${id}/status`, { status, reason }),
    onSuccess: () => { setStatusAsk(null); refresh(); },
  });
  const decide = useMutation({
    mutationFn: async ({ bankId, approve, note }: { bankId: string; approve: boolean; note?: string }) => api.post(`/vendors/bank/${bankId}/decide`, { approve, note }),
    onSuccess: () => { setRejecting(null); refresh(); },
  });

  if (isLoading || !v) return <p className="text-sm text-gray-500">Loading…</p>;
  const pending = v.bankHistory.find((b) => b.status === 'pending');

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <PageHeader
        title={v.displayName}
        subtitle={<>{v.legalName && v.legalName !== v.displayName ? `${v.legalName} · ` : ''}{TYPE_LABEL[v.vendorType]} · <Chip tone={STATUS_CHIP[v.status].tone}>{STATUS_CHIP[v.status].text}</Chip></>}
        action={canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>
            {(v.status === 'draft' || v.status === 'pending_review' || v.status === 'blocked') && <Button onClick={() => setStatus.mutate({ status: 'active' })}>Activate</Button>}
            {v.status === 'draft' && <Button variant="ghost" onClick={() => setStatus.mutate({ status: 'pending_review' })}>Send for review</Button>}
            {v.status === 'active' && <Button variant="danger" onClick={() => setStatusAsk('blocked')}>Block</Button>}
          </div>
        )}
      />
      <ErrorNote>{(setStatus.isError && apiErrorMessage(setStatus.error, 'Could not change status')) || (decide.isError && apiErrorMessage(decide.error, 'Could not decide'))}</ErrorNote>

      {v.warnings.length > 0 && (
        <ul className="space-y-1">
          {v.warnings.map((w) => (
            <li key={w} className="flex gap-2 text-sm text-amber-900 bg-amber-50 rounded-lg px-3 py-2"><AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />{w}</li>
          ))}
        </ul>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="p-4 space-y-3">
          <h2 className="font-semibold text-gray-900">Tax profile</h2>
          <Facts items={[
            { label: 'GSTIN', value: v.gstin ? <span className="font-mono">{v.gstin}</span> : 'Not GST registered' },
            { label: 'PAN', value: v.pan ? <span className="font-mono">{v.pan}</span> : <span className="text-amber-700">Not on file</span> },
            { label: 'Deductee type', value: v.deducteeLabel },
            { label: 'State', value: v.state ? `${v.state}${v.stateCode ? ` (${v.stateCode})` : ''}` : '—' },
            { label: 'MSME', value: v.msmeType === 'none' ? 'No' : `${MSME_LABEL[v.msmeType]} · ${v.udyamNo}` },
            { label: 'Lower deduction', value: v.ldcNumber ? `${v.ldcNumber} at ${v.ldcRate}% till ${dateLabel(v.ldcValidTo)}` : '—' },
            { label: 'Default category', value: categoryText(cats, v.defaultCategoryId, v.defaultSubCategoryId) ?? '—' },
            { label: 'Bank statement names', value: v.bankNames.length ? v.bankNames.join(', ') : '—' },
          ]} />
        </Card>
        <Card className="p-4 space-y-3">
          <h2 className="font-semibold text-gray-900">Contact</h2>
          <Facts items={[
            { label: 'Person', value: v.contactName },
            { label: 'Phone', value: v.phone },
            { label: 'Email', value: v.email },
            { label: 'Address', value: [v.addressLine1, v.addressLine2, v.city, v.pincode].filter(Boolean).join(', ') || null },
            { label: 'Notes', value: v.notes },
          ]} />
        </Card>
      </div>

      <Card className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold text-gray-900">Bank details</h2>
          {canEdit && <Button variant="secondary" onClick={() => setBankForm(true)}>{v.currentBank ? 'Change bank details' : 'Add bank details'}</Button>}
        </div>
        <p className="text-xs text-gray-500">Once a vendor is active, new bank details need approval by the other founder, and payments show a warning for 30 days (BR-16, invoice-redirection fraud).</p>
        {pending && (
          <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-sm space-y-2">
            <div><strong>Waiting for approval:</strong> {pending.accountName} · <span className="font-mono">{pending.accountNumberMasked}</span> · {pending.ifsc}{pending.bankName ? ` · ${pending.bankName}` : ''}</div>
            <div className="text-xs text-gray-600">Asked by {pending.requestedBy} on {formatDateTime(pending.requestedAt)}</div>
            {canEdit && (pending.requestedById === user?.id
              ? <p className="text-xs text-amber-900">The other founder approves this change.</p>
              : (
                <div className="flex gap-2">
                  <Button disabled={decide.isPending} onClick={() => decide.mutate({ bankId: pending.id, approve: true, note: 'Confirmed with the vendor' })}>Approve</Button>
                  <Button variant="danger" onClick={() => setRejecting(pending.id)}>Reject</Button>
                </div>
              ))}
          </div>
        )}
        <ul className="divide-y divide-gray-100 text-sm">
          {v.bankHistory.filter((b) => b.status !== 'pending').map((b) => (
            <li key={b.id} className="py-2 flex flex-wrap items-center justify-between gap-2">
              <span>{b.accountName} · <span className="font-mono">{b.accountNumberMasked}</span> · {b.ifsc}{b.bankName ? ` · ${b.bankName}` : ''}
                <span className="block text-xs text-gray-500">{b.decidedBy ? `${b.status === 'rejected' ? 'Rejected' : 'Approved'} by ${b.decidedBy}` : ''}{b.decisionNote ? `: ${b.decisionNote}` : ''}</span>
              </span>
              <Chip tone={BANK_CHIP[b.status].tone}>{BANK_CHIP[b.status].text}</Chip>
            </li>
          ))}
          {v.bankHistory.length === 0 && <li className="py-2 text-gray-500">No bank details yet.</li>}
        </ul>
      </Card>

      <Card className="p-4 space-y-2">
        <h2 className="font-semibold text-gray-900">Documents</h2>
        <p className="text-xs text-gray-500">Uploading arrives with the documents vault (next milestone). A vendor can be active without every document; payments then show a warning.</p>
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1 text-sm">
          {v.documents.map((d) => (
            <li key={d.kind} className="flex items-center gap-2">
              {d.present ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <Circle className={`w-4 h-4 ${d.required ? 'text-amber-500' : 'text-gray-300'}`} />}
              {d.label}{!d.required && <span className="text-xs text-gray-400">(optional)</span>}
            </li>
          ))}
        </ul>
      </Card>

      <Card className="p-4 space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-semibold text-gray-900">Payments</h2>
          <span className="text-sm text-gray-600">FY {v.payments.fy}: <span className="num font-medium">{formatINR(v.payments.paidThisFy)}</span> · all time <span className="num">{formatINR(v.payments.paidAllTime)}</span></span>
        </div>
        <p className="text-xs text-gray-500">Bank rows linked to this vendor or paid to its bank statement names. Bills, POs, advances and TDS join in Phase 2.</p>
        {v.payments.rows.length === 0 && <p className="text-sm text-gray-500">No payments found.</p>}
        <ul className="divide-y divide-gray-100 text-sm">
          {v.payments.rows.map((r) => (
            <li key={r.id}>
              <button className="w-full text-left py-2 flex items-start justify-between gap-2 hover:bg-gray-50" onClick={() => setOpenTxn(r.id)}>
                <span className="min-w-0">
                  <span className="block truncate">{r.description ?? r.counterpartyName ?? r.narrationRaw}</span>
                  <span className="block text-xs text-gray-500">{dateLabel(r.txnDate)}{r.utr ? ` · UTR ${r.utr}` : ''}</span>
                </span>
                <span className={`num whitespace-nowrap ${isZero(r.debit) ? 'text-emerald-700' : 'text-red-700'}`}>{isZero(r.debit) ? `+${formatINR(r.credit)}` : `-${formatINR(r.debit)}`}</span>
              </button>
            </li>
          ))}
        </ul>
      </Card>

      {editing && <VendorForm vendor={v} onClose={() => setEditing(false)} onSaved={() => setEditing(false)} />}
      {bankForm && <BankForm vendorId={v.id} needsApproval={v.status === 'active' || v.status === 'blocked' || !!v.currentBank} onClose={() => { setBankForm(false); refresh(); }} />}
      {statusAsk && (
        <ReasonModal title="Block vendor" label="Why is this vendor blocked? No new POs or payments until it is active again." pending={setStatus.isPending}
          onClose={() => setStatusAsk(null)} onSave={(reason) => setStatus.mutate({ status: statusAsk, reason })} />
      )}
      {rejecting && (
        <ReasonModal title="Reject bank details" label="Why are these bank details rejected?" pending={decide.isPending}
          onClose={() => setRejecting(null)} onSave={(note) => decide.mutate({ bankId: rejecting, approve: false, note })} />
      )}
      {openTxn && <TxnPanel id={openTxn} onClose={() => setOpenTxn(null)} />}
    </div>
  );
}

function ReasonModal({ title, label, pending, onClose, onSave }: { title: string; label: string; pending: boolean; onClose: () => void; onSave: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <Modal title={title} onClose={onClose} footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button disabled={pending || reason.trim().length < 3} onClick={() => onSave(reason)}>Save</Button>
    </>}>
      <Field label={label}><TextInput autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </Modal>
  );
}

function BankForm({ vendorId, needsApproval, onClose }: { vendorId: string; needsApproval: boolean; onClose: () => void }) {
  const [f, setF] = useState({ accountName: '', accountNumber: '', confirmNumber: '', ifsc: '', bankName: '', branch: '' });
  const [ifscNote, setIfscNote] = useState('');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const ifsc = useMutation({
    mutationFn: async () => (await api.get<{ data: { ok: true; bank: string; branch: string } | { ok: false; message: string } }>(`/vendors/lookup/ifsc/${f.ifsc.trim().toUpperCase()}`)).data.data,
    onSuccess: (o) => { if (o.ok) { setF((p) => ({ ...p, bankName: o.bank, branch: o.branch })); setIfscNote(`${o.bank}, ${o.branch}`); } else setIfscNote(o.message); },
  });
  const save = useMutation({
    mutationFn: async () => api.post(`/vendors/${vendorId}/bank`, { accountName: f.accountName, accountNumber: f.accountNumber, ifsc: f.ifsc, bankName: f.bankName, branch: f.branch }),
    onSuccess: onClose,
  });
  const mismatch = f.confirmNumber.length > 0 && f.confirmNumber !== f.accountNumber;
  return (
    <Modal title="Bank details" onClose={onClose} footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button disabled={save.isPending || mismatch || !f.confirmNumber} onClick={() => save.mutate()}>{needsApproval ? 'Send for approval' : 'Save'}</Button>
    </>}>
      <ErrorNote>{save.isError && apiErrorMessage(save.error, 'Could not save')}</ErrorNote>
      {needsApproval && <p className="text-sm text-amber-900 bg-amber-50 rounded-lg px-3 py-2">The other founder must approve these details before they are used. Confirm them with the vendor by phone, not by email.</p>}
      <Field label="Account holder name (as on the cheque)"><TextInput value={f.accountName} onChange={set('accountName')} /></Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Account number"><TextInput className="font-mono" inputMode="numeric" value={f.accountNumber} onChange={set('accountNumber')} /></Field>
        <Field label="Type it again" error={mismatch ? 'The two numbers differ' : undefined}><TextInput className="font-mono" inputMode="numeric" value={f.confirmNumber} onChange={set('confirmNumber')} onPaste={(e) => e.preventDefault()} /></Field>
      </div>
      <Field label="IFSC" hint={ifscNote || 'Bank and branch fill in from the IFSC'}>
        <TextInput className="font-mono uppercase" maxLength={11} value={f.ifsc} onChange={set('ifsc')} onBlur={() => f.ifsc.length === 11 && ifsc.mutate()} />
      </Field>
    </Modal>
  );
}
