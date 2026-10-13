import { describe, expect, it } from 'vitest';
import { computeLine, gstMode } from '../../src/lib/gst';

// BR-20 GST split. Same state: CGST = SGST = rate/2. Different state: IGST = rate.
// Worked example: Saiffi (06 Haryana) supplying to Entelechy (29) is IGST 18%; Makenica (29) is
// CGST 9% + SGST 9%.
describe('BR-20 GST split', () => {
  it('Saiffi (06) with place of supply Karnataka (29): IGST 18%', () => {
    expect(gstMode({ supplierState: '06', placeOfSupply: '29', supplierRegistered: true })).toBe('igst');
    const l = computeLine({ qty: '1', rate: '980000', discount: '0', gstRate: '18', mode: 'igst' });
    expect([l.taxable, l.cgst, l.sgst, l.igst, l.lineTotal].map((d) => d.toFixed(2)))
      .toEqual(['980000.00', '0.00', '0.00', '176400.00', '1156400.00']);
  });

  it('Makenica (29) to Karnataka: CGST 9% + SGST 9%', () => {
    expect(gstMode({ supplierState: '29', placeOfSupply: '29', supplierRegistered: true })).toBe('cgst_sgst');
    const l = computeLine({ qty: '1', rate: '15847.46', discount: '0', gstRate: '18', mode: 'cgst_sgst' });
    expect([l.cgst, l.sgst, l.igst].map((d) => d.toFixed(2))).toEqual(['1426.27', '1426.27', '0.00']);
  });

  it('an unregistered supplier charges no GST', () => {
    expect(gstMode({ supplierState: '29', placeOfSupply: '29', supplierRegistered: false })).toBe('none');
    const l = computeLine({ qty: '2', rate: '500', discount: '0', gstRate: '18', mode: 'none' });
    expect(l.lineTotal.toFixed(2)).toBe('1000.00');
  });

  it('taxable = qty x rate - discount; tax per line rounded to 2 decimals (BR-21)', () => {
    const l = computeLine({ qty: '3', rate: '333.33', discount: '0.99', gstRate: '5', mode: 'cgst_sgst' });
    expect(l.taxable.toFixed(2)).toBe('999.00');
    expect([l.cgst, l.sgst].map((d) => d.toFixed(2))).toEqual(['24.98', '24.98']); // 24.975 rounds half up
  });

  it('refuses a discount larger than the line', () => {
    expect(() => computeLine({ qty: '1', rate: '100', discount: '101', gstRate: '18', mode: 'igst' })).toThrow();
  });
});
