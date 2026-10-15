import type { GatewayPayment, ReconDiscrepancy, SettlementBatch, SettlementLine } from '@prisma/client';
import { prisma } from '../config/database';
import { crmOrder, crmOrders, crmReaderMode, type CrmOrder } from '../crm/reader';
import { deliveries, inventoryReaderMode, type Delivery } from '../inventory/reader';
import { withAudit, type AuditContext, type Tx } from '../lib/audit';
import { dateText, parseDate } from '../lib/dates';
import { todayIST } from '../lib/fy';
import { UserError } from '../lib/http';
import { Decimal, moneyText } from '../lib/money';
import { readTableFile } from '../lib/tableFile';
import { addWorkingDays } from '../lib/workingDays';
import { batchChecks, DISCREPANCY_LABEL, orderChecks, type Finding } from '../recon/checks';
import { parseRazorpayTable, parseShiprocketTable, type SettlementIn } from '../recon/files';
import { IN_TRANSIT, ORDER_STATUS_LABEL, ROUTE_LABEL, orderPaymentStatus, type Collections, type OrderFacts, type OrderStatusCode, type Route } from '../recon/status';
import { tieOut } from '../recon/tieOut';
import { upload } from './attachment.service';
import { settleOrderInvoices } from './receivables.service';
import { daysToBank, funnelByMonth, type FunnelRow } from '../recon/funnel';
import {
  batchCandidates, linkBatchRow, linkLinesToOrders, linkOrderRow, linkPaymentsToOrders, matchBatches, reconRules, reconSetting, routeOf, unlinkBankRow, type Rules,
} from './reconMatch.service';
import { getCompany } from './settings.service';

/**
 * M18 Order-to-bank (F190-F199). Orders come from the CRM reader, delivery facts from the
 * Inventory reader; Finance imports Razorpay and Shiprocket reports, links them to orders and to
 * bank credits, works out each order's status (BR-44, BR-45), ties settlements out (BR-47) and keeps
 * a queue of discrepancies (BR-46). Statuses are never stored; discrepancies are, so they can be
 * resolved with a note.
 */

const DAY = 86_400_000;
const shift = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const zero = () => new Decimal(0);
const sum = (xs: Decimal[]) => xs.reduce((s, x) => s.plus(x), zero());
const text = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
/** How far back the queue and money in transit look (and never before Settings > Track from). */
const WINDOW_DAYS = 180;

export const RESOLUTIONS = ['chase_razorpay', 'chase_shiprocket', 'refunded', 'written_off', 'crm_corrected', 'linked_by_hand', 'other'] as const;
export const RESOLUTION_LABEL: Record<(typeof RESOLUTIONS)[number], string> = {
  chase_razorpay: 'Chased Razorpay', chase_shiprocket: 'Chased Shiprocket', refunded: 'Refunded the customer', written_off: 'Written off',
  crm_corrected: 'CRM order corrected', linked_by_hand: 'Linked by hand', other: 'Other',
};

async function windowStart(days = WINDOW_DAYS) {
  const s = await reconSetting();
  const from = shift(todayIST(), -days);
  const track = s.trackFrom ? dateText(s.trackFrom)! : null;
  return track && track > from ? track : from;
}

// ---------- Imports (F192, F193) ----------

export type ImportInput = { source: 'razorpay' | 'shiprocket_cod'; fileName: string; contentBase64: string };

async function saveBatch(tx: Tx, entityId: string, importId: string, s: SettlementIn) {
  const d = (v: string) => new Decimal(v);
  const batch = await tx.settlementBatch.create({
    data: {
      entityId, source: s.source, externalId: s.externalId, utr: s.utr, settledOn: parseDate(s.settledOn), gross: d(s.gross), fees: d(s.fees),
      taxOnFees: d(s.taxOnFees), refunds: d(s.refunds), adjustments: d(s.adjustments), net: d(s.net), importId,
    },
  });
  await tx.settlementLine.createMany({
    data: s.lines.map((l) => ({
      batchId: batch.id, type: l.type, externalId: l.externalId, paymentId: l.paymentId, awb: l.awb, gross: d(l.gross), fee: d(l.fee), taxOnFee: d(l.taxOnFee),
      refund: d(l.refund), adjustment: d(l.adjustment), net: d(l.net), reference: l.reference, happenedOn: l.happenedOn ? parseDate(l.happenedOn) : null,
    })),
  });
  // A settlement names its payments: those not imported from the Payments report are added from it.
  for (const l of s.lines.filter((x) => x.type === 'payment')) {
    const known = await tx.gatewayPayment.findUnique({ where: { externalId: l.externalId } });
    if (!known) {
      await tx.gatewayPayment.create({
        data: { entityId, externalId: l.externalId, amount: d(l.gross), fee: d(l.fee), taxOnFee: d(l.taxOnFee), status: 'captured', capturedOn: parseDate(l.happenedOn ?? s.settledOn), reference: l.reference, importId },
      });
    }
  }
  for (const l of s.lines.filter((x) => x.type === 'refund' && x.paymentId)) {
    const p = await tx.gatewayPayment.findUnique({ where: { externalId: l.paymentId! } });
    if (p) {
      const refunded = Decimal.min(p.amount, p.refunded.plus(d(l.refund)));
      await tx.gatewayPayment.update({ where: { id: p.id }, data: { refunded, status: refunded.equals(p.amount) ? 'refunded' : p.status } });
    }
  }
}

