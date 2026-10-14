import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/lib/money';
import { challanProblems, suggestDeductions } from '../../src/lib/tdsRegister';

// BR-14 Challan matching: challan amount = linked deductions + interest + fee; linked deductions
// become Deposited; the OPT/CBDT bank row with the same amount and date is linked.
// Worked example: 7 Sep: three challans Rs 1,080 (Valco), Rs 5,812 (Micro Instruments),
// Rs 1,700 (VideAim), each matched to one deduction.
const d = (v: string) => new Decimal(v);
const open = [
  { id: 'valco', amount: d('1080'), month: '2026-08-01' },
  { id: 'micro', amount: d('5812'), month: '2026-08-01' },
  { id: 'videaim', amount: d('1700'), month: '2026-08-01' },
];

describe('BR-14 challans', () => {
  it('7 Sep: each challan matches exactly one deduction', () => {
    expect(suggestDeductions(d('1080'), open)).toEqual(['valco']);
    expect(suggestDeductions(d('5812'), open)).toEqual(['micro']);
    expect(suggestDeductions(d('1700'), open)).toEqual(['videaim']);
  });
  it("one challan for a whole month's deductions is matched to all of them", () => {
    expect(suggestDeductions(d('8592'), open).sort()).toEqual(['micro', 'valco', 'videaim']);
  });
  it('no suggestion when nothing adds up', () => {
    expect(suggestDeductions(d('999'), open)).toEqual([]);
  });
  it('the challan must add up: TDS = linked deductions, total = TDS + interest + fee', () => {
    expect(challanProblems({ tds: d('1080'), interest: d('0'), fee: d('0'), total: d('1080'), linked: d('1080') })).toEqual([]);
    expect(challanProblems({ tds: d('1080'), interest: d('16.20'), fee: d('0'), total: d('1080'), linked: d('1080') })[0]).toMatch(/total/);
    expect(challanProblems({ tds: d('1080'), interest: d('0'), fee: d('0'), total: d('1080'), linked: d('1700') })[0]).toMatch(/deductions/);
  });
});
