import { describe, expect, it } from 'vitest';
import { docNumberProblem, formatDocNumber, seriesProblem } from '../../src/lib/numberSeries';

// BR-30 Document numbering. Worked example: ELPL/26-27/0001 = 15 characters.
// Tax invoice and credit note numbers: max 16 characters; only letters, digits, '-' and '/'.
describe('BR-30 document numbering', () => {
  it('formats ELPL/26-27/0001 with 15 characters', () => {
    const n = formatDocNumber('ELPL/{FY}/{N}', '26-27', 1, 4);
    expect(n).toBe('ELPL/26-27/0001');
    expect(n).toHaveLength(15);
    expect(docNumberProblem('tax_invoice', n)).toBeNull();
  });

  it('allows the 5-digit tax invoice series from Documents & Numbering (16 characters)', () => {
    expect(formatDocNumber('ELPL/{FY}/{N}', '26-27', 1, 5)).toBe('ELPL/26-27/00001');
    expect(seriesProblem({ docType: 'tax_invoice', pattern: 'ELPL/{FY}/{N}', padding: 5, fyLabel: '26-27' })).toBeNull();
  });

  it('rejects a tax invoice series that could exceed 16 characters', () => {
    expect(seriesProblem({ docType: 'tax_invoice', pattern: 'ELPL/INV/{FY}/{N}', padding: 5, fyLabel: '26-27' }))
      .toMatch(/at most 16/);
  });

  it('rejects characters other than letters, digits, / and -', () => {
    expect(docNumberProblem('credit_note', 'ELCN_26-27_0001')).toMatch(/may only contain/);
  });

  it('does not apply the GST limits to POs and vouchers', () => {
    expect(docNumberProblem('purchase_order', 'ELPL/PO/26-27/0000000001')).toBeNull();
    expect(formatDocNumber('PMT-{N}', null, 6, 4)).toBe('PMT-0006');
  });

  it('needs {N} in the pattern and a whole number from 1', () => {
    expect(seriesProblem({ docType: 'proforma', pattern: 'ELPL/PI/{FY}/', padding: 4, fyLabel: '26-27' })).toMatch(/\{N\}/);
    expect(() => formatDocNumber('PMT-{N}', null, 0, 4)).toThrow();
  });
});
