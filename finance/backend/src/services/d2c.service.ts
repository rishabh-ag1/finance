import { prisma } from '../config/database';
import { crmOrder, crmOrderLines, crmOrdersMovedSince, type CrmOrder } from '../crm/reader';
import { deliveries, invProducts } from '../inventory/reader';
import { withAudit, type AuditContext } from '../lib/audit';
import { d2cEligibility, orderInvoiceLines, rtoCreditNeeded } from '../lib/d2cInvoice';
import { dateText, parseDate } from '../lib/dates';
import { todayIST } from '../lib/fy';
import { UserError } from '../lib/http';
import { Decimal } from '../lib/money';
import { createCreditNote, createDoc, getDoc, issueDoc, previewDoc, type DocExtra, type DocInput, type LineInput } from './sales.service';
import { settleOrderInvoices } from './receivables.service';
import { getCompany } from './settings.service';

/**
 * F102 D2C auto-invoicing, F103 RTO credit notes, and the order-to-invoice step the CRM API uses
 * (F105). An order's invoice is built from what the customer paid (BR-48): lines from the CRM order
 * items, HSN from bloc-inv, COD charges as their own line. Finance never writes to the CRM.
 */

/** Invoice lines for a CRM order, and what stops it being invoiced. */
export async function orderLines(o: CrmOrder): Promise<{ lines: LineInput[]; problems: string[] }> {
  const items = await crmOrderLines([o.id]);
  if (!items.length) return { lines: [], problems: ['The order has no lines in the CRM'] };
  const ids = items.map((i) => i.invProductId).filter(Boolean) as string[];
  const products = new Map((await invProducts({ ids })).map((p) => [p.id, p]));
  const problems: string[] = [];
  for (const i of items) if (!i.invProductId || !products.has(i.invProductId)) problems.push(`${i.productName} (${i.sku}) is not linked to a bloc-inv product`);
  const r = orderInvoiceLines(
    items.map((i) => ({ description: i.productName, hsn: (i.invProductId && products.get(i.invProductId)?.hsn) || null, qty: i.qty, priceBeforeTax: i.priceBeforeTax, taxPercent: i.taxPercent, finalAmount: i.finalAmount })),
    o.paymentMethod === 'COD' ? o.codCharges : new Decimal(0),
    o.totalAmount,
  );
  problems.push(...r.problems);
  const lines: LineInput[] = r.lines.map((l, n) => {
    const item = items[n];
    return {
      invProductId: item && products.has(item.invProductId ?? '') ? item.invProductId : null, description: l.description, hsnSac: l.hsn, qty: l.qty,
      rate: l.rate, discount: l.discount, gstRate: l.gstRate, priceSource: `order ${o.orderNumber}`,
    };
  });
  return { lines, problems };
}

/** A draft proforma or tax invoice for a CRM order, priced as the order (F105, F102). */
export async function draftFromOrder(ctx: AuditContext, f: { orderNumber: string; docType: 'proforma' | 'tax_invoice'; docDate?: string | null; salesPerson?: string | null; source: DocExtra['source'] }) {
  const o = await crmOrder(f.orderNumber);
  if (!o) throw new UserError(`Order ${f.orderNumber} is not in the CRM`, 404);
  if (o.paymentMethod === 'FREE' || o.isReplacement) throw new UserError('A replacement or free order is not invoiced');
  if (f.docType === 'tax_invoice') {
    const existing = await prisma.salesDocument.findFirst({ where: { crmOrderNumber: o.orderNumber, docType: 'tax_invoice', status: { in: ['draft', 'issued'] } } });
    if (existing) throw new UserError(existing.status === 'issued' ? `Order ${o.orderNumber} is already invoiced: ${existing.docNumber}` : `Order ${o.orderNumber} already has a draft invoice`, 409);
  }
  const { lines, problems } = await orderLines(o);
  if (!lines.length) throw new UserError(problems.join('; '));
  const input: DocInput = { docType: f.docType, docDate: f.docDate ?? todayIST(), customer: { kind: 'order', orderNumber: o.orderNumber }, salesPerson: f.salesPerson ?? null, lines };
  const doc = await createDoc({ ...ctx, reason: ctx.reason ?? `Drafted from CRM order ${o.orderNumber}` }, input, { source: f.source });
  return { doc, orderProblems: problems };
}

