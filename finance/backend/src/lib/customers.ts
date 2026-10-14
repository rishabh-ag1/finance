import { Decimal } from './money';

/** F121: the price in force on a date for a quantity (highest quantity break reached, then latest start). */
export type PriceItem = { invProductId: string; price: Decimal; minQty: number; effectiveFrom: string; effectiveTo: string | null; isArchived: boolean };

export function priceFor<T extends PriceItem>(items: T[], productId: string, date: string, qty: number): T | null {
  const fits = items.filter((i) => !i.isArchived && i.invProductId === productId && i.effectiveFrom <= date && (!i.effectiveTo || i.effectiveTo >= date) && i.minQty <= qty);
  fits.sort((a, b) => b.minQty - a.minQty || b.effectiveFrom.localeCompare(a.effectiveFrom));
  return fits[0] ?? null;
}

/** The rate before GST that an invoice line uses (lists may be kept inclusive of GST). */
export function exclusiveRate(price: Decimal, taxInclusive: boolean, gstRate: Decimal): Decimal {
  if (!taxInclusive) return price.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return price.times(100).dividedBy(new Decimal(100).plus(gstRate)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export type ProfileFields = {
  paymentTermId: string | null; creditLimit: Decimal | null; invoiceEmails: string[]; deductsTds: boolean | null;
  tdsSectionId: string | null; priceListId: string | null; channel: string | null; billToBranchId: string | null;
};

/**
 * F081: an outlet's fields override its company's one by one (an empty e-mail list counts as
 * empty); what is still empty takes the defaults: payment terms On delivery, deducts TDS No,
 * channel HoReCa (B2B customers in the CRM are hotels, restaurants and distributors).
 */
export function resolveProfile(company: ProfileFields | null, outlet: ProfileFields | null, defaults: { onDelivery: string | null }) {
  const pick = <K extends keyof ProfileFields>(k: K): ProfileFields[K] | null => {
    const o = outlet?.[k];
    if (o !== null && o !== undefined && !(Array.isArray(o) && o.length === 0)) return o;
    const c = company?.[k];
    return c !== null && c !== undefined ? c : null;
  };
  return {
    paymentTermId: pick('paymentTermId') ?? defaults.onDelivery,
    creditLimit: pick('creditLimit'),
    invoiceEmails: pick('invoiceEmails') ?? [],
    deductsTds: pick('deductsTds') ?? false,
    tdsSectionId: pick('tdsSectionId'),
    priceListId: pick('priceListId'),
    channel: pick('channel') ?? 'horeca',
    billToBranchId: outlet?.billToBranchId ?? null,
  };
}

/** F083 (warn only in v1): over the credit limit, or anything more than 30 days overdue. */
export function creditWarnings(c: { creditLimit: Decimal | null; outstanding: Decimal; newAmount: Decimal; oldestOverdueDays: number }): string[] {
  const out: string[] = [];
  if (c.creditLimit !== null && c.outstanding.plus(c.newAmount).greaterThan(c.creditLimit)) {
    out.push(`Outstanding Rs ${c.outstanding.toFixed(2)} + this invoice Rs ${c.newAmount.toFixed(2)} is above the credit limit of Rs ${c.creditLimit.toFixed(2)}`);
  }
  if (c.oldestOverdueDays > 30) out.push(`An invoice of this customer is ${c.oldestOverdueDays} days overdue`);
  return out;
}
