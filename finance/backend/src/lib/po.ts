import type { Decimal } from './money';

/**
 * BR-17 PO status. The person moves a PO through its lifecycle (draft, issue, send, close,
 * cancel); billing states are computed from linked tax invoices, taxable against taxable.
 */
export type PoLifecycle = 'draft' | 'pending_approval' | 'approved' | 'sent' | 'closed' | 'cancelled';
export type PoStatus = PoLifecycle | 'partially_billed' | 'fully_billed';

export function poBillingStatus(p: { lifecycle: PoLifecycle; taxable: Decimal; billedTaxable: Decimal }): PoStatus {
  if (p.lifecycle !== 'approved' && p.lifecycle !== 'sent') return p.lifecycle;
  if (p.billedTaxable.isZero() || p.billedTaxable.isNegative()) return p.lifecycle;
  return p.billedTaxable.greaterThanOrEqualTo(p.taxable) ? 'fully_billed' : 'partially_billed';
}
