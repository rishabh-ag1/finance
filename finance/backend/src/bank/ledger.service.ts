import type { BankTxn, BankTxnStatus, PartyType, Prisma, TxnNature, TxnSplit } from '@prisma/client';
import { prisma } from '../config/database';
import { withAudit, type AuditContext, type Tx } from '../lib/audit';
import { dateText, parseDate } from '../lib/dates';
import { UserError } from '../lib/http';
import { Decimal, moneyText, parseMoney } from '../lib/money';
import { resolveNature } from '../lib/nature';
import { suggest, type LastUsed, type Rule, type RuleDirection, type RuleField, type RuleOperator, type Suggestion } from './rules';
import { splitProblem } from './split';
import { findTransferPartner } from './transfers';
import { txnView } from './import.service';

/**
 * M3 ledger and review (F014-F021): auto-categorisation (BR-05), transfer pairing (BR-06),
 * split (BR-07), related party tagging (BR-29), and the person's actions on a row. Statuses
 * follow docs/spec.md Status Flows; a person never types a status.
 */

const RELATED_PARTY_TYPES = ['business_transfer', 'director_loan', 'capital', 'undecided'] as const;
export type RelatedPartyType = (typeof RELATED_PARTY_TYPES)[number];

// ---------- BR-05 auto-categorisation and BR-06 pairing (run inside the import transaction) ----------

export async function loadRules(tx: Tx | typeof prisma): Promise<Rule[]> {
  const rows = await tx.categorizationRule.findMany({ where: { isActive: true }, orderBy: { priority: 'asc' } });
  return rows.map((r) => ({
    ...r,
    matchField: r.matchField as RuleField,
    operator: r.operator as RuleOperator,
    direction: r.direction as RuleDirection,
  }));
}

/** Suggests a category for each given row still in Review; rows without a suggestion stay in Review. */
export async function autoCategorise(tx: Tx, txnIds: string[]): Promise<number> {
  if (txnIds.length === 0) return 0;
  const rules = await loadRules(tx);
  const rows = await tx.bankTxn.findMany({ where: { id: { in: txnIds }, status: 'review' } });
  const subs = new Map((await tx.subCategory.findMany({ include: { category: true } })).map((s) => [s.id, s]));
  const categories = new Map((await tx.category.findMany()).map((c) => [c.id, c]));

  // Step 4: the category most recently confirmed for each counterparty.
  const parties = [...new Set(rows.map((r) => r.counterpartyName).filter((n): n is string => !!n))];
  const confirmed = await tx.bankTxn.findMany({
    where: { counterpartyName: { in: parties }, status: 'categorised', categoryId: { not: null } },
    orderBy: [{ txnDate: 'desc' }, { seq: 'desc' }],
    select: { counterpartyName: true, categoryId: true, subCategoryId: true, nature: true, partyType: true },
  });
  const lastUsed = new Map<string, LastUsed>();
  for (const c of confirmed) {
    if (c.counterpartyName && !lastUsed.has(c.counterpartyName)) {
      lastUsed.set(c.counterpartyName, { categoryId: c.categoryId!, subCategoryId: c.subCategoryId, nature: c.nature, partyType: c.partyType });
    }
  }

  // Step 2: the counterparty is a known vendor (by one of its bank names).
  const vendors = (await tx.vendor.findMany({ where: { isArchived: false, NOT: { bankNames: { isEmpty: true } } } }))
    .flatMap((v) => v.bankNames.map((n) => ({ vendor: v, name: n.toUpperCase() })))
    .sort((a, b) => b.name.length - a.name.length); // the longest (most specific) name wins
  const vendorFor = (cp: string | null) => (cp ? vendors.find((x) => cp.toUpperCase().includes(x.name))?.vendor ?? null : null);

  let suggested = 0;
  for (const row of rows) {
    const vendor = vendorFor(row.counterpartyName);
    const s: Suggestion | null = vendor?.defaultCategoryId
      ? { categoryId: vendor.defaultCategoryId, subCategoryId: vendor.defaultSubCategoryId, nature: null, partyType: 'vendor', description: null, reason: `Vendor: ${vendor.displayName}` }
      : suggest(rules, row, (cp) => lastUsed.get(cp) ?? null);
    const category = s ? categories.get(s.categoryId) : undefined;
    if (!s || !category) {
      if (vendor) await tx.bankTxn.update({ where: { id: row.id }, data: { partyType: 'vendor', partyId: vendor.id } });
      continue;
    }
    const sub = s.subCategoryId ? subs.get(s.subCategoryId) : null;
    const nature = s.nature ?? resolveNature(category, sub ?? null);
    await tx.bankTxn.update({
      where: { id: row.id },
      data: {
        categoryId: category.id,
        subCategoryId: sub?.id ?? null,
        nature,
        partyType: vendor ? 'vendor' : s.partyType,
        partyId: vendor?.id ?? null,
        description: row.description ?? s.description,
        relatedPartyType: nature === 'related_party' ? 'undecided' : null,
        status: 'suggested',
        categorisationReason: s.reason,
      },
    });
    suggested += 1;
  }
  return suggested;
}

