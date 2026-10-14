import { parseStatementAmount, parseStatementDate } from '../bank/parsers/statementFile';
import { UserError } from '../lib/http';
import { Decimal } from '../lib/money';
import { headerKey, type Cell } from '../lib/tableFile';

/**
 * F192-F194 files from Razorpay and Shiprocket (no API keys yet, D13 item 7; Finance never calls
 * Shiprocket, Q31). Razorpay dashboard exports: the Payments report (captured payments, refunds so
 * far) and the Settlement Recon report (one row per payment / refund / adjustment in a settlement).
 * Amounts are rupees; Razorpay's fee column includes the GST on the fee, so fee = fee - tax here.
 * Shiprocket's COD remittance report: one row per AWB in a remittance (freight is not deducted, Q24).
 * Column names follow the documented formats and are matched loosely. [Verify] with real files.
 */

type Columns<K extends string> = Record<K, number>;

function columns<K extends string>(header: Cell[], spec: Record<K, string[]>): Columns<K> {
  const keys = header.map(headerKey);
  return Object.fromEntries(Object.entries(spec).map(([k, names]) => [k, keys.findIndex((h) => (names as string[]).includes(h))])) as Columns<K>;
}
const str = (row: Cell[], i: number) => (i >= 0 ? String(row[i] ?? '').trim() : '');
const amt = (row: Cell[], i: number, field: string) => (i >= 0 ? parseStatementAmount(row[i], field) : new Decimal(0));
const two = (d: Decimal) => d.toFixed(2);
const sum = (xs: Decimal[]) => xs.reduce((s, x) => s.plus(x), new Decimal(0));

/** Razorpay writes '09/10/2026 14:23:11', '2026-10-09 14:23:11' or epoch seconds; the business date is IST. */
export function reportDate(value: Cell): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return parseStatementDate(value);
  const s = String(value).trim();
  if (/^\d{9,10}$/.test(s)) return new Date(Number(s) * 1000 + 5.5 * 3600_000).toISOString().slice(0, 10);
  return parseStatementDate(s.split(/[\sT]/)[0]);
}

export type RazorpayPayment = {
  externalId: string; externalOrderId: string | null; method: string | null; status: 'captured' | 'refunded';
  amount: string; fee: string; taxOnFee: string; refunded: string; capturedOn: string;
  /** Text that may name the CRM order: description, notes, order id, e-mail, contact. */
  reference: string; contact: string | null;
};
export type SettlementLineIn = {
  type: 'payment' | 'refund' | 'adjustment' | 'cod'; externalId: string; paymentId: string | null; awb: string | null;
  gross: string; fee: string; taxOnFee: string; refund: string; adjustment: string; net: string; reference: string; happenedOn: string | null;
};
export type SettlementIn = {
  source: 'razorpay' | 'shiprocket_cod'; externalId: string; utr: string | null; settledOn: string;
  gross: string; fees: string; taxOnFees: string; refunds: string; adjustments: string; net: string; lines: SettlementLineIn[];
};

const PAYMENTS = {
  id: ['id', 'paymentid'], amount: ['amount'], status: ['status'], orderId: ['orderid'], method: ['method'], refunded: ['amountrefunded'],
  description: ['description'], notes: ['notes'], email: ['email'], contact: ['contact'], fee: ['fee'], tax: ['tax'], createdAt: ['createdat'],
};
const RECON = {
  entityId: ['entityid'], type: ['type'], debit: ['debit'], credit: ['credit'], amount: ['amount'], fee: ['fee'], tax: ['tax'],
  createdAt: ['createdat'], settledAt: ['settledat'], settlementId: ['settlementid'], utr: ['settlementutr', 'utr'], paymentId: ['paymentid'],
  orderId: ['orderid'], receipt: ['orderreceipt', 'receipt'], description: ['description'], notes: ['notes'],
};

