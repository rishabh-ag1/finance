import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/lib/money';
import { poBillingStatus } from '../../src/lib/po';

// BR-17 PO status and over-billing. Billed % = linked tax invoice taxable / PO taxable.
// 0% = Issued (Approved / Sent); between = Partially Billed; 100% = Fully Billed. Like for like:
// taxable against taxable. Worked example: Saiffi PO ₹28,91,000, billed ₹9,80,000 = Partially Billed.
describe('BR-17 PO billing status', () => {
  const d = (v: string) => new Decimal(v);
  it('Saiffi: ₹9,80,000 billed of ₹28,91,000 is Partially Billed', () => {
    expect(poBillingStatus({ lifecycle: 'sent', taxable: d('2891000'), billedTaxable: d('980000') })).toBe('partially_billed');
  });
  it('nothing billed keeps the issue state; all billed is Fully Billed', () => {
    expect(poBillingStatus({ lifecycle: 'approved', taxable: d('2891000'), billedTaxable: d('0') })).toBe('approved');
    expect(poBillingStatus({ lifecycle: 'sent', taxable: d('2891000'), billedTaxable: d('2891000') })).toBe('fully_billed');
  });
  it('closed, cancelled and draft are never overridden by billing', () => {
    for (const lifecycle of ['draft', 'closed', 'cancelled'] as const) {
      expect(poBillingStatus({ lifecycle, taxable: d('100'), billedTaxable: d('100') })).toBe(lifecycle);
    }
  });
});
