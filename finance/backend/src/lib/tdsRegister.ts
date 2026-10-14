import { Decimal, formatINR } from './money';

/**
 * M07 TDS register: due dates and late interest (BR-13), challan checks and matching (BR-14).
 * Pure functions; the TDS service feeds them from the database.
 */

const ymd = (d: string) => d.split('-').map(Number) as [number, number, number];

/** BR-13: the 7th of the next month; March deductions are due on 30 April. */
export function tdsDueDate(deductionDate: string): string {
  const [y, m] = ymd(deductionDate);
  if (m === 3) return `${y}-04-30`;
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-07`;
}

/**
 * BR-13 late interest for deducted-but-not-deposited TDS: the rate for each month or part of a
 * month from the deduction to the deposit, counted in calendar months (as TRACES does, [Verify]).
 * Nothing when deposited by the due date.
 */
export function tdsLateInterest(p: { amount: Decimal; deductionDate: string; depositDate: string | null; today?: string; ratePerMonth: Decimal }) {
  const until = p.depositDate ?? p.today ?? p.deductionDate;
  if (until <= tdsDueDate(p.deductionDate)) return { months: 0, interest: '0.00' };
  const [y1, m1] = ymd(p.deductionDate);
  const [y2, m2] = ymd(until);
  const months = (y2 * 12 + m2) - (y1 * 12 + m1) + 1;
  const interest = p.amount.times(p.ratePerMonth).times(months).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return { months, interest: interest.toFixed(2) };
}

/** BR-14: what does not add up on a challan, in plain words. */
export function challanProblems(c: { tds: Decimal; interest: Decimal; fee: Decimal; total: Decimal; linked: Decimal }): string[] {
  const out: string[] = [];
  const sum = c.tds.plus(c.interest).plus(c.fee);
  if (!c.total.equals(sum)) out.push(`The challan total ${formatINR(c.total)} is not TDS + interest + fee (${formatINR(sum)})`);
  if (!c.tds.equals(c.linked)) out.push(`The TDS on the challan ${formatINR(c.tds)} is not the sum of the linked deductions (${formatINR(c.linked)})`);
  return out;
}

/**
 * BR-14 suggestion for a deposit of this TDS amount among open deductions: one deduction of exactly
 * that amount, else every open deduction of one month when together they make that amount.
 */
export function suggestDeductions(amount: Decimal, open: { id: string; amount: Decimal; month: string }[]): string[] {
  const exact = open.filter((o) => o.amount.equals(amount));
  if (exact.length === 1) return [exact[0].id];
  const months = [...new Set(open.map((o) => o.month))];
  for (const m of months) {
    const inMonth = open.filter((o) => o.month === m);
    if (inMonth.reduce((s, o) => s.plus(o.amount), new Decimal(0)).equals(amount)) return inMonth.map((o) => o.id);
  }
  return [];
}
