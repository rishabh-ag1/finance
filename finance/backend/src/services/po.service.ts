import type { Prisma, PurchaseOrder, PoLine, PoStatus, Vendor } from '@prisma/client';
import { prisma } from '../config/database';
import { withAudit, type AuditContext, type Tx } from '../lib/audit';
import { dateText, parseDate, parseOptionalDate } from '../lib/dates';
import { amountInWords, computeLine, documentTotals, gstMode, type GstMode } from '../lib/gst';
import { GST_STATE_CODES } from '../lib/gstin';
import { UserError } from '../lib/http';
import { Decimal, moneyText } from '../lib/money';
import { poBillingStatus, type PoLifecycle } from '../lib/po';
import { purchaseOrderHtml, PO_TEMPLATE_VERSION, type PoPdfData } from '../pdf/purchaseOrder';
import { renderPdf } from '../pdf/render';
import { archive, upload } from './attachment.service';
import { takeNumber } from './numbering.service';
import { getCompany } from './settings.service';
import { bankRecentlyChanged } from './vendor.service';

/**
 * M04 Purchase orders (F040-F048). A PO is edited freely as a draft, gets its number only on
 * Issue (BR-30), is then frozen (database trigger) and changes only by amendment with a reason
 * (F046). Billing states are computed from linked tax invoices (BR-17).
 */

export const PO_STATUS_LABEL: Record<PoStatus, string> = {
  draft: 'Draft',
  pending_approval: 'Waiting for approval',
  approved: 'Issued',
  sent: 'Sent',
  partially_billed: 'Partially billed',
  fully_billed: 'Fully billed',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

const OPEN_FOR_BILLS: PoStatus[] = ['approved', 'sent', 'partially_billed'];

// ---------- Delivery addresses and purchase catalogue (F041, F042) ----------

export type DeliveryAddressInput = { label: string; address: string; stateCode: string; isActive?: boolean };

function checkState(code: string) {
  if (!GST_STATE_CODES[code]) throw new UserError(`${code} is not a GST state code`);
}

export async function listDeliveryAddresses() {
  return prisma.deliveryAddress.findMany({ orderBy: [{ isActive: 'desc' }, { label: 'asc' }] });
}

export async function saveDeliveryAddress(ctx: AuditContext, id: string | null, input: DeliveryAddressInput) {
  checkState(input.stateCode);
  const data = { label: input.label.trim(), address: input.address.trim(), stateCode: input.stateCode, isActive: input.isActive ?? true };
  if (await prisma.deliveryAddress.findFirst({ where: { label: data.label, ...(id ? { id: { not: id } } : {}) } })) {
    throw new UserError(`There is already a delivery address called ${data.label}`);
  }
  return withAudit(ctx, (tx) => (id ? tx.deliveryAddress.update({ where: { id }, data }) : tx.deliveryAddress.create({ data })));
}

export type PurchaseItemInput = { name: string; hsnSac?: string | null; unit?: string; defaultGstRate?: string | null; preferredVendorId?: string | null; isArchived?: boolean };

export async function listPurchaseItems(q?: string) {
  const items = await prisma.purchaseItem.findMany({
    where: { isArchived: false, ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}) },
    orderBy: { name: 'asc' },
    take: 200,
  });
  return items.map((i) => ({ ...i, defaultGstRate: i.defaultGstRate?.toFixed(2) ?? null, lastRate: i.lastRate?.toString() ?? null }));
}

export async function savePurchaseItem(ctx: AuditContext, id: string | null, input: PurchaseItemInput) {
  const data = {
    name: input.name.trim(),
    hsnSac: input.hsnSac?.trim() || null,
    unit: input.unit?.trim() || 'Nos',
    defaultGstRate: input.defaultGstRate ? new Decimal(input.defaultGstRate) : null,
    preferredVendorId: input.preferredVendorId || null,
    isArchived: input.isArchived ?? false,
  };
  if (await prisma.purchaseItem.findFirst({ where: { name: { equals: data.name, mode: 'insensitive' }, ...(id ? { id: { not: id } } : {}) } })) {
    throw new UserError(`${data.name} is already in the catalogue`);
  }
  return withAudit(ctx, (tx) => (id ? tx.purchaseItem.update({ where: { id }, data }) : tx.purchaseItem.create({ data })));
}

