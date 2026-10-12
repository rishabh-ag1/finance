import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import api from '../../api';
import { Button, Card, Chip, ErrorNote, Field, Modal, MoneyInput, Select, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { formatINR } from '../../lib/money';
import { apiErrorMessage } from '../../lib/utils';
import { ACCOUNT_TYPE_LABEL, dateLabel, useSettings, useSettingsMutation, type AccountType, type BankAccount } from './api';

// F003 bank accounts, including cash credit (BR-50). Adding a bank needs only an account record
// and a statement parser for its format.
export function BankAccountsTab() {
  const { data: accounts, isLoading } = useSettings<BankAccount[]>('bank-accounts');
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('financeSettings', 'edit');
  const [editing, setEditing] = useState<BankAccount | 'new' | null>(null);
  const [archiving, setArchiving] = useState<BankAccount | null>(null);

  if (isLoading || !accounts) return <p className="text-sm text-gray-500">Loading…</p>;

  return (
    <div className="space-y-3">
      {canEdit && <div className="flex justify-end"><Button onClick={() => setEditing('new')}>Add account</Button></div>}
      {accounts.map((a) => (
        <Card key={a.id} className={`p-4 ${a.isArchived ? 'opacity-60' : ''}`}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-medium text-gray-900">{a.bankName} <span className="font-mono text-gray-500">{a.accountNumberMasked}</span></div>
              <div className="text-sm text-gray-500">{a.accountName} · {a.ifsc}{a.branch ? ` · ${a.branch}` : ''}</div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Chip tone={a.accountType === 'cash_credit' ? 'amber' : 'blue'}>{ACCOUNT_TYPE_LABEL[a.accountType]}</Chip>
              {a.isArchived && <Chip>Archived</Chip>}
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <div><div className="text-gray-500">Opening balance</div><div className="num">{formatINR(a.openingBalance)}</div></div>
            <div><div className="text-gray-500">As of</div><div>{dateLabel(a.openingDate)}</div></div>
            <div><div className="text-gray-500">Owner</div><div>{a.owner}</div></div>
            <div><div className="text-gray-500">Statement format</div><div>{a.parserFormat ?? '—'}</div></div>
            {a.accountType === 'cash_credit' && <>
              <div><div className="text-gray-500">Sanctioned limit</div><div className="num">{formatINR(a.sanctionedLimit)}</div></div>
              <div><div className="text-gray-500">Drawing power</div><div className="num">{formatINR(a.drawingPower)}</div></div>
              <div><div className="text-gray-500">Headroom if nothing drawn</div><div className="num">{formatINR(a.headroomIfUndrawn)}</div></div>
              <div><div className="text-gray-500">Renewal</div><div>{dateLabel(a.renewalDate)}</div></div>
            </>}
          </div>
          {canEdit && (
            <div className="mt-3 flex gap-2">
              <Button variant="secondary" onClick={async () => setEditing((await api.get(`/settings/bank-accounts/${a.id}`)).data.data)}>Edit</Button>
              <Button variant="ghost" onClick={() => setArchiving(a)}>{a.isArchived ? 'Restore' : 'Archive'}</Button>
            </div>
          )}
        </Card>
      ))}
      {editing && <AccountForm account={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {archiving && <ArchiveAccount account={archiving} onClose={() => setArchiving(null)} />}
    </div>
  );
}

function AccountForm({ account, onClose }: { account: BankAccount | null; onClose: () => void }) {
  const [f, setF] = useState({
    bankName: account?.bankName ?? '', accountName: account?.accountName ?? 'Entelechy Labs Private Limited',
    accountNumber: account?.accountNumber ?? '', ifsc: account?.ifsc ?? '', branch: account?.branch ?? '',
    accountType: (account?.accountType ?? 'business_current') as AccountType, owner: account?.owner ?? 'Entelechy',
    openingBalance: account?.openingBalance ?? '0', openingDate: account?.openingDate ?? '', parserFormat: account?.parserFormat ?? '',
    sanctionedLimit: account?.sanctionedLimit ?? '', drawingPower: account?.drawingPower ?? '', drawingPowerAsOf: account?.drawingPowerAsOf ?? '',
    interestRate: account?.interestRate ?? '', renewalDate: account?.renewalDate ?? '',
  });
  const save = useSettingsMutation<typeof f>('bank-accounts', account ? 'put' : 'post');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const isCc = f.accountType === 'cash_credit';

  return (
    <Modal
      title={account ? 'Edit bank account' : 'Add bank account'}
      onClose={onClose}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button disabled={save.isPending} onClick={() => save.mutate({ url: account ? `bank-accounts/${account.id}` : undefined, body: f }, { onSuccess: onClose })}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </>}
    >
      <ErrorNote>{save.isError && apiErrorMessage(save.error, 'Could not save')}</ErrorNote>
      <Field label="Account type">
        <Select value={f.accountType} onChange={set('accountType')}>
          {Object.entries(ACCOUNT_TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
      </Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Bank"><TextInput value={f.bankName} onChange={set('bankName')} placeholder="Punjab National Bank" /></Field>
        <Field label="Branch"><TextInput value={f.branch} onChange={set('branch')} /></Field>
        <Field label="Account number"><TextInput className="font-mono" value={f.accountNumber} onChange={set('accountNumber')} /></Field>
        <Field label="IFSC"><TextInput className="font-mono uppercase" value={f.ifsc} onChange={set('ifsc')} maxLength={11} /></Field>
        <Field label="Account name"><TextInput value={f.accountName} onChange={set('accountName')} /></Field>
        <Field label="Owner" hint="Entelechy, or the founder for a personal account"><TextInput value={f.owner} onChange={set('owner')} /></Field>
        <Field label={isCc ? 'Opening drawn amount' : 'Opening balance'}><MoneyInput value={f.openingBalance} onChange={set('openingBalance')} /></Field>
        <Field label="As of"><TextInput type="date" value={f.openingDate} onChange={set('openingDate')} /></Field>
      </div>
      <Field label="Statement format" hint="idfc_v1 for IDFC. A new bank needs its parser before import."><TextInput value={f.parserFormat} onChange={set('parserFormat')} /></Field>
      {isCc && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-lg bg-amber-50/60 p-3">
          <p className="sm:col-span-2 text-xs text-amber-900">A cash credit balance is money drawn (owed to the bank), not cash. Headroom = lower of limit and drawing power, minus drawn.</p>
          <Field label="Sanctioned limit"><MoneyInput value={f.sanctionedLimit} onChange={set('sanctionedLimit')} /></Field>
          <Field label="Interest rate %"><TextInput inputMode="decimal" value={f.interestRate} onChange={set('interestRate')} /></Field>
          <Field label="Drawing power"><MoneyInput value={f.drawingPower} onChange={set('drawingPower')} /></Field>
          <Field label="Drawing power as of"><TextInput type="date" value={f.drawingPowerAsOf} onChange={set('drawingPowerAsOf')} /></Field>
          <Field label="Renewal date"><TextInput type="date" value={f.renewalDate} onChange={set('renewalDate')} /></Field>
        </div>
      )}
    </Modal>
  );
}

function ArchiveAccount({ account, onClose }: { account: BankAccount; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const archive = !account.isArchived;
  const submit = async () => {
    try {
      await api.post(`/settings/bank-accounts/${account.id}/archive`, { isArchived: archive, reason });
      qc.invalidateQueries({ queryKey: ['settings', 'bank-accounts'] });
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not change the account'));
    }
  };
  return (
    <Modal title={archive ? 'Archive account' : 'Restore account'} onClose={onClose} footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button onClick={submit}>{archive ? 'Archive' : 'Restore'}</Button>
    </>}>
      <ErrorNote>{error}</ErrorNote>
      <p className="text-sm text-gray-600">{archive ? 'Archived accounts keep all their transactions but are hidden from pickers. Nothing is deleted.' : 'The account will show in pickers again.'}</p>
      <Field label="Reason"><TextInput value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </Modal>
  );
}
