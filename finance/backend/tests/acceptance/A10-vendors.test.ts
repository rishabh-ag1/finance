import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Agent } from 'supertest';
import { prisma } from '../../src/config/database';
import { createApp } from '../../src/app';
import { bankRecentlyChanged } from '../../src/services/vendor.service';
import { hasDb } from '../setup/db';
import { loggedInFounder, seedOnce } from '../setup/fixtures';

// Acceptance A10 (vendor from GSTIN), BR-15 on save, BR-16 bank detail change control,
// BR-05 step 2 (bank rows linked to a vendor) and the vendor status flow.
const csv = (text: string) => Buffer.from(text).toString('base64');
const HEADER = 'Transaction Date,Value Date,Particulars,Cheque No.,Debit,Credit,Balance\n';

describe.skipIf(!hasDb)('Vendors (M4)', () => {
  let app: Express;
  let rishabh: Agent;
  let arnav: Agent;
  let saiffiId = '';

  beforeAll(async () => {
    await seedOnce();
    app = createApp();
    ({ agent: rishabh } = await loggedInFounder(app));
    ({ agent: arnav } = await loggedInFounder(app));
    // The test database is not wiped: archive any Saiffi left by an earlier run (GSTIN is unique).
    const old = await prisma.vendor.findMany({ where: { gstin: '06ANJPA3053F1ZI', isArchived: false } });
    for (const v of old) await rishabh.post(`/api/vendors/${v.id}/archive`).send({ reason: 'test re-run' });
  });
  afterAll(() => prisma.$disconnect());

  it('A10: GSTIN 06ANJPA3053F1ZI gives PAN ANJPA3053F, deductee individual, state Haryana (06)', async () => {
    const r = await rishabh.post('/api/vendors').send({
      displayName: 'Saiffi Industries', vendorType: 'goods', gstin: '06anjpa3053f1zi', bankNames: ['Saiffi Industries'],
    });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      gstin: '06ANJPA3053F1ZI', pan: 'ANJPA3053F', deducteeType: 'individual', stateCode: '06', state: 'Haryana', gstRegistered: true, status: 'draft',
    });
    saiffiId = r.body.data.id;
  });

  it('BR-15: refuses a bad GSTIN checksum, a PAN that differs from the GSTIN, and a duplicate GSTIN', async () => {
    expect((await rishabh.post('/api/vendors').send({ displayName: 'Test vendor', vendorType: 'goods', gstin: '06ANJPA3053F1ZJ' })).body.error).toMatch(/checksum/);
    expect((await rishabh.post('/api/vendors').send({ displayName: 'Test vendor', vendorType: 'goods', gstin: '06AAGCV6571J1ZW', pan: 'ANJPA3053F' })).body.error).toMatch(/PAN must be AAGCV6571J/);
    expect((await rishabh.post('/api/vendors').send({ displayName: 'Saiffi again', vendorType: 'goods', gstin: '06ANJPA3053F1ZI' })).body.error).toMatch(/already has this GSTIN/);
  });

  it('takes the PAN for a vendor without GST, and treats no PAN as the no-PAN rate', async () => {
    const withPan = await rishabh.post('/api/vendors').send({ displayName: `Freelancer ${Date.now()}`, vendorType: 'services', pan: 'abcpd1234e' });
    expect(withPan.body.data).toMatchObject({ gstRegistered: false, pan: 'ABCPD1234E', deducteeType: 'individual' });
    const noPan = await rishabh.post('/api/vendors').send({ displayName: `Courier ${Date.now()}`, vendorType: 'services' });
    expect(noPan.body.data.deducteeType).toBe('unknown');
    expect(noPan.body.data.warnings.join(' ')).toMatch(/no-PAN rate/);
  });

  it('BR-16: the first account of a new vendor is approved at onboarding', async () => {
    const r = await rishabh.post(`/api/vendors/${saiffiId}/bank`).send({ accountName: 'SAIFFI INDUSTRIES', accountNumber: '39876543210', ifsc: 'sbin0050316' });
    expect(r.status).toBe(200);
    expect(r.body.data.currentBank).toMatchObject({ accountNumberMasked: '•••• 3210', ifsc: 'SBIN0050316', status: 'approved', decisionNote: 'First account at onboarding' });
  });

  it('BR-16: on an active vendor a change waits for another founder; the requester cannot approve it', async () => {
    expect((await rishabh.post(`/api/vendors/${saiffiId}/status`).send({ status: 'active' })).status).toBe(200);
    const req = await rishabh.post(`/api/vendors/${saiffiId}/bank`).send({ accountName: 'SAIFFI INDUSTRIES', accountNumber: '11112222333', ifsc: 'HDFC0000873' });
    const pending = req.body.data.bankHistory.find((b: { status: string }) => b.status === 'pending');
    expect(pending).toBeTruthy();
    expect(req.body.data.currentBank.accountNumberMasked).toBe('•••• 3210'); // still the old one
    expect(req.body.data.warnings.join(' ')).toMatch(/waiting for another founder/);

    const self = await rishabh.post(`/api/vendors/bank/${pending.id}/decide`).send({ approve: true });
    expect(self.status).toBe(403);

    const ok = await arnav.post(`/api/vendors/bank/${pending.id}/decide`).send({ approve: true, note: 'Confirmed by phone with Parvez' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.currentBank.accountNumberMasked).toBe('•••• 2333');
    expect(ok.body.data.bankHistory.map((b: { status: string }) => b.status).sort()).toEqual(['approved', 'superseded']);
    expect(ok.body.data.warnings.join(' ')).toMatch(/changed less than 30 days ago/);
  });

  it('BR-16: the 30-day warning ends 30 days after the change', () => {
    const now = new Date('2026-10-13T00:00:00Z');
    const acc = (status: 'approved' | 'superseded', validFrom: string) => ({ status, validFrom: new Date(validFrom) }) as never;
    expect(bankRecentlyChanged([acc('approved', '2026-09-20T00:00:00Z'), acc('superseded', '2026-06-01T00:00:00Z')], now)).toBe(true);
    expect(bankRecentlyChanged([acc('approved', '2026-09-10T00:00:00Z'), acc('superseded', '2026-06-01T00:00:00Z')], now)).toBe(false);
    expect(bankRecentlyChanged([acc('approved', '2026-10-10T00:00:00Z')], now)).toBe(false); // first account, nothing replaced
  });

  it('BR-05 step 2: a bank row paid to a vendor bank name is linked and takes the vendor\'s default category', async () => {
    const capex = await prisma.category.findUniqueOrThrow({ where: { name: 'Capex' }, include: { subCategories: true } });
    const tooling = capex.subCategories.find((s) => s.name === 'Tooling & Moulds')!;
    const current = (await rishabh.get(`/api/vendors/${saiffiId}`)).body.data;
    await rishabh.put(`/api/vendors/${saiffiId}`).send({ ...current, defaultCategoryId: capex.id, defaultSubCategoryId: tooling.id });

    const acct = await rishabh.post('/api/settings/bank-accounts').send({
      bankName: 'IDFC FIRST Bank', accountName: 'Entelechy Labs Private Limited', accountNumber: `V${Date.now()}`, ifsc: 'IDFB0080152',
      accountType: 'business_current', owner: 'Entelechy', openingBalance: '2000000', openingDate: '2026-11-01', parserFormat: 'idfc_v1',
    });
    await rishabh.post('/api/bank/imports').send({
      bankAccountId: acct.body.data.id, fileName: 'v.csv',
      contentBase64: csv(`${HEADER}2026-11-05,2026-11-05,RTGS/IDFBR62026110500000001/SAIFFI INDUSTRIESPARVEZ AALAM/SBIN0050316/Tooling balance,,500000,,1500000\n`),
    });
    const t = await prisma.bankTxn.findFirstOrThrow({ where: { bankAccountId: acct.body.data.id } });
    expect(t).toMatchObject({ partyType: 'vendor', partyId: saiffiId, categoryId: capex.id, subCategoryId: tooling.id, nature: 'capex', categorisationReason: 'Vendor: Saiffi Industries' });

    const v360 = (await rishabh.get(`/api/vendors/${saiffiId}`)).body.data;
    expect(v360.payments.rows.some((r: { id: string }) => r.id === t.id)).toBe(true);
  });

  it('blocks a vendor only with a reason, and never deletes one', async () => {
    expect((await rishabh.post(`/api/vendors/${saiffiId}/status`).send({ status: 'blocked' })).status).toBe(400);
    const b = await rishabh.post(`/api/vendors/${saiffiId}/status`).send({ status: 'blocked', reason: 'Quality dispute' });
    expect(b.body.data).toMatchObject({ status: 'blocked', statusReason: 'Quality dispute' });
    expect((await rishabh.delete(`/api/vendors/${saiffiId}`)).status).toBe(409);
    expect((await rishabh.post(`/api/vendors/${saiffiId}/status`).send({ status: 'active' })).body.data.status).toBe('active');
  });

  it('lists vendors with this FY\'s payments', async () => {
    const r = await rishabh.get('/api/vendors?q=saiffi');
    const row = r.body.data.vendors.find((v: { id: string }) => v.id === saiffiId);
    expect(row).toMatchObject({ gstin: '06ANJPA3053F1ZI', status: 'active', bankRecentlyChanged: true });
    expect(Number(row.paidThisFy)).toBeGreaterThanOrEqual(500000);
  });
});
