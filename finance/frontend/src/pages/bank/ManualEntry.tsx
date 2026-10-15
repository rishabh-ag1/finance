import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import api from '../../api';
import { Button, ErrorNote, Field, Modal, MoneyInput, Select, TextInput } from '../../components/ui/kit';
import { apiErrorMessage } from '../../lib/utils';
import { useSettings, type BankAccount } from '../settings/api';
import { useRefreshBank } from './ledgerApi';

const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

/** F022: a cash or wallet transaction no statement will bring; then categorise it and attach the bill. */
export function ManualEntry({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void }) {
  const refresh = useRefreshBank();
  const { data: accounts } = useSettings<BankAccount[]>('bank-accounts');
  const manual = accounts?.filter((a) => !a.parserFormat && a.owner === 'Entelechy') ?? [];
  const [f, setF] = useState({ bankAccountId: '', txnDate: today(), description: '', amount: '', direction: 'out', note: '' });
  const save = useMutation({
    mutationFn: async () => (await api.post<{ data: { id: string } }>('/bank/manual', { ...f, bankAccountId: f.bankAccountId || manual[0]?.id })).data.data,
    onSuccess: (t) => { refresh(); onSaved(t.id); },
  });
  return (
    <Modal title="Cash or wallet entry" onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button disabled={save.isPending || !manual.length} onClick={() => save.mutate()}>Save</Button></>}>
      {accounts && manual.length === 0 ? (
        <p className="text-sm text-gray-600">Add a cash or wallet account first (Settings › Bank accounts, type Wallet, no statement format). Bank accounts get their rows from statements only.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Account"><Select value={f.bankAccountId || manual[0]?.id || ''} onChange={(e) => setF({ ...f, bankAccountId: e.target.value })}>{manual.map((a) => <option key={a.id} value={a.id}>{a.bankName} · {a.accountName}</option>)}</Select></Field>
          <Field label="Date" hint="After the account's last entry"><TextInput type="date" value={f.txnDate} onChange={(e) => setF({ ...f, txnDate: e.target.value })} /></Field>
          <Field label="Money"><Select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}><option value="out">Paid out</option><option value="in">Received</option></Select></Field>
          <Field label="Amount (₹)"><MoneyInput value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
          <Field label="What it was" className="sm:col-span-2"><TextInput value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Courier charges" /></Field>
          <Field label="Note (who, why)" className="sm:col-span-2"><TextInput value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        </div>
      )}
      <p className="text-xs text-gray-500 mt-2">It opens next so you can categorise it and attach the bill or receipt. <Link to="/settings?tab=banks" className="underline">Accounts</Link></p>
      <ErrorNote>{save.isError && apiErrorMessage(save.error, 'Not saved')}</ErrorNote>
    </Modal>
  );
}
