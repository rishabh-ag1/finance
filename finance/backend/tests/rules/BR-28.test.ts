import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/lib/money';
import { accruedInterest, addMonths, covenantCheck, emiAmount, flexibleState, loanSchedule, shareApplicationAlert } from '../../src/lib/loans';

const d = (v: string) => new Decimal(v);

// BR-28 loans and covenant. Worked example: Mesa Rs 12,00,000 disbursed 4 Jun 2026, flexible:
// repay any time within 18 months. Total debt = principal outstanding on all loans + drawn cash
// credit; warn above Rs 45,00,000 (Mesa aggregate cap).
describe('BR-28 flexible loan (Mesa)', () => {
  it('Rs 12,00,000 from 4 Jun 2026 over 18 months: final due 4 Dec 2027, 415 days left on 15 Oct 2026', () => {
    expect(addMonths('2026-06-04', 18)).toBe('2027-12-04');
    expect(flexibleState({ disbursed: d('1200000'), disbursedDate: '2026-06-04', finalDueDate: '2027-12-04', principalRepaid: d('0') }, '2026-10-15'))
      .toEqual({ balance: '1200000.00', daysToFinalDue: 415, overdue: false });
  });
  it('a prepayment of Rs 2,00,000 leaves Rs 10,00,000; after the final date with money owed it is overdue', () => {
    expect(flexibleState({ disbursed: d('1200000'), disbursedDate: '2026-06-04', finalDueDate: '2027-12-04', principalRepaid: d('200000') }, '2027-12-05'))
      .toEqual({ balance: '1000000.00', daysToFinalDue: -1, overdue: true });
  });
  it('simple interest on the balance, actual days / 365: Rs 12,00,000 at 10% for 30 days = Rs 9,863.01', () => {
    expect(accruedInterest(d('1200000'), d('10'), '2026-06-04', '2026-07-04')).toBe('9863.01');
    expect(accruedInterest(d('1200000'), null, '2026-06-04', '2026-07-04')).toBe('0.00');
  });
});

describe('BR-28 EMI and bullet schedules', () => {
  it('Rs 10,00,000 at 12% over 12 months: EMI Rs 88,849; month 1 interest Rs 10,000; the last instalment clears the loan', () => {
    expect(emiAmount(d('1000000'), d('12'), 12).toFixed(2)).toBe('88849.00');
    const s = loanSchedule({ type: 'emi', principal: d('1000000'), annualRate: d('12'), months: 12, firstDue: '2026-07-05', moratoriumMonths: 0 });
    expect(s).toHaveLength(12);
    expect(s[0]).toMatchObject({ instalmentNo: 1, dueDate: '2026-07-05', interest: '10000.00', principal: '78849.00', total: '88849.00', closingBalance: '921151.00' });
    expect(s[11]).toMatchObject({ dueDate: '2027-06-05', closingBalance: '0.00' });
    expect(s.reduce((x, r) => x.plus(r.principal), d('0')).toFixed(2)).toBe('1000000.00');
  });
  it('a 2-month moratorium pays interest only first', () => {
    const s = loanSchedule({ type: 'emi', principal: d('600000'), annualRate: d('12'), months: 6, firstDue: '2026-07-05', moratoriumMonths: 2 });
    expect(s).toHaveLength(8);
    expect(s[0]).toMatchObject({ principal: '0.00', interest: '6000.00', total: '6000.00', closingBalance: '600000.00' });
    expect(s[7].closingBalance).toBe('0.00');
  });
  it('bullet: interest each month, the principal with the last instalment', () => {
    const s = loanSchedule({ type: 'bullet', principal: d('500000'), annualRate: d('12'), months: 6, firstDue: '2026-07-05', moratoriumMonths: 0 });
    expect(s.map((r) => r.total)).toEqual(['5000.00', '5000.00', '5000.00', '5000.00', '5000.00', '505000.00']);
  });
});

describe('BR-28 covenant', () => {
  it('Mesa Rs 12,00,000 outstanding: a new Rs 34,00,000 loan takes total debt to Rs 46,00,000, above the Rs 45,00,000 cap', () => {
    expect(covenantCheck({ loansOutstanding: d('1200000'), cashCreditDrawn: d('0'), cap: d('4500000'), adding: d('3400000') })).toEqual({
      totalDebt: '4600000.00', cap: '4500000.00', headroom: '-100000.00', breached: true,
      warning: 'Total debt Rs 46,00,000.00 would be above the Rs 45,00,000.00 cap in the Mesa agreement (by Rs 1,00,000.00)',
    });
    expect(covenantCheck({ loansOutstanding: d('1200000'), cashCreditDrawn: d('300000'), cap: d('4500000'), adding: d('0') })).toMatchObject({ totalDebt: '1500000.00', headroom: '3000000.00', breached: false, warning: null });
  });
});

describe('share application money', () => {
  it('not allotted within 60 days of receipt is flagged [Verify with the CA]', () => {
    expect(shareApplicationAlert({ receivedOn: '2026-08-01', allotmentDate: null }, '2026-10-15')).toEqual({ days: 75, overdue: true });
    expect(shareApplicationAlert({ receivedOn: '2026-08-01', allotmentDate: '2026-09-01' }, '2026-10-15')).toBeNull();
  });
});