// ---------- PO form ----------

export type PoLineInput = { purchaseItemId?: string | null; description: string; hsnSac?: string | null; qty: string; unit?: string; rate: string; discount?: string; gstRate: string };
export type PoInput = {
  vendorId: string;
  poDate: string;
  expectedDeliveryDate?: string | null;
  deliveryAddressId?: string | null;
  deliveryAddress?: string | null;
  placeOfSupplyState?: string | null;
  quoteRef?: string | null;
  paymentTermId?: string | null;
  paymentTermsText?: string | null;
  milestones?: { label: string; percent: string }[];
  termsText?: string | null;
  notes?: string | null;
  lines: PoLineInput[];
};

const text = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

async function gstRatesOn(date: string): Promise<Set<string>> {
  const d = parseDate(date);
  const rates = await prisma.gstRate.findMany({ where: { effectiveFrom: { lte: d }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: d } }] } });
  return new Set(rates.map((r) => r.rate.toFixed(2)));
}

/** Validates the form and works out GST and totals (BR-20, BR-21). */
async function poData(input: PoInput) {
  const vendor = await prisma.vendor.findUnique({ where: { id: input.vendorId } });
  if (!vendor) throw new UserError('Vendor not found', 404);
  if (vendor.status === 'blocked') throw new UserError(`${vendor.displayName} is blocked: no new POs (${vendor.statusReason ?? 'see the vendor page'})`);
  if (vendor.isArchived) throw new UserError(`${vendor.displayName} is archived`);
  parseDate(input.poDate, 'PO date');

  let deliveryAddress = text(input.deliveryAddress);
  let placeOfSupplyState = text(input.placeOfSupplyState);
  if (input.deliveryAddressId) {
    const a = await prisma.deliveryAddress.findUnique({ where: { id: input.deliveryAddressId } });
    if (!a) throw new UserError('Delivery address not found');
    deliveryAddress = a.address;
    placeOfSupplyState = a.stateCode;
  }
  if (!deliveryAddress) throw new UserError('Add a delivery address');
  if (!placeOfSupplyState) throw new UserError('Choose the delivery state (place of supply)');
  checkState(placeOfSupplyState);

  const milestones = (input.milestones ?? []).filter((m) => m.label.trim() || m.percent.trim());
  if (milestones.length) {
    let total = new Decimal(0);
    for (const m of milestones) {
      if (!m.label.trim()) throw new UserError('Every payment milestone needs a label, e.g. "advance"');
      if (!/^\d{1,3}(\.\d{1,2})?$/.test(m.percent) || new Decimal(m.percent).lessThanOrEqualTo(0)) throw new UserError(`Milestone "${m.label}" needs a percentage above 0`);
      total = total.plus(m.percent);
    }
    if (!total.equals(100)) throw new UserError(`Payment milestones add up to ${total.toString()}%; they must add up to 100%`);
  }

  if (!input.lines.length) throw new UserError('Add at least one line');
  const mode: GstMode = gstMode({ supplierState: vendor.stateCode, placeOfSupply: placeOfSupplyState, supplierRegistered: vendor.gstRegistered });
  const rates = await gstRatesOn(input.poDate);
  const lines = input.lines.map((l, i) => {
    if (!l.description.trim()) throw new UserError(`Line ${i + 1} needs a description`);
    const gstRate = mode === 'none' ? '0' : l.gstRate;
    if (mode !== 'none' && !rates.has(new Decimal(gstRate || '0').toFixed(2))) {
      throw new UserError(`Line ${i + 1}: ${gstRate}% is not a GST rate in force on ${input.poDate} (Settings > GST rates)`);
    }
    const a = computeLine({ qty: l.qty, rate: l.rate, discount: l.discount ?? '0', gstRate, mode });
    return {
      lineNo: i + 1,
      purchaseItemId: l.purchaseItemId || null,
      description: l.description.trim(),
      hsnSac: text(l.hsnSac),
      qty: new Decimal(l.qty.replace(/,/g, '')),
      unit: text(l.unit) ?? 'Nos',
      rate: new Decimal(l.rate.replace(/,/g, '')),
      discount: new Decimal((l.discount || '0').replace(/,/g, '')),
      gstRate: new Decimal(gstRate || '0'),
      ...a,
    };
  });
  const t = documentTotals(lines);
  return {
    vendor,
    header: {
      vendorId: vendor.id,
      poDate: parseDate(input.poDate),
      expectedDeliveryDate: parseOptionalDate(input.expectedDeliveryDate, 'Expected delivery date'),
      deliveryAddressId: input.deliveryAddressId || null,
      deliveryAddress,
      placeOfSupplyState,
      gstMode: mode,
      quoteRef: text(input.quoteRef),
      paymentTermId: input.paymentTermId || null,
      paymentTermsText: text(input.paymentTermsText),
      milestones: milestones.map((m) => ({ label: m.label.trim(), percent: m.percent })),
      termsText: text(input.termsText),
      notes: text(input.notes),
      taxable: t.taxable, cgst: t.cgst, sgst: t.sgst, igst: t.igst, roundOff: t.roundOff, total: t.total,
    },
    lines,
  };
}

