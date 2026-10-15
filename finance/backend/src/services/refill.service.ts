import { prisma } from '../config/database';
import { crmCompanies } from '../crm/reader';
import { invProducts } from '../inventory/reader';
import { withAudit, type AuditContext } from '../lib/audit';
import { dateText, parseDate } from '../lib/dates';
import { todayIST } from '../lib/fy';
import { UserError } from '../lib/http';
import { Decimal } from '../lib/money';
import { createDoc } from './sales.service';

/**
 * F099 Sachet refill plans: per outlet, a product, quantity and cycle. Each due cycle drafts a tax
 * invoice for a founder to check and issue. Finance never writes to the CRM, so the dispatch order
 * for a refill is still made in the CRM by sales (the draft shows on the "Refills due" list).
 */

/** The same day n months later, kept inside the month (31 Jan + 1 month = 28 Feb). */
export function addMonths(day: string, n: number) {
  const [y, m, d] = day.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

export type RefillInput = { crmCompanyId: string; crmBranchId: string; invProductId: string; qty: string; rate?: string | null; everyMonths: number; nextDate: string; isActive?: boolean; notes?: string | null };

function check(i: RefillInput) {
  if (!/^\d{1,9}(\.\d{1,3})?$/.test(i.qty) || Number(i.qty) <= 0) throw new UserError('Enter the quantity per refill');
  if (i.rate && (!/^\d{1,12}(\.\d{1,2})?$/.test(i.rate) || Number(i.rate) <= 0)) throw new UserError('The rate is not a valid amount');
  if (!Number.isInteger(i.everyMonths) || i.everyMonths < 1 || i.everyMonths > 12) throw new UserError('Choose a cycle of 1 to 12 months');
}

export async function listPlans(f: { companyId?: string } = {}) {
  const plans = await prisma.refillPlan.findMany({ where: f.companyId ? { crmCompanyId: f.companyId } : {}, orderBy: [{ isActive: 'desc' }, { nextDate: 'asc' }] });
  const companies = new Map((await crmCompanies({ ids: [...new Set(plans.map((p) => p.crmCompanyId))] })).map((c) => [c.id, c]));
  const products = new Map((await invProducts({ ids: [...new Set(plans.map((p) => p.invProductId))] })).map((p) => [p.id, p]));
  const drafts = await prisma.salesDocument.findMany({ where: { refillPlanId: { in: plans.map((p) => p.id) }, status: { not: 'discarded' } }, orderBy: { docDate: 'desc' } });
  const today = todayIST();
  return plans.map((p) => {
    const c = companies.get(p.crmCompanyId);
    const last = drafts.find((d) => d.refillPlanId === p.id);
    return {
      id: p.id, crmCompanyId: p.crmCompanyId, crmBranchId: p.crmBranchId, companyName: c?.name ?? '(not in the CRM)', outletName: c?.branches.find((b) => b.id === p.crmBranchId)?.name ?? '',
      invProductId: p.invProductId, productName: products.get(p.invProductId)?.name ?? '(not in bloc-inv)', qty: p.qty.toString(), rate: p.rate?.toFixed(2) ?? null,
      everyMonths: p.everyMonths, nextDate: dateText(p.nextDate), isActive: p.isActive, notes: p.notes, due: p.isActive && dateText(p.nextDate)! <= today,
      lastDoc: last ? { id: last.id, docNumber: last.docNumber, status: last.status, docDate: dateText(last.docDate) } : null,
    };
  });
}

async function validRefs(i: RefillInput) {
  const c = (await crmCompanies({ ids: [i.crmCompanyId] }))[0];
  if (!c) throw new UserError('Customer not found in the CRM');
  if (!c.branches.some((b) => b.id === i.crmBranchId)) throw new UserError('Choose one of the customer\'s outlets');
  if (!(await invProducts({ ids: [i.invProductId] })).length) throw new UserError('That product is not in bloc-inv');
}

export async function savePlan(ctx: AuditContext, id: string | null, i: RefillInput) {
  check(i);
  await validRefs(i);
  const data = {
    crmCompanyId: i.crmCompanyId, crmBranchId: i.crmBranchId, invProductId: i.invProductId, qty: new Decimal(i.qty), rate: i.rate ? new Decimal(i.rate) : null,
    everyMonths: i.everyMonths, nextDate: parseDate(i.nextDate, 'Next refill date'), isActive: i.isActive ?? true, notes: i.notes?.trim() || null,
  };
  await withAudit({ ...ctx, reason: ctx.reason ?? (id ? 'Refill plan changed' : 'Refill plan added') }, (tx) =>
    id ? tx.refillPlan.update({ where: { id }, data }) : tx.refillPlan.create({ data }));
  return listPlans();
}

/** Draft a tax invoice for every plan due by today, and move each plan to its next cycle. */
export async function draftDueRefills(ctx: AuditContext, today = todayIST()) {
  const due = await prisma.refillPlan.findMany({ where: { isActive: true, nextDate: { lte: parseDate(today) } }, orderBy: { nextDate: 'asc' } });
  const made: { planId: string; docId: string }[] = [];
  const failed: { planId: string; error: string }[] = [];
  for (const p of due) {
    try {
      const doc = await createDoc({ ...ctx, reason: `Refill plan: cycle of ${dateText(p.nextDate)}` }, {
        docType: 'tax_invoice', docDate: today, customer: { kind: 'outlet', companyId: p.crmCompanyId, branchId: p.crmBranchId },
        notes: `Sachet refill for the cycle of ${dateText(p.nextDate)}`, lines: [{ invProductId: p.invProductId, qty: p.qty.toString(), rate: p.rate?.toFixed(2) ?? null }],
      }, { source: 'refill', refillPlanId: p.id });
      await withAudit({ ...ctx, reason: 'Refill drafted: next cycle set' }, (tx) => tx.refillPlan.update({ where: { id: p.id }, data: { nextDate: parseDate(addMonths(dateText(p.nextDate)!, p.everyMonths)) } }));
      made.push({ planId: p.id, docId: doc.id });
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      failed.push({ planId: p.id, error: e.message });
    }
  }
  return { made, failed };
}
