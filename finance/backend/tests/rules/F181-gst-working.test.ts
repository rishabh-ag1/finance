import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/lib/money';
import { b2cSummary, hsnSummary, tieOut } from '../../src/lib/caPack';

const d = (v: string) => new Decimal(v);
const line = (o: { hsn: string; rate: string; qty: string; taxable: string; cgst?: string; sgst?: string; igst?: string; credit?: boolean }) => ({
  hsnSac: o.hsn, gstRate: d(o.rate), qty: d(o.qty), taxable: d(o.taxable), cgst: d(o.cgst ?? '0'), sgst: d(o.sgst ?? '0'), igst: d(o.igst ?? '0'), isCredit: !!o.credit,
});

// F181 GST working for the CA (information only, not a GSTR file): outward supplies by HSN and
// rate, net of credit notes, tied to the invoices' taxable value.
describe('F181 HSN summary', () => {
  const lines = [
    line({ hsn: '8543', rate: '18', qty: '2', taxable: '7800', cgst: '702', sgst: '702' }),
    line({ hsn: '8543', rate: '18', qty: '1', taxable: '3900', igst: '702' }),
    line({ hsn: '3808', rate: '18', qty: '10', taxable: '2533.90', cgst: '228.05', sgst: '228.05' }),
    line({ hsn: '8543', rate: '18', qty: '1', taxable: '3900', cgst: '351', sgst: '351', credit: true }),
  ];
  it('Trap Pro: 3 sold less 1 credited = 2 units, taxable Rs 7,800; lure sachets apart; sorted by HSN', () => {
    expect(hsnSummary(lines)).toEqual([
      { hsn: '3808', rate: '18', qty: '10', taxable: '2533.90', cgst: '228.05', sgst: '228.05', igst: '0.00', tax: '456.10', total: '2990.00' },
      { hsn: '8543', rate: '18', qty: '2', taxable: '7800.00', cgst: '351.00', sgst: '351.00', igst: '702.00', tax: '1404.00', total: '9204.00' },
    ]);
  });
  it('the HSN summary ties to the invoices less credit notes', () => {
    expect(tieOut(hsnSummary(lines), { invoicesTaxable: d('14233.90'), creditsTaxable: d('3900') })).toEqual({ hsnTaxable: '10333.90', documentsTaxable: '10333.90', difference: '0.00', ok: true });
    expect(tieOut(hsnSummary(lines), { invoicesTaxable: d('14234.90'), creditsTaxable: d('3900') }).ok).toBe(false);
  });
});

describe('F181 B2C summary', () => {
  it('B2C supplies by place of supply and rate, credit notes subtracted', () => {
    const docs = [
      { placeOfSupply: '27', gstRate: d('18'), taxable: d('3900'), igst: d('702'), cgst: d('0'), sgst: d('0'), isCredit: false },
      { placeOfSupply: '27', gstRate: d('18'), taxable: d('1000'), igst: d('180'), cgst: d('0'), sgst: d('0'), isCredit: true },
      { placeOfSupply: '29', gstRate: d('18'), taxable: d('3812.71'), igst: d('0'), cgst: d('343.14'), sgst: d('343.14'), isCredit: false },
    ];
    expect(b2cSummary(docs)).toEqual([
      { placeOfSupply: '27', rate: '18', taxable: '2900.00', cgst: '0.00', sgst: '0.00', igst: '522.00' },
      { placeOfSupply: '29', rate: '18', taxable: '3812.71', cgst: '343.14', sgst: '343.14', igst: '0.00' },
    ]);
  });
});
