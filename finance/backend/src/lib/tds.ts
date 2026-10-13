import type { DeducteeType } from '@prisma/client';
import { rateColumn } from './deductee';
import { Decimal, formatINR } from './money';

/**
 * BR-11 / BR-12 TDS suggestion for one document or advance. Pure: the caller supplies the section,
 * the vendor's deductee type and what the vendor has already been billed this FY under the section.
 * Rates and thresholds come from the TDS master ([Verify] with the CA, Q15); the person can override
 * the suggestion with a reason.
 */

export type TdsSectionRates = {
  id: string;
  label: string;
  rateIndividual: Decimal;
  rateOthers: Decimal;
  rateNoPan: Decimal;
  singleThreshold: Decimal | null;
  annualThreshold: Decimal | null;
};

export type LowerDeduction = { number: string | null; rate: Decimal; validFrom: string | null; validTo: string | null; limit: Decimal | null };

export type TdsSuggestion = {
  applicable: boolean;
  sectionId: string | null;
  rate: string;
  base: string;
  amount: string;
  reason: string;
};

export function suggestTds(p: {
  section: TdsSectionRates | null;
  deducteeType: DeducteeType;
  /** Taxable value of this document (GST excluded, BR-11). */
  base: Decimal;
  date: string;
  /** Same vendor, same section, this FY, before this document: base already taxed / not taxed. */
  fyBefore: { taxedBase: Decimal; untaxedBase: Decimal };
  ldc?: LowerDeduction | null;
}): TdsSuggestion {
  const zero = { rate: '0.00', base: '0.00', amount: '0.00' };
  if (!p.section) return { applicable: false, sectionId: null, ...zero, reason: 'No TDS section on the vendor or the bill' };
  const s = p.section;
  const fyTotal = p.fyBefore.taxedBase.plus(p.fyBefore.untaxedBase).plus(p.base);
  const overSingle = !!s.singleThreshold && p.base.greaterThan(s.singleThreshold);
  const overAnnual = !!s.annualThreshold && fyTotal.greaterThan(s.annualThreshold);
  if (!overSingle && !overAnnual) {
    const limits = [s.singleThreshold && `single bill ${formatINR(s.singleThreshold)}`, s.annualThreshold && `FY total ${formatINR(s.annualThreshold)}`].filter(Boolean).join(', ');
    return { applicable: false, sectionId: s.id, ...zero, reason: `${s.label}: below the thresholds (${limits}); FY total with this bill ${formatINR(fyTotal)}` };
  }

  // Once the FY threshold is crossed, TDS is due on the whole FY amount, including earlier bills
  // that were below it (BR-12).
  const catchUp = overAnnual && p.fyBefore.untaxedBase.greaterThan(0) ? p.fyBefore.untaxedBase : new Decimal(0);
  const base = p.base.plus(catchUp);

  let rate: Decimal;
  let rateWhy: string;
  const ldc = p.ldc;
  const ldcValid = !!ldc
    && (!ldc.validFrom || p.date >= ldc.validFrom) && (!ldc.validTo || p.date <= ldc.validTo)
    && (!ldc.limit || fyTotal.lessThanOrEqualTo(ldc.limit));
  if (ldc && ldcValid) {
    rate = ldc.rate;
    rateWhy = `lower deduction certificate${ldc.number ? ` ${ldc.number}` : ''}`;
  } else {
    const col = rateColumn(p.deducteeType);
    rate = col === 'individual' ? s.rateIndividual : col === 'others' ? s.rateOthers : s.rateNoPan;
    rateWhy = col === 'individual' ? 'individual / HUF rate' : col === 'others' ? 'company / firm rate' : 'no PAN on file';
  }
  const amount = base.times(rate).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const why = [
    `${s.label} at ${rate.toFixed(2)}% (${rateWhy})`,
    overSingle && !overAnnual ? `bill above ${formatINR(s.singleThreshold!)}` : `FY total ${formatINR(fyTotal)} above ${formatINR(s.annualThreshold ?? s.singleThreshold!)}`,
    catchUp.greaterThan(0) ? `includes ${formatINR(catchUp)} billed earlier this FY without TDS` : '',
  ].filter(Boolean).join('; ');
  return { applicable: true, sectionId: s.id, rate: rate.toFixed(2), base: base.toFixed(2), amount: amount.toFixed(2), reason: why };
}
