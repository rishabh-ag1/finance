import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/lib/money';
import { batchChecks, orderChecks } from '../../src/recon/checks';
import type { Collections, OrderFacts, ReconRules } from '../../src/recon/status';

// BR-46 Discrepancy detection. Worked example: CRM order Rs 2,998, Razorpay captured Rs 2,499 (a
// coupon not recorded in the CRM): type 1, amount Rs 499, action 'correct CRM order or chase customer'.
const d = (v: string) => new Decimal(v);
const rules: ReconRules = { razorpaySettlementDays: 3, codRemittanceDays: 5, settlementToBankDays: 1, graceDays: 2, tolerance: d('1'), holidays: new Set() };
const order = (o: Partial<OrderFacts> = {}): OrderFacts => ({
  orderNumber: 'BLC-260777', orderDate: '2026-10-05', channel: 'SHOPIFY', paymentMethod: 'RAZORPAY', totalAmount: d('2998'), advancePaid: d('0'), balanceDue: d('0'),
  crmStatus: 'CONFIRMED', isReplacement: false, codToCollect: null, shippedAt: null, deliveredAt: null, awb: null, ...o,
});
const none: Collections = { payments: [], remittances: [], direct: [], writtenOff: false };
const pay = (amount: string, extra: object = {}) => ({ amount: d(amount), capturedAt: '2026-10-05', refunded: d('0'), settledBatch: null, ...extra });
const types = (xs: { type: number }[]) => xs.map((x) => x.type).sort((a, b) => a - b);

describe('BR-46 order checks', () => {
  it('type 1: CRM Rs 2,998, Razorpay captured Rs 2,499 -> Rs 499', () => {
    const found = orderChecks(order(), { ...none, payments: [pay('2499')] }, rules, '2026-10-06');
    expect(found).toEqual([{ type: 1, amount: '499.00', detail: 'Order Rs 2998.00, collected Rs 2499.00', action: 'Correct the CRM order or chase the customer' }]);
  });
  it('within the Rs 1 tolerance nothing is raised', () => {
    expect(orderChecks(order(), { ...none, payments: [pay('2997.50')] }, rules, '2026-10-06')).toEqual([]);
  });
  it('type 2: a prepaid order with no gateway payment after the grace days', () => {
    expect(orderChecks(order(), none, rules, '2026-10-06')).toEqual([]);
    expect(types(orderChecks(order(), none, rules, '2026-10-07'))).toEqual([2]);
  });
  it('type 3: captured but not settled past the expected date; type 8: two payments', () => {
    expect(types(orderChecks(order(), { ...none, payments: [pay('2998')] }, rules, '2026-10-12'))).toEqual([3]);
    expect(types(orderChecks(order(), { ...none, payments: [pay('2998'), pay('2998')] }, rules, '2026-10-06'))).toEqual([1, 8]);
  });
  it('type 7: refunded but the order stands, or cancelled and not refunded', () => {
    expect(types(orderChecks(order(), { ...none, payments: [pay('2998', { refunded: d('2998') })] }, rules, '2026-10-06'))).toEqual([7]);
    expect(types(orderChecks(order({ crmStatus: 'CANCELLED' }), { ...none, payments: [pay('2998')] }, rules, '2026-10-06'))).toEqual([7]);
  });
  it('type 9: COD delivered and not remitted past the expected date; type 10: COD remitted differs', () => {
    const cod = order({ channel: 'WHATSAPP', paymentMethod: 'COD', totalAmount: d('1499'), codToCollect: d('1499'), deliveredAt: '2026-10-05', crmStatus: 'DELIVERED' });
    expect(types(orderChecks(cod, none, rules, '2026-10-13'))).toEqual([]);
    expect(types(orderChecks(cod, none, rules, '2026-10-14'))).toEqual([9]);
    expect(orderChecks(cod, { ...none, remittances: [{ amount: d('1399'), batch: { date: '2026-10-12', bankDate: null } }] }, rules, '2026-10-12'))
      .toEqual([{ type: 10, amount: '100.00', detail: 'COD to collect Rs 1499.00, remitted Rs 1399.00', action: 'Chase Shiprocket for the difference' }]);
  });
});

describe('BR-46 batch checks', () => {
  const batch = (over: object = {}) => ({ source: 'razorpay' as const, date: '2026-10-14', paymentGross: d('5996'), feesWithTax: d('141.51'), bankCredit: null, levels: [
    { level: 1 as const, label: '', difference: '0.00', ok: true }, { level: 2 as const, label: '', difference: '0.00', ok: true }, { level: 3 as const, label: '', difference: null, ok: null },
  ], ...over });
  it('B14 fees are 2% + 18% GST: nothing raised while the bank credit is not due yet', () => {
    expect(batchChecks(batch(), { ...rules, expectedFeeRate: d('2'), feeGstRate: d('18') }, '2026-10-14')).toEqual([]);
  });
  it('type 4: fees above the expected rate; type 5: not in the bank after the grace days', () => {
    const found = batchChecks(batch({ feesWithTax: d('200') }), { ...rules, expectedFeeRate: d('2'), feeGstRate: d('18') }, '2026-10-19');
    expect(found.map((f) => [f.type, f.amount])).toEqual([[4, '57.49'], [5, '0.00']]);
  });
  it('a non-zero tie-out level raises its type: level 1 -> 1, level 2 -> 11, level 3 -> 6', () => {
    const levels = [{ level: 1 as const, label: '', difference: '-500.00', ok: false }, { level: 2 as const, label: '', difference: '0.02', ok: false }, { level: 3 as const, label: '', difference: '-4.49', ok: false }];
    expect(batchChecks(batch({ levels, bankCredit: d('5850') }), { ...rules, expectedFeeRate: d('2'), feeGstRate: d('18') }, '2026-10-15').map((f) => [f.type, f.amount])).toEqual([[1, '500.00'], [11, '0.02'], [6, '4.49']]);
  });
});