/** Reads the file, keeps what is new (same ids are left as they were), links, matches and re-checks. */
export async function importReport(ctx: AuditContext, input: ImportInput) {
  const table = await readTableFile(input.fileName, Buffer.from(input.contentBase64, 'base64'));
  const company = await getCompany();
  const r = await reconRules();
  let summary: { kind: string; rows: number; added: number; repeated: number; skipped: number };
  const importId = await withAudit({ ...ctx, reason: ctx.reason ?? `${input.source === 'razorpay' ? 'Razorpay' : 'Shiprocket'} report imported` }, async (tx) => {
    const imp = await tx.reconImport.create({ data: { entityId: company.id, source: input.source, kind: 'pending', fileName: input.fileName, rows: 0, added: 0, repeated: 0, skipped: 0 } });
    if (input.source === 'razorpay') {
      const parsed = parseRazorpayTable(table);
      if (parsed.kind === 'payments') {
        let added = 0; let repeated = 0;
        for (const p of parsed.payments) {
          const known = await tx.gatewayPayment.findUnique({ where: { externalId: p.externalId } });
          if (known) {
            repeated += 1;
            // Status and refunds move on later reports; the captured amount and date never do.
            if (known.status !== p.status || !known.refunded.equals(p.refunded) || (!known.reference && p.reference)) {
              await tx.gatewayPayment.update({ where: { id: known.id }, data: { status: p.status, refunded: new Decimal(p.refunded), reference: known.reference || p.reference, contact: known.contact ?? p.contact, method: known.method ?? p.method, externalOrderId: known.externalOrderId ?? p.externalOrderId } });
            }
            continue;
          }
          await tx.gatewayPayment.create({
            data: {
              entityId: company.id, externalId: p.externalId, externalOrderId: p.externalOrderId, method: p.method, amount: new Decimal(p.amount), fee: new Decimal(p.fee),
              taxOnFee: new Decimal(p.taxOnFee), refunded: new Decimal(p.refunded), status: p.status, capturedOn: parseDate(p.capturedOn), reference: p.reference, contact: p.contact, importId: imp.id,
            },
          });
          added += 1;
        }
        summary = { kind: 'payments', rows: parsed.payments.length + parsed.skipped, added, repeated, skipped: parsed.skipped };
      } else {
        summary = await saveBatches(tx, company.id, imp.id, parsed.settlements, 'settlements');
      }
    } else {
      summary = await saveBatches(tx, company.id, imp.id, parseShiprocketTable(table), 'remittances');
    }
    await tx.reconImport.update({ where: { id: imp.id }, data: summary });
    await linkPaymentsToOrders(tx);
    await linkLinesToOrders(tx);
    await matchBatches(tx, r);
    return imp.id;
  }, { timeoutMs: 120_000 });
  try {
    await upload(ctx, { recordType: 'ReconImport', recordId: importId, docKind: 'statement', fileName: input.fileName, contentBase64: input.contentBase64 });
  } catch (error) {
    console.error('Report file not stored:', error);
  }
  await refreshDiscrepancies(ctx);
  return { id: importId, ...summary! };
}

async function saveBatches(tx: Tx, entityId: string, importId: string, batches: SettlementIn[], kind: string) {
  let added = 0; let repeated = 0;
  for (const s of batches) {
    const known = await tx.settlementBatch.findUnique({ where: { source_externalId: { source: s.source, externalId: s.externalId } } });
    if (known) { repeated += 1; continue; }
    await saveBatch(tx, entityId, importId, s);
    added += 1;
  }
  return { kind, rows: batches.reduce((n, b) => n + b.lines.length, 0), added, repeated, skipped: 0 };
}

export async function listImports() {
  const rows = await prisma.reconImport.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
  return rows.map((i) => ({ id: i.id, source: i.source, kind: i.kind, fileName: i.fileName, rows: i.rows, added: i.added, repeated: i.repeated, skipped: i.skipped, createdAt: i.createdAt }));
}

// ---------- Order states (BR-44, BR-45) ----------

type Linked = {
  payments: (GatewayPayment & { batch: (SettlementBatch & { bankDate: string | null }) | null })[];
  cod: (SettlementLine & { batch: SettlementBatch & { bankDate: string | null } })[];
  direct: { id: string; amount: Decimal; bankTxnId: string; bankDate: string; matchedBy: string }[];
  writeOff: { amount: Decimal; reason: string } | null;
};

/** Everything Finance holds for these orders, keyed by order number. */
async function linkedFor(orderNumbers: string[]) {
  const [payments, links, offs] = await Promise.all([
    prisma.gatewayPayment.findMany({ where: { orderNumber: { in: orderNumbers } }, orderBy: { capturedOn: 'asc' } }),
    prisma.orderBankLink.findMany({ where: { orderNumber: { in: orderNumbers }, isArchived: false } }),
    prisma.orderWriteOff.findMany({ where: { orderNumber: { in: orderNumbers }, isArchived: false } }),
  ]);
  const lines = await prisma.settlementLine.findMany({
    where: { OR: [{ type: 'cod', orderNumber: { in: orderNumbers } }, { type: 'payment', paymentId: { in: payments.map((p) => p.externalId) } }] },
    include: { batch: true },
  });
  const txnIds = [...new Set([...lines.map((l) => l.batch.bankTxnId), ...links.map((l) => l.bankTxnId)].filter(Boolean) as string[])];
  const bankDate = new Map((await prisma.bankTxn.findMany({ where: { id: { in: txnIds } }, select: { id: true, txnDate: true } })).map((t) => [t.id, dateText(t.txnDate)!]));
  const withBank = (b: SettlementBatch) => ({ ...b, bankDate: b.bankTxnId ? bankDate.get(b.bankTxnId) ?? null : null });
  const settledBy = new Map(lines.filter((l) => l.type === 'payment' && l.paymentId).map((l) => [l.paymentId!, withBank(l.batch)]));
  const out = new Map<string, Linked>();
  const get = (n: string) => out.get(n) ?? out.set(n, { payments: [], cod: [], direct: [], writeOff: null }).get(n)!;
  for (const p of payments) get(p.orderNumber!).payments.push({ ...p, batch: settledBy.get(p.externalId) ?? null });
  for (const l of lines.filter((x) => x.type === 'cod')) get(l.orderNumber!).cod.push({ ...l, batch: withBank(l.batch) });
  for (const l of links) get(l.orderNumber).direct.push({ id: l.id, amount: l.amount, bankTxnId: l.bankTxnId, bankDate: bankDate.get(l.bankTxnId) ?? '', matchedBy: l.matchedBy });
  for (const w of offs) get(w.orderNumber).writeOff = { amount: w.amount, reason: w.reason };
  return out;
}

