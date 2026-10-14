import type { TxnNature } from '@prisma/client';
import type { Decimal } from './money';

/**
 * BR-35 accrual view. Documents count on their own date; bank rows count only when no document
 * stands behind them (a row matched to a payment for a bill is that bill, already counted).
 */

export type MoneyFlow = { date: string; month: string; direction: 'in' | 'out'; nature: TxnNature; amount: Decimal; categoryId: string | null; subCategoryId: string | null };

/** What a vendor bill costs the company: taxable value and other charges, plus GST it cannot claim back. */
export function billAccrualAmount(b: { taxableValue: Decimal; otherCharges: Decimal; gst: Decimal; itcEligible: boolean }): Decimal {
  return b.taxableValue.plus(b.otherCharges).plus(b.itcEligible ? 0 : b.gst);
}

export function accrualFlows<T extends MoneyFlow>(bank: (T & { linked: boolean })[], documents: T[]): T[] {
  return [...bank.filter((f) => !f.linked).map(({ linked: _linked, ...f }) => f as unknown as T), ...documents];
}
