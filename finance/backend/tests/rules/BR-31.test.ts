import { describe, expect, it } from 'vitest';
import { fyLabel, fyMonths, fyQuarter, fyRange, monthStart, todayIST } from '../../src/lib/fy';

// BR-31 Financial year. Worked example: FY label for 12 Oct 2026 = 26-27. FY 26-27 starts
// 1 Apr 2026; Entelechy was incorporated 22 May 2026, so April and most of May show zero.
describe('BR-31 financial year', () => {
  it('labels 12 Oct 2026 as FY 26-27, Q3', () => {
    expect(fyLabel('2026-10-12')).toBe('26-27');
    expect(fyQuarter('2026-10-12')).toBe(3);
  });

  it('starts FY 26-27 on 1 Apr 2026 and ends it on 31 Mar 2027', () => {
    expect(fyRange('2026-10-12')).toEqual({ from: '2026-04-01', to: '2027-03-31', label: '26-27' });
    expect(fyLabel('2026-04-01')).toBe('26-27');
    expect(fyLabel('2026-03-31')).toBe('25-26');
    expect(fyLabel('2027-03-31')).toBe('26-27');
  });

  it('puts the quarters on Apr-Jun, Jul-Sep, Oct-Dec, Jan-Mar', () => {
    expect(['2026-04-01', '2026-06-30', '2026-07-01', '2026-09-30', '2026-12-31', '2027-01-01', '2027-03-31'].map(fyQuarter))
      .toEqual([1, 1, 2, 2, 3, 4, 4]);
  });

  it('lists all twelve months from April, including the months before incorporation', () => {
    const months = fyMonths('2026-05-22');
    expect(months).toHaveLength(12);
    expect(months[0]).toBe('2026-04-01');
    expect(months[1]).toBe('2026-05-01');
    expect(months[11]).toBe('2027-03-01');
  });

  it('reads Prisma @db.Date values (UTC midnight) without a time-zone shift', () => {
    expect(fyLabel(new Date('2026-04-01T00:00:00.000Z'))).toBe('26-27');
    expect(monthStart(new Date('2026-07-24T00:00:00.000Z'))).toBe('2026-07-01');
  });

  it('takes today in IST, not UTC', () => {
    // 31 Mar 2027 20:00 UTC is already 1 Apr 2027 in India: a new FY.
    expect(todayIST(new Date('2027-03-31T20:00:00Z'))).toBe('2027-04-01');
  });
});
