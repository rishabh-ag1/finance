import { Decimal } from './money';

/**
 * M17 CA pack (F180, F181): the GST working the CA checks before filing. Information only, not a
 * GSTR file. Outward supplies are summarised by HSN and rate, net of credit notes, and tied to the
 * documents' taxable value; B2C supplies by place of supply and rate.
 */

const zero = () => new Decimal(0);

export type GstLine = { hsnSac: string | null; gstRate: Decimal; qty: Decimal; taxable: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal; isCredit: boolean };

export function hsnSummary(lines: GstLine[]) {
  const by = new Map<string, { hsn: string; rate: Decimal; qty: Decimal; taxable: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal }>();
  for (const l of lines) {
    const hsn = l.hsnSac?.trim() || '(none)';
    const k = `${hsn}|${l.gstRate.toString()}`;
    const cur = by.get(k) ?? { hsn, rate: l.gstRate, qty: zero(), taxable: zero(), cgst: zero(), sgst: zero(), igst: zero() };
    const s = l.isCredit ? -1 : 1;
    cur.qty = cur.qty.plus(l.qty.times(s));
    cur.taxable = cur.taxable.plus(l.taxable.times(s));
    cur.cgst = cur.cgst.plus(l.cgst.times(s));
    cur.sgst = cur.sgst.plus(l.sgst.times(s));
    cur.igst = cur.igst.plus(l.igst.times(s));
    by.set(k, cur);
  }
  return [...by.values()]
    .sort((a, b) => (a.hsn === b.hsn ? a.rate.comparedTo(b.rate) : a.hsn < b.hsn ? -1 : 1))
    .map((x) => {
      const tax = x.cgst.plus(x.sgst).plus(x.igst);
      return { hsn: x.hsn, rate: x.rate.toString(), qty: x.qty.toString(), taxable: x.taxable.toFixed(2), cgst: x.cgst.toFixed(2), sgst: x.sgst.toFixed(2), igst: x.igst.toFixed(2), tax: tax.toFixed(2), total: x.taxable.plus(tax).toFixed(2) };
    });
}

/** The HSN summary must add up to the invoices' taxable value less the credit notes'. */
export function tieOut(summary: { taxable: string }[], docs: { invoicesTaxable: Decimal; creditsTaxable: Decimal }) {
  const hsn = summary.reduce((s, r) => s.plus(r.taxable), zero());
  const documents = docs.invoicesTaxable.minus(docs.creditsTaxable);
  const diff = hsn.minus(documents);
  return { hsnTaxable: hsn.toFixed(2), documentsTaxable: documents.toFixed(2), difference: diff.toFixed(2), ok: diff.abs().lessThan(0.01) };
}

export type B2cDoc = { placeOfSupply: string; gstRate: Decimal; taxable: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal; isCredit: boolean };

/** B2C outward supplies by place of supply and rate (as GSTR-1 asks for them), credit notes subtracted. */
export function b2cSummary(lines: B2cDoc[]) {
  const by = new Map<string, { placeOfSupply: string; rate: Decimal; taxable: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal }>();
  for (const l of lines) {
    const k = `${l.placeOfSupply}|${l.gstRate.toString()}`;
    const cur = by.get(k) ?? { placeOfSupply: l.placeOfSupply, rate: l.gstRate, taxable: zero(), cgst: zero(), sgst: zero(), igst: zero() };
    const s = l.isCredit ? -1 : 1;
    cur.taxable = cur.taxable.plus(l.taxable.times(s));
    cur.cgst = cur.cgst.plus(l.cgst.times(s));
    cur.sgst = cur.sgst.plus(l.sgst.times(s));
    cur.igst = cur.igst.plus(l.igst.times(s));
    by.set(k, cur);
  }
  return [...by.values()]
    .sort((a, b) => (a.placeOfSupply === b.placeOfSupply ? a.rate.comparedTo(b.rate) : a.placeOfSupply < b.placeOfSupply ? -1 : 1))
    .map((x) => ({ placeOfSupply: x.placeOfSupply, rate: x.rate.toString(), taxable: x.taxable.toFixed(2), cgst: x.cgst.toFixed(2), sgst: x.sgst.toFixed(2), igst: x.igst.toFixed(2) }));
}