async function replaceLines(tx: Tx, poId: string, lines: Awaited<ReturnType<typeof poData>>['lines']) {
  await tx.poLine.updateMany({ where: { poId, isArchived: false }, data: { isArchived: true } });
  for (const l of lines) await tx.poLine.create({ data: { poId, ...l } });
}

/** Form preview: GST and totals worked out by the server, nothing saved. */
export async function previewPo(input: PoInput) {
  const { vendor, header, lines } = await poData(input);
  const warnings: string[] = [];
  if (vendor.status !== 'active') warnings.push(`${vendor.displayName} is ${vendor.status.replace('_', ' ')}; activate the vendor before issuing.`);
  if (header.gstMode === 'none') warnings.push(`${vendor.displayName} is not GST registered, so no GST is charged.`);
  return {
    gstMode: header.gstMode,
    placeOfSupplyState: header.placeOfSupplyState,
    lines: lines.map((l) => ({ taxable: moneyText(l.taxable), tax: moneyText(l.cgst.plus(l.sgst).plus(l.igst)), lineTotal: moneyText(l.lineTotal) })),
    taxable: moneyText(header.taxable), cgst: moneyText(header.cgst), sgst: moneyText(header.sgst), igst: moneyText(header.igst),
    roundOff: moneyText(header.roundOff), total: moneyText(header.total), amountInWords: amountInWords(header.total),
    warnings,
  };
}

export async function createDraft(ctx: AuditContext, input: PoInput) {
  const { header, lines } = await poData(input);
  const company = await getCompany();
  const po = await withAudit({ ...ctx, reason: ctx.reason ?? 'PO drafted' }, async (tx) => {
    const created = await tx.purchaseOrder.create({ data: { entityId: company.id, ...header } });
    await replaceLines(tx, created.id, lines);
    return created;
  });
  return getPo(po.id);
}

async function loadPo(id: string) {
  const po = await prisma.purchaseOrder.findUnique({ where: { id } });
  if (!po) throw new UserError('Purchase order not found', 404);
  return po;
}

export async function updateDraft(ctx: AuditContext, id: string, input: PoInput) {
  const po = await loadPo(id);
  if (po.status !== 'draft') throw new UserError('Only a draft can be edited. Amend an issued PO instead.');
  const { header, lines } = await poData(input);
  await withAudit({ ...ctx, reason: ctx.reason ?? 'PO draft edited' }, async (tx) => {
    await tx.purchaseOrder.update({ where: { id }, data: header });
    await replaceLines(tx, id, lines);
  });
  return getPo(id);
}

// ---------- Issue, approve, send, close, cancel (F044-F048) ----------

function vendorAddress(v: Vendor) {
  return [v.addressLine1, v.addressLine2, [v.city, v.state, v.pincode].filter(Boolean).join(' ')].filter((x) => x && x.trim()).join('\n');
}

/** Freezes vendor and company details as printed (issued documents are immutable). */
async function snapshots(vendorId: string) {
  const v = await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });
  const c = await getCompany();
  return {
    vendorSnapshot: { name: v.legalName ?? v.displayName, address: vendorAddress(v), gstin: v.gstin, pan: v.pan, stateCode: v.stateCode, contact: [v.contactName, v.phone, v.email].filter(Boolean).join(' · ') || null },
    companySnapshot: { legalName: c.legalName, address: c.registeredAddress, gstin: c.gstin, pan: c.pan, cin: c.cin, email: c.email, phone: c.phone, stateCode: c.stateCode },
  };
}

