import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import api from '../../api';
import { Button, Card, PageHeader, Select, TextInput } from '../../components/ui/kit';
import { formatINR } from '../../lib/money';
import { useSettings, type BankAccount } from '../settings/api';
import { LedgerRows } from './LedgerRows';
import { TxnPanel } from './TxnPanel';
import { ManualEntry } from './ManualEntry';
import { useAuth } from '../../context/auth';
import { NATURE_LABEL, STATUS_LABEL, useCategories, type LedgerPage as Page, type Nature, type TxnStatus } from './ledgerApi';

const FILTERS = ['accountId', 'from', 'to', 'status', 'nature', 'categoryId', 'subCategoryId', 'direction', 'q'] as const;

// F014 ledger: every bank row with filters and running totals for the filter. Filters live in the
// address, so a filtered view can be bookmarked or shared.
export function LedgerPage() {
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const { hasPermission } = useAuth();
  const { data: accounts } = useSettings<BankAccount[]>('bank-accounts');
  const { data: cats } = useCategories();
  const filter = Object.fromEntries(FILTERS.map((k) => [k, params.get(k) ?? '']));
  const set = (k: (typeof FILTERS)[number], v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    setParams(next, { replace: true });
  };

  const query = useInfiniteQuery({
    queryKey: ['ledger', filter],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => (await api.get<{ data: Page }>('/bank/txns', {
      params: { ...Object.fromEntries(Object.entries(filter).filter(([, v]) => v)), offset: pageParam, limit: 100 },
    })).data.data,
    getNextPageParam: (last) => last.nextOffset ?? undefined,
  });
  const totals = query.data?.pages[0]?.totals;
  const rows = query.data?.pages.flatMap((p) => p.rows) ?? [];
  const active = FILTERS.some((k) => filter[k]);

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <PageHeader title="Bank ledger" subtitle="Every bank row with its category and nature. Click a row to categorise, split, link, ignore or see its history." action={hasPermission('financeBank', 'edit') && <Button variant="secondary" onClick={() => setAdding(true)}>Cash entry</Button>} />
      {adding && <ManualEntry onClose={() => setAdding(false)} onSaved={(id) => { setAdding(false); setOpen(id); }} />}

      <Card className="p-3 sm:p-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Select value={filter.accountId} onChange={(e) => set('accountId', e.target.value)} aria-label="Account">
            <option value="">All accounts</option>
            {accounts?.map((a) => <option key={a.id} value={a.id}>{a.bankName} {a.accountNumberMasked}</option>)}
          </Select>
          <Select value={filter.status} onChange={(e) => set('status', e.target.value)} aria-label="Status">
            <option value="">Any status</option>
            <option value="needs_review">Needs review</option>
            {(Object.keys(STATUS_LABEL) as TxnStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s].text}</option>)}
          </Select>
          <Select value={filter.nature} onChange={(e) => set('nature', e.target.value)} aria-label="Nature">
            <option value="">Any nature</option>
            {(Object.keys(NATURE_LABEL) as Nature[]).map((n) => <option key={n} value={n}>{NATURE_LABEL[n]}</option>)}
          </Select>
          <Select value={filter.categoryId} onChange={(e) => set('categoryId', e.target.value)} aria-label="Category">
            <option value="">Any category</option>
            {cats?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <TextInput type="date" value={filter.from} onChange={(e) => set('from', e.target.value)} aria-label="From" />
          <TextInput type="date" value={filter.to} onChange={(e) => set('to', e.target.value)} aria-label="To" />
          <Select value={filter.direction} onChange={(e) => set('direction', e.target.value)} aria-label="Direction">
            <option value="">In and out</option>
            <option value="in">Money in</option>
            <option value="out">Money out</option>
          </Select>
          <TextInput placeholder="Search party, UTR, notes" value={filter.q} onChange={(e) => set('q', e.target.value)} />
        </div>
        {active && <div className="mt-2 text-right"><Button variant="ghost" onClick={() => setParams({}, { replace: true })}>Clear filters</Button></div>}
      </Card>

      {totals && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Card className="p-3"><div className="text-xs text-gray-500">Rows</div><div className="text-lg font-semibold">{totals.count}</div></Card>
          <Card className="p-3"><div className="text-xs text-gray-500">Money in</div><div className="text-lg font-semibold num text-emerald-700">{formatINR(totals.inflow, { decimals: false })}</div></Card>
          <Card className="p-3"><div className="text-xs text-gray-500">Money out</div><div className="text-lg font-semibold num text-red-700">{formatINR(totals.outflow, { decimals: false })}</div></Card>
          <Card className="p-3"><div className="text-xs text-gray-500">Net</div><div className="text-lg font-semibold num">{formatINR(totals.net, { decimals: false })}</div></Card>
        </div>
      )}

      {query.isLoading && <p className="text-sm text-gray-500">Loading…</p>}
      {!query.isLoading && rows.length === 0 && <p className="text-sm text-gray-500">No transactions{active ? ' match these filters' : ' yet. Import a statement first'}.</p>}
      {rows.length > 0 && <LedgerRows rows={rows} cats={cats} onOpen={setOpen} />}
      {query.hasNextPage && <Button variant="secondary" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>Load more</Button>}

      {open && <TxnPanel id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