/** BR-06: pairs each given row with an opposite row in another own account. Returns pairs made. */
export async function pairTransfers(tx: Tx, txnIds: string[]): Promise<number> {
  if (txnIds.length === 0) return 0;
  const own = await tx.bankAccount.findMany({
    where: { owner: 'Entelechy', accountType: { in: ['business_current', 'cash_credit', 'wallet', 'loan'] } },
    select: { id: true, accountNumber: true },
  });
  if (own.length < 2) return 0;
  const transfers = await tx.category.findUnique({ where: { name: 'Transfers' }, include: { subCategories: true } });
  const interBank = transfers?.subCategories.find((s) => s.name === 'Inter-Bank Transfer') ?? null;

  let pairs = 0;
  const rows = await tx.bankTxn.findMany({ where: { id: { in: txnIds }, transferPairId: null, status: { in: ['review', 'suggested'] } } });
  for (const row of rows) {
    const from = new Date(row.txnDate.getTime() - 3 * 86_400_000);
    const to = new Date(row.txnDate.getTime() + 3 * 86_400_000);
    const candidates = await tx.bankTxn.findMany({
      where: { bankAccountId: { not: row.bankAccountId }, transferPairId: null, txnDate: { gte: from, lte: to }, status: { in: ['review', 'suggested'] } },
    });
    const view = (t: BankTxn) => ({ id: t.id, bankAccountId: t.bankAccountId, txnDate: dateText(t.txnDate)!, debit: t.debit, credit: t.credit, counterpartyAccount: t.counterpartyAccount, transferPairId: t.transferPairId });
    const partner = findTransferPartner(view(row), candidates.map(view), own);
    if (!partner) continue;
    const data = (pairId: string) => ({
      transferPairId: pairId,
      status: 'transfer' as const,
      nature: 'transfer' as const,
      categoryId: transfers?.id ?? null,
      subCategoryId: interBank?.id ?? null,
      partyType: 'own_account' as const,
      categorisationReason: 'Own-account transfer (BR-06)',
    });
    await tx.bankTxn.update({ where: { id: row.id }, data: data(partner.id) });
    await tx.bankTxn.update({ where: { id: partner.id }, data: data(row.id) });
    pairs += 1;
  }
  return pairs;
}

// ---------- Reading ----------

export type LedgerFilter = {
  accountId?: string;
  from?: string;
  to?: string;
  status?: BankTxnStatus | 'needs_review';
  categoryId?: string;
  subCategoryId?: string;
  nature?: TxnNature;
  direction?: 'in' | 'out';
  q?: string;
  min?: string;
  max?: string;
  limit?: number;
  offset?: number;
};

function splitView(s: TxnSplit) {
  return {
    id: s.id, lineNo: s.lineNo, amount: moneyText(s.amount), categoryId: s.categoryId, subCategoryId: s.subCategoryId,
    nature: s.nature, partyType: s.partyType, description: s.description, note: s.note,
  };
}

