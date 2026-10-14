/**
 * BR-45 working days: Saturdays, Sundays and the holidays in Settings > Order-to-bank are skipped.
 * Dates are business dates as 'YYYY-MM-DD'.
 */

const DAY = 86_400_000;
const at = (d: string) => Date.parse(`${d}T00:00:00Z`);
const text = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function isWorkingDay(d: string, holidays: Set<string>) {
  const dow = new Date(at(d)).getUTCDay();
  return dow !== 0 && dow !== 6 && !holidays.has(d);
}

/** n working days after a date (Saturday + 1 = Monday). n = 0 gives the date, or the next working day. */
export function addWorkingDays(from: string, n: number, holidays: Set<string>): string {
  let ms = at(from);
  if (n === 0) {
    while (!isWorkingDay(text(ms), holidays)) ms += DAY;
    return text(ms);
  }
  while (n > 0) {
    ms += DAY;
    if (isWorkingDay(text(ms), holidays)) n -= 1;
  }
  return text(ms);
}

/**
 * Expected date = start + cycle working days; overdue from expected + grace working days (B13:
 * expected Wed 14 Oct with 2 days' grace is overdue from Fri 16 Oct).
 */
export function expectedAndOverdue(start: string, cycleDays: number, graceDays: number, holidays: Set<string>) {
  const expected = addWorkingDays(start, cycleDays, holidays);
  return { expected, overdueFrom: addWorkingDays(expected, graceDays, holidays) };
}
