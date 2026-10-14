import { Decimal } from '../lib/money';

/**
 * BR-47 three-level tie-out of one settlement or COD remittance.
 *   Level 1: each order's amount = its gross in the batch (lines with no order are left out).
 *   Level 2: sum of lines (gross - fee - GST on fee - refund + adjustment) = the batch net.
 *   Level 3: batch net = the bank credit it was matched to (waits until matched).
 * Differences are shown as found - expected; anything non-zero raises a discrepancy (BR-46).
 */

export type TieOutLine = { orderAmount: Decimal | null; gross: Decimal; fee: Decimal; taxOnFee: Decimal; refund: Decimal; adjustment: Decimal; net: Decimal };
export type TieOutLevel = { level: 1 | 2 | 3; label: string; difference: string | null; ok: boolean | null };

const sum = (xs: Decimal[]) => xs.reduce((s, x) => s.plus(x), new Decimal(0));

export function tieOut(b: { lines: TieOutLine[]; net: Decimal; bankCredit: Decimal | null }) {
  const withOrder = b.lines.filter((l) => l.orderAmount !== null);
  const level1 = sum(withOrder.map((l) => l.gross)).minus(sum(withOrder.map((l) => l.orderAmount!)));
  const fromLines = sum(b.lines.map((l) => l.gross.minus(l.fee).minus(l.taxOnFee).minus(l.refund).plus(l.adjustment)));
  const level2 = fromLines.minus(b.net);
  const level3 = b.bankCredit === null ? null : b.bankCredit.minus(b.net);
  return {
    totals: {
      gross: sum(b.lines.map((l) => l.gross)).toFixed(2),
      fees: sum(b.lines.map((l) => l.fee)).toFixed(2),
      taxOnFees: sum(b.lines.map((l) => l.taxOnFee)).toFixed(2),
      refunds: sum(b.lines.map((l) => l.refund)).toFixed(2),
      adjustments: sum(b.lines.map((l) => l.adjustment)).toFixed(2),
      net: b.net.toFixed(2),
    },
    levels: [
      { level: 1, label: 'Orders vs settlement', difference: level1.toFixed(2), ok: level1.isZero() },
      { level: 2, label: 'Lines vs settlement net', difference: level2.toFixed(2), ok: level2.isZero() },
      { level: 3, label: 'Settlement net vs bank credit', difference: level3 === null ? null : level3.toFixed(2), ok: level3 === null ? null : level3.isZero() },
    ] as TieOutLevel[],
  };
}
