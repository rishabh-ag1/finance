import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { parseStatementAmount, parseStatementDate, readStatementFile, rowsFromTable } from '../../src/bank/parsers/statementFile';

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

  // Q30: the layout of a real IDFC net-banking XLSX download (13 Oct 2026): details block, a summary
  // table of numbers above the transactions, numeric amounts with empty cells, a Cheque No. column,
  // totals and counts below, and a second sheet of bank notices.
  it('reads a real IDFC XLSX download', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Account Statement');
    ws.addRow(['STATEMENT OF ACCOUNT']);
    ws.addRow(['CUSTOMER ID', '6870889163']);
    ws.addRow(['ACCOUNT NUMBER', '88062419345']);
    ws.addRow(['STATEMENT PERIOD', '29-May-2026 TO 13-Oct-2026']);
    ws.addRow(['CUSTOMER NAME', 'ENTELECHY LABS PRIVATE LIMITED', null, null, 'IFSC', 'IDFB0080152']);
    ws.addRow(['Opening Balance', 'Total Debit', 'Total Credit', 'Closing Balance']);
    ws.addRow([0, 1180, 51180, 50000]);
    ws.addRow(['Transaction Date', 'Value Date', 'Particulars', 'Cheque No.', 'Debit', 'Credit', 'Balance']);
    ws.addRow(['30-May-2026', '30-May-2026', 'IMPS/615064116942/RISHABHSHIVDARS/HDFC0002524/4436/Investment', null, null, 50000, 50000]);
    ws.addRow(['06-Jun-2026', '06-Jun-2026', 'IFT/10199987550/ASTRA SHIELD SOLUTIO/8950768', null, 1180, null, 48820]);
    ws.addRow(['10-Jun-2026', '10-Jun-2026', 'IFT/10245658808/NEWERA LIVING /17694473', null, null, 1180, 50000]);
    ws.addRow([null, 'Total', null, null, 1180, 51180]);
    ws.addRow([null, 'Total number of Debits', 1]);
    ws.addRow([null, 'Total number of Credits', 2]);
    ws.addRow([null, null, 'End of the Statement']);
    wb.addWorksheet('Important Message and Safety Ti').addRow(['IMPORTANT MESSAGE']);
    const file = await readStatementFile('IDFCFIRSTBankstatement.xlsx', Buffer.from(await wb.xlsx.writeBuffer()));
    expect(file.accountNumber).toBe('88062419345');
    expect(file.rows.map((r) => [r.txnDate, r.debit.toFixed(2), r.credit.toFixed(2), r.balance.toFixed(2)])).toEqual([
      ['2026-05-30', '0.00', '50000.00', '50000.00'],
      ['2026-06-06', '1180.00', '0.00', '48820.00'],
      ['2026-06-10', '0.00', '1180.00', '50000.00'],
    ]);
  });
});
