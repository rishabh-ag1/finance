import { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../config/database';
import { istDate } from '../crm/reader';
import { Decimal } from '../lib/money';

/**
 * Inventory reader (D15, I19): each order's delivery facts from bloc-inv. Read only.
 * Until connected it reads finance_stub."OutgoingOrder" (same name and columns as bloc-inv's
 * table); INVENTORY_DATABASE_URL points the same query at bloc-inv's database (bloc_inv).
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
  if (!url) return { client: prisma as PrismaClient, table: Prisma.raw('finance_stub."OutgoingOrder"') };
  live ??= new PrismaClient({ datasourceUrl: url });
  return { client: live, table: Prisma.raw('public."OutgoingOrder"') };
}

type Row = { orderNumber: string; awbNumber: string | null; codToCollect: Prisma.Decimal | null; carrierType: string; status: string; shippedAt: Date | null; deliveredAt: Date | null; cancelledAt: Date | null };

/** Delivery facts for orders by number, or by AWB (a COD remittance names AWBs). */
export async function deliveries(f: { orderNumbers?: string[]; awbs?: string[] }): Promise<Delivery[]> {
  const { client, table } = source();
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
