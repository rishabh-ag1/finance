import type { CustomerProfile, PriceList, PriceListItem } from '@prisma/client';
import { prisma } from '../config/database';
import { crmCompanies, crmCompany, crmOrders, type CrmBranch, type CrmCompany } from '../crm/reader';
import { invProducts, type InvProduct } from '../inventory/reader';
import { withAudit, type AuditContext } from '../lib/audit';
import { exclusiveRate, priceFor, resolveProfile, type ProfileFields } from '../lib/customers';
import { dateText, parseDate } from '../lib/dates';
import { todayIST } from '../lib/fy';
import { GST_STATE_CODES, stateCodeFromName, validateGstinChecksum } from '../lib/gstin';
import { UserError } from '../lib/http';
import { Decimal, moneyText } from '../lib/money';
import { getCompany } from './settings.service';

/**
 * M08 Customers (F080-F083) and M11 Products & price lists (F120, F121).
 * Customers are the CRM's companies and outlets, read through the CRM reader; Finance only keeps
 * its own fields for them (customer profile). Products are bloc-inv's, read through the Inventory
 * reader; Finance keeps price lists. Finance never creates a customer or product of its own.
 */

export const CHANNELS = ['horeca', 'distributor', 'marketplace', 'd2c'] as const;
export const CHANNEL_LABEL: Record<string, string> = { horeca: 'HoReCa', distributor: 'Distributor', marketplace: 'Marketplace', d2c: 'D2C' };
export const PRICE_LIST_KINDS = ['mrp', 'horeca', 'distributor', 'marketplace', 'other'] as const;
export const PRICE_LIST_KIND_LABEL: Record<string, string> = { mrp: 'MRP', horeca: 'HoReCa', distributor: 'Distributor', marketplace: 'Marketplace', other: 'Other' };
/** Customers are charged GST at 18% (Q29); a product carrying another rate is flagged. */
export const SALES_GST_RATE = new Decimal(18);

const text = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
const keyOf = (companyId: string, branchId: string | null) => `${companyId}:${branchId ?? '-'}`;
const DAY = 86_400_000;
const shift = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

function fields(p: CustomerProfile | undefined | null): ProfileFields | null {
  if (!p) return null;
  return { paymentTermId: p.paymentTermId, creditLimit: p.creditLimit, invoiceEmails: p.invoiceEmails, deductsTds: p.deductsTds, tdsSectionId: p.tdsSectionId, priceListId: p.priceListId, channel: p.channel, billToBranchId: p.billToBranchId };
}

async function lookups() {
  const [terms, sections, lists] = await Promise.all([
    prisma.paymentTerm.findMany(), prisma.tdsSection.findMany(), prisma.priceList.findMany(),
  ]);
  return {
    terms: new Map(terms.map((t) => [t.id, t])), onDelivery: terms.find((t) => t.label === 'On delivery')?.id ?? null,
    sections: new Map(sections.map((t) => [t.id, t])), lists: new Map(lists.map((l) => [l.id, l])),
  };
}

/** What Finance knows about one outlet: its GSTIN check, state code and resolved profile. */
function outletView(b: CrmBranch, company: CustomerProfile | undefined, own: CustomerProfile | undefined, l: Awaited<ReturnType<typeof lookups>>) {
  const r = resolveProfile(fields(company), fields(own), { onDelivery: l.onDelivery });
  const gst = b.gstNumber?.trim() ? validateGstinChecksum(b.gstNumber) : null;
  const stateCode = gst?.valid ? gst.normalized.slice(0, 2) : stateCodeFromName(b.state);
  return {
    id: b.id, name: b.name, address: [b.addressLine1, b.addressLine2, b.city, b.pincode].filter(Boolean).join(', '), state: b.state,
    stateCode, stateName: stateCode ? GST_STATE_CODES[stateCode] : null, gstin: b.gstNumber?.trim() || null,
    gstinProblem: gst && !gst.valid ? gst.reason : null,
    /** BR-49: an outlet with a valid GSTIN gets B2B invoices; without one, B2C (and sales should capture it). */
    invoiceType: gst?.valid ? 'B2B' : 'B2C',
    isActive: b.isActive,
    hasOwnProfile: !!own,
    profile: profileView(r, l),
    own: own ? rawView(own) : null,
  };
}

