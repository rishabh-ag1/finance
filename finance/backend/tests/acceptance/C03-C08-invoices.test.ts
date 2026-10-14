import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Agent } from 'supertest';
import { prisma } from '../../src/config/database';
import { createApp } from '../../src/app';
import { computeGstinCheckDigit } from '../../src/lib/gstin';
import { closePdfBrowser } from '../../src/pdf/render';
import { hasDb } from '../setup/db';
import { loggedInFounder, seedOnce } from '../setup/fixtures';

// Phase 3 acceptance C3 (numbering, BR-30), C4 (B2B vs B2C, BR-49 / BR-20), C5 (rounding, BR-21),
// C6 (checks on issue, F094 / BR-32), C7 (proforma to tax invoice, BR-33; the advance part comes
// with receipts in Step 17) and C8 (cancel vs credit note, BR-34).
const RUN = Date.now().toString(36).toUpperCase();
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function gstin(state: string) {
  const n = Date.now() + Math.floor(Math.random() * 1e6);
  const l = (i: number) => LETTERS[Math.floor(n / 26 ** i) % 26];
  const first14 = `${state}${l(0)}${l(1)}${l(2)}C${l(3)}${String(n % 10000).padStart(4, '0')}${l(4)}1Z`;
  return first14 + computeGstinCheckDigit(first14);
}

