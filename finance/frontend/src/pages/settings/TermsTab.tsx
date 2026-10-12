import { useState } from 'react';
import { Button, Card, Chip, ErrorNote, Field, Modal, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { formatINR } from '../../lib/money';
import { apiErrorMessage } from '../../lib/utils';
import { useSettings, useSettingsMutation, type ApprovalRule, type PaymentTerm } from './api';

// F009 payment terms and F007 approval rules (provision only, switched off - Q9).
export function TermsTab() {
  const { data: terms } = useSettings<PaymentTerm[]>('payment-terms');
  const { data: rules } = useSettings<ApprovalRule[]>('approval-rules');
  const { hasPermission } = useAuth();
  const [editing, setEditing] = useState<PaymentTerm | 'new' | null>(null);
  const canEdit = hasPermission('financeSettings', 'edit');

  return (
    <div className="space-y-4">
      <Card className="p-4 sm:p-6 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold text-gray-900">Payment terms</h2>
          {canEdit && <Button variant="secondary" onClick={() => setEditing('new')}>Add term</Button>}
        </div>
        <p className="text-sm text-gray-600">Due date = document date + days. Advance terms are due on the document date.</p>
        <ul className="divide-y divide-gray-100">
          {terms?.map((t) => (
            <li key={t.id} className="py-2.5 flex items-center justify-between gap-2 text-sm">
              <span className={t.isActive ? 'text-gray-900' : 'text-gray-400 line-through'}>{t.label}</span>
              <span className="flex items-center gap-2">
                {t.isAdvance ? <Chip tone="amber">Advance</Chip> : <span className="text-gray-500">{t.days} days</span>}
                {canEdit && <Button variant="ghost" onClick={() => setEditing(t)}>Edit</Button>}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="p-4 sm:p-6 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold text-gray-900">Approval limits</h2>
          <Chip>Switched off</Chip>
        </div>
        <p className="text-sm text-gray-600">No approval limits for now (Q9): any admin issues POs and records payments. The bands stay here so they can be switched on later without changes.</p>
        <ul className="text-sm text-gray-500 space-y-1">
          {rules?.map((r) => (
            <li key={r.id}>
              {r.appliesTo === 'purchase_order' ? 'PO' : 'Payment'} {formatINR(r.amountFrom, { decimals: false })}{r.amountTo ? ` to ${formatINR(r.amountTo, { decimals: false })}` : ' and above'}: {r.approversRequired === 2 ? 'both founders' : 'one founder'}
            </li>
          ))}
        </ul>
      </Card>

      {editing && <TermForm term={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function TermForm({ term, onClose }: { term: PaymentTerm | null; onClose: () => void }) {
  const [f, setF] = useState({ label: term?.label ?? '', days: String(term?.days ?? 0), isAdvance: term?.isAdvance ?? false, isActive: term?.isActive ?? true });
  const save = useSettingsMutation('payment-terms', term ? 'put' : 'post');
  return (
    <Modal title={term ? 'Edit payment term' : 'Add payment term'} onClose={onClose} footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button disabled={save.isPending} onClick={() => save.mutate({ url: term ? `payment-terms/${term.id}` : undefined, body: { ...f, days: Number(f.days) } }, { onSuccess: onClose })}>Save</Button>
    </>}>
      <ErrorNote>{save.isError && apiErrorMessage(save.error, 'Could not save')}</ErrorNote>
      <Field label="Name"><TextInput value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="Net 60" /></Field>
      <Field label="Days"><TextInput inputMode="numeric" value={f.days} disabled={f.isAdvance} onChange={(e) => setF({ ...f, days: e.target.value })} /></Field>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isAdvance} onChange={(e) => setF({ ...f, isAdvance: e.target.checked })} /> Advance (due on the document date)</label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> In use</label>
    </Modal>
  );
}
