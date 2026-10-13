import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/lib/money';
import { suggestTds, type TdsSectionRates } from '../../src/lib/tds';

// BR-11 TDS base and timing, BR-12 rate and thresholds. Values come from the seeded TDS master
// (old Act, [Verify] with the CA, Q15).
const s194C: TdsSectionRates = {
  id: 'c', label: '194C Contract work', rateIndividual: new Decimal(1), rateOthers: new Decimal(2), rateNoPan: new Decimal(20),
  singleThreshold: new Decimal(30000), annualThreshold: new Decimal(100000),
};
const s194J: TdsSectionRates = {
  id: 'j', label: '194J Professional fees', rateIndividual: new Decimal(10), rateOthers: new Decimal(10), rateNoPan: new Decimal(20),
  singleThreshold: null, annualThreshold: new Decimal(50000),
};
const none = { taxedBase: new Decimal(0), untaxedBase: new Decimal(0) };
const d = (v: string) => new Decimal(v);

describe('BR-11 / BR-12 TDS suggestion', () => {
  it('Saiffi bill 040: base is the taxable value (GST excluded); PAN letter P = individual rate', () => {
    const t = suggestTds({ section: s194C, deducteeType: 'individual', base: d('980000'), date: '2026-07-24', fyBefore: none });
    expect(t).toMatchObject({ applicable: true, rate: '1.00', base: '980000.00', amount: '9800.00' });
    // What was actually deducted (2%, Rs 19,600) is an override that needs a reason (B3).
  });

  it('a company pays the "others" rate; no PAN pays the no-PAN rate', () => {
    expect(suggestTds({ section: s194C, deducteeType: 'company', base: d('980000'), date: '2026-07-24', fyBefore: none }).amount).toBe('19600.00');
    expect(suggestTds({ section: s194C, deducteeType: 'unknown', base: d('50000'), date: '2026-07-24', fyBefore: none })).toMatchObject({ rate: '20.00', amount: '10000.00' });
  });

  it('VideAim PI0037: 10% of Rs 17,000 = Rs 1,700 once the FY total is over the threshold', () => {
    const t = suggestTds({ section: s194J, deducteeType: 'company', base: d('17000'), date: '2026-09-03', fyBefore: { taxedBase: d('40000'), untaxedBase: d('0') } });
    expect(t).toMatchObject({ applicable: true, amount: '1700.00' });
  });

  it('below both thresholds: no TDS, with the reason', () => {
    const t = suggestTds({ section: s194C, deducteeType: 'company', base: d('25000'), date: '2026-09-08', fyBefore: { taxedBase: d('0'), untaxedBase: d('50000') } });
    expect(t.applicable).toBe(false);
    expect(t.reason).toMatch(/below/);
  });

  it('crossing the FY threshold: TDS on the full FY amount, earlier untaxed bills included', () => {
    const t = suggestTds({ section: s194C, deducteeType: 'company', base: d('20000'), date: '2026-10-01', fyBefore: { taxedBase: d('0'), untaxedBase: d('85000') } });
    expect(t).toMatchObject({ applicable: true, base: '105000.00', amount: '2100.00' });
    expect(t.reason).toMatch(/85,000/);
  });

  it('a single bill above the single-payment limit is taxed even when the FY total is small', () => {
    expect(suggestTds({ section: s194C, deducteeType: 'company', base: d('37401'), date: '2026-09-08', fyBefore: none }).amount).toBe('748.02');
  });

  it('a valid lower deduction certificate sets the rate, within its limit and dates', () => {
    const ldc = { number: 'LDC1', rate: new Decimal('0.5'), validFrom: '2026-04-01', validTo: '2027-03-31', limit: new Decimal(1000000) };
    expect(suggestTds({ section: s194C, deducteeType: 'company', base: d('100000'), date: '2026-08-01', fyBefore: none, ldc })).toMatchObject({ rate: '0.50', amount: '500.00' });
    expect(suggestTds({ section: s194C, deducteeType: 'company', base: d('100000'), date: '2027-04-02', fyBefore: none, ldc }).rate).toBe('2.00');
    expect(suggestTds({ section: s194C, deducteeType: 'company', base: d('100000'), date: '2026-08-01', fyBefore: { taxedBase: d('950000'), untaxedBase: d('0') }, ldc }).rate).toBe('2.00');
  });

  it('no section on the vendor or bill: not applicable', () => {
    expect(suggestTds({ section: null, deducteeType: 'company', base: d('100000'), date: '2026-08-01', fyBefore: none })).toMatchObject({ applicable: false, amount: '0.00' });
  });
});