/**
 * F014 ledger list. Totals are for everything the filter matches (not just this page). With a
 * category or nature filter, split rows count only their matching lines.
 */
export async function listLedger(f: LedgerFilter) {
  const where: Prisma.BankTxnWhereInput = {
    ...(f.accountId && { bankAccountId: f.accountId }),
    ...((f.from || f.to) && { txnDate: { ...(f.from && { gte: parseDate(f.from, 'From') }), ...(f.to && { lte: parseDate(f.to, 'To') }) } }),
    ...(f.status === 'needs_review' ? { status: { in: ['review', 'suggested'] } } : f.status ? { status: f.status } : {}),
    ...(f.direction === 'in' && { credit: { gt: 0 } }),
    ...(f.direction === 'out' && { debit: { gt: 0 } }),
    ...(f.q && {
      OR: [
        { narrationRaw: { contains: f.q, mode: 'insensitive' } },
        { counterpartyName: { contains: f.q, mode: 'insensitive' } },
        { description: { contains: f.q, mode: 'insensitive' } },
        { notes: { contains: f.q, mode: 'insensitive' } },
        { utr: { contains: f.q, mode: 'insensitive' } },
      ],
    }),
  };
  const lineFilter = f.categoryId || f.subCategoryId || f.nature;
  if (lineFilter) {
    const match = { ...(f.categoryId && { categoryId: f.categoryId }), ...(f.subCategoryId && { subCategoryId: f.subCategoryId }), ...(f.nature && { nature: f.nature }) };
    where.AND = [{ OR: [match, { status: 'split', splits: { some: { ...match, isArchived: false } } }] }];
  }

  const rows = await prisma.bankTxn.findMany({
    where,
    orderBy: [{ txnDate: 'desc' }, { seq: 'desc' }],
    include: { splits: { where: { isArchived: false }, orderBy: { lineNo: 'asc' } }, bankAccount: { select: { bankName: true, accountNumber: true } } },
    take: 5000,
  });

  const min = f.min ? parseMoney(f.min, 'Minimum') : null;
  const max = f.max ? parseMoney(f.max, 'Maximum') : null;
  const amountOf = (r: (typeof rows)[number]) => (r.debit.greaterThan(0) ? r.debit : r.credit);
  const kept = rows.filter((r) => (!min || amountOf(r).greaterThanOrEqualTo(min)) && (!max || amountOf(r).lessThanOrEqualTo(max)));

  let inflow = new Decimal(0);
  let outflow = new Decimal(0);
  for (const r of kept) {
    const lines = lineFilter && r.status === 'split'
      ? r.splits.filter((s) => (!f.categoryId || s.categoryId === f.categoryId) && (!f.subCategoryId || s.subCategoryId === f.subCategoryId) && (!f.nature || s.nature === f.nature)).map((s) => s.amount)
      : [amountOf(r)];
    const amount = lines.reduce((s, a) => s.plus(a), new Decimal(0));
    if (r.debit.greaterThan(0)) outflow = outflow.plus(amount);
    else inflow = inflow.plus(amount);
  }

  const offset = f.offset ?? 0;
  const limit = Math.min(f.limit ?? 100, 500);
  return {
    totals: { count: kept.length, inflow: moneyText(inflow), outflow: moneyText(outflow), net: moneyText(inflow.minus(outflow)) },
    rows: kept.slice(offset, offset + limit).map((r) => ({
      ...txnView(r),
      relatedPartyType: r.relatedPartyType,
      transferPairId: r.transferPairId,
      bankName: r.bankAccount.bankName,
      accountNumberMasked: `•••• ${r.bankAccount.accountNumber.slice(-4)}`,
      splits: r.splits.map(splitView),
    })),
    nextOffset: offset + limit < kept.length ? offset + limit : null,
  };
}

