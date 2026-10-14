import type { BankTxn, Prisma, ReconSetting, SettlementBatch } from '@prisma/client';
import { prisma } from '../config/database';
import { crmOrders, type CrmOrder } from '../crm/reader';
import { deliveries } from '../inventory/reader';
import { withAudit, type Tx } from '../lib/audit';
import { dateText } from '../lib/dates';
import { Decimal } from '../lib/money';
import { nameSimilarity } from '../lib/payables';
import { addWorkingDays } from '../lib/workingDays';
import { collectionRoute, type CrmChannel, type CrmPaymentMethod } from '../recon/status';
import { getCompany } from './settings.service';

/**
 * M18 linking: Razorpay payments and settlement lines to CRM orders (F192, F193), settlements and
 * remittances to their IDFC credit (F194), and direct payments to orders (F195). Every link records
 * how it was made (reference, amount_date, utr, amount_date_name, manual).
 */

const DAY = 86_400_000;
const shift = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

export async function reconSetting(): Promise<ReconSetting> {
  const company = await getCompany();
  const s = await prisma.reconSetting.findUnique({ where: { entityId: company.id } });
  if (s) return s;
  // Created with the defaults the first time it is needed (also seeded).
  return withAudit({ userId: 'system', reason: 'Order-to-bank settings created with defaults' }, (tx) =>
    tx.reconSetting.upsert({ where: { entityId: company.id }, update: {}, create: { entityId: company.id } }));
}

export async function reconRules() {
  const [s, hol] = await Promise.all([reconSetting(), prisma.bankHoliday.findMany({ where: { isArchived: false } })]);
  return {
    setting: s,
    razorpaySettlementDays: s.razorpaySettlementDays, codRemittanceDays: s.codRemittanceDays, settlementToBankDays: s.settlementToBankDays,
    graceDays: s.graceDays, tolerance: s.amountTolerance, expectedFeeRate: s.expectedFeeRate, feeGstRate: s.feeGstRate,
    holidays: new Set(hol.map((h) => dateText(h.date)!)),
  };
}
export type Rules = Awaited<ReturnType<typeof reconRules>>;

export const routeOf = (o: CrmOrder) => collectionRoute({ channel: o.channel as CrmChannel, paymentMethod: o.paymentMethod as CrmPaymentMethod, isReplacement: o.isReplacement });

/** Words in a report's text, for finding an order number or Shopify number in it. */
const words = (text: string) => new Set(text.toUpperCase().split(/[^A-Z0-9_-]+/).filter((w) => w.length >= 3));
const cancelled = (o: CrmOrder) => o.status === 'CANCELLED' || o.status === 'RETURNED';

