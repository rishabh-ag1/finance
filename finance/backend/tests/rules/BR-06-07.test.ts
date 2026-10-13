import { describe, expect, it } from 'vitest';
import { splitProblem } from '../../src/bank/split';
import { findTransferPartner, type TransferCandidate } from '../../src/bank/transfers';
import { Decimal } from '../../src/lib/money';

// BR-07 Split transactions. Worked example: one Rs 50,000 payment that clears two vendor bills of
// Rs 30,000 and Rs 20,000. Lines must add up to the bank amount to the paisa.
describe('BR-07 split', () => {
  const d = (s: string) => new Decimal(s);

  it('accepts 30,000 + 20,000 for a 50,000 payment', () => {
    expect(splitProblem(d('50000'), [d('30000'), d('20000')])).toBeNull();
  });

  it('refuses lines that are a paisa short or over', () => {
    expect(splitProblem(d('50000'), [d('30000'), d('19999.99')])).toMatch(/short by 0.01/);
    expect(splitProblem(d('50000'), [d('30000'), d('20000.01')])).toMatch(/over by 0.01/);
  });

  it('needs two or more positive lines', () => {
    expect(splitProblem(d('50000'), [d('50000')])).toMatch(/two lines/);
    expect(splitProblem(d('50000'), [d('50000'), d('0')])).toMatch(/above zero/);
  });
});

// BR-06 Own-account transfer pairing (no worked example): same amount, opposite direction,
// within 3 days, both accounts Entelechy's.
describe('BR-06 own-account transfers', () => {
  const own = [{ id: 'idfc', accountNumber: '88062419345' }, { id: 'pnb', accountNumber: '0114008700012345' }];
  const tx = (o: Partial<TransferCandidate>): TransferCandidate => ({
    id: 'x', bankAccountId: 'idfc', txnDate: '2026-11-02', debit: new Decimal(0), credit: new Decimal(0), counterpartyAccount: null, transferPairId: null, ...o,
  });
  const out = tx({ id: 'out', bankAccountId: 'idfc', debit: new Decimal('200000') });

  it('pairs an IDFC debit with the PNB credit of the same amount two days later', () => {
    const inCc = tx({ id: 'in', bankAccountId: 'pnb', txnDate: '2026-11-04', credit: new Decimal('200000') });
    expect(findTransferPartner(out, [inCc], own)?.id).toBe('in');
  });

  it('does not pair beyond 3 days, different amounts, the same account or already-paired rows', () => {
    expect(findTransferPartner(out, [tx({ bankAccountId: 'pnb', txnDate: '2026-11-06', credit: new Decimal('200000') })], own)).toBeNull();
    expect(findTransferPartner(out, [tx({ bankAccountId: 'pnb', credit: new Decimal('199999') })], own)).toBeNull();
    expect(findTransferPartner(out, [tx({ bankAccountId: 'idfc', credit: new Decimal('200000') })], own)).toBeNull();
    expect(findTransferPartner(out, [tx({ bankAccountId: 'pnb', credit: new Decimal('200000'), transferPairId: 'other' })], own)).toBeNull();
  });

  it('never pairs with a founder\'s personal account (not an own account)', () => {
    const founder = tx({ id: 'f', bankAccountId: 'founder-hdfc', credit: new Decimal('200000') });
    expect(findTransferPartner(out, [founder], own)).toBeNull();
  });

  it('prefers the row whose narration names the other account number', () => {
    const a = tx({ id: 'a', bankAccountId: 'pnb', txnDate: '2026-11-02', credit: new Decimal('200000') });
    const b = tx({ id: 'b', bankAccountId: 'pnb', txnDate: '2026-11-03', credit: new Decimal('200000'), counterpartyAccount: '88062419345' });
    expect(findTransferPartner(out, [a, b], own)?.id).toBe('b');
  });
});