export async function getTxn(id: string) {
  const t = await prisma.bankTxn.findUnique({
    where: { id },
    include: { splits: { where: { isArchived: false }, orderBy: { lineNo: 'asc' } }, bankAccount: { select: { bankName: true, accountNumber: true } } },
  });
  if (!t) throw new UserError('Transaction not found', 404);
  const pair = t.transferPairId ? await prisma.bankTxn.findUnique({ where: { id: t.transferPairId }, include: { bankAccount: { select: { bankName: true } } } }) : null;
  return {
    ...txnView(t),
    relatedPartyType: t.relatedPartyType,
    transferPairId: t.transferPairId,
    bankName: t.bankAccount.bankName,
    accountNumberMasked: `•••• ${t.bankAccount.accountNumber.slice(-4)}`,
    splits: t.splits.map(splitView),
    pair: pair ? { id: pair.id, bankName: pair.bankAccount.bankName, txnDate: dateText(pair.txnDate), debit: moneyText(pair.debit), credit: moneyText(pair.credit) } : null,
  };
}

export async function reviewCount() {
  return { count: await prisma.bankTxn.count({ where: { status: { in: ['review', 'suggested'] } } }) };
}

// ---------- A person's actions ----------

async function loadTxn(id: string) {
  const t = await prisma.bankTxn.findUnique({ where: { id } });
  if (!t) throw new UserError('Transaction not found', 404);
  return t;
}

async function resolveCategory(categoryId: string, subCategoryId: string | null | undefined, nature: TxnNature | null | undefined) {
  const category = await prisma.category.findUnique({ where: { id: categoryId } });
  if (!category) throw new UserError('Pick a category');
  const sub = subCategoryId ? await prisma.subCategory.findUnique({ where: { id: subCategoryId } }) : null;
  if (subCategoryId && (!sub || sub.categoryId !== category.id)) throw new UserError('That sub-category belongs to another category');
  return { category, sub, nature: nature ?? resolveNature(category, sub) };
}

export type CategoriseInput = {
  categoryId: string;
  subCategoryId?: string | null;
  /** Override the sub-category's nature (BR-04: set by the category, can be overridden). */
  nature?: TxnNature | null;
  partyType?: PartyType | null;
  description?: string | null;
  notes?: string | null;
  relatedPartyType?: RelatedPartyType | null;
};

const EDITABLE: BankTxnStatus[] = ['review', 'suggested', 'categorised'];

/** Confirms or changes a row's category: status Categorised. */
export async function categorise(ctx: AuditContext, id: string, input: CategoriseInput) {
  const t = await loadTxn(id);
  if (!EDITABLE.includes(t.status)) {
    throw new UserError(t.status === 'split' ? 'This row is split; change its lines, or unsplit it first'
      : t.status === 'transfer' ? 'This row is an own-account transfer; unpair it first'
      : t.status === 'ignored' ? 'This row is ignored; restore it first' : 'This row cannot be changed here');
  }
  const { category, sub, nature } = await resolveCategory(input.categoryId, input.subCategoryId, input.nature);
  if (input.relatedPartyType && !RELATED_PARTY_TYPES.includes(input.relatedPartyType)) throw new UserError('Unknown related-party type');
  await withAudit(ctx, (tx) => tx.bankTxn.update({
    where: { id },
    data: {
      categoryId: category.id,
      subCategoryId: sub?.id ?? null,
      nature,
      partyType: input.partyType ?? t.partyType,
      description: input.description !== undefined ? input.description?.trim() || null : t.description,
      notes: input.notes !== undefined ? input.notes?.trim() || null : t.notes,
      relatedPartyType: nature === 'related_party' ? (input.relatedPartyType ?? t.relatedPartyType ?? 'undecided') : null,
      status: 'categorised',
      categorisationReason: t.status === 'suggested' && t.categoryId === category.id && t.subCategoryId === (sub?.id ?? null)
        ? `${t.categorisationReason} (accepted)`
        : 'Set by hand',
    },
  }));
  return getTxn(id);
}

/** F016 bulk accept: every listed row that has a suggestion becomes Categorised as suggested. */
export async function acceptSuggestions(ctx: AuditContext, ids: string[]) {
  const rows = await prisma.bankTxn.findMany({ where: { id: { in: ids }, status: 'suggested' } });
  await withAudit(ctx, async (tx) => {
    for (const r of rows) {
      await tx.bankTxn.update({ where: { id: r.id }, data: { status: 'categorised', categorisationReason: `${r.categorisationReason} (accepted)` } });
    }
  }, { timeoutMs: 60_000 });
  return { accepted: rows.length, skipped: ids.length - rows.length };
}