function profileView(r: ReturnType<typeof resolveProfile>, l: Awaited<ReturnType<typeof lookups>>) {
  return {
    paymentTermId: r.paymentTermId, paymentTerms: r.paymentTermId ? l.terms.get(r.paymentTermId)?.label ?? null : null,
    creditLimit: moneyText(r.creditLimit), invoiceEmails: r.invoiceEmails, deductsTds: r.deductsTds,
    tdsSection: r.tdsSectionId ? l.sections.get(r.tdsSectionId)?.codeOldAct ?? null : null, tdsSectionId: r.tdsSectionId,
    priceListId: r.priceListId, priceList: r.priceListId ? l.lists.get(r.priceListId)?.name ?? null : null,
    channel: r.channel, channelLabel: CHANNEL_LABEL[r.channel] ?? r.channel, billToBranchId: r.billToBranchId,
  };
}

function rawView(p: CustomerProfile) {
  return {
    paymentTermId: p.paymentTermId, creditLimit: moneyText(p.creditLimit), invoiceEmails: p.invoiceEmails, deductsTds: p.deductsTds,
    tdsSectionId: p.tdsSectionId, priceListId: p.priceListId, channel: p.channel, billToBranchId: p.billToBranchId, notes: p.notes,
  };
}

// ---------- F080 list ----------

export async function listCustomers(f: { q?: string } = {}) {
  const [companies, profiles, l] = await Promise.all([crmCompanies({ q: f.q }), prisma.customerProfile.findMany(), lookups()]);
  const byKey = new Map(profiles.map((p) => [p.profileKey, p]));
  return companies.map((c) => {
    const company = byKey.get(keyOf(c.id, null));
    const r = resolveProfile(fields(company), null, { onDelivery: l.onDelivery });
    const outlets = c.branches.filter((b) => b.isActive);
    const gstins = outlets.map((b) => b.gstNumber?.trim()).filter(Boolean) as string[];
    const states = [...new Set(outlets.map((b) => (b.gstNumber && validateGstinChecksum(b.gstNumber).valid ? b.gstNumber.trim().slice(0, 2).toUpperCase() : stateCodeFromName(b.state))).filter(Boolean) as string[])];
    return {
      id: c.id, name: c.name, chainType: c.chainType, outlets: outlets.length, gstins, states: states.map((s) => GST_STATE_CODES[s] ?? s),
      ...profileView(r, l),
      // Outstanding, overdue, last invoice and last receipt come with invoicing and receipts (Steps 15, 17).
      outstanding: null as string | null, overdue: null as string | null, lastInvoice: null as string | null, lastReceipt: null as string | null,
    };
  });
}

// ---------- F082 overview ----------

export async function getCustomer(companyId: string) {
  const c = await crmCompany(companyId);
  if (!c) throw new UserError('Customer not found in the CRM', 404);
  const [profiles, l] = await Promise.all([prisma.customerProfile.findMany({ where: { crmCompanyId: companyId } }), lookups()]);
  const company = profiles.find((p) => p.crmBranchId === null);
  const orders = await crmOrders({ billingBranchIds: c.branches.map((b) => b.id), contactIds: c.contacts.map((p) => p.id), from: shift(todayIST(), -365) });
  return {
    id: c.id, name: c.name, chainType: c.chainType,
    profile: profileView(resolveProfile(fields(company), null, { onDelivery: l.onDelivery }), l),
    own: company ? rawView(company) : null,
    outlets: c.branches.map((b) => outletView(b, company, profiles.find((p) => p.crmBranchId === b.id), l)),
    contacts: c.contacts,
    orders: orders.slice(0, 100).map((o) => ({
      orderNumber: o.orderNumber, orderDate: o.orderDate, channel: o.channel, paymentMethod: o.paymentMethod, totalAmount: moneyText(o.totalAmount),
      status: o.status, outletId: o.billingBranchId,
    })),
    // Proformas, invoices, receipts, credit notes, ageing and the statement come with Steps 15 and 17.
  };
}

// ---------- F081 Finance fields ----------

export type ProfileInput = {
  paymentTermId?: string | null; creditLimit?: string | null; invoiceEmails?: string[]; deductsTds?: boolean | null;
  tdsSectionId?: string | null; priceListId?: string | null; channel?: string | null; billToBranchId?: string | null; notes?: string | null;
};