describe.skipIf(!hasDb)('Acceptance C3-C8: invoices', () => {
  let app: Express;
  let agent: Agent;
  let companyId = '';
  let hq = '';
  let trap = '';
  let noHsn = '';
  const outlet = () => ({ kind: 'outlet', companyId, branchId: hq });
  const pune = { kind: 'one_off', name: `Priya Kulkarni ${RUN}`, address: '14 FC Road, Pune 411004', state: 'Maharashtra', phone: '+919800000001' };
  const draft = async (body: object) => {
    const r = await agent.post('/api/sales').send({ docType: 'tax_invoice', docDate: '2026-10-14', customer: outlet(), lines: [{ invProductId: trap, qty: '2' }], ...body });
    if (r.status !== 200) throw new Error(r.body.error);
    return r.body.data;
  };

  beforeAll(async () => {
    await seedOnce();
    app = createApp();
    ({ agent } = await loggedInFounder(app));
    companyId = (await prisma.crmCompany.create({ data: { name: `Lake View Hotels ${RUN}` } })).id;
    hq = (await prisma.crmCompanyBranch.create({ data: { companyId, name: 'Indiranagar', addressLine1: '100 Feet Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560038', gstNumber: gstin('29') } })).id;
    trap = (await prisma.invProduct.create({ data: { name: `Bloc Trap Pro ${RUN}`, sku: `TRAPI-${RUN}`, skuNumber: `TI${RUN}`, hsnCode: '8543', priceExclTax: '3900', taxRate: '18', priceInclTax: '4602' } })).id;
    noHsn = (await prisma.invProduct.create({ data: { name: `Lure sachet ${RUN}`, sku: `SACHI-${RUN}`, skuNumber: `SI${RUN}`, hsnCode: null, priceExclTax: '253.39', taxRate: '18', priceInclTax: '299' } })).id;
    // Switch the sales series on, as a founder does in Settings > Numbering.
    await setSales(true);
  }, 60_000);
  // Leave the sales series as seeded (off), so other tests see the shipped state.
  afterAll(async () => { await setSales(false); await closePdfBrowser(); await prisma.$disconnect(); });

  async function setSales(on: boolean) {
    const series = (await agent.get('/api/settings/number-series')).body.data as { id: string; docType: string; pattern: string; padding: number; nextNumber: number; isActive: boolean }[];
    for (const s of series.filter((x) => ['tax_invoice', 'proforma', 'credit_note'].includes(x.docType) && x.isActive !== on)) {
      const r = await agent.put(`/api/settings/number-series/${s.id}`).send({ pattern: s.pattern, padding: s.padding, nextNumber: s.nextNumber, isActive: on, reason: on ? 'Test: invoicing switched on' : 'Test: invoicing switched off again' });
      if (r.status !== 200) throw new Error(r.body.error);
    }
  }

  it('C4: hotel with a GSTIN in Karnataka is B2B with CGST + SGST; a home customer in Pune is B2C with IGST, place of supply 27', async () => {
    const b2b = (await agent.post('/api/sales/preview').send({ docType: 'tax_invoice', docDate: '2026-10-14', customer: outlet(), lines: [{ invProductId: trap, qty: '2' }] })).body.data;
    expect(b2b).toMatchObject({ supplyType: 'b2b', placeOfSupply: '29', gstMode: 'cgst_sgst', totals: { taxable: '7800.00', cgst: '702.00', sgst: '702.00', igst: '0.00', total: '9204.00' } });
    const b2c = (await agent.post('/api/sales/preview').send({ docType: 'tax_invoice', docDate: '2026-10-14', customer: pune, lines: [{ invProductId: trap, qty: '1' }] })).body.data;
    expect(b2c).toMatchObject({ supplyType: 'b2c', placeOfSupply: '27', gstMode: 'igst', totals: { igst: '702.00', total: '4602.00' } });
    expect(b2c.billTo.gstin).toBeNull();
  }, 60_000);

  it('C5: Rs 37,401.28 is shown as Rs 37,401.00 with round off -0.28, and the amount in words', async () => {
    const p = (await agent.post('/api/sales/preview').send({ docType: 'tax_invoice', docDate: '2026-10-14', customer: outlet(), lines: [{ invProductId: trap, qty: '1', rate: '31696' }] })).body.data;
    expect(p.totals).toMatchObject({ taxable: '31696.00', cgst: '2852.64', sgst: '2852.64', roundOff: '-0.28', total: '37401.00' });
    expect(p.amountInWords).toBe('Rupees Thirty Seven Thousand Four Hundred One Only');
  }, 60_000);

  it('C6: a line without HSN is refused at issue, in plain words', async () => {
    const d = await draft({ lines: [{ invProductId: noHsn, qty: '1' }] });
    expect(d.docNumber).toBeNull();
    expect(d.problems).toContain(`Line 1 (Lure sachet ${RUN}) has no HSN code`);
    const r = await agent.post(`/api/sales/${d.id}/issue`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/no HSN code/);
  }, 60_000);

  it('C3: drafts have no number; two issues at once get consecutive numbers of at most 16 characters', async () => {
    const [a, b] = [await draft({}), await draft({})];
    expect(a.docNumber).toBeNull();
    const [ra, rb] = await Promise.all([agent.post(`/api/sales/${a.id}/issue`), agent.post(`/api/sales/${b.id}/issue`)]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    const nums = [ra.body.data.docNumber, rb.body.data.docNumber].sort();
    for (const n of nums) { expect(n).toMatch(/^ELPL\/26-27\/\d{5}$/); expect(n.length).toBe(16); }
    expect(Number(nums[1].slice(-5)) - Number(nums[0].slice(-5))).toBe(1);
    expect(ra.body.data).toMatchObject({ status: 'issued', supplyType: 'b2b', dueDate: '2026-10-14' });
    // The PDF is filed with it (Original, Duplicate, Triplicate) and the document is frozen.
    expect(ra.body.data.pdfAttachmentId).toBeTruthy();
    await expect(prisma.salesDocument.update({ where: { id: a.id }, data: { total: '1' } })).rejects.toThrow();
    await expect(prisma.salesDocumentLine.updateMany({ where: { docId: a.id }, data: { qty: '9' } })).rejects.toThrow();
  }, 120_000);

  it('C7: a proforma converts in part, then in full; it shows Partly converted, then Converted', async () => {
    const pi = (await agent.post('/api/sales').send({ docType: 'proforma', docDate: '2026-10-14', validUntil: '2026-10-31', customer: outlet(), lines: [{ invProductId: trap, qty: '10' }] })).body.data;
    const issued = (await agent.post(`/api/sales/${pi.id}/issue`)).body.data;
    expect(issued.docNumber).toMatch(/^ELPL\/PI\/26-27\/\d{4}$/);
    const lineId = issued.lines[0].id;
    const ti1 = (await agent.post(`/api/sales/${pi.id}/convert`).send({ docDate: '2026-10-14', lines: [{ sourceLineId: lineId, qty: '6' }] })).body.data;
    expect(ti1).toMatchObject({ docType: 'tax_invoice', proformaId: pi.id, lines: [{ qty: '6', rate: '3900.00', sourceLineId: lineId }] });
    expect((await agent.get(`/api/sales/${pi.id}`)).body.data).toMatchObject({ status: 'partly_converted', lines: [{ remainingToConvert: '4' }] });
    expect((await agent.post(`/api/sales/${pi.id}/convert`).send({ docDate: '2026-10-14', lines: [{ sourceLineId: lineId, qty: '5' }] })).body.error).toMatch(/only 4 left/);
    const ti1Issued = (await agent.post(`/api/sales/${ti1.id}/issue`)).body.data;
    expect(ti1Issued.lines[0].priceSource).toBe(`proforma ${issued.docNumber}`);
    const ti2 = (await agent.post(`/api/sales/${pi.id}/convert`).send({ docDate: '2026-10-14' })).body.data;
    expect(ti2.lines[0].qty).toBe('4');
    expect((await agent.get(`/api/sales/${pi.id}`)).body.data.status).toBe('converted');
  }, 120_000);

  it('C8: cancel before GSTR-1 keeps the number; once GSTR-1 is filed only a credit note will do', async () => {
    const oct = await draft({});
    const issued = (await agent.post(`/api/sales/${oct.id}/issue`)).body.data;
    const cancelled = (await agent.post(`/api/sales/${oct.id}/cancel`).send({ reason: 'Wrong outlet billed' })).body.data;
    expect(cancelled).toMatchObject({ status: 'cancelled', docNumber: issued.docNumber, statusReason: 'Wrong outlet billed' });

    const sep = await draft({ docDate: '2026-09-28' });
    const sepIssued = (await agent.post(`/api/sales/${sep.id}/issue`)).body.data;
    const filed = await agent.post('/api/gstr1').send({ month: '2026-09', filedOn: '2026-10-11', arn: 'AA2909261234567' });
    expect([200, 400]).toContain(filed.status); // already marked by an earlier run is fine
    const refused = await agent.post(`/api/sales/${sep.id}/cancel`).send({ reason: 'Price was wrong' });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/raise a credit note/);
    expect((await agent.get(`/api/sales/${sep.id}`)).body.data.cancelRoute).toBe('credit_note');

    const cn = (await agent.post(`/api/sales/${sep.id}/credit-note`).send({ docDate: '2026-10-14', creditReason: 'rate_difference', lines: [{ sourceLineId: sepIssued.lines[0].id, qty: '2', rate: '400' }] })).body.data;
    expect(cn).toMatchObject({ docType: 'credit_note', againstInvoiceId: sep.id, taxable: '800.00', total: '944.00', problems: [] });
    const cnIssued = (await agent.post(`/api/sales/${cn.id}/issue`)).body.data;
    expect(cnIssued.docNumber).toMatch(/^ELCN\/26-27\/\d{4}$/);
    // More than the invoice line is refused.
    expect((await agent.post(`/api/sales/${sep.id}/credit-note`).send({ docDate: '2026-10-14', creditReason: 'return', lines: [{ sourceLineId: sepIssued.lines[0].id, qty: '3' }] })).body.error).toMatch(/more than the 2/);
  }, 120_000);
});
