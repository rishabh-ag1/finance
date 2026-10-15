import { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../config/database';
import { Decimal } from '../lib/money';

/**
 * CRM reader (D15, I01, I02): the only way Finance reads CRM data. Read only.
 * Until the apps share a database it reads the stub tables in schema crm_stub (same table and
 * column names as the CRM's public schema). Setting CRM_DATABASE_URL points the very same query at the
 * CRM's database (schema CRM_SCHEMA, default public): a config change, nothing else.
 * [Verify] the live path against the CRM database once Finance runs on the same server (Q33).
 */

export type CrmOrder = {
  id: string;
  orderNumber: string;
  channel: string;
  paymentMethod: string;
  totalAmount: Decimal;
  advancePaid: Decimal;
  balanceDue: Decimal;
  customerName: string;
  phone: string;
  email: string | null;
  shopifyOrderId: string | null;
  status: string;
  awb: string | null;
  isReplacement: boolean;
  /** Business date (IST) the order was placed. */
  orderDate: string;
  shippedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  contactId: string | null;
  billingBranchId: string | null;
  /** COMPANY (billed to an outlet) or PERSONAL; null when no company is involved. */
  orderFor: string | null;
  gstNumber: string | null;
  gstApplicable: boolean;
  /** Delivery address snapshot on the order. */
  shipping: OrderAddress;
  /** Billing address: the delivery address unless the order says otherwise. */
  billing: OrderAddress;
  deliveryMethod: string;
  codCharges: Decimal;
  returnedAt: string | null;
};
export type OrderAddress = { line1: string | null; line2: string | null; city: string | null; state: string | null; pincode: string | null };

let live: PrismaClient | null = null;
/** 'stub' until CRM_DATABASE_URL is set. */
export const crmReaderMode = () => (process.env.CRM_DATABASE_URL ? 'live' : 'stub');
function source() {
  const url = process.env.CRM_DATABASE_URL;
  if (!url) return { client: prisma as PrismaClient, schema: 'crm_stub' };
  live ??= new PrismaClient({ datasourceUrl: url });
  return { client: live, schema: (process.env.CRM_SCHEMA ?? 'public').replace(/[^a-z0-9_]/gi, '') };
}
/** A CRM table in whichever schema the reader points at. */
function crm(table: string) {
  const { client, schema } = source();
  return { client, table: Prisma.raw(`"${schema}"."${table}"`) };
}

/** A timestamp as the business date in India. */
export const istDate = (d: Date | null) => (d ? new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10) : null);
/** CRM timestamps that bound a business date range (IST midnight to midnight). */
const istStart = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 5.5 * 3600_000);

type Row = {
  id: string; orderNumber: string; channel: string; paymentMethod: string; totalAmount: Prisma.Decimal; advancePaid: Prisma.Decimal; balanceDue: Prisma.Decimal;
  customerName: string; phone: string; email: string | null; shopifyOrderId: string | null; status: string; shiprocketAwbNumber: string | null;
  replacementOfId: string | null; createdAt: Date; shippedAt: Date | null; deliveredAt: Date | null; cancelledAt: Date | null;
  contactId: string | null; billingBranchId: string | null; orderFor: string | null; gstNumber: string | null;
  gstApplicable: boolean | null; addressLine1: string | null; addressLine2: string | null; city: string | null; state: string | null; pincode: string | null;
  billingSameAsShipping: boolean | null; billingAddressLine1: string | null; billingAddressLine2: string | null; billingCity: string | null; billingState: string | null; billingPincode: string | null;
  deliveryMethod: string | null; codCharges: Prisma.Decimal | null; returnedAt: Date | null;
};

function view(r: Row): CrmOrder {
  const shipping = { line1: r.addressLine1, line2: r.addressLine2, city: r.city, state: r.state, pincode: r.pincode };
  return {
    id: r.id, orderNumber: r.orderNumber, channel: String(r.channel), paymentMethod: String(r.paymentMethod),
    totalAmount: new Decimal(r.totalAmount), advancePaid: new Decimal(r.advancePaid ?? 0), balanceDue: new Decimal(r.balanceDue ?? 0),
    customerName: r.customerName, phone: r.phone, email: r.email, shopifyOrderId: r.shopifyOrderId, status: String(r.status), awb: r.shiprocketAwbNumber,
    isReplacement: !!r.replacementOfId, orderDate: istDate(r.createdAt)!, shippedAt: istDate(r.shippedAt), deliveredAt: istDate(r.deliveredAt), cancelledAt: istDate(r.cancelledAt),
    contactId: r.contactId, billingBranchId: r.billingBranchId, orderFor: r.orderFor === null ? null : String(r.orderFor), gstNumber: r.gstNumber,
    gstApplicable: !!r.gstApplicable, shipping, deliveryMethod: String(r.deliveryMethod ?? 'COURIER'), codCharges: new Decimal(r.codCharges ?? 0), returnedAt: istDate(r.returnedAt),
    billing: r.billingSameAsShipping === false && (r.billingAddressLine1 || r.billingCity)
      ? { line1: r.billingAddressLine1, line2: r.billingAddressLine2, city: r.billingCity, state: r.billingState, pincode: r.billingPincode }
      : shipping,
  };
}

