import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/lib/money';
import { d2cEligibility, orderInvoiceLines, rtoCreditNeeded } from '../../src/lib/d2cInvoice';

// BR-48 D2C invoice timing and RTO. The tax invoice is issued when the order ships (Shiprocket
// pickup, or 'Shipped' marked in the CRM for Porter / self-delivery, Q27), not on delivery. Prepaid
// orders cancelled before shipping get no invoice. RTO or cancelled after shipping: a credit note is
// drafted. Worked example: COD order shipped 8 Oct, invoice issued 8 Oct; RTO on 14 Oct creates a
// credit note.
const d = (v: string) => new Decimal(v);
const order = (o: object = {}) => ({
  orderNumber: 'BLC-260900', channel: 'WHATSAPP', paymentMethod: 'COD', orderFor: null, status: 'SHIPPED', isReplacement: false,
  shippedAt: '2026-10-08', cancelledAt: null, ...o,
});

describe('BR-48 when a D2C order is invoiced', () => {
  it('shipped 8 Oct: invoiced, dated 8 Oct', () => {
    expect(d2cEligibility(order(), null, '2026-10-01')).toEqual({ eligible: true, invoiceDate: '2026-10-08', reason: null });
  });
  it('the ship date comes from bloc-inv when the CRM has none (Shiprocket pickup)', () => {
    expect(d2cEligibility(order({ shippedAt: null }), { shippedAt: '2026-10-09' }, '2026-10-01')).toMatchObject({ eligible: true, invoiceDate: '2026-10-09' });
  });
  it('not shipped, cancelled before shipping, free replacements, company orders and Amazon are not auto-invoiced', () => {
    expect(d2cEligibility(order({ shippedAt: null, status: 'CONFIRMED' }), null, '2026-10-01').reason).toBe('Not shipped yet');
    expect(d2cEligibility(order({ shippedAt: null, status: 'CANCELLED' }), null, '2026-10-01').reason).toBe('Cancelled before shipping: no invoice');
    expect(d2cEligibility(order({ paymentMethod: 'FREE', isReplacement: true }), null, '2026-10-01').reason).toMatch(/Replacement/);
    expect(d2cEligibility(order({ orderFor: 'COMPANY' }), null, '2026-10-01').reason).toMatch(/B2B/);
    expect(d2cEligibility(order({ channel: 'AMAZON' }), null, '2026-10-01').reason).toMatch(/Amazon/);
  });
  it('orders shipped before auto-invoicing started are left alone', () => {
    expect(d2cEligibility(order({ shippedAt: '2026-09-30' }), null, '2026-10-01').reason).toMatch(/before/);
  });
});

describe('BR-48 invoice lines from what the customer paid', () => {
  it('Trap Pro at MRP Rs 4,999 with Rs 500 off, COD charge Rs 49: the invoice totals Rs 5,048 like the order', () => {
    const r = orderInvoiceLines([
      { description: 'Bloc Trap Pro', hsn: '8543', qty: 1, priceBeforeTax: d('4236.44'), taxPercent: d('18'), finalAmount: d('4499') },
    ], d('549'), d('5048'));
    expect(r.lines.map((l) => [l.description, l.rate, l.discount, l.taxable, l.tax, l.lineTotal])).toEqual([
      ['Bloc Trap Pro', '4236.44', '423.73', '3812.71', '686.29', '4499.00'],
      ['Cash on delivery charges', '465.25', '0.00', '465.25', '83.75', '549.00'],
    ]);
    expect(r.total).toBe('5048.00');
    expect(r.difference).toBe('0.00');
  });
  it('a line with no HSN, or a total that does not match the order, is a problem', () => {
    const r = orderInvoiceLines([{ description: 'Lure sachet', hsn: null, qty: 2, priceBeforeTax: d('253.39'), taxPercent: d('18'), finalAmount: d('598') }], d('0'), d('650'));
    expect(r.problems).toEqual(['Lure sachet has no HSN code in bloc-inv', 'Invoice total Rs 598.00 differs from the order total Rs 650.00']);
  });
});

describe('BR-48 RTO after an invoice', () => {
  it('an invoiced order returned or cancelled after shipping needs a credit note, once', () => {
    expect(rtoCreditNeeded({ status: 'RETURNED' }, { invoiceIssued: true, creditNotes: 0 })).toBe(true);
    expect(rtoCreditNeeded({ status: 'CANCELLED' }, { invoiceIssued: true, creditNotes: 0 })).toBe(true);
    expect(rtoCreditNeeded({ status: 'RETURNED' }, { invoiceIssued: true, creditNotes: 1 })).toBe(false);
    expect(rtoCreditNeeded({ status: 'DELIVERED' }, { invoiceIssued: true, creditNotes: 0 })).toBe(false);
  });
});
