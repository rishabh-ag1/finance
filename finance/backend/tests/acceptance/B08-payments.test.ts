import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Agent } from 'supertest';
import { prisma } from '../../src/config/database';
import { createApp } from '../../src/app';
import { withAudit } from '../../src/lib/audit';
import { todayIST } from '../../src/lib/fy';
import { computeGstinCheckDigit } from '../../src/lib/gstin';
import { closePdfBrowser } from '../../src/pdf/render';
import { hasDb } from '../setup/db';
import { loggedInFounder, seedOnce } from '../setup/fixtures';

// Phase 2 acceptance B7 (advances), B8 (bank match), B11 (ageing, MSME) and F060-F067.
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function testGstin(state: string, kind: 'P' | 'C') {
  const n = Date.now() + Math.floor(Math.random() * 1e6);
  const l = (i: number) => LETTERS[Math.floor(n / 26 ** i) % 26];
  const pan = `${l(0)}${l(1)}${l(2)}${kind}${l(3)}${String(n % 10000).padStart(4, '0')}${l(4)}`;
  const first14 = `${state}${pan}1Z`;
  return first14 + computeGstinCheckDigit(first14);
}
const PDF = Buffer.from('%PDF-1.4\n% vendor invoice for tests\n').toString('base64');
const csv = (text: string) => Buffer.from(text).toString('base64');
const HEADER = 'Transaction Date,Value Date,Particulars,Cheque No.,Debit,Credit,Balance\n';
const shift = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!hasDb)('Acceptance B7, B8, B11: payments out', () => {
  let app: Express;
  let agent: Agent;
  let other: Agent;
  let s194C = '';
  let capex = { categoryId: '', subCategoryId: '' };
  let idfc = '';

  const line = (rate: string, extra: object = {}) => ({ description: 'Item', hsnSac: '8480', qty: '1', unit: 'Nos', rate, discount: '0', gstRate: '18', ...extra });
  const vendor = async (name: string, extra: object = {}) => (await agent.post('/api/vendors').send({
    displayName: `${name} ${Date.now()}${Math.floor(Math.random() * 100)}`, vendorType: 'both', gstin: testGstin('29', 'C'), activate: true, ...extra,
  })).body.data.id as string;
  const doc = async (vendorId: string, docType: string, rate: string, extra: object = {}) => {
    const r = await agent.post('/api/bills').send({ docType, vendorId, docNumber: `D-${Date.now()}-${Math.floor(Math.random() * 1e4)}`, docDate: '2026-08-18', lines: [line(rate)], ...extra });
    if (r.status !== 200) throw new Error(r.body.error);
    return r.body.data;
  };
  const okToPay = async (id: string) => {
    await agent.post('/api/attachments').send({ recordType: 'VendorDocument', recordId: id, docKind: 'bill', fileName: 'invoice.pdf', contentBase64: PDF });
    return (await agent.post(`/api/bills/${id}/approve`)).body.data;
  };
  const record = (over: object = {}) => ({ paidDate: '2026-08-19', mode: 'imps', fromBankAccountId: idfc, utr: `UTR${Date.now()}${Math.floor(Math.random() * 1e4)}`, ...over });

  beforeAll(async () => {
    await seedOnce();
    app = createApp();
    ({ agent } = await loggedInFounder(app));
    ({ agent: other } = await loggedInFounder(app));
    s194C = (await prisma.tdsSection.findFirstOrThrow({ where: { codeOldAct: '194C' } })).id;
    const c = await prisma.category.findUniqueOrThrow({ where: { name: 'Capex' }, include: { subCategories: true } });
    capex = { categoryId: c.id, subCategoryId: c.subCategories[0].id };
    idfc = (await agent.post('/api/settings/bank-accounts').send({
      bankName: 'IDFC FIRST Bank', accountName: 'Entelechy Labs Private Limited', accountNumber: `P${Date.now()}`, ifsc: 'IDFB0080152',
      accountType: 'business_current', owner: 'Entelechy', openingBalance: '300000', openingDate: '2026-08-01', parserFormat: 'idfc_v1',
    })).body.data.id;
  }, 60_000);
  afterAll(async () => { await closePdfBrowser(); await prisma.$disconnect(); });

  it('B8: an advance with UTR 623112118032 is recorded, then the statement row links to it and takes the quote category', async () => {
    const micro = await vendor('Micro Instruments', { bankNames: ['MICRO INSTRUMENTS CO'], defaultTdsSectionId: s194C });
    const quote = await doc(micro, 'quote', '246288.14', capex);
    expect(quote.totalValue).toBe('290620.00');
    // Rs 2,84,808 left the bank; Rs 5,812 TDS was deducted on the advance (2% of the gross, as actually done).
    const p = await agent.post('/api/payments').send({
      vendorId: micro, purpose: 'Advance for tooling',
      allocations: [{ docId: quote.id, gross: '290620', tds: { applicable: true, sectionId: s194C, rate: '2', amount: '5812', overrideReason: 'Deducted on the gross advance as done; CA to confirm (BR-11)' } }],
      record: record({ utr: '623112118032' }),
    });
    expect(p.status).toBe(200);
    expect(p.body.data).toMatchObject({ status: 'paid', amount: '284808.00', tdsAmount: '5812.00' });
    expect(p.body.data.paymentNo).toMatch(/^PMT-\d{4,}$/);
    expect((await agent.get(`/api/bills/${quote.id}`)).body.data).toMatchObject({ paidAmount: '290620.00', status: 'awaiting_tax_invoice' });

    const imp = await agent.post('/api/bank/imports').send({ bankAccountId: idfc, fileName: 'idfc.csv', contentBase64: csv(
      `${HEADER}2026-08-19,2026-08-19,IMPS-OPM/623112118032/MICRO INSTRUMENTS COMICRO INSTRUMENTS CO/SBIN0002468/7009/AdvanceToolingPaymentM,,284808,,15192\n`) });
    expect(imp.status).toBe(200);
    const after = (await agent.get(`/api/payments/${p.body.data.id}`)).body.data;
    expect(after).toMatchObject({ status: 'reconciled', matchedBy: 'utr' });
    const row = await prisma.bankTxn.findUniqueOrThrow({ where: { id: after.bankRow.id } });
    expect(row).toMatchObject({ status: 'suggested', categoryId: capex.categoryId, partyType: 'vendor', partyId: micro, linkedDocType: 'PaymentOut' });
    expect(row.categorisationReason).toMatch(/^Matched PMT-/);
  }, 60_000);

  it('B7: a proforma paid in advance is on the chase list; its tax invoice takes the advance', async () => {
    const valco = await vendor('Valco');
    const pi = await doc(valco, 'proforma', '53084.75');
    const pay = await agent.post('/api/payments').send({ vendorId: valco, allocations: [{ docId: pi.id, gross: '62640' }], record: record({ paidDate: '2026-09-01' }) });
    expect(pay.body.data).toMatchObject({ amount: '62640.00', tdsAmount: '0.00' });
    const chase = (await agent.get('/api/bills/chase')).body.data;
    expect(chase.rows.find((r: { id: string }) => r.id === pi.id)).toMatchObject({ advancePaid: '62640.00' });

    const ti = await doc(valco, 'tax_invoice', '53084.75', { docDate: '2026-10-05', replacesDocumentId: pi.id });
    expect(ti).toMatchObject({ advancesApplied: '62640.00', outstanding: '0.00' });
    expect((await okToPay(ti.id)).status).toBe('paid');
  }, 60_000);

  it('BR-11: TDS already deducted on the advance is netted from the tax invoice', async () => {
    const v = await vendor('Netting', { defaultTdsSectionId: s194C });
    const pi = await doc(v, 'proforma', '100000');
    const pre = (await agent.post('/api/payments/preview').send({ vendorId: v, allocations: [{ docId: pi.id, gross: '118000' }] })).body.data;
    expect(pre.allocations[0]).toMatchObject({ tdsAmount: '2000.00', amount: '116000.00' });
    await agent.post('/api/payments').send({ vendorId: v, allocations: [{ docId: pi.id, gross: '118000' }], record: record() });
    const ti = await doc(v, 'tax_invoice', '100000', { replacesDocumentId: pi.id });
    expect(ti).toMatchObject({ tdsAmount: '0.00', advancesApplied: '118000.00', outstanding: '0.00' });
    expect(ti.tds.suggestion.reason).toMatch(/already deducted on the advance/);
  }, 60_000);

  it('paying bills: only OK-to-pay bills, never more than owed; part then full payment; numbers in order', async () => {
    const v = await vendor('Direct');
    const inv = await doc(v, 'tax_invoice', '10000');
    expect((await agent.post('/api/payments').send({ vendorId: v, allocations: [{ docId: inv.id, gross: '1000' }] })).body.error).toMatch(/not marked OK to pay/);
    await okToPay(inv.id);
    expect((await agent.post('/api/payments').send({ vendorId: v, allocations: [{ docId: inv.id, gross: '20000' }] })).body.error).toMatch(/more than/);
    const a = (await agent.post('/api/payments').send({ vendorId: v, allocations: [{ docId: inv.id, gross: '5000' }], record: record() })).body.data;
    expect((await agent.get(`/api/bills/${inv.id}`)).body.data).toMatchObject({ status: 'partially_paid', outstanding: '6800.00' });
    const b = (await agent.post('/api/payments').send({ vendorId: v, allocations: [{ docId: inv.id, gross: '6800' }], record: record() })).body.data;
    expect((await agent.get(`/api/bills/${inv.id}`)).body.data).toMatchObject({ status: 'paid', outstanding: '0.00' });
    expect(Number(b.paymentNo.slice(4))).toBe(Number(a.paymentNo.slice(4)) + 1);
  }, 60_000);

  it('a recorded payment is fixed; marking it failed makes the bill owed again and keeps the number', async () => {
    const v = await vendor('Fails');
    const inv = await doc(v, 'tax_invoice', '1000');
    await okToPay(inv.id);
    const p = (await agent.post('/api/payments').send({ vendorId: v, allocations: [{ docId: inv.id, gross: '1180' }], record: record() })).body.data;
    await expect(withAudit({ userId: 'system' }, (tx) => tx.paymentOut.update({ where: { id: p.id }, data: { amount: '1' } }))).rejects.toThrow(/only marked failed/);
    expect((await agent.post(`/api/payments/${p.id}/failed`).send({ reason: '' })).status).toBe(400);
    const f = (await agent.post(`/api/payments/${p.id}/failed`).send({ reason: 'Returned by the bank: wrong IFSC' })).body.data;
    expect(f).toMatchObject({ status: 'failed', paymentNo: p.paymentNo });
    expect((await agent.get(`/api/bills/${inv.id}`)).body.data).toMatchObject({ outstanding: '1180.00' });
    expect((await agent.delete(`/api/paymentouts/${p.id}`)).status).toBe(409);
  }, 60_000);

  it('BR-09: an advance on a PO is applied to the tax invoice billed against it', async () => {
    const v = await vendor('PO advance');
    const po = (await agent.post('/api/purchases/pos').send({ vendorId: v, poDate: '2026-08-01', placeOfSupplyState: '29', deliveryAddress: 'Bengaluru', lines: [line('100000')] })).body.data;
    await agent.post(`/api/purchases/pos/${po.id}/issue`);
    await agent.post('/api/payments').send({ vendorId: v, allocations: [{ poId: po.id, gross: '47200' }], record: record() });
    expect((await agent.get(`/api/purchases/pos/${po.id}`)).body.data).toMatchObject({ paidTotal: '47200.00', advanceTotal: '47200.00' });
    const inv = await doc(v, 'tax_invoice', '100000', { poId: po.id });
    const open = (await agent.get(`/api/payments/advances-for/${inv.id}`)).body.data;
    expect(open).toHaveLength(1);
    await agent.post(`/api/payments/advances-for/${inv.id}/apply`).send({ allocationId: open[0].id });
    expect((await agent.get(`/api/bills/${inv.id}`)).body.data).toMatchObject({ advancesApplied: '47200.00', outstanding: '70800.00' });
    expect((await agent.get(`/api/purchases/pos/${po.id}`)).body.data).toMatchObject({ advanceTotal: '0.00' });
  }, 60_000);

  it('B11: the due list flags overdue and MSME bills; ageing puts them in buckets', async () => {
    const today = todayIST();
    const msme = await vendor('MSME micro', { msmeType: 'micro', udyamNo: 'UDYAM-KR-03-0000001' });
    const inv = await doc(msme, 'tax_invoice', '1000', { docDate: shift(today, -41), dueDate: shift(today, -11) });
    await okToPay(inv.id);
    const due = (await agent.get('/api/payments/due')).body.data;
    const r = due.rows.find((x: { id: string }) => x.id === inv.id);
    expect(r).toMatchObject({ group: 'overdue', daysOverdue: 11, owed: '1180.00', msme: expect.objectContaining({ level: 'breached' }) });
    const ageing = (await agent.get('/api/payments/ageing')).body.data;
    expect(ageing.rows.find((x: { vendorId: string }) => x.vendorId === msme)).toMatchObject({ total: '1180.00', buckets: expect.objectContaining({ '1_30': '1180.00' }) });
  }, 60_000);

  it('BR-26 when a payment band is on: waits for approval; the requester cannot approve', async () => {
    const band = await withAudit({ userId: 'system', reason: 'test band' }, (tx) => tx.approvalRule.create({
      data: { appliesTo: 'payment', amountFrom: '4321.00', amountTo: '4321.00', approversRequired: 1, isEnabled: true },
    }));
    try {
      const v = await vendor('Approval');
      const inv = await doc(v, 'tax_invoice', '10000');
      await okToPay(inv.id);
      const p = (await agent.post('/api/payments').send({ vendorId: v, allocations: [{ docId: inv.id, gross: '4321' }] })).body.data;
      expect(p.status).toBe('requested');
      expect((await agent.post(`/api/payments/${p.id}/record`).send(record())).body.error).toMatch(/waiting for approval/);
      expect((await agent.post(`/api/payments/${p.id}/approve`)).body.error).toMatch(/cannot approve/);
      expect((await other.post(`/api/payments/${p.id}/approve`)).body.data.status).toBe('approved');
    } finally {
      await withAudit({ userId: 'system', reason: 'test band off' }, (tx) => tx.approvalRule.update({ where: { id: band.id }, data: { isEnabled: false } }));
    }
  }, 60_000);
});