async function approvalBand(tx: Tx, total: Decimal) {
  const bands = await tx.approvalRule.findMany({ where: { appliesTo: 'purchase_order', isEnabled: true } });
  return bands.find((b) => total.greaterThanOrEqualTo(b.amountFrom) && (!b.amountTo || total.lessThanOrEqualTo(b.amountTo))) ?? null;
}

async function assignNumber(tx: Tx, po: PurchaseOrder, ctx: AuditContext) {
  const vendor = await tx.vendor.findUniqueOrThrow({ where: { id: po.vendorId } });
  if (vendor.status !== 'active') throw new UserError(`${vendor.displayName} is not active yet (${vendor.status}). Activate the vendor before issuing a PO.`);
  const poNumber = await takeNumber(tx, po.entityId, 'purchase_order', dateText(po.poDate)!);
  const snap = await snapshots(po.vendorId);
  await tx.purchaseOrder.update({
    where: { id: po.id },
    data: { poNumber, status: 'approved', issuedAt: new Date(), issuedBy: ctx.userId, templateVersion: PO_TEMPLATE_VERSION, ...snap },
  });
  const lines = await tx.poLine.findMany({ where: { poId: po.id, isArchived: false } });
  for (const l of lines) {
    if (l.purchaseItemId) await tx.purchaseItem.update({ where: { id: l.purchaseItemId }, data: { lastRate: l.rate } });
  }
  return poNumber;
}

/**
 * F044. Approvals off (Q9): Issue assigns the number and prints the PDF at once. When a band is
 * switched on, the PO waits for approval first (BR-26).
 */
export async function issue(ctx: AuditContext, id: string) {
  const issued = await withAudit({ ...ctx, reason: ctx.reason ?? 'PO issued' }, async (tx) => {
    const [po] = await tx.$queryRaw<PurchaseOrder[]>`select * from finance."PurchaseOrder" where id = ${id} for update`;
    if (!po) throw new UserError('Purchase order not found', 404);
    if (po.status !== 'draft') throw new UserError(`This PO is ${PO_STATUS_LABEL[po.status].toLowerCase()}, not a draft`);
    const band = await approvalBand(tx, new Decimal(po.total));
    if (band) {
      await tx.purchaseOrder.update({ where: { id }, data: { status: 'pending_approval', approvals: [], issuedBy: ctx.userId } });
      return false;
    }
    await assignNumber(tx, po, ctx);
    return true;
  });
  if (issued) await printPdf(ctx, id);
  return getPo(id);
}

/** BR-26: the requester cannot approve; a two-founder band needs two different approvers. */
export async function approve(ctx: AuditContext, id: string) {
  const done = await withAudit({ ...ctx, reason: ctx.reason ?? 'PO approved' }, async (tx) => {
    const [po] = await tx.$queryRaw<PurchaseOrder[]>`select * from finance."PurchaseOrder" where id = ${id} for update`;
    if (!po || po.status !== 'pending_approval') throw new UserError('This PO is not waiting for approval');
    if (po.issuedBy === ctx.userId) throw new UserError('The person who raised a PO cannot approve it');
    const approvals = (po.approvals as { userId: string; at: string }[]) ?? [];
    if (approvals.some((a) => a.userId === ctx.userId)) throw new UserError('You have already approved this PO');
    const next = [...approvals, { userId: ctx.userId, at: new Date().toISOString() }];
    const band = await approvalBand(tx, new Decimal(po.total));
    await tx.purchaseOrder.update({ where: { id }, data: { approvals: next } });
    if (band && next.length < band.approversRequired) return false;
    await assignNumber(tx, { ...po, approvals: next }, { ...ctx, userId: po.issuedBy ?? ctx.userId });
    return true;
  });
  if (done) await printPdf(ctx, id);
  return getPo(id);
}

export async function reject(ctx: AuditContext, id: string) {
  if (!ctx.reason?.trim()) throw new UserError('Say why the PO is sent back');
  const po = await loadPo(id);
  if (po.status !== 'pending_approval') throw new UserError('This PO is not waiting for approval');
  await withAudit(ctx, (tx) => tx.purchaseOrder.update({ where: { id }, data: { status: 'draft', approvals: [], statusReason: ctx.reason } }));
  return getPo(id);
}