/** Saves the company's fields (branchId null) or one outlet's overrides. The CRM must have the customer. */
export async function saveProfile(ctx: AuditContext, companyId: string, branchId: string | null, input: ProfileInput) {
  const c = await crmCompany(companyId);
  if (!c) throw new UserError('Customer not found in the CRM; add it there first', 404);
  if (branchId && !c.branches.some((b) => b.id === branchId)) throw new UserError('That outlet is not one of this customer\'s');
  if (input.paymentTermId && !(await prisma.paymentTerm.findUnique({ where: { id: input.paymentTermId } }))) throw new UserError('Choose payment terms from the list');
  if (input.tdsSectionId && !(await prisma.tdsSection.findUnique({ where: { id: input.tdsSectionId } }))) throw new UserError('Choose a TDS section from the list');
  if (input.priceListId) {
    const pl = await prisma.priceList.findUnique({ where: { id: input.priceListId } });
    if (!pl || !pl.isActive) throw new UserError('Choose an active price list');
  }
  if (input.channel && !CHANNELS.includes(input.channel as (typeof CHANNELS)[number])) throw new UserError('Choose a channel');
  if (input.billToBranchId) {
    if (!branchId) throw new UserError('Billing another outlet is set on an outlet');
    if (input.billToBranchId === branchId || !c.branches.some((b) => b.id === input.billToBranchId)) throw new UserError('Bill to another outlet of the same customer');
  }
  const emails = (input.invoiceEmails ?? []).map((e) => e.trim()).filter(Boolean);
  for (const e of emails) if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new UserError(`${e} is not an e-mail address`);
  let creditLimit: Decimal | null = null;
  if (text(input.creditLimit)) {
    const clean = input.creditLimit!.replace(/[,\s₹]/g, '');
    if (!/^\d{1,12}(\.\d{1,2})?$/.test(clean)) throw new UserError('Credit limit is not an amount');
    creditLimit = new Decimal(clean);
  }
  if (input.deductsTds && !input.tdsSectionId && !branchId) throw new UserError('Choose the TDS section this customer deducts under');
  const company = await getCompany();
  const data = {
    paymentTermId: input.paymentTermId || null, creditLimit, invoiceEmails: emails, deductsTds: input.deductsTds ?? null,
    tdsSectionId: input.tdsSectionId || null, priceListId: input.priceListId || null, channel: input.channel || null,
    billToBranchId: input.billToBranchId || null, notes: text(input.notes),
  };
  const key = keyOf(companyId, branchId);
  await withAudit({ ...ctx, reason: ctx.reason ?? 'Customer finance fields saved' }, (tx) => tx.customerProfile.upsert({
    where: { profileKey: key }, update: data, create: { entityId: company.id, profileKey: key, crmCompanyId: companyId, crmBranchId: branchId, ...data },
  }));
  return getCustomer(companyId);
}

// ---------- F120 products ----------

async function currentPrices(date = todayIST()) {
  const lists = await prisma.priceList.findMany({ where: { isActive: true }, include: { items: { where: { isArchived: false } } }, orderBy: { name: 'asc' } });
  return lists.map((l) => ({ list: l, items: l.items.map(itemFacts) }));
}
const itemFacts = (i: PriceListItem) => ({ ...i, effectiveFrom: dateText(i.effectiveFrom)!, effectiveTo: dateText(i.effectiveTo) });

function productView(p: InvProduct) {
  const problems: string[] = [];
  if (!p.hsn) problems.push('No HSN in bloc-inv: it cannot go on an invoice until added there');
  if (!p.gstRate.equals(SALES_GST_RATE)) problems.push(`GST ${p.gstRate.toFixed(2)}% in bloc-inv; customers are charged 18% (Q29)`);
  return {
    id: p.id, sku: p.sku, skuNumber: p.skuNumber, name: p.name, hsn: p.hsn, gstRate: p.gstRate.toFixed(2), priceExclTax: moneyText(p.priceExclTax),
    priceInclTax: moneyText(p.priceInclTax), unitCost: moneyText(p.unitCost), unitCostFrom: p.unitCostFrom, aliases: p.aliases, isActive: p.isActive, problems,
  };
}

export async function listProducts() {
  const [products, lists] = await Promise.all([invProducts(), currentPrices()]);
  const today = todayIST();
  return {
    priceLists: lists.map(({ list }) => ({ id: list.id, name: list.name, taxInclusive: list.taxInclusive })),
    rows: products.map((p) => ({
      ...productView(p),
      prices: Object.fromEntries(lists.map(({ list, items }) => [list.id, moneyText(priceFor(items, p.id, today, 1)?.price ?? null)])),
    })),
  };
}

