import { UserError } from './http';
import { Decimal } from './money';

/**
 * BR-20 GST split and BR-21 rounding, shared by POs (M04), vendor documents (M05) and sales
 * documents (M09). Inputs are text so no JS number reaches the arithmetic.
 */

export type GstMode = 'cgst_sgst' | 'igst' | 'none';

/** Same state: CGST + SGST. Different state: IGST. An unregistered supplier charges no GST. */
export function gstMode(p: { supplierState: string | null; placeOfSupply: string; supplierRegistered: boolean }): GstMode {
  if (!p.supplierRegistered) return 'none';
  return p.supplierState === p.placeOfSupply ? 'cgst_sgst' : 'igst';
}

export type LineInput = { qty: string; rate: string; discount: string; gstRate: string; mode: GstMode };
export type LineAmounts = { taxable: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal; lineTotal: Decimal };

const r2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

function num(text: string, field: string): Decimal {
  const clean = String(text ?? '').replace(/[,\s₹]/g, '');
  if (!/^\d{1,12}(\.\d{1,4})?$/.test(clean)) throw new UserError(`${field} is not a valid number: ${text}`);
  return new Decimal(clean);
}

/** One line: taxable = qty x rate - discount (2 decimals); tax per line to 2 decimals (BR-21). */
export function computeLine(l: LineInput): LineAmounts {
  const qty = num(l.qty, 'Quantity');
  if (qty.isZero()) throw new UserError('Quantity must be more than zero');
  const gross = r2(qty.times(num(l.rate, 'Rate')));
  const discount = r2(num(l.discount || '0', 'Discount'));
  if (discount.greaterThan(gross)) throw new UserError('Discount is larger than the line amount');
  const taxable = gross.minus(discount);
  const rate = l.mode === 'none' ? new Decimal(0) : num(l.gstRate || '0', 'GST rate');
  const zero = new Decimal(0);
  let cgst = zero; let sgst = zero; let igst = zero;
  if (l.mode === 'cgst_sgst') {
    cgst = r2(taxable.times(rate).dividedBy(200));
    sgst = cgst;
  } else if (l.mode === 'igst') {
    igst = r2(taxable.times(rate).dividedBy(100));
  }
  return { taxable, cgst, sgst, igst, lineTotal: taxable.plus(cgst).plus(sgst).plus(igst) };
}

export type DocTotals = { taxable: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal; beforeRounding: Decimal; roundOff: Decimal; total: Decimal };

/** Document totals; the total is rounded to the rupee with a separate round-off line (BR-21). */
export function documentTotals(lines: Pick<LineAmounts, 'taxable' | 'cgst' | 'sgst' | 'igst'>[], otherCharges: Decimal = new Decimal(0)): DocTotals {
  const add = (k: 'taxable' | 'cgst' | 'sgst' | 'igst') => lines.reduce((s, l) => s.plus(l[k]), new Decimal(0));
  const taxable = add('taxable'); const cgst = add('cgst'); const sgst = add('sgst'); const igst = add('igst');
  const beforeRounding = taxable.plus(cgst).plus(sgst).plus(igst).plus(otherCharges);
  const total = beforeRounding.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return { taxable, cgst, sgst, igst, beforeRounding, roundOff: total.minus(beforeRounding), total };
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function below100(n: number): string {
  return n < 20 ? ONES[n] : [TENS[Math.floor(n / 10)], ONES[n % 10]].filter(Boolean).join(' ');
}
function below1000(n: number): string {
  return [n >= 100 ? `${ONES[Math.floor(n / 100)]} Hundred` : '', below100(n % 100)].filter(Boolean).join(' ');
}

/** Whole rupees in Indian words: crore, lakh, thousand. Integer maths on a whole number only. */
function indianWords(n: number): string {
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  if (crore) parts.push(`${indianWords(crore)} Crore`);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  if (lakh) parts.push(`${below100(lakh)} Lakh`);
  const thousand = Math.floor((n % 100_000) / 1000);
  if (thousand) parts.push(`${below100(thousand)} Thousand`);
  const rest = n % 1000;
  if (rest) parts.push(below1000(rest));
  return parts.join(' ');
}

/** "Rupees Eleven Lakh Thirty Six Thousand Eight Hundred Only" (BR-21). */
export function amountInWords(amount: Decimal): string {
  const fixed = amount.abs().toFixed(2);
  const [rupees, paise] = fixed.split('.').map((p) => Number(p));
  const words = `Rupees ${indianWords(rupees)}${paise ? ` and ${below100(paise)} Paise` : ''} Only`;
  return amount.isNegative() ? `Minus ${words}` : words;
}