function facts(o: CrmOrder, d: Delivery | undefined): OrderFacts {
  return {
    orderNumber: o.orderNumber, orderDate: o.orderDate, channel: o.channel as OrderFacts['channel'], paymentMethod: o.paymentMethod as OrderFacts['paymentMethod'],
    totalAmount: o.totalAmount, advancePaid: o.advancePaid, balanceDue: o.balanceDue, crmStatus: o.status, isReplacement: o.isReplacement,
    codToCollect: d?.codToCollect ?? null, shippedAt: d?.shippedAt ?? o.shippedAt, deliveredAt: d?.deliveredAt ?? o.deliveredAt, awb: d?.awb ?? o.awb,
  };
}

function collections(l: Linked | undefined): Collections {
  return {
    payments: (l?.payments ?? []).map((p) => ({ amount: p.amount, capturedAt: dateText(p.capturedOn)!, refunded: p.refunded, settledBatch: p.batch ? { date: dateText(p.batch.settledOn)!, bankDate: p.batch.bankDate } : null })),
    remittances: (l?.cod ?? []).map((x) => ({ amount: x.gross, batch: { date: dateText(x.batch.settledOn)!, bankDate: x.batch.bankDate } })),
    direct: (l?.direct ?? []).map((x) => ({ amount: x.amount, bankDate: x.bankDate })),
    writtenOff: !!l?.writeOff,
  };
}

async function states(orders: CrmOrder[], r: Rules, today = todayIST()) {
  const nums = orders.map((o) => o.orderNumber);
  const [dl, linked] = await Promise.all([deliveries({ orderNumbers: nums }), linkedFor(nums)]);
  const byNum = new Map(dl.map((d) => [d.orderNumber, d]));
  return orders.map((o) => {
    const f = facts(o, byNum.get(o.orderNumber));
    const l = linked.get(o.orderNumber);
    const c = collections(l);
    return { order: o, facts: f, linked: l, collections: c, state: orderPaymentStatus(f, c, r, today), findings: orderChecks(f, c, r, today) };
  });
}

// ---------- F190 / F191 tracker ----------

export type TrackerFilter = { from?: string; to?: string; status?: string; route?: string; channel?: string; discrepancyOnly?: boolean; q?: string; showInBank?: boolean };

export async function tracker(f: TrackerFilter = {}) {
  const r = await reconRules();
  const to = f.to ?? todayIST();
  const from = f.from ?? shift(to, -60);
  const orders = await crmOrders({ from, to });
  const all = await states(orders, r);
  const open = await prisma.reconDiscrepancy.findMany({ where: { status: 'open', orderNumber: { in: orders.map((o) => o.orderNumber) } } });
  const openBy = new Map<string, number[]>();
  for (const x of open) openBy.set(x.orderNumber!, [...(openBy.get(x.orderNumber!) ?? []), x.typeCode]);
  const q = f.q?.trim().toUpperCase();
  const tracked = all.filter((s) => s.state.status !== 'nothing_due');
  const rows = tracked
    .filter((s) => (f.channel ? s.order.channel === f.channel : true) && (f.route ? s.state.route === f.route : true))
    .filter((s) => (!q ? true : [s.order.orderNumber, s.order.customerName, s.order.phone, s.order.shopifyOrderId ?? '', s.facts.awb ?? '', ...(s.linked?.payments.map((p) => p.externalId) ?? [])].some((x) => x.toUpperCase().includes(q))));
  const totals = Object.fromEntries((Object.keys(ORDER_STATUS_LABEL) as OrderStatusCode[]).map((k) => {
    const these = rows.filter((s) => s.state.status === k);
    return [k, { label: ORDER_STATUS_LABEL[k], count: these.length, amount: moneyText(sum(these.map((s) => new Decimal(s.state.expectedAmount)))) }];
  }));
  const shown = rows
    .filter((s) => (f.status ? s.state.status === f.status : f.showInBank || !['in_bank', 'written_off', 'rto_cancelled', 'refunded', 'not_tracked'].includes(s.state.status)))
    .filter((s) => (f.discrepancyOnly ? openBy.has(s.order.orderNumber) : true));
  return {
    from, to,
    readers: { crm: crmReaderMode(), inventory: inventoryReaderMode() },
    totals,
    overdue: rows.filter((s) => s.state.overdue).length,
    rows: shown.map((s) => ({
      orderNumber: s.order.orderNumber, orderDate: s.order.orderDate, channel: s.order.channel, customerName: s.order.customerName, paymentMethod: s.order.paymentMethod,
      route: s.state.route, routeLabel: ROUTE_LABEL[s.state.route], orderAmount: moneyText(s.order.totalAmount), expectedAmount: s.state.expectedAmount, collected: s.state.collected,
      gatewayRef: s.linked?.payments[0]?.externalId ?? s.facts.awb ?? null,
      settlementRef: s.linked?.payments.find((p) => p.batch)?.batch?.externalId ?? s.linked?.cod[0]?.batch.externalId ?? null,
      status: s.state.status, statusLabel: ORDER_STATUS_LABEL[s.state.status], expectedDate: s.state.expectedDate, bankDate: s.state.bankDate, overdue: s.state.overdue,
      discrepancies: openBy.get(s.order.orderNumber) ?? [],
    })),
  };
}

