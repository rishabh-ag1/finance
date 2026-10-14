import { describe, expect, it } from 'vitest';
import { computeGstinCheckDigit } from '../../src/lib/gstin';
import { supplyOf } from '../../src/lib/sales';

// BR-49 B2B vs B2C invoice (with BR-20 for the tax split). A customer with a valid GSTIN gets a B2B
// invoice with its GSTIN, place of supply from the ship-to state; without one, B2C with name,
// address and state, place of supply = delivery state. Worked example: hotel with GSTIN 29XXXXX:
// B2B. Home customer in Pune: B2C, IGST, place of supply 27 (Maharashtra).
const gstin29 = (() => { const f = '29AABCH1234Q1Z'; return f + computeGstinCheckDigit(f); })();

describe('BR-49 B2B vs B2C', () => {
  it('hotel in Karnataka with a GSTIN: B2B, CGST + SGST', () => {
    expect(supplyOf({ supplierState: '29', billToGstin: gstin29, shipToState: '29' })).toEqual({ supplyType: 'b2b', placeOfSupply: '29', gstMode: 'cgst_sgst', gstin: gstin29, problem: null });
  });
  it('home customer in Pune without a GSTIN: B2C, IGST, place of supply 27', () => {
    expect(supplyOf({ supplierState: '29', billToGstin: null, shipToState: '27' })).toEqual({ supplyType: 'b2c', placeOfSupply: '27', gstMode: 'igst', gstin: null, problem: null });
  });
  it('a B2B customer shipping to another state: place of supply is the ship-to state', () => {
    expect(supplyOf({ supplierState: '29', billToGstin: gstin29, shipToState: '30' })).toMatchObject({ supplyType: 'b2b', placeOfSupply: '30', gstMode: 'igst' });
  });
  it('a GSTIN that fails the check is a problem, not a quiet B2C', () => {
    expect(supplyOf({ supplierState: '29', billToGstin: '29AABCH1234Q1ZX', shipToState: '29' }).problem).toMatch(/GSTIN/);
  });
});
