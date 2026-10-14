import { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../config/database';
import { Decimal } from '../lib/money';

/**
 * CRM reader (D15, I01, I02): the only way Finance reads CRM data. Read only.
 * Until the apps share a database it reads the stub table finance_stub."Order" (same name and
 * columns as the CRM's public."Order"). Setting CRM_DATABASE_URL points the very same query at the
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
};

let live: PrismaClient | null = null;
/** 'stub' until CRM_DATABASE_URL is set. */
export const crmReaderMode = () => (process.env.CRM_DATABASE_URL ? 'live' : 'stub');
function source() {
  const url = process.env.CRM_DATABASE_URL;
  if (!url) return { client: prisma as PrismaClient, table: Prisma.raw('finance_stub."Order"') };
  live ??= new PrismaClient({ datasourceUrl: url });
  const schema = (process.env.CRM_SCHEMA ?? 'public').replace(/[^a-z0-9_]/gi, '');
  return { client: live, table: Prisma.raw(`"${schema}"."Order"`) };
}

/** A timestamp as the business date in India. */
export const istDate = (d: Date | null) => (d ? new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10) : null);
/** CRM timestamps that bound a business date range (IST midnight to midnight). */
const istStart = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 5.5 * 3600_000);

type Row = {
  id: string; orderNumber: string; channel: string; paymentMethod: string; totalAmount: Prisma.Decimal; advancePaid: Prisma.Decimal; balanceDue: Prisma.Decimal;
  customerName: string; phone: string; email: string | null; shopifyOrderId: string | null; status: string; shiprocketAwbNumber: string | null;
  replacementOfId: string | null; createdAt: Date; shippedAt: Date | null; deliveredAt: Date | null; cancelledAt: Date | null;
};

function view(r: Row): CrmOrder {
  return {
    id: r.id, orderNumber: r.orderNumber, channel: String(r.channel), paymentMethod: String(r.paymentMethod),
    totalAmount: new Decimal(r.totalAmount), advancePaid: new Decimal(r.advancePaid ?? 0), balanceDue: new Decimal(r.balanceDue ?? 0),
    customerName: r.customerName, phone: r.phone, email: r.email, shopifyOrderId: r.shopifyOrderId, status: String(r.status), awb: r.shiprocketAwbNumber,
    isReplacement: !!r.replacementOfId, orderDate: istDate(r.createdAt)!, shippedAt: istDate(r.shippedAt), deliveredAt: istDate(r.deliveredAt), cancelledAt: istDate(r.cancelledAt),
  };
}

const COLUMNS = Prisma.sql`"id", "orderNumber", "channel"::text as "channel", "paymentMethod"::text as "paymentMethod", "totalAmount", "advancePaid", "balanceDue",
  "customerName", "phone", "email", "shopifyOrderId", "status"::text as "status", "shiprocketAwbNumber", "replacementOfId", "createdAt", "shippedAt", "deliveredAt", "cancelledAt"`;

/** Orders placed between two business dates (inclusive), or with the given numbers. */
export async function crmOrders(f: { from?: string; to?: string; orderNumbers?: string[] }): Promise<CrmOrder[]> {
  const { client, table } = source();
  const where: Prisma.Sql[] = [];
  if (f.from) where.push(Prisma.sql`"createdAt" >= ${istStart(f.from)}`);
  if (f.to) where.push(Prisma.sql`"createdAt" < ${new Date(istStart(f.to).getTime() + 86_400_000)}`);
  if (f.orderNumbers) {
    if (!f.orderNumbers.length) return [];
    where.push(Prisma.sql`"orderNumber" in (${Prisma.join(f.orderNumbers)})`);
  }
  const rows = await client.$queryRaw<Row[]>`select ${COLUMNS} from ${table} ${where.length ? Prisma.sql`where ${Prisma.join(where, ' and ')}` : Prisma.empty} order by "createdAt" desc`;
  return rows.map(view);
}

export async function crmOrder(orderNumber: string): Promise<CrmOrder | null> {
  return (await crmOrders({ orderNumbers: [orderNumber] }))[0] ?? null;
}
