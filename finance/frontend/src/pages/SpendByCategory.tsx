import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import api from '../api';
import { Card } from '../components/ui/kit';
import { formatINR } from '../lib/money';
import { cn } from '../lib/utils';

type Row = {
  categoryId: string | null; name: string; amount: string; sharePercent: string; transactions: number; previous: string | null; changePercent: string | null;
  topSubCategories: { name: string; amount: string }[];
};
type Data = { period: 'month' | '3m' | 'fy'; from: string; to: string; label: string; comparedWith: string | null; total: string; rows: Row[] };

const PERIODS: [Data['period'], string][] = [['month', 'This month'], ['3m', 'Last 3 months'], ['fy', 'This FY']];
const SHOWN = 10;
const short = (v: string) => {
  const n = Number(v);
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  if (n >= 1e3) return `₹${(n / 1e3).toFixed(1)}K`;
  return formatINR(v, { decimals: false });
};

/** D39: spend by category, largest first, to see which verticals to grow or cut. One hue; values at the bar tips. */
export function SpendByCategory() {
  const [period, setPeriod] = useState<Data['period']>('3m');
  const [view, setView] = useState<'cash' | 'accrual'>('cash');
  const [asTable, setAsTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const { data } = useQuery({ queryKey: ['home', 'spend-by-category', period, view], queryFn: async () => (await api.get<{ data: Data }>('/dashboard/spend-by-category', { params: { period, view } })).data.data });

  // Ten largest; the rest fold into "Other" so the chart stays readable.
  const rows = data?.rows ?? [];
  const shown = rows.slice(0, SHOWN);
  const rest = rows.slice(SHOWN);
  const other = rest.length ? { categoryId: null, name: `Other (${rest.length})`, amount: rest.reduce((s, r) => s + Number(r.amount), 0).toFixed(2), sharePercent: rest.reduce((s, r) => s + Number(r.sharePercent), 0).toFixed(1), transactions: rest.reduce((s, r) => s + r.transactions, 0), previous: null, changePercent: null, topSubCategories: rest.slice(0, 3).map((r) => ({ name: r.name, amount: r.amount })) } : null;
  const bars = other ? [...shown, other] : shown;
  const max = Math.max(...bars.map((b) => Number(b.amount)), 1);

  return (
    <Card className="p-3 sm:p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold text-gray-900">Spend by category</h2>
          <p className="text-xs text-gray-500">{data ? `${data.label}: ${formatINR(data.total, { decimals: false })} on operating costs, COGS and interest (capex apart)` : 'Loading…'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="inline-flex rounded-lg border border-gray-200 p-0.5" role="group" aria-label="Period">
            {PERIODS.map(([k, l]) => <button key={k} onClick={() => setPeriod(k)} className={cn('px-2 py-1 text-xs rounded-md', period === k ? 'bg-[#0c2c55] text-white' : 'text-gray-600 hover:bg-gray-50')}>{l}</button>)}
          </div>
          <div className="inline-flex rounded-lg border border-gray-200 p-0.5" role="group" aria-label="View">
            {(['cash', 'accrual'] as const).map((k) => <button key={k} onClick={() => setView(k)} className={cn('px-2 py-1 text-xs rounded-md', view === k ? 'bg-gray-800 text-white' : 'text-gray-600 hover:bg-gray-50')}>{k === 'cash' ? 'Cash' : 'Accrual'}</button>)}
          </div>
        </div>
      </div>

      {data && bars.length === 0 && <p className="text-sm text-gray-500 py-6 text-center">No spending recorded for this period yet.</p>}

      {data && bars.length > 0 && !asTable && (
        <ul className="space-y-0.5" onMouseLeave={() => setHover(null)}>
          {bars.map((b, i) => {
            const w = (Number(b.amount) / max) * 100;
            const change = b.changePercent === null ? null : Number(b.changePercent);
            const to = `/analytics?kind=expense&view=${view}${b.categoryId ? `&category=${b.categoryId}` : ''}`;
            return (
              <li key={`${b.categoryId}-${b.name}`} className="relative" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)}>
                <Link to={to} className={cn('block rounded-md px-1 py-1 sm:grid sm:grid-cols-[11rem_1fr] sm:items-center sm:gap-2', hover === i && 'bg-gray-50')} aria-label={`${b.name}: ${formatINR(b.amount)}, ${b.sharePercent}% of spend`}>
                  {/* Phone: name and value on one line, the bar full width below. Wider: name, then bar with the value at its tip. */}
                  <span className="flex sm:block items-baseline justify-between gap-2 min-w-0">
                    <span className="text-xs sm:text-sm text-gray-700 truncate" title={b.name}>{b.name}</span>
                    <span className="sm:hidden text-xs text-gray-900 num whitespace-nowrap">{short(b.amount)} <span className="text-gray-500">{Number(b.sharePercent).toFixed(0)}%</span>{change !== null && <span className="text-[11px] text-gray-500"> {change > 0 ? '▲' : change < 0 ? '▼' : '='}{Math.abs(change)}%</span>}</span>
                  </span>
                  <span className="mt-1 sm:mt-0 flex items-center gap-2 min-w-0">
                    <span className="sm:hidden h-2.5 rounded-r-[4px] bg-[#0c2c55] shrink-0 transition-[width]" style={{ width: `max(2px, ${w}%)` }} />
                    <span className="hidden sm:block h-3.5 rounded-r-[4px] bg-[#0c2c55] shrink-0 transition-[width]" style={{ width: `max(2px, calc(${w}% - 5.5rem))` }} />
                    <span className="hidden sm:inline text-xs text-gray-900 num whitespace-nowrap">{short(b.amount)} <span className="text-gray-500">{Number(b.sharePercent).toFixed(0)}%</span></span>
                    {change !== null && <span className="hidden sm:inline text-[11px] text-gray-500 whitespace-nowrap" title={`Against ${data.comparedWith}`}>{change > 0 ? '▲' : change < 0 ? '▼' : '='} {Math.abs(change)}%</span>}
                  </span>
                </Link>
                {hover === i && (
                  <div className="absolute z-20 left-1/3 top-full mt-1 w-64 max-w-[calc(100vw-3rem)] rounded-lg bg-white shadow-lg border border-gray-200 p-3 text-xs text-gray-700 pointer-events-none">
                    <div className="font-semibold text-gray-900 mb-1">{b.name}</div>
                    <div className="flex justify-between"><span>Spent</span><span className="num">{formatINR(b.amount)}</span></div>
                    <div className="flex justify-between"><span>Share of spend</span><span>{b.sharePercent}%</span></div>
                    {b.previous !== null && <div className="flex justify-between"><span>{data.comparedWith}</span><span className="num">{formatINR(b.previous)}{change !== null ? ` (${change > 0 ? '+' : ''}${change}%)` : ''}</span></div>}
                    <div className="flex justify-between"><span>Transactions</span><span>{b.transactions}</span></div>
                    {b.topSubCategories.length > 0 && (
                      <div className="mt-1.5 pt-1.5 border-t border-gray-100 space-y-0.5">
                        {b.topSubCategories.map((s) => <div key={s.name} className="flex justify-between gap-2"><span className="truncate">{s.name}</span><span className="num">{short(s.amount)}</span></div>)}
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {data && bars.length > 0 && asTable && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs sm:text-sm">
            <thead><tr className="text-left text-gray-500"><th className="py-1 pr-2">Category</th><th className="text-right pr-2">Spent</th><th className="text-right pr-2">Share</th>{data.comparedWith && <th className="text-right pr-2">{data.comparedWith}</th>}<th className="text-right">Transactions</th></tr></thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => (
                <tr key={`${r.categoryId}-${r.name}`}>
                  <td className="py-1 pr-2">{r.name}</td><td className="text-right num pr-2">{formatINR(r.amount, { decimals: false })}</td><td className="text-right pr-2">{r.sharePercent}%</td>
                  {data.comparedWith && <td className="text-right num pr-2">{r.previous ? formatINR(r.previous, { decimals: false }) : '–'}{r.changePercent ? ` (${Number(r.changePercent) > 0 ? '+' : ''}${r.changePercent}%)` : ''}</td>}
                  <td className="text-right">{r.transactions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && bars.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
          <span>{data.comparedWith ? `▲ / ▼ against ${data.comparedWith}. ` : ''}Hover a bar for its sub-categories; click to open it in Category analytics.</span>
          <span className="flex gap-3">
            <button className="text-[#0c2c55] hover:underline" onClick={() => setAsTable(!asTable)}>{asTable ? 'Show chart' : 'Show as table'}</button>
            <Link to={`/analytics?kind=expense&view=${view}`} className="text-[#0c2c55] hover:underline">Category analytics</Link>
          </span>
        </div>
      )}
    </Card>
  );
}
