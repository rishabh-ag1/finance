import type { InvoiceTemplate, Prisma, SalesDocument, SalesDocumentLine } from '@prisma/client';
import QRCode from 'qrcode';
import { prisma } from '../config/database';
import { crmBranchCompanyId, crmCompany, crmOrder, type OrderAddress } from '../crm/reader';
import { invProducts } from '../inventory/reader';
import { withAudit, type AuditContext, type Tx } from '../lib/audit';
import { resolveProfile } from '../lib/customers';
import { dateText, parseDate } from '../lib/dates';
import { fyLabel, todayIST } from '../lib/fy';
import { amountInWords, computeLine, documentTotals, type GstMode } from '../lib/gst';
import { stateCodeFromName, validateGstinChecksum } from '../lib/gstin';
import { UserError } from '../lib/http';
import { Decimal, moneyText } from '../lib/money';
import { cancelRoute, conversionState, ewayBillNeeded, isGoodsCode, issueProblems, supplyOf, type SalesDocType } from '../lib/sales';
import { salesDocumentHtml, SALES_LAYOUT_VERSION, type SalesPdfData } from '../pdf/salesDocument';
import { renderPdf } from '../pdf/render';
import { archive, download, upload } from './attachment.service';
import { linePrice, SALES_GST_RATE } from './customer.service';
import { takeNumber } from './numbering.service';
import { getCompany } from './settings.service';

/**
 * M09 Sales documents (F090-F098, F104, F106). Proformas, tax invoices and credit notes are made
 * as drafts (no number), checked and issued (number taken in the same transaction, BR-30; PDF
 * frozen with the template version, F104). B2B or B2C from the customer's GSTIN (BR-49), tax split
 * from the place of supply (BR-20), rounding per BR-21. Issued documents never change (database):
 * cancel before GSTR-1, else a credit note (BR-34).
 */

export const DOC_LABEL: Record<SalesDocType, string> = { proforma: 'Proforma invoice', tax_invoice: 'Tax invoice', credit_note: 'Credit note' };
export const CREDIT_REASONS = ['return', 'rto', 'rate_difference', 'discount', 'other'] as const;
export const CREDIT_REASON_LABEL: Record<string, string> = { return: 'Goods returned', rto: 'Returned to origin (RTO) or cancelled after dispatch', rate_difference: 'Rate difference', discount: 'Discount after sale', other: 'Other' };
export const SOURCE_LABEL: Record<string, string> = { manual: 'Made here', d2c_batch: 'D2C batch', crm_api: 'From the CRM', refill: 'Refill plan', rto: 'RTO credit note' };
export const FONTS = ['inter', 'roboto', 'lato', 'noto-serif'] as const;

const zero = () => new Decimal(0);
const r2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const text = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
const DAY = 86_400_000;
const shift = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const num = (v: string | null | undefined, field: string, places = 2) => {
  const clean = String(v ?? '').replace(/[,\s₹%]/g, '');
  const re = places === 3 ? /^\d{1,9}(\.\d{1,3})?$/ : /^\d{1,12}(\.\d{1,2})?$/;
  if (!re.test(clean)) throw new UserError(`${field} is not a valid number: ${v}`);
  return new Decimal(clean);
};

type Party = { name: string; address: string; stateCode: string | null; gstin: string | null; phone?: string | null; email?: string | null };

export type LineInput = {
  invProductId?: string | null; description?: string | null; hsnSac?: string | null; qty: string; unit?: string | null;
  rate?: string | null; discountPct?: string | null; gstRate?: string | null; sourceLineId?: string | null;
  /** Kept when a stored line is re-checked (price list, proforma), else 'typed'. */
  priceSource?: string | null;
  /** Discount in rupees (an order's discount, F102); wins over discountPct. */
  discount?: string | null;
};
export type CustomerInput =
  | { kind: 'outlet'; companyId: string; branchId: string; shipToBranchId?: string | null }
  | { kind: 'one_off'; name: string; address: string; state: string; gstin?: string | null; phone?: string | null; email?: string | null; shipTo?: { name: string; address: string; state: string } | null }
  /** A CRM order (F102, F105): billed to its outlet when ordered for a company, else to the buyer from the order's own address. */
  | { kind: 'order'; orderNumber: string };
export type DocInput = {
  docType: 'proforma' | 'tax_invoice';
  docDate: string;
  customer: CustomerInput;
  customerPoNo?: string | null; customerPoDate?: string | null; validUntil?: string | null; paymentTermId?: string | null;
  salesPerson?: string | null; notes?: string | null; ewayBillNo?: string | null; transporter?: string | null; vehicleNo?: string | null;
  lines: LineInput[];
};

// ---------- Working out a document (no writes) ----------

const outletAddress = (b: { addressLine1: string | null; addressLine2: string | null; city: string | null; pincode: string | null }) =>
  [b.addressLine1, b.addressLine2, [b.city, b.pincode].filter(Boolean).join(' ')].filter((x) => x && String(x).trim()).join(', ');

/** Bill-to and ship-to from a CRM outlet (with 'bill invoices to' from the outlet's profile) or typed. */
const orderAddress = (a: OrderAddress) => [a.line1, a.line2, [a.city, a.pincode].filter(Boolean).join(' ')].filter((x) => x && String(x).trim()).join(', ');

type Parties = {
  billTo: Party; shipTo: { name: string; address: string; stateCode: string | null } | null; crmCompanyId: string | null; crmBranchId: string | null;
  shipToBranchId: string | null; profile: ReturnType<typeof resolveProfile> | null;
};

async function parties(c: CustomerInput): Promise<Parties> {
  if (c.kind === 'order') {
    const o = await crmOrder(c.orderNumber);
    if (!o) throw new UserError(`Order ${c.orderNumber} is not in the CRM`);
    if (o.orderFor === 'COMPANY' && o.billingBranchId) {
      const companyId = await crmBranchCompanyId(o.billingBranchId);
      if (companyId) return parties({ kind: 'outlet', companyId, branchId: o.billingBranchId });
    }
    const gstin = o.gstApplicable ? text(o.gstNumber) : null;
    const billTo: Party = { name: o.customerName.trim(), address: orderAddress(o.billing), stateCode: stateCodeFromName(o.billing.state ?? ''), gstin, phone: text(o.phone), email: text(o.email) };
    const same = orderAddress(o.billing) === orderAddress(o.shipping);
    const shipTo = same ? null : { name: o.customerName.trim(), address: orderAddress(o.shipping), stateCode: stateCodeFromName(o.shipping.state ?? '') };
    return { billTo, shipTo, crmCompanyId: null, crmBranchId: null, shipToBranchId: null, profile: null };
  }
  if (c.kind === 'one_off') {
    const stateCode = stateCodeFromName(c.state);
    const billTo: Party = { name: c.name.trim(), address: c.address.trim(), stateCode, gstin: text(c.gstin), phone: text(c.phone), email: text(c.email) };
    const shipTo = c.shipTo ? { name: c.shipTo.name.trim(), address: c.shipTo.address.trim(), stateCode: stateCodeFromName(c.shipTo.state) } : null;
    return { billTo, shipTo, crmCompanyId: null, crmBranchId: null, shipToBranchId: null, profile: null };
  }
  const company = await crmCompany(c.companyId);
  if (!company) throw new UserError('Customer not found in the CRM');
  const outlet = company.branches.find((b) => b.id === c.branchId);
  if (!outlet) throw new UserError('Choose one of the customer\'s outlets');
  const profiles = await prisma.customerProfile.findMany({ where: { crmCompanyId: company.id } });
  const terms = await prisma.paymentTerm.findFirst({ where: { label: 'On delivery' } });
  const pick = (p: (typeof profiles)[number] | undefined) => (p ? { paymentTermId: p.paymentTermId, creditLimit: p.creditLimit, invoiceEmails: p.invoiceEmails, deductsTds: p.deductsTds, tdsSectionId: p.tdsSectionId, priceListId: p.priceListId, channel: p.channel, billToBranchId: p.billToBranchId } : null);
  const profile = resolveProfile(pick(profiles.find((p) => p.crmBranchId === null)), pick(profiles.find((p) => p.crmBranchId === outlet.id)), { onDelivery: terms?.id ?? null });
  const billOutlet = (profile.billToBranchId && company.branches.find((b) => b.id === profile.billToBranchId)) || outlet;
  const shipOutlet = (c.shipToBranchId && company.branches.find((b) => b.id === c.shipToBranchId)) || outlet;
  const asParty = (b: typeof outlet): Party => {
    const gst = b.gstNumber?.trim() || null;
    const v = gst ? validateGstinChecksum(gst) : null;
    return { name: `${company.name}${company.branches.length > 1 ? ` (${b.name})` : ''}`, address: outletAddress(b), stateCode: v?.valid ? v.normalized.slice(0, 2) : stateCodeFromName(b.state), gstin: gst };
  };
  const billTo = asParty(billOutlet);
  const ship = asParty(shipOutlet);
  return {
    billTo, shipTo: billOutlet.id === shipOutlet.id ? null : { name: ship.name, address: ship.address, stateCode: ship.stateCode },
    crmCompanyId: company.id, crmBranchId: billOutlet.id, shipToBranchId: shipOutlet.id, profile,
  };
}

