import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../../api';
import { Button, Card, Chip, ErrorNote, Field, Modal, MoneyInput, PageHeader, Select, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { formatINR } from '../../lib/money';
import { apiErrorMessage } from '../../lib/utils';
import { dateLabel } from '../settings/api';
import { CategoryFields, type CategoryValue } from './CategoryFields';
import { PARTY_LABEL, useCategories, type Nature, type PartyType } from './ledgerApi';

type Rule = {
  id: string; name: string; priority: number; matchField: string; operator: string; matchValue: string;
  direction: 'debit' | 'credit' | null; amountMin: string | null; amountMax: string | null; setCategoryId: string;
  setSubCategoryId: string | null; setNature: Nature | null; setPartyType: PartyType | null; setDescription: string | null;
  isActive: boolean; isSeeded: boolean; target: string;
};

const FIELD_LABEL: Record<string, string> = { narration: 'Narration', counterparty_name: 'Party name', mode: 'Mode', remark: 'Remark', utr: 'UTR' };
const OP_LABEL: Record<string, string> = { contains: 'contains', equals: 'is', starts_with: 'starts with', regex: 'matches pattern' };

// F017 rules manager (BR-05 step 3): if a bank row looks like this, suggest that category.
export function RulesPage() {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('financeRules', 'edit');
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  const { data: rules } = useQuery({ queryKey: ['rules'], queryFn: async () => (await api.get<{ data: Rule[] }>('/bank/rules')).data.data });

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <PageHeader
        title="Categorisation rules"
        subtitle="New bank rows are matched against these in order (lowest number first). The first match suggests the category; you still confirm it in the review queue."
        action={canEdit && <Button onClick={() => setEditing('new')}>Add rule</Button>}
      />
      <Card className="divide-y divide-gray-100">
        {rules?.map((r) => (
          <button key={r.id} className={`w-full text-left p-3 sm:p-4 hover:bg-gray-50 ${r.isActive ? '' : 'opacity-50'}`} onClick={() => canEdit && setEditing(r)}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-medium text-gray-900"><span className="font-mono text-xs text-gray-400 mr-2">{r.priority}</span>{r.name}</div>
                <div className="text-sm text-gray-600">
                  If {r.direction === 'debit' ? 'money out' : r.direction === 'credit' ? 'money in' : 'a row'} has {FIELD_LABEL[r.matchField]} {OP_LABEL[r.operator]} “{r.matchValue}”
                  {r.amountMin || r.amountMax ? ` and amount ${r.amountMin ? `from ${formatINR(r.amountMin, { decimals: false })}` : ''}${r.amountMax ? ` up to ${formatINR(r.amountMax, { decimals: false })}` : ''}` : ''}
                </div>
                <div className="text-sm">→ {r.target}{r.setPartyType ? ` · ${PARTY_LABEL[r.setPartyType]}` : ''}</div>
              </div>
              <div className="flex gap-1.5">
                {r.isSeeded && <Chip>From the spec</Chip>}
                {!r.isActive && <Chip tone="amber">Off</Chip>}
              </div>
            </div>
          </button>
        ))}
      </Card>
      {editing && <RuleForm rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function RuleForm({ rule, onClose }: { rule: Rule | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: cats } = useCategories();
  const [f, setF] = useState({
    name: rule?.name ?? '', priority: String(rule?.priority ?? 100), matchField: rule?.matchField ?? 'counterparty_name',
    operator: rule?.operator ?? 'contains', matchValue: rule?.matchValue ?? '', direction: rule?.direction ?? '',
    amountMin: rule?.amountMin ?? '', amountMax: rule?.amountMax ?? '', setPartyType: rule?.setPartyType ?? '',
    setDescription: rule?.setDescription ?? '', isActive: rule?.isActive ?? true,
  });
  const [cat, setCat] = useState<CategoryValue>({ categoryId: rule?.setCategoryId ?? '', subCategoryId: rule?.setSubCategoryId ?? '', nature: rule?.setNature ?? '' });
  const body = {
    ...f, priority: Number(f.priority), direction: f.direction || null, setPartyType: f.setPartyType || null,
    setCategoryId: cat.categoryId, setSubCategoryId: cat.subCategoryId || null, setNature: cat.nature || null,
  };
  const save = useMutation({
    mutationFn: async () => (rule ? api.put(`/bank/rules/${rule.id}`, body) : api.post('/bank/rules', body)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['rules'] }); onClose(); },
  });
  const test = useMutation({
    mutationFn: async () => (await api.post<{ data: { matches: number; examples: { id: string; txnDate: string; counterpartyName: string | null; narrationRaw: string; debit: string; credit: string }[] } }>('/bank/rules/test', body)).data.data,
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <Modal title={rule ? 'Edit rule' : 'Add rule'} onClose={onClose} footer={<>
      <Button variant="secondary" onClick={() => test.mutate()} disabled={test.isPending}>Test</Button>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>
    </>}>
      <ErrorNote>{(save.isError && apiErrorMessage(save.error, 'Could not save')) || (test.isError && apiErrorMessage(test.error, 'Could not test'))}</ErrorNote>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Name" className="col-span-2"><TextInput value={f.name} onChange={set('name')} placeholder="Shiprocket freight" /></Field>
        <Field label="Order"><TextInput inputMode="numeric" value={f.priority} onChange={set('priority')} /></Field>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field label="Look at">
          <Select value={f.matchField} onChange={set('matchField')}>{Object.entries(FIELD_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        </Field>
        <Field label="It">
          <Select value={f.operator} onChange={set('operator')}>{Object.entries(OP_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        </Field>
        <Field label="Text"><TextInput value={f.matchValue} onChange={set('matchValue')} placeholder="SHIPROCKET" /></Field>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field label="Direction">
          <Select value={f.direction} onChange={set('direction')}><option value="">In or out</option><option value="debit">Money out</option><option value="credit">Money in</option></Select>
        </Field>
        <Field label="Amount from"><MoneyInput value={f.amountMin} onChange={set('amountMin')} /></Field>
        <Field label="Amount up to"><MoneyInput value={f.amountMax} onChange={set('amountMax')} /></Field>
      </div>
      <p className="text-sm font-medium text-gray-700 pt-1">Then suggest</p>
      {cats && <CategoryFields cats={cats} value={cat} onChange={setCat} compact />}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Party type">
          <Select value={f.setPartyType} onChange={set('setPartyType')}><option value="">—</option>{Object.entries(PARTY_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        </Field>
        <Field label="Description"><TextInput value={f.setDescription} onChange={set('setDescription')} /></Field>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Rule is on</label>
      {test.data && (
        <div className="text-sm bg-blue-50 rounded-lg p-3">
          <p className="font-medium">Matches {test.data.matches} past row{test.data.matches === 1 ? '' : 's'}.</p>
          <ul className="mt-1 text-xs text-gray-600 space-y-0.5">
            {test.data.examples.map((x) => <li key={x.id} className="truncate">{dateLabel(x.txnDate)} · {x.counterpartyName ?? x.narrationRaw} · {formatINR(/^0+(\.0+)?$/.test(x.debit) ? x.credit : x.debit)}</li>)}
          </ul>
        </div>
      )}
    </Modal>
  );
}
