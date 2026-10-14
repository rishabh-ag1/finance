import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/lib/money';
import { tieOut } from '../../src/recon/tieOut';

// BR-47 Three-level tie-out. Level 1: each order amount = its gross in the settlement. Level 2: sum of
// lines (gross - fees - GST on fees - refunds +/- adjustments) = settlement net. Level 3: settlement net
// = bank credit. Worked example (B14): orders Rs 1,499 + 2,998 + 1,499 = 5,996 gross; fees at 2% =
// 119.92; GST 18% on fees = 21.59; net 5,854.49 must equal the IDFC credit.
describe('BR-47 three-level tie-out', () => {
  const d = (v: string) => new Decimal(v);
  const line = (order: string, gross: string, fee: string, tax: string) => ({ orderAmount: d(order), gross: d(gross), fee: d(fee), taxOnFee: d(tax), refund: d('0'), adjustment: d('0'), net: d(gross).minus(fee).minus(tax) });
  const lines = [line('1499', '1499', '29.98', '5.40'), line('2998', '2998', '59.96', '10.79'), line('1499', '1499', '29.98', '5.40')];

  it('B14: Rs 5,996 gross, fees Rs 119.92, GST Rs 21.59, net Rs 5,854.49 equals the IDFC credit', () => {
    const t = tieOut({ lines, net: d('5854.49'), bankCredit: d('5854.49') });
    expect(t.totals).toEqual({ gross: '5996.00', fees: '119.92', taxOnFees: '21.59', refunds: '0.00', adjustments: '0.00', net: '5854.49' });
    expect(t.levels).toEqual([
      { level: 1, label: 'Orders vs settlement', difference: '0.00', ok: true },
      { level: 2, label: 'Lines vs settlement net', difference: '0.00', ok: true },
      { level: 3, label: 'Settlement net vs bank credit', difference: '0.00', ok: true },
    ]);
  });

  it('any difference shows at its level', () => {
    const short = [{ ...lines[0], orderAmount: d('1999') }, lines[1], lines[2]];
    const t = tieOut({ lines: short, net: d('5854.49'), bankCredit: d('5850.00') });
    expect(t.levels.map((l) => [l.level, l.difference, l.ok])).toEqual([[1, '-500.00', false], [2, '0.00', true], [3, '-4.49', false]]);
  });

  it('level 3 waits while no bank credit is linked', () => {
    const t = tieOut({ lines, net: d('5854.49'), bankCredit: null });
    expect(t.levels[2]).toEqual({ level: 3, label: 'Settlement net vs bank credit', difference: null, ok: null });
  });
});
