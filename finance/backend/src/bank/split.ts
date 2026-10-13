import { Decimal } from '../lib/money';

/**
 * BR-07 Split transactions: the lines must add up to the bank amount to the paisa. Each line has
 * its own category, nature, party and linked document; the parent shows "Split (n)".
 */
export function splitProblem(bankAmount: Decimal, lineAmounts: Decimal[]): string | null {
  if (lineAmounts.length < 2) return 'A split needs at least two lines';
  if (lineAmounts.some((a) => !a.greaterThan(0))) return 'Every line needs an amount above zero';
  if (lineAmounts.some((a) => a.decimalPlaces() > 2)) return 'Amounts can have at most 2 decimals';
  const total = lineAmounts.reduce((s, a) => s.plus(a), new Decimal(0));
  if (!total.equals(bankAmount)) {
    const diff = bankAmount.minus(total);
    return `Lines add up to ${total.toFixed(2)}, the bank amount is ${bankAmount.toFixed(2)} (${diff.isNegative() ? 'over' : 'short'} by ${diff.abs().toFixed(2)})`;
  }
  return null;
}