type PlannedLine = {
  invProductId: string | null; sku: string | null; description: string; hsnSac: string | null; qty: Decimal; unit: string; rate: Decimal; discountPct: Decimal;
  discount: Decimal; gstRate: Decimal; taxable: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal; lineTotal: Decimal; priceSource: string | null; sourceLineId: string | null;
};

async function planLines(lines: LineInput[], ctx: { mode: GstMode; date: string; companyId: string | null; branchId: string | null }) {
  const ids = [...new Set(lines.map((l) => l.invProductId).filter(Boolean) as string[])];
  const products = new Map((await invProducts({ ids })).map((p) => [p.id, p]));
  const warnings: string[] = [];
  const out: PlannedLine[] = [];
  for (const [i, l] of lines.entries()) {
    const p = l.invProductId ? products.get(l.invProductId) : undefined;
    if (l.invProductId && !p) throw new UserError(`Line ${i + 1}: that product is not in bloc-inv`);
    const qty = num(l.qty, `Line ${i + 1} quantity`, 3);
    let rate: Decimal;
    let priceSource: string | null = text(l.priceSource) ?? 'typed';
    if (text(l.rate)) rate = num(l.rate, `Line ${i + 1} rate`);
    else if (p) {
      const lp = await linePrice({ companyId: ctx.companyId, branchId: ctx.branchId, invProductId: p.id, date: ctx.date, qty: Math.max(1, Math.round(Number(qty.toString()))) });
      rate = new Decimal(lp.rate ?? '0'); priceSource = lp.source;
    } else throw new UserError(`Line ${i + 1}: enter a rate`);
    let discountPct = text(l.discountPct) ? num(l.discountPct, `Line ${i + 1} discount %`) : zero();
    if (discountPct.greaterThan(100)) throw new UserError(`Line ${i + 1}: discount above 100%`);
    const gross = r2(qty.times(rate));
    const fixedDiscount = text(l.discount) ? num(l.discount, `Line ${i + 1} discount`) : null;
    if (fixedDiscount?.greaterThan(gross)) throw new UserError(`Line ${i + 1}: the discount is more than the line`);
    if (fixedDiscount) discountPct = gross.isZero() ? zero() : r2(fixedDiscount.times(100).dividedBy(gross));
    const gstRate = text(l.gstRate) ? num(l.gstRate, `Line ${i + 1} GST rate`) : SALES_GST_RATE;
    if (p && !p.gstRate.equals(gstRate)) warnings.push(`Line ${i + 1}: bloc-inv has GST ${p.gstRate.toFixed(2)}% for ${p.name}; ${gstRate.toFixed(2)}% is charged`);
    const discount = fixedDiscount ?? r2(gross.times(discountPct).dividedBy(100));
    const a = computeLine({ qty: qty.toString(), rate: rate.toString(), discount: discount.toString(), gstRate: gstRate.toString(), mode: ctx.mode });
    out.push({
      invProductId: p?.id ?? null, sku: p?.sku ?? null, description: text(l.description) ?? p?.name ?? '', hsnSac: text(l.hsnSac) ?? p?.hsn ?? null,
      qty, unit: text(l.unit) ?? 'Nos', rate, discountPct, discount, gstRate, ...a, priceSource, sourceLineId: l.sourceLineId ?? null,
    });
  }
  return { lines: out, warnings };
}

async function template(version?: number | null) {
  const t = version ? await prisma.invoiceTemplate.findUnique({ where: { version } }) : await prisma.invoiceTemplate.findFirst({ orderBy: { version: 'desc' } });
  return t ?? (await ensureTemplate());
}

async function plan(input: DocInput) {
  const date = dateText(parseDate(input.docDate, 'Date'))!;
  const company = await getCompany();
  const party = await parties(input.customer);
  const supply = supplyOf({ supplierState: company.stateCode, billToGstin: party.billTo.gstin, shipToState: (party.shipTo ?? party.billTo).stateCode });
  if (supply.gstin) party.billTo.gstin = supply.gstin;
  const { lines, warnings } = await planLines(input.lines, { mode: supply.gstMode, date, companyId: party.crmCompanyId, branchId: party.crmBranchId });
  const totals = documentTotals(lines);
  const termId = input.paymentTermId || party.profile?.paymentTermId || (await prisma.paymentTerm.findFirst({ where: { label: party.crmCompanyId ? 'On delivery' : 'On receipt' } }))?.id || null;
  const term = termId ? await prisma.paymentTerm.findUnique({ where: { id: termId } }) : null;
  const t = await template();
  const eway = ewayBillNeeded({ docType: input.docType, total: totals.total, threshold: t.ewayBillThreshold, hasGoods: lines.some((l) => isGoodsCode(l.hsnSac)) });
  if (eway && !text(input.ewayBillNo)) warnings.push(`Goods above ₹${t.ewayBillThreshold.toFixed(0)}: an e-way bill is needed before dispatch (make it on the e-way bill portal and add its number) [Verify threshold, BR-42]`);
  if (party.profile && party.billTo.gstin === null && input.customer.kind === 'outlet') warnings.push('This outlet has no GSTIN in the CRM, so the invoice is B2C; if the customer is registered, ask sales to add the GSTIN first (BR-49)');
  const problems = issueProblems({
    docType: input.docType, supplyType: supply.supplyType, billTo: party.billTo, gstinProblem: supply.problem, placeOfSupply: supply.placeOfSupply,
    docDate: date, today: todayIST(), lines: lines.map((l) => ({ description: l.description, hsnSac: l.hsnSac, qty: l.qty, rate: l.rate })),
  });
  return {
    date, party, supply, lines, totals, warnings, problems, ewayNeeded: eway, term,
    dueDate: input.docType === 'tax_invoice' ? shift(date, term?.days ?? 0) : null,
  };
}

