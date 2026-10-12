import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../api';
import { Button, Card, Chip, ErrorNote, Field, Modal, PageHeader, Select, TextInput } from '../components/ui/kit';
import { useAuth } from '../context/auth';
import { apiErrorMessage } from '../lib/utils';

type Nature =
  | 'operating_income' | 'operating_expense' | 'cogs' | 'capex' | 'financing_in' | 'financing_out' | 'interest'
  | 'tax_payment' | 'advance' | 'transfer' | 'related_party' | 'refund_reversal' | 'reimbursement';

type Sub = { id: string; name: string; natureOverride: Nature | null; nature: Nature; plGroup: string | null; note: string | null; isActive: boolean };
type Category = { id: string; name: string; natureDefault: Nature; isActive: boolean; subCategories: Sub[] };

const NATURE: Record<Nature, { label: string; tone: 'gray' | 'green' | 'amber' | 'red' | 'blue' }> = {
  operating_income: { label: 'Operating Income', tone: 'green' },
  operating_expense: { label: 'Operating Expense', tone: 'red' },
  cogs: { label: 'COGS', tone: 'red' },
  capex: { label: 'Capex', tone: 'amber' },
  financing_in: { label: 'Financing In', tone: 'blue' },
  financing_out: { label: 'Financing Out', tone: 'blue' },
  interest: { label: 'Interest', tone: 'red' },
  tax_payment: { label: 'Tax Payment', tone: 'gray' },
  advance: { label: 'Advance', tone: 'gray' },
  transfer: { label: 'Transfer', tone: 'gray' },
  related_party: { label: 'Related Party', tone: 'amber' },
  refund_reversal: { label: 'Refund/Reversal', tone: 'gray' },
  reimbursement: { label: 'Reimbursement', tone: 'gray' },
};

const IN_PNL: Nature[] = ['operating_income', 'operating_expense', 'cogs', 'interest'];

// Category Master with Nature (BR-04): nature decides what counts in P&L and burn.
export function CategoriesPage() {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('financeSettings', 'edit');
  const [filter, setFilter] = useState('');
  const [editingSub, setEditingSub] = useState<{ category: Category; sub: Sub | null } | null>(null);
  const [editingCat, setEditingCat] = useState<Category | 'new' | null>(null);
  const { data: cats, isLoading } = useQuery({
    queryKey: ['categories'],
    queryFn: async () => (await api.get<{ data: Category[] }>('/categories')).data.data,
  });

  const q = filter.trim().toLowerCase();
  const shown = (cats ?? [])
    .map((c) => ({ ...c, subCategories: c.subCategories.filter((s) => !q || c.name.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)) }))
    .filter((c) => c.subCategories.length > 0 || c.name.toLowerCase().includes(q));

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <PageHeader
        title="Categories"
        subtitle={<>Each sub-category has a <strong>nature</strong>. Only {IN_PNL.map((n) => NATURE[n].label).join(', ')} count in P&L; capex, loans, tax and transfers stay out of burn.</>}
        action={canEdit && <Button onClick={() => setEditingCat('new')}>Add category</Button>}
      />
      <TextInput placeholder="Search categories" value={filter} onChange={(e) => setFilter(e.target.value)} className="max-w-xs" />
      {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
      {shown.map((c) => (
        <Card key={c.id} className={c.isActive ? '' : 'opacity-60'}>
          <div className="px-4 py-3 border-b border-gray-100 flex flex-wrap items-center justify-between gap-2">
            <div className="font-semibold text-gray-900">{c.name} {!c.isActive && <Chip>Off</Chip>}</div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">Default</span>
              <Chip tone={NATURE[c.natureDefault].tone}>{NATURE[c.natureDefault].label}</Chip>
              {canEdit && <Button variant="ghost" onClick={() => setEditingCat(c)}>Edit</Button>}
              {canEdit && <Button variant="ghost" onClick={() => setEditingSub({ category: c, sub: null })}>+ Sub</Button>}
            </div>
          </div>
          <ul className="divide-y divide-gray-50">
            {c.subCategories.map((s) => (
              <li key={s.id} className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-sm">
                <div className="min-w-0">
                  <span className={s.isActive ? 'text-gray-900' : 'text-gray-400 line-through'}>{s.name}</span>
                  {s.note && <span className="block text-xs text-gray-500">{s.note}</span>}
                </div>
                <div className="flex items-center gap-2">
                  {s.plGroup && <span className="text-xs text-gray-400 hidden sm:inline">{s.plGroup}</span>}
                  <Chip tone={NATURE[s.nature].tone}>{NATURE[s.nature].label}</Chip>
                  {canEdit && <Button variant="ghost" onClick={() => setEditingSub({ category: c, sub: s })}>Edit</Button>}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ))}
      {editingSub && <SubForm category={editingSub.category} sub={editingSub.sub} onClose={() => setEditingSub(null)} />}
      {editingCat && <CategoryForm category={editingCat === 'new' ? null : editingCat} onClose={() => setEditingCat(null)} />}
    </div>
  );
}

function useSave(url: string, method: 'post' | 'put') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: unknown) => (await api[method](url, body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['categories'] }),
  });
}

