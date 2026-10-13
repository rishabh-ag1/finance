import crypto from 'node:crypto';
import type { BankAccount, BankImportBatch, BankTxn } from '@prisma/client';
import { prisma } from '../config/database';
import { pgCode, withAudit, type AuditContext } from '../lib/audit';
import { dateText, parseDate } from '../lib/dates';
import { monthStart } from '../lib/fy';
import { UserError } from '../lib/http';
import { Decimal, moneyText } from '../lib/money';
import { registerReviewCounter } from '../services/settings.service';
import { checkBalances, dedupeKey, type BalanceCheck } from './importRules';
import { parseIdfcNarration, type ParsedNarration } from './parsers/idfcNarration';
import { readStatementFile, type StatementRow } from './parsers/statementFile';

/**
 * F010-F013 Statement import: read the file, parse narrations (BR-02), mark duplicates (BR-01),
 * check balance continuity (BR-03), show a preview, then store the new rows in one transaction.
 * New rows land in Review; categorisation is M3.
 */

const NARRATION_PARSERS: Record<string, (n: string) => ParsedNarration> = {
  idfc_v1: parseIdfcNarration,
};

// BR-36: rows waiting in Review or Suggested block locking their month.
registerReviewCounter((entityId, month) => {
  const next = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));
  return prisma.bankTxn.count({ where: { entityId, txnDate: { gte: month, lt: next }, status: { in: ['review', 'suggested'] } } });
});

export type ImportFile = { bankAccountId: string; fileName: string; contentBase64: string };

type PreparedRow = StatementRow & ParsedNarration & { dedupeKey: string; isDuplicate: boolean; monthLocked: boolean };

type Prepared = {
  account: BankAccount;
  fileHash: string;
  rows: PreparedRow[];
  check: BalanceCheck;
  fileAccountNumber: string | null;
};

async function prepare(input: ImportFile): Promise<Prepared> {
  const account = await prisma.bankAccount.findUnique({ where: { id: input.bankAccountId } });
  if (!account || account.isArchived) throw new UserError('Pick an active bank account', 404);
  const parser = NARRATION_PARSERS[account.parserFormat ?? ''];
  if (!parser) throw new UserError(`No statement parser for "${account.parserFormat ?? 'none'}". Set the statement format on the account (Settings > Bank accounts); IDFC is idfc_v1.`);

  const content = Buffer.from(input.contentBase64, 'base64');
  if (content.length === 0) throw new UserError('The file is empty');
  const file = await readStatementFile(input.fileName, content);

  // F010: the account number printed above the table must be this account's (last 4 digits,
  // because some banks mask the rest).
  if (file.accountNumber && file.accountNumber.slice(-4) !== account.accountNumber.slice(-4)) {
    throw new UserError(`This statement is for account ending ${file.accountNumber.slice(-4)}, not ${account.bankName} ending ${account.accountNumber.slice(-4)}`);
  }

  const keys = file.rows.map((r) => dedupeKey(account.id, r));
  if (new Set(keys).size !== keys.length) {
    throw new UserError('The file repeats the same row (same date, narration, amount and balance). Check the download.');
  }
  const existing = new Set(
    (await prisma.bankTxn.findMany({ where: { bankAccountId: account.id, dedupeKey: { in: keys } }, select: { dedupeKey: true } })).map((t) => t.dedupeKey),
  );

  const months = [...new Set(file.rows.map((r) => monthStart(r.txnDate)))];
  const locked = new Set(
    (await prisma.periodLock.findMany({ where: { entityId: account.entityId, isLocked: true, month: { in: months.map((m) => parseDate(m)) } } }))
      .map((l) => dateText(l.month)),
  );

  const rows: PreparedRow[] = file.rows.map((r, i) => ({
    ...r,
    ...parser(r.narration),
    dedupeKey: keys[i],
    isDuplicate: existing.has(keys[i]),
    monthLocked: locked.has(monthStart(r.txnDate)),
  }));

  // BR-03: compare with the stored balance just before the file. If the file starts with rows
  // already imported, it continues from them by definition.
  let previous: { balance: Decimal; txnDate: string | null } | null;
  if (rows[0].isDuplicate) {
    previous = null;
  } else {
    const before = await prisma.bankTxn.findFirst({
      where: { bankAccountId: account.id, txnDate: { lte: parseDate(rows[0].txnDate) }, balance: { not: null } },
      orderBy: [{ txnDate: 'desc' }, { seq: 'desc' }],
    });
    previous = before
      ? { balance: before.balance!, txnDate: dateText(before.txnDate) }
      : { balance: account.openingBalance, txnDate: dateText(account.openingDate) };
  }

  return {
    account,
    fileHash: crypto.createHash('sha256').update(content).digest('hex'),
    rows,
    check: checkBalances(rows, previous),
    fileAccountNumber: file.accountNumber,
  };
}

