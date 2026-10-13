import { describe, expect, it } from 'vitest';
import { ruleMatches, suggest, type Rule, type RowFacts } from '../../src/bank/rules';
import { parseIdfcNarration } from '../../src/bank/parsers/idfcNarration';
import { Decimal } from '../../src/lib/money';

// BR-05 Auto-categorisation order. Worked example: OPT/CBDT/... matches keyword rule 'OPT/CBDT'
// and becomes Tax Payment > TDS Deposit (also acceptance A5). Suggestions store their reason.
const row = (narration: string, debit: string, credit = '0'): RowFacts => {
  const p = parseIdfcNarration(narration);
  return { narrationRaw: narration, counterpartyName: p.counterpartyName, mode: p.mode, remark: p.remark, utr: p.utr, debit: new Decimal(debit), credit: new Decimal(credit) };
};

const rule = (over: Partial<Rule>): Rule => ({
  id: 'r', name: 'rule', priority: 100, matchField: 'narration', operator: 'contains', matchValue: '', direction: null,
  amountMin: null, amountMax: null, setCategoryId: 'cat', setSubCategoryId: null, setNature: null, setPartyType: null,
  setDescription: null, isActive: true, ...over,
});

const tdsRule = rule({ id: 'tds', name: 'OPT/CBDT', priority: 10, operator: 'starts_with', matchValue: 'OPT/CBDT', direction: 'debit', setCategoryId: 'taxes', setSubCategoryId: 'tds-deposit', setPartyType: 'govt' });

describe('BR-05 auto-categorisation', () => {
  it('turns an OPT/CBDT payment into Taxes > TDS Deposit with the reason "Rule: OPT/CBDT"', () => {
    const s = suggest([tdsRule], row('OPT/CBDT/26080500079856/05-08-2026/12:12:07', '19600'), () => null);
    expect(s).toEqual({ categoryId: 'taxes', subCategoryId: 'tds-deposit', nature: null, partyType: 'govt', description: null, reason: 'Rule: OPT/CBDT' });
  });

  it('uses rules in priority order', () => {
    const general = rule({ id: 'g', name: 'Any IMPS', priority: 50, matchField: 'mode', operator: 'equals', matchValue: 'IMPS', setCategoryId: 'misc' });
    const specific = rule({ id: 's', name: 'Makenica', priority: 20, matchField: 'counterparty_name', matchValue: 'makenica', setCategoryId: 'rnd' });
    const s = suggest([general, specific], row('IMPS-OPM/625117872046/MAKENICA PRIVATE LIMITED/HDFC0000133/1171/Makenica3DPrint', '7434'), () => null);
    expect(s?.categoryId).toBe('rnd');
    expect(s?.reason).toBe('Rule: Makenica');
  });

  it('falls back to the category last used for the same counterparty (step 4)', () => {
    const s = suggest([tdsRule], row('IMPS-OPM/626018943896/MAKENICA PRIVATE LIMITED/HDFC0000133/1171/QT251390SLSNylonPrint', '18700'), (cp) =>
      cp === 'MAKENICA PRIVATE LIMITED' ? { categoryId: 'rnd', subCategoryId: 'proto', nature: null, partyType: 'vendor' } : null);
    expect(s).toMatchObject({ categoryId: 'rnd', subCategoryId: 'proto', reason: 'Last used for MAKENICA PRIVATE LIMITED' });
  });

  it('leaves a row for Review when nothing matches (step 5)', () => {
    expect(suggest([tdsRule], row('IFT/10199987550/ASTRA SHIELD SOLUTIO/8950768', '1180'), () => null)).toBeNull();
  });

  it('respects direction and amount limits, and skips switched-off rules', () => {
    const creditOnly = rule({ matchValue: 'NEWERA', direction: 'credit', amountMin: new Decimal('5000') });
    expect(ruleMatches(creditOnly, row('IFT/10245658808/NEWERA LIVING /7545890/Business Acc Transfer', '0', '700000'))).toBe(true);
    expect(ruleMatches(creditOnly, row('IFT/10245658808/NEWERA LIVING /17694473', '0', '1180'))).toBe(false);
    expect(suggest([{ ...tdsRule, isActive: false }], row('OPT/CBDT/1/2/3', '1'), () => null)).toBeNull();
  });

  it('treats a broken regex as no match instead of failing the import', () => {
    expect(ruleMatches(rule({ operator: 'regex', matchValue: '([' }), row('OPT/CBDT/1/2/3', '1'))).toBe(false);
  });
});