function linesView(lines: PlannedLine[]) {
  return lines.map((l) => ({
    invProductId: l.invProductId, sku: l.sku, description: l.description, hsnSac: l.hsnSac, qty: l.qty.toString(), unit: l.unit, rate: moneyText(l.rate),
    discountPct: l.discountPct.toString(), discount: moneyText(l.discount), gstRate: l.gstRate.toString(), taxable: moneyText(l.taxable),
    tax: moneyText(l.cgst.plus(l.sgst).plus(l.igst)), lineTotal: moneyText(l.lineTotal), priceSource: l.priceSource, sourceLineId: l.sourceLineId,
  }));
}
const totalsView = (t: { taxable: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal; roundOff: Decimal; total: Decimal }) => ({
  taxable: moneyText(t.taxable), cgst: moneyText(t.cgst), sgst: moneyText(t.sgst), igst: moneyText(t.igst), roundOff: moneyText(t.roundOff), total: moneyText(t.total),
});

/** Server-side maths for the form (no money arithmetic in the browser). */
export async function previewDoc(input: DocInput) {
  const p = await plan(input);
  return {
    supplyType: p.supply.supplyType, placeOfSupply: p.supply.placeOfSupply, gstMode: p.supply.gstMode, billTo: p.party.billTo, shipTo: p.party.shipTo,
    lines: linesView(p.lines), totals: totalsView(p.totals), amountInWords: amountInWords(p.totals.total), dueDate: p.dueDate,
    paymentTerms: p.term?.label ?? null, warnings: p.warnings, problems: p.problems, ewayNeeded: p.ewayNeeded,
  };
}

// ---------- Drafts ----------

function docData(input: DocInput, p: Awaited<ReturnType<typeof plan>>) {
  return {
    docDate: parseDate(p.date), customerKind: input.customer.kind, crmCompanyId: p.party.crmCompanyId, crmBranchId: p.party.crmBranchId, shipToBranchId: p.party.shipToBranchId,
    billTo: p.party.billTo as Prisma.InputJsonValue, shipTo: (p.party.shipTo ?? p.party.billTo) as Prisma.InputJsonValue,
    supplyType: p.supply.supplyType, placeOfSupply: p.supply.placeOfSupply || '00', gstMode: p.supply.gstMode,
    customerPoNo: text(input.customerPoNo), customerPoDate: input.customerPoDate ? parseDate(input.customerPoDate, 'Customer PO date') : null,
    validUntil: input.docType === 'proforma' && input.validUntil ? parseDate(input.validUntil, 'Valid until') : null, dueDate: p.dueDate ? parseDate(p.dueDate) : null,
    paymentTermId: p.term?.id ?? null, salesPerson: text(input.salesPerson), notes: text(input.notes),
    ewayBillNo: text(input.ewayBillNo), transporter: text(input.transporter), vehicleNo: text(input.vehicleNo),
    taxable: p.totals.taxable, cgst: p.totals.cgst, sgst: p.totals.sgst, igst: p.totals.igst, roundOff: p.totals.roundOff, total: p.totals.total,
  };
}

async function writeLines(tx: Tx, docId: string, lines: PlannedLine[]) {
  await tx.salesDocumentLine.updateMany({ where: { docId, isArchived: false }, data: { isArchived: true } });
  await tx.salesDocumentLine.createMany({
    data: lines.map((l, i) => ({
      docId, lineNo: i + 1, invProductId: l.invProductId, sku: l.sku, description: l.description, hsnSac: l.hsnSac, qty: l.qty, unit: l.unit, rate: l.rate,
      discountPct: l.discountPct, discount: l.discount, gstRate: l.gstRate, taxable: l.taxable, cgst: l.cgst, sgst: l.sgst, igst: l.igst, lineTotal: l.lineTotal,
      priceSource: l.priceSource, sourceLineId: l.sourceLineId,
    })),
  });
}

function checkCustomerInput(input: DocInput) {
  if (input.customer.kind === 'one_off') {
    if (!text(input.customer.name) || !text(input.customer.address)) throw new UserError('Enter the customer name and address');
    if (!stateCodeFromName(input.customer.state)) throw new UserError('Choose the customer\'s state');
  }
  if (!input.lines.length) throw new UserError('Add at least one line');
}

export type DocExtra = { proformaId?: string | null; crmOrderNumber?: string | null; source?: 'manual' | 'd2c_batch' | 'crm_api' | 'refill'; refillPlanId?: string | null };

export async function createDoc(ctx: AuditContext, input: DocInput, extra: DocExtra = {}) {
  checkCustomerInput(input);
  const p = await plan(input);
  const company = await getCompany();
  const crmOrderNumber = input.customer.kind === 'order' ? input.customer.orderNumber : extra.crmOrderNumber ?? null;
  const doc = await withAudit({ ...ctx, reason: ctx.reason ?? `${DOC_LABEL[input.docType]} drafted` }, async (tx) => {
    const d = await tx.salesDocument.create({ data: { entityId: company.id, docType: input.docType, ...docData(input, p), proformaId: extra.proformaId ?? null, crmOrderNumber, source: extra.source ?? 'manual', refillPlanId: extra.refillPlanId ?? null } });
    await writeLines(tx, d.id, p.lines);
    return d;
  });
  return getDoc(doc.id);
}

async function loadDoc(id: string) {
  const d = await prisma.salesDocument.findUnique({ where: { id }, include: { lines: { where: { isArchived: false }, orderBy: { lineNo: 'asc' } } } });
  if (!d) throw new UserError('Document not found', 404);
  return d;
}

export async function updateDoc(ctx: AuditContext, id: string, input: DocInput) {
  const d = await loadDoc(id);
  if (d.status !== 'draft') throw new UserError('Only a draft can be edited');
  if (d.docType === 'credit_note') throw new UserError('Edit a credit note from its invoice');
  if (input.docType !== d.docType) throw new UserError('The type of a draft cannot change');
  checkCustomerInput(input);
  const p = await plan(input);
  await withAudit({ ...ctx, reason: ctx.reason ?? 'Draft edited' }, async (tx) => {
    await tx.salesDocument.update({ where: { id }, data: docData(input, p) });
    await writeLines(tx, id, p.lines);
  });
  return getDoc(id);
}

/** The input a stored draft was made from, to re-run the plan at issue. */
function inputOf(d: SalesDocument & { lines: SalesDocumentLine[] }): DocInput {
  const bill = d.billTo as Party;
  const ship = d.shipTo as Party;
  return {
    docType: d.docType as 'proforma' | 'tax_invoice', docDate: dateText(d.docDate)!,
    customer: d.customerKind === 'order' && d.crmOrderNumber ? { kind: 'order', orderNumber: d.crmOrderNumber }
      : d.customerKind === 'outlet'
      ? { kind: 'outlet', companyId: d.crmCompanyId!, branchId: d.crmBranchId!, shipToBranchId: d.shipToBranchId }
      : { kind: 'one_off', name: bill.name, address: bill.address, state: bill.stateCode ?? '', gstin: bill.gstin, phone: bill.phone, email: bill.email, shipTo: ship && ship.address !== bill.address ? { name: ship.name, address: ship.address, state: ship.stateCode ?? '' } : null },
    customerPoNo: d.customerPoNo, customerPoDate: dateText(d.customerPoDate), validUntil: dateText(d.validUntil), paymentTermId: d.paymentTermId,
    salesPerson: d.salesPerson, notes: d.notes, ewayBillNo: d.ewayBillNo, transporter: d.transporter, vehicleNo: d.vehicleNo,
    lines: d.lines.map((l) => ({ invProductId: l.invProductId, description: l.description, hsnSac: l.hsnSac, qty: l.qty.toString(), unit: l.unit, rate: l.rate.toFixed(2), discountPct: l.discountPct.toString(), gstRate: l.gstRate.toString(), sourceLineId: l.sourceLineId, priceSource: l.priceSource, discount: d.customerKind === 'order' ? l.discount.toFixed(2) : null })),
  };
}

