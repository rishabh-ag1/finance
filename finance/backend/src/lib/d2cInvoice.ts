import { Decimal } from './money';

/**
 * BR-48 D2C invoices from CRM orders. The CRM prices a line at MRP (GST included) less discounts;
 * OrderItem.finalAmount is what the customer pays for the line, GST included, and COD charges are
 * added to the order total. The invoice is built backwards from those amounts, so it matches what
 * the customer paid: taxable = paid / (1 + GST), discount = price before tax x qty - taxable.
 */

export type OrderFacts = {
  orderNumber: string; channel: string; paymentMethod: string; orderFor: string | null; status: string; isReplacement: boolean;
  shippedAt: string | null; cancelledAt: string | null;
};

/** Whether the batch issues an invoice for the order now, and with which date (the ship date). */
export function d2cEligibility(o: OrderFacts, delivery: { shippedAt: string | null } | null, fromDate: string): { eligible: boolean; invoiceDate: string | null; reason: string | null } {
  const no = (reason: string) => ({ eligible: false, invoiceDate: null, reason });
  if (o.paymentMethod === 'FREE' || o.isReplacement) return no('Replacement or free order: nothing is sold, no invoice');
  if (o.orderFor === 'COMPANY') return no('B2B order: invoiced by sales from the CRM or here, not automatically');
  if (o.channel === 'AMAZON') return no('Amazon order: Amazon invoices it (P2)');
  const shipped = [o.shippedAt, delivery?.shippedAt].filter(Boolean).sort()[0] ?? null;
  if (!shipped) return no(o.status === 'CANCELLED' ? 'Cancelled before shipping: no invoice' : 'Not shipped yet');
  if (shipped < fromDate) return no(`Shipped ${shipped}, before auto-invoicing started (${fromDate})`);
  return { eligible: true, invoiceDate: shipped, reason: null };
}

export type OrderLine = { description: string; hsn: string | null; qty: number; priceBeforeTax: Decimal; taxPercent: Decimal; finalAmount: Decimal };

const r2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** Invoice lines (rate before tax, discount amount) from an order's lines and COD charge. */
export function orderInvoiceLines(items: OrderLine[], codCharges: Decimal, orderTotal: Decimal) {
  const problems: string[] = [];
  const lines: { description: string; hsn: string | null; qty: string; rate: string; discount: string; gstRate: string; taxable: string; tax: string; lineTotal: string }[] = [];
  let total = new Decimal(0);
  const add = (description: string, hsn: string | null, qty: number, unitBeforeTax: Decimal, paid: Decimal, rate: Decimal) => {
    const taxable = r2(paid.times(100).dividedBy(new Decimal(100).plus(rate)));
    // Paid above the list price (rare: a price changed in bloc-inv): the unit rate is raised to cover it.
    const unit = r2(unitBeforeTax.times(qty)).greaterThanOrEqualTo(taxable) ? unitBeforeTax : taxable.dividedBy(qty).toDecimalPlaces(2, Decimal.ROUND_UP);
    const discount = r2(unit.times(qty)).minus(taxable);
    const tax = r2(taxable.times(rate).dividedBy(100));
    const lineTotal = taxable.plus(tax);
    total = total.plus(lineTotal);
    lines.push({ description, hsn, qty: String(qty), rate: unit.toFixed(2), discount: discount.toFixed(2), gstRate: rate.toString(), taxable: taxable.toFixed(2), tax: tax.toFixed(2), lineTotal: lineTotal.toFixed(2) });
  };
  for (const i of items) {
    if (!i.hsn) problems.push(`${i.description} has no HSN code in bloc-inv`);
    if (i.qty <= 0) problems.push(`${i.description} has no quantity`);
    else add(i.description, i.hsn, i.qty, i.priceBeforeTax, i.finalAmount, i.taxPercent);
  }
  // COD charges are part of the same supply: taxed at the main goods' rate, under their HSN [Verify] with the CA.
  if (codCharges.greaterThan(0) && items.length) {
    const main = items[0];
    const taxable = r2(codCharges.times(100).dividedBy(new Decimal(100).plus(main.taxPercent)));
    add('Cash on delivery charges', main.hsn, 1, taxable, codCharges, main.taxPercent);
  }
  const rounded = total.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  const difference = rounded.minus(orderTotal);
  if (difference.abs().greaterThan(1)) problems.push(`Invoice total Rs ${rounded.toFixed(2)} differs from the order total Rs ${orderTotal.toFixed(2)}`);
  return { lines, total: rounded.toFixed(2), difference: difference.toFixed(2), problems };
}

/** F103: an invoiced order cancelled or returned after shipping gets one credit note draft. */
export function rtoCreditNeeded(o: { status: string }, inv: { invoiceIssued: boolean; creditNotes: number }) {
  return inv.invoiceIssued && inv.creditNotes === 0 && (o.status === 'CANCELLED' || o.status === 'RETURNED');
}
