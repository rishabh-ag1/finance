import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Agent } from 'supertest';
import { prisma } from '../../src/config/database';
import { createApp } from '../../src/app';
import { computeGstinCheckDigit } from '../../src/lib/gstin';
import { closePdfBrowser } from '../../src/pdf/render';
import { hasDb } from '../setup/db';
import { loggedInFounder, seedOnce } from '../setup/fixtures';

// Phase 3 acceptance C11 (receipt with TDS, BR-38 / BR-41), C12 (AR ageing and statement, F117 /
// F082), C13 (a settlement settles D2C invoices, BR-39) and the advance part of C7 (BR-33).
const RUN = Date.now().toString(36).toUpperCase();
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function gstin(state: string) {
  const n = Date.now() + Math.floor(Math.random() * 1e6);
  const l = (i: number) => LETTERS[Math.floor(n / 26 ** i) % 26];
  const first14 = `${state}${l(0)}${l(1)}${l(2)}C${l(3)}${String(n % 10000).padStart(4, '0')}${l(4)}1Z`;
  return first14 + computeGstinCheckDigit(first14);
}
const csv = (text: string) => Buffer.from(text.trim() + '\n').toString('base64');
const HEADER = 'Transaction Date,Value Date,Particulars,Cheque No.,Debit,Credit,Balance\n';
const ist = (d: string) => new Date(`${d}T05:00:00Z`);

