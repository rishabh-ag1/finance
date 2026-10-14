import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/lib/money';
import { collectionRoute, orderPaymentStatus, type Collections, type OrderFacts, type ReconRules } from '../../src/recon/status';

// BR-44 Order payment status, computed from linked records, never typed.
// Worked example: COD order Rs 1,499 delivered 10 Oct: 'Delivered, awaiting remittance'. Shiprocket
// remittance on 15 Oct includes its AWB: 'Remitted'. Remittance credit hits IDFC 15 Oct and is
// matched: 'In bank'.
const d = (v: string) => new Decimal(v);
const rules: ReconRules = { razorpaySettlementDays: 3, codRemittanceDays: 5, settlementToBankDays: 1, graceDays: 2, tolerance: d('1'), holidays: new Set() };
const order = (o: Partial<OrderFacts> = {}): OrderFacts => ({
  orderNumber: 'BLC-260501', orderDate: '2026-10-06', channel: 'WHATSAPP', paymentMethod: 'COD', totalAmount: d('1499'), advancePaid: d('0'), balanceDue: d('1499'),
  crmStatus: 'SHIPPED', isReplacement: false, codToCollect: d('1499'), shippedAt: '2026-10-07', deliveredAt: null, awb: '1234567890', ...o,
});
const none: Collections = { payments: [], remittances: [], direct: [], writtenOff: false };

describe('BR-44 collection route', () => {
  it('follows the payment method; Shopify prepaid UPI is collected by Razorpay', () => {
    expect(collectionRoute(order({ paymentMethod: 'COD' }))).toBe('cod');
    expect(collectionRoute(order({ paymentMethod: 'RAZORPAY' }))).toBe('razorpay');
    expect(collectionRoute(order({ channel: 'SHOPIFY', paymentMethod: 'UPI' }))).toBe('razorpay');
    expect(collectionRoute(order({ channel: 'WHATSAPP', paymentMethod: 'UPI' }))).toBe('direct');
    expect(collectionRoute(order({ paymentMethod: 'BANK_TRANSFER' }))).toBe('direct');
    expect(collectionRoute(order({ paymentMethod: 'FREE' }))).toBe('none');
    expect(collectionRoute(order({ channel: 'AMAZON', paymentMethod: 'RAZORPAY' }))).toBe('marketplace');
  });
});

describe('BR-44 COD worked example', () => {
  it('Rs 1,499 delivered 10 Oct -> remitted 15 Oct -> in bank 15 Oct', () => {
    const delivered = orderPaymentStatus(order({ deliveredAt: '2026-10-10', crmStatus: 'DELIVERED' }), none, rules, '2026-10-12');
    expect(delivered).toMatchObject({ route: 'cod', status: 'delivered_awaiting_remittance', expectedAmount: '1499.00', expectedDate: '2026-10-16', overdue: false });
    const remitted = orderPaymentStatus(order({ deliveredAt: '2026-10-10' }), { ...none, remittances: [{ amount: d('1499'), batch: { date: '2026-10-15', bankDate: null } }] }, rules, '2026-10-15');
    expect(remitted).toMatchObject({ status: 'remitted', collected: '1499.00', expectedDate: '2026-10-16' });
    const inBank = orderPaymentStatus(order({ deliveredAt: '2026-10-10' }), { ...none, remittances: [{ amount: d('1499'), batch: { date: '2026-10-15', bankDate: '2026-10-15' } }] }, rules, '2026-10-15');
    expect(inBank).toMatchObject({ status: 'in_bank', bankDate: '2026-10-15', expectedDate: null, overdue: false });
  });
  it('not delivered yet: awaiting delivery, nothing expected; cancelled before delivery: RTO / cancelled', () => {
    expect(orderPaymentStatus(order(), none, rules, '2026-10-12').status).toBe('awaiting_delivery');
    expect(orderPaymentStatus(order({ crmStatus: 'CANCELLED' }), none, rules, '2026-10-12').status).toBe('rto_cancelled');
  });
});

describe('BR-44 Razorpay route and BR-45 overdue', () => {
  const rzp = order({ channel: 'SHOPIFY', paymentMethod: 'RAZORPAY', codToCollect: null });
  const captured = (settled: { date: string; bankDate: string | null } | null) => ({ amount: d('1499'), capturedAt: '2026-10-09', refunded: d('0'), settledBatch: settled });
  it('B13: captured Fri 9 Oct, not settled: expected Wed 14 Oct, overdue from Fri 16 Oct', () => {
    expect(orderPaymentStatus(rzp, none, rules, '2026-10-09').status).toBe('awaiting_payment');
    expect(orderPaymentStatus(rzp, { ...none, payments: [captured(null)] }, rules, '2026-10-15')).toMatchObject({ status: 'paid_at_gateway', expectedDate: '2026-10-14', overdueFrom: '2026-10-16', overdue: false });
    expect(orderPaymentStatus(rzp, { ...none, payments: [captured(null)] }, rules, '2026-10-16')).toMatchObject({ overdue: true });
  });
  it('settled, then in bank; a full refund ends it', () => {
    expect(orderPaymentStatus(rzp, { ...none, payments: [captured({ date: '2026-10-14', bankDate: null })] }, rules, '2026-10-14')).toMatchObject({ status: 'settled', expectedDate: '2026-10-15' });
    expect(orderPaymentStatus(rzp, { ...none, payments: [captured({ date: '2026-10-14', bankDate: '2026-10-15' })] }, rules, '2026-10-20')).toMatchObject({ status: 'in_bank', bankDate: '2026-10-15' });
    expect(orderPaymentStatus(rzp, { ...none, payments: [{ ...captured(null), refunded: d('1499') }] }, rules, '2026-10-20').status).toBe('refunded');
  });
  it('direct payments are in bank once the linked credits cover the order; write-off ends any route', () => {
    const direct = order({ paymentMethod: 'BANK_TRANSFER', codToCollect: null, totalAmount: d('11800') });
    expect(orderPaymentStatus(direct, none, rules, '2026-10-12').status).toBe('awaiting_payment');
    expect(orderPaymentStatus(direct, { ...none, direct: [{ amount: d('11800'), bankDate: '2026-10-12' }] }, rules, '2026-10-12')).toMatchObject({ status: 'in_bank', collected: '11800.00' });
    expect(orderPaymentStatus(direct, { ...none, writtenOff: true }, rules, '2026-10-12').status).toBe('written_off');
  });
});