// ---------- Issue (BR-30, BR-32) ----------

export async function issueDoc(ctx: AuditContext, id: string) {
  const d = await loadDoc(id);
  if (d.status !== 'draft') throw new UserError(`This ${DOC_LABEL[d.docType].toLowerCase()} is already ${d.status}`);
  const company = await getCompany();
  let problems: string[];
  if (d.docType === 'credit_note') {
    problems = await creditNoteProblems(d);
  } else {
    // Re-run the plan on today's CRM data so the issued document is checked as it stands.
    const p = await plan(inputOf(d));
    problems = p.problems;
    if (d.proformaId) problems.push(...(await conversionProblems(d)));
    if (!problems.length) {
      await withAudit({ ...ctx, reason: 'Recomputed at issue' }, async (tx) => {
        await tx.salesDocument.update({ where: { id }, data: docData(inputOf(d), p) });
        await writeLines(tx, id, p.lines.map((l, i) => ({ ...l, sourceLineId: d.lines[i]?.sourceLineId ?? null })));
      });
    }
  }
  if (problems.length) throw new UserError(`Cannot issue yet: ${problems.join('; ')}`);
  const t = await template();
  await withAudit({ ...ctx, reason: ctx.reason ?? `${DOC_LABEL[d.docType]} issued` }, async (tx) => {
    const fresh = await tx.salesDocument.findUniqueOrThrow({ where: { id } });
    const docNumber = await takeNumber(tx, company.id, d.docType, dateText(fresh.docDate)!);
    await tx.salesDocument.update({
      where: { id },
      data: {
        docNumber, fyLabel: fyLabel(dateText(fresh.docDate)!), status: 'issued', issuedBy: ctx.userId, issuedAt: new Date(), templateVersion: t.version,
        companySnapshot: { legalName: company.legalName, brandName: company.brandName, address: company.registeredAddress, gstin: company.gstin, pan: company.pan, cin: company.cin, email: company.email, phone: company.phone, stateCode: company.stateCode },
      },
    });
  });
  // The frozen PDF is filed after the issue commits; if printing fails the document stands and can be printed again.
  try { await printDoc(ctx, id); } catch (e) { console.error('Invoice PDF not stored:', e); }
  return getDoc(id);
}

// ---------- BR-33 conversion ----------

async function convertedLines(proformaId: string, excludeDocId?: string) {
  const tis = await prisma.salesDocument.findMany({ where: { proformaId, docType: 'tax_invoice', status: { in: ['draft', 'issued'] }, ...(excludeDocId ? { id: { not: excludeDocId } } : {}) }, include: { lines: { where: { isArchived: false } } } });
  return tis.flatMap((t) => t.lines.filter((l) => l.sourceLineId).map((l) => ({ sourceLineId: l.sourceLineId!, qty: l.qty })));
}

async function conversionProblems(d: SalesDocument & { lines: SalesDocumentLine[] }) {
  const pi = await loadDoc(d.proformaId!);
  if (pi.status !== 'issued') return ['The proforma it comes from is not issued (or was cancelled)'];
  const st = conversionState(pi.lines.map((l) => ({ id: l.id, qty: l.qty })), await convertedLines(pi.id, d.id));
  return d.lines.filter((l) => l.sourceLineId && l.qty.greaterThan(st.remaining[l.sourceLineId] ?? '0'))
    .map((l) => `${l.description}: only ${st.remaining[l.sourceLineId!] ?? 0} left on the proforma`);
}

/** BR-33: a tax invoice draft from an issued proforma, for all or part of each line's quantity. */
export async function convertProforma(ctx: AuditContext, id: string, input: { docDate: string; lines?: { sourceLineId: string; qty: string }[] }) {
  const pi = await loadDoc(id);
  if (pi.docType !== 'proforma' || pi.status !== 'issued') throw new UserError('Only an issued proforma can be converted');
  const st = conversionState(pi.lines.map((l) => ({ id: l.id, qty: l.qty })), await convertedLines(id));
  const wanted = input.lines ?? pi.lines.map((l) => ({ sourceLineId: l.id, qty: st.remaining[l.id] }));
  const lines: LineInput[] = [];
  for (const w of wanted) {
    const l = pi.lines.find((x) => x.id === w.sourceLineId);
    if (!l) throw new UserError('That line is not on the proforma');
    const qty = num(w.qty, 'Quantity', 3);
    if (qty.isZero()) continue;
    if (qty.greaterThan(st.remaining[l.id])) throw new UserError(`${l.description}: only ${st.remaining[l.id]} left to convert`);
    lines.push({ invProductId: l.invProductId, description: l.description, hsnSac: l.hsnSac, qty: qty.toString(), unit: l.unit, rate: l.rate.toFixed(2), discountPct: l.discountPct.toString(), gstRate: l.gstRate.toString(), sourceLineId: l.id, priceSource: `proforma ${pi.docNumber}` });
  }
  if (!lines.length) throw new UserError('Nothing left to convert');
  const base = inputOf(pi);
  return createDoc({ ...ctx, reason: ctx.reason ?? `Converted from ${pi.docNumber}` }, { ...base, docType: 'tax_invoice', docDate: input.docDate, validUntil: null, lines }, { proformaId: id, crmOrderNumber: pi.crmOrderNumber });
}

// ---------- F097 credit notes ----------

async function creditedLines(invoiceId: string, excludeDocId?: string) {
  const cns = await prisma.salesDocument.findMany({ where: { againstInvoiceId: invoiceId, docType: 'credit_note', status: { in: ['draft', 'issued'] }, ...(excludeDocId ? { id: { not: excludeDocId } } : {}) }, include: { lines: { where: { isArchived: false } } } });
  return { docs: cns, lines: cns.flatMap((c) => c.lines) };
}

async function creditNoteProblems(cn: SalesDocument & { lines: SalesDocumentLine[] }) {
  const inv = await loadDoc(cn.againstInvoiceId!);
  const out: string[] = [];
  if (inv.status !== 'issued') out.push('The invoice is not issued (or was cancelled)');
  if (dateText(cn.docDate)! < dateText(inv.docDate)!) out.push('A credit note cannot be dated before its invoice');
  if (dateText(cn.docDate)! > todayIST()) out.push('The date cannot be in the future');
  const prior = await creditedLines(inv.id, cn.id);
  const priorTotal = prior.docs.filter((x) => x.status === 'issued').reduce((s, x) => s.plus(x.total), zero());
  if (cn.total.plus(priorTotal).greaterThan(inv.total)) out.push(`Credit notes would exceed the invoice total of ₹${inv.total.toFixed(2)}`);
  for (const l of cn.lines) {
    const src = inv.lines.find((x) => x.id === l.sourceLineId);
    if (!src) { out.push(`${l.description}: not a line of the invoice`); continue; }
    const usedTaxable = prior.lines.filter((x) => x.sourceLineId === src.id).reduce((s, x) => s.plus(x.taxable), zero());
    if (l.taxable.plus(usedTaxable).greaterThan(src.taxable)) out.push(`${l.description}: more than the invoice line's taxable value is credited`);
  }
  if (!cn.lines.length) out.push('Add at least one line');
  return out;
}