const COLUMNS = Prisma.sql`"id", "orderNumber", "channel"::text as "channel", "paymentMethod"::text as "paymentMethod", "totalAmount", "advancePaid", "balanceDue",
  "customerName", "phone", "email", "shopifyOrderId", "status"::text as "status", "shiprocketAwbNumber", "replacementOfId", "createdAt", "shippedAt", "deliveredAt", "cancelledAt",
  "contactId", "billingBranchId", "orderFor"::text as "orderFor", "gstNumber", "gstApplicable", "addressLine1", "addressLine2", "city", "state", "pincode",
  "billingSameAsShipping", "billingAddressLine1", "billingAddressLine2", "billingCity", "billingState", "billingPincode", "deliveryMethod"::text as "deliveryMethod", "codCharges", "returnedAt"`;

/** Orders placed between two business dates (inclusive), or with the given numbers. */
export async function crmOrders(f: { from?: string; to?: string; orderNumbers?: string[]; billingBranchIds?: string[]; contactIds?: string[] }): Promise<CrmOrder[]> {
  const { client, table } = crm('Order');
  const where: Prisma.Sql[] = [];
  if (f.from) where.push(Prisma.sql`"createdAt" >= ${istStart(f.from)}`);
  if (f.to) where.push(Prisma.sql`"createdAt" < ${new Date(istStart(f.to).getTime() + 86_400_000)}`);
  if (f.orderNumbers) {
    if (!f.orderNumbers.length) return [];
    where.push(Prisma.sql`"orderNumber" in (${Prisma.join(f.orderNumbers)})`);
  }
  // A company's orders: billed to one of its outlets, or placed for it by one of its people.
  if (f.billingBranchIds || f.contactIds) {
    const or: Prisma.Sql[] = [];
    if (f.billingBranchIds?.length) or.push(Prisma.sql`"billingBranchId" in (${Prisma.join(f.billingBranchIds)})`);
    if (f.contactIds?.length) or.push(Prisma.sql`("contactId" in (${Prisma.join(f.contactIds)}) and coalesce("orderFor"::text, '') = 'COMPANY')`);
    if (!or.length) return [];
    where.push(Prisma.sql`(${Prisma.join(or, ' or ')})`);
  }
  const rows = await client.$queryRaw<Row[]>`select ${COLUMNS} from ${table} ${where.length ? Prisma.sql`where ${Prisma.join(where, ' and ')}` : Prisma.empty} order by "createdAt" desc`;
  return rows.map(view);
}

export async function crmOrder(orderNumber: string): Promise<CrmOrder | null> {
  return (await crmOrders({ orderNumbers: [orderNumber] }))[0] ?? null;
}

/** Orders shipped, cancelled or returned on or after a business date (the D2C batch's window, F102). */
export async function crmOrdersMovedSince(day: string): Promise<CrmOrder[]> {
  const { client, table } = crm('Order');
  const t = istStart(day);
  const rows = await client.$queryRaw<Row[]>`select ${COLUMNS} from ${table}
    where "shippedAt" >= ${t} or "cancelledAt" >= ${t} or "returnedAt" >= ${t} or ("createdAt" >= ${t} and "status"::text in ('SHIPPED', 'DELIVERED', 'RETURNED', 'CANCELLED'))
    order by "createdAt"`;
  return rows.map(view);
}

export type CrmOrderLine = {
  orderId: string; productName: string; sku: string; invProductId: string | null; qty: number;
  mrp: Decimal; discountAmount: Decimal; finalAmount: Decimal; priceBeforeTax: Decimal; taxPercent: Decimal;
};

