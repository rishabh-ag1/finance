import { prisma } from '../config/database';
import type { AuditContext } from '../lib/audit';
import { dateText } from '../lib/dates';
import { UserError } from '../lib/http';
import { linkReimbursementRow } from './claim.service';
import { linkCapital, linkLoan, linkRepayment } from './funding.service';
import { linkBankRow as linkPaymentRow } from './payment.service';
import { linkReceiptRow } from './receivables.service';
import { linkSettlementRow } from './recon.service';
import { linkChallanBankRow } from './tds.service';

/**
 * F020: link one bank row to whatever document it stands for: a vendor payment, a founder
 * reimbursement, a TDS challan, a loan repayment (debits); a customer receipt, capital, a loan
 * received or a Razorpay / COD settlement (credits). Same amount, within 15 days, not yet linked.
 * Each link runs through the document's own module, so its status and the row's category follow.
 */

export const LINK_TYPES = ['payment', 'reimbursement', 'challan', 'repayment', 'receipt', 'capital', 'loan', 'settlement'] as const;
export type LinkType = (typeof LINK_TYPES)[number];
const DAY = 86_400_000;

export async function documentsForRow(txnId: string) {
  const t = await prisma.bankTxn.findUnique({ where: { id: txnId } });
  if (!t) throw new UserError('Bank row not found', 404);
  if (t.linkedDocId) return { linked: { type: t.linkedDocType, id: t.linkedDocId }, options: [] };
  const near = { gte: new Date(t.txnDate.getTime() - 15 * DAY), lte: new Date(t.txnDate.getTime() + 15 * DAY) };
  const out: { type: LinkType; id: string; label: string; date: string | null; amount: string }[] = [];
  if (t.debit.greaterThan(0)) {
    const amt = t.debit;
    for (const p of await prisma.paymentOut.findMany({ where: { status: 'paid', bankTxnId: null, amount: amt, paidDate: near }, include: { vendor: true } })) out.push({ type: 'payment', id: p.id, label: `Payment ${p.paymentNo} to ${p.vendor.displayName}`, date: dateText(p.paidDate), amount: p.amount.toFixed(2) });
    for (const r of await prisma.reimbursement.findMany({ where: { status: 'paid', bankTxnId: null, amount: amt, paidDate: near } })) out.push({ type: 'reimbursement', id: r.id, label: `Reimbursement ${r.reimbursementNo}`, date: dateText(r.paidDate), amount: r.amount.toFixed(2) });
    for (const c of await prisma.tdsChallan.findMany({ where: { isCancelled: false, bankTxnId: null, total: amt, depositDate: near } })) out.push({ type: 'challan', id: c.id, label: `TDS challan ${c.bsrCode}-${c.challanSerial}`, date: dateText(c.depositDate), amount: c.total.toFixed(2) });
    for (const r of await prisma.loanRepayment.findMany({ where: { status: 'recorded', bankTxnId: null, paidDate: near }, include: { loan: true } })) {
      if (r.principal.plus(r.interest).equals(amt)) out.push({ type: 'repayment', id: r.id, label: `Loan repayment to ${r.loan.lender}`, date: dateText(r.paidDate), amount: amt.toFixed(2) });
    }
  } else {
    const amt = t.credit;
    for (const r of await prisma.receipt.findMany({ where: { status: 'recorded', source: 'manual', bankTxnId: null, mode: { not: 'cash' }, amount: amt, receiptDate: near } })) out.push({ type: 'receipt', id: r.id, label: `Receipt ${r.receiptNo} from ${r.customerName}`, date: dateText(r.receiptDate), amount: r.amount.toFixed(2) });
    for (const c of await prisma.capitalReceipt.findMany({ where: { status: 'recorded', bankTxnId: null, amount: amt, receiptDate: near } })) out.push({ type: 'capital', id: c.id, label: `Capital from ${c.holderName}`, date: dateText(c.receiptDate), amount: c.amount.toFixed(2) });
    for (const l of await prisma.loan.findMany({ where: { status: { not: 'cancelled' }, bankTxnId: null, disbursedAmount: amt, disbursedDate: near } })) out.push({ type: 'loan', id: l.id, label: `Loan from ${l.lender}`, date: dateText(l.disbursedDate), amount: l.disbursedAmount.toFixed(2) });
    for (const b of await prisma.settlementBatch.findMany({ where: { bankTxnId: null, net: amt, settledOn: near } })) out.push({ type: 'settlement', id: b.id, label: `${b.source === 'razorpay' ? 'Razorpay settlement' : 'COD remittance'} ${b.externalId}`, date: dateText(b.settledOn), amount: b.net.toFixed(2) });
  }
  return { linked: null, options: out.sort((a, b) => Math.abs(Date.parse(a.date ?? '') - t.txnDate.getTime()) - Math.abs(Date.parse(b.date ?? '') - t.txnDate.getTime())) };
}

export async function linkRowTo(ctx: AuditContext, txnId: string, type: LinkType, id: string) {
  const c = { ...ctx, reason: ctx.reason ?? 'Linked from the bank ledger' };
  switch (type) {
    case 'payment': await linkPaymentRow(c, id, txnId); break;
    case 'reimbursement': await linkReimbursementRow(c, id, txnId); break;
    case 'challan': await linkChallanBankRow(c, id, txnId); break;
    case 'repayment': await linkRepayment(c, id, txnId); break;
    case 'receipt': await linkReceiptRow(c, id, txnId); break;
    case 'capital': await linkCapital(c, id, txnId); break;
    case 'loan': await linkLoan(c, id, txnId); break;
    case 'settlement': await linkSettlementRow(c, id, txnId); break;
    default: throw new UserError('Choose what the row is');
  }
  const t = await prisma.bankTxn.findUniqueOrThrow({ where: { id: txnId } });
  return { linkedDocType: t.linkedDocType, linkedDocId: t.linkedDocId, status: t.status };
}