/** F197: paid by customers, not yet in the bank. Batches not yet in the bank count at their net. */
export async function moneyInTransit() {
  const r = await reconRules();
  const from = await windowStart();
  const all = await states(await crmOrders({ from, to: todayIST() }), r);
  const stage = (st: OrderStatusCode, amount: (s: (typeof all)[number]) => Decimal) => {
    const these = all.filter((s) => s.state.status === st);
    return { count: these.length, amount: moneyText(sum(these.map(amount))), overdue: these.filter((s) => s.state.overdue).length, oldestExpected: these.map((s) => s.state.expectedDate).filter(Boolean).sort()[0] ?? null };
  };
  const waiting = await prisma.settlementBatch.findMany({ where: { bankTxnId: null, net: { gt: 0 } }, orderBy: { settledOn: 'asc' } });
  const expectedBank = (b: SettlementBatch) => addWorkingDays(dateText(b.settledOn)!, r.settlementToBankDays, r.holidays);
  const batchStage = (source: SettlementBatch['source']) => {
    const these = waiting.filter((b) => b.source === source);
    return { count: these.length, amount: moneyText(sum(these.map((b) => b.net))), overdue: these.filter((b) => todayIST() >= addWorkingDays(expectedBank(b), r.graceDays, r.holidays)).length, oldestExpected: these[0] ? expectedBank(these[0]) : null };
  };
  const gateway = stage('paid_at_gateway', (s) => new Decimal(s.state.collected));
  const cod = stage('delivered_awaiting_remittance', (s) => new Decimal(s.state.expectedAmount));
  const settled = batchStage('razorpay');
  const remitted = batchStage('shiprocket_cod');
  return {
    paidAtGateway: gateway, deliveredAwaitingRemittance: cod, settledNotInBank: settled, remittedNotInBank: remitted,
    total: moneyText([gateway, cod, settled, remitted].reduce((s, x) => s.plus(x.amount ?? 0), zero())),
    /** For the cash forecast (F136): expected bank date per item. */
    expected: [
      ...all.filter((s) => s.state.status === 'paid_at_gateway' || s.state.status === 'delivered_awaiting_remittance').map((s) => ({
        date: addWorkingDays(s.state.expectedDate!, r.settlementToBankDays, r.holidays), amount: s.state.status === 'paid_at_gateway' ? s.state.collected : s.state.expectedAmount,
        label: `${s.order.orderNumber} (${ORDER_STATUS_LABEL[s.state.status].toLowerCase()})`,
      })),
      ...waiting.map((b) => ({ date: expectedBank(b), amount: moneyText(b.net)!, label: `${b.source === 'razorpay' ? 'Razorpay settlement' : 'COD remittance'} ${b.externalId}` })),
    ],
  };
}

// ---------- Order detail ----------

export async function orderDetail(orderNumber: string) {
  const o = await crmOrder(orderNumber);
  if (!o) throw new UserError('Order not found in the CRM', 404);
  const r = await reconRules();
  const [s] = await states([o], r);
  const disc = await prisma.reconDiscrepancy.findMany({ where: { orderNumber }, orderBy: { detectedAt: 'desc' } });
  const links = await prisma.orderBankLink.findMany({ where: { orderNumber }, orderBy: { createdAt: 'asc' } });
  const rows = new Map((await prisma.bankTxn.findMany({ where: { id: { in: links.map((l) => l.bankTxnId) } } })).map((t) => [t.id, t]));
  const writeOffs = await prisma.orderWriteOff.findMany({ where: { orderNumber }, orderBy: { createdAt: 'desc' } });
  return {
    order: {
      orderNumber: o.orderNumber, orderDate: o.orderDate, channel: o.channel, paymentMethod: o.paymentMethod, customerName: o.customerName, phone: o.phone, email: o.email,
      shopifyOrderId: o.shopifyOrderId, crmStatus: o.status, totalAmount: moneyText(o.totalAmount), advancePaid: moneyText(o.advancePaid),
      awb: s.facts.awb, codToCollect: moneyText(s.facts.codToCollect), shippedAt: s.facts.shippedAt, deliveredAt: s.facts.deliveredAt,
    },
    state: { ...s.state, statusLabel: ORDER_STATUS_LABEL[s.state.status], routeLabel: ROUTE_LABEL[s.state.route as Route] },
    payments: (s.linked?.payments ?? []).map((p) => ({
      id: p.id, externalId: p.externalId, method: p.method, amount: moneyText(p.amount), fee: moneyText(p.fee), taxOnFee: moneyText(p.taxOnFee), refunded: moneyText(p.refunded),
      status: p.status, capturedOn: dateText(p.capturedOn), linkedBy: p.linkedBy, settlement: p.batch ? { id: p.batch.id, externalId: p.batch.externalId, settledOn: dateText(p.batch.settledOn), bankDate: p.batch.bankDate } : null,
    })),
    remittances: (s.linked?.cod ?? []).map((l) => ({ lineId: l.id, awb: l.awb, amount: moneyText(l.gross), linkedBy: l.linkedBy, batch: { id: l.batch.id, externalId: l.batch.externalId, settledOn: dateText(l.batch.settledOn), bankDate: l.batch.bankDate } })),
    direct: links.map((l) => { const t = rows.get(l.bankTxnId); return { id: l.id, amount: moneyText(l.amount), matchedBy: l.matchedBy, isArchived: l.isArchived, archivedReason: l.archivedReason, bankRow: t ? { id: t.id, txnDate: dateText(t.txnDate), counterpartyName: t.counterpartyName, credit: moneyText(t.credit) } : null }; }),
    writeOffs: writeOffs.map((w) => ({ id: w.id, amount: moneyText(w.amount), reason: w.reason, isArchived: w.isArchived, archivedReason: w.archivedReason, createdAt: w.createdAt })),
    discrepancies: disc.map(discrepancyRow),
  };
}

/** Bank credits a person could link to a direct order: free credits within 45 days after the order. */
export async function orderCreditCandidates(orderNumber: string) {
  const o = await crmOrder(orderNumber);
  if (!o) throw new UserError('Order not found in the CRM', 404);
  const rows = await prisma.bankTxn.findMany({
    where: { credit: { gt: 0 }, status: { in: ['review', 'suggested', 'categorised'] }, OR: [{ linkedDocId: null }, { linkedDocType: 'CrmOrder' }], txnDate: { gte: parseDate(shift(o.orderDate, -3)), lte: parseDate(shift(o.orderDate, 45)) } },
    orderBy: { txnDate: 'asc' }, take: 100,
  });
  return rows.sort((a, b) => Number(!a.credit.equals(o.totalAmount)) - Number(!b.credit.equals(o.totalAmount)))
    .map((t) => ({ id: t.id, txnDate: dateText(t.txnDate), counterpartyName: t.counterpartyName, credit: moneyText(t.credit), narration: t.narrationRaw, sameAmount: t.credit.equals(o.totalAmount) }));
}