const SENT_VIA = ['email', 'whatsapp', 'download', 'other'] as const;
export type SentVia = (typeof SENT_VIA)[number];

/** F045: logs that the PO went to the vendor (email from the app comes with a mail account, D14). */
export async function markSent(ctx: AuditContext, id: string, via: SentVia) {
  if (!SENT_VIA.includes(via)) throw new UserError('Unknown way of sending');
  const po = await loadPo(id);
  if (!po.poNumber || ['closed', 'cancelled'].includes(po.status)) throw new UserError('Only an issued, open PO can be sent');
  await withAudit({ ...ctx, reason: ctx.reason ?? `PO sent by ${via}` }, async (tx) => {
    await tx.purchaseOrder.update({ where: { id }, data: { sentAt: new Date(), sentVia: via } });
    await refreshPoStatus(tx, id);
  });
  return getPo(id);
}

/** F048 short-close: no new bills can link. Reason required. */
export async function close(ctx: AuditContext, id: string) {
  if (!ctx.reason?.trim()) throw new UserError('Say why the PO is closed (e.g. "short-closed, balance not needed")');
  const po = await loadPo(id);
  if (!po.poNumber || ['closed', 'cancelled'].includes(po.status)) throw new UserError('Only an issued, open PO can be closed');
  await withAudit(ctx, (tx) => tx.purchaseOrder.update({ where: { id }, data: { status: 'closed', statusReason: ctx.reason, closedAt: new Date() } }));
  return getPo(id);
}

/** F048 cancel: only if nothing is billed or paid. The number stays visible (BR-30). */
export async function cancel(ctx: AuditContext, id: string) {
  if (!ctx.reason?.trim()) throw new UserError('Say why the PO is cancelled');
  const po = await loadPo(id);
  if (['closed', 'cancelled'].includes(po.status)) throw new UserError('This PO is already closed or cancelled');
  if (!po.billedTaxable.isZero() || !po.paidTotal.isZero() || !po.advanceTotal.isZero()) {
    throw new UserError('Something is already billed or paid against this PO; close it instead of cancelling');
  }
  await withAudit(ctx, (tx) => tx.purchaseOrder.update({ where: { id }, data: { status: 'cancelled', statusReason: ctx.reason, closedAt: new Date() } }));
  return getPo(id);
}

/**
 * F046 amendment: changes lines, dates or terms of an issued PO. The PO keeps its number, the
 * revision goes up (R1, R2...), the previous version is kept with the reason and a new PDF is
 * printed. The vendor cannot change; the value cannot drop below what is already billed.
 */
export async function amend(ctx: AuditContext, id: string, input: PoInput) {
  if (!ctx.reason?.trim()) throw new UserError('Say what changed and why');
  const po = await getPo(id);
  if (!['approved', 'sent', 'partially_billed'].includes(po.status)) throw new UserError(`A ${po.statusLabel.toLowerCase()} PO cannot be amended`);
  if (input.vendorId !== po.vendorId) throw new UserError('The vendor of an issued PO cannot change; cancel it and raise a new one');
  const { header, lines } = await poData(input);
  if (header.taxable.lessThan(po.billedTaxable ?? '0')) throw new UserError(`The PO value cannot drop below what is already billed (${po.billedTaxable})`);
  await withAudit(ctx, async (tx) => {
    await tx.$queryRaw`select set_config('finance.po_amend', 'on', true)`;
    await tx.poRevision.create({ data: { poId: id, revisionNo: po.revisionNo, reason: ctx.reason!, before: po as unknown as Prisma.InputJsonValue } });
    const { vendorSnapshot } = await snapshots(po.vendorId);
    await tx.purchaseOrder.update({ where: { id }, data: { ...header, revisionNo: po.revisionNo + 1, vendorSnapshot } });
    await replaceLines(tx, id, lines);
    await refreshPoStatus(tx, id);
  });
  await printPdf(ctx, id);
  return getPo(id);
}

/** BR-17: billing states follow linked tax invoices. Called whenever a linked document changes. */
export async function refreshPoStatus(tx: Tx, id: string) {
  const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id } });
  if (!['approved', 'sent', 'partially_billed', 'fully_billed'].includes(po.status)) return po.status;
  const lifecycle: PoLifecycle = po.sentAt ? 'sent' : 'approved';
  const status = poBillingStatus({ lifecycle, taxable: po.taxable, billedTaxable: po.billedTaxable });
  if (status !== po.status) await tx.purchaseOrder.update({ where: { id }, data: { status } });
  return status;
}

