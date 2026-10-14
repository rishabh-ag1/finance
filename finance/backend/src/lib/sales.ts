import { gstMode, type GstMode } from './gst';
import { validateGstinChecksum } from './gstin';
import { Decimal } from './money';

/**
 * M09 sales documents: rules that decide, without touching the database.
 * BR-49 / BR-20 supply type and tax split, BR-32 checks on issue (F094), BR-34 cancel or credit
 * note, BR-33 conversion of a proforma, BR-42 e-way bill warning.
 */

export type SalesDocType = 'proforma' | 'tax_invoice' | 'credit_note';

/** BR-49: B2B when the customer has a valid GSTIN; place of supply is the ship-to state (BR-20). */
export function supplyOf(p: { supplierState: string; billToGstin: string | null; shipToState: string | null }) {
  const raw = p.billToGstin?.trim() || null;
  let gstin: string | null = null;
  let problem: string | null = null;
  if (raw) {
    const v = validateGstinChecksum(raw);
    if (v.valid) gstin = v.normalized;
    else problem = v.reason;
  }
  const placeOfSupply = p.shipToState ?? '';
  const mode: GstMode = placeOfSupply ? gstMode({ supplierState: p.supplierState, placeOfSupply, supplierRegistered: true }) : 'cgst_sgst';
  return { supplyType: (gstin || problem ? 'b2b' : 'b2c') as 'b2b' | 'b2c', placeOfSupply, gstMode: mode, gstin, problem };
}

export type IssueFacts = {
  docType: SalesDocType;
  supplyType: 'b2b' | 'b2c';
  billTo: { name: string; address: string; stateCode: string | null; gstin: string | null };
  gstinProblem: string | null;
  placeOfSupply: string;
  docDate: string;
  today: string;
  lines: { description: string; hsnSac: string | null; qty: Decimal; rate: Decimal }[];
};

/** F094 / BR-32: everything the law asks for is present. Plain words, one per problem. */
export function issueProblems(f: IssueFacts): string[] {
  const out: string[] = [];
  if (!f.billTo.name?.trim()) out.push('Bill-to name is missing');
  if (!f.billTo.address?.trim()) out.push('Bill-to address is missing');
  if (!f.billTo.stateCode) out.push('Bill-to state is missing');
  if (f.gstinProblem) out.push(`Customer GSTIN: ${f.gstinProblem}`);
  if (f.supplyType === 'b2b' && !f.gstinProblem && !f.billTo.gstin) out.push('A B2B invoice needs the customer GSTIN');
  if (!f.placeOfSupply) out.push('Place of supply is not set');
  if (f.docDate > f.today) out.push('The date cannot be in the future');
  if (!f.lines.length) out.push('Add at least one line');
  f.lines.forEach((l, i) => {
    const name = `Line ${i + 1} (${l.description || 'no description'})`;
    if (!l.hsnSac || !/^\d{4,8}$/.test(l.hsnSac.trim())) out.push(`${name} has ${l.hsnSac ? 'an HSN code that is not 4 to 8 digits' : 'no HSN code'}`);
    if (!l.qty.greaterThan(0)) out.push(`${name} has no quantity`);
    if (!l.rate.greaterThan(0)) out.push(`${name} has no rate`);
  });
  return out;
}

/** BR-34: what "cancel" means for this document now. */
export function cancelRoute(p: { status: string; docDate: string; gstr1FiledMonths: string[] }): 'discard' | 'cancel' | 'credit_note' | 'none' {
  if (p.status === 'draft') return 'discard';
  if (p.status !== 'issued') return 'none';
  const month = `${p.docDate.slice(0, 7)}-01`;
  return p.gstr1FiledMonths.includes(month) ? 'credit_note' : 'cancel';
}

/** BR-33: how much of each proforma line is left after the tax invoices made from it. */
export function conversionState(lines: { id: string; qty: Decimal }[], converted: { sourceLineId: string; qty: Decimal }[]) {
  const remaining: Record<string, string> = {};
  let any = false; let all = true;
  for (const l of lines) {
    const used = converted.filter((c) => c.sourceLineId === l.id).reduce((s, c) => s.plus(c.qty), new Decimal(0));
    if (used.greaterThan(0)) any = true;
    const left = Decimal.max(l.qty.minus(used), 0);
    if (left.greaterThan(0)) all = false;
    remaining[l.id] = left.toString();
  }
  return { state: (all && lines.length ? 'converted' : any ? 'partly_converted' : 'not_converted') as 'converted' | 'partly_converted' | 'not_converted', remaining };
}

/** BR-42: a goods tax invoice above the threshold needs an e-way bill (made outside the app). */
export function ewayBillNeeded(p: { docType: SalesDocType; total: Decimal; threshold: Decimal; hasGoods: boolean }) {
  return p.docType === 'tax_invoice' && p.hasGoods && p.total.greaterThan(p.threshold);
}

/** Goods are HSN chapters 01-97; services (SAC) start with 99. */
export const isGoodsCode = (code: string | null) => !!code && !code.trim().startsWith('99');