/** F192: link captured payments with no order. The order number in the report wins; else amount + date. */
export async function linkPaymentsToOrders(tx: Tx): Promise<number> {
  const open = await tx.gatewayPayment.findMany({ where: { orderNumber: null } });
  if (!open.length) return 0;
  const days = open.map((p) => dateText(p.capturedOn)!).sort();
  const orders = await crmOrders({ from: shift(days[0], -10), to: shift(days[days.length - 1], 1) });
  const taken = new Set((await tx.gatewayPayment.findMany({ where: { orderNumber: { in: orders.map((o) => o.orderNumber) } }, select: { orderNumber: true } })).map((p) => p.orderNumber!));
  let linked = 0;
  for (const p of open) {
    const w = words(p.reference);
    let match = orders.find((o) => w.has(o.orderNumber.toUpperCase()) || (o.shopifyOrderId && w.has(o.shopifyOrderId.replace(/^#/, '').toUpperCase())));
    let by = 'reference';
    if (!match) {
      const day = dateText(p.capturedOn)!;
      const same = orders.filter((o) => routeOf(o) === 'razorpay' && !cancelled(o) && !taken.has(o.orderNumber) && o.totalAmount.equals(p.amount) && o.orderDate <= day && o.orderDate >= shift(day, -3));
      if (same.length === 1) { match = same[0]; by = 'amount_date'; }
    }
    if (!match) continue;
    await tx.gatewayPayment.update({ where: { id: p.id }, data: { orderNumber: match.orderNumber, linkedBy: by } });
    taken.add(match.orderNumber);
    linked += 1;
  }
  await linkLinesToOrders(tx);
  return linked;
}

/** Settlement lines take their payment's order; COD lines their AWB's order (bloc-inv), else the order id in the file. */
export async function linkLinesToOrders(tx: Tx) {
  const lines = await tx.settlementLine.findMany({ where: { orderNumber: null } });
  if (!lines.length) return;
  const payIds = lines.map((l) => l.paymentId).filter(Boolean) as string[];
  const pays = new Map((await tx.gatewayPayment.findMany({ where: { externalId: { in: payIds }, orderNumber: { not: null } } })).map((p) => [p.externalId, p.orderNumber!]));
  const awbs = lines.map((l) => l.awb).filter(Boolean) as string[];
  const byAwb = new Map((await deliveries({ awbs })).filter((d) => d.awb).map((d) => [d.awb!, d.orderNumber]));
  const refs = lines.filter((l) => l.awb && !byAwb.has(l.awb) && l.reference).map((l) => l.reference.replace(/^#/, '').trim());
  const known = new Set((await crmOrders({ orderNumbers: refs })).map((o) => o.orderNumber));
  for (const l of lines) {
    let orderNumber: string | null = null; let by = '';
    if (l.paymentId && pays.has(l.paymentId)) { orderNumber = pays.get(l.paymentId)!; by = 'payment'; }
    else if (l.awb && byAwb.has(l.awb)) { orderNumber = byAwb.get(l.awb)!; by = 'awb'; }
    else if (l.awb && known.has(l.reference.replace(/^#/, '').trim())) { orderNumber = l.reference.replace(/^#/, '').trim(); by = 'reference'; }
    if (orderNumber) await tx.settlementLine.update({ where: { id: l.id }, data: { orderNumber, linkedBy: by } });
  }
}

// ---------- F194: settlements and remittances to the bank ----------

const FREE_CREDIT: Prisma.BankTxnWhereInput = { linkedDocId: null, credit: { gt: 0 }, status: { in: ['review', 'suggested', 'categorised'] } };
const SOURCE_WORDS: Record<SettlementBatch['source'], RegExp> = { razorpay: /RAZORPAY/i, shiprocket_cod: /SHIPROCKET|BIGFOOT/i };
const REVENUE_SUB: Record<SettlementBatch['source'], string> = { razorpay: 'Razorpay', shiprocket_cod: 'Shiprocket COD Remittance' };

async function revenueCategory(tx: Tx, sub: string) {
  const c = await tx.category.findFirst({ where: { name: 'Revenue' }, include: { subCategories: true } });
  if (!c) return null;
  const s = c.subCategories.find((x) => x.name === sub) ?? null;
  return { categoryId: c.id, subCategoryId: s?.id ?? null, nature: s?.natureOverride ?? c.natureDefault };
}

export async function linkBatchRow(tx: Tx, b: SettlementBatch, row: BankTxn, by: string) {
  const cat = await revenueCategory(tx, REVENUE_SUB[b.source]);
  const keep = row.status === 'categorised';
  await tx.bankTxn.update({
    where: { id: row.id },
    data: {
      linkedDocType: 'SettlementBatch', linkedDocId: b.id, partyType: 'other',
      ...(keep || !cat ? {} : { ...cat, status: 'suggested', categorisationReason: `Matched ${b.source === 'razorpay' ? 'Razorpay settlement' : 'Shiprocket remittance'} ${b.externalId} (${by === 'utr' ? 'UTR' : by === 'manual' ? 'linked by hand' : 'amount and date'})` }),
    },
  });
  await tx.settlementBatch.update({ where: { id: b.id }, data: { bankTxnId: row.id, matchedBy: by } });
}

export async function unlinkBankRow(tx: Tx, txnId: string) {
  const row = await tx.bankTxn.findUnique({ where: { id: txnId } });
  if (!row) return;
  const wasSuggestion = row.status === 'suggested' && row.categorisationReason?.startsWith('Matched ');
  await tx.bankTxn.update({
    where: { id: txnId },
    data: { linkedDocType: null, linkedDocId: null, ...(wasSuggestion ? { status: 'review', categoryId: null, subCategoryId: null, nature: null, categorisationReason: null } : {}) },
  });
}

/** One batch to one credit of exactly its net: by UTR first, else in the date window with the gateway's name. */
function pickRow(b: SettlementBatch, rows: BankTxn[], r: Rules): { row: BankTxn; by: string } | null {
  const same = rows.filter((x) => x.credit.equals(b.net));
  const utr = b.utr?.trim().toUpperCase();
  if (utr && utr.length >= 6) {
    const byUtr = same.filter((x) => x.utr?.toUpperCase() === utr || x.narrationRaw.toUpperCase().includes(utr));
    if (byUtr.length === 1) return { row: byUtr[0], by: 'utr' };
  }
  const from = dateText(b.settledOn)!;
  const to = addWorkingDays(from, r.settlementToBankDays + r.graceDays + 2, r.holidays);
  const near = same.filter((x) => dateText(x.txnDate)! >= from && dateText(x.txnDate)! <= to && SOURCE_WORDS[b.source].test(`${x.counterpartyName ?? ''} ${x.narrationRaw}`));
  return near.length === 1 ? { row: near[0], by: 'amount_date' } : null;
}

/** After an import of settlements, or of a statement: link what agrees exactly. */
export async function matchBatches(tx: Tx, r: Rules, txnIds?: string[]): Promise<number> {
  const batches = await tx.settlementBatch.findMany({ where: { bankTxnId: null, net: { gt: 0 } } });
  if (!batches.length) return 0;
  const rows = await tx.bankTxn.findMany({ where: { ...FREE_CREDIT, ...(txnIds ? { id: { in: txnIds } } : {}), credit: { in: [...new Set(batches.map((b) => b.net.toFixed(2)))].map((v) => new Decimal(v)) } } });
  let n = 0;
  const taken = new Set<string>();
  for (const b of batches) {
    const m = pickRow(b, rows.filter((x) => !taken.has(x.id)), r);
    if (!m) continue;
    await linkBatchRow(tx, b, m.row, m.by);
    taken.add(m.row.id);
    n += 1;
  }
  return n;
}

export async function batchCandidates(b: SettlementBatch, r: Rules) {
  const from = shift(dateText(b.settledOn)!, -2);
  const to = addWorkingDays(dateText(b.settledOn)!, r.settlementToBankDays + r.graceDays + 5, r.holidays);
  const rows = await prisma.bankTxn.findMany({ where: { ...FREE_CREDIT, txnDate: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) } }, orderBy: { txnDate: 'asc' } });
  // Same amount first; others in the window can still be linked (the tie-out shows the difference).
  return rows.sort((a, c) => Number(!a.credit.equals(b.net)) - Number(!c.credit.equals(b.net)));
}

// ---------- F195: direct payments ----------

export async function linkOrderRow(tx: Tx, orderNumber: string, row: BankTxn, amount: Decimal, by: string) {
  const company = await getCompany();
  await tx.orderBankLink.create({ data: { entityId: company.id, orderNumber, bankTxnId: row.id, amount, matchedBy: by } });
  if (row.linkedDocId) return; // already carries another order of the same credit
  const cat = await revenueCategory(tx, 'Direct Transfer');
  const keep = row.status === 'categorised';
  await tx.bankTxn.update({
    where: { id: row.id },
    data: {
      linkedDocType: 'CrmOrder', linkedDocId: orderNumber, partyType: 'customer',
      ...(keep || !cat ? {} : { ...cat, status: 'suggested', categorisationReason: `Matched order ${orderNumber} (${by === 'manual' ? 'linked by hand' : 'amount, date and name'})` }),
    },
  });
}

/** New credits that pay a direct order exactly: same amount, within 30 days after the order, name alike. */
export async function matchDirectForTxns(tx: Tx, txnIds: string[]): Promise<number> {
  if (!txnIds.length) return 0;
  const rows = await tx.bankTxn.findMany({ where: { id: { in: txnIds }, ...FREE_CREDIT } });
  if (!rows.length) return 0;
  const days = rows.map((x) => dateText(x.txnDate)!).sort();
  const s = await reconSetting();
  const from = shift(days[0], -30);
  const orders = (await crmOrders({ from: s.trackFrom && dateText(s.trackFrom)! > from ? dateText(s.trackFrom)! : from, to: days[days.length - 1] }))
    .filter((o) => routeOf(o) === 'direct' && !cancelled(o));
  if (!orders.length) return 0;
  const paid = new Set((await tx.orderBankLink.findMany({ where: { isArchived: false, orderNumber: { in: orders.map((o) => o.orderNumber) } } })).map((l) => l.orderNumber));
  let n = 0;
  for (const row of rows) {
    const day = dateText(row.txnDate)!;
    const fits = orders.filter((o) => !paid.has(o.orderNumber) && o.totalAmount.equals(row.credit) && o.orderDate <= day && o.orderDate >= shift(day, -30) && nameSimilarity(row.counterpartyName, [o.customerName]) >= 0.5);
    if (fits.length !== 1) continue;
    await linkOrderRow(tx, fits[0].orderNumber, row, row.credit, 'amount_date_name');
    paid.add(fits[0].orderNumber);
    n += 1;
  }
  return n;
}

/** BR-05 step 1 on statement import: settlements and direct order payments, before the rules. */
export async function matchOrderCreditsForTxns(tx: Tx, txnIds: string[]) {
  if (!txnIds.length) return 0;
  const r = await reconRules();
  return (await matchBatches(tx, r, txnIds)) + (await matchDirectForTxns(tx, txnIds));
}