// ---------- PDF ----------

/** Prints the PO from its frozen details and files it with the PO (replacing the previous print). */
export async function printPdf(ctx: AuditContext, id: string) {
  const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id }, include: { lines: { where: { isArchived: false }, orderBy: { lineNo: 'asc' } } } });
  if (!po.poNumber || !po.vendorSnapshot || !po.companySnapshot) throw new UserError('Only an issued PO has a PDF');
  const term = po.paymentTermId ? await prisma.paymentTerm.findUnique({ where: { id: po.paymentTermId } }) : null;
  const data: PoPdfData = {
    poNumber: po.poNumber,
    poDate: dateText(po.poDate)!,
    revisionNo: po.revisionNo,
    company: po.companySnapshot as PoPdfData['company'],
    vendor: po.vendorSnapshot as PoPdfData['vendor'],
    deliveryAddress: po.deliveryAddress,
    placeOfSupplyState: po.placeOfSupplyState,
    expectedDeliveryDate: dateText(po.expectedDeliveryDate),
    quoteRef: po.quoteRef,
    paymentTerms: [term?.label, po.paymentTermsText].filter(Boolean).join('. ') || null,
    milestones: po.milestones as PoPdfData['milestones'],
    termsText: po.termsText,
    gstMode: po.gstMode,
    lines: po.lines.map((l) => ({
      description: l.description, hsnSac: l.hsnSac, qty: l.qty.toString(), unit: l.unit, rate: l.rate.toFixed(2),
      discount: l.discount.toFixed(2), gstRate: l.gstRate.toString(), taxable: l.taxable.toFixed(2),
      tax: l.cgst.plus(l.sgst).plus(l.igst).toFixed(2), lineTotal: l.lineTotal.toFixed(2),
    })),
    totals: { taxable: po.taxable.toFixed(2), cgst: po.cgst.toFixed(2), sgst: po.sgst.toFixed(2), igst: po.igst.toFixed(2), roundOff: po.roundOff.toFixed(2), total: po.total.toFixed(2) },
  };
  const pdf = await renderPdf(purchaseOrderHtml(data));
  if (po.pdfAttachmentId) await archive({ ...ctx, reason: `Replaced by revision R${po.revisionNo}` }, po.pdfAttachmentId).catch(() => undefined);
  const name = `${po.poNumber.replace(/\//g, '-')}${po.revisionNo ? `-R${po.revisionNo}` : ''}.pdf`;
  const a = await upload({ ...ctx, reason: 'PO printed' }, { recordType: 'PurchaseOrder', recordId: id, docKind: 'po_pdf', fileName: name, contentBase64: pdf.toString('base64') });
  await withAudit({ ...ctx, reason: 'PO printed' }, (tx) => tx.purchaseOrder.update({ where: { id }, data: { pdfAttachmentId: a.id, templateVersion: PO_TEMPLATE_VERSION } }));
  return a;
}

// ---------- Views (F040, F045-F047) ----------

function lineView(l: PoLine) {
  return {
    id: l.id, lineNo: l.lineNo, purchaseItemId: l.purchaseItemId, description: l.description, hsnSac: l.hsnSac,
    qty: l.qty.toString(), unit: l.unit, rate: l.rate.toString(), discount: moneyText(l.discount), gstRate: l.gstRate.toString(),
    taxable: moneyText(l.taxable), cgst: moneyText(l.cgst), sgst: moneyText(l.sgst), igst: moneyText(l.igst), tax: moneyText(l.cgst.plus(l.sgst).plus(l.igst)), lineTotal: moneyText(l.lineTotal),
    qtyBilled: l.qtyBilled.toString(),
  };
}

