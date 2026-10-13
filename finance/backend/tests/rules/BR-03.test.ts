import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkBalances } from '../../src/bank/importRules';
import { rowsFromTable, type StatementRow } from '../../src/bank/parsers/statementFile';
import { Decimal } from '../../src/lib/money';
import { parse } from 'csv-parse/sync';

// BR-03 Balance continuity. Worked example: last stored balance 4,60,366 on 7 Sep. The next
// file's first row must back-calculate to 4,60,366. Uses the real IDFC fixture rows.
const fixture = fs.readFileSync(path.resolve(__dirname, '../../../data/fixtures/idfc_statement_rows.csv'), 'utf8');
const all = rowsFromTable(parse(fixture) as string[][]).rows;

/** Rows from the fixture as a fresh file (seq renumbered). */
const file = (rows: StatementRow[]) => rows.map((r, i) => ({ ...r, seq: i + 1 }));

describe('BR-03 balance continuity', () => {
  it('passes the whole fixture against an opening balance of 0 (first import)', () => {
    const check = checkBalances(all, { balance: new Decimal(0), txnDate: null });
    expect(check.status).toBe('ok');
    expect(check.fileClosing.toFixed(2)).toBe('410869.00');
  });

  it('continues a file from the stored 4,60,366 of 7 Sep (worked example)', () => {
    const cut = all.findIndex((r) => r.balance.equals(460366)); // the Rs 1,080 OPT/CBDT row on 7 Sep
    expect(all[cut].txnDate).toBe('2026-09-07');
    const next = file(all.slice(cut + 1));
    const check = checkBalances(next, { balance: new Decimal('460366'), txnDate: '2026-09-07' });
    expect(check.fileOpening.toFixed(2)).toBe('460366.00');
    expect(check.status).toBe('ok');
  });

  it('flags a gap and names the missing dates when rows are missing between files', () => {
    const cut = all.findIndex((r) => r.balance.equals(460366));
    const skipped = file(all.slice(cut + 3)); // two 7 Sep challans missing
    const check = checkBalances(skipped, { balance: new Decimal('460366'), txnDate: '2026-09-07' });
    expect(check.status).toBe('gap');
    expect(check.missingFrom).toBe('2026-09-07');
    expect(check.missingTo).toBe(skipped[0].txnDate);
    expect(check.notes[0]).toMatch(/probably missing/);
  });

  it('flags a mismatch when a row inside the file does not follow from the one before', () => {
    const broken = file(all.slice(0, 5)).map((r, i) => (i === 3 ? { ...r, balance: r.balance.plus(1) } : r));
    const check = checkBalances(broken, { balance: new Decimal(0), txnDate: null });
    expect(check.status).toBe('mismatch');
    expect(check.notes.some((n) => n.startsWith('Row 4'))).toBe(true);
  });
});