export type CreditNoteInput = { docDate: string; creditReason: string; notes?: string | null; lines: { sourceLineId: string; qty: string; rate?: string | null }[] };

/** F097: a credit note draft against an issued invoice (returned quantity, or a lower rate). */
export async function createCreditNote(ctx: AuditContext, invoiceId: string, input: CreditNoteInput, extra: { source?: 'manual' | 'rto' } = {}) {
  const inv = await loadDoc(invoiceId);
  if (inv.docType !== 'tax_invoice' || inv.status !== 'issued') throw new UserError('A credit note is raised against an issued tax invoice');
  if (!CREDIT_REASONS.includes(input.creditReason as (typeof CREDIT_REASONS)[number])) throw new UserError('Choose why the credit note is raised');
  const date = dateText(parseDate(input.docDate, 'Date'))!;
  const lines: PlannedLine[] = [];
  for (const w of input.lines) {
    const src = inv.lines.find((x) => x.id === w.sourceLineId);
    if (!src) throw new UserError('That line is not on the invoice');
    const qty = num(w.qty, 'Quantity', 3);
    if (qty.isZero()) continue;
    if (qty.greaterThan(src.qty)) throw new UserError(`${src.description}: more than the ${src.qty} invoiced`);
    const rate = text(w.rate) ? num(w.rate, 'Rate') : src.rate;
    if (rate.greaterThan(src.rate)) throw new UserError(`${src.description}: the credit rate cannot be above the invoiced rate`);
    // At the invoiced rate the credit takes the line's own discount, in proportion; at a lower rate, its discount %.
    const discount = rate.equals(src.rate) ? (qty.equals(src.qty) ? src.discount : r2(src.discount.times(qty).dividedBy(src.qty))) : r2(r2(qty.times(rate)).times(src.discountPct).dividedBy(100));
    const a = computeLine({ qty: qty.toString(), rate: rate.toString(), discount: discount.toString(), gstRate: src.gstRate.toString(), mode: inv.gstMode as GstMode });
    lines.push({ invProductId: src.invProductId, sku: src.sku, description: src.description, hsnSac: src.hsnSac, qty, unit: src.unit, rate, discountPct: src.discountPct, discount, gstRate: src.gstRate, ...a, priceSource: `credit of ${inv.docNumber}`, sourceLineId: src.id });
  }
  if (!lines.length) throw new UserError('Choose what is credited');
  const totals = documentTotals(lines);
  const company = await getCompany();
  const cn = await withAudit({ ...ctx, reason: ctx.reason ?? `Credit note drafted against ${inv.docNumber}` }, async (tx) => {
    const d = await tx.salesDocument.create({
      data: {
        entityId: company.id, docType: 'credit_note', docDate: parseDate(date), customerKind: inv.customerKind, crmCompanyId: inv.crmCompanyId, crmBranchId: inv.crmBranchId,
        shipToBranchId: inv.shipToBranchId, crmOrderNumber: inv.crmOrderNumber, billTo: inv.billTo as Prisma.InputJsonValue, shipTo: inv.shipTo as Prisma.InputJsonValue,
        supplyType: inv.supplyType, placeOfSupply: inv.placeOfSupply, gstMode: inv.gstMode, againstInvoiceId: inv.id, creditReason: input.creditReason, notes: text(input.notes), source: extra.source ?? 'manual',
        salesPerson: inv.salesPerson, taxable: totals.taxable, cgst: totals.cgst, sgst: totals.sgst, igst: totals.igst, roundOff: totals.roundOff, total: totals.total,
      },
    });
    await writeLines(tx, d.id, lines);
    return d;
  });
  return getDoc(cn.id);
}

// ---------- BR-34 discard, cancel; sent / accepted; transport ----------

async function filedMonths() {
  return (await prisma.gstr1Filing.findMany({ where: { isArchived: false } })).map((f) => dateText(f.month)!);
}

export async function cancelDoc(ctx: AuditContext, id: string) {
  if (!text(ctx.reason)) throw new UserError('Say why');
  const d = await loadDoc(id);
  const route = cancelRoute({ status: d.status, docDate: dateText(d.docDate)!, gstr1FiledMonths: d.docType === 'proforma' ? [] : await filedMonths() });
  if (route === 'none') throw new UserError(`This document is ${d.status}`);
  if (route === 'credit_note') throw new UserError(`GSTR-1 for ${dateText(d.docDate)!.slice(0, 7)} is filed, so this invoice cannot be cancelled: raise a credit note against it instead (BR-34)`);
  if (route === 'discard') {
    await withAudit(ctx, (tx) => tx.salesDocument.update({ where: { id }, data: { status: 'discarded', statusReason: ctx.reason } }));
    return getDoc(id);
  }
  if (d.docType === 'tax_invoice') {
    const cns = await prisma.salesDocument.count({ where: { againstInvoiceId: id, status: 'issued' } });
    if (cns) throw new UserError('Credit notes are issued against this invoice; cancel them first');
  }
  if (d.docType === 'proforma' && (await prisma.salesDocument.count({ where: { proformaId: id, status: 'issued' } }))) throw new UserError('Tax invoices are issued from this proforma; it cannot be cancelled');
  await withAudit(ctx, (tx) => tx.salesDocument.update({ where: { id }, data: { status: 'cancelled', statusReason: ctx.reason, cancelledAt: new Date() } }));
  // The stamped copy is filed beside the original; the original PDF is kept.
  try { await printDoc({ ...ctx, reason: 'Cancelled copy printed' }, id, { keepPrevious: true }); } catch (e) { console.error('Cancelled PDF not stored:', e); }
  return getDoc(id);
}

export async function markDoc(ctx: AuditContext, id: string, what: 'sent' | 'accepted') {
  const d = await loadDoc(id);
  if (d.status !== 'issued') throw new UserError('Only an issued document can be marked');
  if (what === 'accepted' && d.docType !== 'proforma') throw new UserError('Only a proforma is accepted');
  await withAudit({ ...ctx, reason: ctx.reason ?? `Marked ${what}` }, (tx) => tx.salesDocument.update({ where: { id }, data: what === 'sent' ? { sentAt: new Date() } : { acceptedAt: new Date() } }));
  return getDoc(id);
}

/** E-way bill number and transport may be added after issue (the e-way bill is made from the invoice); the PDF is printed again. */
export async function updateTransport(ctx: AuditContext, id: string, t: { ewayBillNo?: string | null; transporter?: string | null; vehicleNo?: string | null }) {
  const d = await loadDoc(id);
  if (d.docType !== 'tax_invoice' || d.status !== 'issued') throw new UserError('Transport details are added to an issued tax invoice');
  await withAudit({ ...ctx, reason: ctx.reason ?? 'Transport details added' }, (tx) => tx.salesDocument.update({ where: { id }, data: { ewayBillNo: text(t.ewayBillNo), transporter: text(t.transporter), vehicleNo: text(t.vehicleNo) } }));
  try { await printDoc({ ...ctx, reason: 'Printed again with transport details' }, id); } catch (e) { console.error('Invoice PDF not stored:', e); }
  return getDoc(id);
}

// ---------- PDF (F095, F104) ----------

async function dataUri(attachmentId: string | null) {
  if (!attachmentId) return null;
  try {
    const f = await download(attachmentId);
    return `data:${f.mimeType};base64,${f.content.toString('base64')}`;
  } catch {
    return null;
  }
}

