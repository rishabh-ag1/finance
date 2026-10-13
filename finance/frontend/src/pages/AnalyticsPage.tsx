import { Fragment, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import api from '../api';
import { Card, PageHeader, Select } from '../components/ui/kit';
import { formatINR } from '../lib/money';
import { cn } from '../lib/utils';
import { monthLabel } from './settings/api';

type Kind = 'expense' | 'income' | 'capex';
type Pivot = {
  fy: string; kind: Kind; months: string[]; currentMonth: string;
  rows: { categoryId: string; name: string; values: string[]; total: string; momPercent: string | null;
    subCategories: { subCategoryId: string; name: string; values: string[]; total: string }[] }[];
  totals: string[]; grandTotal: string;
};

const TABS: { kind: Kind; label: string; note: string }[] = [
  { kind: 'expense', label: 'Spending', note: 'Operating expense, COGS and interest: what makes up burn.' },
  { kind: 'income', label: 'Income', note: 'Operating income only. Capital, loans and related-party money are not income.' },
  { kind: 'capex', label: 'Capex', note: 'Tooling, equipment and patents. Kept out of burn.' },
];

const cell = (v: string) => (Number(v) === 0 ? <span className="text-gray-300">–</span> : formatINR(v, { decimals: false }));

/** Last day of the month, for ledger links. */
const monthEnd = (m: string) => `${m.slice(0, 8)}${new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate()}`;

/** FY labels from 26-27 (the company's first year) to the current one, newest first (BR-31). */
function fyOptions() {
  const now = new Date();
  const last = (now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1) % 100;
  const out: string[] = [];
  for (let y = last; y >= 26; y--) out.push(`${y}-${y + 1}`);
  return out;
}

// F131 category analytics: category x month for the FY, with sub-categories and drill-down to the ledger.
export function AnalyticsPage() {
  const [params, setParams] = useSearchParams();
  const kind = (TABS.find((t) => t.kind === params.get('kind'))?.kind ?? 'expense') as Kind;
  const fy = params.get('fy') ?? '';
  const [open, setOpen] = useState<Set<string>>(new Set());
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { replace: true }); };

  const { data: p, isLoading } = useQuery({
    queryKey: ['dashboard-categories', kind, fy],
    queryFn: async () => (await api.get<{ data: Pivot }>('/dashboard/categories', { params: { kind, fy: fy || undefined } })).data.data,
  });

  const ledger = (m: string | null, categoryId?: string, subCategoryId?: string) => {
    const q = new URLSearchParams({ direction: kind === 'income' ? 'in' : 'out' });
    if (m) { q.set('from', m); q.set('to', monthEnd(m)); } else if (p) { q.set('from', p.months[0]); q.set('to', monthEnd(p.months[p.months.length - 1])); }
    if (categoryId && categoryId !== 'none') q.set('categoryId', categoryId);
    if (subCategoryId && subCategoryId !== 'none') q.set('subCategoryId', subCategoryId);
    return `/ledger?${q}`;
  };
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="max-w-7xl mx-auto space-y-4">
      <PageHeader title="Category analytics" subtitle={TABS.find((t) => t.kind === kind)!.note} />

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5">
          {TABS.map((t) => (
            <button key={t.kind} type="button" onClick={() => set('kind', t.kind === 'expense' ? '' : t.kind)}
              className={cn('px-3 py-1.5 text-sm rounded-md', kind === t.kind ? 'bg-[#0c2c55] text-white' : 'text-gray-700 hover:bg-gray-50')}>
              {t.label}
            </button>
          ))}
        </div>
        {p && (
          <Select value={fy || p.fy} onChange={(e) => set('fy', e.target.value)} aria-label="Financial year" className="w-auto">
            {fyOptions().map((f) => <option key={f} value={f}>FY {f}</option>)}
          </Select>
        )}
      </div>

      {isLoading || !p ? <p className="text-sm text-gray-500">Loading…</p> : p.rows.length === 0 ? (
        <Card className="p-4 text-sm text-gray-500">Nothing in FY {p.fy} yet.</Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="min-w-full text-xs sm:text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="sticky left-0 bg-gray-50 text-left font-medium px-3 py-2 min-w-[10rem]">Category</th>
                {p.months.map((m) => (
                  <th key={m} className={cn('text-right font-medium px-2 py-2 whitespace-nowrap', m === p.currentMonth && 'text-[#0c2c55]')}>
                    {monthLabel(m).replace(' 20', " '")}
                  </th>
                ))}
                <th className="text-right font-medium px-3 py-2">FY total</th>
                <th className="text-right font-medium px-3 py-2 whitespace-nowrap" title="This month against last month">vs last month</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {p.rows.map((r) => (
                <Fragment key={r.categoryId}>
                  <tr className="hover:bg-gray-50/60">
                    <td className="sticky left-0 bg-white px-3 py-1.5">
                      <button type="button" onClick={() => toggle(r.categoryId)} className="inline-flex items-center gap-1 text-left font-medium text-gray-900">
                        {open.has(r.categoryId) ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}{r.name}
                      </button>
                    </td>
                    {r.values.map((v, i) => (
                      <td key={i} className="text-right num px-2 py-1.5 whitespace-nowrap">
                        {Number(v) === 0 || r.categoryId === 'none' ? cell(v) : <Link to={ledger(p.months[i], r.categoryId)} className="hover:underline">{cell(v)}</Link>}
                      </td>
                    ))}
                    <td className="text-right num px-3 py-1.5 font-medium whitespace-nowrap">
                      {r.categoryId === 'none' ? cell(r.total) : <Link to={ledger(null, r.categoryId)} className="hover:underline">{cell(r.total)}</Link>}
                    </td>
                    <td className={cn('text-right num px-3 py-1.5', r.momPercent && Number(r.momPercent) > 0 && kind !== 'income' && 'text-red-700', r.momPercent && Number(r.momPercent) < 0 && kind !== 'income' && 'text-emerald-700')}>
                      {r.momPercent === null ? <span className="text-gray-300">–</span> : `${Number(r.momPercent) > 0 ? '+' : ''}${r.momPercent}%`}
                    </td>
                  </tr>
                  {open.has(r.categoryId) && r.subCategories.map((s) => (
                    <tr key={s.subCategoryId} className="text-gray-600 bg-gray-50/40">
                      <td className="sticky left-0 bg-gray-50 pl-8 pr-3 py-1">{s.name}</td>
                      {s.values.map((v, i) => (
                        <td key={i} className="text-right num px-2 py-1 whitespace-nowrap">
                          {Number(v) === 0 || r.categoryId === 'none' ? cell(v) : <Link to={ledger(p.months[i], r.categoryId, s.subCategoryId)} className="hover:underline">{cell(v)}</Link>}
                        </td>
                      ))}
                      <td className="text-right num px-3 py-1 whitespace-nowrap">{cell(s.total)}</td>
                      <td />
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
            <tfoot className="bg-gray-50 font-semibold">
              <tr>
                <td className="sticky left-0 bg-gray-50 px-3 py-2">Total</td>
                {p.totals.map((v, i) => <td key={i} className="text-right num px-2 py-2 whitespace-nowrap">{cell(v)}</td>)}
                <td className="text-right num px-3 py-2 whitespace-nowrap">{formatINR(p.grandTotal, { decimals: false })}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </Card>
      )}
      <p className="text-xs text-gray-500">Click a category to see its sub-categories; click an amount to open those bank rows. Ignored rows and rows waiting for review are left out.</p>
    </div>
  );
}
