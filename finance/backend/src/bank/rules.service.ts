import type { PartyType, TxnNature } from '@prisma/client';
import { prisma } from '../config/database';
import { withAudit, type AuditContext } from '../lib/audit';
import { UserError } from '../lib/http';
import { moneyText, parseOptionalMoney } from '../lib/money';
import { ruleMatches, type RuleDirection, type RuleField, type RuleOperator } from './rules';

/** F017 Rules manager: keyword rules with priority order and a test against past rows. */

export type RuleInput = {
  name: string;
  priority: number;
  matchField: RuleField;
  operator: RuleOperator;
  matchValue: string;
  direction: RuleDirection;
  amountMin?: string | null;
  amountMax?: string | null;
  setCategoryId: string;
  setSubCategoryId?: string | null;
  setNature?: TxnNature | null;
  setPartyType?: PartyType | null;
  setDescription?: string | null;
  isActive: boolean;
};

export async function listRules() {
  const rules = await prisma.categorizationRule.findMany({ orderBy: [{ priority: 'asc' }, { name: 'asc' }] });
  const subs = new Map((await prisma.subCategory.findMany({ include: { category: true } })).map((s) => [s.id, s]));
  const cats = new Map((await prisma.category.findMany()).map((c) => [c.id, c]));
  return rules.map((r) => ({
    id: r.id,
    name: r.name,
    priority: r.priority,
    matchField: r.matchField,
    operator: r.operator,
    matchValue: r.matchValue,
    direction: r.direction,
    amountMin: moneyText(r.amountMin),
    amountMax: moneyText(r.amountMax),
    setCategoryId: r.setCategoryId,
    setSubCategoryId: r.setSubCategoryId,
    setNature: r.setNature,
    setPartyType: r.setPartyType,
    setDescription: r.setDescription,
    isActive: r.isActive,
    isSeeded: r.isSeeded,
    target: `${cats.get(r.setCategoryId)?.name ?? '?'}${r.setSubCategoryId ? ` > ${subs.get(r.setSubCategoryId)?.name ?? '?'}` : ''}`,
  }));
}

function ruleData(input: RuleInput) {
  if (!input.name.trim()) throw new UserError('Give the rule a name');
  if (!input.matchValue.trim()) throw new UserError('Say what the rule looks for');
  if (input.operator === 'regex') {
    try { new RegExp(input.matchValue, 'i'); } catch { throw new UserError('The pattern is not a valid regular expression'); }
  }
  const amountMin = parseOptionalMoney(input.amountMin, 'Minimum amount');
  const amountMax = parseOptionalMoney(input.amountMax, 'Maximum amount');
  if (amountMin && amountMax && amountMin.greaterThan(amountMax)) throw new UserError('Minimum is above maximum');
  return {
    name: input.name.trim(),
    priority: input.priority,
    matchField: input.matchField,
    operator: input.operator,
    matchValue: input.matchValue.trim(),
    direction: input.direction,
    amountMin,
    amountMax,
    setCategoryId: input.setCategoryId,
    setSubCategoryId: input.setSubCategoryId || null,
    setNature: input.setNature ?? null,
    setPartyType: input.setPartyType ?? null,
    setDescription: input.setDescription?.trim() || null,
    isActive: input.isActive,
  };
}

async function checkTarget(input: RuleInput) {
  const cat = await prisma.category.findUnique({ where: { id: input.setCategoryId } });
  if (!cat) throw new UserError('Pick the category the rule sets');
  if (input.setSubCategoryId) {
    const sub = await prisma.subCategory.findUnique({ where: { id: input.setSubCategoryId } });
    if (!sub || sub.categoryId !== cat.id) throw new UserError('That sub-category belongs to another category');
  }
}

export async function saveRule(ctx: AuditContext, id: string | null, input: RuleInput) {
  await checkTarget(input);
  const data = ruleData(input);
  await withAudit(ctx, async (tx) => {
    if (id) await tx.categorizationRule.update({ where: { id }, data });
    else await tx.categorizationRule.create({ data });
  });
  return listRules();
}

/** F017 test button: how many past rows the rule would match, with a few examples. */
export async function testRule(input: Pick<RuleInput, 'matchField' | 'operator' | 'matchValue' | 'direction' | 'amountMin' | 'amountMax'>) {
  if (!input.matchValue.trim()) throw new UserError('Say what the rule looks for');
  const rule = {
    matchField: input.matchField,
    operator: input.operator,
    matchValue: input.matchValue,
    direction: input.direction,
    amountMin: parseOptionalMoney(input.amountMin, 'Minimum amount'),
    amountMax: parseOptionalMoney(input.amountMax, 'Maximum amount'),
  };
  const rows = await prisma.bankTxn.findMany({ orderBy: [{ txnDate: 'desc' }, { seq: 'desc' }], take: 10_000 });
  const hits = rows.filter((r) => ruleMatches(rule, r));
  return {
    matches: hits.length,
    examples: hits.slice(0, 5).map((r) => ({
      id: r.id, txnDate: r.txnDate.toISOString().slice(0, 10), counterpartyName: r.counterpartyName,
      narrationRaw: r.narrationRaw, debit: moneyText(r.debit), credit: moneyText(r.credit), status: r.status,
    })),
  };
}
