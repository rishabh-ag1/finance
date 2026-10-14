import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Agent } from 'supertest';
import { prisma } from '../../src/config/database';
import { createApp } from '../../src/app';
import { computeGstinCheckDigit } from '../../src/lib/gstin';
import { closePdfBrowser } from '../../src/pdf/render';
import { hasDb } from '../setup/db';
import { loggedInFounder, seedOnce } from '../setup/fixtures';

// Phase 2 acceptance B9 (TDS due dates), B10 (challans) and F070-F075.
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function testGstin(state: string, kind: 'P' | 'C') {
  const n = Date.now() + Math.floor(Math.random() * 1e6);
  const l = (i: number) => LETTERS[Math.floor(n / 26 ** i) % 26];
  const pan = `${l(0)}${l(1)}${l(2)}${kind}${l(3)}${String(n % 10000).padStart(4, '0')}${l(4)}`;
  const first14 = `${state}${pan}1Z`;
  return first14 + computeGstinCheckDigit(first14);
}
const csv = (text: string) => Buffer.from(text).toString('base64');
const HEADER = 'Transaction Date,Value Date,Particulars,Cheque No.,Debit,Credit,Balance\n';

describe.skipIf(!hasDb)('Acceptance B9, B10: TDS', () => {
  let app: Express;
  let agent: Agent;
  let s194C = '';
  let s194J = '';
  let account = '';

  const vendor = async (name: string, sectionId: string) => (await agent.post('/api/vendors').send({
    displayName: `${name} ${Date.now()}${Math.floor(Math.random() * 100)}`, vendorType: 'both', gstin: testGstin('29', 'C'), defaultTdsSectionId: sectionId, activate: true,
  })).body.data.id as string;
  /** A tax invoice whose TDS is exactly `tds` (as actually deducted). */
  const billWithTds = async (vendorId: string, sectionId: string, docDate: string, taxable: string, tds: string) => {
    const r = await agent.post('/api/bills').send({
      docType: 'tax_invoice', vendorId, docNumber: `T-${Date.now()}-${Math.floor(Math.random() * 1e5)}`, docDate,
      lines: [{ description: 'Work', qty: '1', unit: 'Nos', rate: taxable, discount: '0', gstRate: '18' }],
      tds: { applicable: true, sectionId, amount: tds, overrideReason: 'As deducted' },
    });
    if (r.status !== 200) throw new Error(r.body.error);
    return r.body.data;
  };
  const entryFor = (docId: string) => prisma.tdsEntry.findUniqueOrThrow({ where: { sourceType_sourceId: { sourceType: 'bill', sourceId: docId } } });

  beforeAll(async () => {
    await seedOnce();
    app = createApp();
    ({ agent } = await loggedInFounder(app));
    s194C = (await prisma.tdsSection.findFirstOrThrow({ where: { codeOldAct: '194C' } })).id;
    s194J = (await prisma.tdsSection.findFirstOrThrow({ where: { codeOldAct: '194J', nature: 'Professional fees' } })).id;
    account = (await agent.post('/api/settings/bank-accounts').send({
      bankName: 'IDFC FIRST Bank', accountName: 'Entelechy Labs Private Limited', accountNumber: `X${Date.now()}`, ifsc: 'IDFB0080152',
      accountType: 'business_current', owner: 'Entelechy', openingBalance: '100000', openingDate: '2026-08-31', parserFormat: 'idfc_v1',
    })).body.data.id;
  }, 60_000);
  afterAll(async () => { await closePdfBrowser(); await prisma.$disconnect(); });

  it('B9 / F070-F071: a bill\'s TDS enters the register; deducted 24 Jul is due 7 Aug, with late interest while unpaid', async () => {
    const saiffi = await vendor('Saiffi TDS', s194C);
    const b = await billWithTds(saiffi, s194C, '2026-07-24', '980000', '19600');
    const e = await entryFor(b.id);
    expect(e).toMatchObject({ status: 'deducted', quarter: 2, fyLabel: '26-27' });
    expect(e.tdsAmount.toFixed(2)).toBe('19600.00');
    const reg = (await agent.get('/api/tds/register').query({ vendorId: saiffi })).body.data;
    expect(reg.rows[0]).toMatchObject({ dueDate: '2026-08-07', tdsAmount: '19600.00', section: '194C Contract work', source: expect.objectContaining({ kind: 'bill' }) });
    const pay = (await agent.get('/api/tds/payable')).body.data;
    expect(pay.find((m: { month: string }) => m.month === '2026-07-01')).toMatchObject({ dueDate: '2026-08-07', overdue: true });
  });

  it('B10: the 7 Sep challans of Rs 1,080, Rs 5,812 and Rs 1,700 each take one deduction and their OPT/CBDT bank row', async () => {
    const valco = await vendor('Valco TDS', s194C);
    const micro = await vendor('Micro TDS', s194C);
    const videaim = await vendor('VideAim TDS', s194J);
    const bills = [await billWithTds(valco, s194C, '2026-08-30', '53084.75', '1080'), await billWithTds(micro, s194C, '2026-08-19', '246288.14', '5812'), await billWithTds(videaim, s194J, '2026-08-28', '17000', '1700')];
    await agent.post('/api/bank/imports').send({ bankAccountId: account, fileName: 'idfc.csv', contentBase64: csv(`${HEADER}`
      + '2026-09-07,2026-09-07,OPT/CBDT/26090700561688/07-09-2026/15:04:22,,1080,,98920\n'
      + '2026-09-07,2026-09-07,OPT/CBDT/26090700598441/07-09-2026/15:20:05,,5812,,93108\n'
      + '2026-09-07,2026-09-07,OPT/CBDT/26090700848121/07-09-2026/16:50:14,,1700,,91408\n') });
    const rows = await prisma.bankTxn.findMany({ where: { bankAccountId: account }, orderBy: { seq: 'asc' } });
    for (const [i, b] of bills.entries()) {
      const e = await entryFor(b.id);
      const r = await agent.post('/api/tds/challans').send({
        challanSerial: `${Date.now() % 100000}${i}`, bsrCode: '6390340', depositDate: '2026-09-07', entryIds: [e.id], total: e.tdsAmount.toFixed(2), bankTxnId: rows[i].id,
      });
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ total: e.tdsAmount.toFixed(2), bankRow: expect.objectContaining({ id: rows[i].id }) });
      expect((await entryFor(b.id)).status).toBe('deposited');
      expect(await prisma.bankTxn.findUniqueOrThrow({ where: { id: rows[i].id } })).toMatchObject({ linkedDocType: 'TdsChallan', linkedDocId: r.body.data.id });
    }
    // Micro Instruments deducted 19 Aug, deposited 7 Sep: on the due date, no interest (BR-13).
    expect((await agent.get('/api/tds/register').query({ vendorId: micro })).body.data.rows[0]).toMatchObject({ status: 'deposited', lateInterest: '0.00' });
  }, 60_000);

  it('BR-14: an OPT/CBDT row of a unique amount is suggested and linked by itself; a challan must add up', async () => {
    const v = await vendor('Auto challan', s194C);
    const amt = `${3000 + Math.floor(Math.random() * 900)}.${String(Math.floor(Math.random() * 90) + 10)}`;
    const b = await billWithTds(v, s194C, '2026-09-02', '500000', amt);
    const e = await entryFor(b.id);
    const acct = (await agent.post('/api/settings/bank-accounts').send({
      bankName: 'IDFC FIRST Bank', accountName: 'Entelechy Labs Private Limited', accountNumber: `Y${Date.now()}`, ifsc: 'IDFB0080152',
      accountType: 'business_current', owner: 'Entelechy', openingBalance: '100000', openingDate: '2026-09-30', parserFormat: 'idfc_v1',
    })).body.data.id;
    await agent.post('/api/bank/imports').send({ bankAccountId: acct, fileName: 'a.csv', contentBase64: csv(`${HEADER}2026-10-06,2026-10-06,OPT/CBDT/26100600000001/06-10-2026/11:00:00,,${amt},,${(100000 - Number(amt)).toFixed(2)}\n`) });
    const row = await prisma.bankTxn.findFirstOrThrow({ where: { bankAccountId: acct } });
    const sugg = (await agent.get('/api/tds/bank-rows')).body.data.find((r: { id: string }) => r.id === row.id);
    expect(sugg.suggestedEntryIds).toEqual([e.id]);
    expect((await agent.post('/api/tds/challans').send({ challanSerial: '20001', bsrCode: '6390340', depositDate: '2026-10-06', entryIds: [e.id], total: '1' })).body.error).toMatch(/total/);
    const serial = `2${Date.now() % 100000}`;
    const c = (await agent.post('/api/tds/challans').send({ challanSerial: serial, bsrCode: '6390340', depositDate: '2026-10-06', entryIds: [e.id], total: amt })).body.data;
    expect(c.bankRow?.id).toBe(row.id);
    const again = await agent.post('/api/tds/challans').send({ challanSerial: serial, bsrCode: '6390340', depositDate: '2026-10-06', entryIds: [e.id], total: amt });
    expect(again.status).toBe(400);
  }, 60_000);

  it('a deposited deduction is fixed: its bill cannot change its TDS or be cancelled; a challan cancelled with a reason frees it', async () => {
    const v = await vendor('Fixed TDS', s194C);
    const b = await billWithTds(v, s194C, '2026-09-03', '100000', '2000');
    const e = await entryFor(b.id);
    const c = (await agent.post('/api/tds/challans').send({ challanSerial: `3${Date.now() % 100000}`, bsrCode: '6390340', depositDate: '2026-09-05', entryIds: [e.id], total: '2000' })).body.data;
    const edit = await agent.put(`/api/bills/${b.id}`).send({
      docType: 'tax_invoice', vendorId: v, docNumber: b.docNumber, docDate: '2026-09-03',
      lines: [{ description: 'Work', qty: '1', unit: 'Nos', rate: '100000', discount: '0', gstRate: '18' }],
      tds: { applicable: true, sectionId: s194C, amount: '2500', overrideReason: 'Changed' },
    });
    expect(edit.status).toBe(400);
    expect(edit.body.error).toMatch(/already deposited/);
    expect((await agent.post(`/api/bills/${b.id}/cancel`).send({ reason: 'Wrong' })).status).toBe(400);
    expect((await agent.post(`/api/tds/challans/${c.id}/cancel`).send({ reason: 'Entered against the wrong deduction' })).body.data.isCancelled).toBe(true);
    expect((await entryFor(b.id)).status).toBe('deducted');
  }, 60_000);

  it('advances: TDS deducted on an advance enters the register; a failed payment takes it out', async () => {
    const v = await vendor('Advance TDS', s194C);
    const pi = (await agent.post('/api/bills').send({ docType: 'proforma', vendorId: v, docNumber: `PI-${Date.now()}`, docDate: '2026-09-01', lines: [{ description: 'Mould', qty: '1', unit: 'Nos', rate: '100000', discount: '0', gstRate: '18' }] })).body.data;
    const p = (await agent.post('/api/payments').send({ vendorId: v, allocations: [{ docId: pi.id, gross: '118000' }], record: { paidDate: '2026-09-02', mode: 'neft', fromBankAccountId: account, utr: `U${Date.now()}` } })).body.data;
    const alloc = await prisma.paymentAllocation.findFirstOrThrow({ where: { paymentId: p.id } });
    const e = await prisma.tdsEntry.findUniqueOrThrow({ where: { sourceType_sourceId: { sourceType: 'advance', sourceId: alloc.id } } });
    expect(e).toMatchObject({ status: 'deducted' });
    expect(e.tdsAmount.toFixed(2)).toBe('2000.00');
    await agent.post(`/api/payments/${p.id}/failed`).send({ reason: 'Returned by the bank' });
    expect((await prisma.tdsEntry.findUniqueOrThrow({ where: { id: e.id } })).status).toBe('cancelled');
  }, 60_000);

  it('F073-F074: a quarter is filed only when all its TDS is deposited; Form 16A after filing; the 26Q working exports', async () => {
    // A quarter no other run has used: the test database keeps every run's data.
    const used = new Set((await prisma.tdsReturn.findMany()).map((r) => `${r.fyLabel}/${r.quarter}`));
    let year = 1991; let quarter = 1;
    while (used.has(`${String(year).slice(2)}-${String(year + 1).slice(2)}/${quarter}`) || (await prisma.tdsEntry.count({ where: { fyLabel: `${String(year).slice(2)}-${String(year + 1).slice(2)}`, quarter, status: 'deducted' } }))) {
      quarter = quarter === 4 ? 1 : quarter + 1; if (quarter === 1) year += 1;
    }
    const fy = `${String(year).slice(2)}-${String(year + 1).slice(2)}`;
    const date = quarter === 4 ? `${year + 1}-01-15` : `${year}-${String(quarter * 3 + 1).padStart(2, '0')}-15`;
    const v = await vendor('Quarter TDS', s194J);
    const b = await billWithTds(v, s194J, date, '60000', '6000');
    const e = await entryFor(b.id);
    expect((await agent.post('/api/tds/returns').send({ fy, quarter, filedOn: '2026-10-14', ackNo: 'ACK1' })).body.error).toMatch(/not deposited/);
    await agent.post('/api/tds/challans').send({ challanSerial: `4${Date.now() % 100000}`, bsrCode: '6390340', depositDate: date, entryIds: [e.id], total: '6000' });
    expect((await agent.post('/api/tds/certificates').send({ fy, quarter, vendorId: v, issuedOn: '2026-10-14' })).body.error).toMatch(/File the quarter/);
    const filed = (await agent.post('/api/tds/returns').send({ fy, quarter, filedOn: '2026-10-14', ackNo: `ACK${Date.now()}` })).body.data;
    expect(filed.filed).toMatchObject({ filedOn: '2026-10-14' });
    expect((await entryFor(b.id)).status).toBe('return_filed');
    const cert = (await agent.post('/api/tds/certificates').send({ fy, quarter, vendorId: v, issuedOn: '2026-10-14', certificateNo: 'C-1' })).body.data;
    expect(cert.vendors.find((x: { vendorId: string }) => x.vendorId === v).certificate).toMatchObject({ certificateNo: 'C-1' });
    expect((await entryFor(b.id)).status).toBe('certificate_issued');
    const xl = await agent.get('/api/tds/quarter/export').query({ fy, quarter }).buffer(true);
    expect(xl.status).toBe(200);
    expect(xl.headers['content-type']).toMatch(/spreadsheetml/);
  }, 60_000);

  it('F075: vendors near or over the FY threshold are flagged', async () => {
    const v = await vendor('Threshold', s194C);
    await agent.post('/api/bills').send({
      docType: 'tax_invoice', vendorId: v, docNumber: `TH-${Date.now()}`, docDate: '2026-09-10',
      lines: [{ description: 'Job', qty: '1', unit: 'Nos', rate: '25000', discount: '0', gstRate: '18' }],
    });
    await agent.post('/api/bills').send({
      docType: 'tax_invoice', vendorId: v, docNumber: `TH2-${Date.now()}`, docDate: '2026-09-20',
      lines: [{ description: 'Job', qty: '1', unit: 'Nos', rate: '60000', discount: '0', gstRate: '18' }],
    });
    const t = (await agent.get('/api/tds/thresholds').query({ fy: '26-27' })).body.data.find((x: { vendorId: string }) => x.vendorId === v);
    expect(t).toMatchObject({ credited: '85000.00', annualThreshold: '100000.00', status: 'near', left: '15000.00' });
  }, 60_000);
});