function rowView(r: PreparedRow) {
  return {
    seq: r.seq,
    txnDate: r.txnDate,
    valueDate: r.valueDate,
    narration: r.narration,
    chequeNo: r.chequeNo,
    debit: moneyText(r.debit),
    credit: moneyText(r.credit),
    balance: moneyText(r.balance),
    parsed: r.parsed,
    mode: r.mode,
    modeDetail: r.modeDetail,
    utr: r.utr,
    counterpartyName: r.counterpartyName,
    counterpartyIfsc: r.counterpartyIfsc,
    counterpartyAccount: r.counterpartyAccount,
    remark: r.remark,
    isDuplicate: r.isDuplicate,
    monthLocked: r.monthLocked,
  };
}

function summary(p: Prepared) {
  const fresh = p.rows.filter((r) => !r.isDuplicate);
  const sum = (rows: PreparedRow[], k: 'debit' | 'credit') => rows.reduce((s, r) => s.plus(r[k]), new Decimal(0));
  return {
    account: { id: p.account.id, bankName: p.account.bankName, accountNumberMasked: `•••• ${p.account.accountNumber.slice(-4)}` },
    fileAccountNumberMatched: p.fileAccountNumber ? true : null,
    periodFrom: p.rows[0].txnDate,
    periodTo: p.rows[p.rows.length - 1].txnDate,
    rowsTotal: p.rows.length,
    rowsNew: fresh.length,
    rowsDuplicate: p.rows.length - fresh.length,
    rowsUnparsed: fresh.filter((r) => !r.parsed).length,
    rowsInLockedMonths: fresh.filter((r) => r.monthLocked).length,
    totalDebit: moneyText(sum(p.rows, 'debit')),
    totalCredit: moneyText(sum(p.rows, 'credit')),
    newDebit: moneyText(sum(fresh, 'debit')),
    newCredit: moneyText(sum(fresh, 'credit')),
    balanceCheck: {
      status: p.check.status,
      fileOpening: moneyText(p.check.fileOpening),
      fileClosing: moneyText(p.check.fileClosing),
      expectedOpening: moneyText(p.check.expectedOpening),
      notes: p.check.notes,
      missingFrom: p.check.missingFrom,
      missingTo: p.check.missingTo,
    },
  };
}

/** F010-F013: what would happen, without storing anything. */
export async function previewImport(input: ImportFile) {
  const p = await prepare(input);
  return { ...summary(p), rows: p.rows.map(rowView) };
}

/** Stores the new rows and the batch in one transaction. Duplicates are skipped (BR-01). */
export async function confirmImport(ctx: AuditContext, input: ImportFile) {
  const p = await prepare(input);
  const s = summary(p);
  if (s.rowsInLockedMonths > 0) {
    throw new UserError(`${s.rowsInLockedMonths} new row(s) fall in a locked month. Unlock the month in Settings > Period lock first (BR-36).`);
  }
  const fresh = p.rows.filter((r) => !r.isDuplicate);
  try {
    const batch = await withAudit(ctx, async (tx) => {
      const last = await tx.bankTxn.aggregate({ where: { bankAccountId: p.account.id }, _max: { seq: true } });
      const seqBase = last._max.seq ?? 0;
      const b = await tx.bankImportBatch.create({
        data: {
          entityId: p.account.entityId,
          bankAccountId: p.account.id,
          fileName: input.fileName,
          fileHash: p.fileHash,
          periodFrom: parseDate(s.periodFrom),
          periodTo: parseDate(s.periodTo),
          rowsTotal: s.rowsTotal,
          rowsNew: s.rowsNew,
          rowsDuplicate: s.rowsDuplicate,
          openingBalance: p.check.fileOpening,
          closingBalance: p.check.fileClosing,
          balanceCheckStatus: p.check.status,
          balanceCheckNote: p.check.notes.join('\n') || null,
          missingFrom: p.check.missingFrom ? parseDate(p.check.missingFrom) : null,
          missingTo: p.check.missingTo ? parseDate(p.check.missingTo) : null,
          totalDebit: new Decimal(s.totalDebit!),
          totalCredit: new Decimal(s.totalCredit!),
          importedBy: ctx.userId,
        },
      });
      if (fresh.length > 0) {
        await tx.bankTxn.createMany({
          data: fresh.map((r, i) => ({
            entityId: p.account.entityId,
            bankAccountId: p.account.id,
            batchId: b.id,
            seq: seqBase + i + 1,
            txnDate: parseDate(r.txnDate),
            valueDate: r.valueDate ? parseDate(r.valueDate) : null,
            narrationRaw: r.narration,
            chequeNo: r.chequeNo,
            debit: r.debit,
            credit: r.credit,
            balance: r.balance,
            dedupeKey: r.dedupeKey,
            parseOk: r.parsed,
            mode: r.mode,
            modeDetail: r.modeDetail,
            utr: r.utr,
            counterpartyName: r.counterpartyName,
            counterpartyIfsc: r.counterpartyIfsc,
            counterpartyAccount: r.counterpartyAccount,
            counterpartyBank: r.counterpartyBank,
            ref2: r.ref2,
            remark: r.remark,
            status: 'review',
            categorisationReason: r.parsed ? null : 'Narration pattern not recognised',
          })),
        });
      }
      return b;
    }, { timeoutMs: 120_000 });
    return batchView(batch);
  } catch (error) {
    if (pgCode(error) === 'P0007') throw new UserError('A row falls in a locked month. Unlock it in Settings > Period lock first (BR-36).');
    throw error;
  }
}

