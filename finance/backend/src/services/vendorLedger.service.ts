import { prisma } from '../config/database';
import { dateText, parseDate } from '../lib/dates';
import { fyLabel, todayIST } from '../lib/fy';
import { UserError } from '../lib/http';
import { Decimal } from '../lib/money';
import type { StatementLine } from '../pdf/statement';
import { getCompany } from './settings.service';

/**
 * F038 Vendor 360: POs, bills, payments, advances, TDS deducted and what is owed for one vendor,
 * and a statement (bills against payments, TDS and credit notes, with a running balance) to
 * reconcile with the vendor's own ledger.
 */

const zero = () => new Decimal(0);
const sum = <T>(xs: T[], f: (x: T) => Decimal) => xs.reduce((s, x) => s.plus(f(x)), zero());
const BILLS = ['tax_invoice', 'debit_note', 'credit_note'] as const;

export async function vendorOverview(vendorId: string) {
  const v = await prisma.vendor.findUnique({ where: { id: vendorId } });
  if (!v) throw new UserError('Vendor not found', 404);
  const pos = await prisma.purchaseOrder.findMany({ where: { vendorId, status: { not: 'cancelled' } }, orderBy: { poDate: 'desc' } });
  const docs = await prisma.vendorDocument.findMany({ where: { vendorId, status: { notIn: ['cancelled'] } }, orderBy: { docDate: 'desc' } });
  const payments = await prisma.paymentOut.findMany({ where: { vendorId, status: { in: ['paid', 'reconciled'] } }, include: { allocations: { where: { isArchived: false } } }, orderBy: { paidDate: 'desc' } });
  const tds = await prisma.tdsEntry.findMany({ where: { vendorId, status: { not: 'cancelled' } } });
  const today = todayIST();
  const owed = docs.filter((d) => d.docType === 'tax_invoice' || d.docType === 'debit_note');
  const advances = sum(payments.flatMap((p) => p.allocations), (a) => {
    const d = a.docId ? docs.find((x) => x.id === a.docId) : null;
    const isAdvance = a.poId ? !a.appliedToDocId : d ? (d.docType === 'quote' || d.docType === 'proforma') && !a.appliedToDocId : false;
    return isAdvance ? a.amount : zero();
  });
  const byFy = new Map<string, Decimal>();
  for (const t of tds) byFy.set(t.fyLabel, (byFy.get(t.fyLabel) ?? zero()).plus(t.tdsAmount));
  return {
    outstanding: sum(owed, (d) => d.outstanding).toFixed(2),
    overdue: sum(owed.filter((d) => d.dueDate && dateText(d.dueDate)! < today && d.outstanding.greaterThan(0)), (d) => d.outstanding).toFixed(2),
    advances: advances.toFixed(2),
    paidThisFy: sum(payments.filter((p) => p.paidDate && fyLabel(dateText(p.paidDate)!) === fyLabel(today)), (p) => p.amount).toFixed(2),
    tdsByFy: [...byFy.entries()].sort().reverse().map(([fy, amount]) => ({ fy, amount: amount.toFixed(2) })),
    purchaseOrders: pos.slice(0, 50).map((p) => ({ id: p.id, poNumber: p.poNumber, poDate: dateText(p.poDate), total: p.total.toFixed(2), billed: p.billedTotal.toFixed(2), status: p.status })),
    documents: docs.slice(0, 100).map((d) => ({ id: d.id, docType: d.docType, docNumber: d.docNumber, docDate: dateText(d.docDate), dueDate: dateText(d.dueDate), total: d.totalValue.toFixed(2), outstanding: d.outstanding.toFixed(2), status: d.status })),
    payments: payments.slice(0, 50).map((p) => ({ id: p.id, paymentNo: p.paymentNo, paidDate: dateText(p.paidDate), amount: p.amount.toFixed(2), tds: p.tdsAmount.toFixed(2), inBank: p.status === 'reconciled' })),
  };
}

