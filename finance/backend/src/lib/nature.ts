import type { TxnNature } from '@prisma/client';

/**
 * BR-04 Nature of a transaction. Set by the category (Category Master), can be overridden.
 * P&L-style dashboards only use Operating Income, Operating Expense, COGS and Interest.
 * Burn uses operating outflows (BR-37); capex, financing, tax, transfers stay out.
 */

/** Labels exactly as written in the Nature column of docs/spec.md Category Master. */
export const NATURE_LABELS: Record<TxnNature, string> = {
  operating_income: 'Operating Income',
  operating_expense: 'Operating Expense',
  cogs: 'COGS',
  capex: 'Capex',
  financing_in: 'Financing In',
  financing_out: 'Financing Out',
  interest: 'Interest',
  tax_payment: 'Tax Payment',
  advance: 'Advance',
  transfer: 'Transfer',
  related_party: 'Related Party',
  refund_reversal: 'Refund/Reversal',
  reimbursement: 'Reimbursement',
};

const BY_LABEL = new Map(Object.entries(NATURE_LABELS).map(([k, v]) => [v.toLowerCase(), k as TxnNature]));

export function natureFromLabel(label: string): TxnNature {
  const n = BY_LABEL.get(label.trim().toLowerCase());
  if (!n) throw new Error(`Unknown nature "${label}"`);
  return n;
}

const PNL: ReadonlySet<TxnNature> = new Set(['operating_income', 'operating_expense', 'cogs', 'interest']);
const BURN_OUTFLOW: ReadonlySet<TxnNature> = new Set(['operating_expense', 'cogs', 'interest']);

/** Counts in P&L-style dashboards. */
export function isPnl(n: TxnNature): boolean {
  return PNL.has(n);
}

/** An outflow of this nature counts in gross burn (BR-37). */
export function countsInGrossBurn(n: TxnNature): boolean {
  return BURN_OUTFLOW.has(n);
}

/** An inflow of this nature reduces net burn (BR-37). */
export function countsAsOperatingIncome(n: TxnNature): boolean {
  return n === 'operating_income';
}

/** Nature of a sub-category: its own override, else the category default. */
export function resolveNature(category: { natureDefault: TxnNature }, sub?: { natureOverride: TxnNature | null } | null): TxnNature {
  return sub?.natureOverride ?? category.natureDefault;
}