/**
 * F200: the order's payment status for the CRM order page ('In bank 14 Oct', 'Awaiting COD
 * remittance'). The status needs CRM data, so it cannot be a database view over CRM tables (D15);
 * the CRM calls this instead, as it calls the invoice engine (F105).
 */
export async function orderStatusForCrm(orderNumber: string) {
  const o = await crmOrder(orderNumber);
  if (!o) throw new UserError('Order not found in the CRM', 404);
  const [s] = await states([o], await reconRules());
  const open = await prisma.reconDiscrepancy.count({ where: { orderNumber, status: 'open' } });
  const when = s.state.bankDate ?? s.state.expectedDate;
  return {
    orderNumber, status: s.state.status, label: ORDER_STATUS_LABEL[s.state.status], route: s.state.route,
    text: s.state.bankDate ? `In bank ${s.state.bankDate}` : `${ORDER_STATUS_LABEL[s.state.status]}${when ? `, expected ${when}` : ''}`,
    expectedAmount: s.state.expectedAmount, collected: s.state.collected, bankDate: s.state.bankDate, expectedDate: s.state.expectedDate,
    overdue: s.state.overdue, openDiscrepancies: open,
  };
}

// ---------- F198 settlements ----------

async function batchView(b: SettlementBatch & { lines: SettlementLine[] }) {
  const orders = new Map((await crmOrders({ orderNumbers: [...new Set(b.lines.map((l) => l.orderNumber).filter(Boolean) as string[])] })).map((o) => [o.orderNumber, o]));
  const dl = new Map((await deliveries({ orderNumbers: [...orders.keys()] })).map((d) => [d.orderNumber, d]));
  const row = b.bankTxnId ? await prisma.bankTxn.findUnique({ where: { id: b.bankTxnId } }) : null;
  const orderAmount = (l: SettlementLine) => {
    if (!l.orderNumber || (l.type !== 'payment' && l.type !== 'cod')) return null;
    const o = orders.get(l.orderNumber);
    if (!o) return null;
    return l.type === 'cod' ? (dl.get(l.orderNumber)?.codToCollect ?? o.totalAmount) : o.totalAmount;
  };
  const t = tieOut({ lines: b.lines.map((l) => ({ orderAmount: orderAmount(l), gross: l.gross, fee: l.fee, taxOnFee: l.taxOnFee, refund: l.refund, adjustment: l.adjustment, net: l.net })), net: b.net, bankCredit: row?.credit ?? null });
  return { row, tie: t, orderAmount };
}

export async function listSettlements(f: { source?: string; notInBank?: boolean } = {}) {
  const r = await reconRules();
  const rows = await prisma.settlementBatch.findMany({
    where: { ...(f.source && { source: f.source as SettlementBatch['source'] }), ...(f.notInBank && { bankTxnId: null }) },
    include: { _count: { select: { lines: true } } }, orderBy: { settledOn: 'desc' }, take: 300,
  });
  return rows.map((b) => ({
    id: b.id, source: b.source, externalId: b.externalId, utr: b.utr, settledOn: dateText(b.settledOn), lines: b._count.lines, gross: moneyText(b.gross), fees: moneyText(b.fees.plus(b.taxOnFees)), net: moneyText(b.net),
    inBank: !!b.bankTxnId, matchedBy: b.matchedBy, expectedBank: addWorkingDays(dateText(b.settledOn)!, r.settlementToBankDays, r.holidays),
  }));
}

export async function getSettlement(id: string) {
  const b = await prisma.settlementBatch.findUnique({ where: { id }, include: { lines: { orderBy: { createdAt: 'asc' } } } });
  if (!b) throw new UserError('Settlement not found', 404);
  const r = await reconRules();
  const { row, tie, orderAmount } = await batchView(b);
  const candidates = b.bankTxnId ? [] : (await batchCandidates(b, r)).map((t) => ({ id: t.id, txnDate: dateText(t.txnDate), counterpartyName: t.counterpartyName, credit: moneyText(t.credit), narration: t.narrationRaw, sameAmount: t.credit.equals(b.net) }));
  const disc = await prisma.reconDiscrepancy.findMany({ where: { batchId: id }, orderBy: { detectedAt: 'desc' } });
  return {
    id: b.id, source: b.source, externalId: b.externalId, utr: b.utr, settledOn: dateText(b.settledOn), matchedBy: b.matchedBy,
    totals: tie.totals, levels: tie.levels,
    bankRow: row ? { id: row.id, txnDate: dateText(row.txnDate), counterpartyName: row.counterpartyName, credit: moneyText(row.credit), bankAccountId: row.bankAccountId } : null,
    lines: b.lines.map((l) => ({
      id: l.id, type: l.type, externalId: l.externalId, paymentId: l.paymentId, awb: l.awb, orderNumber: l.orderNumber, linkedBy: l.linkedBy, reference: l.reference,
      orderAmount: moneyText(orderAmount(l)), gross: moneyText(l.gross), fee: moneyText(l.fee), taxOnFee: moneyText(l.taxOnFee), refund: moneyText(l.refund), adjustment: moneyText(l.adjustment), net: moneyText(l.net),
    })),
    candidates,
    discrepancies: disc.map(discrepancyRow),
  };
}

// ---------- BR-46 discrepancy queue (F196) ----------

type Scoped = Finding & { key: string; orderNumber?: string; batchId?: string; gatewayPaymentId?: string };

