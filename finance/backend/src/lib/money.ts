import { Prisma } from '@prisma/client';
import { UserError } from './http';

/**
 * Money is never a JS number (CLAUDE.md). Prisma's Decimal (decimal.js) is used everywhere; the
 * API sends money as strings ("1136800.00") and reads it back from strings.
 */
export const Decimal = Prisma.Decimal;
export type Decimal = Prisma.Decimal;

const MONEY_TEXT = /^-?\d{1,12}(\.\d{1,2})?$/;

/**
 * Parse an amount typed or sent as text. Accepts "12,00,000.50" (commas ignored) but never a
 * JS number, so a float can't slip in. Throws on anything else.
 */
export function parseMoney(input: string, field = 'Amount'): Decimal {
  if (typeof input !== 'string') throw new UserError(`${field} must be sent as text, e.g. "1200.50"`);
  const clean = input.replace(/[,\s₹]/g, '');
  if (!MONEY_TEXT.test(clean)) throw new UserError(`${field} is not a valid amount: ${input}`);
  return new Decimal(clean);
}

/** Same as parseMoney but empty / null / undefined becomes null. */
export function parseOptionalMoney(input: string | null | undefined, field = 'Amount'): Decimal | null {
  if (input === null || input === undefined || input.trim() === '') return null;
  return parseMoney(input, field);
}

/** Two-decimal string for the API: "1136800.00". */
export function moneyText(value: Decimal | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toFixed(2);
}

/** ₹11,36,800.00 - Indian grouping (lakh, crore). */
export function formatINR(value: Decimal | string): string {
  const d = typeof value === 'string' ? new Decimal(value) : value;
  const negative = d.isNegative();
  const [whole, frac] = d.abs().toFixed(2).split('.');
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}₹${rest ? `${rest},${last3}` : last3}.${frac}`;
}

export function sum(values: Decimal[]): Decimal {
  return values.reduce((acc, v) => acc.plus(v), new Decimal(0));
}
