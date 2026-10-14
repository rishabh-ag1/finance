import { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../config/database';
import { istDate } from '../crm/reader';
import { Decimal } from '../lib/money';

/**
 * Inventory reader (D15, I19): each order's delivery facts from bloc-inv. Read only.
 * Until connected it reads the stub tables in schema inv_stub (same names and columns as bloc-inv's
 * tables); INVENTORY_DATABASE_URL points the same query at bloc-inv's database (bloc_inv).
 * bloc-inv knows orders by the CRM's order number. [Verify] the live path once Finance runs on
 * the same server (Q33).
 */

export type Delivery = {
  orderNumber: string;
  awb: string | null;
  codToCollect: Decimal | null;
  carrierType: string;
  status: string;
  shippedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
};

let live: PrismaClient | null = null;
/** 'stub' until INVENTORY_DATABASE_URL is set. */
export const inventoryReaderMode = () => (process.env.INVENTORY_DATABASE_URL ? 'live' : 'stub');
function source() {
  const url = process.env.INVENTORY_DATABASE_URL;
  if (!url) return { client: prisma as PrismaClient, schema: 'inv_stub' };
  live ??= new PrismaClient({ datasourceUrl: url });
  return { client: live, schema: 'public' };
}
/** A bloc-inv table in whichever schema the reader points at. */
function inv(table: string) {
  const { client, schema } = source();
  return { client, table: Prisma.raw(`"${schema}"."${table}"`) };
}

type Row = { orderNumber: string; awbNumber: string | null; codToCollect: Prisma.Decimal | null; carrierType: string; status: string; shippedAt: Date | null; deliveredAt: Date | null; cancelledAt: Date | null };

/** Delivery facts for orders by number, or by AWB (a COD remittance names AWBs). */
export async function deliveries(f: { orderNumbers?: string[]; awbs?: string[] }): Promise<Delivery[]> {
  const { client, table } = inv('OutgoingOrder');
  const or: Prisma.Sql[] = [];
  if (f.orderNumbers?.length) or.push(Prisma.sql`"orderNumber" in (${Prisma.join(f.orderNumbers)})`);
  if (f.awbs?.length) or.push(Prisma.sql`"awbNumber" in (${Prisma.join(f.awbs)})`);
  if (!or.length) return [];
  const rows = await client.$queryRaw<Row[]>`select "orderNumber", "awbNumber", "codToCollect", "carrierType", "status", "shippedAt", "deliveredAt", "cancelledAt"
    from ${table} where ${Prisma.join(or, ' or ')}`;
  return rows.map((r) => ({
    orderNumber: r.orderNumber, awb: r.awbNumber, codToCollect: r.codToCollect === null ? null : new Decimal(r.codToCollect), carrierType: r.carrierType,
    status: r.status, shippedAt: istDate(r.shippedAt), deliveredAt: istDate(r.deliveredAt), cancelledAt: istDate(r.cancelledAt),
  }));
}

// ---------- Products (F120) ----------

export type InvProduct = {
  id: string; sku: string; skuNumber: string; name: string; hsn: string | null; gstRate: Decimal; priceExclTax: Decimal; priceInclTax: Decimal;
  aliases: string[]; isActive: boolean; unitCost: Decimal | null; unitCostFrom: string | null;
};

type ProductRow = {
  id: string; sku: string; skuNumber: string; name: string; hsnCode: string | null; taxRate: Prisma.Decimal; priceExclTax: Prisma.Decimal;
  priceInclTax: Prisma.Decimal; aliases: string[]; isActive: boolean; unitCost: Prisma.Decimal | null; validFrom: Date | null;
};

/** bloc-inv's catalogue with today's unit cost (the newest ProductCost on or before now). */
export async function invProducts(f: { ids?: string[] } = {}): Promise<InvProduct[]> {
  if (f.ids && !f.ids.length) return [];
  const p = inv('Product');
  const c = inv('ProductCost');
  const rows = await p.client.$queryRaw<ProductRow[]>`
    select p."id", p."sku", p."skuNumber", p."name", p."hsnCode", p."taxRate", p."priceExclTax", p."priceInclTax", p."aliases", p."isActive", k."unitCost", k."validFrom"
    from ${p.table} p
    left join lateral (select "unitCost", "validFrom" from ${c.table} where "productId" = p."id" and "validFrom" <= now() order by "validFrom" desc limit 1) k on true
    ${f.ids ? Prisma.sql`where p."id" in (${Prisma.join(f.ids)})` : Prisma.empty}
    order by p."name"`;
  return rows.map((r) => ({
    id: r.id, sku: r.sku, skuNumber: r.skuNumber, name: r.name, hsn: r.hsnCode?.trim() || null, gstRate: new Decimal(r.taxRate),
    priceExclTax: new Decimal(r.priceExclTax), priceInclTax: new Decimal(r.priceInclTax), aliases: r.aliases ?? [], isActive: r.isActive,
    unitCost: r.unitCost === null ? null : new Decimal(r.unitCost), unitCostFrom: istDate(r.validFrom),
  }));
}
