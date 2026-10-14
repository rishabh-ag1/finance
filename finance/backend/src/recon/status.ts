import { addWorkingDays, expectedAndOverdue } from '../lib/workingDays';
import { Decimal } from '../lib/money';

/**
 * BR-44 order payment status and BR-45 expected dates, computed from the order (CRM reader), its
 * delivery facts (Inventory reader) and what Finance has imported or matched. Never stored or typed.
 */

export type CrmChannel = 'MANUAL' | 'WHATSAPP' | 'SHOPIFY' | 'AMAZON';
export type CrmPaymentMethod = 'UPI' | 'COD' | 'BANK_TRANSFER' | 'RAZORPAY' | 'FREE';
export type Route = 'razorpay' | 'cod' | 'direct' | 'none' | 'marketplace';
export type OrderStatusCode =
  | 'awaiting_payment' | 'awaiting_delivery' | 'paid_at_gateway' | 'delivered_awaiting_remittance' | 'settled' | 'remitted'
  | 'in_bank' | 'refunded' | 'rto_cancelled' | 'written_off' | 'nothing_due' | 'not_tracked';

export const ORDER_STATUS_LABEL: Record<OrderStatusCode, string> = {
  awaiting_payment: 'Awaiting payment', awaiting_delivery: 'Awaiting delivery', paid_at_gateway: 'Paid at gateway',
  delivered_awaiting_remittance: 'Delivered, awaiting remittance', settled: 'Settled', remitted: 'Remitted', in_bank: 'In bank',
  refunded: 'Refunded', rto_cancelled: 'RTO / Cancelled', written_off: 'Written off', nothing_due: 'Nothing to collect', not_tracked: 'Marketplace (not tracked)',
};
export const ROUTE_LABEL: Record<Route, string> = { razorpay: 'Razorpay', cod: 'Shiprocket COD', direct: 'Direct', none: 'Nothing to collect', marketplace: 'Marketplace' };
/** Money that has left the customer but is not in the bank yet (F197). */
export const IN_TRANSIT: OrderStatusCode[] = ['paid_at_gateway', 'delivered_awaiting_remittance', 'settled', 'remitted'];

export type OrderFacts = {
  orderNumber: string;
  orderDate: string;
  channel: CrmChannel;
  paymentMethod: CrmPaymentMethod;
  totalAmount: Decimal;
  advancePaid: Decimal;
  balanceDue: Decimal;
  crmStatus: string;
  isReplacement: boolean;
  /** From bloc-inv (Inventory reader); null until it knows the order. */
  codToCollect: Decimal | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  awb: string | null;
};
export type BatchRef = { date: string; bankDate: string | null };
export type Collections = {
  payments: { amount: Decimal; capturedAt: string; refunded: Decimal; settledBatch: BatchRef | null }[];
  remittances: { amount: Decimal; batch: BatchRef }[];
  direct: { amount: Decimal; bankDate: string }[];
  writtenOff: boolean;
};
export type ReconRules = {
  razorpaySettlementDays: number; codRemittanceDays: number; settlementToBankDays: number; graceDays: number;
  tolerance: Decimal; holidays: Set<string>;
};

/**
 * Which way the money comes (BR-44, Q35). Shopify prepaid orders are paid through Razorpay even
 * when the CRM records UPI (Magic Checkout's own method note wins in the CRM's mapper).
 * Replacements (FREE) expect nothing; Amazon pays out through its own settlements (P2).
 */
export function collectionRoute(o: Pick<OrderFacts, 'channel' | 'paymentMethod' | 'isReplacement'>): Route {
  if (o.paymentMethod === 'FREE' || o.isReplacement) return 'none';
  if (o.channel === 'AMAZON') return 'marketplace';
  if (o.paymentMethod === 'COD') return 'cod';
  if (o.paymentMethod === 'RAZORPAY') return 'razorpay';
  if (o.channel === 'SHOPIFY' && o.paymentMethod === 'UPI') return 'razorpay';
  return 'direct';
}

