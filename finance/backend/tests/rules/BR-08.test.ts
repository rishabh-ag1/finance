import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/lib/money';
import { matchBankRow, nameSimilarity, type MatchCandidate, type PaymentToMatch } from '../../src/lib/payables';

// BR-08 Payment allocation and matching: a bank debit links to a payment by UTR first, else
// amount + date (within 3 days) + party name similarity.
// Worked example: PMT-0002 Rs 2,84,808 to Micro Instruments, UTR 623112118032.
const pay: PaymentToMatch = {
  amount: new Decimal('284808'), paidDate: '2026-08-19', utr: '623112118032', bankAccountId: 'idfc',
  vendorNames: ['MICRO INSTRUMENTS CO', 'Micro Instruments Co'],
};
const row = (over: Partial<MatchCandidate>): MatchCandidate => ({
  id: 'r', bankAccountId: 'idfc', txnDate: '2026-08-19', debit: new Decimal('284808'), utr: '623112118032',
  counterpartyName: 'MICRO INSTRUMENTS CO', narrationRaw: 'IMPS-OPM/623112118032/MICRO INSTRUMENTS CO.../SBIN0002468/7009/AdvanceToolingPaymentM', ...over,
});

describe('BR-08 matching a payment to its bank row', () => {
  it('matches the Micro Instruments row by UTR', () => {
    expect(matchBankRow(pay, [row({ id: 'a' })])).toEqual({ txnId: 'a', by: 'utr' });
  });

  it('matches by UTR even when the date is far off, and finds the UTR inside the narration', () => {
    expect(matchBankRow(pay, [row({ id: 'b', utr: null, txnDate: '2026-09-30' })])).toEqual({ txnId: 'b', by: 'utr' });
  });

  it('without a UTR: same amount, within 3 days, similar name', () => {
    const p = { ...pay, utr: null };
    const rows = [
      row({ id: 'far', utr: null, narrationRaw: 'x', txnDate: '2026-08-25' }),
      row({ id: 'other', utr: null, narrationRaw: 'x', counterpartyName: 'VALCO INDUSTRIES LIMITED' }),
      row({ id: 'ok', utr: null, narrationRaw: 'x', txnDate: '2026-08-21' }),
    ];
    expect(matchBankRow(p, rows)).toEqual({ txnId: 'ok', by: 'amount_date_name' });
  });

  it('never matches a different amount or another account; two equally good rows are left to a person', () => {
    const p = { ...pay, utr: null };
    expect(matchBankRow(p, [row({ utr: null, narrationRaw: 'x', debit: new Decimal('284807') })])).toBeNull();
    expect(matchBankRow(pay, [row({ bankAccountId: 'other' })])).toBeNull();
    expect(matchBankRow(p, [row({ id: 'x', utr: null, narrationRaw: 'x' }), row({ id: 'y', utr: null, narrationRaw: 'x' })])).toBeNull();
  });

  it('names: IDFC truncations and repeats still count as the same party', () => {
    expect(nameSimilarity('SAIFFI INDUSTRIESPARVEZ AALAM', ['Saiffi Industries'])).toBeGreaterThanOrEqual(0.5);
    expect(nameSimilarity('MAKENICA PRIVATE LIMITED', ['Makenica Pvt Ltd'])).toBeGreaterThanOrEqual(0.5);
    expect(nameSimilarity('VALCO INDUSTRIES LIMITED', ['Micro Instruments Co'])).toBeLessThan(0.5);
  });
});