async function pdfData(d: SalesDocument & { lines: SalesDocumentLine[] }): Promise<SalesPdfData> {
  const company = await getCompany();
  const snap = (d.companySnapshot as SalesPdfData['company'] | null) ?? { legalName: company.legalName, brandName: company.brandName, address: company.registeredAddress, gstin: company.gstin, pan: company.pan, cin: company.cin, email: company.email, phone: company.phone, stateCode: company.stateCode };
  const t = await template(d.templateVersion);
  const bank = t.bankAccountId ? await prisma.bankAccount.findUnique({ where: { id: t.bankAccountId } }) : null;
  const term = d.paymentTermId ? await prisma.paymentTerm.findUnique({ where: { id: d.paymentTermId } }) : null;
  const against = d.againstInvoiceId ? await prisma.salesDocument.findUnique({ where: { id: d.againstInvoiceId } }) : null;
  const upiQr = t.upiId ? await QRCode.toDataURL(`upi://pay?pa=${encodeURIComponent(t.upiId)}&pn=${encodeURIComponent(snap.legalName)}&cu=INR${d.docType !== 'credit_note' ? `&am=${d.total.toFixed(2)}` : ''}${d.docNumber ? `&tn=${encodeURIComponent(d.docNumber)}` : ''}`, { margin: 1, width: 180 }) : null;
  const bill = d.billTo as Party;
  const ship = d.shipTo as Party;
  const hsn = new Map<string, { hsn: string; rate: string; taxable: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal }>();
  for (const l of d.lines) {
    const k = `${l.hsnSac}|${l.gstRate.toString()}`;
    const h = hsn.get(k) ?? { hsn: l.hsnSac ?? '', rate: l.gstRate.toString(), taxable: zero(), cgst: zero(), sgst: zero(), igst: zero() };
    h.taxable = h.taxable.plus(l.taxable); h.cgst = h.cgst.plus(l.cgst); h.sgst = h.sgst.plus(l.sgst); h.igst = h.igst.plus(l.igst);
    hsn.set(k, h);
  }
  return {
    docType: d.docType, docNumber: d.docNumber, docDate: dateText(d.docDate)!, status: d.status, company: snap,
    billTo: bill, shipTo: ship && (ship.address !== bill.address || ship.name !== bill.name) ? { name: ship.name, address: ship.address, stateCode: ship.stateCode } : null,
    supplyType: d.supplyType as 'b2b' | 'b2c', placeOfSupply: d.placeOfSupply, gstMode: d.gstMode, reverseCharge: d.reverseCharge,
    customerPoNo: d.customerPoNo, customerPoDate: dateText(d.customerPoDate), validUntil: dateText(d.validUntil), dueDate: dateText(d.dueDate), paymentTerms: term?.label ?? null,
    ewayBillNo: d.ewayBillNo, transporter: d.transporter, vehicleNo: d.vehicleNo, salesPerson: d.salesPerson, crmOrderNumber: d.crmOrderNumber,
    against: against?.docNumber ? { number: against.docNumber, date: dateText(against.docDate)! } : null, creditReason: d.creditReason ? CREDIT_REASON_LABEL[d.creditReason] ?? d.creditReason : null,
    lines: d.lines.map((l) => ({
      description: l.description, hsnSac: l.hsnSac ?? '', qty: l.qty.toString(), unit: l.unit, rate: l.rate.toFixed(2), discountPct: l.discountPct.toString(), discount: l.discount.toFixed(2),
      taxable: l.taxable.toFixed(2), gstRate: l.gstRate.toString(), cgst: l.cgst.toFixed(2), sgst: l.sgst.toFixed(2), igst: l.igst.toFixed(2), lineTotal: l.lineTotal.toFixed(2),
    })),
    hsnSummary: [...hsn.values()].map((h) => ({ hsn: h.hsn, rate: h.rate, taxable: h.taxable.toFixed(2), cgst: h.cgst.toFixed(2), sgst: h.sgst.toFixed(2), igst: h.igst.toFixed(2), tax: h.cgst.plus(h.sgst).plus(h.igst).toFixed(2) })),
    totals: { taxable: d.taxable.toFixed(2), cgst: d.cgst.toFixed(2), sgst: d.sgst.toFixed(2), igst: d.igst.toFixed(2), roundOff: d.roundOff.toFixed(2), total: d.total.toFixed(2), pieces: d.lines.reduce((s, l) => s.plus(l.qty), zero()).toString() },
    amountInWords: amountInWords(d.total),
    look: {
      version: t.version, accentColor: t.accentColor, font: t.font, logo: await dataUri(t.logoAttachmentId), signature: await dataUri(t.signatureAttachmentId), upiQr, upiId: t.upiId,
      bank: bank ? { accountName: bank.accountName, bankName: bank.bankName, accountNumber: bank.accountNumber, ifsc: bank.ifsc } : null,
      warrantyText: d.docType === 'credit_note' ? null : t.warrantyText, declarationText: t.declarationText, termsText: d.docType === 'credit_note' ? null : t.termsText, footerText: t.footerText,
      showDiscount: t.showDiscount, showHsnSummary: t.showHsnSummary,
    },
  };
}

/** The HTML a document prints from (for checking the layout). */
export async function previewHtml(id: string) {
  return salesDocumentHtml(await pdfData(await loadDoc(id)));
}

/** A draft's PDF is a preview (stamped DRAFT, not filed). */
export async function previewPdf(id: string) {
  return renderPdf(salesDocumentHtml(await pdfData(await loadDoc(id))));
}

/** Files the PDF of an issued document with it (F104: frozen copy). */
export async function printDoc(ctx: AuditContext, id: string, opts: { keepPrevious?: boolean } = {}) {
  const d = await loadDoc(id);
  if (!d.docNumber) throw new UserError('Only an issued document is filed as PDF; a draft can be previewed');
  const pdf = await renderPdf(salesDocumentHtml(await pdfData(d)));
  if (d.pdfAttachmentId && !opts.keepPrevious) await archive({ ...ctx, reason: 'Printed again' }, d.pdfAttachmentId).catch(() => undefined);
  const name = `${d.docNumber.replace(/\//g, '-')}${d.status === 'cancelled' ? '-CANCELLED' : ''}.pdf`;
  const a = await upload({ ...ctx, reason: ctx.reason ?? 'Document printed' }, { recordType: 'SalesDocument', recordId: id, docKind: 'invoice_pdf', fileName: name, contentBase64: pdf.toString('base64') });
  await withAudit({ ...ctx, reason: ctx.reason ?? 'Document printed' }, (tx) => tx.salesDocument.update({ where: { id }, data: { pdfAttachmentId: a.id } }));
  return a;
}

// ---------- Views (F098) ----------

type DocRow = SalesDocument & { lines?: SalesDocumentLine[] };

function computedStatus(d: DocRow, conv?: string) {
  if (d.status !== 'issued') return d.status;
  if (d.docType === 'proforma') {
    if (conv === 'converted') return 'converted';
    if (conv === 'partly_converted') return 'partly_converted';
    if (d.validUntil && dateText(d.validUntil)! < todayIST()) return 'expired';
    if (d.acceptedAt) return 'accepted';
  }
  return 'issued';
}
export const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft', issued: 'Issued', cancelled: 'Cancelled', discarded: 'Discarded', converted: 'Converted', partly_converted: 'Partly converted', expired: 'Expired', accepted: 'Accepted',
};