/** What should arrive by the order's route: the COD amount for COD, else the order total. */
export function expectedAmount(o: OrderFacts, route: Route): Decimal {
  if (route === 'none' || route === 'marketplace') return new Decimal(0);
  if (route === 'cod') return o.codToCollect ?? (o.balanceDue.greaterThan(0) ? o.balanceDue : o.totalAmount.minus(o.advancePaid));
  return o.totalAmount;
}

const sum = (xs: Decimal[]) => xs.reduce((s, x) => s.plus(x), new Decimal(0));
const maxDate = (xs: string[]) => xs.reduce((m, x) => (x > m ? x : m), xs[0]);
const isCancelled = (o: OrderFacts) => o.crmStatus === 'CANCELLED' || o.crmStatus === 'RETURNED';

export function orderPaymentStatus(o: OrderFacts, c: Collections, r: ReconRules, today: string) {
  const route = collectionRoute(o);
  const expected = expectedAmount(o, route);
  let status: OrderStatusCode;
  let collected = new Decimal(0);
  let bankDate: string | null = null;
  // Where the next step's clock starts, and how many working days it takes (BR-45).
  let clock: { from: string; days: number } | null = null;

  if (route === 'none') status = 'nothing_due';
  else if (route === 'marketplace') status = 'not_tracked';
  else if (c.writtenOff) status = 'written_off';
  else if (route === 'razorpay') {
    collected = sum(c.payments.map((p) => p.amount));
    const refunded = sum(c.payments.map((p) => p.refunded));
    const open = c.payments.find((p) => !p.settledBatch);
    if (!c.payments.length) status = isCancelled(o) ? 'rto_cancelled' : 'awaiting_payment';
    else if (refunded.greaterThanOrEqualTo(collected)) status = 'refunded';
    else if (open) { status = 'paid_at_gateway'; clock = { from: open.capturedAt, days: r.razorpaySettlementDays }; }
    else {
      const batches = c.payments.map((p) => p.settledBatch!);
      const waiting = batches.find((b) => !b.bankDate);
      if (waiting) { status = 'settled'; clock = { from: waiting.date, days: r.settlementToBankDays }; }
      else { status = 'in_bank'; bankDate = maxDate(batches.map((b) => b.bankDate!)); }
    }
  } else if (route === 'cod') {
    collected = sum(c.remittances.map((x) => x.amount));
    if (c.remittances.length) {
      const waiting = c.remittances.find((x) => !x.batch.bankDate);
      if (waiting) { status = 'remitted'; clock = { from: waiting.batch.date, days: r.settlementToBankDays }; }
      else { status = 'in_bank'; bankDate = maxDate(c.remittances.map((x) => x.batch.bankDate!)); }
    } else if (isCancelled(o) && !o.deliveredAt) status = 'rto_cancelled';
    else if (o.deliveredAt && o.crmStatus !== 'RETURNED') { status = 'delivered_awaiting_remittance'; clock = { from: o.deliveredAt, days: r.codRemittanceDays }; }
    else if (o.crmStatus === 'RETURNED') status = 'rto_cancelled';
    else status = 'awaiting_delivery';
  } else {
    collected = sum(c.direct.map((x) => x.amount));
    if (c.direct.length && collected.greaterThanOrEqualTo(expected.minus(r.tolerance))) { status = 'in_bank'; bankDate = maxDate(c.direct.map((x) => x.bankDate)); }
    else if (isCancelled(o) && collected.isZero()) status = 'rto_cancelled';
    else status = 'awaiting_payment';
  }

  const dates = clock ? expectedAndOverdue(clock.from, clock.days, r.graceDays, r.holidays) : null;
  return {
    route,
    status,
    expectedAmount: expected.toFixed(2),
    collected: collected.toFixed(2),
    bankDate,
    expectedDate: dates?.expected ?? null,
    overdueFrom: dates?.overdueFrom ?? null,
    overdue: !!dates && today >= dates.overdueFrom,
  };
}

/** The day by which a prepaid order should show a gateway payment (BR-46 type 2). */
export function paymentDueBy(orderDate: string, r: ReconRules) {
  return addWorkingDays(orderDate, r.graceDays, r.holidays);
}