/** An order's lines with the product they sell (the CRM product carries bloc-inv's id, not the HSN). */
export async function crmOrderLines(orderIds: string[]): Promise<CrmOrderLine[]> {
  if (!orderIds.length) return [];
  const i = crm('OrderItem');
  const p = crm('Product');
  const rows = await i.client.$queryRaw<{ orderId: string; productName: string; sku: string; invProductId: string | null; quantity: number; mrp: Prisma.Decimal; discountAmount: Prisma.Decimal; finalAmount: Prisma.Decimal; priceBeforeTax: Prisma.Decimal; taxPercent: Prisma.Decimal }[]>`
    select i."orderId", p."name" as "productName", p."sku", p."invProductId", i."quantity", i."mrp", i."discountAmount", i."finalAmount", i."priceBeforeTax", i."taxPercent"
    from ${i.table} i join ${p.table} p on p."id" = i."productId" where i."orderId" in (${Prisma.join(orderIds)}) order by i."id"`;
  return rows.map((r) => ({
    orderId: r.orderId, productName: r.productName, sku: r.sku, invProductId: r.invProductId, qty: Number(r.quantity),
    mrp: new Decimal(r.mrp), discountAmount: new Decimal(r.discountAmount), finalAmount: new Decimal(r.finalAmount), priceBeforeTax: new Decimal(r.priceBeforeTax), taxPercent: new Decimal(r.taxPercent),
  }));
}

// ---------- Customers (F080): companies, their outlets and their people ----------

export type CrmBranch = {
  id: string; companyId: string; name: string; addressLine1: string | null; addressLine2: string | null; city: string | null;
  state: string | null; pincode: string | null; gstNumber: string | null; isActive: boolean;
};
export type CrmCompany = {
  id: string; name: string; chainType: string; branches: CrmBranch[];
  contacts: { id: string; name: string | null; phone: string; email: string | null; role: string | null }[];
};

/**
 * Companies (B2B customers) with their outlets and active contacts. D2C buyers are not customers
 * here: their invoices carry the order's own name and address (BR-49).
 */
export async function crmCompanies(f: { ids?: string[]; q?: string } = {}): Promise<CrmCompany[]> {
  const c = crm('Company');
  const where: Prisma.Sql[] = [];
  if (f.ids) {
    if (!f.ids.length) return [];
    where.push(Prisma.sql`"id" in (${Prisma.join(f.ids)})`);
  }
  if (f.q?.trim()) where.push(Prisma.sql`"name" ilike ${`%${f.q.trim()}%`}`);
  const companies = await c.client.$queryRaw<{ id: string; name: string; chainType: string }[]>`
    select "id", "name", "chainType"::text as "chainType" from ${c.table} ${where.length ? Prisma.sql`where ${Prisma.join(where, ' and ')}` : Prisma.empty} order by "name"`;
  if (!companies.length) return [];
  const ids = companies.map((x) => x.id);
  const b = crm('CompanyBranch');
  const branches = await b.client.$queryRaw<CrmBranch[]>`
    select "id", "companyId", "name", "address" as "addressLine1", "addressLine2", "city", "state", "pincode", "gstNumber", "isActive"
    from ${b.table} where "companyId" in (${Prisma.join(ids)}) order by "name"`;
  const cc = crm('CompanyContact');
  const ct = crm('Contact');
  const people = await cc.client.$queryRaw<{ companyId: string; id: string; name: string | null; phone: string; email: string | null; role: string | null }[]>`
    select l."companyId", p."id", p."name", p."phoneNumber" as "phone", p."email", l."role"::text as "role"
    from ${cc.table} l join ${ct.table} p on p."id" = l."contactId" where l."isActive" and l."companyId" in (${Prisma.join(ids)})`;
  return companies.map((x) => ({
    ...x,
    branches: branches.filter((br) => br.companyId === x.id),
    contacts: people.filter((p) => p.companyId === x.id).map(({ companyId: _c, ...p }) => p),
  }));
}

/** The company an outlet belongs to (an order billed to an outlet names only the outlet). */
export async function crmBranchCompanyId(branchId: string): Promise<string | null> {
  const b = crm('CompanyBranch');
  const rows = await b.client.$queryRaw<{ companyId: string }[]>`select "companyId" from ${b.table} where "id" = ${branchId}`;
  return rows[0]?.companyId ?? null;
}

export async function crmCompany(id: string): Promise<CrmCompany | null> {
  return (await crmCompanies({ ids: [id] }))[0] ?? null;
}