function rowView(d: DocRow, conv?: string) {
  const bill = d.billTo as Party;
  const st = computedStatus(d, conv);
  return {
    id: d.id, docType: d.docType, docTypeLabel: DOC_LABEL[d.docType], docNumber: d.docNumber, docDate: dateText(d.docDate), status: st, statusLabel: STATUS_LABEL[st] ?? st,
    customerName: bill.name, customerGstin: bill.gstin, supplyType: d.supplyType, placeOfSupply: d.placeOfSupply, crmCompanyId: d.crmCompanyId, crmOrderNumber: d.crmOrderNumber,
    taxable: moneyText(d.taxable), tax: moneyText(d.cgst.plus(d.sgst).plus(d.igst)), total: moneyText(d.total), dueDate: dateText(d.dueDate), validUntil: dateText(d.validUntil),
    sent: !!d.sentAt, salesPerson: d.salesPerson, source: d.source, sourceLabel: SOURCE_LABEL[d.source] ?? d.source, refillPlanId: d.refillPlanId,
  };
}

export async function listDocs(f: { docType?: string; status?: string; q?: string; from?: string; to?: string; companyId?: string; supplyType?: string } = {}) {
  const where: Prisma.SalesDocumentWhereInput = {
    ...(f.docType && { docType: f.docType as SalesDocType }),
    ...(f.companyId && { crmCompanyId: f.companyId }),
    ...(f.supplyType && { supplyType: f.supplyType }),
    ...((f.from || f.to) && { docDate: { ...(f.from && { gte: parseDate(f.from) }), ...(f.to && { lte: parseDate(f.to) }) } }),
    ...(f.status && ['draft', 'issued', 'cancelled', 'discarded'].includes(f.status) ? { status: f.status as SalesDocument['status'] } : f.status ? { status: 'issued' } : { status: { not: 'discarded' } }),
  };
  const rows = await prisma.salesDocument.findMany({ where, orderBy: [{ docDate: 'desc' }, { createdAt: 'desc' }], take: 500 });
  const pis = rows.filter((r) => r.docType === 'proforma' && r.status === 'issued');
  const conv = new Map<string, string>();
  for (const pi of pis) {
    const lines = await prisma.salesDocumentLine.findMany({ where: { docId: pi.id, isArchived: false } });
    conv.set(pi.id, conversionState(lines.map((l) => ({ id: l.id, qty: l.qty })), await convertedLines(pi.id)).state);
  }
  const q = f.q?.trim().toLowerCase();
  const out = rows.map((r) => rowView(r, conv.get(r.id)))
    .filter((r) => (!q ? true : `${r.docNumber ?? ''} ${r.customerName} ${r.customerGstin ?? ''} ${r.crmOrderNumber ?? ''}`.toLowerCase().includes(q)))
    .filter((r) => (f.status && !['draft', 'issued', 'cancelled', 'discarded'].includes(f.status) ? r.status === f.status : true));
  const counted = out.filter((r) => r.status !== 'draft' && r.status !== 'cancelled');
  const sum = (k: 'taxable' | 'tax' | 'total', type: string) => moneyText(counted.filter((r) => r.docType === type).reduce((s, r) => s.plus(r[k] ?? 0), zero()));
  return {
    rows: out,
    totals: { invoiced: sum('total', 'tax_invoice'), invoicedTax: sum('tax', 'tax_invoice'), credited: sum('total', 'credit_note'), proformas: sum('total', 'proforma') },
  };
}

export async function getDoc(id: string) {
  const d = await loadDoc(id);
  const isDraft = d.status === 'draft';
  let conv: ReturnType<typeof conversionState> | null = null;
  if (d.docType === 'proforma') conv = conversionState(d.lines.map((l) => ({ id: l.id, qty: l.qty })), await convertedLines(d.id));
  const related = await prisma.salesDocument.findMany({ where: { OR: [{ proformaId: id }, { againstInvoiceId: id }, ...(d.proformaId ? [{ id: d.proformaId }] : []), ...(d.againstInvoiceId ? [{ id: d.againstInvoiceId }] : [])] }, orderBy: { createdAt: 'asc' } });
  const credited = d.docType === 'tax_invoice' ? await creditedLines(id) : null;
  let problems: string[] = [];
  let warnings: string[] = [];
  if (isDraft) {
    if (d.docType === 'credit_note') problems = await creditNoteProblems(d);
    else {
      const p = await plan(inputOf(d)).catch((e) => ({ problems: [e instanceof Error ? e.message : String(e)], warnings: [] as string[] }));
      problems = p.problems; warnings = p.warnings;
      if (d.proformaId) problems.push(...(await conversionProblems(d)));
    }
  }
  const series = isDraft ? await prisma.numberSeries.findFirst({ where: { docType: d.docType }, orderBy: { createdAt: 'desc' } }) : null;
  if (isDraft && series && !series.isActive) problems.push(`The ${DOC_LABEL[d.docType].toLowerCase()} series is switched off: switch it on in Settings > Numbering when you are ready to issue real documents`);
  const t = await template();
  const route = cancelRoute({ status: d.status, docDate: dateText(d.docDate)!, gstr1FiledMonths: d.docType === 'proforma' ? [] : await filedMonths() });
  const term = d.paymentTermId ? await prisma.paymentTerm.findUnique({ where: { id: d.paymentTermId } }) : null;
  return {
    ...rowView(d, conv?.state),
    billTo: d.billTo, shipTo: d.shipTo, gstMode: d.gstMode, reverseCharge: d.reverseCharge, customerKind: d.customerKind, crmBranchId: d.crmBranchId, shipToBranchId: d.shipToBranchId,
    customerPoNo: d.customerPoNo, customerPoDate: dateText(d.customerPoDate), paymentTermId: d.paymentTermId, paymentTerms: term?.label ?? null,
    ewayBillNo: d.ewayBillNo, transporter: d.transporter, vehicleNo: d.vehicleNo, notes: d.notes, creditReason: d.creditReason, creditReasonLabel: d.creditReason ? CREDIT_REASON_LABEL[d.creditReason] : null,
    statusReason: d.statusReason, issuedAt: d.issuedAt, sentAt: d.sentAt, acceptedAt: d.acceptedAt, cancelledAt: d.cancelledAt, templateVersion: d.templateVersion, layout: SALES_LAYOUT_VERSION,
    pdfAttachmentId: d.pdfAttachmentId, proformaId: d.proformaId, againstInvoiceId: d.againstInvoiceId,
    roundOff: moneyText(d.roundOff), cgst: moneyText(d.cgst), sgst: moneyText(d.sgst), igst: moneyText(d.igst), amountInWords: amountInWords(d.total),
    lines: d.lines.map((l) => ({
      id: l.id, lineNo: l.lineNo, invProductId: l.invProductId, sku: l.sku, description: l.description, hsnSac: l.hsnSac, qty: l.qty.toString(), unit: l.unit, rate: moneyText(l.rate),
      discountPct: l.discountPct.toString(), discount: moneyText(l.discount), gstRate: l.gstRate.toString(), taxable: moneyText(l.taxable), tax: moneyText(l.cgst.plus(l.sgst).plus(l.igst)),
      lineTotal: moneyText(l.lineTotal), priceSource: l.priceSource, sourceLineId: l.sourceLineId,
      remainingToConvert: conv ? conv.remaining[l.id] ?? null : null,
      credited: credited ? credited.lines.filter((x) => x.sourceLineId === l.id).reduce((s, x) => s.plus(x.qty), zero()).toString() : null,
    })),
    conversion: conv?.state ?? null,
    related: await Promise.all(related.map(async (r) => {
      if (r.docType !== 'proforma' || r.status !== 'issued') return rowView(r);
      const ls = await prisma.salesDocumentLine.findMany({ where: { docId: r.id, isArchived: false } });
      return rowView(r, conversionState(ls.map((l) => ({ id: l.id, qty: l.qty })), await convertedLines(r.id)).state);
    })),
    problems, warnings,
    ewayNeeded: ewayBillNeeded({ docType: d.docType, total: d.total, threshold: t.ewayBillThreshold, hasGoods: d.lines.some((l) => isGoodsCode(l.hsnSac)) }),
    cancelRoute: route,
  };
}

