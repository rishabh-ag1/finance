import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/lib/money';
import { daysToBank, funnelByMonth, percentile } from '../../src/recon/funnel';

const d = (v: string) => new Decimal(v);
const row = (o: object) => ({ orderMonth: '2026-10', orderDate: '2026-10-01', route: 'razorpay', status: 'in_bank', orderValue: d('1499'), collected: d('1499'), bankDate: '2026-10-06', ...o });

// D36 where each month's order value is; D37 how long money takes to reach the bank, by route.
describe('D36 order-to-bank funnel', () => {
  it('order value, then collected, settled or remitted, in bank, and refunded / RTO, by order month', () => {
    const f = funnelByMonth([
      row({}),
      row({ status: 'settled', bankDate: null }),
      row({ status: 'paid_at_gateway', bankDate: null }),
      row({ route: 'cod', status: 'awaiting_delivery', collected: d('0'), bankDate: null }),
      row({ route: 'cod', status: 'rto_cancelled', collected: d('0'), bankDate: null }),
      row({ orderMonth: '2026-09', orderDate: '2026-09-28', orderValue: d('11800'), collected: d('11800'), route: 'direct', bankDate: '2026-10-03' }),
    ]);
    expect(f).toEqual([
      { month: '2026-09', orders: 1, orderValue: '11800.00', collected: '11800.00', settled: '11800.00', inBank: '11800.00', refundedOrRto: '0.00' },
      { month: '2026-10', orders: 5, orderValue: '7495.00', collected: '4497.00', settled: '2998.00', inBank: '1499.00', refundedOrRto: '1499.00' },
    ]);
  });
});

describe('D37 days to bank', () => {
  it('average and 90th percentile of bank date - order date, by route', () => {
    const r = daysToBank([
      row({ orderDate: '2026-10-01', bankDate: '2026-10-06' }), row({ orderDate: '2026-10-01', bankDate: '2026-10-04' }), row({ orderDate: '2026-10-01', bankDate: '2026-10-11' }),
      row({ route: 'cod', orderDate: '2026-10-01', bankDate: '2026-10-15' }), row({ route: 'cod', status: 'remitted', bankDate: null }),
    ]);
    expect(r).toEqual([
      { route: 'cod', orders: 1, averageDays: 14, p90Days: 14 },
      { route: 'razorpay', orders: 3, averageDays: 6, p90Days: 10 },
    ]);
  });
  it('90th percentile by nearest rank', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([3], 90)).toBe(3);
  });
});