/** Vendor statement: bills raise what is owed; payments, TDS deducted and credit notes reduce it. */
export async function vendorStatement(vendorId: string, from: string, to: string) {
  const v = await prisma.vendor.findUnique({ where: { id: vendorId } });
  if (!v) throw new UserError('Vendor not found', 404);
  const end = parseDate(to, 'To');
  const docs = await prisma.vendorDocument.findMany({ where: { vendorId, docType: { in: [...BILLS] }, status: { notIn: ['cancelled', 'replaced'] }, docDate: { lte: end } } });
  const payments = await prisma.paymentOut.findMany({ where: { vendorId, status: { in: ['paid', 'reconciled'] }, paidDate: { lte: end } } });
  const tds = await prisma.tdsEntry.findMany({ where: { vendorId, status: { not: 'cancelled' }, deductionDate: { lte: end } } });
  const sections = new Map((await prisma.tdsSection.findMany()).map((s) => [s.id, s.codeOldAct]));
  type Item = { date: string; kind: string; ref: string; detail: string; debit: Decimal; credit: Decimal };
  const items: Item[] = [
    ...docs.map((d): Item => ({ date: dateText(d.docDate)!, kind: d.docType, ref: d.docNumber, detail: d.docType === 'credit_note' ? 'Credit note' : d.docType === 'debit_note' ? 'Debit note' : 'Tax invoice', debit: d.docType === 'credit_note' ? zero() : d.totalValue, credit: d.docType === 'credit_note' ? d.totalValue : zero() })),
    ...payments.map((p): Item => ({ date: dateText(p.paidDate)!, kind: 'payment', ref: p.paymentNo ?? '', detail: `Paid${p.mode ? ` by ${p.mode.toUpperCase()}` : ''}${p.utr ? ` (${p.utr})` : ''}`, debit: zero(), credit: p.amount })),
    ...tds.map((t): Item => ({ date: dateText(t.deductionDate)!, kind: 'tds', ref: `TDS ${sections.get(t.sectionId) ?? ''}`.trim(), detail: `TDS deducted at ${t.rate.toString()}% on ${t.baseAmount.toFixed(2)}`, debit: zero(), credit: t.tdsAmount })),
  ].sort((a, b) => (a.date === b.date ? (a.debit.greaterThan(0) ? -1 : 1) : a.date < b.date ? -1 : 1));
  let balance = sum(items.filter((x) => x.date < from), (x) => x.debit.minus(x.credit));
  const opening = balance;
  const lines: StatementLine[] = items.filter((x) => x.date >= from).map((x) => {
    balance = balance.plus(x.debit).minus(x.credit);
    return { date: x.date, kind: x.kind, ref: x.ref, detail: x.detail, debit: x.debit.toFixed(2), credit: x.credit.toFixed(2), balance: balance.toFixed(2) };
  });
  return { vendor: { id: v.id, name: v.legalName ?? v.displayName, gstin: v.gstin, pan: v.pan }, from, to, opening: opening.toFixed(2), closing: balance.toFixed(2), lines };
}

export async function vendorStatementPdf(vendorId: string, from: string, to: string) {
  const s = await vendorStatement(vendorId, from, to);
  const company = await getCompany();
  const { statementHtml } = await import('../pdf/statement');
  const { renderPdf } = await import('../pdf/render');
  const owed = Number(s.closing);
  return {
    pdf: await renderPdf(statementHtml({
      company: { legalName: company.legalName, address: company.registeredAddress, gstin: company.gstin ?? '', email: company.email }, customer: { name: s.vendor.name, gstins: s.vendor.gstin ? [s.vendor.gstin] : [] },
      from, to, opening: s.opening, closing: s.closing, outstanding: s.closing, advances: '0', lines: s.lines,
      labels: { debit: 'Billed', credit: 'Paid / TDS / credit notes', footer: owed >= 0 ? `A positive balance is owed by ${company.legalName} to the vendor. TDS is deducted on the vendor's behalf and deposited with the government.` : `A negative balance is an advance paid to the vendor.` },
    })),
    name: `Statement ${s.vendor.name} ${from} to ${to}.pdf`,
  };
}