// ---------- F104 template settings ----------

async function ensureTemplate(): Promise<InvoiceTemplate> {
  const existing = await prisma.invoiceTemplate.findFirst({ orderBy: { version: 'desc' } });
  if (existing) return existing;
  const company = await getCompany();
  const bank = await prisma.bankAccount.findFirst({ where: { owner: 'Entelechy', accountType: 'business_current', isArchived: false }, orderBy: { createdAt: 'asc' } });
  return withAudit({ userId: 'system', reason: 'Invoice template version 1 (defaults from the current proforma layout)' }, (tx) => tx.invoiceTemplate.upsert({
    where: { version: 1 }, update: {},
    create: {
      version: 1, bankAccountId: bank?.id ?? null,
      warrantyText: '12 months warranty from the date of invoice against manufacturing defects.',
      declarationText: 'We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.',
      footerText: company.email ? `Questions about this invoice: ${company.email}` : null,
    },
  }));
}

function templateView(t: InvoiceTemplate) {
  return {
    version: t.version, accentColor: t.accentColor, font: t.font, logoAttachmentId: t.logoAttachmentId, signatureAttachmentId: t.signatureAttachmentId, bankAccountId: t.bankAccountId,
    upiId: t.upiId, warrantyText: t.warrantyText, declarationText: t.declarationText, termsText: t.termsText, footerText: t.footerText, showDiscount: t.showDiscount,
    showHsnSummary: t.showHsnSummary, ewayBillThreshold: moneyText(t.ewayBillThreshold), savedAt: t.createdAt,
  };
}

export async function getTemplate() {
  const t = await ensureTemplate();
  const versions = await prisma.invoiceTemplate.count();
  return { ...templateView(await template()), versions, layout: SALES_LAYOUT_VERSION, fonts: FONTS };
}

export type TemplateInput = {
  accentColor: string; font: string; logoAttachmentId?: string | null; signatureAttachmentId?: string | null; bankAccountId?: string | null; upiId?: string | null;
  warrantyText?: string | null; declarationText?: string | null; termsText?: string | null; footerText?: string | null; showDiscount: boolean; showHsnSummary: boolean; ewayBillThreshold: string;
};

/** Saves a new version; documents already issued keep theirs (F104). */
export async function saveTemplate(ctx: AuditContext, input: TemplateInput) {
  if (!/^#[0-9a-fA-F]{6}$/.test(input.accentColor)) throw new UserError('Colour must look like #0c2c55');
  if (!FONTS.includes(input.font as (typeof FONTS)[number])) throw new UserError('Choose a font from the list');
  if (input.upiId && !/^[\w.-]{2,}@[a-zA-Z]{2,}$/.test(input.upiId.trim())) throw new UserError('UPI ID must look like name@bank');
  if (input.bankAccountId && !(await prisma.bankAccount.findUnique({ where: { id: input.bankAccountId } }))) throw new UserError('Choose a bank account');
  const threshold = num(input.ewayBillThreshold, 'E-way bill threshold');
  const latest = await ensureTemplate();
  await withAudit({ ...ctx, reason: ctx.reason ?? 'Invoice template saved' }, (tx) => tx.invoiceTemplate.create({
    data: {
      version: latest.version + 1, accentColor: input.accentColor, font: input.font, logoAttachmentId: input.logoAttachmentId || null, signatureAttachmentId: input.signatureAttachmentId || null,
      bankAccountId: input.bankAccountId || null, upiId: text(input.upiId), warrantyText: text(input.warrantyText), declarationText: text(input.declarationText),
      termsText: text(input.termsText), footerText: text(input.footerText), showDiscount: input.showDiscount, showHsnSummary: input.showHsnSummary, ewayBillThreshold: threshold,
    },
  }));
  return getTemplate();
}

/** A sample tax invoice in the current template, to see the look before saving more (no number, nothing filed). */
export async function templateSample(): Promise<Buffer> {
  const company = await getCompany();
  const t = await ensureTemplate();
  const fake = {
    id: 'sample', docType: 'tax_invoice', docNumber: 'ELPL/26-27/00000', docDate: parseDate(todayIST()), status: 'draft', billTo: { name: 'Sample Hotels Pvt Ltd', address: '12 MG Road, Bengaluru 560001', stateCode: company.stateCode, gstin: null },
    shipTo: { name: 'Sample Hotels Pvt Ltd', address: '12 MG Road, Bengaluru 560001', stateCode: company.stateCode, gstin: null }, supplyType: 'b2b', placeOfSupply: company.stateCode, gstMode: 'cgst_sgst',
    reverseCharge: false, customerPoNo: null, customerPoDate: null, validUntil: null, dueDate: null, paymentTermId: null, ewayBillNo: null, transporter: null, vehicleNo: null, salesPerson: null, crmOrderNumber: null,
    againstInvoiceId: null, creditReason: null, companySnapshot: null, templateVersion: t.version,
    taxable: new Decimal('7800'), cgst: new Decimal('702'), sgst: new Decimal('702'), igst: zero(), roundOff: zero(), total: new Decimal('9204'),
    lines: [{ description: 'Bloc Trap Pro (sample)', hsnSac: '8543', qty: new Decimal(2), unit: 'Nos', rate: new Decimal('3900'), discountPct: zero(), discount: zero(), taxable: new Decimal('7800'), gstRate: new Decimal(18), cgst: new Decimal('702'), sgst: new Decimal('702'), igst: zero(), lineTotal: new Decimal('9204') }],
  } as unknown as SalesDocument & { lines: SalesDocumentLine[] };
  return renderPdf(salesDocumentHtml(await pdfData(fake)));
}

// ---------- BR-34 GSTR-1 months ----------

export async function listGstr1() {
  const rows = await prisma.gstr1Filing.findMany({ where: { isArchived: false }, orderBy: { month: 'desc' } });
  return rows.map((r) => ({ id: r.id, month: dateText(r.month), filedOn: dateText(r.filedOn), arn: r.arn, notes: r.notes }));
}

export async function markGstr1Filed(ctx: AuditContext, input: { month: string; filedOn: string; arn?: string | null; notes?: string | null }) {
  const month = `${dateText(parseDate(`${input.month.slice(0, 7)}-01`, 'Month'))!.slice(0, 7)}-01`;
  const filedOn = dateText(parseDate(input.filedOn, 'Filed on'))!;
  if (filedOn < month) throw new UserError('GSTR-1 is filed after the month it covers');
  if (await prisma.gstr1Filing.findFirst({ where: { month: parseDate(month), isArchived: false } })) throw new UserError('That month is already marked filed');
  const company = await getCompany();
  await withAudit({ ...ctx, reason: ctx.reason ?? `GSTR-1 for ${month.slice(0, 7)} marked filed` }, (tx) => tx.gstr1Filing.create({ data: { entityId: company.id, month: parseDate(month), filedOn: parseDate(filedOn), arn: text(input.arn), notes: text(input.notes) } }));
  return listGstr1();
}

export async function unmarkGstr1(ctx: AuditContext, id: string) {
  if (!text(ctx.reason)) throw new UserError('Say why the mark is removed');
  await withAudit(ctx, (tx) => tx.gstr1Filing.update({ where: { id }, data: { isArchived: true, archivedReason: ctx.reason } }));
  return listGstr1();
}
