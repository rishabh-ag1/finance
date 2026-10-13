import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../api';
import { Button, Field, Select, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { apiErrorMessage } from '../../lib/utils';
import { NATURE_LABEL, type Category, type Nature } from './ledgerApi';

export type CategoryValue = { categoryId: string; subCategoryId: string; nature: Nature | '' };

const NEW = '__new__';

/**
 * Category + sub-category + nature (defaults to the sub-category's, can be overridden, BR-04).
 * People who may edit settings can add a category or sub-category right here (D10); it is the
 * same as adding it on the Categories page and is audited the same way.
 */
export function CategoryFields({ cats, value, onChange, compact }: {
  cats: Category[];
  value: CategoryValue;
  onChange: (v: CategoryValue) => void;
  compact?: boolean;
}) {
  const { hasPermission } = useAuth();
  const canAdd = hasPermission('financeSettings', 'edit');
  const [adding, setAdding] = useState<'category' | 'sub' | null>(null);
  const active = cats.filter((c) => c.isActive || c.id === value.categoryId);
  const cat = cats.find((c) => c.id === value.categoryId);
  const subs = (cat?.subCategories ?? []).filter((s) => s.isActive || s.id === value.subCategoryId);
  const sub = subs.find((s) => s.id === value.subCategoryId);
  const defaultNature = sub?.nature ?? cat?.natureDefault;

  return (
    <div className="space-y-2">
      <div className={compact ? 'grid grid-cols-1 sm:grid-cols-3 gap-2' : 'space-y-3'}>
        <Field label="Category">
          <Select value={value.categoryId} onChange={(e) => {
            if (e.target.value === NEW) { setAdding('category'); return; }
            onChange({ categoryId: e.target.value, subCategoryId: '', nature: '' });
          }}>
            <option value="">Choose…</option>
            {active.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            {canAdd && <option value={NEW}>+ New category…</option>}
          </Select>
        </Field>
        <Field label="Sub-category">
          <Select value={value.subCategoryId} disabled={!cat} onChange={(e) => {
            if (e.target.value === NEW) { setAdding('sub'); return; }
            onChange({ ...value, subCategoryId: e.target.value, nature: '' });
          }}>
            <option value="">{cat ? 'Choose…' : '—'}</option>
            {subs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            {canAdd && cat && <option value={NEW}>+ New sub-category in {cat.name}…</option>}
          </Select>
        </Field>
        <Field label="Nature" hint={defaultNature && !compact ? `Default for this category: ${NATURE_LABEL[defaultNature]}` : undefined}>
          <Select value={value.nature} disabled={!cat} onChange={(e) => onChange({ ...value, nature: e.target.value as Nature | '' })}>
            <option value="">{defaultNature ? `${NATURE_LABEL[defaultNature]} (default)` : '—'}</option>
            {(Object.keys(NATURE_LABEL) as Nature[]).filter((n) => n !== defaultNature).map((n) => <option key={n} value={n}>{NATURE_LABEL[n]}</option>)}
          </Select>
        </Field>
      </div>
      {adding && (
        <QuickAdd
          kind={adding}
          category={adding === 'sub' ? cat ?? null : null}
          onCancel={() => setAdding(null)}
          onAdded={(next) => { setAdding(null); onChange(next); }}
        />
      )}
    </div>
  );
}

/** Small inline form: name + nature. Returns the new selection to the picker. */
function QuickAdd({ kind, category, onCancel, onAdded }: {
  kind: 'category' | 'sub';
  category: Category | null;
  onCancel: () => void;
  onAdded: (v: CategoryValue) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [nature, setNature] = useState<Nature>(category?.natureDefault ?? 'operating_expense');
  const save = useMutation({
    mutationFn: async () => {
      const res = kind === 'category'
        ? await api.post<{ data: Category[] }>('/categories', { name, natureDefault: nature, isActive: true })
        : await api.post<{ data: Category[] }>('/categories/sub', { categoryId: category!.id, name, nature, isActive: true });
      return res.data.data;
    },
    onSuccess: (list) => {
      qc.setQueryData(['categories'], list);
      const trimmed = name.trim();
      if (kind === 'category') {
        const c = list.find((x) => x.name === trimmed);
        if (c) onAdded({ categoryId: c.id, subCategoryId: '', nature: '' });
      } else {
        const s = list.find((x) => x.id === category!.id)?.subCategories.find((x) => x.name === trimmed);
        if (s) onAdded({ categoryId: category!.id, subCategoryId: s.id, nature: '' });
      }
    },
  });
  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-3 space-y-2">
      <p className="text-sm font-medium text-gray-800">{kind === 'category' ? 'New category' : `New sub-category in ${category?.name}`}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <TextInput autoFocus placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <Select value={nature} onChange={(e) => setNature(e.target.value as Nature)} aria-label="Nature">
          {(Object.keys(NATURE_LABEL) as Nature[]).map((n) => <option key={n} value={n}>{NATURE_LABEL[n]}</option>)}
        </Select>
      </div>
      {save.isError && <p className="text-xs text-red-600">{apiErrorMessage(save.error, 'Could not add')}</p>}
      <div className="flex gap-2 justify-end">
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button disabled={name.trim().length < 2 || save.isPending} onClick={() => save.mutate()}>Add</Button>
      </div>
    </div>
  );
}