/** A9: instead of a delete, a row is ignored with a note (reversal pairs, test credits). */
export async function ignore(ctx: AuditContext, id: string, note: string) {
  const t = await loadTxn(id);
  if (!note.trim()) throw new UserError('Say why this row is ignored');
  if (!['review', 'suggested', 'categorised'].includes(t.status)) throw new UserError('Only rows in review or categorised can be ignored');
  await withAudit({ ...ctx, reason: note.trim() }, (tx) => tx.bankTxn.update({
    where: { id },
    data: { status: 'ignored', notes: t.notes ? `${t.notes}\n${note.trim()}` : note.trim(), categorisationReason: 'Ignored' },
  }));
  return getTxn(id);
}

export async function restore(ctx: AuditContext, id: string) {
  const t = await loadTxn(id);
  if (t.status !== 'ignored') throw new UserError('Only ignored rows can be restored');
  await withAudit(ctx, (tx) => tx.bankTxn.update({ where: { id }, data: { status: 'review', categorisationReason: 'Restored to review' } }));
  return getTxn(id);
}

export async function setNotes(ctx: AuditContext, id: string, notes: string | null, description?: string | null) {
  await loadTxn(id);
  await withAudit(ctx, (tx) => tx.bankTxn.update({
    where: { id },
    data: { notes: notes?.trim() || null, ...(description !== undefined && { description: description?.trim() || null }) },
  }));
  return getTxn(id);
}

export type SplitLineInput = {
  amount: string;
  categoryId: string;
  subCategoryId?: string | null;
  nature?: TxnNature | null;
  partyType?: PartyType | null;
  description?: string | null;
  note?: string | null;
};

/** BR-07: replaces the row's category with lines that add up to the bank amount. */
export async function split(ctx: AuditContext, id: string, lines: SplitLineInput[]) {
  const t = await loadTxn(id);
  if (!['review', 'suggested', 'categorised', 'split'].includes(t.status)) throw new UserError('This row cannot be split');
  const bankAmount = t.debit.greaterThan(0) ? t.debit : t.credit;
  const amounts = lines.map((l, i) => parseMoney(l.amount, `Line ${i + 1} amount`));
  const problem = splitProblem(bankAmount, amounts);
  if (problem) throw new UserError(problem);
  const resolved: Awaited<ReturnType<typeof resolveCategory>>[] = [];
  for (const l of lines) resolved.push(await resolveCategory(l.categoryId, l.subCategoryId, l.nature));

  await withAudit(ctx, async (tx) => {
    await tx.txnSplit.updateMany({ where: { bankTxnId: id, isArchived: false }, data: { isArchived: true } });
    for (const [i, l] of lines.entries()) {
      await tx.txnSplit.create({
        data: {
          bankTxnId: id,
          lineNo: i + 1,
          amount: amounts[i],
          categoryId: resolved[i].category.id,
          subCategoryId: resolved[i].sub?.id ?? null,
          nature: resolved[i].nature,
          partyType: l.partyType ?? null,
          description: l.description?.trim() || null,
          note: l.note?.trim() || null,
        },
      });
    }
    await tx.bankTxn.update({
      where: { id },
      data: { status: 'split', categoryId: null, subCategoryId: null, nature: null, relatedPartyType: null, categorisationReason: `Split (${lines.length})` },
    });
  });
  return getTxn(id);
}

/** Split -> Categorised needs a category again, so unsplit returns the row to Review. */
export async function unsplit(ctx: AuditContext, id: string, reason: string) {
  const t = await loadTxn(id);
  if (t.status !== 'split') throw new UserError('This row is not split');
  if (!reason.trim()) throw new UserError('Say why the split is removed');
  await withAudit({ ...ctx, reason: reason.trim() }, async (tx) => {
    await tx.txnSplit.updateMany({ where: { bankTxnId: id, isArchived: false }, data: { isArchived: true } });
    await tx.bankTxn.update({ where: { id }, data: { status: 'review', categorisationReason: 'Split removed' } });
  });
  return getTxn(id);
}

