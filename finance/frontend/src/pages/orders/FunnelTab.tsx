import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '../../api';
import { Card, Field, TextInput } from '../../components/ui/kit';
import { formatINR } from '../../lib/money';

type Funnel = {
  months: { month: string; orders: number; orderValue: string; collected: string; settled: string; inBank: string; refundedOrRto: string }[];
  daysToBank: { route: string; orders: number; averageDays: number; p90Days: number }[];
};
const ROUTE: Record<string, string> = { razorpay: 'Razorpay', cod: 'COD (Shiprocket)', direct: 'Direct to bank', marketplace: 'Marketplace' };
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });
const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const back = (days: number) => new Date(Date.now() + 5.5 * 3600_000 - days * 86_400_000).toISOString().slice(0, 10);

/** D36 where each month's order value is; D37 how fast money reaches the bank, by route. */
export function FunnelTab() {
  const [from, setFrom] = useState(back(90).slice(0, 8) + '01');
  const [to, setTo] = useState(today());
  const { data } = useQuery({ queryKey: ['recon-funnel', from, to], queryFn: async () => (await api.get<{ data: Funnel }>('/recon/funnel', { params: { from, to } })).data.data });
  const pct = (a: string, b: string) => (Number(b) ? `${Math.round((Number(a) / Number(b)) * 100)}%` : '–');
  return (
    <div className="space-y-4">
      <Card className="p-3 flex flex-wrap items-end gap-2">
        <Field label="Orders placed from" className="w-40"><TextInput type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="to" className="w-40"><TextInput type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </Card>
      {!data ? <p className="text-sm text-gray-500">Loading…</p> : (
        <>
          <Card className="p-4 space-y-2">
            <h2 className="font-semibold text-gray-900">Funnel by order month</h2>
            {data.months.length === 0 ? <p className="text-sm text-gray-500">No tracked orders in the period.</p> : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs sm:text-sm">
                  <thead><tr className="text-left text-gray-500"><th className="py-1 pr-2">Month</th><th className="text-right pr-2">Orders</th><th className="text-right pr-2">Order value</th><th className="text-right pr-2">Collected</th><th className="text-right pr-2">Settled / remitted</th><th className="text-right pr-2">In bank</th><th className="text-right">Refunded / RTO</th></tr></thead>
                  <tbody className="divide-y divide-gray-100">
                    {data.months.map((m) => (
                      <tr key={m.month}>
                        <td className="py-1.5 pr-2 whitespace-nowrap">{monthName(m.month)}</td><td className="text-right pr-2">{m.orders}</td>
                        <td className="text-right num pr-2">{formatINR(m.orderValue, { decimals: false })}</td>
                        <td className="text-right num pr-2">{formatINR(m.collected, { decimals: false })}</td>
                        <td className="text-right num pr-2">{formatINR(m.settled, { decimals: false })}</td>
                        <td className="text-right num pr-2">{formatINR(m.inBank, { decimals: false })} <span className="text-xs text-gray-500">{pct(m.inBank, m.orderValue)}</span></td>
                        <td className="text-right num">{formatINR(m.refundedOrRto, { decimals: false })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <Card className="p-4 space-y-2">
            <h2 className="font-semibold text-gray-900">Days to bank</h2>
            <p className="text-xs text-gray-500">From the order date to the date the money reached the IDFC account, for orders already in the bank.</p>
            {data.daysToBank.length === 0 ? <p className="text-sm text-gray-500">No orders in the bank yet.</p> : (
              <ul className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {data.daysToBank.map((r) => (
                  <li key={r.route} className="rounded-lg bg-gray-50 px-3 py-2 text-sm">
                    <div className="text-xs text-gray-500">{ROUTE[r.route] ?? r.route} · {r.orders} order(s)</div>
                    <div><span className="text-lg font-semibold">{r.averageDays}</span> days on average · 90% within {r.p90Days}</div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
