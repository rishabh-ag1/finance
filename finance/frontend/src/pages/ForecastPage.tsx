import { Fragment, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import api from '../api';
import { Card, PageHeader } from '../components/ui/kit';
import { formatINR } from '../lib/money';
import { cn } from '../lib/utils';
import { dateLabel } from './settings/api';

type Item = { kind: 'bill' | 'advance' | 'tds' | 'claims' | 'regular' | 'receipt'; label: string; date: string | null; amount: string; link: string | null };
type Week = { from: string; to: string; opening: string; receipts: string; payments: string; closing: string; items: Item[] };
type Forecast = {
  asOf: string; openingCash: string; regularWeekly: string; regularBasis: { from: string; to: string; total: string };
  weeks: Week[]; closingCash: string; firstShortWeek: string | null;
  notIncluded: { openPurchaseOrders: { count: number; unbilled: string }; receipts: string; loans: string };
};

const KIND_LABEL: Record<Item['kind'], string> = { bill: 'Bill', advance: 'Advance', tds: 'TDS', claims: 'Founder', regular: 'Regular', receipt: 'In' };
const short = (v: string) => formatINR(v, { decimals: false });
const day = (d: string) => dateLabel(d).replace(/ \d{4}$/, '');

// F136 / D33: 13-week cash forecast from today's cash and what is due each week.
export function ForecastPage() {
  const [open, setOpen] = useState<Set<number>>(new Set([0]));
  const { data: f, isLoading } = useQuery({ queryKey: ['forecast'], queryFn: async () => (await api.get<{ data: Forecast }>('/dashboard/forecast')).data.data });
  if (isLoading || !f) return <p className="text-sm text-gray-500">Loading…</p>;
  const toggle = (i: number) => setOpen((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  const negative = (v: string) => v.startsWith('-');

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <PageHeader title="Cash forecast" subtitle="The next 13 weeks: today's cash, plus customer money on its way, less what is due each week. Anything already overdue is in this week." />
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <Card className="p-3"><div className="text-xs text-gray-500">Cash today</div><div className="text-lg font-semibold num">{short(f.openingCash)}</div></Card>
        <Card className="p-3"><div className="text-xs text-gray-500">After 13 weeks</div><div className={cn('text-lg font-semibold num', negative(f.closingCash) && 'text-red-700')}>{short(f.closingCash)}</div></Card>
        <Card className="p-3 col-span-2 sm:col-span-1"><div className="text-xs text-gray-500">Regular spending a week</div><div className="text-lg font-semibold num">{short(f.regularWeekly)}</div></Card>
      </div>
      {f.firstShortWeek && (
        <p className="flex items-start gap-2 text-sm text-red-800 bg-red-50 rounded-lg px-3 py-2"><AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> Cash runs out in the week of {dateLabel(f.firstShortWeek)} unless money comes in.</p>
      )}

      <Card className="overflow-hidden">
        <table className="w-full table-fixed text-xs sm:text-sm">
          <colgroup><col /><col className="w-20 sm:w-28" /><col className="w-20 sm:w-28" /><col className="w-24 sm:w-36" /></colgroup>
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="text-left font-medium px-3 py-2">Week</th>
              <th className="text-right font-medium px-2 py-2">In</th>
              <th className="text-right font-medium px-2 py-2">Out</th>
              <th className="text-right font-medium px-3 py-2">Cash left</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {f.weeks.map((w, i) => (
              <Fragment key={w.from}>
                <tr className="hover:bg-gray-50/60">
                  <td className="px-3 py-1.5">
                    <button type="button" onClick={() => toggle(i)} className="inline-flex items-start gap-1 text-left text-gray-900">
                      {open.has(i) ? <ChevronDown className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
                      <span>{day(w.from)} – {day(w.to)}{i === 0 && <span className="block text-gray-500">this week, and overdue</span>}</span>
                    </button>
                  </td>
                  <td className="text-right num px-2 py-1.5 whitespace-nowrap text-emerald-700">{w.receipts === '0.00' ? <span className="text-gray-300">–</span> : short(w.receipts)}</td>
                  <td className="text-right num px-2 py-1.5 whitespace-nowrap">{w.payments === '0.00' ? <span className="text-gray-300">–</span> : short(w.payments)}</td>
                  <td className={cn('text-right num px-3 py-1.5 font-medium whitespace-nowrap', negative(w.closing) && 'text-red-700')}>{short(w.closing)}</td>
                </tr>
                {open.has(i) && w.items.map((it, j) => (
                  <tr key={j} className="text-gray-600 bg-gray-50/40">
                    <td className="pl-6 pr-2 py-1 break-words">
                      <span className="text-[11px] uppercase tracking-wide text-gray-400 mr-1.5">{KIND_LABEL[it.kind]}</span>
                      {it.link ? <Link to={it.link} className="hover:underline">{it.label}</Link> : it.label}
                      {it.date && <span className="text-gray-400"> · due {dateLabel(it.date)}</span>}
                    </td>
                    <td className="text-right num px-2 py-1 whitespace-nowrap text-emerald-700">{it.kind === 'receipt' ? short(it.amount) : ''}</td>
                    <td className="text-right num px-2 py-1 whitespace-nowrap">{it.kind === 'receipt' ? '' : short(it.amount)}</td>
                    <td />
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </Card>

      <Card className="p-3 sm:p-4 text-xs text-gray-600 space-y-1">
        <p><span className="font-medium text-gray-800">How it is worked out.</span> Bills and advances fall in the week they are due; TDS by its deposit date; what is owed to founders in this week. Money in: Razorpay payments, COD delivered and settlements not yet in the bank, on the day each is expected in the bank (Order-to-bank). Regular spending is spending with no bill (salaries, rent, subscriptions): the weekly average of {dateLabel(f.regularBasis.from)} to {dateLabel(f.regularBasis.to)} ({short(f.regularBasis.total)} over 13 weeks).</p>
        <p><span className="font-medium text-gray-800">Not in the weeks yet.</span> {f.notIncluded.receipts}. {f.notIncluded.loans}. {f.notIncluded.openPurchaseOrders.count > 0 ? `${f.notIncluded.openPurchaseOrders.count} open purchase order(s) with ${short(f.notIncluded.openPurchaseOrders.unbilled)} not yet billed or paid in advance have no dates, so they are left out.` : 'No open purchase orders.'}</p>
      </Card>
    </div>
  );
}