export function parseRazorpayTable(table: Cell[][]): { kind: 'payments'; payments: RazorpayPayment[]; skipped: number } | { kind: 'settlements'; settlements: SettlementIn[] } {
  const headerAt = table.findIndex((r) => r.map(headerKey).includes('settlementid') || (r.map(headerKey).includes('id') && r.map(headerKey).includes('status')));
  if (headerAt < 0) throw new UserError('This is not a Razorpay Payments or Settlement Recon report (no id / settlement_id column)');
  const header = table[headerAt];
  const body = table.slice(headerAt + 1).filter((r) => r.some((c) => String(c ?? '').trim()));

  if (header.map(headerKey).includes('settlementid')) {
    const c = columns(header, RECON);
    if (c.entityId < 0 || c.type < 0 || c.settledAt < 0) throw new UserError('The Settlement Recon report needs entity_id, type, settled_at and settlement_id columns');
    const groups = new Map<string, { utr: string | null; settledOn: string; lines: SettlementLineIn[] }>();
    body.forEach((r, i) => {
      const line = `Row ${headerAt + i + 2}`;
      const settlementId = str(r, c.settlementId);
      if (!settlementId) return; // not settled yet
      const settledOn = reportDate(r[c.settledAt]);
      if (!settledOn) throw new UserError(`${line}: settled_at is not a date`);
      const raw = str(r, c.type).toLowerCase();
      const type = raw === 'payment' ? 'payment' : raw === 'refund' ? 'refund' : 'adjustment';
      const debit = amt(r, c.debit, `${line} debit`);
      const credit = amt(r, c.credit, `${line} credit`);
      const amount = amt(r, c.amount, `${line} amount`);
      const tax = amt(r, c.tax, `${line} tax`);
      const feeWithTax = amt(r, c.fee, `${line} fee`);
      const net = credit.minus(debit);
      const l: SettlementLineIn = {
        type, externalId: str(r, c.entityId), paymentId: type === 'payment' ? str(r, c.entityId) : (str(r, c.paymentId) || null), awb: null,
        gross: two(type === 'payment' ? amount : new Decimal(0)), fee: two(feeWithTax.minus(tax)), taxOnFee: two(tax),
        refund: two(type === 'refund' ? debit : new Decimal(0)), adjustment: two(type === 'adjustment' ? net : new Decimal(0)), net: two(net),
        reference: [str(r, c.receipt), str(r, c.orderId), str(r, c.description), str(r, c.notes)].filter(Boolean).join(' '),
        happenedOn: reportDate(c.createdAt >= 0 ? r[c.createdAt] : null),
      };
      const g = groups.get(settlementId) ?? { utr: str(r, c.utr) || null, settledOn, lines: [] };
      g.lines.push(l);
      groups.set(settlementId, g);
    });
    if (!groups.size) throw new UserError('No settled rows in this report');
    return { kind: 'settlements', settlements: [...groups.entries()].map(([externalId, g]) => totals('razorpay', externalId, g.utr, g.settledOn, g.lines)) };
  }

  const c = columns(header, PAYMENTS);
  if (c.amount < 0 || c.createdAt < 0) throw new UserError('The Payments report needs id, amount, status and created_at columns');
  let skipped = 0;
  const payments: RazorpayPayment[] = [];
  body.forEach((r, i) => {
    const line = `Row ${headerAt + i + 2}`;
    const status = str(r, c.status).toLowerCase();
    // Failed and created-but-unpaid attempts never reach the bank.
    if (status !== 'captured' && status !== 'refunded') { skipped += 1; return; }
    const capturedOn = reportDate(r[c.createdAt]);
    if (!capturedOn) throw new UserError(`${line}: created_at is not a date`);
    const tax = amt(r, c.tax, `${line} tax`);
    payments.push({
      externalId: str(r, c.id), externalOrderId: str(r, c.orderId) || null, method: str(r, c.method) || null, status,
      amount: two(amt(r, c.amount, `${line} amount`)), fee: two(amt(r, c.fee, `${line} fee`).minus(tax)), taxOnFee: two(tax),
      refunded: two(amt(r, c.refunded, `${line} amount_refunded`)), capturedOn,
      reference: [str(r, c.description), str(r, c.notes), str(r, c.orderId), str(r, c.email)].filter(Boolean).join(' '),
      contact: str(r, c.contact) || null,
    });
  });
  return { kind: 'payments', payments, skipped };
}

function totals(source: SettlementIn['source'], externalId: string, utr: string | null, settledOn: string, lines: SettlementLineIn[]): SettlementIn {
  const s = (k: keyof Pick<SettlementLineIn, 'gross' | 'fee' | 'taxOnFee' | 'refund' | 'adjustment' | 'net'>) => two(sum(lines.map((l) => new Decimal(l[k]))));
  return { source, externalId, utr, settledOn, gross: s('gross'), fees: s('fee'), taxOnFees: s('taxOnFee'), refunds: s('refund'), adjustments: s('adjustment'), net: s('net'), lines };
}

const SHIPROCKET = {
  awb: ['awb', 'awbcode', 'awbno', 'awbnumber'], order: ['orderid', 'channelorderid', 'orderno', 'ordernumber'],
  amount: ['codamount', 'remittedamount', 'collectableamount', 'amount'], batch: ['crfid', 'remittanceid', 'batchid', 'remittanceno'],
  date: ['remittancedate', 'remitteddate', 'remittedon', 'date'], utr: ['utr', 'utrno', 'utrnumber', 'bankreference', 'referenceno'],
};

export function parseShiprocketTable(table: Cell[][]): SettlementIn[] {
  const headerAt = table.findIndex((r) => r.map(headerKey).some((h) => SHIPROCKET.awb.includes(h)));
  if (headerAt < 0) throw new UserError('No AWB column found: upload Shiprocket\'s COD remittance report with AWB-level rows');
  const c = columns(table[headerAt], SHIPROCKET);
  if (c.amount < 0 || c.date < 0) throw new UserError('The remittance report needs AWB, COD amount and remittance date columns');
  const groups = new Map<string, { utr: string | null; settledOn: string; lines: SettlementLineIn[] }>();
  table.slice(headerAt + 1).forEach((r, i) => {
    const awb = str(r, c.awb);
    if (!awb) return;
    const line = `Row ${headerAt + i + 2}`;
    const settledOn = reportDate(r[c.date]);
    if (!settledOn) throw new UserError(`${line}: remittance date is not a date`);
    const utr = str(r, c.utr) || null;
    const key = str(r, c.batch) || utr || `COD-${settledOn}`;
    const gross = amt(r, c.amount, `${line} COD amount`);
    const g = groups.get(key) ?? { utr, settledOn, lines: [] };
    g.lines.push({ type: 'cod', externalId: awb, paymentId: null, awb, gross: two(gross), fee: '0.00', taxOnFee: '0.00', refund: '0.00', adjustment: '0.00', net: two(gross), reference: str(r, c.order), happenedOn: null });
    groups.set(key, g);
  });
  if (!groups.size) throw new UserError('No AWB rows in this file');
  return [...groups.entries()].map(([externalId, g]) => totals('shiprocket_cod', externalId, g.utr, g.settledOn, g.lines));
}
