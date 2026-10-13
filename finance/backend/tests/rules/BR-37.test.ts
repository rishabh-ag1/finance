import { describe, expect, it } from 'vitest';
import { lastCompleteMonths, monthFigures, runway, type Flow } from '../../src/lib/burn';
import { Decimal } from '../../src/lib/money';

// BR-37 Burn and runway (no worked example in rules.md; acceptance A11 runs on the fixture).
const d = (s: string) => new Decimal(s);
const flow = (month: string, nature: Flow['nature'], direction: Flow['direction'], amount: string): Flow => ({ month, nature, direction, amount: d(amount) });

describe('BR-37 burn and runway', () => {
  it('counts only operating expense, COGS and interest in gross burn; capex, loans, tax and transfers stay out', () => {
    const f = monthFigures('2026-09-01', [
      flow('2026-09-01', 'operating_expense', 'out', '30152'),
      flow('2026-09-01', 'cogs', 'out', '1000'),
      flow('2026-09-01', 'interest', 'out', '500'),
      flow('2026-09-01', 'capex', 'out', '19360'),
      flow('2026-09-01', 'tax_payment', 'out', '8592'),
      flow('2026-09-01', 'financing_out', 'out', '100000'),
      flow('2026-09-01', 'transfer', 'out', '200000'),
      flow('2026-09-01', 'financing_in', 'in', '1200000'),
      flow('2026-09-01', 'operating_income', 'in', '2000'),
      flow('2026-08-01', 'operating_expense', 'out', '999'),
    ]);
    expect(f.grossBurn.toFixed(2)).toBe('31652.00');
    expect(f.netBurn.toFixed(2)).toBe('29652.00');
    expect(f.capex.toFixed(2)).toBe('19360.00');
    expect(f.financingIn.toFixed(2)).toBe('1200000.00');
    expect(f.financingOut.toFixed(2)).toBe('100000.00');
    expect(f.taxPaid.toFixed(2)).toBe('8592.00');
  });

  it('A11: runway with no operating income = cash / average net burn of the last 3 complete months', () => {
    const r = runway(d('410869'), [d('0'), d('0'), d('30152')]);
    expect(r).toMatchObject({ kind: 'months' });
    if (r.kind !== 'months') throw new Error('expected months');
    expect(r.averageNetBurn.toFixed(2)).toBe('10050.67');
    expect(r.months.toFixed(1)).toBe('40.8'); // 410869 / 10050.67 = 40.88, shown rounded down
  });

  it('shows "Cash positive" when average net burn is zero or less', () => {
    expect(runway(d('100000'), [d('-5000'), d('2000'), d('0')]).kind).toBe('cash_positive');
  });

  it('takes the three complete months before today (12 Oct 2026 -> Jul, Aug, Sep; Jan -> Oct, Nov, Dec)', () => {
    expect(lastCompleteMonths('2026-10-13')).toEqual(['2026-07-01', '2026-08-01', '2026-09-01']);
    expect(lastCompleteMonths('2027-01-05')).toEqual(['2026-10-01', '2026-11-01', '2026-12-01']);
  });
});
