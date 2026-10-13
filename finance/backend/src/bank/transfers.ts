import type { Decimal } from '../lib/money';

/**
 * BR-06 Own-account transfer pairing: a debit in one own account and a credit in another for the
 * same amount within 3 days, both accounts Entelechy's, are a pair (Nature = Transfer, out of
 * income and expense). Transfers from founder personal accounts are not Transfers.
 */

export const TRANSFER_WINDOW_DAYS = 3;

export type TransferCandidate = {
  id: string;
  bankAccountId: string;
  txnDate: string;
  debit: Decimal;
  credit: Decimal;
  /** The other account number in the narration (IFT), when the bank prints it. */
  counterpartyAccount: string | null;
  transferPairId: string | null;
};

export type OwnAccount = { id: string; accountNumber: string };

const days = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

/**
 * The best partner for `row` among `candidates`: opposite direction, same amount, a different
 * own account, within 3 days, not already paired. A narration that names the partner's account
 * number wins; otherwise the closest date.
 */
export function findTransferPartner(row: TransferCandidate, candidates: TransferCandidate[], ownAccounts: OwnAccount[]): TransferCandidate | null {
  const own = new Set(ownAccounts.map((a) => a.id));
  if (!own.has(row.bankAccountId) || row.transferPairId) return null;
  const rowIsDebit = row.debit.greaterThan(0);
  const amount = rowIsDebit ? row.debit : row.credit;
  const accountNo = (id: string) => ownAccounts.find((a) => a.id === id)?.accountNumber ?? '';

  const matches = candidates.filter((c) =>
    c.id !== row.id
    && !c.transferPairId
    && own.has(c.bankAccountId)
    && c.bankAccountId !== row.bankAccountId
    && (rowIsDebit ? c.credit : c.debit).equals(amount)
    && (rowIsDebit ? c.debit : c.credit).isZero()
    && days(c.txnDate, row.txnDate) <= TRANSFER_WINDOW_DAYS,
  );
  if (matches.length === 0) return null;

  const names = (c: TransferCandidate) =>
    (!!row.counterpartyAccount && accountNo(c.bankAccountId).endsWith(row.counterpartyAccount))
    || (!!c.counterpartyAccount && accountNo(row.bankAccountId).endsWith(c.counterpartyAccount));
  return [...matches].sort((a, b) => Number(names(b)) - Number(names(a)) || days(a.txnDate, row.txnDate) - days(b.txnDate, row.txnDate))[0];
}
