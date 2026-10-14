import type { Prisma, TxnNature, Vendor, VendorDocStatus, VendorDocType, VendorDocument, VendorDocumentLine } from '@prisma/client';
import { prisma } from '../config/database';
import { withAudit, type AuditContext, type Tx } from '../lib/audit';
import { billAmounts, docNumberKey, dueDate as dueDateFor } from '../lib/bill';
import { dateText, parseDate, parseOptionalDate } from '../lib/dates';
import { fyLabel, todayIST } from '../lib/fy';
import { computeLine, gstMode, type GstMode } from '../lib/gst';
import { GST_STATE_CODES } from '../lib/gstin';
import { UserError } from '../lib/http';
import { Decimal, formatINR, moneyText } from '../lib/money';
import { suggestTds, type TdsSuggestion } from '../lib/tds';
import { presentKinds } from './attachment.service';
import { refreshPoStatus } from './po.service';
import { getCompany } from './settings.service';
import { syncBillTds } from './tds.service';
import { bankRecentlyChanged } from './vendor.service';

/**
 * M05 Vendor documents (F050-F059): quotes, proformas, tax invoices, debit and credit notes.
 * GST split from vendor state vs place of supply (BR-20), duplicate check (BR-19), due date (BR-23),
 * TDS suggested from the master with override and reason (BR-11, BR-12), net payable (BR-18).
 * Statuses follow Status Flows and are never typed.
 */

export const DOC_TYPE_LABEL: Record<VendorDocType, string> = {
  quote: 'Quote', proforma: 'Proforma', tax_invoice: 'Tax invoice', debit_note: 'Debit note', credit_note: 'Credit note',
};
export const DOC_STATUS_LABEL: Record<VendorDocStatus, string> = {
  awaiting_tax_invoice: 'Awaiting tax invoice', received: 'Received', approved: 'OK to pay', partially_paid: 'Partially paid',
  paid: 'Paid', disputed: 'Disputed', replaced: 'Replaced by tax invoice', cancelled: 'Cancelled',
};

const PAYABLE_TYPES: VendorDocType[] = ['tax_invoice', 'quote', 'proforma'];
const NOTE_TYPES: VendorDocType[] = ['debit_note', 'credit_note'];
const OPEN_PO: string[] = ['approved', 'sent', 'partially_billed'];
const zero = () => new Decimal(0);
const text = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

export type BillLineInput = {
  poLineId?: string | null; description: string; hsnSac?: string | null; qty: string; unit?: string | null; rate: string; discount?: string | null; gstRate: string;
  /** GST exactly as printed on the vendor's document, when it differs from the computed split (F053). */
  cgst?: string | null; sgst?: string | null; igst?: string | null;
};
export type BillInput = {
  docType: VendorDocType;
  vendorId: string;
  docNumber: string;
  docDate: string;
  receivedDate?: string | null;
  poId?: string | null;
  replacesDocumentId?: string | null;
  againstDocumentId?: string | null;
  placeOfSupplyState?: string | null;
  reverseCharge?: boolean;
  lines: BillLineInput[];
  otherCharges?: string | null;
  /** The vendor's round-off; worked out to the nearest rupee when empty (BR-21). */
  roundOff?: string | null;
  /** Leave empty to take the suggestion; anything different needs overrideReason. */
  tds?: { applicable: boolean; sectionId?: string | null; rate?: string | null; base?: string | null; amount?: string | null; overrideReason?: string | null } | null;
  categoryId?: string | null;
  subCategoryId?: string | null;
  paymentTermId?: string | null;
  dueDate?: string | null;
  itcEligible?: boolean;
  notes?: string | null;
};

const money2 = (v: string | null | undefined, field: string) => {
  const clean = String(v ?? '').replace(/[,\s₹]/g, '');
  if (!clean) return zero();
  if (!/^-?\d{1,12}(\.\d{1,2})?$/.test(clean)) throw new UserError(`${field} is not a valid amount: ${v}`);
  return new Decimal(clean);
};

// ---------- TDS (BR-11, BR-12) ----------

/** What this vendor was billed this FY under a section before this document. */
async function fyBefore(vendorId: string, sectionId: string, fy: string, excludeId: string | null) {
  const docs = await prisma.vendorDocument.findMany({
    where: { vendorId, fyLabel: fy, docType: 'tax_invoice', status: { not: 'cancelled' }, ...(excludeId ? { id: { not: excludeId } } : {}),
      OR: [{ tdsSectionId: sectionId }, { tdsApplicable: false }] },
  });
  let taxedBase = zero(); let untaxed = zero(); let caughtUp = zero();
  for (const d of docs) {
    if (d.tdsApplicable && d.tdsSectionId === sectionId) {
      taxedBase = taxedBase.plus(d.tdsBase);
      if (d.tdsBase.greaterThan(d.taxableValue)) caughtUp = caughtUp.plus(d.tdsBase.minus(d.taxableValue));
    } else if (!d.tdsApplicable) {
      untaxed = untaxed.plus(d.taxableValue);
    }
  }
  return { taxedBase, untaxedBase: Decimal.max(untaxed.minus(caughtUp), 0) };
}

