import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Agent } from 'supertest';
import { prisma } from '../../src/config/database';
import { createApp } from '../../src/app';
import { withAudit } from '../../src/lib/audit';
import { computeGstinCheckDigit } from '../../src/lib/gstin';
import { closePdfBrowser } from '../../src/pdf/render';
import { hasDb } from '../setup/db';
import { loggedInFounder, seedOnce } from '../setup/fixtures';

// Phase 2 acceptance B3-B7 and F050-F059 on vendor documents.
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function testGstin(state: string, kind: 'P' | 'C') {
  const n = Date.now() + Math.floor(Math.random() * 1e6);
  const l = (i: number) => LETTERS[Math.floor(n / 26 ** i) % 26];
  const pan = `${l(0)}${l(1)}${l(2)}${kind}${l(3)}${String(n % 10000).padStart(4, '0')}${l(4)}`;
  const first14 = `${state}${pan}1Z`;
  return first14 + computeGstinCheckDigit(first14);
}
const PDF = Buffer.from('%PDF-1.4\n% vendor invoice for tests\n').toString('base64');

describe.skipIf(!hasDb)('Acceptance B3-B7: vendor bills', () => {
  let app: Express;
  let agent: Agent;
  let saiffi = '';   // Haryana proprietor, TDS 194C
  let videaim = '';  // Karnataka company, TDS 194J professional fees
  let valco = '';    // Karnataka company, no TDS section
  let s194C = '';
  let s194J = '';

  const line = (rate: string, gstRate = '18', extra: object = {}) => ({ description: 'Item', hsnSac: '8480', qty: '1', unit: 'Nos', rate, discount: '0', gstRate, ...extra });
  const bill = (vendorId: string, docNumber: string, extra: object = {}) => ({ docType: 'tax_invoice', vendorId, docNumber, docDate: '2026-07-24', lines: [line('980000')], ...extra });

  beforeAll(async () => {
    await seedOnce();
    app = createApp();
    ({ agent } = await loggedInFounder(app));
    s194C = (await prisma.tdsSection.findFirstOrThrow({ where: { codeOldAct: '194C' } })).id;
    s194J = (await prisma.tdsSection.findFirstOrThrow({ where: { codeOldAct: '194J', nature: 'Professional fees' } })).id;
    const mk = async (name: string, gstin: string, defaultTdsSectionId: string | null) =>
      (await agent.post('/api/vendors').send({ displayName: `${name} ${Date.now()}`, vendorType: 'both', gstin, defaultTdsSectionId, activate: true })).body.data.id as string;
    saiffi = await mk('Saiffi like', testGstin('06', 'P'), s194C);
    videaim = await mk('VideAim like', testGstin('29', 'C'), s194J);
    valco = await mk('Valco like', testGstin('29', 'C'), null);
  }, 60_000);
  afterAll(async () => { await closePdfBrowser(); await prisma.$disconnect(); });

  it('B3: Saiffi 040 is IGST; TDS 194C suggested at the individual rate; 2% needs a reason; net Rs 11,36,800', async () => {
    const pre = (await agent.post('/api/bills/preview').send(bill(saiffi, '040'))).body.data;
    expect(pre).toMatchObject({ gstMode: 'igst', taxableValue: '980000.00', igst: '176400.00', totalValue: '1156400.00' });
    expect(pre.tds).toMatchObject({ applicable: true, rate: '1.00', amount: '9800.00' });
    expect(pre.tdsSuggestion.reason).toMatch(/individual/);

    const twoPercent = { applicable: true, sectionId: s194C, rate: '2', amount: '19600' };
    const refused = await agent.post('/api/bills').send(bill(saiffi, '040', { tds: twoPercent }));
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/reason/);
    const ok = await agent.post('/api/bills').send(bill(saiffi, '040', { tds: { ...twoPercent, overrideReason: 'Deducted at 2% as paid; CA to confirm (Q15)' } }));
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'received', tdsAmount: '19600.00', netPayable: '1136800.00', outstanding: '1136800.00' });
    expect(ok.body.data.tds).toMatchObject({ overrideReason: 'Deducted at 2% as paid; CA to confirm (Q15)', suggestion: expect.objectContaining({ amount: '9800.00' }) });
  });

  it('B4: VideAim Rs 17,000 + GST Rs 3,060 + fees Rs 1,000 = Rs 21,060; TDS 10% Rs 1,700; net Rs 19,360', async () => {
    const r = await agent.post('/api/bills').send({
      ...bill(videaim, 'PI0037', { docDate: '2026-09-03' }), lines: [line('17000')], otherCharges: '1000',
      tds: { applicable: true, sectionId: s194J, rate: '10', overrideReason: 'Deducted at 10% on the first bill' },
    });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ gstMode: 'cgst_sgst', cgst: '1530.00', sgst: '1530.00', otherCharges: '1000.00', totalValue: '21060.00', tdsAmount: '1700.00', netPayable: '19360.00' });
  });

  it('B5: a bill linked to a PO makes it Partially Billed; billing beyond the PO is refused (BR-17)', async () => {
    const po = (await agent.post('/api/purchases/pos').send({
      vendorId: saiffi, poDate: '2026-07-22', placeOfSupplyState: '29', deliveryAddress: 'Bengaluru office', lines: [line('2891000')],
    })).body.data;
    await agent.post(`/api/purchases/pos/${po.id}/issue`);
    const b = await agent.post('/api/bills').send(bill(saiffi, `PO-${Date.now()}`, { poId: po.id, lines: [line('980000', '18', { poLineId: po.lines[0].id })] }));
    expect(b.status).toBe(200);
    const after = (await agent.get(`/api/purchases/pos/${po.id}`)).body.data;
    expect(after).toMatchObject({ status: 'partially_billed', billedTaxable: b.body.data.taxableValue });
    const over = await agent.post('/api/bills').send(bill(saiffi, `PO2-${Date.now()}`, { poId: po.id, lines: [line('2000000')] }));
    expect(over.body.error).toMatch(/Amend the PO first/);
  }, 60_000);

  it('B6: the same vendor + number + FY is refused, ignoring case and spaces; cancelling frees the number', async () => {
    const n = `inv ${Date.now()}`;
    const first = (await agent.post('/api/bills').send(bill(valco, n, { lines: [line('1000')] }))).body.data;
    const dup = await agent.post('/api/bills').send(bill(valco, n.toUpperCase().replace(' ', '  '), { lines: [line('2000')] }));
    expect(dup.status).toBe(400);
    expect(dup.body.error).toMatch(/already entered/);
    expect((await agent.post(`/api/bills/${first.id}/cancel`).send({ reason: 'Entered twice by mistake' })).body.data.status).toBe('cancelled');
    expect((await agent.post('/api/bills').send(bill(valco, n, { lines: [line('1000')] }))).status).toBe(200);
  });

  it('B7: a proforma waits for the tax invoice and is on the chase list; the tax invoice replaces it', async () => {
    const n = `931842454696864-${Date.now()}`;
    const pi = (await agent.post('/api/bills').send({ ...bill(valco, n, { docDate: '2026-09-01' }), docType: 'proforma', lines: [line('53084.75')] })).body.data;
    expect(pi).toMatchObject({ status: 'awaiting_tax_invoice', totalValue: '62640.00', tdsAmount: '0.00' });
    const chase = (await agent.get('/api/bills/chase')).body.data;
    expect(chase.rows.find((r: { id: string }) => r.id === pi.id)).toMatchObject({ due: true });

    const ti = (await agent.post('/api/bills').send(bill(valco, `TI-${n}`, { docDate: '2026-10-05', replacesDocumentId: pi.id, lines: [line('53084.75')] }))).body.data;
    expect(ti.status).toBe('received');
    expect((await agent.get(`/api/bills/${pi.id}`)).body.data).toMatchObject({ status: 'replaced', replacedBy: expect.objectContaining({ id: ti.id }) });
    expect((await agent.get('/api/bills/chase')).body.data.rows.some((r: { id: string }) => r.id === pi.id)).toBe(false);

    await agent.post(`/api/bills/${ti.id}/cancel`).send({ reason: 'Wrong invoice entered' });
    expect((await agent.get(`/api/bills/${pi.id}`)).body.data.status).toBe('awaiting_tax_invoice');
  });

  it('OK to pay needs the vendor file; editing an approved bill sends it back; holds need a reason', async () => {
    const b = (await agent.post('/api/bills').send(bill(valco, `OK-${Date.now()}`, { lines: [line('5000')] }))).body.data;
    expect((await agent.post(`/api/bills/${b.id}/approve`)).body.error).toMatch(/Attach/);
    await agent.post('/api/attachments').send({ recordType: 'VendorDocument', recordId: b.id, docKind: 'bill', fileName: 'invoice.pdf', contentBase64: PDF });
    expect((await agent.post(`/api/bills/${b.id}/approve`)).body.data.status).toBe('approved');
    const edited = await agent.put(`/api/bills/${b.id}`).send(bill(valco, b.docNumber, { lines: [line('5100')] }));
    expect(edited.body.data.status).toBe('received');
    expect((await agent.post(`/api/bills/${b.id}/dispute`).send({ reason: '' })).status).toBe(400);
    expect((await agent.post(`/api/bills/${b.id}/dispute`).send({ reason: 'Wrong quantity' })).body.data.status).toBe('disputed');
    expect((await agent.post(`/api/bills/${b.id}/resolve`)).body.data.status).toBe('received');
  });

  it('a vendor credit note reduces what is still owed on the invoice', async () => {
    const inv = (await agent.post('/api/bills').send(bill(valco, `CNI-${Date.now()}`, { lines: [line('10000')] }))).body.data;
    const cn = await agent.post('/api/bills').send({ ...bill(valco, `CN-${Date.now()}`, { lines: [line('1000')] }), docType: 'credit_note', againstDocumentId: inv.id });
    expect(cn.status).toBe(200);
    expect((await agent.get(`/api/bills/${inv.id}`)).body.data).toMatchObject({ netPayable: '11800.00', outstanding: '10620.00' });
  });

  it('a paid document is frozen by the database; delete is refused', async () => {
    const b = (await agent.post('/api/bills').send(bill(valco, `PD-${Date.now()}`, { lines: [line('100')] }))).body.data;
    await withAudit({ userId: 'system', reason: 'test: mark paid' }, (tx) => tx.vendorDocument.update({ where: { id: b.id }, data: { status: 'paid' } }));
    await expect(withAudit({ userId: 'system' }, (tx) => tx.vendorDocument.update({ where: { id: b.id }, data: { taxableValue: '1', totalValue: '1', igst: '0', cgst: '0', sgst: '0', roundOff: '0' } }))).rejects.toThrow(/cannot be edited/);
    expect((await agent.put(`/api/bills/${b.id}`).send(bill(valco, b.docNumber, { lines: [line('200')] }))).status).toBe(400);
    expect((await agent.delete(`/api/vendordocuments/${b.id}`)).status).toBe(409);
  });
});
