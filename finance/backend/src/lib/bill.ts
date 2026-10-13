import { Decimal } from './money';

/** M05 vendor documents: duplicate key (BR-19), due date (BR-23), net payable (BR-18). */

/** BR-19: the document number compared ignoring case and spaces. */
export function docNumberKey(docNumber: string): string {
  return docNumber.replace(/\s+/g, '').toUpperCase();
}

/** BR-23: document date + term days; advance terms (and no term) are due on the document date. */
export function dueDate(docDate: string, term: { days: number; isAdvance: boolean } | null): string {
  if (!term || term.isAdvance || term.days <= 0) return docDate;
  const d = new Date(`${docDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + term.days);
  return d.toISOString().slice(0, 10);
}

/**
 * BR-18. Net payable = total - TDS - advances adjusted. Outstanding = net payable - payments
 * allocated + vendor debit notes - vendor credit notes (`notes` is signed: credit notes negative).
 */
export function billAmounts(p: { total: Decimal; tds: Decimal; advancesApplied: Decimal; paid: Decimal; notes: Decimal }) {
  const netPayable = p.total.minus(p.tds).minus(p.advancesApplied);
  return { netPayable, outstanding: netPayable.minus(p.paid).plus(p.notes) };
}