// ---------- F121 price lists ----------

function listView(l: PriceList & { items?: PriceListItem[] }) {
  return { id: l.id, name: l.name, kind: l.kind, kindLabel: PRICE_LIST_KIND_LABEL[l.kind] ?? l.kind, taxInclusive: l.taxInclusive, isActive: l.isActive, notes: l.notes, items: l.items?.filter((i) => !i.isArchived).length ?? undefined };
}

export async function listPriceLists() {
  const lists = await prisma.priceList.findMany({ include: { items: true }, orderBy: [{ isActive: 'desc' }, { name: 'asc' }] });
  const used = await prisma.customerProfile.groupBy({ by: ['priceListId'], _count: true });
  const count = new Map(used.map((u) => [u.priceListId, u._count]));
  return lists.map((l) => ({ ...listView(l), customers: count.get(l.id) ?? 0 }));
}

export async function getPriceList(id: string) {
  const l = await prisma.priceList.findUnique({ where: { id }, include: { items: { orderBy: [{ sku: 'asc' }, { minQty: 'asc' }, { effectiveFrom: 'desc' }] } } });
  if (!l) throw new UserError('Price list not found', 404);
  const products = new Map((await invProducts()).map((p) => [p.id, p]));
  const today = todayIST();
  return {
    ...listView(l),
    items: l.items.map((i) => {
      const p = products.get(i.invProductId);
      const f = itemFacts(i);
      const current = !i.isArchived && f.effectiveFrom <= today && (!f.effectiveTo || f.effectiveTo >= today);
      return {
        id: i.id, invProductId: i.invProductId, sku: i.sku, productName: p?.name ?? '(not in bloc-inv)', price: moneyText(i.price), minQty: i.minQty,
        effectiveFrom: f.effectiveFrom, effectiveTo: f.effectiveTo, isArchived: i.isArchived, current, upcoming: !i.isArchived && f.effectiveFrom > today,
        /** What an invoice line would charge before GST (BR-21 rounding). */
        rateBeforeGst: p ? moneyText(exclusiveRate(i.price, l.taxInclusive, p.gstRate)) : null,
      };
    }),
  };
}

export async function savePriceList(ctx: AuditContext, id: string | null, input: { name: string; kind: string; taxInclusive: boolean; notes?: string | null; isActive?: boolean }) {
  const name = text(input.name);
  if (!name) throw new UserError('Name the price list');
  if (!PRICE_LIST_KINDS.includes(input.kind as (typeof PRICE_LIST_KINDS)[number])) throw new UserError('Choose the kind of list');
  const same = await prisma.priceList.findUnique({ where: { name } });
  if (same && same.id !== id) throw new UserError('A price list with that name exists');
  if (id) {
    const l = await prisma.priceList.findUnique({ where: { id }, include: { items: { where: { isArchived: false } } } });
    if (!l) throw new UserError('Price list not found', 404);
    if (l.taxInclusive !== input.taxInclusive && l.items.length) throw new UserError('Prices are already entered; make a new list to switch between inclusive and exclusive of GST');
    if (input.isActive === false && (await prisma.customerProfile.count({ where: { priceListId: id } }))) throw new UserError('Customers use this list; move them to another list first');
    await withAudit({ ...ctx, reason: ctx.reason ?? 'Price list changed' }, (tx) => tx.priceList.update({ where: { id }, data: { name, kind: input.kind, taxInclusive: input.taxInclusive, notes: text(input.notes), isActive: input.isActive ?? l.isActive } }));
    return getPriceList(id);
  }
  const created = await withAudit({ ...ctx, reason: ctx.reason ?? 'Price list created' }, (tx) => tx.priceList.create({ data: { name, kind: input.kind, taxInclusive: input.taxInclusive, notes: text(input.notes) } }));
  return getPriceList(created.id);
}

/**
 * Adds a price from a date. The same product and quantity break's open price ends the day
 * before; prices are never edited (database), so an invoice priced from one can be explained.
 */
