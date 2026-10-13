import { describe, expect, it } from 'vitest';
import { dedupeKey } from '../../src/bank/importRules';
import { rowsFromTable } from '../../src/bank/parsers/statementFile';
import { Decimal } from '../../src/lib/money';

// BR-01 Duplicate check on import. Worked example: two Rs 500 UPI payments to Porter on 5 Sep
// with identical narration: balances differ (10,500 then 10,000), so both rows are kept.
describe('BR-01 duplicate key', () => {
  const narration = 'UPI/DR/625000000001/PORTER/YESB/123456/Porter delivery';
  const header = ['Transaction Date', 'Value Date', 'Particulars', 'Cheque No.', 'Debit', 'Credit', 'Balance'];

  it('keeps two identical Rs 500 Porter payments on 5 Sep apart by their running balance', () => {
    const { rows } = rowsFromTable([
      header,
      ['2026-09-05', '2026-09-05', narration, '', '500', '', '10500'],
      ['2026-09-05', '2026-09-05', narration, '', '500', '', '10000'],
    ]);
    const keys = rows.map((r) => dedupeKey('acct-1', r));
    expect(keys[0]).not.toBe(keys[1]);
    expect(new Set(keys).size).toBe(2);
  });

  it('gives the same row in a second download the same key', () => {
    const row = { txnDate: '2026-09-05', narration: ` ${narration} `, debit: new Decimal('500'), credit: new Decimal(0), balance: new Decimal('10500.00') };
    expect(dedupeKey('acct-1', row)).toBe(dedupeKey('acct-1', { ...row, narration, balance: new Decimal('10500') }));
  });

  it('keys per account, so the same narration in another account is not a duplicate', () => {
    const row = { txnDate: '2026-09-05', narration, debit: new Decimal('500'), credit: new Decimal(0), balance: new Decimal('10500') };
    expect(dedupeKey('acct-1', row)).not.toBe(dedupeKey('acct-2', row));
  });
});
