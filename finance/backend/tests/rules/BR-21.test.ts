import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/lib/money';
import { amountInWords, documentTotals } from '../../src/lib/gst';

// BR-21 Rounding and amount in words. Line amounts and tax per line to 2 decimals; the document
// total is rounded to the rupee with a separate round-off line (at most ±0.99... in practice ±0.50).
// Worked example: ₹37,401.28 shows as ₹37,401.00 with round off (0.28).
describe('BR-21 rounding and amount in words', () => {
  it('₹37,401.28 -> total ₹37,401.00 with round off -0.28', () => {
    const t = documentTotals([{ taxable: new Decimal('31696.00'), cgst: new Decimal('2852.64'), sgst: new Decimal('2852.64'), igst: new Decimal(0) }]);
    expect(t.beforeRounding.toFixed(2)).toBe('37401.28');
    expect(t.roundOff.toFixed(2)).toBe('-0.28');
    expect(t.total.toFixed(2)).toBe('37401.00');
  });

  it('rounds .50 and up to the next rupee', () => {
    const t = documentTotals([{ taxable: new Decimal('100.50'), cgst: new Decimal(0), sgst: new Decimal(0), igst: new Decimal(0) }]);
    expect([t.roundOff.toFixed(2), t.total.toFixed(2)]).toEqual(['0.50', '101.00']);
  });

  it('writes amounts in Indian words (lakh, crore)', () => {
    expect(amountInWords(new Decimal('1136800'))).toBe('Rupees Eleven Lakh Thirty Six Thousand Eight Hundred Only');
    expect(amountInWords(new Decimal('37401'))).toBe('Rupees Thirty Seven Thousand Four Hundred One Only');
    expect(amountInWords(new Decimal('12500000.50'))).toBe('Rupees One Crore Twenty Five Lakh and Fifty Paise Only');
    expect(amountInWords(new Decimal('0'))).toBe('Rupees Zero Only');
  });
});