function poSummary(po: PurchaseOrder & { vendor: Vendor }) {
  return {
    id: po.id,
    poNumber: po.poNumber,
    poDate: dateText(po.poDate),
    vendorId: po.vendorId,
    vendorName: po.vendor.displayName,
    vendorGstin: po.vendor.gstin,
    status: po.status,
    statusLabel: PO_STATUS_LABEL[po.status],
    revisionNo: po.revisionNo,
    taxable: moneyText(po.taxable),
    total: moneyText(po.total),
    billedTaxable: moneyText(po.billedTaxable),
    paidTotal: moneyText(po.paidTotal),
    balanceToBill: moneyText(Decimal.max(po.taxable.minus(po.billedTaxable), 0)),
    pdfAttachmentId: po.pdfAttachmentId,
    expectedDeliveryDate: dateText(po.expectedDeliveryDate),
  };
}

export async function listPos(filter: { status?: string; vendorId?: string; q?: string; open?: boolean } = {}) {
  const where: Prisma.PurchaseOrderWhereInput = {
    ...(filter.status ? { status: filter.status as PoStatus } : {}),
    ...(filter.open ? { status: { in: OPEN_FOR_BILLS } } : {}),
    ...(filter.vendorId ? { vendorId: filter.vendorId } : {}),
    ...(filter.q ? { OR: [{ poNumber: { contains: filter.q, mode: 'insensitive' } }, { vendor: { displayName: { contains: filter.q, mode: 'insensitive' } } }, { quoteRef: { contains: filter.q, mode: 'insensitive' } }] } : {}),
  };
  const rows = await prisma.purchaseOrder.findMany({ where, include: { vendor: true }, orderBy: [{ poDate: 'desc' }, { createdAt: 'desc' }], take: 500 });
  const sumOf = (k: 'taxable' | 'total' | 'billedTaxable' | 'paidTotal') => moneyText(rows.filter((r) => r.status !== 'cancelled').reduce((s, r) => s.plus(r[k]), new Decimal(0)));
  return { rows: rows.map(poSummary), totals: { count: rows.length, taxable: sumOf('taxable'), total: sumOf('total'), billedTaxable: sumOf('billedTaxable'), paidTotal: sumOf('paidTotal') } };
}

export async function getPo(id: string) {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id },
    include: { vendor: true, lines: { where: { isArchived: false }, orderBy: { lineNo: 'asc' } }, revisions: { orderBy: { revisionNo: 'desc' } } },
  });
  if (!po) throw new UserError('Purchase order not found', 404);
  const userIds = [po.issuedBy, ...(po.approvals as { userId: string }[]).map((a) => a.userId), ...po.revisions.map((r) => r.createdBy)].filter(Boolean) as string[];
  const users = new Map((await prisma.user.findMany({ where: { id: { in: userIds } } })).map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));
  const bankChangedRecently = bankRecentlyChanged(await prisma.vendorBankAccount.findMany({ where: { vendorId: po.vendorId } }));
  return {
    ...poSummary(po),
    vendorStatus: po.vendor.status,
    vendorStateCode: po.vendor.stateCode,
    deliveryAddressId: po.deliveryAddressId,
    deliveryAddress: po.deliveryAddress,
    placeOfSupplyState: po.placeOfSupplyState,
    gstMode: po.gstMode,
    quoteRef: po.quoteRef,
    paymentTermId: po.paymentTermId,
    paymentTermsText: po.paymentTermsText,
    milestones: po.milestones as { label: string; percent: string }[],
    termsText: po.termsText,
    notes: po.notes,
    cgst: moneyText(po.cgst), sgst: moneyText(po.sgst), igst: moneyText(po.igst), roundOff: moneyText(po.roundOff),
    amountInWords: amountInWords(po.total),
    billedTotal: moneyText(po.billedTotal),
    advanceTotal: moneyText(po.advanceTotal),
    statusReason: po.statusReason,
    issuedAt: po.issuedAt,
    issuedBy: po.issuedBy ? users.get(po.issuedBy) ?? po.issuedBy : null,
    approvals: (po.approvals as { userId: string; at: string }[]).map((a) => ({ name: users.get(a.userId) ?? a.userId, at: a.at })),
    sentAt: po.sentAt,
    sentVia: po.sentVia,
    templateVersion: po.templateVersion,
    vendorBankChangedRecently: !!bankChangedRecently,
    lines: po.lines.map(lineView),
    revisions: po.revisions.map((r) => ({ revisionNo: r.revisionNo, reason: r.reason, by: r.createdBy ? users.get(r.createdBy) ?? r.createdBy : null, at: r.createdAt })),
  };
}
