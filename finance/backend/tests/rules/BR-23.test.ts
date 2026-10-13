import { describe, expect, it } from 'vitest';
import { dueDate } from '../../src/lib/bill';

// BR-23 Due date = document date + payment term days; advance terms are due on the document date.
describe('BR-23 due date', () => {
  it('Net 30 from 24 Jul 2026 is 23 Aug 2026', () => {
    expect(dueDate('2026-07-24', { days: 30, isAdvance: false })).toBe('2026-08-23');
  });
  it('advance terms and "on receipt" are due on the document date; no term means the document date', () => {
    expect(dueDate('2026-09-01', { days: 0, isAdvance: true })).toBe('2026-09-01');
    expect(dueDate('2026-09-01', { days: 0, isAdvance: false })).toBe('2026-09-01');
    expect(dueDate('2026-09-01', null)).toBe('2026-09-01');
  });
  it('crosses month and year ends', () => {
    expect(dueDate('2027-03-20', { days: 15, isAdvance: false })).toBe('2027-04-04');
  });
});