async function tdsSuggestion(vendor: Vendor, sectionId: string | null, base: Decimal, date: string, excludeId: string | null): Promise<TdsSuggestion> {
  const section = sectionId ? await prisma.tdsSection.findUnique({ where: { id: sectionId } }) : null;
  const label = section ? `${section.codeOldAct} ${section.nature}` : '';
  return suggestTds({
    section: section && { id: section.id, label, rateIndividual: section.rateIndividual, rateOthers: section.rateOthers, rateNoPan: section.rateNoPan, singleThreshold: section.singleThreshold, annualThreshold: section.annualThreshold },
    deducteeType: vendor.deducteeType,
    base,
    date,
    fyBefore: section ? await fyBefore(vendor.id, section.id, fyLabel(date), excludeId) : { taxedBase: zero(), untaxedBase: zero() },
    ldc: vendor.ldcRate ? { number: vendor.ldcNumber, rate: vendor.ldcRate, validFrom: dateText(vendor.ldcValidFrom), validTo: dateText(vendor.ldcValidTo), limit: vendor.ldcLimit } : null,
  });
}

// ---------- Form ----------

async function docData(input: BillInput, existingId: string | null) {
  const vendor = await prisma.vendor.findUnique({ where: { id: input.vendorId } });
  if (!vendor) throw new UserError('Vendor not found', 404);
  if (vendor.isArchived) throw new UserError(`${vendor.displayName} is archived`);
  const docNumber = text(input.docNumber);
  if (!docNumber) throw new UserError("Enter the vendor's document number");
  const docDate = dateText(parseDate(input.docDate, 'Document date'))!;
  const fy = fyLabel(docDate);
  const company = await getCompany();
  const warnings: string[] = [];

  // BR-19 duplicate (blocked) and same amount within 7 days (warned).
  const key = docNumberKey(docNumber);
  const dup = await prisma.vendorDocument.findFirst({ where: { vendorId: vendor.id, fyLabel: fy, docNumberKey: key, status: { not: 'cancelled' }, ...(existingId ? { id: { not: existingId } } : {}) } });
  if (dup) throw new UserError(`${DOC_TYPE_LABEL[dup.docType]} ${dup.docNumber} from ${vendor.displayName} is already entered for FY ${fy}`);

  // PO link (F052) and over-billing (BR-17).
  const po = input.poId ? await prisma.purchaseOrder.findUnique({ where: { id: input.poId }, include: { lines: { where: { isArchived: false } } } }) : null;
  if (input.poId && !po) throw new UserError('Purchase order not found');
  if (po && po.vendorId !== vendor.id) throw new UserError(`${po.poNumber} is for another vendor`);
  if (po && !OPEN_PO.includes(po.status)) {
    const linkedAlready = existingId ? await prisma.vendorDocument.findFirst({ where: { id: existingId, poId: po.id } }) : null;
    if (!linkedAlready) throw new UserError(`${po.poNumber ?? 'This PO'} is ${po.status.replace('_', ' ')}; bills can only be linked to an issued, open PO`);
  }

  // Place of supply: the PO's, else our own state (goods delivered to us).
  const placeOfSupplyState = text(input.placeOfSupplyState) ?? po?.placeOfSupplyState ?? company.stateCode;
  if (!GST_STATE_CODES[placeOfSupplyState]) throw new UserError(`${placeOfSupplyState} is not a GST state code`);
  const mode: GstMode = gstMode({ supplierState: vendor.stateCode, placeOfSupply: placeOfSupplyState, supplierRegistered: vendor.gstRegistered });

  if (!input.lines.length) throw new UserError('Add at least one line');
  const mismatches: string[] = [];
  const lines = input.lines.map((l, i) => {
    if (!l.description.trim()) throw new UserError(`Line ${i + 1} needs a description`);
    if (l.poLineId && !po?.lines.some((pl) => pl.id === l.poLineId)) throw new UserError(`Line ${i + 1} points to a line of another PO`);
    const gstRate = mode === 'none' ? '0' : l.gstRate;
    const a = computeLine({ qty: l.qty, rate: l.rate, discount: l.discount ?? '0', gstRate, mode });
    // F053: take the vendor's GST figures when typed; warn when they differ from the computed split.
    const typed = { cgst: text(l.cgst), sgst: text(l.sgst), igst: text(l.igst) };
    let { cgst, sgst, igst } = a;
    if (typed.cgst || typed.sgst || typed.igst) {
      const t = { cgst: money2(typed.cgst, 'CGST'), sgst: money2(typed.sgst, 'SGST'), igst: money2(typed.igst, 'IGST') };
      if (mode === 'none' && !t.cgst.plus(t.sgst).plus(t.igst).isZero()) throw new UserError(`${vendor.displayName} is not GST registered and cannot charge GST`);
      if (mode === 'igst' && !t.cgst.plus(t.sgst).isZero()) mismatches.push(`line ${i + 1}: CGST/SGST charged on an inter-state supply (IGST expected)`);
      if (mode === 'cgst_sgst' && !t.igst.isZero()) mismatches.push(`line ${i + 1}: IGST charged on an intra-state supply (CGST + SGST expected)`);
      for (const k of ['cgst', 'sgst', 'igst'] as const) {
        if (!t[k].equals(a[k])) mismatches.push(`line ${i + 1}: ${k.toUpperCase()} ${formatINR(t[k])} on the document, ${formatINR(a[k])} computed`);
      }
      ({ cgst, sgst, igst } = t);
    }
    return {
      lineNo: i + 1, poLineId: l.poLineId || null, description: l.description.trim(), hsnSac: text(l.hsnSac),
      qty: new Decimal(l.qty.replace(/,/g, '')), unit: text(l.unit) ?? 'Nos', rate: new Decimal(l.rate.replace(/,/g, '')),
      discount: new Decimal((l.discount || '0').replace(/,/g, '')), gstRate: new Decimal(gstRate || '0'),
      taxable: a.taxable, cgst, sgst, igst, lineTotal: a.taxable.plus(cgst).plus(sgst).plus(igst),
    };
  });
  const sumOf = (k: 'taxable' | 'cgst' | 'sgst' | 'igst') => lines.reduce((s, l) => s.plus(l[k]), zero());
  const taxableValue = sumOf('taxable');
  const cgst = sumOf('cgst'); const sgst = sumOf('sgst'); const igst = sumOf('igst');
  const otherCharges = money2(input.otherCharges, 'Other charges');
  if (otherCharges.isNegative()) throw new UserError('Other charges cannot be negative');
  const before = taxableValue.plus(cgst).plus(sgst).plus(igst).plus(otherCharges);
  const roundOff = text(input.roundOff) ? money2(input.roundOff, 'Round off') : before.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).minus(before);
  if (roundOff.abs().greaterThanOrEqualTo(1)) throw new UserError('Round off must be less than one rupee (BR-21)');
  const totalValue = before.plus(roundOff);

  // F057 replacing a quote / proforma; notes against an invoice.
  if (input.replacesDocumentId) {
    if (input.docType !== 'tax_invoice') throw new UserError('Only a tax invoice can replace a quote or proforma');
    const r = await prisma.vendorDocument.findUnique({ where: { id: input.replacesDocumentId } });
    if (!r || r.vendorId !== vendor.id || !['quote', 'proforma'].includes(r.docType)) throw new UserError('Choose a quote or proforma from the same vendor to replace');
    if (r.status !== 'awaiting_tax_invoice' && !(existingId && (await prisma.vendorDocument.findFirst({ where: { id: existingId, replacesDocumentId: r.id } })))) {
      throw new UserError(`${r.docNumber} is ${DOC_STATUS_LABEL[r.status].toLowerCase()}`);
    }
  }
  if (NOTE_TYPES.includes(input.docType)) {
    const a = input.againstDocumentId ? await prisma.vendorDocument.findUnique({ where: { id: input.againstDocumentId } }) : null;
    if (!a || a.vendorId !== vendor.id || a.docType !== 'tax_invoice' || a.status === 'cancelled') throw new UserError('A debit or credit note must point to a tax invoice of the same vendor');
  }

  // PO over-billing (BR-17): taxable against taxable, tolerance 0.
  if (po && input.docType === 'tax_invoice') {
    const others = await prisma.vendorDocument.aggregate({ _sum: { taxableValue: true }, where: { poId: po.id, docType: 'tax_invoice', status: { not: 'cancelled' }, ...(existingId ? { id: { not: existingId } } : {}) } });
    const billed = (others._sum.taxableValue ?? zero()).plus(taxableValue);
    if (billed.greaterThan(po.taxable)) throw new UserError(`This takes ${po.poNumber} to ${formatINR(billed)} billed against ${formatINR(po.taxable)} ordered. Amend the PO first (BR-17).`);
  }

  // TDS: on tax invoices when booked; on quotes and proformas when the advance is paid (BR-11).
  let tds = { tdsApplicable: false, tdsSectionId: null as string | null, tdsBase: zero(), tdsRate: zero(), tdsAmount: zero(), tdsOverrideReason: null as string | null };
  let suggestion: TdsSuggestion | null = null as TdsSuggestion | null;
  if (input.docType === 'tax_invoice') {
    const sectionId = input.tds?.sectionId ?? vendor.defaultTdsSectionId ?? null;
    suggestion = await tdsSuggestion(vendor, sectionId, taxableValue, docDate, existingId);
    const advanceDocs = [input.replacesDocumentId].filter(Boolean) as string[];
    const advanceTds = advanceDocs.length
      ? (await prisma.paymentAllocation.findMany({ where: { docId: { in: advanceDocs }, isArchived: false, payment: { status: { in: ['paid', 'reconciled'] } } } }))
        .reduce((s, a) => s.plus(a.tdsAmount), zero())
      : zero();
    if (suggestion.applicable && advanceTds.greaterThan(0)) {
      const rest = Decimal.max(new Decimal(suggestion.amount).minus(advanceTds), 0);
      suggestion = { ...suggestion, amount: rest.toFixed(2), reason: `${suggestion.reason}; less ${formatINR(advanceTds)} already deducted on the advance (BR-11)` };
    }
    const t = input.tds;
    if (!t) {
      tds = { tdsApplicable: suggestion.applicable, tdsSectionId: suggestion.applicable ? suggestion.sectionId : sectionId, tdsBase: new Decimal(suggestion.base), tdsRate: new Decimal(suggestion.rate), tdsAmount: new Decimal(suggestion.amount), tdsOverrideReason: null };
    } else if (!t.applicable) {
      tds = { ...tds, tdsSectionId: sectionId };
    } else {
      if (!sectionId) throw new UserError('Choose the TDS section');
      const base = t.base ? money2(t.base, 'TDS base') : taxableValue;
      const rate = new Decimal(t.rate || suggestion.rate);
      const amount = t.amount ? money2(t.amount, 'TDS amount') : base.times(rate).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      tds = { tdsApplicable: true, tdsSectionId: sectionId, tdsBase: base, tdsRate: rate, tdsAmount: amount, tdsOverrideReason: text(t.overrideReason) };
    }
    const differs = tds.tdsApplicable !== suggestion.applicable
      || (tds.tdsApplicable && (!tds.tdsAmount.equals(suggestion.amount) || (tds.tdsSectionId ?? null) !== suggestion.sectionId));
    if (differs && !tds.tdsOverrideReason) {
      throw new UserError(`TDS differs from the suggestion (${suggestion.applicable ? formatINR(suggestion.amount) : 'none'}: ${suggestion.reason}). Give a reason for the change.`);
    }
    if (!differs) tds.tdsOverrideReason = null;
  }

  // Category (F055): from the bill, else the vendor's default; nature from the category (BR-04).
  const categoryId = input.categoryId ?? vendor.defaultCategoryId ?? null;
  const subCategoryId = input.subCategoryId ?? (input.categoryId ? null : vendor.defaultSubCategoryId) ?? null;
  let nature: TxnNature | null = null;
  if (categoryId) {
    const c = await prisma.category.findUnique({ where: { id: categoryId }, include: { subCategories: true } });
    if (!c) throw new UserError('Category not found');
    const sub = subCategoryId ? c.subCategories.find((s) => s.id === subCategoryId) : null;
    if (subCategoryId && !sub) throw new UserError('That sub-category is not under the chosen category');
    nature = sub?.natureOverride ?? c.natureDefault;
  }

  // Due date (BR-23): typed, or document date + the term (bill's, else the vendor's).
  const paymentTermId = input.paymentTermId ?? vendor.paymentTermId ?? null;
  const term = paymentTermId ? await prisma.paymentTerm.findUnique({ where: { id: paymentTermId } }) : null;
  const due = text(input.dueDate) ?? dueDateFor(docDate, term);
  parseDate(due, 'Due date');

  // Warnings that do not block.
  const sameAmount = await prisma.vendorDocument.findFirst({
    where: { vendorId: vendor.id, totalValue, status: { not: 'cancelled' }, ...(existingId ? { id: { not: existingId } } : {}),
      docDate: { gte: parseDate(shift(docDate, -7)), lte: parseDate(shift(docDate, 7)) } },
  });
  if (sameAmount) warnings.push(`${DOC_TYPE_LABEL[sameAmount.docType]} ${sameAmount.docNumber} from this vendor has the same amount within 7 days. Check it is not the same bill (BR-19).`);
  if (mismatches.length) warnings.push(`GST on the document differs from the computed split: ${mismatches.join('; ')}.`);
  if (vendor.status === 'blocked') warnings.push(`${vendor.displayName} is blocked: no new payments.`);
  if (vendor.status !== 'active' && vendor.status !== 'blocked') warnings.push(`${vendor.displayName} is not active yet.`);
  if (mode === 'none') warnings.push(`${vendor.displayName} is not GST registered, so no GST is charged.`);

  return {
    vendor, po, suggestion, warnings,
    header: {
      entityId: company.id, docType: input.docType, vendorId: vendor.id, docNumber, docNumberKey: key, fyLabel: fy,
      docDate: parseDate(docDate), receivedDate: parseOptionalDate(input.receivedDate, 'Received date'),
      poId: po?.id ?? null, replacesDocumentId: input.replacesDocumentId || null, againstDocumentId: NOTE_TYPES.includes(input.docType) ? input.againstDocumentId! : null,
      placeOfSupplyState, gstMode: mode, reverseCharge: input.reverseCharge ?? false,
      taxableValue, cgst, sgst, igst, otherCharges, roundOff, totalValue,
      taxMismatch: mismatches.length ? mismatches.join('; ') : null,
      ...tds,
      tdsSuggestion: (suggestion ?? undefined) as Prisma.InputJsonValue | undefined,
      categoryId, subCategoryId, nature, paymentTermId, dueDate: parseDate(due),
      itcEligible: input.itcEligible ?? true, notes: text(input.notes),
    },
    lines,
  };
}

