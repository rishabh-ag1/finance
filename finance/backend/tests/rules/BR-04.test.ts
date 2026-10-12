import { describe, expect, it } from 'vitest';
import { groupCategoryMaster, readCategoryMaster } from '../../src/lib/categoryMaster';
import { countsAsOperatingIncome, countsInGrossBurn, isPnl, resolveNature } from '../../src/lib/nature';

// BR-04 Nature of transaction. Worked example:
//   Rs 12,00,000 from Neos Kosmos on 4 Jun = Financing In (loan), not Income.
//   Rs 11,36,800 to Saiffi on 24 Jul = Capex (tooling).
//   Rs 19,600 OPT/CBDT on 5 Aug = Tax Payment, settles TDS payable, not a new expense.
// The natures come from the Category Master table in docs/spec.md, read as the seed reads it.
const seeds = groupCategoryMaster(readCategoryMaster());

function natureOf(category: string, sub: string) {
  const cat = seeds.find((c) => c.name === category);
  const s = cat?.subs.find((x) => x.name === sub);
  if (!cat || !s) throw new Error(`${category} > ${sub} is not in the Category Master`);
  return resolveNature(cat, s);
}

describe('BR-04 nature of transaction', () => {
  it('treats the Neos Kosmos (Mesa) loan as Financing In, outside P&L and burn', () => {
    const n = natureOf('Financing', 'Loan Received');
    expect(n).toBe('financing_in');
    expect(isPnl(n)).toBe(false);
    expect(countsAsOperatingIncome(n)).toBe(false);
  });

  it('treats the Saiffi tooling payment as Capex, outside P&L and burn', () => {
    const n = natureOf('Capex', 'Tooling & Moulds');
    expect(n).toBe('capex');
    expect(isPnl(n)).toBe(false);
    expect(countsInGrossBurn(n)).toBe(false);
  });

  it('treats the OPT/CBDT TDS deposit as Tax Payment, not a new expense', () => {
    const n = natureOf('Taxes', 'TDS Deposit');
    expect(n).toBe('tax_payment');
    expect(countsInGrossBurn(n)).toBe(false);
  });

  it('counts only Operating Income, Operating Expense, COGS and Interest in P&L', () => {
    expect(isPnl('operating_income')).toBe(true);
    expect(isPnl('operating_expense')).toBe(true);
    expect(isPnl('cogs')).toBe(true);
    expect(isPnl('interest')).toBe(true);
    for (const n of ['capex', 'financing_in', 'financing_out', 'tax_payment', 'transfer', 'related_party', 'refund_reversal', 'reimbursement', 'advance'] as const) {
      expect(isPnl(n)).toBe(false);
    }
  });

  it('keeps a sub-category nature that differs from its category (Operations_Admin > GST & Taxes)', () => {
    expect(natureOf('Operations_Admin', 'Office / Admin Misc')).toBe('operating_expense');
    expect(natureOf('Operations_Admin', 'GST & Taxes')).toBe('tax_payment');
    expect(natureOf('Packaging_Printing', 'Boxes / Cartons')).toBe('cogs');
    expect(natureOf('Packaging_Printing', 'Business Cards')).toBe('operating_expense');
  });

  it('reads every row of the Category Master', () => {
    expect(seeds.reduce((n, c) => n + c.subs.length, 0)).toBe(90);
    expect(natureOf('Related Party', 'Newera Living Transfer')).toBe('related_party');
    expect(natureOf('Founder Reimbursement', 'Reimbursement to Founder')).toBe('reimbursement');
  });
});
