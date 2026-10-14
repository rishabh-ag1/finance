import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/lib/money';
import { founderBalances } from '../../src/lib/claims';

// BR-27 Founder reimbursement: an approved claim is a payable to the founder; a bank debit to the
// founder settles it. Founder balance = approved claims - reimbursements. Rejected or cancelled
// claims count for nothing.
describe('BR-27 founder balances', () => {
  const d = (v: string) => new Decimal(v);
  it('owes the approved claims not yet reimbursed', () => {
    const b = founderBalances(
      [
        { founderId: 'rishabh', amount: d('2500'), status: 'approved' },
        { founderId: 'rishabh', amount: d('1200'), status: 'approved' },
        { founderId: 'rishabh', amount: d('800'), status: 'rejected' },
        { founderId: 'arnav', amount: d('450'), status: 'submitted' },
      ],
      [{ founderId: 'rishabh', amount: d('2500') }],
    );
    expect(b.rishabh).toEqual({ claimed: '3700.00', reimbursed: '2500.00', owed: '1200.00', waiting: '0.00' });
    expect(b.arnav).toEqual({ claimed: '0.00', reimbursed: '0.00', owed: '0.00', waiting: '450.00' });
  });
});
