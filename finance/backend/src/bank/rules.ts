import type { PartyType, TxnNature } from '@prisma/client';
import type { Decimal } from '../lib/money';

/**
 * BR-05 Auto-categorisation - the pure part. Order:
 *  1) expected item (approved payment, loan EMI, TDS challan) - from Phase 2, none yet
 *  2) counterparty mapped to a vendor/customer default category - vendors arrive in M4
 *  3) keyword rules in priority order (F017)
 *  4) category last used for this counterparty
 *  5) Review
 * Every suggestion carries its reason ("Rule: OPT/CBDT", "Last used for MAKENICA ...").
 */

export type RuleField = 'narration' | 'counterparty_name' | 'mode' | 'remark' | 'utr';
export type RuleOperator = 'contains' | 'equals' | 'starts_with' | 'regex';
export type RuleDirection = 'debit' | 'credit' | null;

export type Rule = {
  id: string;
  name: string;
  priority: number;
  matchField: RuleField;
  operator: RuleOperator;
  matchValue: string;
  direction: RuleDirection;
  amountMin: Decimal | null;
  amountMax: Decimal | null;
  setCategoryId: string;
  setSubCategoryId: string | null;
  setNature: TxnNature | null;
  setPartyType: PartyType | null;
  setDescription: string | null;
  isActive: boolean;
};

export type RowFacts = {
  narrationRaw: string;
  counterpartyName: string | null;
  mode: string | null;
  remark: string | null;
  utr: string | null;
  debit: Decimal;
  credit: Decimal;
};

function fieldValue(row: RowFacts, field: RuleField): string {
  switch (field) {
    case 'narration': return row.narrationRaw;
    case 'counterparty_name': return row.counterpartyName ?? '';
    case 'mode': return row.mode ?? '';
    case 'remark': return row.remark ?? '';
    case 'utr': return row.utr ?? '';
  }
}

/** Case-insensitive match of one rule against one bank row. */
export function ruleMatches(rule: Pick<Rule, 'matchField' | 'operator' | 'matchValue' | 'direction' | 'amountMin' | 'amountMax'>, row: RowFacts): boolean {
  const isDebit = row.debit.greaterThan(0);
  if (rule.direction === 'debit' && !isDebit) return false;
  if (rule.direction === 'credit' && isDebit) return false;
  const amount = isDebit ? row.debit : row.credit;
  if (rule.amountMin && amount.lessThan(rule.amountMin)) return false;
  if (rule.amountMax && amount.greaterThan(rule.amountMax)) return false;

  const value = fieldValue(row, rule.matchField).toLowerCase();
  const needle = rule.matchValue.toLowerCase();
  switch (rule.operator) {
    case 'contains': return value.includes(needle);
    case 'equals': return value.trim() === needle.trim();
    case 'starts_with': return value.startsWith(needle);
    case 'regex':
      try {
        return new RegExp(rule.matchValue, 'i').test(fieldValue(row, rule.matchField));
      } catch {
        return false;
      }
  }
}

export type Suggestion = {
  categoryId: string;
  subCategoryId: string | null;
  /** Null = take the sub-category's nature. */
  nature: TxnNature | null;
  partyType: PartyType | null;
  description: string | null;
  reason: string;
};

export type LastUsed = { categoryId: string; subCategoryId: string | null; nature: TxnNature | null; partyType: PartyType | null };

/**
 * Steps 3-5 of BR-05 for one row. `lastUsedFor` returns the category most recently confirmed
 * for this counterparty (step 4). Returns null for Review.
 */
export function suggest(rules: Rule[], row: RowFacts, lastUsedFor: (counterparty: string) => LastUsed | null): Suggestion | null {
  const active = rules.filter((r) => r.isActive).sort((a, b) => a.priority - b.priority);
  for (const r of active) {
    if (ruleMatches(r, row)) {
      return {
        categoryId: r.setCategoryId,
        subCategoryId: r.setSubCategoryId,
        nature: r.setNature,
        partyType: r.setPartyType,
        description: r.setDescription,
        reason: `Rule: ${r.name}`,
      };
    }
  }
  if (row.counterpartyName) {
    const last = lastUsedFor(row.counterpartyName);
    if (last) {
      return { ...last, description: null, reason: `Last used for ${row.counterpartyName}` };
    }
  }
  return null;
}