/** Re-runs every check on the tracked window and keeps the queue in step: new problems open, fixed ones clear. */
export async function refreshDiscrepancies(ctx: AuditContext) {
  const r = await reconRules();
  const today = todayIST();
  const from = await windowStart();
  const found: Scoped[] = [];
  const scopes = new Set<string>();

  const all = await states(await crmOrders({ from, to: today }), r, today);
  for (const s of all) {
    scopes.add(`order:${s.order.orderNumber}`);
    for (const f of s.findings) found.push({ ...f, key: `${f.type}:order:${s.order.orderNumber}`, orderNumber: s.order.orderNumber });
  }
  const batches = await prisma.settlementBatch.findMany({ where: { settledOn: { gte: parseDate(from) } }, include: { lines: true } });
  for (const b of batches) {
    scopes.add(`batch:${b.id}`);
    const { row, tie } = await batchView(b);
    const pays = b.lines.filter((l) => l.type === 'payment');
    const checks = batchChecks({ source: b.source, date: dateText(b.settledOn)!, paymentGross: sum(pays.map((l) => l.gross)), feesWithTax: sum(pays.map((l) => l.fee.plus(l.taxOnFee))), bankCredit: row?.credit ?? null, levels: tie.levels }, r, today);
    for (const f of checks) found.push({ ...f, key: `${f.type}:batch:${b.id}`, batchId: b.id });
  }
  // Type 2 the other way round: a Razorpay payment that names no CRM order after the grace days.
  const loose = await prisma.gatewayPayment.findMany({ where: { orderNumber: null, capturedOn: { gte: parseDate(from) } } });
  for (const p of loose) {
    scopes.add(`payment:${p.id}`);
    if (today >= addWorkingDays(dateText(p.capturedOn)!, r.graceDays, r.holidays)) {
      found.push({ type: 2, amount: p.amount.toFixed(2), detail: `Razorpay payment ${p.externalId} of ${dateText(p.capturedOn)} names no CRM order`, action: 'Link it to its order, or chase the order in the CRM', key: `2:payment:${p.id}`, gatewayPaymentId: p.id });
    }
  }
  // Linked payments leave the "no order" scope too.
  const linkedNow = await prisma.reconDiscrepancy.findMany({ where: { status: 'open', gatewayPaymentId: { not: null } } });
  for (const d of linkedNow) scopes.add(`payment:${d.gatewayPaymentId}`);

  const company = await getCompany();
  const existing = await prisma.reconDiscrepancy.findMany({ where: { OR: [{ status: 'open' }, { key: { in: found.map((f) => f.key) } }] } });
  const byKey = new Map(existing.map((d) => [d.key, d]));
  const now = new Date();
  let opened = 0; let cleared = 0;
  await withAudit({ ...ctx, reason: ctx.reason ?? 'Order-to-bank checks run' }, async (tx) => {
    for (const f of found) {
      const d = byKey.get(f.key);
      if (!d) {
        await tx.reconDiscrepancy.create({ data: { entityId: company.id, key: f.key, typeCode: f.type, orderNumber: f.orderNumber, batchId: f.batchId, gatewayPaymentId: f.gatewayPaymentId, amount: new Decimal(f.amount), detail: f.detail, suggestedAction: f.action } });
        opened += 1;
      } else if (d.status === 'cleared') {
        await tx.reconDiscrepancy.update({ where: { id: d.id }, data: { status: 'open', clearedAt: null, amount: new Decimal(f.amount), detail: f.detail, detectedAt: now } });
        opened += 1;
      } else if (d.status === 'open' && (!d.amount.equals(f.amount) || d.detail !== f.detail)) {
        await tx.reconDiscrepancy.update({ where: { id: d.id }, data: { amount: new Decimal(f.amount), detail: f.detail } });
      }
    }
    const still = new Set(found.map((f) => f.key));
    for (const d of existing.filter((x) => x.status === 'open' && !still.has(x.key))) {
      const scope = d.key.split(':').slice(1).join(':');
      if (!scopes.has(scope)) continue; // outside what was checked this time
      await tx.reconDiscrepancy.update({ where: { id: d.id }, data: { status: 'cleared', clearedAt: now } });
      cleared += 1;
    }
  }, { timeoutMs: 120_000 });
  // BR-39 / BR-40: orders whose money reached the bank settle their D2C invoices.
  await settleOrderInvoices({ userId: ctx.userId, reason: 'Order payments in the bank applied to invoices' });
  return { opened, cleared, open: await prisma.reconDiscrepancy.count({ where: { status: 'open' } }) };
}

function discrepancyRow(d: ReconDiscrepancy) {
  return {
    id: d.id, typeCode: d.typeCode, typeLabel: DISCREPANCY_LABEL[d.typeCode] ?? `Type ${d.typeCode}`, orderNumber: d.orderNumber, batchId: d.batchId, gatewayPaymentId: d.gatewayPaymentId,
    amount: moneyText(d.amount), detail: d.detail, suggestedAction: d.suggestedAction, status: d.status, detectedAt: d.detectedAt, clearedAt: d.clearedAt,
    resolutionAction: d.resolutionAction, resolutionLabel: d.resolutionAction ? RESOLUTION_LABEL[d.resolutionAction as keyof typeof RESOLUTION_LABEL] ?? d.resolutionAction : null,
    resolutionNote: d.resolutionNote, resolvedAt: d.resolvedAt,
  };
}

export async function listDiscrepancies(f: { status?: string; type?: number } = {}) {
  const rows = await prisma.reconDiscrepancy.findMany({ where: { status: f.status ?? 'open', ...(f.type && { typeCode: f.type }) }, orderBy: [{ typeCode: 'asc' }, { detectedAt: 'asc' }], take: 500 });
  const byType = await prisma.reconDiscrepancy.groupBy({ by: ['typeCode'], where: { status: 'open' }, _count: true, _sum: { amount: true } });
  return {
    rows: rows.map(discrepancyRow),
    open: byType.map((t) => ({ typeCode: t.typeCode, typeLabel: DISCREPANCY_LABEL[t.typeCode], count: t._count, amount: moneyText(t._sum.amount ?? zero()) })).sort((a, b) => a.typeCode - b.typeCode),
  };
}

