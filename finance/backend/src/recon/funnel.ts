import { Decimal } from '../lib/money';

/**
 * D36 order-to-bank funnel and D37 days to bank. Pure functions over each tracked order's state
 * (BR-44): its route, status, order value, what was collected and when it reached the bank.
 */

export type FunnelRow = { orderMonth: string; orderDate: string; route: string; status: string; orderValue: Decimal; collected: Decimal; bankDate: string | null };

const SETTLED = new Set(['settled', 'remitted', 'in_bank']);
const GONE = new Set(['refunded', 'rto_cancelled']);
const zero = () => new Decimal(0);
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export function funnelByMonth(rows: FunnelRow[]) {
  const by = new Map<string, { orders: number; orderValue: Decimal; collected: Decimal; settled: Decimal; inBank: Decimal; refundedOrRto: Decimal }>();
  for (const r of rows) {
    const m = by.get(r.orderMonth) ?? { orders: 0, orderValue: zero(), collected: zero(), settled: zero(), inBank: zero(), refundedOrRto: zero() };
    m.orders += 1;
    m.orderValue = m.orderValue.plus(r.orderValue);
    if (GONE.has(r.status)) m.refundedOrRto = m.refundedOrRto.plus(r.orderValue);
    else {
      m.collected = m.collected.plus(r.collected);
      if (SETTLED.has(r.status)) m.settled = m.settled.plus(r.collected);
      if (r.status === 'in_bank') m.inBank = m.inBank.plus(r.collected);
    }
    by.set(r.orderMonth, m);
  }
  return [...by.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([month, m]) => ({
    month, orders: m.orders, orderValue: m.orderValue.toFixed(2), collected: m.collected.toFixed(2), settled: m.settled.toFixed(2), inBank: m.inBank.toFixed(2), refundedOrRto: m.refundedOrRto.toFixed(2),
  }));
}

/** Nearest-rank percentile. */
export function percentile(values: number[], p: number) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
}

export function daysToBank(rows: FunnelRow[]) {
  const by = new Map<string, number[]>();
  for (const r of rows) {
    if (r.status !== 'in_bank' || !r.bankDate) continue;
    by.set(r.route, [...(by.get(r.route) ?? []), days(r.orderDate, r.bankDate)]);
  }
  return [...by.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([route, v]) => ({
    route, orders: v.length, averageDays: Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 10) / 10, p90Days: percentile(v, 90),
  }));
}