function shift(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** F053 preview: GST, totals, TDS suggestion, due date and warnings; nothing saved. */
export async function previewBill(input: BillInput, existingId: string | null = null) {
  const { header, lines, suggestion, warnings } = await docData(input, existingId);
  const net = header.totalValue.minus(header.tdsAmount);
  return {
    gstMode: header.gstMode, placeOfSupplyState: header.placeOfSupplyState,
    lines: lines.map((l) => ({ taxable: moneyText(l.taxable), tax: moneyText(l.cgst.plus(l.sgst).plus(l.igst)), lineTotal: moneyText(l.lineTotal) })),
    taxableValue: moneyText(header.taxableValue), cgst: moneyText(header.cgst), sgst: moneyText(header.sgst), igst: moneyText(header.igst),
    otherCharges: moneyText(header.otherCharges), roundOff: moneyText(header.roundOff), totalValue: moneyText(header.totalValue),
    tds: { applicable: header.tdsApplicable, sectionId: header.tdsSectionId, base: moneyText(header.tdsBase), rate: header.tdsRate.toFixed(2), amount: moneyText(header.tdsAmount) },
    tdsSuggestion: suggestion,
    netPayable: moneyText(net),
    dueDate: dateText(header.dueDate),
    categoryId: header.categoryId, subCategoryId: header.subCategoryId, nature: header.nature,
    warnings,
  };
}

async function replaceLines(tx: Tx, docId: string, lines: Awaited<ReturnType<typeof docData>>['lines']) {
  await tx.vendorDocumentLine.updateMany({ where: { docId, isArchived: false }, data: { isArchived: true } });
  for (const l of lines) await tx.vendorDocumentLine.create({ data: { docId, ...l } });
}

/** BR-18 figures and the payment states that follow from them. */
export async function refreshDocAmounts(tx: Tx, id: string) {
  const d = await tx.vendorDocument.findUniqueOrThrow({ where: { id } });
  let notes = zero();
  if (d.docType === 'tax_invoice') {
    const ns = await tx.vendorDocument.findMany({ where: { againstDocumentId: id, status: { not: 'cancelled' } } });
    for (const n of ns) notes = n.docType === 'debit_note' ? notes.plus(n.totalValue) : notes.minus(n.totalValue);
  }
  // BR-08 / BR-09: what recorded payments settled on this document, and advances applied to it.
  const live = { isArchived: false, payment: { status: { in: ['paid', 'reconciled'] as ('paid' | 'reconciled')[] } } };
  const gross = (rows: { amount: Decimal; tdsAmount: Decimal }[]) => rows.reduce((s, r) => s.plus(r.amount).plus(r.tdsAmount), zero());
  const paidAmount = gross(await tx.paymentAllocation.findMany({ where: { docId: id, ...live } }));
  const advancesApplied = d.docType === 'tax_invoice' ? gross(await tx.paymentAllocation.findMany({ where: { appliedToDocId: id, ...live } })) : zero();
  d.paidAmount = paidAmount;
  d.advancesApplied = advancesApplied;
  const isNote = NOTE_TYPES.includes(d.docType);
  const a = isNote
    ? { netPayable: zero(), outstanding: zero() }
    : billAmounts({ total: d.totalValue, tds: d.tdsAmount, advancesApplied: d.advancesApplied, paid: d.paidAmount, notes });
  let status = d.status;
  if (d.docType === 'tax_invoice' && ['approved', 'partially_paid', 'paid'].includes(d.status)) {
    status = a.outstanding.lessThanOrEqualTo(0) ? 'paid' : d.paidAmount.plus(d.advancesApplied).greaterThan(0) ? 'partially_paid' : 'approved';
  }
  await tx.vendorDocument.update({ where: { id }, data: { paidAmount, advancesApplied, notesAdjustment: notes, netPayable: a.netPayable, outstanding: a.outstanding, status } });
  if (d.againstDocumentId) await refreshDocAmounts(tx, d.againstDocumentId);
}

/** BR-17: billed taxable / total and billed quantities on the PO, from its tax invoices. */
export async function refreshPoBilling(tx: Tx, poId: string) {
  const docs = await tx.vendorDocument.findMany({ where: { poId, docType: 'tax_invoice', status: { not: 'cancelled' } }, include: { lines: { where: { isArchived: false } } } });
  const billedTaxable = docs.reduce((s, d) => s.plus(d.taxableValue), zero());
  const billedTotal = docs.reduce((s, d) => s.plus(d.totalValue), zero());
  // Paid on the PO: payments to its documents and advances paid straight against it (BR-08, BR-09).
  const docIds = (await tx.vendorDocument.findMany({ where: { poId }, select: { id: true } })).map((d) => d.id);
  const allocs = await tx.paymentAllocation.findMany({
    where: { isArchived: false, payment: { status: { in: ['paid', 'reconciled'] } }, OR: [{ poId }, { docId: { in: docIds } }] },
    include: { payment: false },
  });
  const advDocs = new Set((await tx.vendorDocument.findMany({ where: { id: { in: docIds }, docType: { in: ['quote', 'proforma'] } }, select: { id: true } })).map((d) => d.id));
  const g = (a: { amount: Decimal; tdsAmount: Decimal }) => a.amount.plus(a.tdsAmount);
  const paidTotal = allocs.reduce((s, a) => s.plus(g(a)), zero());
  const advanceTotal = allocs.filter((a) => !a.appliedToDocId && (a.poId || (a.docId && advDocs.has(a.docId)))).reduce((s, a) => s.plus(g(a)), zero());
  await tx.purchaseOrder.update({ where: { id: poId }, data: { billedTaxable, billedTotal, paidTotal, advanceTotal } });
  const qty = new Map<string, Decimal>();
  for (const l of docs.flatMap((d) => d.lines)) if (l.poLineId) qty.set(l.poLineId, (qty.get(l.poLineId) ?? zero()).plus(l.qty));
  for (const pl of await tx.poLine.findMany({ where: { poId, isArchived: false } })) {
    const q = qty.get(pl.id) ?? zero();
    if (!q.equals(pl.qtyBilled)) await tx.poLine.update({ where: { id: pl.id }, data: { qtyBilled: q } });
  }
  await refreshPoStatus(tx, poId);
}

export async function createBill(ctx: AuditContext, input: BillInput) {
  const { header, lines, warnings } = await docData(input, null);
  const status: VendorDocStatus = ['quote', 'proforma'].includes(input.docType) ? 'awaiting_tax_invoice' : 'received';
  const doc = await withAudit({ ...ctx, reason: ctx.reason ?? header.tdsOverrideReason ?? `${DOC_TYPE_LABEL[input.docType]} entered` }, async (tx) => {
    const d = await tx.vendorDocument.create({ data: { ...header, status } });
    await replaceLines(tx, d.id, lines);
    if (header.replacesDocumentId) {
      await tx.vendorDocument.update({ where: { id: header.replacesDocumentId }, data: { status: 'replaced', statusReason: `Replaced by tax invoice ${header.docNumber}` } });
      // BR-09: the advance paid against the proforma now settles the tax invoice.
      await tx.paymentAllocation.updateMany({ where: { docId: header.replacesDocumentId, isArchived: false, appliedToDocId: null }, data: { appliedToDocId: d.id, appliedAt: new Date() } });
    }
    await refreshDocAmounts(tx, d.id);
    if (header.poId) await refreshPoBilling(tx, header.poId);
    await syncBillTds(tx, d.id);
    return d;
  });
  return { ...(await getBill(doc.id)), saveWarnings: warnings };
}

const EDITABLE: VendorDocStatus[] = ['awaiting_tax_invoice', 'received', 'approved', 'disputed'];

export async function updateBill(ctx: AuditContext, id: string, input: BillInput) {
  const old = await loadDoc(id);
  if (!EDITABLE.includes(old.status)) throw new UserError(`A ${DOC_STATUS_LABEL[old.status].toLowerCase()} document cannot be edited`);
  if (!old.paidAmount.isZero() || !old.advancesApplied.isZero()) throw new UserError('Payments are already allocated to this document; it cannot be edited');
  if (input.docType !== old.docType) throw new UserError('The document type cannot change; cancel it and enter it again');
  if (input.replacesDocumentId !== (old.replacesDocumentId ?? undefined) && (input.replacesDocumentId ?? null) !== old.replacesDocumentId) {
    throw new UserError('The quote or proforma a tax invoice replaces cannot change; cancel and enter it again');
  }
  const { header, lines, warnings } = await docData(input, id);
  await withAudit({ ...ctx, reason: ctx.reason ?? header.tdsOverrideReason ?? 'Document edited' }, async (tx) => {
    // Editing an approved bill sends it back to Received for a fresh OK to pay.
    const status = old.status === 'approved' ? 'received' : old.status;
    await tx.vendorDocument.update({ where: { id }, data: { ...header, status, approvedBy: status === 'received' ? null : old.approvedBy, approvedAt: status === 'received' ? null : old.approvedAt } });
    await replaceLines(tx, id, lines);
    await refreshDocAmounts(tx, id);
    for (const poId of new Set([old.poId, header.poId].filter(Boolean) as string[])) await refreshPoBilling(tx, poId);
    await syncBillTds(tx, id);
  });
  return { ...(await getBill(id)), saveWarnings: warnings };
}

async function loadDoc(id: string) {
  const d = await prisma.vendorDocument.findUnique({ where: { id } });
  if (!d) throw new UserError('Document not found', 404);
  return d;
}

// ---------- Actions ----------

/** OK to pay (Status Flows): needs the vendor's file attached (F052 upload). */
export async function approveBill(ctx: AuditContext, id: string) {
  const d = await loadDoc(id);
  if (d.docType !== 'tax_invoice' || d.status !== 'received') throw new UserError('Only a received tax invoice can be marked OK to pay');
  if (!(await presentKinds('VendorDocument', id)).has('bill')) throw new UserError("Attach the vendor's invoice first");
  await withAudit({ ...ctx, reason: ctx.reason ?? 'OK to pay' }, async (tx) => {
    await tx.vendorDocument.update({ where: { id }, data: { status: 'approved', approvedBy: ctx.userId, approvedAt: new Date() } });
    await refreshDocAmounts(tx, id);
  });
  return getBill(id);
}

/** F058 hold: excluded from payment runs until resolved. */
export async function disputeBill(ctx: AuditContext, id: string) {
  if (!ctx.reason?.trim()) throw new UserError('Say what is disputed');
  const d = await loadDoc(id);
  if (!['received', 'approved', 'partially_paid'].includes(d.status) || d.docType !== 'tax_invoice') throw new UserError('Only an open tax invoice can be put on hold');
  await withAudit(ctx, (tx) => tx.vendorDocument.update({ where: { id }, data: { status: 'disputed', statusReason: ctx.reason } }));
  return getBill(id);
}

export async function resolveDispute(ctx: AuditContext, id: string) {
  const d = await loadDoc(id);
  if (d.status !== 'disputed') throw new UserError('This document is not on hold');
  await withAudit({ ...ctx, reason: ctx.reason ?? 'Dispute resolved' }, async (tx) => {
    await tx.vendorDocument.update({ where: { id }, data: { status: d.approvedAt ? 'approved' : 'received', statusReason: null } });
    await refreshDocAmounts(tx, id);
  });
  return getBill(id);
}

/** Cancel (entered in error or withdrawn): only when nothing is allocated. A replaced proforma comes back. */
export async function cancelBill(ctx: AuditContext, id: string) {
  if (!ctx.reason?.trim()) throw new UserError('Say why the document is cancelled');
  const d = await loadDoc(id);
  if (['cancelled', 'paid', 'replaced'].includes(d.status)) throw new UserError(`A ${DOC_STATUS_LABEL[d.status].toLowerCase()} document cannot be cancelled`);
  if (!d.paidAmount.isZero()) throw new UserError('Payments are allocated to this document; it cannot be cancelled');
  const poAdvances = await prisma.paymentAllocation.count({ where: { appliedToDocId: id, poId: { not: null }, isArchived: false } });
  if (poAdvances) throw new UserError('PO advances are applied to this invoice; take them off first');
  const notes = await prisma.vendorDocument.count({ where: { againstDocumentId: id, status: { not: 'cancelled' } } });
  if (notes) throw new UserError('Debit or credit notes point to this invoice; cancel them first');
  await withAudit(ctx, async (tx) => {
    await tx.vendorDocument.update({ where: { id }, data: { status: 'cancelled', statusReason: ctx.reason } });
    if (d.replacesDocumentId) {
      await tx.vendorDocument.update({ where: { id: d.replacesDocumentId }, data: { status: 'awaiting_tax_invoice', statusReason: null } });
      await tx.paymentAllocation.updateMany({ where: { docId: d.replacesDocumentId, appliedToDocId: id }, data: { appliedToDocId: null, appliedAt: null } });
      await refreshDocAmounts(tx, d.replacesDocumentId);
    }
    if (d.againstDocumentId) await refreshDocAmounts(tx, d.againstDocumentId);
    if (d.poId) await refreshPoBilling(tx, d.poId);
    await syncBillTds(tx, id);
  });
  return getBill(id);
}

// ---------- Views (F050, F057, F059) ----------

function overdue(d: VendorDocument, today: string) {
  return !!d.dueDate && dateText(d.dueDate)! < today && d.outstanding.greaterThan(0) && ['received', 'approved', 'partially_paid', 'disputed'].includes(d.status);
}

function docRow(d: VendorDocument & { vendor: Vendor; po?: { poNumber: string | null } | null }, today: string) {
  return {
    id: d.id, docType: d.docType, docTypeLabel: DOC_TYPE_LABEL[d.docType], docNumber: d.docNumber, docDate: dateText(d.docDate), fyLabel: d.fyLabel,
    status: d.status, statusLabel: DOC_STATUS_LABEL[d.status], overdue: overdue(d, today),
    vendorId: d.vendorId, vendorName: d.vendor.displayName, vendorGstin: d.vendor.gstin, msme: d.vendor.msmeType !== 'none' ? d.vendor.msmeType : null,
    poId: d.poId, poNumber: d.po?.poNumber ?? null,
    taxableValue: moneyText(d.taxableValue), cgst: moneyText(d.cgst), sgst: moneyText(d.sgst), igst: moneyText(d.igst),
    otherCharges: moneyText(d.otherCharges), totalValue: moneyText(d.totalValue), tdsAmount: moneyText(d.tdsAmount),
    netPayable: moneyText(d.netPayable), paidAmount: moneyText(d.paidAmount.plus(d.advancesApplied)), outstanding: moneyText(d.outstanding),
    dueDate: dateText(d.dueDate),
  };
}

export async function listBills(f: { vendorId?: string; poId?: string; status?: string; docType?: string; q?: string; fy?: string; overdue?: boolean; open?: boolean } = {}) {
  const today = todayIST();
  const where: Prisma.VendorDocumentWhereInput = {
    ...(f.vendorId ? { vendorId: f.vendorId } : {}),
    ...(f.poId ? { poId: f.poId } : {}),
    ...(f.status ? { status: f.status as VendorDocStatus } : {}),
    ...(f.docType ? { docType: f.docType as VendorDocType } : {}),
    ...(f.fy ? { fyLabel: f.fy } : {}),
    ...(f.open ? { status: { in: ['received', 'approved', 'partially_paid', 'disputed', 'awaiting_tax_invoice'] } } : {}),
    ...(f.q ? { OR: [{ docNumber: { contains: f.q, mode: 'insensitive' } }, { vendor: { displayName: { contains: f.q, mode: 'insensitive' } } }] } : {}),
  };
  let rows = await prisma.vendorDocument.findMany({ where, include: { vendor: true, po: { select: { poNumber: true } } }, orderBy: [{ docDate: 'desc' }, { createdAt: 'desc' }], take: 1000 });
  if (f.overdue) rows = rows.filter((d) => overdue(d, today));
  const counted = rows.filter((r) => r.status !== 'cancelled' && r.status !== 'replaced' && !NOTE_TYPES.includes(r.docType));
  const sumOf = (fn: (d: VendorDocument) => Decimal) => moneyText(counted.reduce((s, d) => s.plus(fn(d)), zero()));
  return {
    rows: rows.map((r) => docRow(r, today)),
    totals: {
      count: rows.length,
      taxableValue: sumOf((d) => d.taxableValue), gst: sumOf((d) => d.cgst.plus(d.sgst).plus(d.igst)), totalValue: sumOf((d) => d.totalValue),
      tdsAmount: sumOf((d) => d.tdsAmount), netPayable: sumOf((d) => d.netPayable), outstanding: sumOf((d) => d.outstanding),
    },
  };
}

function lineView(l: VendorDocumentLine) {
  return {
    id: l.id, lineNo: l.lineNo, poLineId: l.poLineId, description: l.description, hsnSac: l.hsnSac, qty: l.qty.toString(), unit: l.unit,
    rate: l.rate.toString(), discount: moneyText(l.discount), gstRate: l.gstRate.toString(), taxable: moneyText(l.taxable),
    cgst: moneyText(l.cgst), sgst: moneyText(l.sgst), igst: moneyText(l.igst), tax: moneyText(l.cgst.plus(l.sgst).plus(l.igst)), lineTotal: moneyText(l.lineTotal),
  };
}

export async function getBill(id: string) {
  const d = await prisma.vendorDocument.findUnique({
    where: { id },
    include: { vendor: { include: { bankAccounts: true } }, po: { select: { poNumber: true, status: true } }, lines: { where: { isArchived: false }, orderBy: { lineNo: 'asc' } } },
  });
  if (!d) throw new UserError('Document not found', 404);
  const today = todayIST();
  const [replaces, replacedBy, against, notesAgainst, section, category, sub, term, files, users] = await Promise.all([
    d.replacesDocumentId ? prisma.vendorDocument.findUnique({ where: { id: d.replacesDocumentId } }) : null,
    prisma.vendorDocument.findFirst({ where: { replacesDocumentId: id, status: { not: 'cancelled' } } }),
    d.againstDocumentId ? prisma.vendorDocument.findUnique({ where: { id: d.againstDocumentId } }) : null,
    prisma.vendorDocument.findMany({ where: { againstDocumentId: id }, orderBy: { docDate: 'asc' } }),
    d.tdsSectionId ? prisma.tdsSection.findUnique({ where: { id: d.tdsSectionId } }) : null,
    d.categoryId ? prisma.category.findUnique({ where: { id: d.categoryId } }) : null,
    d.subCategoryId ? prisma.subCategory.findUnique({ where: { id: d.subCategoryId } }) : null,
    d.paymentTermId ? prisma.paymentTerm.findUnique({ where: { id: d.paymentTermId } }) : null,
    presentKinds('VendorDocument', id),
    prisma.user.findMany({ where: { id: { in: [d.approvedBy, d.createdBy].filter(Boolean) as string[] } } }),
  ]);
  const name = (uid: string | null) => { const u = users.find((x) => x.id === uid); return u ? `${u.firstName} ${u.lastName}`.trim() : uid; };
  const link = (x: VendorDocument | null) => x && { id: x.id, docType: x.docType, docTypeLabel: DOC_TYPE_LABEL[x.docType], docNumber: x.docNumber, status: x.status, statusLabel: DOC_STATUS_LABEL[x.status], totalValue: moneyText(x.totalValue) };
  const warnings: string[] = [];
  if (d.taxMismatch) warnings.push(`GST typed from the vendor's document differs from the computed split: ${d.taxMismatch}.`);
  if (!files.has('bill') && !['cancelled', 'replaced'].includes(d.status)) warnings.push("The vendor's document is not attached yet.");
  if (bankRecentlyChanged(d.vendor.bankAccounts)) warnings.push("This vendor's bank details changed in the last 30 days. Confirm them by phone before paying (BR-16).");
  if (d.vendor.msmeType === 'micro' || d.vendor.msmeType === 'small') warnings.push(`${d.vendor.msmeType === 'micro' ? 'Micro' : 'Small'} enterprise (MSME): pay within the agreed terms and at most 45 days (BR-25).`);
  if (['quote', 'proforma'].includes(d.docType) && d.status === 'awaiting_tax_invoice') warnings.push('TDS on an advance against this is worked out when the advance is paid (BR-11).');
  return {
    ...docRow(d, today),
    vendorStatus: d.vendor.status, receivedDate: dateText(d.receivedDate), placeOfSupplyState: d.placeOfSupplyState, gstMode: d.gstMode,
    reverseCharge: d.reverseCharge, roundOff: moneyText(d.roundOff), taxMismatch: d.taxMismatch,
    tds: { applicable: d.tdsApplicable, sectionId: d.tdsSectionId, sectionLabel: section ? `${section.codeOldAct} ${section.nature}` : null, verifiedByCa: section?.verifiedByCa ?? null,
      base: moneyText(d.tdsBase), rate: d.tdsRate.toFixed(2), amount: moneyText(d.tdsAmount), overrideReason: d.tdsOverrideReason, suggestion: d.tdsSuggestion as TdsSuggestion | null },
    advancesApplied: moneyText(d.advancesApplied), notesAdjustment: moneyText(d.notesAdjustment),
    categoryId: d.categoryId, subCategoryId: d.subCategoryId, categoryName: category?.name ?? null, subCategoryName: sub?.name ?? null, nature: d.nature,
    paymentTermId: d.paymentTermId, paymentTermLabel: term?.label ?? null, itcEligible: d.itcEligible, notes: d.notes, statusReason: d.statusReason,
    approvedBy: name(d.approvedBy), approvedAt: d.approvedAt, enteredBy: name(d.createdBy), enteredAt: d.createdAt,
    poStatus: d.po?.status ?? null,
    replaces: link(replaces), replacedBy: link(replacedBy), against: link(against), notesAgainst: notesAgainst.map((n) => link(n)!),
    lines: d.lines.map(lineView),
    warnings,
  };
}

/** F059 / BR-10: quotes and proformas still waiting for the tax invoice, oldest first. */
export async function chaseList() {
  const company = await getCompany();
  const today = todayIST();
  const docs = await prisma.vendorDocument.findMany({ where: { status: 'awaiting_tax_invoice' }, include: { vendor: true }, orderBy: { docDate: 'asc' } });
  const age = (d: VendorDocument) => Math.round((Date.parse(today) - d.docDate.getTime()) / 86_400_000);
  const rows = docs.map((d) => ({ ...docRow(d, today), ageDays: age(d), advancePaid: moneyText(d.paidAmount), due: age(d) > company.taxInvoiceChaseDays }));
  return {
    chaseAfterDays: company.taxInvoiceChaseDays,
    rows,
    totals: {
      awaiting: rows.length,
      advancesWithoutTaxInvoice: moneyText(docs.reduce((s, d) => s.plus(d.paidAmount), zero())),
      toChase: rows.filter((r) => r.due).length,
    },
  };
}
