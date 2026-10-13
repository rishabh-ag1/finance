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

// Phase 2 acceptance B1, B2, B15 and F041-F048 on purchase orders.
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** A valid, unique GSTIN for a test vendor in a state; the 4th PAN letter is P (proprietor) or C. */
function testGstin(state: string, kind: 'P' | 'C') {
  const n = Date.now() + Math.floor(Math.random() * 1e6);
  const l = (i: number) => LETTERS[Math.floor(n / 26 ** i) % 26];
  const pan = `${l(0)}${l(1)}${l(2)}${kind}${l(3)}${String(n % 10000).padStart(4, '0')}${l(4)}`;
  const first14 = `${state}${pan}1Z`;
  return first14 + computeGstinCheckDigit(first14);
}

describe.skipIf(!hasDb)('Acceptance B1, B2, B15: purchase orders', () => {
  let app: Express;
  let agent: Agent;
  let other: Agent;
  let haryana = '';   // like Saiffi: Haryana (06), proprietor
  let karnataka = ''; // like Makenica: Karnataka (29)
  let office = '';

  const line = { description: 'Tooling moulds, 1 set', hsnSac: '8480', qty: '1', unit: 'Set', rate: '980000', discount: '0', gstRate: '18' };
  const poBody = (vendorId: string, extra: object = {}) => ({ vendorId, poDate: '2026-10-13', deliveryAddressId: office, lines: [line], ...extra });

  beforeAll(async () => {
    await seedOnce();
    app = createApp();
    ({ agent } = await loggedInFounder(app));
    ({ agent: other } = await loggedInFounder(app));
    const mk = async (name: string, gstin: string) =>
      (await agent.post('/api/vendors').send({ displayName: `${name} ${Date.now()}`, vendorType: 'goods', gstin, activate: true })).body.data.id as string;
    haryana = await mk('Tooling Haryana', testGstin('06', 'P'));
    karnataka = await mk('Prints Karnataka', testGstin('29', 'C'));
    office = (await prisma.deliveryAddress.findUniqueOrThrow({ where: { label: 'Bangalore office' } })).id;
  }, 60_000);
  afterAll(async () => { await closePdfBrowser(); await prisma.$disconnect(); });

  it('B2: Haryana vendor delivering to Karnataka is IGST 18%; Karnataka vendor is CGST 9% + SGST 9%', async () => {
    const a = await agent.post('/api/purchases/pos').send(poBody(haryana));
    expect(a.status).toBe(200);
    expect(a.body.data).toMatchObject({ gstMode: 'igst', taxable: '980000.00', igst: '176400.00', cgst: '0.00', total: '1156400.00' });
    const b = await agent.post('/api/purchases/pos').send(poBody(karnataka, { lines: [{ ...line, rate: '15847.46' }] }));
    expect(b.body.data).toMatchObject({ gstMode: 'cgst_sgst', cgst: '1426.27', sgst: '1426.27', igst: '0.00', roundOff: '0.00', total: '18700.00' });
    expect(b.body.data.amountInWords).toBe('Rupees Eighteen Thousand Seven Hundred Only');
  });

  it('B1: no number while draft; the number and PDF come on Issue (BR-30)', async () => {
    const draft = (await agent.post('/api/purchases/pos').send(poBody(haryana, { quoteRef: 'Q-040', milestones: [{ label: 'advance', percent: '40' }, { label: 'on T1 approval', percent: '60' }] }))).body.data;
    expect(draft.poNumber).toBeNull();
    expect(draft.status).toBe('draft');
    const series = await prisma.numberSeries.findFirstOrThrow({ where: { docType: 'purchase_order', fyLabel: '26-27' } });

    const issued = await agent.post(`/api/purchases/pos/${draft.id}/issue`);
    expect(issued.status).toBe(200);
    expect(issued.body.data.poNumber).toBe(`ELPL/PO/26-27/${String(series.nextNumber).padStart(3, '0')}`);
    expect(issued.body.data).toMatchObject({ status: 'approved', statusLabel: 'Issued', templateVersion: 'po-v1' });
    expect((await prisma.numberSeries.findUniqueOrThrow({ where: { id: series.id } })).nextNumber).toBe(series.nextNumber + 1);

    const pdf = await agent.get(`/api/attachments/${issued.body.data.pdfAttachmentId}/file`).buffer(true);
    expect(pdf.status).toBe(200);
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');

    const sent = await agent.post(`/api/purchases/pos/${draft.id}/sent`).send({ via: 'whatsapp' });
    expect(sent.body.data).toMatchObject({ status: 'sent', sentVia: 'whatsapp' });
  }, 60_000);

  it('an issued PO is frozen: the form refuses edits and so does the database', async () => {
    const po = (await agent.post('/api/purchases/pos').send(poBody(karnataka))).body.data;
    await agent.post(`/api/purchases/pos/${po.id}/issue`);
    const edit = await agent.put(`/api/purchases/pos/${po.id}`).send(poBody(karnataka, { lines: [{ ...line, rate: '1' }] }));
    expect(edit.status).toBe(400);
    await expect(withAudit({ userId: 'system' }, (tx) => tx.purchaseOrder.update({ where: { id: po.id }, data: { taxable: '1' } }))).rejects.toThrow(/amendment/);
    await expect(withAudit({ userId: 'system' }, (tx) => tx.poLine.updateMany({ where: { poId: po.id }, data: { rate: '1' } }))).rejects.toThrow(/amendment/);
    await expect(withAudit({ userId: 'system' }, (tx) => tx.purchaseOrder.update({ where: { id: po.id }, data: { poNumber: 'X' } }))).rejects.toThrow(/cannot change/);
  }, 60_000);

  it('F046: an amendment keeps the number, raises the revision, keeps the old version and reprints', async () => {
    const po = (await agent.post('/api/purchases/pos').send(poBody(haryana))).body.data;
    const issued = (await agent.post(`/api/purchases/pos/${po.id}/issue`)).body.data;
    expect((await agent.post(`/api/purchases/pos/${po.id}/amend`).send(poBody(haryana))).status).toBe(400); // no reason
    expect((await agent.post(`/api/purchases/pos/${po.id}/amend`).send({ ...poBody(karnataka), reason: 'switch vendor' })).status).toBe(400);
    const r = await agent.post(`/api/purchases/pos/${po.id}/amend`).send({ ...poBody(haryana, { lines: [line, { ...line, description: 'Spare insert', rate: '20000' }] }), reason: 'Added a spare insert' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ poNumber: issued.poNumber, revisionNo: 1, taxable: '1000000.00', total: '1180000.00' });
    expect(r.body.data.revisions).toEqual([expect.objectContaining({ revisionNo: 0, reason: 'Added a spare insert' })]);
    expect(r.body.data.pdfAttachmentId).not.toBe(issued.pdfAttachmentId);
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: issued.pdfAttachmentId } })).isArchived).toBe(true);
  }, 60_000);

  it('B15: cancel needs a reason and keeps the number; delete is refused and audited', async () => {
    const po = (await agent.post('/api/purchases/pos').send(poBody(karnataka))).body.data;
    const issued = (await agent.post(`/api/purchases/pos/${po.id}/issue`)).body.data;
    expect((await agent.post(`/api/purchases/pos/${po.id}/cancel`).send({ reason: '' })).status).toBe(400);
    const c = await agent.post(`/api/purchases/pos/${po.id}/cancel`).send({ reason: 'Vendor could not supply' });
    expect(c.body.data).toMatchObject({ status: 'cancelled', poNumber: issued.poNumber, statusReason: 'Vendor could not supply' });
    expect((await agent.delete(`/api/purchaseorders/${po.id}`)).status).toBe(409);
    expect(await prisma.purchaseOrder.findUnique({ where: { id: po.id } })).not.toBeNull();
  }, 60_000);

  it('blocked vendors get no POs; draft vendors cannot be issued to; milestones must add up to 100%', async () => {
    const draftVendor = (await agent.post('/api/vendors').send({ displayName: `Draft vendor ${Date.now()}`, vendorType: 'goods', gstin: testGstin('29', 'C') })).body.data.id;
    const po = (await agent.post('/api/purchases/pos').send(poBody(draftVendor))).body.data;
    expect((await agent.post(`/api/purchases/pos/${po.id}/issue`)).body.error).toMatch(/not active/);
    await agent.post(`/api/vendors/${draftVendor}/status`).send({ status: 'active' });
    expect((await agent.post(`/api/vendors/${draftVendor}/status`).send({ status: 'blocked', reason: 'Quality issues' })).status).toBe(200);
    expect((await agent.post('/api/purchases/pos').send(poBody(draftVendor))).body.error).toMatch(/blocked/);
    const bad = await agent.post('/api/purchases/pos').send(poBody(haryana, { milestones: [{ label: 'advance', percent: '40' }] }));
    expect(bad.body.error).toMatch(/100%/);
    const rate = await agent.post('/api/purchases/pos').send(poBody(haryana, { lines: [{ ...line, gstRate: '12' }] }));
    expect(rate.body.error).toMatch(/not a GST rate in force/); // 12% removed from 22 Sep 2025 (Q29)
  });

  it('BR-26 when a band is switched on: waits for approval, the raiser cannot approve, another founder can', async () => {
    const band = await withAudit({ userId: 'system', reason: 'test band' }, (tx) => tx.approvalRule.create({
      data: { appliesTo: 'purchase_order', amountFrom: '77777.00', amountTo: '77777.00', approversRequired: 1, isEnabled: true },
    }));
    try {
      const po = (await agent.post('/api/purchases/pos').send(poBody(karnataka, { lines: [{ ...line, rate: '65912.71', gstRate: '18' }] }))).body.data;
      expect(po.total).toBe('77777.00');
      const sub = (await agent.post(`/api/purchases/pos/${po.id}/issue`)).body.data;
      expect(sub).toMatchObject({ status: 'pending_approval', poNumber: null });
      expect((await agent.post(`/api/purchases/pos/${po.id}/approve`)).body.error).toMatch(/cannot approve/);
      const ok = (await other.post(`/api/purchases/pos/${po.id}/approve`)).body.data;
      expect(ok.status).toBe('approved');
      expect(ok.poNumber).toMatch(/^ELPL\/PO\/26-27\/\d{3}$/);
    } finally {
      await withAudit({ userId: 'system', reason: 'test band off' }, (tx) => tx.approvalRule.update({ where: { id: band.id }, data: { isEnabled: false } }));
    }
  }, 60_000);
});
