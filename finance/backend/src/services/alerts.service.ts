import { prisma } from '../config/database';
import { formatINR } from '../lib/money';
import { todayIST } from '../lib/fy';
import { hasPermission } from '../lib/permissions';
import type { AuthUser } from './auth.service';
import { expectedLoanPayments, fundingOverview } from './funding.service';
import { dueList } from './payment.service';
import { outstandingList } from './receivables.service';
import { moneyInTransit, openDiscrepancyCount } from './recon.service';
import { payable as tdsPayable } from './tds.service';

/**
 * F173 in-app alerts: what needs a person now, for the modules the user can see. Shown as a bell
 * in the header. E-mail digests wait for the mail account (D13 item 6).
 */

export type Alert = { key: string; tone: 'red' | 'amber' | 'blue'; text: string; to: string };
const DAY = 86_400_000;
const shift = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

export async function alertsFor(user: AuthUser): Promise<Alert[]> {
  const can = (m: string) => hasPermission(user.role?.permissions, m, 'view');
  const today = todayIST();
  const out: Alert[] = [];
  const safe = async (f: () => Promise<void>) => { try { await f(); } catch (e) { console.error('Alert left out:', e); } };

  if (can('financePayments')) await safe(async () => {
    const requested = await prisma.paymentOut.count({ where: { status: 'requested' } });
    if (requested) out.push({ key: 'payments-approval', tone: 'amber', text: `${requested} payment request(s) waiting for approval`, to: '/payables?tab=payments' });
    const due = await dueList();
    if (due.totals.msmeAtRisk) out.push({ key: 'msme', tone: 'red', text: `${due.totals.msmeAtRisk} MSME bill(s) near or past 45 days`, to: '/payables?tab=due' });
    if (due.totals.overdue !== '0.00') out.push({ key: 'payables-overdue', tone: 'amber', text: `Bills overdue: ${formatINR(due.totals.overdue ?? '0')}`, to: '/payables?tab=due' });
  });
  if (can('financePurchases')) await safe(async () => {
    const n = await prisma.purchaseOrder.count({ where: { status: 'pending_approval' } });
    if (n) out.push({ key: 'po-approval', tone: 'amber', text: `${n} purchase order(s) waiting for approval`, to: '/purchase-orders' });
  });
  if (can('financeClaims')) await safe(async () => {
    const n = await prisma.expenseClaim.count({ where: { status: 'submitted', founderUserId: { not: user.id } } });
    if (n) out.push({ key: 'claims', tone: 'amber', text: `${n} founder claim(s) for you to approve`, to: '/claims' });
  });
  if (can('financeTds')) await safe(async () => {
    for (const m of await tdsPayable()) {
      if (!m.dueDate || m.dueDate > shift(today, 3)) continue;
      out.push({ key: `tds-${m.month}`, tone: m.dueDate < today ? 'red' : 'amber', text: `TDS for ${m.month.slice(0, 7)} (${formatINR(m.amount ?? '0')}) ${m.dueDate < today ? 'was due' : 'is due'} on ${m.dueDate}`, to: '/tds' });
    }
  });
  if (can('financeReceivables')) await safe(async () => {
    const o = await outstandingList({ overdueOnly: true });
    if (o.rows.length) out.push({ key: 'invoices-overdue', tone: 'amber', text: `${o.rows.length} invoice(s) overdue: ${formatINR(o.totals.overdue ?? '0')}`, to: '/receivables?tab=outstanding' });
  });
  if (can('financeBank')) await safe(async () => {
    const accounts = await prisma.bankAccount.findMany({ where: { isArchived: false, owner: 'Entelechy', parserFormat: { not: null } } });
    for (const a of accounts) {
      const last = await prisma.bankImportBatch.findFirst({ where: { bankAccountId: a.id }, orderBy: { importedAt: 'desc' } });
      if (!last || Date.now() - last.importedAt.getTime() > 7 * DAY) out.push({ key: `stale-${a.id}`, tone: 'blue', text: `${a.bankName} ${a.accountNumber.slice(-4)}: no statement imported for 7+ days`, to: '/import' });
    }
    const review = await prisma.bankTxn.count({ where: { status: 'review' } });
    if (review) out.push({ key: 'review', tone: 'blue', text: `${review} bank row(s) to review`, to: '/review' });
  });
  if (can('financeFunding')) await safe(async () => {
    for (const x of await expectedLoanPayments()) {
      if (x.date > shift(today, 7)) continue;
      out.push({ key: `loan-${x.loanId}-${x.date}`, tone: x.date < today ? 'red' : 'amber', text: `${x.label}: ${formatINR(x.amount)} ${x.date < today ? 'was due' : 'due'} ${x.date}`, to: `/funding/loans/${x.loanId}` });
    }
    const f = await fundingOverview();
    if (f.covenant.breached) out.push({ key: 'covenant', tone: 'red', text: 'Total debt is above the Mesa cap', to: '/funding' });
    if (f.capital.allotmentOverdue.length) out.push({ key: 'allotment', tone: 'amber', text: `${f.capital.allotmentOverdue.length} share application amount(s) not allotted in 60 days`, to: '/funding?tab=capital' });
  });
  if (can('financeOrders')) await safe(async () => {
    const t = await moneyInTransit();
    const overdue = [t.paidAtGateway, t.deliveredAwaitingRemittance, t.settledNotInBank, t.remittedNotInBank].reduce((n, x) => n + x.overdue, 0);
    if (overdue) out.push({ key: 'transit', tone: 'amber', text: `${overdue} order payment(s) overdue from Razorpay, Shiprocket or the bank`, to: '/order-to-bank' });
    const d = await openDiscrepancyCount();
    if (d) out.push({ key: 'discrepancies', tone: 'amber', text: `${d} order-to-bank mismatch(es) to look at`, to: '/order-to-bank?tab=discrepancies' });
  });
  if (can('financeSales')) await safe(async () => {
    const fix = await prisma.d2cOrderInvoice.count({ where: { state: 'fix' } });
    if (fix) out.push({ key: 'd2c-fix', tone: 'amber', text: `${fix} D2C order(s) could not be invoiced`, to: '/sales/d2c' });
    const rto = await prisma.salesDocument.count({ where: { docType: 'credit_note', status: 'draft', source: 'rto' } });
    if (rto) out.push({ key: 'rto', tone: 'blue', text: `${rto} RTO credit note(s) to review and issue`, to: '/sales?docType=credit_note&status=draft' });
  });
  const rank = { red: 0, amber: 1, blue: 2 };
  return out.sort((a, b) => rank[a.tone] - rank[b.tone]).map((a) => ({ ...a, text: a.text.replace(/(\d{4}-\d{2}-\d{2})/g, (m) => new Date(`${m}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })) }));
}
