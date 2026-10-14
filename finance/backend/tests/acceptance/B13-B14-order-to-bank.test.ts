import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Agent } from 'supertest';
import { prisma } from '../../src/config/database';
import { createApp } from '../../src/app';
import { closePdfBrowser } from '../../src/pdf/render';
import { hasDb } from '../setup/db';
import { loggedInFounder, seedOnce } from '../setup/fixtures';

// Phase 2 acceptance B13 (expected settlement date, BR-45) and B14 (three-level tie-out, BR-47), with
// the order-to-bank flows of Step 13: Razorpay payments and settlement linked to CRM orders and to the
// IDFC credit (F192, F194), a COD remittance by AWB (F193), a direct transfer (F195) and the
// discrepancy queue (F196, BR-46). Orders sit in the reader stubs (finance_stub), as the CRM and
// bloc-inv would hold them.
const csv = (text: string) => Buffer.from(text.trim() + '\n').toString('base64');
const HEADER = 'Transaction Date,Value Date,Particulars,Cheque No.,Debit,Credit,Balance\n';
const RUN = Date.now().toString(36).toUpperCase();
const n = (i: number) => `TST-${RUN}-${i}`;
/** 10:30 IST on a business date. */
const ist = (d: string) => new Date(`${d}T05:00:00Z`);