/** Undo a transfer pairing: both rows go back to Review. */
export async function unpair(ctx: AuditContext, id: string, reason: string) {
  const t = await loadTxn(id);
  if (t.status !== 'transfer' || !t.transferPairId) throw new UserError('This row is not a paired transfer');
  if (!reason.trim()) throw new UserError('Say why the pair is wrong');
  await withAudit({ ...ctx, reason: reason.trim() }, async (tx) => {
    for (const rowId of [t.id, t.transferPairId!]) {
      await tx.bankTxn.update({
        where: { id: rowId },
        data: { transferPairId: null, status: 'review', categoryId: null, subCategoryId: null, nature: null, partyType: null, categorisationReason: 'Transfer pairing removed' },
      });
    }
  });
  return getTxn(id);
}

/** Runs the rules again on every row still in Review (after adding or changing a rule). */
export async function rerunRules(ctx: AuditContext) {
  const ids = (await prisma.bankTxn.findMany({ where: { status: 'review' }, select: { id: true } })).map((r) => r.id);
  const suggested = await withAudit({ ...ctx, reason: 'Rules re-run' }, (tx) => autoCategorise(tx, ids), { timeoutMs: 120_000 });
  return { checked: ids.length, suggested };
}

// ---------- F022 manual entries (cash, wallets: accounts without a statement) ----------

export type ManualEntryInput = { bankAccountId: string; txnDate: string; description: string; amount: string; direction: 'in' | 'out'; note: string };

/**
 * A cash or wallet transaction that no statement will bring. Only on accounts that are not
 * imported from a statement (no parser), appended after the account's last entry so the running
 * balance stays right. Needs a note (or a file added after); shown with a 'manual' badge.
 */
export async function addManualEntry(ctx: AuditContext, input: ManualEntryInput) {
  const account = await prisma.bankAccount.findUnique({ where: { id: input.bankAccountId } });
  if (!account || account.isArchived) throw new UserError('Choose an account');
  if (account.parserFormat) throw new UserError('This account comes from bank statements: its rows are imported, not typed (BR-01). Use a cash or wallet account.');
  const amount = parseMoney(input.amount, 'Amount');
  if (amount.lessThanOrEqualTo(0)) throw new UserError('Enter the amount');
  if (!input.description.trim()) throw new UserError('Say what it was');
  if (!input.note.trim()) throw new UserError('Add a note (who, why); attach the bill or receipt after saving');
  const date = parseDate(input.txnDate, 'Date');
  const last = await prisma.bankTxn.findFirst({ where: { bankAccountId: account.id }, orderBy: [{ txnDate: 'desc' }, { seq: 'desc' }] });
  if (last && date < last.txnDate) throw new UserError(`Entries are added in date order: the last one on this account is ${dateText(last.txnDate)}`);
  if (date < account.openingDate) throw new UserError('The date is before the account\'s opening date');
  const prev = last?.balance ?? account.openingBalance;
  const balance = input.direction === 'in' ? prev.plus(amount) : prev.minus(amount);
  const seq = (await prisma.bankTxn.count({ where: { bankAccountId: account.id, txnDate: date } })) + 1;
  const t = await withAudit({ ...ctx, reason: ctx.reason ?? 'Manual entry' }, (tx) => tx.bankTxn.create({
    data: {
      entityId: account.entityId, bankAccountId: account.id, seq, txnDate: date, narrationRaw: input.description.trim(), debit: input.direction === 'out' ? amount : new Decimal(0),
      credit: input.direction === 'in' ? amount : new Decimal(0), balance, dedupeKey: `manual:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`, parseOk: true,
      isManual: true, notes: input.note.trim(), status: 'review', categorisationReason: 'Manual entry: choose its category',
    },
  }));
  return getTxn(t.id);
}