export async function resolveDiscrepancy(ctx: AuditContext, id: string, action: string, note: string) {
  if (!RESOLUTIONS.includes(action as (typeof RESOLUTIONS)[number])) throw new UserError('Choose what was done');
  if (!text(note)) throw new UserError('Add a note on how it was resolved');
  const d = await prisma.reconDiscrepancy.findUnique({ where: { id } });
  if (!d) throw new UserError('Discrepancy not found', 404);
  if (d.status === 'resolved') throw new UserError('Already resolved');
  await withAudit({ ...ctx, reason: ctx.reason ?? 'Discrepancy resolved' }, (tx) => tx.reconDiscrepancy.update({
    where: { id }, data: { status: 'resolved', resolutionAction: action, resolutionNote: note.trim(), resolvedBy: ctx.userId, resolvedAt: new Date() },
  }));
  return discrepancyRow((await prisma.reconDiscrepancy.findUnique({ where: { id } }))!);
}

export async function openDiscrepancyCount() {
  return prisma.reconDiscrepancy.count({ where: { status: 'open' } });
}

// ---------- Links by hand ----------

export async function linkPayment(ctx: AuditContext, paymentId: string, orderNumber: string) {
  const p = await prisma.gatewayPayment.findUnique({ where: { id: paymentId } });
  if (!p) throw new UserError('Payment not found', 404);
  if (p.orderNumber) throw new UserError(`Already linked to ${p.orderNumber}; unlink it first`);
  if (!(await crmOrder(orderNumber))) throw new UserError('No CRM order with that number');
  await withAudit({ ...ctx, reason: ctx.reason ?? 'Razorpay payment linked to order by hand' }, async (tx) => {
    await tx.gatewayPayment.update({ where: { id: paymentId }, data: { orderNumber, linkedBy: 'manual' } });
    await linkLinesToOrders(tx);
  });
  await refreshDiscrepancies(ctx);
  return orderDetail(orderNumber);
}

export async function unlinkPayment(ctx: AuditContext, paymentId: string) {
  if (!text(ctx.reason)) throw new UserError('Say why the link is wrong');
  const p = await prisma.gatewayPayment.findUnique({ where: { id: paymentId } });
  if (!p?.orderNumber) throw new UserError('This payment is not linked');
  await withAudit(ctx, async (tx) => {
    await tx.gatewayPayment.update({ where: { id: paymentId }, data: { orderNumber: null, linkedBy: null } });
    await tx.settlementLine.updateMany({ where: { paymentId: p.externalId }, data: { orderNumber: null, linkedBy: null } });
  });
  await refreshDiscrepancies(ctx);
  return { ok: true };
}

export async function linkSettlementRow(ctx: AuditContext, batchId: string, txnId: string) {
  const b = await prisma.settlementBatch.findUnique({ where: { id: batchId } });
  if (!b) throw new UserError('Settlement not found', 404);
  if (b.bankTxnId) throw new UserError('Already linked to a bank row; unlink it first');
  const row = await prisma.bankTxn.findUnique({ where: { id: txnId } });
  if (!row || row.linkedDocId || !row.credit.greaterThan(0)) throw new UserError('That bank row is not a free credit');
  if (!['review', 'suggested', 'categorised'].includes(row.status)) throw new UserError('That bank row is split, a transfer or ignored');
  await withAudit({ ...ctx, reason: ctx.reason ?? 'Settlement linked to bank row by hand' }, (tx) => linkBatchRow(tx, b, row, 'manual'));
  await refreshDiscrepancies(ctx);
  return getSettlement(batchId);
}

export async function unlinkSettlementRow(ctx: AuditContext, batchId: string) {
  if (!text(ctx.reason)) throw new UserError('Say why the link is wrong');
  const b = await prisma.settlementBatch.findUnique({ where: { id: batchId } });
  if (!b?.bankTxnId) throw new UserError('This settlement is not linked to a bank row');
  await withAudit(ctx, async (tx) => {
    await unlinkBankRow(tx, b.bankTxnId!);
    await tx.settlementBatch.update({ where: { id: batchId }, data: { bankTxnId: null, matchedBy: null } });
  });
  await refreshDiscrepancies(ctx);
  return getSettlement(batchId);
}

/** F195 by hand: one credit may pay several orders (a hotel paying three orders in one transfer). */
export async function linkOrderCredit(ctx: AuditContext, orderNumber: string, txnId: string, amountText?: string | null) {
  const o = await crmOrder(orderNumber);
  if (!o) throw new UserError('Order not found in the CRM', 404);
  const row = await prisma.bankTxn.findUnique({ where: { id: txnId } });
  if (!row || !row.credit.greaterThan(0)) throw new UserError('Choose a bank credit');
  if (row.linkedDocId && row.linkedDocType !== 'CrmOrder') throw new UserError('That bank row already pays something else');
  const used = sum((await prisma.orderBankLink.findMany({ where: { bankTxnId: txnId, isArchived: false } })).map((l) => l.amount));
  const left = row.credit.minus(used);
  const amount = amountText ? new Decimal(amountText.replace(/[,\s₹]/g, '')) : Decimal.min(left, o.totalAmount);
  if (!amount.greaterThan(0) || amount.greaterThan(left)) throw new UserError(`Only Rs ${left.toFixed(2)} of this credit is not yet set against orders`);
  if (await prisma.orderBankLink.findFirst({ where: { bankTxnId: txnId, orderNumber, isArchived: false } })) throw new UserError('Already linked to this order');
  await withAudit({ ...ctx, reason: ctx.reason ?? 'Bank credit linked to order by hand' }, (tx) => linkOrderRow(tx, orderNumber, row, amount, 'manual'));
  await refreshDiscrepancies(ctx);
  return orderDetail(orderNumber);
}

export async function unlinkOrderCredit(ctx: AuditContext, linkId: string) {
  if (!text(ctx.reason)) throw new UserError('Say why the link is wrong');
  const l = await prisma.orderBankLink.findUnique({ where: { id: linkId } });
  if (!l || l.isArchived) throw new UserError('Link not found');
  await withAudit(ctx, async (tx) => {
    await tx.orderBankLink.update({ where: { id: linkId }, data: { isArchived: true, archivedReason: ctx.reason } });
    const others = await tx.orderBankLink.findFirst({ where: { bankTxnId: l.bankTxnId, isArchived: false } });
    if (!others) await unlinkBankRow(tx, l.bankTxnId);
    else await tx.bankTxn.update({ where: { id: l.bankTxnId }, data: { linkedDocId: others.orderNumber } });
  });
  await refreshDiscrepancies(ctx);
  return orderDetail(l.orderNumber);
}

