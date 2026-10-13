import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { UserError } from '../../lib/http';
import { isoDate } from '../../lib/fy';
import { Decimal } from '../../lib/money';

/**
 * F010 Statement upload: reads an IDFC statement export (CSV or XLSX) into rows.
 * Bank exports put account details above the table, so the header row is found by its column
 * names (Transaction Date ... Particulars ... Balance), and the account number is read from the
 * lines above it when present (used to confirm the account, F010).
 */

export type StatementRow = {
  /** 1-based position in the file, after sorting oldest first. */
  seq: number;
  txnDate: string;
  valueDate: string | null;
  narration: string;
  chequeNo: string | null;
  debit: Decimal;
  credit: Decimal;
  balance: Decimal;
};

export type StatementFile = {
  rows: StatementRow[];
  /** Account number found above the table, if any (digits only). */
  accountNumber: string | null;
};

type Cell = string | number | Date | null | undefined;

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Dates as banks write them: 2026-05-30, 30/05/2026, 30-05-2026, 30-May-2026, 30 May 2026, 30/05/26. */
export function parseStatementDate(value: Cell): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return isoDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  const s = String(value).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return isoDate(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m) return isoDate(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  m = s.match(/^(\d{1,2})[\s/-]([A-Za-z]{3})[A-Za-z]*[\s/-](\d{2}|\d{4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return isoDate(m[3].length === 2 ? 2000 + +m[3] : +m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  return null;
}

/** "11,36,800.00", "1136800", "" -> Decimal (0 when empty). Never goes through a JS float. */
export function parseStatementAmount(value: Cell, field: string): Decimal {
  if (value === null || value === undefined || value === '') return new Decimal(0);
  const s = (typeof value === 'number' ? value.toString() : String(value)).replace(/[,\s₹]/g, '').replace(/(Cr|Dr)$/i, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new UserError(`${field} "${value}" is not an amount`);
  return new Decimal(s);
}

const norm = (c: Cell) => String(c ?? '').trim().toLowerCase().replace(/[^a-z]/g, '');

type Columns = { date: number; valueDate: number; narration: number; cheque: number; debit: number; credit: number; balance: number };

function findColumns(row: Cell[]): Columns | null {
  const names = row.map(norm);
  const find = (...options: string[]) => names.findIndex((n) => options.includes(n));
  const cols = {
    date: find('transactiondate', 'txndate', 'date', 'trandate'),
    valueDate: find('valuedate'),
    narration: find('particulars', 'narration', 'description', 'transactiondetails', 'remarks'),
    cheque: find('chequeno', 'chqno', 'chequenumber', 'refno', 'chqrefno'),
    debit: find('debit', 'withdrawal', 'withdrawals', 'withdrawalamt', 'debitamount'),
    credit: find('credit', 'deposit', 'deposits', 'depositamt', 'creditamount'),
    balance: find('balance', 'closingbalance', 'runningbalance'),
  };
  return cols.date >= 0 && cols.narration >= 0 && cols.debit >= 0 && cols.credit >= 0 && cols.balance >= 0 ? cols : null;
}

function accountNumberAbove(lines: Cell[][]): string | null {
  for (const line of lines) {
    const text = line.map((c) => String(c ?? '')).join(' ');
    const m = text.match(/a\/?c(?:count)?\.?\s*(?:no|number)?\.?\s*[:\-]?\s*([X*\d]{6,20})/i);
    if (m) return m[1].replace(/\D/g, '') || null;
  }
  return null;
}

export function rowsFromTable(table: Cell[][]): StatementFile {
  const headerIndex = table.findIndex((r) => findColumns(r) !== null);
  if (headerIndex < 0) {
    throw new UserError('Could not find the statement table: expected columns Transaction Date, Particulars, Debit, Credit, Balance');
  }
  const cols = findColumns(table[headerIndex])!;
  const rows: Omit<StatementRow, 'seq'>[] = [];
  for (const [i, r] of table.slice(headerIndex + 1).entries()) {
    const txnDate = parseStatementDate(r[cols.date]);
    const narration = String(r[cols.narration] ?? '').trim();
    // Lines without a date are footers (closing balance, totals, disclaimers): skipped.
    if (!txnDate) continue;
    if (!narration) throw new UserError(`Row ${headerIndex + i + 2}: no particulars`);
    const line = `Row ${headerIndex + i + 2}`;
    const debit = parseStatementAmount(r[cols.debit], `${line} debit`);
    const credit = parseStatementAmount(r[cols.credit], `${line} credit`);
    if (debit.isZero() === credit.isZero()) throw new UserError(`${line}: exactly one of debit or credit must have an amount`);
    rows.push({
      txnDate,
      valueDate: cols.valueDate >= 0 ? parseStatementDate(r[cols.valueDate]) : null,
      narration,
      chequeNo: cols.cheque >= 0 ? (String(r[cols.cheque] ?? '').trim() || null) : null,
      debit,
      credit,
      balance: parseStatementAmount(r[cols.balance], `${line} balance`),
    });
  }
  if (rows.length === 0) throw new UserError('The statement has no transactions');

  // Some exports list newest first. Statements are processed oldest first; same-day order is
  // decided by the running balance, so keep the file order and reverse it as a whole if needed.
  const ordered = rows.length > 1 && rows[0].txnDate > rows[rows.length - 1].txnDate ? [...rows].reverse() : rows;
  return {
    rows: ordered.map((r, i) => ({ ...r, seq: i + 1 })),
    accountNumber: accountNumberAbove(table.slice(0, headerIndex)),
  };
}

export async function readStatementFile(fileName: string, content: Buffer): Promise<StatementFile> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.csv')) {
    const table = parseCsv(content.toString('utf8').replace(/^﻿/, ''), { relax_column_count: true, skip_empty_lines: true }) as string[][];
    return rowsFromTable(table);
  }
  if (lower.endsWith('.xlsx')) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(content as unknown as ArrayBuffer);
    const sheet = wb.worksheets[0];
    if (!sheet) throw new UserError('The workbook has no sheets');
    const table: Cell[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values = (row.values as Cell[]).slice(1).map((v) => {
        if (v && typeof v === 'object' && !(v instanceof Date)) {
          const o = v as { text?: string; result?: Cell; richText?: { text: string }[] };
          return o.richText ? o.richText.map((t) => t.text).join('') : o.text ?? o.result ?? '';
        }
        return v;
      });
      table.push(values);
    });
    return rowsFromTable(table);
  }
  if (lower.endsWith('.xls')) {
    throw new UserError('Old .xls files are not read yet. Download the statement as .xlsx or CSV, or open it in Excel and save as .xlsx.');
  }
  throw new UserError('Upload the statement as a .csv or .xlsx file (PDF comes later, F010 P1)');
}
