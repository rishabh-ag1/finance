import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/lib/money';
import { accrualFlows, billAccrualAmount } from '../../src/lib/accrual';

// BR-35 Cash view vs accrual view. Cash: bank rows by date and category. Accrual: vendor bills by bill
// date (sales invoices from Phase 3), plus bank rows with no document. Never both for the same item:
// a bank row linked to a document (a payment) leaves the accrual view.
// Worked example: Saiffi bill 040 dated 24 Jul, taxable Rs 9,80,000 + IGST Rs 1,76,400 (input credit
// claimable), TDS Rs 19,600, paid Rs 11,36,800 on 24 Jul. Cash view: capex Rs 11,36,800 (what left the
// bank). Accrual view: capex Rs 9,80,000 (the cost without the claimable GST), once.
describe('BR-35 cash vs accrual', () => {
  const d = (v: string) => new Decimal(v);
  const bankRow = { date: '2026-07-24', month: '2026-07-01', direction: 'out' as const, nature: 'capex' as const, amount: d('1136800'), categoryId: 'capex', subCategoryId: null, linked: true };
  const office = { date: '2026-07-28', month: '2026-07-01', direction: 'out' as const, nature: 'operating_expense' as const, amount: d('12980'), categoryId: 'ops', subCategoryId: null, linked: false };

  it('the cost of a bill is its taxable value plus other charges; GST only when input credit cannot be claimed', () => {
    expect(billAccrualAmount({ taxableValue: d('980000'), otherCharges: d('0'), gst: d('176400'), itcEligible: true }).toFixed(2)).toBe('980000.00');
    expect(billAccrualAmount({ taxableValue: d('17000'), otherCharges: d('1000'), gst: d('3060'), itcEligible: false }).toFixed(2)).toBe('21060.00');
  });

  it('Saiffi 040: accrual counts the bill, not the bank row that paid it; unlinked rows stay', () => {
    const bill = { date: '2026-07-24', month: '2026-07-01', direction: 'out' as const, nature: 'capex' as const, amount: d('980000'), categoryId: 'capex', subCategoryId: null };
    const flows = accrualFlows([bankRow, office], [bill]);
    expect(flows.map((f) => f.amount.toFixed(2)).sort()).toEqual(['12980.00', '980000.00']);
  });
});
