import { Decimal } from './money';
import { ageingBucket, daysOverdue, nameSimilarity, type AgeingBucket } from './payables';

/**
 * M10 Receivables: invoice payment state (Status Flows, BR-22, BR-24), receipt checks (BR-41) and
 * bank credit suggestions (BR-38). Pure functions; the services feed them from the database.
 */

const DAY = 86_400_000;
const gap = (a: string, b: string) => Math.abs(Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY));
const r2 = (x: Decimal) => x.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const zero = new Decimal(0);

/** Paid when received + TDS + credit notes reach the total; overdue while owed past the due date (BR-22). */
export function invoicePayment(f: { total: Decimal; received: Decimal; tds: Decimal; credited: Decimal; dueDate: string | null; today: string }) {
  const settled = f.received.plus(f.tds).plus(f.credited);
  const outstanding = Decimal.max(f.total.minus(settled), zero);
  const state = outstanding.isZero() ? 'paid' as const : settled.greaterThan(0) ? 'partly_paid' as const : 'unpaid' as const;
  const days = outstanding.isZero() ? 0 : daysOverdue(f.dueDate, f.today);
  return { state, outstanding: outstanding.toFixed(2), overdue: days > 0, daysOverdue: days, bucket: outstanding.isZero() ? null : ageingBucket(days) as AgeingBucket };
}

/** BR-41: received + TDS + charges cover what is allocated; each invoice gets no more than it owes; the rest is an advance. */
export function checkReceipt(f: { amount: Decimal; tds: Decimal; charges: Decimal; allocations: { amount: Decimal; outstanding: Decimal; label: string }[] }) {
  const problems: string[] = [];
  const total = f.amount.plus(f.tds).plus(f.charges);
  const allocated = f.allocations.reduce((s, a) => s.plus(a.amount), zero);
  for (const a of f.allocations) {
    if (a.amount.lessThanOrEqualTo(0)) problems.push(`${a.label}: enter an amount above zero`);
    else if (a.amount.greaterThan(a.outstanding)) problems.push(`${a.label}: Rs ${a.amount.toFixed(2)} is more than the Rs ${a.outstanding.toFixed(2)} it owes`);
  }
  if (allocated.greaterThan(total)) problems.push(`Rs ${allocated.toFixed(2)} allocated is more than the Rs ${total.toFixed(2)} received (with TDS and charges)`);
  return { problems, advance: Decimal.max(total.minus(allocated), zero).toFixed(2), total: total.toFixed(2) };
}

export type OpenInvoice = { id: string; docNumber: string | null; outstanding: Decimal; taxable: Decimal; dueDate: string | null; customerNames: string[]; deductsTds: boolean };
export const CUSTOMER_TDS_RATES = ['1', '2', '10'] as const;

/**
 * BR-38: the invoices a bank credit most likely pays, best first, at most 3. The credit equals the
 * outstanding, or the outstanding less TDS at 1, 2 or 10% of taxable (customers that deduct TDS);
 * a smaller credit is a part payment. Within 60 days of the due date; the name in the narration counts.
 */
export function suggestInvoicesForCredit(credit: { amount: Decimal; date: string; counterparty: string | null }, invoices: OpenInvoice[]) {
  const out: { invoiceId: string; docNumber: string | null; receipt: string; tds: string; tdsRate: string | null; settles: boolean; confidence: number; why: string }[] = [];
  for (const inv of invoices) {
    if (inv.outstanding.lessThanOrEqualTo(0)) continue;
    if (inv.dueDate && gap(inv.dueDate, credit.date) > 60) continue;
    const name = nameSimilarity(credit.counterparty, inv.customerNames);
    let fit: { tds: Decimal; rate: string | null; settles: boolean; score: number; why: string } | null = null;
    if (credit.amount.equals(inv.outstanding)) fit = { tds: zero, rate: null, settles: true, score: 0.6, why: 'the amount owed' };
    else if (inv.deductsTds) {
      for (const rate of CUSTOMER_TDS_RATES) {
        const tds = r2(inv.taxable.times(rate).dividedBy(100));
        if (credit.amount.plus(tds).equals(inv.outstanding)) { fit = { tds, rate, settles: true, score: 0.55, why: `the amount owed less TDS at ${rate}% of taxable` }; break; }
      }
    }
    if (!fit && credit.amount.lessThan(inv.outstanding) && name >= 0.5) fit = { tds: zero, rate: null, settles: false, score: 0.2, why: 'part of the amount owed' };
    if (!fit) continue;
    const score = Math.min(1, fit.score + (name >= 0.5 ? 0.3 * name + 0.1 : 0));
    out.push({ invoiceId: inv.id, docNumber: inv.docNumber, receipt: credit.amount.toFixed(2), tds: fit.tds.toFixed(2), tdsRate: fit.rate, settles: fit.settles, confidence: Math.round(score * 100) / 100, why: `${fit.why}${name >= 0.5 ? ', name in the narration' : ''}` });
  }
  return out.sort((a, b) => b.confidence - a.confidence).slice(0, 3);
}

/** Days sales outstanding: outstanding / sales of the period x days; null without sales. */
export function dso(outstanding: Decimal, sales: Decimal, days: number) {
  if (sales.lessThanOrEqualTo(0)) return null;
  return Math.round(Number(outstanding.dividedBy(sales).times(days).toFixed(4)));
}
