import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import api from '../../api';
import { Button, Card, Chip, ErrorNote, Field, PageHeader, Select } from '../../components/ui/kit';
import { formatDateTime } from '../../lib/format';
import { formatINR } from '../../lib/money';
import { apiErrorMessage } from '../../lib/utils';
import { dateLabel, useSettings, type BankAccount } from '../settings/api';
import { BalanceCheckNote } from './BalanceCheckNote';
import { BankRows } from './BankRows';
import type { Batch, Preview } from './types';

type FilePayload = { bankAccountId: string; fileName: string; contentBase64: string };

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

const STATUS_CHIP = {
  ok: { tone: 'green', text: 'Balances OK' },
  gap: { tone: 'amber', text: 'Gap' },
  mismatch: { tone: 'red', text: 'Mismatch' },
} as const;

// F010-F013: upload a statement, preview new vs duplicate rows and the balance check, then import.
export function ImportPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: accounts } = useSettings<BankAccount[]>('bank-accounts');
  const usable = (accounts ?? []).filter((a) => !a.isArchived && a.parserFormat);
  const [accountId, setAccountId] = useState('');
  const [payload, setPayload] = useState<FilePayload | null>(null);
  const selected = accountId || usable[0]?.id || '';

  const preview = useMutation({
    mutationFn: async (p: FilePayload) => (await api.post<{ data: Preview }>('/bank/imports/preview', p)).data.data,
  });
  const confirm = useMutation({
    mutationFn: async (p: FilePayload) => (await api.post<{ data: Batch }>('/bank/imports', p)).data.data,
    onSuccess: (batch) => {
      qc.invalidateQueries({ queryKey: ['bank-imports'] });
      navigate(`/imports/${batch.id}`);
    },
  });
  const { data: history } = useQuery({
    queryKey: ['bank-imports'],
    queryFn: async () => (await api.get<{ data: (Batch & { importedByName: string })[] }>('/bank/imports')).data.data,
  });

  const onFile = async (file: File | undefined) => {
    if (!file || !selected) return;
    const p = { bankAccountId: selected, fileName: file.name, contentBase64: await readAsBase64(file) };
    setPayload(p);
    confirm.reset();
    preview.mutate(p);
  };

  const pv = preview.data;

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <PageHeader title="Import statement" subtitle="Upload the bank's CSV or Excel (.xlsx) download. Rows already imported are skipped; nothing is stored until you confirm." />

      <Card className="p-4 sm:p-6 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
          <Field label="Bank account">
            <Select value={selected} onChange={(e) => { setAccountId(e.target.value); preview.reset(); setPayload(null); }}>
              {usable.map((a) => <option key={a.id} value={a.id}>{a.bankName} {a.accountNumberMasked}</option>)}
            </Select>
          </Field>
          <label className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-dashed border-gray-300 text-sm text-gray-700 cursor-pointer hover:bg-gray-50">
            <Upload className="w-4 h-4" />
            <span>{payload ? payload.fileName : 'Choose statement file'}</span>
            <input type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
        </div>
        {usable.length === 0 && <p className="text-sm text-amber-800">No account has a statement format yet. Set one in Settings &gt; Bank accounts.</p>}
        <ErrorNote>{preview.isError && apiErrorMessage(preview.error, 'Could not read the file')}</ErrorNote>
        {preview.isPending && <p className="text-sm text-gray-500">Reading the statement…</p>}
      </Card>

      {pv && payload && (
        <>
          <Card className="p-4 sm:p-6 space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <div><div className="text-gray-500">Period</div><div>{dateLabel(pv.periodFrom)} – {dateLabel(pv.periodTo)}</div></div>
              <div><div className="text-gray-500">New rows</div><div className="text-lg font-semibold text-gray-900">{pv.rowsNew}</div></div>
              <div><div className="text-gray-500">Already imported</div><div className="text-lg font-semibold text-gray-500">{pv.rowsDuplicate}</div></div>
              <div><div className="text-gray-500">Not recognised</div><div className="text-lg font-semibold text-amber-700">{pv.rowsUnparsed}</div></div>
              <div><div className="text-gray-500">New money in</div><div className="num text-emerald-700">{formatINR(pv.newCredit)}</div></div>
              <div><div className="text-gray-500">New money out</div><div className="num text-red-700">{formatINR(pv.newDebit)}</div></div>
            </div>
            <BalanceCheckNote check={pv.balanceCheck} />
            {pv.rowsInLockedMonths > 0 && (
              <ErrorNote>{pv.rowsInLockedMonths} new row(s) fall in a locked month. Unlock it in Settings &gt; Period lock before importing.</ErrorNote>
            )}
            <ErrorNote>{confirm.isError && apiErrorMessage(confirm.error, 'Import failed')}</ErrorNote>
            <div className="flex flex-wrap gap-2 justify-end">
              <Button variant="secondary" onClick={() => { preview.reset(); setPayload(null); }}>Cancel</Button>
              <Button disabled={pv.rowsNew === 0 || pv.rowsInLockedMonths > 0 || confirm.isPending} onClick={() => confirm.mutate(payload)}>
                {confirm.isPending ? 'Importing…' : pv.rowsNew === 0 ? 'Nothing new to import' : `Import ${pv.rowsNew} new row${pv.rowsNew === 1 ? '' : 's'}`}
              </Button>
            </div>
          </Card>
          <BankRows rows={pv.rows.map((r) => ({
            ...r,
            key: String(r.seq),
            badge: r.isDuplicate ? { tone: 'gray', text: 'Already imported' } : r.monthLocked ? { tone: 'red', text: 'Locked month' } : { tone: 'blue', text: 'New' },
          }))} />
        </>
      )}

      <section className="space-y-2">
        <h2 className="font-semibold text-gray-900">Past imports</h2>
        {history?.length === 0 && <p className="text-sm text-gray-500">No statements imported yet.</p>}
        <Card className="divide-y divide-gray-100">
          {history?.map((b) => (
            <Link key={b.id} to={`/imports/${b.id}`} className="block p-3 sm:p-4 hover:bg-gray-50">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-gray-900 truncate">{b.fileName}</div>
                  <div className="text-xs text-gray-500">{b.bankName} · {dateLabel(b.periodFrom)} – {dateLabel(b.periodTo)} · by {b.importedByName} on {formatDateTime(b.importedAt)}</div>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-gray-600">{b.rowsNew} new, {b.rowsDuplicate} skipped</span>
                  <Chip tone={STATUS_CHIP[b.balanceCheckStatus].tone}>{STATUS_CHIP[b.balanceCheckStatus].text}</Chip>
                </div>
              </div>
            </Link>
          ))}
        </Card>
      </section>
    </div>
  );
}
