import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Agent } from 'supertest';
import { prisma } from '../../src/config/database';
import { createApp } from '../../src/app';
import { computeGstinCheckDigit } from '../../src/lib/gstin';
import { hasDb } from '../setup/db';
import { loggedInFounder, seedOnce } from '../setup/fixtures';

// Phase 3 acceptance C1 (customers from the CRM with Finance fields, F080-F082) and C2 (products
// from bloc-inv and price lists, F120, F121). Companies, outlets and products sit in the reader
// stubs (crm_stub, inv_stub), as the CRM and bloc-inv would hold them.
const RUN = Date.now().toString(36).toUpperCase();
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function gstin(state: string) {
  const n = Date.now() + Math.floor(Math.random() * 1e6);
  const l = (i: number) => LETTERS[Math.floor(n / 26 ** i) % 26];
  const first14 = `${state}${l(0)}${l(1)}${l(2)}C${l(3)}${String(n % 10000).padStart(4, '0')}${l(4)}1Z`;
  return first14 + computeGstinCheckDigit(first14);
}

describe.skipIf(!hasDb)('Acceptance C1, C2: customers and products', () => {
  let app: Express;
  let agent: Agent;
  let companyId = '';
  let goa = '';
  let hq = '';
  let trap = '';
  let sachet = '';

  beforeAll(async () => {
    await seedOnce();
    app = createApp();
    ({ agent } = await loggedInFounder(app));
    const c = await prisma.crmCompany.create({ data: { name: `Sunrise Hotels ${RUN}`, chainType: 'MULTI_OUTLET' } });
    companyId = c.id;
    hq = (await prisma.crmCompanyBranch.create({ data: { companyId, name: 'Bengaluru HQ', addressLine1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001', gstNumber: gstin('29') } })).id;
    goa = (await prisma.crmCompanyBranch.create({ data: { companyId, name: 'Goa Beach', addressLine1: 'Calangute', city: 'Goa', state: 'Goa', pincode: '403516' } })).id;
    const person = await prisma.crmContact.create({ data: { contactCode: `C${RUN}`, phoneNumber: `+91${Date.now()}`.slice(0, 13), name: 'Anita Rao', email: 'anita@sunrise.example' } });
    await prisma.crmCompanyContact.create({ data: { companyId, contactId: person.id, role: 'PRIMARY' } });
    await prisma.crmOrder.create({ data: { orderNumber: `TST-${RUN}-C1`, channel: 'MANUAL', paymentMethod: 'BANK_TRANSFER', totalAmount: '49990', customerName: 'Sunrise Hotels', phone: '+919800000000', billingBranchId: hq, orderFor: 'COMPANY' } });
    trap = (await prisma.invProduct.create({ data: { name: `Bloc Trap Pro ${RUN}`, sku: `TRAP-${RUN}`, skuNumber: `T${RUN}`, hsnCode: '8543', priceExclTax: '4236.44', taxRate: '18', priceInclTax: '4999.00' } })).id;
    sachet = (await prisma.invProduct.create({ data: { name: `Lure sachet ${RUN}`, sku: `SACH-${RUN}`, skuNumber: `S${RUN}`, hsnCode: null, priceExclTax: '253.39', taxRate: '5', priceInclTax: '266.06' } })).id;
    await prisma.invProductCost.create({ data: { productId: trap, unitCost: '1650.00', validFrom: new Date('2026-09-01T00:00:00Z') } });
  }, 60_000);
  afterAll(async () => { await prisma.$disconnect(); });

  it('C1: customers come from the CRM; a new one defaults to On delivery and no TDS', async () => {
    const list = (await agent.get(`/api/customers?q=${RUN}`)).body.data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: `Sunrise Hotels ${RUN}`, outlets: 2, paymentTerms: 'On delivery', deductsTds: false, channel: 'horeca', creditLimit: null });
    const c = (await agent.get(`/api/customers/${companyId}`)).body.data;
    expect(c.outlets.find((o: { id: string }) => o.id === hq)).toMatchObject({ invoiceType: 'B2B', stateCode: '29', stateName: 'Karnataka' });
    expect(c.outlets.find((o: { id: string }) => o.id === goa)).toMatchObject({ invoiceType: 'B2C', stateCode: '30', gstin: null });
    expect(c.contacts[0]).toMatchObject({ name: 'Anita Rao', role: 'PRIMARY' });
    expect(c.orders.map((o: { orderNumber: string }) => o.orderNumber)).toContain(`TST-${RUN}-C1`);
    // Finance never creates a customer the CRM does not have.
    expect((await agent.put('/api/customers/no-such-company/profile').send({ channel: 'horeca' })).status).toBe(404);
  }, 60_000);

  it('C1: Finance fields: the company sets terms and a limit; an outlet bills the head office', async () => {
    const net30 = await prisma.paymentTerm.findUniqueOrThrow({ where: { label: 'Net 30' } });
    const r = await agent.put(`/api/customers/${companyId}/profile`).send({ paymentTermId: net30.id, creditLimit: '2,00,000', invoiceEmails: ['ap@sunrise.example'], channel: 'horeca' });
    expect(r.status).toBe(200);
    expect(r.body.data.profile).toMatchObject({ paymentTerms: 'Net 30', creditLimit: '200000.00', invoiceEmails: ['ap@sunrise.example'] });
    const o = await agent.put(`/api/customers/${companyId}/outlets/${goa}/profile`).send({ invoiceEmails: ['goa@sunrise.example'], billToBranchId: hq });
    expect(o.body.data.outlets.find((x: { id: string }) => x.id === goa).profile).toMatchObject({ paymentTerms: 'Net 30', invoiceEmails: ['goa@sunrise.example'], billToBranchId: hq });
    expect((await agent.put(`/api/customers/${companyId}/profile`).send({ invoiceEmails: ['not-an-email'] })).body.error).toMatch(/not an e-mail/);
  }, 60_000);

  it('C2: products from bloc-inv with HSN, GST and unit cost; problems are flagged', async () => {
    const p = (await agent.get('/api/products')).body.data;
    expect(p.rows.find((x: { id: string }) => x.id === trap)).toMatchObject({ hsn: '8543', gstRate: '18.00', priceExclTax: '4236.44', unitCost: '1650.00', problems: [] });
    expect(p.rows.find((x: { id: string }) => x.id === sachet).problems).toEqual([
      'No HSN in bloc-inv: it cannot go on an invoice until added there',
      'GST 5.00% in bloc-inv; customers are charged 18% (Q29)',
    ]);
  }, 60_000);

  it('C2: a HoReCa customer\'s line takes the HoReCa price-list rate; a new price ends the old one', async () => {
    const list = (await agent.post('/api/price-lists').send({ name: `HoReCa ${RUN}`, kind: 'horeca', taxInclusive: false })).body.data;
    let pl = (await agent.post(`/api/price-lists/${list.id}/prices`).send({ invProductId: trap, price: '3900', effectiveFrom: '2026-10-01' })).body.data;
    expect(pl.items[0]).toMatchObject({ sku: `TRAP-${RUN}`, price: '3900.00', effectiveTo: null, rateBeforeGst: '3900.00' });
    // No price list yet: the line starts from bloc-inv's price.
    expect((await agent.get(`/api/products/${trap}/price?companyId=${companyId}&branchId=${hq}&date=2026-10-14`)).body.data).toMatchObject({ rate: '4236.44', source: 'bloc-inv price before tax' });
    await agent.put(`/api/customers/${companyId}/profile`).send({ priceListId: list.id, channel: 'horeca' });
    expect((await agent.get(`/api/products/${trap}/price?companyId=${companyId}&branchId=${hq}&date=2026-10-14`)).body.data).toMatchObject({ rate: '3900.00', source: `HoReCa ${RUN} price list`, hsn: '8543', gstRate: '18.00' });
    pl = (await agent.post(`/api/price-lists/${list.id}/prices`).send({ invProductId: trap, price: '3850', effectiveFrom: '2026-11-01' })).body.data;
    const items = pl.items.filter((i: { invProductId: string }) => i.invProductId === trap);
    expect(items.map((i: { price: string; effectiveTo: string | null }) => [i.price, i.effectiveTo])).toEqual([['3850.00', null], ['3900.00', '2026-10-31']]);
    // A price is never edited in place (database).
    await expect(prisma.priceListItem.update({ where: { id: items[1].id }, data: { price: '1' } })).rejects.toThrow();
  }, 60_000);
});