describe.skipIf(!hasDb)('Acceptance C11-C13: receivables', () => {
  let app: Express;
  let agent: Agent;
  let companyId = '';
  let hq = '';
  let trap = '';
  let idfc = '';
  const hotel = `Lake View Hotels ${RUN}`;
  const outlet = () => ({ kind: 'outlet', companyId, branchId: hq });
  const issue = async (body: object) => {
    const d = await agent.post('/api/sales').send({ docType: 'tax_invoice', customer: outlet(), ...body });
    if (d.status !== 200) throw new Error(d.body.error);
    const i = await agent.post(`/api/sales/${d.body.data.id}/issue`);
    if (i.status !== 200) throw new Error(i.body.error);
    return i.body.data as { id: string; docNumber: string; total: string; lines: { id: string }[] };
  };
  const receivable = async (id: string) => (await agent.get(`/api/sales/${id}/receivable`)).body.data;

  beforeAll(async () => {
    await seedOnce();
    app = createApp();
    ({ agent } = await loggedInFounder(app));
    companyId = (await prisma.crmCompany.create({ data: { name: hotel } })).id;
    hq = (await prisma.crmCompanyBranch.create({ data: { companyId, name: 'Indiranagar', addressLine1: '100 Feet Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560038', gstNumber: gstin('29') } })).id;
    trap = (await prisma.invProduct.create({ data: { name: `Bloc Trap Pro ${RUN}`, sku: `TRAPR-${RUN}`, skuNumber: `TR${RUN}`, hsnCode: '8543', priceExclTax: '3900', taxRate: '18', priceInclTax: '4602' } })).id;
    idfc = (await agent.post('/api/settings/bank-accounts').send({
      bankName: 'IDFC FIRST Bank', accountName: 'Entelechy Labs Private Limited', accountNumber: `R${Date.now()}`, ifsc: 'IDFB0080152',
      accountType: 'business_current', owner: 'Entelechy', openingBalance: '100000', openingDate: '2026-09-01', parserFormat: 'idfc_v1',
    })).body.data.id;
    await setSales(true);
  }, 60_000);
  afterAll(async () => { await setSales(false); await closePdfBrowser(); await prisma.$disconnect(); });

  async function setSales(on: boolean) {
    const series = (await agent.get('/api/settings/number-series')).body.data as { id: string; docType: string; pattern: string; padding: number; nextNumber: number; isActive: boolean }[];
    for (const s of series.filter((x) => ['tax_invoice', 'proforma', 'credit_note'].includes(x.docType) && x.isActive !== on)) {
      const r = await agent.put(`/api/settings/number-series/${s.id}`).send({ pattern: s.pattern, padding: s.padding, nextNumber: s.nextNumber, isActive: on, reason: on ? 'Test: invoicing switched on' : 'Test: invoicing switched off again' });
      if (r.status !== 200) throw new Error(r.body.error);
    }
  }

  it('C11: Rs 1,18,000 invoice; the hotel deducts 2% and pays Rs 1,16,000; suggested receipt + TDS Rs 2,000 settles it', async () => {
    const inv = await issue({ docDate: '2026-10-05', lines: [{ invProductId: trap, qty: '1', rate: '100000' }] });
    expect(inv.total).toBe('118000.00');
    expect(await receivable(inv.id)).toMatchObject({ state: 'unpaid', outstanding: '118000.00' });
    // TDS is refused until the customer is set to deduct it (off by default).
    const refused = await agent.post('/api/receipts/preview').send({ receiptDate: '2026-10-14', companyId, mode: 'neft', amount: '116000', allocations: [{ docId: inv.id, amount: '118000', tds: '2000' }] });
    expect(refused.body.error).toMatch(/not set to deduct TDS/);
    const section = await prisma.tdsSection.findFirstOrThrow({ where: { codeOldAct: '194C' } });
    const prof = await agent.put(`/api/customers/${companyId}/profile`).send({ deductsTds: true, tdsSectionId: section.id });
    expect(prof.body.error ?? null).toBeNull();

    const st = await agent.post('/api/bank/imports').send({ bankAccountId: idfc, fileName: 'idfc.csv', contentBase64: csv(`${HEADER}2026-10-14,2026-10-14,NEFT/N${RUN}/LAKE VIEW HOTELS PVT LTD/HDFC0000001/Inv,,,116000,216000`) });
    expect(st.status).toBe(200);
    const rowId = (await prisma.bankTxn.findFirstOrThrow({ where: { bankAccountId: idfc, credit: '116000' } })).id;
    const credit = (await agent.get(`/api/receivables/credits/${rowId}`)).body.data as { id: string; suggestions: { invoiceId: string }[] };
    expect(credit.suggestions[0]).toMatchObject({ invoiceId: inv.id, receipt: '116000.00', tds: '2000.00', tdsRate: '2', settles: true });

    const rct = (await agent.post(`/api/receivables/credits/${credit.id}/receipt`).send({ docId: inv.id, tds: '2000' })).body.data;
    expect(rct.receiptNo).toMatch(/^RCT-\d{4,}$/);
    expect(rct).toMatchObject({ amount: '116000.00', tds: '2000.00', allocated: '118000.00', advance: '0.00', inBank: true });
    expect(await receivable(inv.id)).toMatchObject({ state: 'paid', outstanding: '0.00', received: '116000.00', tds: '2000.00' });
    const row = await prisma.bankTxn.findUniqueOrThrow({ where: { id: credit.id } });
    const revenue = await prisma.category.findUniqueOrThrow({ where: { name: 'Revenue' }, include: { subCategories: true } });
    expect(row).toMatchObject({ linkedDocType: 'Receipt', linkedDocId: rct.id, subCategoryId: revenue.subCategories.find((s) => s.name === 'HoReCa B2B Invoice Receipt')!.id });
    expect(((await agent.get('/api/receivables/tds')).body.data as { customerName: string; quarter: string; tds: string }[]).find((t) => t.customerName === hotel)).toMatchObject({ quarter: '26-27 Q3', tds: '2000.00' });
    // A receipt's money cannot be edited.
    await expect(prisma.receipt.update({ where: { id: rct.id }, data: { amount: '1' } })).rejects.toThrow();
  }, 120_000);

  it('C12: outstanding in ageing buckets; the statement PDF ties to the outstanding', async () => {
    const old = await issue({ docDate: '2026-09-01', lines: [{ invProductId: trap, qty: '1', rate: '20000' }] });
    expect(old.total).toBe('23600.00');
    const ageing = (await agent.get('/api/receivables/ageing')).body.data;
    const mine = ageing.rows.find((r: { companyId: string }) => r.companyId === companyId);
    const days = Math.round((Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) - Date.parse('2026-09-01T00:00:00Z')) / 86_400_000);
    const bucket = days <= 30 ? '1_30' : days <= 60 ? '31_60' : days <= 90 ? '61_90' : '90_plus';
    expect(mine).toMatchObject({ name: hotel, total: '23600.00' });
    expect(mine.buckets[bucket]).toBe('23600.00');
    const out = (await agent.get('/api/receivables/outstanding').query({ companyId })).body.data;
    expect(out.rows.map((r: { docNumber: string }) => r.docNumber)).toEqual([old.docNumber]);
    expect(out.rows[0]).toMatchObject({ overdue: true, daysOverdue: days });

    const to = new Date().toISOString().slice(0, 10);
    const s = (await agent.get(`/api/receivables/statement/${companyId}`).query({ from: '2026-09-01', to })).body.data;
    expect(s).toMatchObject({ opening: '0.00', closing: '23600.00', outstanding: '23600.00', advances: '0.00' });
    expect(s.lines.map((l: { kind: string }) => l.kind)).toEqual(['invoice', 'invoice', 'receipt']);
    const pdf = await agent.get(`/api/receivables/statement/${companyId}/pdf`).query({ from: '2026-09-01', to });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    // A reminder is shared by hand and logged.
    expect((await agent.get(`/api/sales/${old.id}/reminder`)).body.data.text).toContain(old.docNumber);
    expect((await agent.post(`/api/sales/${old.id}/reminder`).send({ channel: 'whatsapp' })).body.data.reminders).toHaveLength(1);
  }, 120_000);

  it('C7: an advance on a proforma moves to the tax invoice made from it; the rest stays on the proforma', async () => {
    const pi = (await agent.post('/api/sales').send({ docType: 'proforma', docDate: '2026-10-14', validUntil: '2026-10-31', customer: outlet(), lines: [{ invProductId: trap, qty: '10' }] })).body.data;
    const issued = (await agent.post(`/api/sales/${pi.id}/issue`)).body.data;
    const adv = await agent.post('/api/receipts').send({ receiptDate: '2026-10-14', companyId, mode: 'neft', amount: '30000', allocations: [{ docId: pi.id, amount: '30000' }] });
    expect(adv.status).toBe(200);
    expect((await agent.get('/api/receivables/ageing')).body.data.rows.find((r: { companyId: string }) => r.companyId === companyId).advances).toBe('30000.00');
    const ti = (await agent.post(`/api/sales/${pi.id}/convert`).send({ docDate: '2026-10-14', lines: [{ sourceLineId: issued.lines[0].id, qty: '6' }] })).body.data;
    const tiIssued = (await agent.post(`/api/sales/${ti.id}/issue`)).body.data;
    expect(tiIssued.total).toBe('27612.00');
    expect(await receivable(ti.id)).toMatchObject({ state: 'paid', received: '27612.00' });
    expect(await receivable(pi.id)).toMatchObject({ received: '2388.00' });
  }, 120_000);

  it('C13: a matched Razorpay settlement marks its order invoice paid with fees and GST on fees; the credit is counted once', async () => {
    const orderNumber = `RCV-${RUN}`;
    const crmProduct = (await prisma.crmProduct.create({ data: { name: `Bloc Trap Mini ${RUN}`, sku: `MINI-${RUN}`, mrp: '1499', taxPercent: '18', priceBeforeTax: '1270.34', invProductId: trap } })).id;
    const o = await prisma.crmOrder.create({ data: {
      orderNumber, channel: 'SHOPIFY', paymentMethod: 'RAZORPAY', totalAmount: '1499', customerName: `Asha Rao ${RUN}`, phone: '+919800000002',
      addressLine1: '5 Church Street', city: 'Bengaluru', state: 'Karnataka', pincode: '560001', status: 'SHIPPED', createdAt: ist('2026-10-09'), shippedAt: ist('2026-10-10'),
    } });
    await prisma.crmOrderItem.create({ data: { orderId: o.id, productId: crmProduct, quantity: 1, mrp: '1499', discountAmount: '0', finalAmount: '1499', priceBeforeTax: '1270.34', taxAmount: '228.66', taxPercent: '18' } });
    const draft = (await agent.post('/api/sales/from-order').send({ orderNumber, docType: 'tax_invoice', docDate: '2026-10-10' })).body.data;
    const inv = (await agent.post(`/api/sales/${draft.id}/issue`)).body.data;
    expect(inv.total).toBe('1499.00');

    const imp = (fileName: string, text: string) => agent.post('/api/recon/imports').send({ source: 'razorpay', fileName, contentBase64: csv(text) });
    await imp('payments.csv', `id,amount,currency,status,order_id,method,amount_refunded,description,email,contact,notes,fee,tax,created_at\npay_R${RUN},1499,INR,captured,order_R${RUN},upi,0,Order #${orderNumber},,,,35.38,5.40,09/10/2026 14:00:00`);
    const utr = `RZPR${RUN}`;
    await imp('settlement.csv', `entity_id,type,debit,credit,amount,currency,fee,tax,settled,created_at,settled_at,settlement_id,settlement_utr,order_receipt\npay_R${RUN},payment,0,1463.62,1499,INR,35.38,5.40,1,09/10/2026 14:00:00,14/10/2026 09:00:00,setl_R${RUN},${utr},${orderNumber}`);
    expect(await receivable(inv.id)).toMatchObject({ state: 'unpaid' }); // not in the bank yet
    const st = await agent.post('/api/bank/imports').send({ bankAccountId: idfc, fileName: 'idfc2.csv', contentBase64: csv(`${HEADER}2026-10-15,2026-10-15,NEFT/${utr}/RAZORPAY SOFTWARE PVT LTD/HDFC0000001/Settlement,,,1463.62,217463.62`) });
    expect(st.status).toBe(200);

    expect(await receivable(inv.id)).toMatchObject({ state: 'paid', outstanding: '0.00' });
    const rcts = (await agent.get('/api/receipts').query({ q: orderNumber })).body.data;
    expect(rcts).toHaveLength(1);
    expect(rcts[0]).toMatchObject({ mode: 'razorpay', amount: '1463.62', bankCharges: '35.38', gstOnCharges: '5.40', total: '1499.00', inBank: false, source: 'settlement' });
    // The bank credit stays with the settlement; the receipt does not claim it again.
    const batch = await prisma.settlementBatch.findUniqueOrThrow({ where: { source_externalId: { source: 'razorpay', externalId: `setl_R${RUN}` } } });
    const row = await prisma.bankTxn.findUniqueOrThrow({ where: { id: batch.bankTxnId! } });
    expect(row.linkedDocType).toBe('SettlementBatch');
    // Running the settling again changes nothing.
    await agent.post('/api/recon/discrepancies/refresh');
    expect((await agent.get('/api/receipts').query({ q: orderNumber })).body.data).toHaveLength(1);
  }, 120_000);
});