describe.skipIf(!hasDb)('Acceptance B13, B14: order-to-bank', () => {
  let app: Express;
  let agent: Agent;
  let idfc = '';
  const range = '?from=2026-10-01&to=2026-10-31&showInBank=true';
  const row = async (orderNumber: string) => ((await agent.get(`/api/recon/tracker${range}&q=${orderNumber}`)).body.data.rows as { orderNumber: string; status: string; expectedDate: string | null; collected: string }[]).find((r) => r.orderNumber === orderNumber)!;
  const order = (i: number, data: object) => prisma.crmOrder.create({ data: { orderNumber: n(i), channel: 'SHOPIFY', paymentMethod: 'RAZORPAY', totalAmount: '1499', customerName: `Customer ${RUN} ${i}`, phone: '+919800000000', createdAt: ist('2026-10-09'), ...data } });
  const imp = (source: string, fileName: string, text: string) => agent.post('/api/recon/imports').send({ source, fileName, contentBase64: csv(text) });

  beforeAll(async () => {
    await seedOnce();
    app = createApp();
    ({ agent } = await loggedInFounder(app));
    idfc = (await agent.post('/api/settings/bank-accounts').send({
      bankName: 'IDFC FIRST Bank', accountName: 'Entelechy Labs Private Limited', accountNumber: `R${Date.now()}`, ifsc: 'IDFB0080152',
      accountType: 'business_current', owner: 'Entelechy', openingBalance: '100000', openingDate: '2026-10-01', parserFormat: 'idfc_v1',
    })).body.data.id;
    await order(1, { totalAmount: '1499' });
    await order(2, { totalAmount: '2998' });
    await order(3, { totalAmount: '1499' });
  }, 60_000);
  afterAll(async () => { await closePdfBrowser(); await prisma.$disconnect(); });

  it('B13: payments captured Fri 9 Oct link to their orders by number; settlement expected Wed 14 Oct', async () => {
    const r = await imp('razorpay', 'payments.csv', `
id,amount,currency,status,order_id,method,amount_refunded,description,email,contact,notes,fee,tax,created_at
pay_${RUN}1,1499,INR,captured,order_${RUN}1,upi,0,Order #${n(1)},,,,35.38,5.40,09/10/2026 14:00:00
pay_${RUN}2,2998,INR,captured,order_${RUN}2,card,0,Order #${n(2)},,,,70.75,10.79,09/10/2026 15:00:00
pay_${RUN}3,1499,INR,captured,order_${RUN}3,upi,0,Order #${n(3)},,,,35.38,5.40,09/10/2026 16:00:00`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ kind: 'payments', added: 3, repeated: 0 });
    expect(await row(n(1))).toMatchObject({ status: 'paid_at_gateway', expectedDate: '2026-10-14', collected: '1499.00' });
    // The same report again changes nothing.
    expect((await imp('razorpay', 'payments.csv', `id,amount,status,created_at,description,fee,tax\npay_${RUN}1,1499,captured,09/10/2026 14:00:00,Order #${n(1)},35.38,5.40`)).body.data).toMatchObject({ added: 0, repeated: 1 });
  }, 60_000);

  it('B14: Rs 5,996 gross - fees Rs 119.92 - GST Rs 21.59 = Rs 5,854.49 ties out to the IDFC credit', async () => {
    const utr = `RZPUTR${RUN}`;
    const r = await imp('razorpay', 'settlement.csv', `
entity_id,type,debit,credit,amount,currency,fee,tax,settled,created_at,settled_at,settlement_id,settlement_utr,order_receipt
pay_${RUN}1,payment,0,1463.62,1499,INR,35.38,5.40,1,09/10/2026 14:00:00,14/10/2026 09:00:00,setl_${RUN},${utr},${n(1)}
pay_${RUN}2,payment,0,2927.25,2998,INR,70.75,10.79,1,09/10/2026 15:00:00,14/10/2026 09:00:00,setl_${RUN},${utr},${n(2)}
pay_${RUN}3,payment,0,1463.62,1499,INR,35.38,5.40,1,09/10/2026 16:00:00,14/10/2026 09:00:00,setl_${RUN},${utr},${n(3)}`);
    expect(r.body.data).toMatchObject({ kind: 'settlements', added: 1 });
    const batch = await prisma.settlementBatch.findUniqueOrThrow({ where: { source_externalId: { source: 'razorpay', externalId: `setl_${RUN}` } } });
    let s = (await agent.get(`/api/recon/settlements/${batch.id}`)).body.data;
    expect(s.totals).toEqual({ gross: '5996.00', fees: '119.92', taxOnFees: '21.59', refunds: '0.00', adjustments: '0.00', net: '5854.49' });
    expect(s.levels.map((l: { ok: boolean | null }) => l.ok)).toEqual([true, true, null]);
    expect(await row(n(2))).toMatchObject({ status: 'settled', expectedDate: '2026-10-15' });

    // The IDFC statement brings the credit: matched by UTR, categorised Revenue / Razorpay, orders In bank.
    const st = await agent.post('/api/bank/imports').send({ bankAccountId: idfc, fileName: 'idfc.csv', contentBase64: csv(
      `${HEADER}2026-10-14,2026-10-14,NEFT/${utr}/RAZORPAY SOFTWARE PVT LTD/HDFC0000001/Settlement,,,5854.49,105854.49`) });
    expect(st.status).toBe(200);
    s = (await agent.get(`/api/recon/settlements/${batch.id}`)).body.data;
    expect(s.levels.map((l: { ok: boolean | null; difference: string | null }) => [l.ok, l.difference])).toEqual([[true, '0.00'], [true, '0.00'], [true, '0.00']]);
    expect(s).toMatchObject({ matchedBy: 'utr', bankRow: { credit: '5854.49' } });
    const credit = await prisma.bankTxn.findUniqueOrThrow({ where: { id: s.bankRow.id } });
    const revenue = await prisma.category.findUniqueOrThrow({ where: { name: 'Revenue' }, include: { subCategories: true } });
    expect(credit).toMatchObject({ linkedDocType: 'SettlementBatch', categoryId: revenue.id, subCategoryId: revenue.subCategories.find((x) => x.name === 'Razorpay')!.id, status: 'suggested' });
    for (const i of [1, 2, 3]) expect((await row(n(i))).status).toBe('in_bank');
    // F200: what the CRM order page shows.
    expect((await agent.get(`/api/recon/orders/${n(1)}/status`)).body.data).toMatchObject({ status: 'in_bank', text: 'In bank 2026-10-14', overdue: false, openDiscrepancies: 0 });
  }, 90_000);

  it('BR-44: a COD order follows its AWB from bloc-inv into the Shiprocket remittance', async () => {
    const awb = `9${Date.now()}`.slice(0, 12);
    await order(4, { channel: 'WHATSAPP', paymentMethod: 'COD', totalAmount: '1499', balanceDue: '1499', status: 'DELIVERED', createdAt: ist('2026-10-06') });
    await prisma.invOutgoingOrder.create({ data: { orderNumber: n(4), paymentMethod: 'COD', codToCollect: '1499', awbNumber: awb, status: 'DELIVERED', shippedAt: ist('2026-10-07'), deliveredAt: ist('2026-10-10') } });
    expect(await row(n(4))).toMatchObject({ status: 'delivered_awaiting_remittance', expectedDate: '2026-10-16' });
    const r = await imp('shiprocket_cod', 'remittance.csv', `
CRF ID,Remittance Date,UTR,AWB Code,Order ID,COD Amount
CRF${RUN},15-10-2026,SR${RUN},${awb},${n(4)},1499.00`);
    expect(r.body.data).toMatchObject({ kind: 'remittances', added: 1 });
    expect(await row(n(4))).toMatchObject({ status: 'remitted', collected: '1499.00', expectedDate: '2026-10-16' });
  }, 60_000);

  it('F195: a direct bank transfer from the customer pays the order', async () => {
    await order(5, { channel: 'MANUAL', paymentMethod: 'BANK_TRANSFER', totalAmount: '11800', customerName: `Sunrise Hotels ${RUN}`, createdAt: ist('2026-10-08') });
    expect((await row(n(5))).status).toBe('awaiting_payment');
    const st = await agent.post('/api/bank/imports').send({ bankAccountId: idfc, fileName: 'idfc2.csv', contentBase64: csv(
      `${HEADER}2026-10-13,2026-10-13,NEFT/N${RUN}/SUNRISE HOTELS ${RUN}/SBIN0000001/Order,,,11800,117654.49`) });
    expect(st.status).toBe(200);
    expect(await row(n(5))).toMatchObject({ status: 'in_bank', collected: '11800.00' });
  }, 60_000);

  it('BR-46: CRM Rs 2,998, Razorpay captured Rs 2,499 -> type 1 of Rs 499, resolved with a note', async () => {
    await order(6, { totalAmount: '2998', createdAt: ist('2026-10-12') });
    await imp('razorpay', 'p2.csv', `id,amount,status,created_at,description,fee,tax\npay_${RUN}6,2499,captured,12/10/2026 10:00:00,Order ${n(6)},58.98,9.00`);
    const list = (await agent.get('/api/recon/discrepancies')).body.data;
    const d = list.rows.find((x: { orderNumber: string; typeCode: number }) => x.orderNumber === n(6) && x.typeCode === 1);
    expect(d).toMatchObject({ amount: '499.00', status: 'open', suggestedAction: 'Correct the CRM order or chase the customer' });
    expect((await agent.post(`/api/recon/discrepancies/${d.id}/resolve`).send({ action: 'crm_corrected', note: 'Coupon BLOC500 not entered in the CRM' })).body.data).toMatchObject({ status: 'resolved', resolutionLabel: 'CRM order corrected' });
    // Imported figures cannot be edited.
    await expect(prisma.$executeRawUnsafe(`update finance."GatewayPayment" set amount = 1 where "externalId" = 'pay_${RUN}6'`)).rejects.toThrow();
  }, 60_000);
});
