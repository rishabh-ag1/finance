import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request, { type Agent } from 'supertest';
import { prisma } from '../../src/config/database';
import { createApp } from '../../src/app';
import { computeGstinCheckDigit } from '../../src/lib/gstin';
import { closePdfBrowser } from '../../src/pdf/render';
import { hasDb } from '../setup/db';
import { loggedInFounder, seedOnce } from '../setup/fixtures';

// Phase 3 acceptance C9 (D2C invoice on shipping, RTO credit note, fix-list; BR-48, F102, F103),
// C10 (CRM invoice API, every call logged; F105) and the refill plan cycle (F099).
const RUN = Date.now().toString(36).toUpperCase();
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function gstin(state: string) {
  const n = Date.now() + Math.floor(Math.random() * 1e6);
  const l = (i: number) => LETTERS[Math.floor(n / 26 ** i) % 26];
  const first14 = `${state}${l(0)}${l(1)}${l(2)}C${l(3)}${String(n % 10000).padStart(4, '0')}${l(4)}1Z`;
  return first14 + computeGstinCheckDigit(first14);
}
const ist = (day: string, hour = 11) => new Date(Date.parse(`${day}T${String(hour).padStart(2, '0')}:00:00+05:30`));

describe.skipIf(!hasDb)('Acceptance C9-C10: D2C invoicing and the CRM API', () => {
  let app: Express;
  let agent: Agent;
  let crmTrap = '';
  let invTrap = '';
  let companyId = '';
  let hq = '';
  const cod = `D2C-${RUN}-COD`;
  const noAddress = `D2C-${RUN}-NOADDR`;
  const cancelled = `D2C-${RUN}-CXL`;
  const b2b = `D2C-${RUN}-B2B`;

  async function order(orderNumber: string, o: Record<string, unknown>) {
    const row = await prisma.crmOrder.create({
      data: {
        orderNumber, channel: 'WHATSAPP', paymentMethod: 'COD', totalAmount: '4548', customerName: `Priya Kulkarni ${RUN}`, phone: '+919800000001',
        addressLine1: '14 FC Road', city: 'Pune', state: 'Maharashtra', pincode: '411004', codCharges: '49', subtotal: '4999', discount: '500',
        status: 'SHIPPED', createdAt: ist('2026-10-07'), shippedAt: ist('2026-10-08'), ...o,
      },
    });
    await prisma.crmOrderItem.create({ data: { orderId: row.id, productId: crmTrap, quantity: 1, mrp: '4999', discountAmount: '500', finalAmount: '4499', priceBeforeTax: '4236.44', taxAmount: '762.56', taxPercent: '18' } });
    return row;
  }

  beforeAll(async () => {
    await seedOnce();
    app = createApp();
    ({ agent } = await loggedInFounder(app));
    invTrap = (await prisma.invProduct.create({ data: { name: `Bloc Trap Pro ${RUN}`, sku: `TRAPD-${RUN}`, skuNumber: `TD${RUN}`, hsnCode: '8543', priceExclTax: '4236.44', taxRate: '18', priceInclTax: '4999' } })).id;
    crmTrap = (await prisma.crmProduct.create({ data: { name: `Bloc Trap Pro ${RUN}`, sku: `TRAPD-${RUN}`, mrp: '4999', taxPercent: '18', priceBeforeTax: '4236.44', invProductId: invTrap } })).id;
    companyId = (await prisma.crmCompany.create({ data: { name: `Hilltop Cafe ${RUN}` } })).id;
    hq = (await prisma.crmCompanyBranch.create({ data: { companyId, name: 'Koramangala', addressLine1: '80 Feet Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560034', gstNumber: gstin('29') } })).id;
    await order(cod, {});
    await order(noAddress, { addressLine1: null, city: null, state: null, pincode: null });
    await order(cancelled, { paymentMethod: 'RAZORPAY', codCharges: null, totalAmount: '4499', status: 'CANCELLED', shippedAt: null, cancelledAt: ist('2026-10-08') });
    await order(b2b, { orderFor: 'COMPANY', billingBranchId: hq, paymentMethod: 'BANK_TRANSFER', codCharges: null, totalAmount: '4499', status: 'CONFIRMED', shippedAt: null, gstApplicable: true });
    await setSales(true);
  }, 60_000);
  afterAll(async () => {
    await agent.put('/api/d2c/setting').send({ isOn: false, startFrom: '2026-10-01' });
    await setSales(false);
    await closePdfBrowser();
    await prisma.$disconnect();
  });

  async function setSales(on: boolean) {
    const series = (await agent.get('/api/settings/number-series')).body.data as { id: string; docType: string; pattern: string; padding: number; nextNumber: number; isActive: boolean }[];
    for (const s of series.filter((x) => ['tax_invoice', 'proforma', 'credit_note'].includes(x.docType) && x.isActive !== on)) {
      const r = await agent.put(`/api/settings/number-series/${s.id}`).send({ pattern: s.pattern, padding: s.padding, nextNumber: s.nextNumber, isActive: on, reason: on ? 'Test: invoicing switched on' : 'Test: invoicing switched off again' });
      if (r.status !== 200) throw new Error(r.body.error);
    }
  }
  const docsFor = async (orderNumber: string) => (await agent.get('/api/sales').query({ q: orderNumber })).body.data.rows as { id: string; docType: string; status: string; docNumber: string | null; docDate: string; total: string }[];

  it('C9: the COD order shipped 8 Oct is invoiced by the batch, dated 8 Oct, for what the customer paid', async () => {
    expect((await agent.put('/api/d2c/setting').send({ isOn: true, startFrom: '2026-10-01' })).status).toBe(200);
    const run = await agent.post('/api/d2c/run');
    expect(run.status).toBe(200);
    expect(run.body.data.note).toBeNull();

    const [inv] = (await docsFor(cod)).filter((d) => d.docType === 'tax_invoice');
    expect(inv).toMatchObject({ status: 'issued', docDate: '2026-10-08', total: '4548.00' });
    expect(inv.docNumber).toMatch(/^ELPL\/26-27\/\d{5}$/);
    const full = (await agent.get(`/api/sales/${inv.id}`)).body.data;
    expect(full).toMatchObject({ supplyType: 'b2c', placeOfSupply: '27', gstMode: 'igst', crmOrderNumber: cod, source: 'd2c_batch' });
    expect(full.lines.map((l: { description: string; rate: string; discount: string; taxable: string }) => [l.description, l.rate, l.discount, l.taxable])).toEqual([
      [`Bloc Trap Pro ${RUN}`, '4236.44', '423.73', '3812.71'],
      ['Cash on delivery charges', '41.53', '0.00', '41.53'],
    ]);
    // Cancelled before shipping: no invoice.
    expect(await docsFor(cancelled)).toEqual([]);
  }, 120_000);

  it('C9: the order with no address goes to the fix-list without stopping the batch, and is invoiced once fixed', async () => {
    const fix = (await agent.get('/api/d2c')).body.data.fixList as { orderNumber: string; problems: string[] }[];
    expect(fix.find((f) => f.orderNumber === noAddress)?.problems).toEqual(expect.arrayContaining(['Bill-to address is missing', 'Bill-to state is missing']));
    expect(fix.find((f) => f.orderNumber === cod)).toBeUndefined();
    await prisma.crmOrder.update({ where: { orderNumber: noAddress }, data: { addressLine1: '2 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' } });
    const retry = await agent.post(`/api/d2c/orders/${noAddress}/retry`);
    expect(retry.body.data).toMatchObject({ state: 'invoiced', problems: [] });
    const [inv] = await docsFor(noAddress);
    expect(inv).toMatchObject({ status: 'issued', docDate: '2026-10-08' });
    expect((await agent.get(`/api/sales/${inv.id}`)).body.data).toMatchObject({ placeOfSupply: '29', gstMode: 'cgst_sgst' });
  }, 120_000);

  it('C9: RTO on 14 Oct drafts one credit note for review against the invoice', async () => {
    await prisma.crmOrder.update({ where: { orderNumber: cod }, data: { status: 'RETURNED', returnedAt: ist('2026-10-14') } });
    await agent.post('/api/d2c/run');
    await agent.post('/api/d2c/run');
    const docs = await docsFor(cod);
    const inv = docs.find((d) => d.docType === 'tax_invoice')!;
    const cns = docs.filter((d) => d.docType === 'credit_note');
    expect(cns).toHaveLength(1);
    expect(cns[0]).toMatchObject({ status: 'draft', docDate: '2026-10-14', total: '4548.00' });
    const cn = (await agent.get(`/api/sales/${cns[0].id}`)).body.data;
    expect(cn).toMatchObject({ againstInvoiceId: inv.id, creditReason: 'rto', source: 'rto', problems: [] });
    // Finance reviews and issues it.
    expect((await agent.post(`/api/sales/${cns[0].id}/issue`)).body.data.docNumber).toMatch(/^ELCN\/26-27\/\d{4}$/);
  }, 120_000);

  it('C10: the CRM creates and issues an invoice; it gets the number and the PDF link; the call is logged with the user and order', async () => {
    const key = (await agent.post('/api/crm-api/keys').send({ name: `CRM test ${RUN}` })).body.data;
    expect(key.key).toMatch(/^fin_[0-9a-f]{48}$/);
    // The key is shown once: the list has its prefix only.
    expect(JSON.stringify((await agent.get('/api/crm-api/keys')).body.data)).not.toContain(key.key);

    const crm = (path: string) => request(app).post(`/api/integrations/crm/v1${path}`).set('X-Finance-Key', key.key).set('X-Crm-User', `Asha (sales) ${RUN}`);
    const made = await crm('/documents').send({ orderNumber: b2b, docType: 'tax_invoice', issue: true, docDate: '2026-10-14' });
    expect(made.status).toBe(200);
    expect(made.body.data).toMatchObject({ status: 'issued', supplyType: 'b2b', crmOrderNumber: b2b, total: '4499.00' });
    expect(made.body.data.docNumber).toMatch(/^ELPL\/26-27\/\d{5}$/);
    const pdf = await request(app).get(made.body.data.pdfUrl).set('X-Finance-Key', key.key).set('X-Crm-User', `Asha (sales) ${RUN}`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');

    // A second invoice for the same order is refused, and that is logged too.
    expect((await crm('/documents').send({ orderNumber: b2b, docType: 'tax_invoice' })).status).toBe(409);
    // No key, or a wrong one: refused.
    expect((await request(app).post('/api/integrations/crm/v1/documents').set('X-Crm-User', 'x').send({ orderNumber: b2b, docType: 'proforma' })).status).toBe(401);

    const calls = (await agent.get('/api/crm-api/calls').query({ orderNumber: b2b })).body.data as { crmUser: string; statusCode: number; docNumber: string | null; method: string; error: string | null }[];
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ crmUser: `Asha (sales) ${RUN}`, method: 'POST', statusCode: 200, docNumber: made.body.data.docNumber }),
      expect.objectContaining({ crmUser: `Asha (sales) ${RUN}`, statusCode: 409, error: expect.stringMatching(/already invoiced/) }),
    ]));
    // The log cannot be edited.
    await expect(prisma.crmApiCall.updateMany({ where: { crmOrderNumber: b2b }, data: { statusCode: 200 } })).rejects.toThrow();

    // A revoked key stops working.
    await agent.post(`/api/crm-api/keys/${key.id}/revoke`).send({ reason: 'Test: key rotated' });
    expect((await crm(`/documents/${made.body.data.id}`).send()).status).toBe(401);
  }, 120_000);

  it('F099: a due refill plan drafts a tax invoice for the outlet and moves to its next cycle', async () => {
    const saved = await agent.post('/api/refills').send({ crmCompanyId: companyId, crmBranchId: hq, invProductId: invTrap, qty: '3', rate: '250', everyMonths: 1, nextDate: '2026-10-01' });
    expect(saved.status).toBe(200);
    const due = await agent.post('/api/refills/draft-due');
    expect(due.body.data.failed).toEqual([]);
    const plan = ((await agent.get('/api/refills').query({ companyId })).body.data as { id: string; nextDate: string; lastDoc: { id: string; status: string } | null }[])[0];
    expect(plan).toMatchObject({ nextDate: '2026-11-01', lastDoc: { status: 'draft' } });
    const draft = (await agent.get(`/api/sales/${plan.lastDoc!.id}`)).body.data;
    expect(draft).toMatchObject({ docType: 'tax_invoice', source: 'refill', taxable: '750.00', total: '885.00' });
  }, 120_000);
});
