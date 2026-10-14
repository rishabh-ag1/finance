import { describe, expect, it } from 'vitest';
import { addWorkingDays, expectedAndOverdue } from '../../src/lib/workingDays';

// BR-45 Expected bank date and overdue. Working days skip Saturdays, Sundays and the holiday list.
// Worked example (B13): Razorpay payment captured Friday 9 Oct 2026, settlement cycle 3 working days:
// expected settlement Wednesday 14 Oct, overdue from Friday 16 Oct (grace 2 working days).
describe('BR-45 expected dates', () => {
  it('B13: captured Fri 9 Oct -> settlement expected Wed 14 Oct, overdue from Fri 16 Oct', () => {
    expect(addWorkingDays('2026-10-09', 3, new Set())).toBe('2026-10-14');
    const r = expectedAndOverdue('2026-10-09', 3, 2, new Set());
    expect(r).toEqual({ expected: '2026-10-14', overdueFrom: '2026-10-16' });
  });
  it('skips holidays in the list', () => {
    // Dussehra (20 Oct 2026, a Tuesday) as a bank holiday.
    expect(addWorkingDays('2026-10-16', 3, new Set(['2026-10-20']))).toBe('2026-10-22');
  });
  it('a weekend event: one working day later is Monday', () => {
    expect(addWorkingDays('2026-10-10', 1, new Set())).toBe('2026-10-12');
    expect(addWorkingDays('2026-10-10', 0, new Set())).toBe('2026-10-12');
  });
});