function NatureSelect({ value, onChange }: { value: Nature; onChange: (n: Nature) => void }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value as Nature)}>
      {(Object.keys(NATURE) as Nature[]).map((n) => <option key={n} value={n}>{NATURE[n].label}</option>)}
    </Select>
  );
}

function CategoryForm({ category, onClose }: { category: Category | null; onClose: () => void }) {
  const [f, setF] = useState({ name: category?.name ?? '', natureDefault: category?.natureDefault ?? ('operating_expense' as Nature), isActive: category?.isActive ?? true });
  const save = useSave(category ? `/categories/${category.id}` : '/categories', category ? 'put' : 'post');
  return (
    <Modal title={category ? 'Edit category' : 'Add category'} onClose={onClose} footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button disabled={save.isPending} onClick={() => save.mutate(f, { onSuccess: onClose })}>Save</Button>
    </>}>
      <ErrorNote>{save.isError && apiErrorMessage(save.error, 'Could not save')}</ErrorNote>
      <Field label="Name"><TextInput value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Default nature" hint="Sub-categories use this unless they set their own."><NatureSelect value={f.natureDefault} onChange={(natureDefault) => setF({ ...f, natureDefault })} /></Field>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> In use</label>
    </Modal>
  );
}

function SubForm({ category, sub, onClose }: { category: Category; sub: Sub | null; onClose: () => void }) {
  const [f, setF] = useState({
    categoryId: category.id, name: sub?.name ?? '', nature: sub?.nature ?? category.natureDefault,
    plGroup: sub?.plGroup ?? '', note: sub?.note ?? '', isActive: sub?.isActive ?? true,
  });
  const save = useSave(sub ? `/categories/sub/${sub.id}` : '/categories/sub', sub ? 'put' : 'post');
  return (
    <Modal title={sub ? `Edit ${category.name} › ${sub.name}` : `Add to ${category.name}`} onClose={onClose} footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button disabled={save.isPending} onClick={() => save.mutate(f, { onSuccess: onClose })}>Save</Button>
    </>}>
      <ErrorNote>{save.isError && apiErrorMessage(save.error, 'Could not save')}</ErrorNote>
      <Field label="Name"><TextInput value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Nature" hint="Existing transactions keep the nature they were given."><NatureSelect value={f.nature} onChange={(nature) => setF({ ...f, nature })} /></Field>
      <Field label="Management P&L group"><TextInput value={f.plGroup} onChange={(e) => setF({ ...f, plGroup: e.target.value })} /></Field>
      <Field label="Note"><TextInput value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> In use</label>
    </Modal>
  );
}
