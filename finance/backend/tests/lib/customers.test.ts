import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/lib/money';
import { creditWarnings, exclusiveRate, priceFor, resolveProfile } from '../../src/lib/customers';

// F121 price lists, F081 customer defaults, F083 credit-limit warning.
const d = (v: string) => new Decimal(v);

describe('F121 price lookup', () => {
  const items = [
    { invProductId: 'trap', price: d('4236.44'), minQty: 1, effectiveFrom: '2026-07-01', effectiveTo: '2026-09-30', isArchived: false },
    { invProductId: 'trap', price: d('4100.00'), minQty: 1, effectiveFrom: '2026-10-01', effectiveTo: null, isArchived: false },
    { invProductId: 'trap', price: d('3900.00'), minQty: 10, effectiveFrom: '2026-10-01', effectiveTo: null, isArchived: false },
    { invProductId: 'sachet', price: d('253.39'), minQty: 1, effectiveFrom: '2026-07-01', effectiveTo: null, isArchived: true },
  ];
  it('takes the price in force on the date, the highest quantity break reached', () => {
    expect(priceFor(items, 'trap', '2026-09-15', 1)?.price.toFixed(2)).toBe('4236.44');
    expect(priceFor(items, 'trap', '2026-10-14', 2)?.price.toFixed(2)).toBe('4100.00');
    expect(priceFor(items, 'trap', '2026-10-14', 12)?.price.toFixed(2)).toBe('3900.00');
  });
  it('archived prices and dates before any price give nothing', () => {
    expect(priceFor(items, 'sachet', '2026-10-14', 1)).toBeNull();
    expect(priceFor(items, 'trap', '2026-06-30', 1)).toBeNull();
  });
  it('a price inclusive of GST becomes the rate before GST (2 decimals, half up)', () => {
    expect(exclusiveRate(d('4999'), true, d('18')).toFixed(2)).toBe('4236.44');
    expect(exclusiveRate(d('4236.44'), false, d('18')).toFixed(2)).toBe('4236.44');
  });
});

describe('F081 customer profile', () => {
  const terms = { onDelivery: 'term-od' };
  it('a customer with no profile gets payment terms On delivery and does not deduct TDS', () => {
    expect(resolveProfile(null, null, terms)).toMatchObject({ paymentTermId: 'term-od', deductsTds: false, creditLimit: null, invoiceEmails: [], channel: 'horeca' });
  });
  it('an outlet overrides its company field by field', () => {
    const company = { paymentTermId: 'net30', creditLimit: d('200000'), invoiceEmails: ['ap@hotel.in'], deductsTds: true, tdsSectionId: '194C', priceListId: 'horeca', channel: 'horeca', billToBranchId: null };
    const outlet = { paymentTermId: null, creditLimit: null, invoiceEmails: ['goa@hotel.in'], deductsTds: null, tdsSectionId: null, priceListId: null, channel: null, billToBranchId: 'hq' };
    expect(resolveProfile(company, outlet, terms)).toMatchObject({ paymentTermId: 'net30', invoiceEmails: ['goa@hotel.in'], deductsTds: true, priceListId: 'horeca', billToBranchId: 'hq' });
    expect(resolveProfile(company, outlet, terms).creditLimit?.toFixed(2)).toBe('200000.00');
  });
});

describe('F083 credit-limit warning (warn only)', () => {
  it('warns when outstanding + new invoice exceeds the limit, or something is overdue more than 30 days', () => {
    expect(creditWarnings({ creditLimit: d('100000'), outstanding: d('80000'), newAmount: d('15000'), oldestOverdueDays: 0 })).toEqual([]);
    expect(creditWarnings({ creditLimit: d('100000'), outstanding: d('80000'), newAmount: d('25000'), oldestOverdueDays: 0 }))
      .toEqual(['Outstanding Rs 80000.00 + this invoice Rs 25000.00 is above the credit limit of Rs 100000.00']);
    expect(creditWarnings({ creditLimit: null, outstanding: d('5000'), newAmount: d('1000'), oldestOverdueDays: 31 }))
      .toEqual(['An invoice of this customer is 31 days overdue']);
  });
});
