import type { MsmeType } from '@prisma/client';
import type { Decimal } from './money';

/**
 * M06 Payables: bank matching (BR-08), overdue and ageing (BR-22, BR-24), MSME limit (BR-25).
 * Pure functions; the services feed them from the database.
 */

const DAY = 86_400_000;
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

// ---------- BR-08 matching ----------

const GENERIC = new Set(['PRIVATE', 'PVT', 'LIMITED', 'LTD', 'CO', 'COMPANY', 'THE', 'AND', 'LLP', 'MS', 'INDIA', 'ENTERPRISES']);
const tokens = (name: string) => name.toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/).filter((t) => t.length > 1 && !GENERIC.has(t));

/**
 * How alike a bank counterparty is to any of the vendor's names, 0 to 1. Tokens match when equal
 * or when one starts with the other (IDFC runs words together and truncates: "INDUSTRIESPARVEZ").
 */
export function nameSimilarity(counterparty: string | null, names: string[]): number {
  if (!counterparty) return 0;
  const a = tokens(counterparty);
  let best = 0;
  for (const n of names) {
    const b = tokens(n);
    if (!a.length || !b.length) continue;
    const hit = (x: string, y: string) => x === y || (Math.min(x.length, y.length) >= 4 && (x.startsWith(y) || y.startsWith(x)));
    const matched = b.filter((t) => a.some((u) => hit(t, u))).length;
    best = Math.max(best, matched / Math.min(a.length, b.length));
  }
  return best;
}

export type PaymentToMatch = { amount: Decimal; paidDate: string; utr: string | null; bankAccountId: string | null; vendorNames: string[] };
export type MatchCandidate = { id: string; bankAccountId: string; txnDate: string; debit: Decimal; utr: string | null; counterpartyName: string | null; narrationRaw: string };

/**
 * BR-08: the bank row for a payment. UTR first (in the parsed UTR or anywhere in the narration),
 * else the same amount within 3 days with a similar party name. Two equally good rows are left
 * for a person to choose. The amount must always be equal and the account the same.
 */
export function matchBankRow(p: PaymentToMatch, rows: MatchCandidate[]): { txnId: string; by: 'utr' | 'amount_date_name' } | null {
  const usable = rows.filter((r) => r.debit.equals(p.amount) && (!p.bankAccountId || r.bankAccountId === p.bankAccountId));
  const utr = p.utr?.trim().toUpperCase();
  if (utr && utr.length >= 6) {
    const byUtr = usable.filter((r) => r.utr?.toUpperCase() === utr || r.narrationRaw.toUpperCase().includes(utr));
    if (byUtr.length === 1) return { txnId: byUtr[0].id, by: 'utr' };
    if (byUtr.length > 1) return null;
  }
  const near = usable
    .map((r) => ({ r, gap: Math.abs(days(p.paidDate, r.txnDate)) }))
    .filter(({ r, gap }) => gap <= 3 && nameSimilarity(r.counterpartyName, p.vendorNames) >= 0.5)
    .sort((a, b) => a.gap - b.gap);
  if (!near.length) return null;
  if (near.length > 1 && near[1].gap === near[0].gap) return null;
  return { txnId: near[0].r.id, by: 'amount_date_name' };
}

// ---------- BR-22 / BR-24 ----------

/** Days past the due date (0 when not yet due or no due date). */
export function daysOverdue(dueDate: string | null, today: string): number {
  return dueDate ? Math.max(0, days(dueDate, today)) : 0;
}

export type AgeingBucket = 'not_due' | '1_30' | '31_60' | '61_90' | '90_plus';
export const AGEING_LABEL: Record<AgeingBucket, string> = { not_due: 'Not due', '1_30': '1-30', '31_60': '31-60', '61_90': '61-90', '90_plus': '90+' };

export function ageingBucket(daysPastDue: number): AgeingBucket {
  if (daysPastDue <= 0) return 'not_due';
  if (daysPastDue <= 30) return '1_30';
  if (daysPastDue <= 60) return '31_60';
  if (daysPastDue <= 90) return '61_90';
  return '90_plus';
}

// ---------- BR-25 ----------

export const MSME_LIMIT_DAYS = 45;

/** Micro and small vendors: agreed terms, capped at 45 days from acceptance; alerts at day 30 and 40. */
export function msmeAlert(p: { msmeType: MsmeType; acceptedOn: string; dueDate: string | null }, today: string) {
  const cap = addDays(p.acceptedOn, MSME_LIMIT_DAYS);
  const limitDate = p.dueDate && p.dueDate < cap ? p.dueDate : cap;
  const daysSinceAcceptance = days(p.acceptedOn, today);
  if (p.msmeType !== 'micro' && p.msmeType !== 'small') return { level: 'none' as const, limitDate, daysSinceAcceptance };
  const level = today > limitDate ? 'breached' as const : daysSinceAcceptance >= 40 ? 'day40' as const : daysSinceAcceptance >= 30 ? 'day30' as const : 'none' as const;
  return { level, limitDate, daysSinceAcceptance };
}
