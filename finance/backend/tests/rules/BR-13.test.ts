import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/lib/money';
import { tdsDueDate, tdsLateInterest } from '../../src/lib/tdsRegister';

// BR-13 TDS deposit due date: deducted in a month, due by the 7th of the next month; March
// deductions due by 30 April. Late deposit: 1.5% a month or part of a month ([Verify], settings).
// Worked example: Saiffi deducted 24 Jul, deposited 5 Aug (on time). Micro Instruments deducted
// 19 Aug, deposited 7 Sep (on the due date).
describe('BR-13 TDS due date and late interest', () => {
  it('due on the 7th of the next month', () => {
    expect(tdsDueDate('2026-07-24')).toBe('2026-08-07');
    expect(tdsDueDate('2026-08-19')).toBe('2026-09-07');
    expect(tdsDueDate('2026-12-31')).toBe('2027-01-07');
  });
  it('March deductions are due on 30 April', () => {
    expect(tdsDueDate('2027-03-01')).toBe('2027-04-30');
    expect(tdsDueDate('2027-03-31')).toBe('2027-04-30');
  });
  it('no interest when deposited by the due date (Saiffi 5 Aug, Micro Instruments 7 Sep)', () => {
    expect(tdsLateInterest({ amount: new Decimal('19600'), deductionDate: '2026-07-24', depositDate: '2026-08-05', ratePerMonth: new Decimal('1.5') }))
      .toMatchObject({ months: 0, interest: '0.00' });
    expect(tdsLateInterest({ amount: new Decimal('5812'), deductionDate: '2026-08-19', depositDate: '2026-09-07', ratePerMonth: new Decimal('1.5') }).interest).toBe('0.00');
  });
  it('late: 1.5% for each month or part of a month from deduction to deposit', () => {
    // Deducted 24 Jul, deposited 8 Aug: July and August count = 2 months = 3%.
    expect(tdsLateInterest({ amount: new Decimal('19600'), deductionDate: '2026-07-24', depositDate: '2026-08-08', ratePerMonth: new Decimal('1.5') }))
      .toMatchObject({ months: 2, interest: '588.00' });
    // Still not deposited on 14 Oct: Jul, Aug, Sep, Oct = 4 months.
    expect(tdsLateInterest({ amount: new Decimal('1000'), deductionDate: '2026-07-24', depositDate: null, today: '2026-10-14', ratePerMonth: new Decimal('1.5') }))
      .toMatchObject({ months: 4, interest: '60.00' });
  });
});
