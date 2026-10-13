import { Decimal } from '../lib/money';
import type { StatementRow } from './parsers/statementFile';

/**
 * BR-01 Duplicate key: account | txn date | narration | debit | credit | running balance.
 * The balance is part of the key so two genuine identical payments on the same day stay apart.
 */
export function dedupeKey(accountId: string, r: Pick<StatementRow, 'txnDate' | 'narration' | 'debit' | 'credit' | 'balance'>): string {
  return [accountId, r.txnDate, r.narration.trim(), r.debit.toFixed(2), r.credit.toFixed(2), r.balance.toFixed(2)].join('|');
}

export type BalanceCheck = {
  status: 'ok' | 'gap' | 'mismatch';
  /** Balance before the first row of the file: first balance - credit + debit. */
  fileOpening: Decimal;
  fileClosing: Decimal;
  /** Balance the file should continue from: last stored balance, or the account's opening balance. */
  expectedOpening: Decimal | null;
  /** Plain-English notes for the person importing. */
  notes: string[];
  /** When the file does not continue from what is stored: the dates likely missing. */
  missingFrom: string | null;
  missingTo: string | null;
};

/**
 * BR-03 Balance continuity.
 *  1. The file's first row must back-calculate to the last stored balance for the account
 *     (or the account's opening balance on the first import). Otherwise the batch is a "gap".
 *  2. Each row's balance = previous balance + credit - debit, so the file's last balance =
 *     opening + credits - debits. A break inside the file is a "mismatch".
 * Import is still allowed with a warning; the batch keeps the status.
 */
export function checkBalances(
  rows: StatementRow[],
  previous: { balance: Decimal; txnDate: string | null } | null,
): BalanceCheck {
  const first = rows[0];
  const last = rows[rows.length - 1];
  const fileOpening = first.balance.minus(first.credit).plus(first.debit);
  const notes: string[] = [];
  let status: BalanceCheck['status'] = 'ok';
  let missingFrom: string | null = null;
  let missingTo: string | null = null;

  for (let i = 1; i < rows.length; i++) {
    const expected = rows[i - 1].balance.plus(rows[i].credit).minus(rows[i].debit);
    if (!expected.equals(rows[i].balance)) {
      status = 'mismatch';
      notes.push(`Row ${rows[i].seq} (${rows[i].txnDate}): balance ${rows[i].balance.toFixed(2)} but the previous row gives ${expected.toFixed(2)}`);
    }
  }

  const credits = rows.reduce((s, r) => s.plus(r.credit), new Decimal(0));
  const debits = rows.reduce((s, r) => s.plus(r.debit), new Decimal(0));
  if (!fileOpening.plus(credits).minus(debits).equals(last.balance)) {
    status = 'mismatch';
    notes.push(`Opening ${fileOpening.toFixed(2)} + credits ${credits.toFixed(2)} - debits ${debits.toFixed(2)} does not equal the closing balance ${last.balance.toFixed(2)}`);
  }

  if (previous && !previous.balance.equals(fileOpening)) {
    if (status === 'ok') status = 'gap';
    missingFrom = previous.txnDate;
    missingTo = first.txnDate;
    notes.push(
      `The file starts from a balance of ${fileOpening.toFixed(2)} but the last stored balance${previous.txnDate ? ` (${previous.txnDate})` : ''} is ${previous.balance.toFixed(2)}. ` +
      `Transactions between ${previous.txnDate ?? 'the opening date'} and ${first.txnDate} are probably missing.`,
    );
  }

  return { status, fileOpening, fileClosing: last.balance, expectedOpening: previous?.balance ?? null, notes, missingFrom, missingTo };
}
