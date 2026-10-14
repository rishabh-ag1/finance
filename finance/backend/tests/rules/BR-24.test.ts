import { describe, expect, it } from 'vitest';
import { ageingBucket, daysOverdue } from '../../src/lib/payables';

// BR-22 Overdue: today > due date and outstanding > 0; days overdue = today - due date.
// BR-24 Ageing buckets by days past due: Not due, 1-30, 31-60, 61-90, 90+.
describe('BR-22 / BR-24 overdue and ageing', () => {
  it('days overdue counts from the day after the due date', () => {
    expect(daysOverdue('2026-10-13', '2026-10-14')).toBe(1);
    expect(daysOverdue('2026-10-14', '2026-10-14')).toBe(0);
    expect(daysOverdue('2026-10-20', '2026-10-14')).toBe(0);
    expect(daysOverdue(null, '2026-10-14')).toBe(0);
  });

  it('puts each bill in its bucket', () => {
    expect([0, 1, 30, 31, 60, 61, 90, 91, 400].map(ageingBucket)).toEqual([
      'not_due', '1_30', '1_30', '31_60', '31_60', '61_90', '61_90', '90_plus', '90_plus',
    ]);
  });
});