function batchView(b: BankImportBatch & { bankAccount?: BankAccount }) {
  return {
    id: b.id,
    bankAccountId: b.bankAccountId,
    bankName: b.bankAccount?.bankName,
    fileName: b.fileName,
    periodFrom: dateText(b.periodFrom),
    periodTo: dateText(b.periodTo),
    rowsTotal: b.rowsTotal,
    rowsNew: b.rowsNew,
    rowsDuplicate: b.rowsDuplicate,
    openingBalance: moneyText(b.openingBalance),
    closingBalance: moneyText(b.closingBalance),
    totalDebit: moneyText(b.totalDebit),
    totalCredit: moneyText(b.totalCredit),
    balanceCheckStatus: b.balanceCheckStatus,
    balanceCheckNotes: b.balanceCheckNote ? b.balanceCheckNote.split('\n') : [],
    missingFrom: dateText(b.missingFrom),
    missingTo: dateText(b.missingTo),
    importedBy: b.importedBy,
    importedAt: b.importedAt,
  };
}

export async function listBatches(bankAccountId?: string) {
  const rows = await prisma.bankImportBatch.findMany({
    where: bankAccountId ? { bankAccountId } : {},
    orderBy: { importedAt: 'desc' },
    take: 100,
    include: { bankAccount: true },
  });
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.importedBy))] } }, select: { id: true, firstName: true, lastName: true } });
  const names = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`]));
  return rows.map((b) => ({ ...batchView(b), importedByName: names.get(b.importedBy) ?? b.importedBy }));
}

export function txnView(t: BankTxn) {
  return {
    id: t.id,
    bankAccountId: t.bankAccountId,
    batchId: t.batchId,
    seq: t.seq,
    txnDate: dateText(t.txnDate),
    valueDate: dateText(t.valueDate),
    narrationRaw: t.narrationRaw,
    chequeNo: t.chequeNo,
    debit: moneyText(t.debit),
    credit: moneyText(t.credit),
    balance: moneyText(t.balance),
    parseOk: t.parseOk,
    mode: t.mode,
    modeDetail: t.modeDetail,
    utr: t.utr,
    counterpartyName: t.counterpartyName,
    counterpartyIfsc: t.counterpartyIfsc,
    counterpartyAccount: t.counterpartyAccount,
    counterpartyBank: t.counterpartyBank,
    ref2: t.ref2,
    remark: t.remark,
    description: t.description,
    categoryId: t.categoryId,
    subCategoryId: t.subCategoryId,
    nature: t.nature,
    partyType: t.partyType,
    partyId: t.partyId,
    status: t.status,
    categorisationReason: t.categorisationReason,
    notes: t.notes,
  };
}

export async function getBatch(id: string) {
  const b = await prisma.bankImportBatch.findUnique({ where: { id }, include: { bankAccount: true } });
  if (!b) throw new UserError('Import not found', 404);
  const txns = await prisma.bankTxn.findMany({ where: { batchId: id }, orderBy: [{ txnDate: 'asc' }, { seq: 'asc' }] });
  return { ...batchView(b), rows: txns.map(txnView) };
}

/**
 * Money in, money out and closing balance of an account (A3), from the stored rows.
 * Closing = opening balance + credits - debits, which must equal the last statement balance.
 */
export async function accountTotals(bankAccountId: string) {
  const account = await prisma.bankAccount.findUnique({ where: { id: bankAccountId } });
  if (!account) throw new UserError('Bank account not found', 404);
  const agg = await prisma.bankTxn.aggregate({ where: { bankAccountId }, _sum: { debit: true, credit: true }, _count: true });
  const last = await prisma.bankTxn.findFirst({ where: { bankAccountId, balance: { not: null } }, orderBy: [{ txnDate: 'desc' }, { seq: 'desc' }] });
  const inflow = agg._sum.credit ?? new Decimal(0);
  const outflow = agg._sum.debit ?? new Decimal(0);
  const computedClosing = account.openingBalance.plus(inflow).minus(outflow);
  return {
    bankAccountId,
    rows: agg._count,
    openingBalance: moneyText(account.openingBalance),
    inflow: moneyText(inflow),
    outflow: moneyText(outflow),
    closingBalance: moneyText(computedClosing),
    lastStatementBalance: moneyText(last?.balance ?? null),
    lastTxnDate: dateText(last?.txnDate ?? null),
    agrees: last?.balance ? last.balance.equals(computedClosing) : true,
  };
}
