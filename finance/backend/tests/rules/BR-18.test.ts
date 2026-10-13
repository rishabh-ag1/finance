import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/lib/money';
import { billAmounts } from '../../src/lib/bill';

// BR-18 Net payable = total (taxable + GST + other non-taxable fees) - TDS - advances adjusted.
// Outstanding = net payable - payments allocated.
// Worked example: VideAim PI0037: Rs 17,000 + GST Rs 3,060 + fees Rs 1,000 = Rs 21,060; TDS 10% of
// Rs 17,000 = Rs 1,700; net Rs 19,360; paid Rs 19,360; outstanding 0.
describe('BR-18 net payable', () => {
  const d = (v: string) => new Decimal(v);
  it('VideAim PI0037', () => {
    const a = billAmounts({ total: d('21060'), tds: d('1700'), advancesApplied: d('0'), paid: d('19360'), notes: d('0') });
    expect([a.netPayable, a.outstanding].map((x) => x.toFixed(2))).toEqual(['19360.00', '0.00']);
  });
  it('Saiffi 040: Rs 11,56,400 - TDS Rs 19,600 = Rs 11,36,800 (B3)', () => {
    expect(billAmounts({ total: d('1156400'), tds: d('19600'), advancesApplied: d('0'), paid: d('0'), notes: d('0') }).netPayable.toFixed(2)).toBe('1136800.00');
  });
  it('advances and vendor credit notes reduce what is still owed', () => {
    const a = billAmounts({ total: d('100000'), tds: d('2000'), advancesApplied: d('40000'), paid: d('10000'), notes: d('-5000') });
    expect([a.netPayable, a.outstanding].map((x) => x.toFixed(2))).toEqual(['58000.00', '43000.00']);
  });
});
