import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/lib/money';
import { cancelRoute, conversionState, ewayBillNeeded, issueProblems } from '../../src/lib/sales';

const d = (v: string) => new Decimal(v);

// BR-32 / F094: a tax invoice is issued only when everything the law asks for is there.
describe('BR-32 checks on issue', () => {
  const good = {
    docType: 'tax_invoice' as const, supplyType: 'b2b' as const, billTo: { name: 'Sunrise Hotels', address: '12 MG Road, Bengaluru', stateCode: '29', gstin: '29AABCH1234Q1Z5' },
    gstinProblem: null, placeOfSupply: '29', docDate: '2026-10-14', today: '2026-10-14',
    lines: [{ description: 'Bloc Trap Pro', hsnSac: '8543', qty: d('2'), rate: d('3900') }],
  };
  it('passes when everything is there', () => {
    expect(issueProblems(good)).toEqual([]);
  });
  it('names each missing piece in plain words', () => {
    expect(issueProblems({ ...good, gstinProblem: 'GSTIN checksum is invalid - check for a typo', placeOfSupply: '', lines: [{ description: 'Lure sachet', hsnSac: null, qty: d('1'), rate: d('253.39') }] })).toEqual([
      'Customer GSTIN: GSTIN checksum is invalid - check for a typo',
      'Place of supply is not set',
      'Line 1 (Lure sachet) has no HSN code',
    ]);
    expect(issueProblems({ ...good, lines: [], billTo: { ...good.billTo, address: '' }, docDate: '2026-10-15' })).toEqual([
      'Bill-to address is missing', 'The date cannot be in the future', 'Add at least one line',
    ]);
  });
});

// BR-34: issued and not yet in GSTR-1: cancel (number kept); already reported: credit note only.
describe('BR-34 cancel or credit note', () => {
  it('a draft is discarded, never deleted', () => {
    expect(cancelRoute({ status: 'draft', docDate: '2026-10-14', gstr1FiledMonths: [] })).toBe('discard');
  });
  it('issued in October, October GSTR-1 not filed: cancel', () => {
    expect(cancelRoute({ status: 'issued', docDate: '2026-10-14', gstr1FiledMonths: ['2026-09-01'] })).toBe('cancel');
  });
  it('issued in September, September GSTR-1 filed: credit note only', () => {
    expect(cancelRoute({ status: 'issued', docDate: '2026-09-28', gstr1FiledMonths: ['2026-09-01'] })).toBe('credit_note');
  });
});

// BR-33: a proforma converts in full or in part by quantity.
describe('BR-33 proforma to tax invoice', () => {
  it('tracks what is left to convert per line', () => {
    const lines = [{ id: 'a', qty: d('10') }, { id: 'b', qty: d('4') }];
    expect(conversionState(lines, [])).toEqual({ state: 'not_converted', remaining: { a: '10', b: '4' } });
    expect(conversionState(lines, [{ sourceLineId: 'a', qty: d('6') }])).toEqual({ state: 'partly_converted', remaining: { a: '4', b: '4' } });
    expect(conversionState(lines, [{ sourceLineId: 'a', qty: d('10') }, { sourceLineId: 'b', qty: d('4') }])).toEqual({ state: 'converted', remaining: { a: '0', b: '0' } });
  });
});

// BR-42: above the threshold in settings, a warning and a field for the e-way bill number.
describe('BR-42 e-way bill', () => {
  it('warns above Rs 50,000 [Verify] only for goods invoices', () => {
    expect(ewayBillNeeded({ docType: 'tax_invoice', total: d('50000'), threshold: d('50000'), hasGoods: true })).toBe(false);
    expect(ewayBillNeeded({ docType: 'tax_invoice', total: d('50001'), threshold: d('50000'), hasGoods: true })).toBe(true);
    expect(ewayBillNeeded({ docType: 'proforma', total: d('90000'), threshold: d('50000'), hasGoods: true })).toBe(false);
  });
});
