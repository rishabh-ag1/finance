import { Link } from 'react-router';
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import api from '../../api';
import { Button, Chip, ErrorNote, Facts, Field, Modal, MoneyInput, Select, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { formatDateTime, formatAuditValue } from '../../lib/format';
import { formatINR } from '../../lib/money';
import { apiErrorMessage } from '../../lib/utils';
import { dateLabel } from '../settings/api';
import { CategoryFields, type CategoryValue } from './CategoryFields';
import { Attachments } from '../../components/Attachments';
import {
  categoryText, isZero, NATURE_LABEL, PARTY_LABEL, RELATED_LABEL, STATUS_LABEL, useCategories, useRefreshBank,
  type PartyType, type RelatedPartyType, type TxnDetail,
} from './ledgerApi';

type Mode = 'view' | 'categorise' | 'split' | 'ignore' | 'unsplit' | 'unpair';

/** One bank row: its facts, what it is, and every action a person can take on it (F014-F021). */
export function TxnPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('financeBank', 'edit');
  const { data: cats } = useCategories();
  const refresh = useRefreshBank();
  const [mode, setMode] = useState<Mode>('view');
  const { data: t } = useQuery({
    queryKey: ['txn', id],
    queryFn: async () => (await api.get<{ data: TxnDetail }>(`/bank/txns/${id}`)).data.data,
  });
  const { data: history } = useQuery({
    queryKey: ['audit', 'BankTxn', id],
    queryFn: async () => (await api.get<{ data: { rows: { id: string; action: string; field: string | null; oldValue: unknown; newValue: unknown; reason: string | null; userName: string; at: string }[] } }>('/audit', { params: { recordId: id, limit: 30 } })).data.data.rows,
  });

  const act = useMutation({
    mutationFn: async ({ path, body }: { path: string; body?: unknown }) => (await api.post(`/bank/txns/${id}/${path}`, body ?? {})).data,
    onSuccess: () => { refresh(); setMode('view'); },
  });

  if (!t) return <Modal title="Transaction" onClose={onClose}><p className="text-sm text-gray-500">Loading…</p></Modal>;

  const isDebit = !isZero(t.debit);
  const amount = isDebit ? t.debit : t.credit;
  const st = STATUS_LABEL[t.status];
  const catText = categoryText(cats, t.categoryId, t.subCategoryId);

  return (
    <Modal title={t.counterpartyName ?? 'Transaction'} onClose={onClose}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className={`text-2xl font-semibold num ${isDebit ? 'text-red-700' : 'text-emerald-700'}`}>{isDebit ? '-' : '+'}{formatINR(amount)}</div>
          <div className="text-sm text-gray-500">{dateLabel(t.txnDate)} · {t.bankName} {t.accountNumberMasked}</div>
        </div>
        <Chip tone={st.tone}>{st.text}</Chip>
      </div>

      <ErrorNote>{act.isError && apiErrorMessage(act.error, 'Could not save')}</ErrorNote>

      {mode === 'view' && (
        <>
          <Facts items={[
            { label: 'Category', value: t.status === 'split' ? `Split into ${t.splits.length} lines` : catText ?? <span className="text-amber-700">Not categorised</span> },
            { label: 'Nature', value: t.nature ? NATURE_LABEL[t.nature] : '—' },
            { label: 'Why', value: t.categorisationReason },
            ...(t.linkedDocType === 'PaymentOut' && t.linkedDocId ? [{ label: 'Payment', value: <Link to={`/payments/${t.linkedDocId}`} className="text-blue-700 hover:underline">Open the payment</Link> }] : []),
            { label: 'Party type', value: t.partyType ? PARTY_LABEL[t.partyType] : '—' },
            ...(t.nature === 'related_party' ? [{ label: 'Related party treatment', value: RELATED_LABEL[t.relatedPartyType ?? 'undecided'] }] : []),
            { label: 'Description', value: t.description },
            { label: 'Notes', value: t.notes ? <span className="whitespace-pre-line">{t.notes}</span> : null },
            { label: 'Mode / UTR', value: [t.mode && `${t.mode}${t.modeDetail ? ` ${t.modeDetail}` : ''}`, t.utr].filter(Boolean).join(' · ') || '—' },
            { label: 'Counterparty bank', value: [t.counterpartyIfsc, t.counterpartyAccount && `A/c ${t.counterpartyAccount}`].filter(Boolean).join(' · ') || '—' },
            { label: 'Balance after', value: formatINR(t.balance) },
          ]} />
          <p className="text-[11px] text-gray-400 font-mono break-all">{t.narrationRaw}</p>

          {t.status === 'split' && (
            <ul className="text-sm divide-y divide-gray-100 border border-gray-100 rounded-lg">
              {t.splits.map((s) => (
                <li key={s.id} className="px-3 py-2 flex justify-between gap-2">
                  <span>{categoryText(cats, s.categoryId, s.subCategoryId)} <span className="text-gray-400">· {NATURE_LABEL[s.nature]}</span>{s.description && <span className="block text-xs text-gray-500">{s.description}</span>}</span>
                  <span className="num whitespace-nowrap">{formatINR(s.amount)}</span>
                </li>
              ))}
            </ul>
          )}
          {t.pair && <p className="text-sm text-gray-600">Paired with {t.pair.bankName} on {dateLabel(t.pair.txnDate)} ({formatINR(isZero(t.pair.debit) ? t.pair.credit : t.pair.debit)}). Out of income and expense.</p>}

          {canEdit && (
            <div className="flex flex-wrap gap-2 pt-1">
              {t.status === 'suggested' && <Button disabled={act.isPending} onClick={() => act.mutate({ path: 'categorise', body: { categoryId: t.categoryId, subCategoryId: t.subCategoryId, nature: t.nature, partyType: t.partyType } })}>Accept suggestion</Button>}
              {['review', 'suggested', 'categorised'].includes(t.status) && <Button variant={t.status === 'suggested' ? 'secondary' : 'primary'} onClick={() => setMode('categorise')}>{t.status === 'categorised' ? 'Change category' : 'Categorise'}</Button>}
              {['review', 'suggested', 'categorised', 'split'].includes(t.status) && <Button variant="secondary" onClick={() => setMode('split')}>{t.status === 'split' ? 'Edit split' : 'Split'}</Button>}
              {t.status === 'split' && <Button variant="ghost" onClick={() => setMode('unsplit')}>Remove split</Button>}
              {t.status === 'transfer' && <Button variant="secondary" onClick={() => setMode('unpair')}>Not a transfer</Button>}
              {['review', 'suggested', 'categorised'].includes(t.status) && <Button variant="ghost" onClick={() => setMode('ignore')}>Ignore…</Button>}
              {t.status === 'ignored' && <Button variant="secondary" disabled={act.isPending} onClick={() => act.mutate({ path: 'restore' })}>Restore to review</Button>}
            </div>
          )}

          <div className="border-t border-gray-100 pt-3">
            <p className="text-sm font-medium text-gray-700 mb-1">Files</p>
            <Attachments compact recordType="BankTxn" recordId={t.id} kinds={['proof', 'bill', 'other']} />
          </div>

          {history && history.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-gray-600">History ({history.length})</summary>
              <ul className="mt-2 space-y-1 text-xs text-gray-600">
                {history.map((h) => (
                  <li key={h.id}>
                    <span className="text-gray-400">{formatDateTime(h.at)}</span> {h.userName}: {h.action === 'create' ? 'imported' : h.action === 'delete_refused' ? 'tried to delete (refused)' : `${h.field} → ${formatAuditValue(h.newValue)}`}
                    {h.reason && <span className="text-gray-400"> ({h.reason})</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      {mode === 'categorise' && cats && <CategoriseForm t={t} pending={act.isPending} onCancel={() => setMode('view')} onSave={(body) => act.mutate({ path: 'categorise', body })} cats={cats} />}
      {mode === 'split' && cats && <SplitForm t={t} pending={act.isPending} onCancel={() => setMode('view')} onSave={(lines) => act.mutate({ path: 'split', body: { lines } })} cats={cats} />}
      {mode === 'ignore' && (
        <ReasonForm
          label="Why is this row ignored?"
          hint="Ignored rows stay in the ledger but are left out of every dashboard. Nothing is deleted."
          action="Ignore"
          pending={act.isPending}
          onCancel={() => setMode('view')}
          onSave={(note) => act.mutate({ path: 'ignore', body: { note } })}
        />
      )}
      {mode === 'unsplit' && <ReasonForm label="Why remove the split?" action="Remove split" pending={act.isPending} onCancel={() => setMode('view')} onSave={(reason) => act.mutate({ path: 'unsplit', body: { reason } })} />}
      {mode === 'unpair' && <ReasonForm label="Why is this not a transfer between own accounts?" hint="Both rows go back to review." action="Unpair" pending={act.isPending} onCancel={() => setMode('view')} onSave={(reason) => act.mutate({ path: 'unpair', body: { reason } })} />}
    </Modal>
  );
}

function ReasonForm({ label, hint, action, pending, onCancel, onSave }: { label: string; hint?: string; action: string; pending: boolean; onCancel: () => void; onSave: (text: string) => void }) {
  const [text, setText] = useState('');
  return (
    <div className="space-y-3">
      <Field label={label} hint={hint}><TextInput autoFocus value={text} onChange={(e) => setText(e.target.value)} /></Field>
      <div className="flex gap-2 justify-end">
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button disabled={pending || text.trim().length < 3} onClick={() => onSave(text)}>{action}</Button>
      </div>
    </div>
  );
}

function CategoriseForm({ t, cats, pending, onCancel, onSave }: {
  t: TxnDetail; cats: NonNullable<ReturnType<typeof useCategories>['data']>; pending: boolean; onCancel: () => void; onSave: (body: unknown) => void;
}) {
  const [cat, setCat] = useState<CategoryValue>({ categoryId: t.categoryId ?? '', subCategoryId: t.subCategoryId ?? '', nature: '' });
  const [partyType, setPartyType] = useState<PartyType | ''>(t.partyType ?? '');
  const [description, setDescription] = useState(t.description ?? '');
  const [notes, setNotes] = useState(t.notes ?? '');
  const [related, setRelated] = useState<RelatedPartyType>(t.relatedPartyType ?? 'undecided');
  const c = cats.find((x) => x.id === cat.categoryId);
  const nature = cat.nature || c?.subCategories.find((s) => s.id === cat.subCategoryId)?.nature || c?.natureDefault;

  return (
    <div className="space-y-3">
      <CategoryFields cats={cats} value={cat} onChange={setCat} />
      {nature === 'related_party' && (
        <Field label="Related party treatment (BR-29)" hint="Decide with the CA; shown in the related-party report.">
          <Select value={related} onChange={(e) => setRelated(e.target.value as RelatedPartyType)}>
            {Object.entries(RELATED_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </Field>
      )}
      <Field label="Party type">
        <Select value={partyType} onChange={(e) => setPartyType(e.target.value as PartyType | '')}>
          <option value="">—</option>
          {Object.entries(PARTY_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
      </Field>
      <Field label="Description" hint="Shown in the ledger instead of the bank narration"><TextInput value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <Field label="Notes"><TextInput value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <div className="flex gap-2 justify-end">
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button disabled={pending || !cat.categoryId} onClick={() => onSave({
          categoryId: cat.categoryId, subCategoryId: cat.subCategoryId || null, nature: cat.nature || null,
          partyType: partyType || null, description, notes, relatedPartyType: nature === 'related_party' ? related : null,
        })}>Save</Button>
      </div>
    </div>
  );
}

type Line = CategoryValue & { amount: string; description: string };

function SplitForm({ t, cats, pending, onCancel, onSave }: {
  t: TxnDetail; cats: NonNullable<ReturnType<typeof useCategories>['data']>; pending: boolean; onCancel: () => void; onSave: (lines: unknown[]) => void;
}) {
  const total = isZero(t.debit) ? t.credit : t.debit;
  const empty: Line = { amount: '', categoryId: '', subCategoryId: '', nature: '', description: '' };
  const [lines, setLines] = useState<Line[]>(t.splits.length
    ? t.splits.map((s) => ({ amount: s.amount, categoryId: s.categoryId, subCategoryId: s.subCategoryId ?? '', nature: '', description: s.description ?? '' }))
    : [{ ...empty, categoryId: t.categoryId ?? '', subCategoryId: t.subCategoryId ?? '' }, empty]);
  const set = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  // Paise as whole numbers, only for showing what is left to allocate; the server checks the sum.
  const paise = (v: string) => { const m = v.replace(/,/g, '').match(/^(\d+)(?:\.(\d{1,2}))?$/); return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : NaN; };
  const left = paise(total) - lines.reduce((s, l) => s + (paise(l.amount) || 0), 0);

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600">Lines must add up to {formatINR(total)} exactly (BR-07).</p>
      {lines.map((l, i) => (
        <div key={i} className="rounded-lg border border-gray-200 p-3 space-y-2">
          <div className="flex items-end gap-2">
            <Field label={`Line ${i + 1} amount`} className="flex-1"><MoneyInput value={l.amount} onChange={(e) => set(i, { amount: e.target.value })} /></Field>
            {lines.length > 2 && <Button variant="ghost" aria-label="Remove line" onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 className="w-4 h-4" /></Button>}
          </div>
          <CategoryFields compact cats={cats} value={l} onChange={(v) => set(i, v)} />
          <TextInput placeholder="Description (optional)" value={l.description} onChange={(e) => set(i, { description: e.target.value })} />
        </div>
      ))}
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" onClick={() => setLines([...lines, empty])}><Plus className="w-4 h-4 inline" /> Add line</Button>
        <span className={`text-sm num ${left === 0 ? 'text-emerald-700' : 'text-amber-700'}`}>
          {Number.isNaN(left) ? '' : left === 0 ? 'Adds up' : `${left > 0 ? 'Left' : 'Over'}: ${formatINR((Math.abs(left) / 100).toFixed(2))}`}
        </span>
      </div>
      <div className="flex gap-2 justify-end">
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button disabled={pending || left !== 0} onClick={() => onSave(lines.map((l) => ({
          amount: l.amount, categoryId: l.categoryId, subCategoryId: l.subCategoryId || null, nature: l.nature || null, description: l.description || null,
        })))}>Save split</Button>
      </div>
    </div>
  );
}
