import { describe, expect, it } from 'vitest';
import { parseStatementAmount, parseStatementDate, rowsFromTable } from '../../src/bank/parsers/statementFile';

describe('statement file reading (F010)', () => {
  it('reads the date formats banks use', () => {
    expect(['2026-05-30', '30/05/2026', '30-05-2026', '30-May-2026', '30 May 2026', '30/05/26'].map(parseStatementDate))
      .toEqual(Array(6).fill('2026-05-30'));
    expect(parseStatementDate('Closing balance')).toBeNull();
  });

  it('reads Indian-formatted amounts without floats', () => {
    expect(parseStatementAmount('11,36,800.00', 'x').toFixed(2)).toBe('1136800.00');
    expect(parseStatementAmount('', 'x').toFixed(2)).toBe('0.00');
    expect(() => parseStatementAmount('abc', 'x')).toThrow();
  });

  it('finds the table under the bank header, reads the account number, skips footers', () => {
    const file = rowsFromTable([
      ['Customer Name', 'ENTELECHY LABS PRIVATE LIMITED'],
      ['Account Number : 88062419345'],
      ['IFSC', 'IDFB0080152'],
      [],
      ['Transaction Date', 'Value Date', 'Particulars', 'Cheque No.', 'Debit', 'Credit', 'Balance'],
      ['30-May-2026', '30-May-2026', 'IMPS/615064116942/RISHABHSHIVDARS/HDFC0002524/4436/Investment', '', '', '50,000.00', '50,000.00'],
      ['', '', 'Closing Balance', '', '', '', '50,000.00'],
    ]);
    expect(file.accountNumber).toBe('88062419345');
    expect(file.rows).toHaveLength(1);
    expect(file.rows[0]).toMatchObject({ seq: 1, txnDate: '2026-05-30' });
    expect(file.rows[0].credit.toFixed(2)).toBe('50000.00');
  });

  it('puts a newest-first export into date order', () => {
    const header = ['Date', 'Particulars', 'Withdrawal', 'Deposit', 'Balance'];
    const file = rowsFromTable([header, ['02/06/2026', 'B', '', '10', '30'], ['01/06/2026', 'A', '', '20', '20']]);
    expect(file.rows.map((r) => r.narration)).toEqual(['A', 'B']);
  });

  it('refuses a row with both debit and credit, or neither', () => {
    const header = ['Date', 'Particulars', 'Debit', 'Credit', 'Balance'];
    expect(() => rowsFromTable([header, ['01/06/2026', 'X', '5', '5', '0']])).toThrow(/exactly one/);
  });
});