// ---------- Settings ----------

async function setting() {
  const company = await getCompany();
  return (await prisma.d2cInvoiceSetting.findUnique({ where: { entityId: company.id } })) ?? { id: null, entityId: company.id, isOn: false, startFrom: null, runAsUserId: null, lastRunAt: null, lastRunSummary: null };
}

export async function getD2cSetting() {
  const s = await setting();
  const series = await prisma.numberSeries.findFirst({ where: { docType: 'tax_invoice' }, orderBy: { createdAt: 'desc' } });
  return { isOn: s.isOn, startFrom: dateText(s.startFrom), lastRunAt: s.lastRunAt, lastRunSummary: s.lastRunSummary, seriesOn: !!series?.isActive };
}

export async function saveD2cSetting(ctx: AuditContext, input: { isOn: boolean; startFrom: string | null }) {
  if (input.isOn && !input.startFrom) throw new UserError('Choose the first ship date to invoice: orders shipped before it are left alone');
  const startFrom = input.startFrom ? parseDate(input.startFrom, 'Start from') : null;
  const company = await getCompany();
  await withAudit({ ...ctx, reason: ctx.reason ?? (input.isOn ? 'D2C auto-invoicing switched on' : 'D2C auto-invoicing switched off') }, (tx) =>
    tx.d2cInvoiceSetting.upsert({
      where: { entityId: company.id },
      create: { entityId: company.id, isOn: input.isOn, startFrom, runAsUserId: ctx.userId },
      update: { isOn: input.isOn, startFrom, runAsUserId: ctx.userId },
    }));
  return getD2cSetting();
}

// ---------- The batch (F102, F103) ----------

export type BatchSummary = { checked: number; invoiced: number; fixList: number; creditNotes: number; note: string | null };
let running = false;

async function mark(ctx: AuditContext, orderNumber: string, data: { state: 'invoiced' | 'fix'; problems?: string[]; invoiceId?: string | null; creditNoteId?: string | null }) {
  // Not an upsert: Postgres checks the row's rules on the insert half of INSERT ... ON CONFLICT too.
  await withAudit(ctx, async (tx) => {
    const row = await tx.d2cOrderInvoice.findUnique({ where: { orderNumber } });
    if (!row) return tx.d2cOrderInvoice.create({ data: { orderNumber, state: data.state, problems: data.problems ?? [], invoiceId: data.invoiceId ?? null, creditNoteId: data.creditNoteId ?? null } });
    return tx.d2cOrderInvoice.update({
      where: { orderNumber },
      data: { state: data.state, problems: data.problems ?? [], ...(data.invoiceId !== undefined ? { invoiceId: data.invoiceId } : {}), ...(data.creditNoteId !== undefined ? { creditNoteId: data.creditNoteId } : {}), lastCheckedAt: new Date() },
    });
  });
}

