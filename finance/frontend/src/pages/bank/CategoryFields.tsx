import { Field, Select } from '../../components/ui/kit';
import { NATURE_LABEL, type Category, type Nature } from './ledgerApi';

export type CategoryValue = { categoryId: string; subCategoryId: string; nature: Nature | '' };

/** Category + sub-category + nature (defaults to the sub-category's, can be overridden, BR-04). */
export function CategoryFields({ cats, value, onChange, compact }: {
  cats: Category[];
  value: CategoryValue;
  onChange: (v: CategoryValue) => void;
  compact?: boolean;
}) {
  const active = cats.filter((c) => c.isActive || c.id === value.categoryId);
  const cat = cats.find((c) => c.id === value.categoryId);
  const subs = (cat?.subCategories ?? []).filter((s) => s.isActive || s.id === value.subCategoryId);
  const sub = subs.find((s) => s.id === value.subCategoryId);
  const defaultNature = sub?.nature ?? cat?.natureDefault;

  return (
    <div className={compact ? 'grid grid-cols-1 sm:grid-cols-3 gap-2' : 'space-y-3'}>
      <Field label="Category">
        <Select value={value.categoryId} onChange={(e) => onChange({ categoryId: e.target.value, subCategoryId: '', nature: '' })}>
          <option value="">Choose…</option>
          {active.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </Field>
      <Field label="Sub-category">
        <Select value={value.subCategoryId} disabled={!cat} onChange={(e) => onChange({ ...value, subCategoryId: e.target.value, nature: '' })}>
          <option value="">{cat ? 'Choose…' : '—'}</option>
          {subs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
      </Field>
      <Field label="Nature" hint={defaultNature && !compact ? `Default for this category: ${NATURE_LABEL[defaultNature]}` : undefined}>
        <Select value={value.nature} disabled={!cat} onChange={(e) => onChange({ ...value, nature: e.target.value as Nature | '' })}>
          <option value="">{defaultNature ? `${NATURE_LABEL[defaultNature]} (default)` : '—'}</option>
          {(Object.keys(NATURE_LABEL) as Nature[]).filter((n) => n !== defaultNature).map((n) => <option key={n} value={n}>{NATURE_LABEL[n]}</option>)}
        </Select>
      </Field>
    </div>
  );
}
