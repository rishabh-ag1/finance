import { addWorkingDays } from '../lib/workingDays';
import { Decimal } from '../lib/money';
import { collectionRoute, expectedAmount, orderPaymentStatus, paymentDueBy, type Collections, type OrderFacts, type ReconRules } from './status';
import type { TieOutLevel } from './tieOut';

/**
 * BR-46 discrepancy checks. Each finding has a type code (the numbers in BR-46; 11 = settlement lines
 * that do not add up, BR-47 level 2), an amount and a suggested action. Findings are stored and
 * resolved in recon.service; these functions only say what is wrong now.
 */

export type Finding = { type: number; amount: string; detail: string; action: string };

export const DISCREPANCY_LABEL: Record<number, string> = {
  1: 'Amount differs from the order',
  2: 'Payment and order not linked',
  3: 'Captured, not settled in time',
  4: 'Fees above the expected rate',
  5: 'Settlement not in the bank',
  6: 'Bank credit differs from the settlement',
  7: 'Refund and order status disagree',
  8: 'Two payments on one order',
  9: 'COD delivered, not remitted',
  10: 'COD remitted amount differs',
  11: 'Settlement lines do not add up',
};

const rs = (v: Decimal) => `Rs ${v.toFixed(2)}`;
const sum = (xs: Decimal[]) => xs.reduce((s, x) => s.plus(x), new Decimal(0));
const cancelled = (o: OrderFacts) => o.crmStatus === 'CANCELLED' || o.crmStatus === 'RETURNED';

export function orderChecks(o: OrderFacts, c: Collections, r: ReconRules, today: string): Finding[] {
  const route = collectionRoute(o);
  if (route === 'none' || route === 'marketplace' || c.writtenOff) return [];
  const st = orderPaymentStatus(o, c, r, today);
  const expected = expectedAmount(o, route);
  const out: Finding[] = [];

  if (route === 'razorpay') {
    const captured = sum(c.payments.map((p) => p.amount));
    const refunded = sum(c.payments.map((p) => p.refunded));
    if (c.payments.length && !cancelled(o) && refunded.isZero()) {
      const diff = expected.minus(captured);
      if (diff.abs().greaterThan(r.tolerance)) out.push({ type: 1, amount: diff.abs().toFixed(2), detail: `Order ${rs(expected)}, collected ${rs(captured)}`, action: 'Correct the CRM order or chase the customer' });
    }
    if (!c.payments.length && !cancelled(o) && today >= paymentDueBy(o.orderDate, r)) {
      out.push({ type: 2, amount: expected.toFixed(2), detail: 'Prepaid order with no Razorpay payment linked', action: 'Find the payment in Razorpay and link it, or correct the payment method' });
    }
    if (st.status === 'paid_at_gateway' && st.overdue) out.push({ type: 3, amount: captured.toFixed(2), detail: `Expected in a settlement by ${st.expectedDate}`, action: 'Chase Razorpay' });
    if (refunded.greaterThan(0) && !cancelled(o)) out.push({ type: 7, amount: refunded.toFixed(2), detail: 'Refunded in Razorpay but the CRM order is not cancelled or returned', action: 'Update the CRM order, or check the refund' });
    if (cancelled(o) && captured.minus(refunded).greaterThan(r.tolerance)) out.push({ type: 7, amount: captured.minus(refunded).toFixed(2), detail: 'Order cancelled or returned in the CRM but the money is not refunded', action: 'Refund the customer, or correct the CRM order' });
    if (c.payments.length > 1) out.push({ type: 8, amount: captured.toFixed(2), detail: `${c.payments.length} payments on one order`, action: 'Refund the extra payment' });
  }

  if (route === 'cod') {
    if (st.status === 'delivered_awaiting_remittance' && st.overdue) out.push({ type: 9, amount: expected.toFixed(2), detail: `Delivered ${o.deliveredAt}; remittance expected by ${st.expectedDate}`, action: 'Chase Shiprocket' });
    if (c.remittances.length) {
      const remitted = sum(c.remittances.map((x) => x.amount));
      const diff = expected.minus(remitted);
      if (diff.abs().greaterThan(r.tolerance)) out.push({ type: 10, amount: diff.abs().toFixed(2), detail: `COD to collect ${rs(expected)}, remitted ${rs(remitted)}`, action: 'Chase Shiprocket for the difference' });
    }
  }
  return out;
}

export type BatchFacts = {
  source: 'razorpay' | 'shiprocket_cod';
  date: string;
  /** Gross of the payment lines and their fees including GST (Razorpay's fee column). */
  paymentGross: Decimal;
  feesWithTax: Decimal;
  bankCredit: Decimal | null;
  levels: TieOutLevel[];
};

export function batchChecks(b: BatchFacts, r: ReconRules & { expectedFeeRate: Decimal; feeGstRate: Decimal }, today: string): Finding[] {
  const out: Finding[] = [];
  const level = (n: 1 | 2 | 3) => b.levels.find((l) => l.level === n)!;
  if (level(1).ok === false) out.push({ type: 1, amount: new Decimal(level(1).difference!).abs().toFixed(2), detail: 'Orders differ from their gross in this settlement', action: 'Open the settlement and correct the orders that differ' });
  if (level(2).ok === false) out.push({ type: 11, amount: new Decimal(level(2).difference!).abs().toFixed(2), detail: 'Gross - fees - GST - refunds + adjustments does not give the settlement net', action: 'Check the report file against the gateway dashboard' });
  if (b.source === 'razorpay' && b.paymentGross.greaterThan(0)) {
    const allowed = b.paymentGross.times(r.expectedFeeRate).dividedBy(100).times(new Decimal(100).plus(r.feeGstRate)).dividedBy(100).toDecimalPlaces(2).plus(r.tolerance);
    if (b.feesWithTax.greaterThan(allowed)) out.push({ type: 4, amount: b.feesWithTax.minus(allowed).toFixed(2), detail: `Fees with GST ${rs(b.feesWithTax)}; expected at most ${rs(allowed)} at ${r.expectedFeeRate.toFixed(2)}%`, action: 'Check the pricing with Razorpay' });
  }
  if (!b.bankCredit && today >= addWorkingDays(b.date, r.settlementToBankDays + r.graceDays, r.holidays)) {
    out.push({ type: 5, amount: '0.00', detail: `Settled ${b.date}; no bank credit matched`, action: b.source === 'razorpay' ? 'Import the latest statement, or chase Razorpay' : 'Import the latest statement, or chase Shiprocket' });
  }
  if (level(3).ok === false) out.push({ type: 6, amount: new Decimal(level(3).difference!).abs().toFixed(2), detail: 'The bank credit differs from the settlement net', action: 'Check the bank row linked to this settlement' });
  return out;
}
