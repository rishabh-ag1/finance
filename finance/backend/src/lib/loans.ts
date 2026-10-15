import { Decimal, formatINR } from './money';

/**
 * M13 Funding & Loans (BR-28): repayment schedules, the balance of flexible loans, simple interest
 * and the covenant check against the Mesa aggregate debt cap. Pure functions.
 */

const DAY = 86_400_000;
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
const r2 = (x: Decimal) => x.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const zero = new Decimal(0);

/** The same day n months later, kept inside the month (31 Jan + 1 month = 28 Feb). */
export function addMonths(day: string, n: number) {
  const [y, m, dd] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(dd, last));
  return t.toISOString().slice(0, 10);
}

/** Monthly instalment, rounded to the rupee (the last instalment takes the difference). */
export function emiAmount(principal: Decimal, annualRate: Decimal, months: number) {
  if (months <= 0) throw new Error('months must be positive');
  if (annualRate.isZero()) return principal.dividedBy(months).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  const i = annualRate.dividedBy(1200);
  const f = i.plus(1).pow(months);
  return principal.times(i).times(f).dividedBy(f.minus(1)).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
}

export type ScheduleRow = { instalmentNo: number; dueDate: string; openingBalance: string; principal: string; interest: string; total: string; closingBalance: string };

/**
 * EMI: equal instalments after any interest-only moratorium months; interest each month on the
 * balance at rate / 12. Bullet: interest each month, principal with the last instalment.
 * [Verify] against each loan agreement (some charge interest on actual days).
 */
export function loanSchedule(p: { type: 'emi' | 'bullet'; principal: Decimal; annualRate: Decimal; months: number; firstDue: string; moratoriumMonths: number }): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  let bal = p.principal;
  const monthly = (b: Decimal) => r2(b.times(p.annualRate).dividedBy(1200));
  const push = (n: number, principal: Decimal, interest: Decimal) => {
    const close = bal.minus(principal);
    rows.push({ instalmentNo: n, dueDate: addMonths(p.firstDue, n - 1), openingBalance: bal.toFixed(2), principal: principal.toFixed(2), interest: interest.toFixed(2), total: principal.plus(interest).toFixed(2), closingBalance: close.toFixed(2) });
    bal = close;
  };
  let n = 1;
  for (let k = 0; k < p.moratoriumMonths; k += 1) push(n++, zero, monthly(bal));
  if (p.type === 'bullet') {
    for (let k = 1; k <= p.months; k += 1) push(n++, k === p.months ? bal : zero, monthly(bal));
    return rows;
  }
  const emi = emiAmount(p.principal, p.annualRate, p.months);
  for (let k = 1; k <= p.months; k += 1) {
    const interest = monthly(bal);
    const principal = k === p.months ? bal : Decimal.min(emi.minus(interest), bal);
    push(n++, principal, interest);
  }
  return rows;
}

/** Simple interest on a balance for the days between two dates (actual / 365). No rate entered: nil. */
export function accruedInterest(balance: Decimal, annualRate: Decimal | null, from: string, to: string) {
  if (!annualRate || balance.lessThanOrEqualTo(0) || to <= from) return '0.00';
  return r2(balance.times(annualRate).dividedBy(100).times(days(from, to)).dividedBy(365)).toFixed(2);
}

/** A flexible loan: what is left, and how many days until it must be repaid in full. */
export function flexibleState(l: { disbursed: Decimal; disbursedDate: string; finalDueDate: string; principalRepaid: Decimal }, today: string) {
  const balance = Decimal.max(l.disbursed.minus(l.principalRepaid), zero);
  const left = days(today, l.finalDueDate);
  return { balance: balance.toFixed(2), daysToFinalDue: left, overdue: left < 0 && balance.greaterThan(0) };
}

/** BR-28: total debt (loans that count + drawn cash credit, Q14) against the cap, with what is being added. */
export function covenantCheck(c: { loansOutstanding: Decimal; cashCreditDrawn: Decimal; cap: Decimal; adding: Decimal }) {
  const total = c.loansOutstanding.plus(c.cashCreditDrawn).plus(c.adding);
  const headroom = c.cap.minus(total);
  const breached = total.greaterThan(c.cap);
  return {
    totalDebt: total.toFixed(2), cap: c.cap.toFixed(2), headroom: headroom.toFixed(2), breached,
    warning: breached ? `Total debt Rs ${formatINR(total).replace('₹', '')} ${c.adding.greaterThan(0) ? 'would be' : 'is'} above the Rs ${formatINR(c.cap).replace('₹', '')} cap in the Mesa agreement (by Rs ${formatINR(headroom.negated()).replace('₹', '')})` : null,
  };
}

/** Share application money should be allotted within 60 days of receipt, else refunded [Verify with the CA]. */
export function shareApplicationAlert(s: { receivedOn: string; allotmentDate: string | null }, today: string) {
  if (s.allotmentDate) return null;
  const n = days(s.receivedOn, today);
  return { days: n, overdue: n > 60 };
}