/** One order through the batch: invoice it when shipped, credit it when it comes back. */
async function handleOrder(ctx: AuditContext, o: CrmOrder, shippedByInv: string | null, startFrom: string, sum: BatchSummary) {
  const row = await prisma.d2cOrderInvoice.findUnique({ where: { orderNumber: o.orderNumber } });
  const existing = await prisma.salesDocument.findFirst({ where: { crmOrderNumber: o.orderNumber, docType: 'tax_invoice', status: { in: ['draft', 'issued'] } }, orderBy: { createdAt: 'desc' } });

  // F103: invoiced, then RTO'd or cancelled after dispatch: one credit note draft for review.
  if (existing?.status === 'issued') {
    if (row?.state !== 'invoiced' || row.invoiceId !== existing.id) await mark(ctx, o.orderNumber, { state: 'invoiced', invoiceId: existing.id });
    const credits = await prisma.salesDocument.count({ where: { againstInvoiceId: existing.id, docType: 'credit_note', status: { in: ['draft', 'issued'] } } });
    if (!rtoCreditNeeded({ status: o.status }, { invoiceIssued: true, creditNotes: credits })) return;
    const inv = await getDoc(existing.id);
    const back = [o.returnedAt, o.cancelledAt, todayIST()].filter(Boolean).sort()[0]!;
    const invDate = dateText(existing.docDate)!;
    const date = back < invDate ? invDate : back > todayIST() ? todayIST() : back;
    try {
      const cn = await createCreditNote({ ...ctx, reason: `Order ${o.orderNumber} ${o.status === 'RETURNED' ? 'returned (RTO)' : 'cancelled after dispatch'}` }, existing.id, {
        docDate: date, creditReason: 'rto', notes: `Order ${o.orderNumber} ${o.status === 'RETURNED' ? 'returned to origin' : 'cancelled after dispatch'}. Review and issue.`,
        lines: inv.lines.map((l: { id: string; qty: string }) => ({ sourceLineId: l.id, qty: l.qty })),
      }, { source: 'rto' });
      await mark(ctx, o.orderNumber, { state: 'invoiced', creditNoteId: cn.id });
      sum.creditNotes += 1;
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      await mark(ctx, o.orderNumber, { state: 'fix', problems: [`Credit note for the RTO not drafted: ${e.message}`] });
      sum.fixList += 1;
    }
    return;
  }

  const ok = d2cEligibility(o, { shippedAt: shippedByInv }, startFrom);
  if (!ok.eligible) return;
  sum.checked += 1;
  const fail = async (problems: string[], invoiceId?: string | null) => {
    await mark(ctx, o.orderNumber, { state: 'fix', problems, ...(invoiceId !== undefined ? { invoiceId } : {}) });
    sum.fixList += 1;
  };
  try {
    let docId = existing?.id ?? null;
    if (existing && existing.source !== 'd2c_batch') return fail(['A draft invoice for this order was made by hand: issue or discard it'], existing.id);
    if (!docId) {
      const { lines, problems } = await orderLines(o);
      if (problems.length) return fail(problems);
      const input: DocInput = { docType: 'tax_invoice', docDate: ok.invoiceDate!, customer: { kind: 'order', orderNumber: o.orderNumber }, lines };
      const preview = await previewDoc(input);
      if (preview.problems.length) return fail(preview.problems);
      const doc = await createDoc({ ...ctx, reason: `D2C order ${o.orderNumber} shipped ${ok.invoiceDate}` }, input, { source: 'd2c_batch' });
      docId = doc.id;
    }
    try {
      await issueDoc({ ...ctx, reason: `D2C order ${o.orderNumber} shipped ${ok.invoiceDate}` }, docId);
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      return fail([e.message], docId);
    }
    await mark(ctx, o.orderNumber, { state: 'invoiced', invoiceId: docId, problems: [] });
    sum.invoiced += 1;
  } catch (e) {
    if (e instanceof UserError) return fail([e.message]);
    const msg = (e instanceof Error ? e.message : String(e)).match(/finance: ([^"\\\n]+)/)?.[1];
    if (msg) return fail([msg.charAt(0).toUpperCase() + msg.slice(1)]);
    throw e;
  }
}

/** F102: invoice every D2C order shipped since the start date; failures go to the fix-list, the batch goes on. */
export async function runD2cBatch(ctx: AuditContext | null, opts: { orderNumbers?: string[] } = {}): Promise<BatchSummary> {
  const s = await setting();
  const sum: BatchSummary = { checked: 0, invoiced: 0, fixList: 0, creditNotes: 0, note: null };
  const actor = ctx ?? (s.runAsUserId ? { userId: s.runAsUserId, reason: 'D2C batch' } : null);
  if (!s.isOn || !s.startFrom || !actor) { sum.note = 'D2C auto-invoicing is switched off'; return sum; }
  const series = await prisma.numberSeries.findFirst({ where: { docType: 'tax_invoice' }, orderBy: { createdAt: 'desc' } });
  if (!series?.isActive) { sum.note = 'The tax invoice series is switched off in Settings > Numbering: nothing was issued'; return sum; }
  if (running) { sum.note = 'The batch is already running'; return sum; }
  running = true;
  try {
    const startFrom = dateText(s.startFrom)!;
    let orders = await crmOrdersMovedSince(startFrom);
    if (opts.orderNumbers) orders = orders.filter((o) => opts.orderNumbers!.includes(o.orderNumber));
    const inv = new Map((await deliveries({ orderNumbers: orders.map((o) => o.orderNumber) })).map((d) => [d.orderNumber, d.shippedAt]));
    for (const o of orders) await handleOrder(actor, o, inv.get(o.orderNumber) ?? null, startFrom, sum);
    if (sum.invoiced) await settleOrderInvoices({ userId: actor.userId, reason: 'Order payments applied to new D2C invoices' });
    if (!opts.orderNumbers && s.id) {
      await withAudit({ ...actor, reason: 'D2C batch run' }, (tx) => tx.d2cInvoiceSetting.update({ where: { id: s.id! }, data: { lastRunAt: new Date(), lastRunSummary: sum } }));
    }
    return sum;
  } finally {
    running = false;
  }
}

/** The fix-list (F102) and the orders the batch has invoiced lately. */
export async function d2cOverview() {
  const rows = await prisma.d2cOrderInvoice.findMany({ orderBy: { updatedAt: 'desc' }, take: 300 });
  const docIds = rows.flatMap((r) => [r.invoiceId, r.creditNoteId]).filter(Boolean) as string[];
  const docs = new Map((await prisma.salesDocument.findMany({ where: { id: { in: docIds } }, select: { id: true, docNumber: true, status: true, total: true, docDate: true, docType: true } })).map((d) => [d.id, d]));
  const view = (id: string | null) => {
    const d = id ? docs.get(id) : null;
    return d ? { id: d.id, docNumber: d.docNumber, status: d.status, total: d.total.toFixed(2), docDate: dateText(d.docDate) } : null;
  };
  return {
    setting: await getD2cSetting(),
    fixList: rows.filter((r) => r.state === 'fix').map((r) => ({ orderNumber: r.orderNumber, problems: r.problems, since: r.createdAt, lastCheckedAt: r.lastCheckedAt, invoice: view(r.invoiceId) })),
    invoiced: rows.filter((r) => r.state === 'invoiced').slice(0, 100).map((r) => ({ orderNumber: r.orderNumber, invoice: view(r.invoiceId), creditNote: view(r.creditNoteId), lastCheckedAt: r.lastCheckedAt })),
  };
}

/** Try one order again after its problem was fixed in the CRM or bloc-inv. */
export async function retryOrder(ctx: AuditContext, orderNumber: string) {
  const s = await setting();
  if (!s.isOn) throw new UserError('Switch D2C auto-invoicing on first');
  const sum = await runD2cBatch(ctx, { orderNumbers: [orderNumber] });
  if (sum.note) throw new UserError(sum.note);
  const row = await prisma.d2cOrderInvoice.findUnique({ where: { orderNumber } });
  return { summary: sum, state: row?.state ?? null, problems: row?.problems ?? [] };
}

let timer: NodeJS.Timeout | null = null;
/** Runs the batch every half hour while the server is up (only does anything when switched on). */
export function startD2cTimer(everyMs = 30 * 60_000) {
  if (timer) return;
  timer = setInterval(() => { runD2cBatch(null).catch((e) => console.error('D2C batch failed:', e)); }, everyMs);
  timer.unref();
}