/** Order Payment 'Written off' (admin, with a reason); undone by archiving it with a reason. */
export async function writeOff(ctx: AuditContext, orderNumber: string) {
  if (!text(ctx.reason)) throw new UserError('Say why the money is written off');
  const o = await crmOrder(orderNumber);
  if (!o) throw new UserError('Order not found in the CRM', 404);
  if (await prisma.orderWriteOff.findFirst({ where: { orderNumber, isArchived: false } })) throw new UserError('Already written off');
  const r = await reconRules();
  const [s] = await states([o], r);
  const owed = new Decimal(s.state.expectedAmount).minus(s.state.collected);
  const company = await getCompany();
  await withAudit(ctx, (tx) => tx.orderWriteOff.create({ data: { entityId: company.id, orderNumber, amount: Decimal.max(owed, 0), reason: ctx.reason! } }));
  await refreshDiscrepancies(ctx);
  return orderDetail(orderNumber);
}

export async function undoWriteOff(ctx: AuditContext, orderNumber: string) {
  if (!text(ctx.reason)) throw new UserError('Say why the write-off is undone');
  const w = await prisma.orderWriteOff.findFirst({ where: { orderNumber, isArchived: false } });
  if (!w) throw new UserError('This order is not written off');
  await withAudit(ctx, (tx) => tx.orderWriteOff.update({ where: { id: w.id }, data: { isArchived: true, archivedReason: ctx.reason } }));
  await refreshDiscrepancies(ctx);
  return orderDetail(orderNumber);
}

export async function unlinkedPayments() {
  const rows = await prisma.gatewayPayment.findMany({ where: { orderNumber: null }, orderBy: { capturedOn: 'desc' }, take: 200 });
  return rows.map((p) => ({ id: p.id, externalId: p.externalId, amount: moneyText(p.amount), capturedOn: dateText(p.capturedOn), method: p.method, reference: p.reference, contact: p.contact, status: p.status }));
}

// ---------- Settings (BR-45, BR-46) ----------

export type ReconSettingInput = {
  razorpaySettlementDays: number; codRemittanceDays: number; settlementToBankDays: number; graceDays: number;
  amountTolerance: string; expectedFeeRate: string; feeGstRate: string; trackFrom?: string | null;
};

export async function getReconSettings() {
  const s = await reconSetting();
  const holidays = await prisma.bankHoliday.findMany({ where: { isArchived: false }, orderBy: { date: 'asc' } });
  return {
    razorpaySettlementDays: s.razorpaySettlementDays, codRemittanceDays: s.codRemittanceDays, settlementToBankDays: s.settlementToBankDays, graceDays: s.graceDays,
    amountTolerance: moneyText(s.amountTolerance), expectedFeeRate: s.expectedFeeRate.toFixed(2), feeGstRate: s.feeGstRate.toFixed(2), trackFrom: dateText(s.trackFrom),
    holidays: holidays.map((h) => ({ id: h.id, date: dateText(h.date), name: h.name })),
  };
}

export async function saveReconSettings(ctx: AuditContext, input: ReconSettingInput) {
  for (const k of ['razorpaySettlementDays', 'codRemittanceDays', 'settlementToBankDays', 'graceDays'] as const) {
    if (!Number.isInteger(input[k]) || input[k] < 0 || input[k] > 30) throw new UserError('Days must be whole numbers from 0 to 30');
  }
  const s = await reconSetting();
  await withAudit({ ...ctx, reason: ctx.reason ?? 'Order-to-bank settings changed' }, (tx) => tx.reconSetting.update({
    where: { id: s.id },
    data: {
      razorpaySettlementDays: input.razorpaySettlementDays, codRemittanceDays: input.codRemittanceDays, settlementToBankDays: input.settlementToBankDays, graceDays: input.graceDays,
      amountTolerance: new Decimal(input.amountTolerance), expectedFeeRate: new Decimal(input.expectedFeeRate), feeGstRate: new Decimal(input.feeGstRate),
      trackFrom: input.trackFrom ? parseDate(input.trackFrom, 'Track from') : null,
    },
  }));
  return getReconSettings();
}

export async function addHoliday(ctx: AuditContext, date: string, name: string) {
  if (!text(name)) throw new UserError('Name the holiday');
  const d = parseDate(date, 'Holiday');
  const known = await prisma.bankHoliday.findUnique({ where: { date: d } });
  await withAudit({ ...ctx, reason: ctx.reason ?? 'Bank holiday added' }, (tx) => (known
    ? tx.bankHoliday.update({ where: { id: known.id }, data: { name: name.trim(), isArchived: false } })
    : tx.bankHoliday.create({ data: { date: d, name: name.trim() } })));
  return getReconSettings();
}

export async function removeHoliday(ctx: AuditContext, id: string) {
  await withAudit({ ...ctx, reason: ctx.reason ?? 'Bank holiday removed' }, (tx) => tx.bankHoliday.update({ where: { id }, data: { isArchived: true } }));
  return getReconSettings();
}


// ---------- D36 funnel and D37 days to bank ----------

/** Where each month's order value is, and how fast money reaches the bank by route, for orders placed in the range. */
export async function orderFunnel(from: string, to: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new UserError('Choose the period');
  const r = await reconRules();
  const all = (await states(await crmOrders({ from, to }), r)).filter((s) => s.state.status !== 'nothing_due' && s.state.status !== 'not_tracked');
  const rows: FunnelRow[] = all.map((s) => ({
    orderMonth: s.order.orderDate.slice(0, 7), orderDate: s.order.orderDate, route: s.state.route, status: s.state.status,
    orderValue: s.order.totalAmount, collected: new Decimal(s.state.collected ?? 0), bankDate: s.state.bankDate,
  }));
  return { from, to, months: funnelByMonth(rows), daysToBank: daysToBank(rows) };
}
