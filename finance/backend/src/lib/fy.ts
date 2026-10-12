/**
 * BR-31 Financial year: 1 April to 31 March. Label "26-27". Quarters Q1 Apr-Jun ... Q4 Jan-Mar.
 * Business dates are calendar dates with no time zone: pass "YYYY-MM-DD" strings or
 * Dates at UTC midnight (what Prisma returns for @db.Date columns).
 */

export const FY_START_MONTH = 4; // April (company.fyStartMonth is fixed to 4)

export type BusinessDate = string | Date;

/** Year, month (1-12) and day of a business date. */
export function ymd(d: BusinessDate): { y: number; m: number; day: number } {
  if (typeof d === 'string') {
    const match = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) throw new Error(`Not a date: ${d}`);
    return { y: Number(match[1]), m: Number(match[2]), day: Number(match[3]) };
  }
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** "YYYY-MM-DD" */
export function isoDate(y: number, m: number, day: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Calendar year in which the FY containing this date starts. */
export function fyStartYear(d: BusinessDate): number {
  const { y, m } = ymd(d);
  return m >= FY_START_MONTH ? y : y - 1;
}

/** "26-27" for any date from 1 Apr 2026 to 31 Mar 2027. */
export function fyLabel(d: BusinessDate): string {
  const start = fyStartYear(d);
  return `${String(start % 100).padStart(2, '0')}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** First and last day of the FY containing this date. */
export function fyRange(d: BusinessDate): { from: string; to: string; label: string } {
  const start = fyStartYear(d);
  return { from: isoDate(start, 4, 1), to: isoDate(start + 1, 3, 31), label: fyLabel(d) };
}

/** 1-4: Q1 Apr-Jun, Q2 Jul-Sep, Q3 Oct-Dec, Q4 Jan-Mar. */
export function fyQuarter(d: BusinessDate): 1 | 2 | 3 | 4 {
  const { m } = ymd(d);
  return (Math.floor(((m - FY_START_MONTH + 12) % 12) / 3) + 1) as 1 | 2 | 3 | 4;
}

/**
 * The twelve months of the FY as first-of-month dates, April first. Months before the company
 * existed are still listed (Q12: "enter April as 0"), so dashboards show zero, not a gap.
 */
export function fyMonths(d: BusinessDate): string[] {
  const start = fyStartYear(d);
  return Array.from({ length: 12 }, (_, i) => {
    const m = ((FY_START_MONTH - 1 + i) % 12) + 1;
    return isoDate(m >= FY_START_MONTH ? start : start + 1, m, 1);
  });
}

/** First day of the month of a business date: the key used by period locks (BR-36). */
export function monthStart(d: BusinessDate): string {
  const { y, m } = ymd(d);
  return isoDate(y, m, 1);
}

/** Today's date in India (IST), as "YYYY-MM-DD". */
export function todayIST(now: Date = new Date()): string {
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return isoDate(ist.getUTCFullYear(), ist.getUTCMonth() + 1, ist.getUTCDate());
}
