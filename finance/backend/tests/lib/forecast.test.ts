import { describe, expect, it } from 'vitest';
import { forecastWeeks, weekIndex } from '../../src/lib/forecast';

// F136 / D33 13-week cash forecast: weeks start on Monday; anything already due falls in this week;
// anything after the 13th week is left out.
describe('13-week forecast weeks', () => {
  it('starts this week on Monday and lists 13 weeks', () => {
    const w = forecastWeeks('2026-10-14'); // a Wednesday
    expect(w).toHaveLength(13);
    expect(w[0]).toEqual({ from: '2026-10-12', to: '2026-10-18' });
    expect(w[12]).toEqual({ from: '2027-01-04', to: '2027-01-10' });
  });
  it('puts overdue items in this week and drops those beyond the 13 weeks', () => {
    expect(weekIndex('2026-09-01', '2026-10-14')).toBe(0);
    expect(weekIndex('2026-10-19', '2026-10-14')).toBe(1);
    expect(weekIndex('2027-01-10', '2026-10-14')).toBe(12);
    expect(weekIndex('2027-01-11', '2026-10-14')).toBeNull();
  });
});
