import { describe, expect, it } from 'vitest';
import { Decimal, formatINR, parseMoney, sum } from '../../src/lib/money';

describe('money', () => {
  it('formats with lakh and crore grouping', () => {
    expect(formatINR('1136800')).toBe('₹11,36,800.00');
    expect(formatINR('20011810')).toBe('₹2,00,11,810.00');
    expect(formatINR('980')).toBe('₹980.00');
    expect(formatINR('-1590312.5')).toBe('-₹15,90,312.50');
  });

  it('parses typed amounts with Indian commas, never floats', () => {
    expect(parseMoney('12,00,000.50').toFixed(2)).toBe('1200000.50');
    expect(() => parseMoney('12.345')).toThrow();
    expect(() => parseMoney('abc')).toThrow();
    expect(() => parseMoney(1200 as unknown as string)).toThrow(/as text/);
  });

  it('adds to the paisa with no float drift', () => {
    expect(sum(['0.1', '0.2', '0.7'].map((v) => new Decimal(v))).toFixed(2)).toBe('1.00');
  });
});