export async function addPrice(ctx: AuditContext, listId: string, input: { invProductId: string; price: string; minQty?: number; effectiveFrom: string }) {
  const l = await prisma.priceList.findUnique({ where: { id: listId } });
  if (!l || !l.isActive) throw new UserError('Price list not found', 404);
  const [p] = await invProducts({ ids: [input.invProductId] });
  if (!p) throw new UserError('That product is not in bloc-inv');
  const clean = String(input.price ?? '').replace(/[,\s₹]/g, '');
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(clean) || new Decimal(clean).lessThanOrEqualTo(0)) throw new UserError('Price is not an amount');
  const minQty = input.minQty ?? 1;
  if (!Number.isInteger(minQty) || minQty < 1) throw new UserError('Minimum quantity must be a whole number from 1');
  const from = dateText(parseDate(input.effectiveFrom, 'From'))!;
  const open = await prisma.priceListItem.findMany({ where: { priceListId: listId, invProductId: p.id, minQty, isArchived: false } });
  if (open.some((i) => dateText(i.effectiveFrom) === from)) throw new UserError('This product already has a price from that date; archive it first if it was a mistake');
  if (open.some((i) => dateText(i.effectiveFrom)! > from)) throw new UserError('A later price already exists; add prices in date order');
  await withAudit({ ...ctx, reason: ctx.reason ?? 'Price added' }, async (tx) => {
    for (const i of open.filter((x) => !x.effectiveTo || dateText(x.effectiveTo)! >= from)) {
      await tx.priceListItem.update({ where: { id: i.id }, data: { effectiveTo: parseDate(shift(from, -1)) } });
    }
    await tx.priceListItem.create({ data: { priceListId: listId, invProductId: p.id, sku: p.sku, price: new Decimal(clean), minQty, effectiveFrom: parseDate(from) } });
  });
  return getPriceList(listId);
}

/** A price entered by mistake is archived with a reason (never deleted); a real one is ended instead. */
export async function archivePrice(ctx: AuditContext, itemId: string) {
  if (!text(ctx.reason)) throw new UserError('Say why the price is removed');
  const i = await prisma.priceListItem.findUnique({ where: { id: itemId } });
  if (!i || i.isArchived) throw new UserError('Price not found', 404);
  await withAudit(ctx, (tx) => tx.priceListItem.update({ where: { id: itemId }, data: { isArchived: true } }));
  return getPriceList(i.priceListId);
}

export async function endPrice(ctx: AuditContext, itemId: string, lastDay: string) {
  const i = await prisma.priceListItem.findUnique({ where: { id: itemId } });
  if (!i || i.isArchived) throw new UserError('Price not found', 404);
  const to = dateText(parseDate(lastDay, 'Last day'))!;
  if (to < dateText(i.effectiveFrom)!) throw new UserError('The last day cannot be before the price starts');
  await withAudit({ ...ctx, reason: ctx.reason ?? 'Price ended' }, (tx) => tx.priceListItem.update({ where: { id: itemId }, data: { effectiveTo: parseDate(to) } }));
  return getPriceList(i.priceListId);
}

// ---------- Line price for invoices (used from Step 15) ----------

/**
 * The rate before GST an invoice line starts from: the customer's price list (outlet, then
 * company), else bloc-inv's price before tax. Says where it came from so a person can check it.
 */
export async function linePrice(f: { companyId?: string | null; branchId?: string | null; invProductId: string; date: string; qty: number }) {
  const [p] = await invProducts({ ids: [f.invProductId] });
  if (!p) throw new UserError('That product is not in bloc-inv');
  let listId: string | null = null;
  if (f.companyId) {
    const profiles = await prisma.customerProfile.findMany({ where: { crmCompanyId: f.companyId } });
    const r = resolveProfile(fields(profiles.find((x) => x.crmBranchId === null)), fields(profiles.find((x) => x.crmBranchId === f.branchId)), { onDelivery: null });
    listId = r.priceListId;
  }
  if (listId) {
    const l = await prisma.priceList.findUnique({ where: { id: listId }, include: { items: { where: { isArchived: false } } } });
    const hit = l ? priceFor(l.items.map(itemFacts), p.id, f.date, f.qty) : null;
    if (l && hit) return { rate: moneyText(exclusiveRate(hit.price, l.taxInclusive, p.gstRate)), source: `${l.name} price list`, hsn: p.hsn, gstRate: p.gstRate.toFixed(2) };
  }
  return { rate: moneyText(p.priceExclTax), source: 'bloc-inv price before tax', hsn: p.hsn, gstRate: p.gstRate.toFixed(2) };
}

export type { CrmCompany };
