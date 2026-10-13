import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Agent } from 'supertest';
import { prisma } from '../src/config/database';
import { createApp } from '../src/app';
import { fileNameFor, folderPathFor, slug } from '../src/services/attachment.service';
import { hasDb } from './setup/db';
import { loggedInFounder, seedOnce } from './setup/fixtures';

// M15 Documents vault: F160 attach / name / file / download / archive, F161 missing documents,
// F036 vendor checklist, F010 statement file kept with each import.

describe('F160 naming and folders', () => {
  it('names files {record}_{kind}.{ext} and files them under /Finance/{FY}/{Module}/{Record}', () => {
    const c = { fy: '26-27', module: 'Vendors', record: 'Saiffi Industries', nameBase: 'Saiffi Industries' };
    expect(fileNameFor(c, 'gst_cert', 'scan 0012.PDF')).toBe('Saiffi-Industries_GST-certificate.pdf');
    expect(folderPathFor(c)).toBe('/Finance/26-27/Vendors/Saiffi-Industries');
  });

  it('keeps names safe for Drive, Windows and links', () => {
    expect(slug('ELPL/PO/2026/001 — Saiffi & Co.')).toBe('ELPL-PO-2026-001-Saiffi-Co');
    expect(slug('///')).toBe('file');
  });
});

const PDF = Buffer.from('%PDF-1.4\n% test file\n').toString('base64');

describe.skipIf(!hasDb)('F160-F161 documents vault', () => {
  let app: Express;
  let agent: Agent;
  let vendorId = '';

  beforeAll(async () => {
    await seedOnce();
    app = createApp();
    ({ agent } = await loggedInFounder(app));
    const v = await agent.post('/api/vendors').send({ displayName: `Docs vendor ${Date.now()}`, vendorType: 'goods', pan: 'ABCPD1234E', activate: true });
    vendorId = v.body.data.id;
  });
  afterAll(() => prisma.$disconnect());

  it('attaches a PAN copy to a vendor, ticks the checklist and serves the file back', async () => {
    const before = (await agent.get(`/api/vendors/${vendorId}`)).body.data;
    expect(before.documents.find((d: { kind: string }) => d.kind === 'pan').present).toBe(false);

    const up = await agent.post('/api/attachments').send({ recordType: 'Vendor', recordId: vendorId, docKind: 'pan', fileName: 'pan card.pdf', contentBase64: PDF });
    expect(up.status).toBe(200);
    expect(up.body.data).toMatchObject({ docKind: 'pan', mimeType: 'application/pdf', storage: 'local', originalName: 'pan card.pdf' });
    expect(up.body.data.fileName).toMatch(/^Docs-vendor-\d+_PAN-card\.pdf$/);
    expect(up.body.data.folderPath).toMatch(/^\/Finance\/\d{2}-\d{2}\/Vendors\/Docs-vendor-\d+$/);

    const after = (await agent.get(`/api/vendors/${vendorId}`)).body.data;
    expect(after.documents.find((d: { kind: string }) => d.kind === 'pan').present).toBe(true);
    expect(after.attachments).toHaveLength(1);

    const file = await agent.get(`/api/attachments/${up.body.data.id}/file`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toMatch(/application\/pdf/);
    expect((file.body as Buffer).toString()).toContain('%PDF-1.4');
  });

  it('refuses the same file twice, unknown types and files over 15 MB', async () => {
    expect((await agent.post('/api/attachments').send({ recordType: 'Vendor', recordId: vendorId, docKind: 'pan', fileName: 'again.pdf', contentBase64: PDF })).body.error).toMatch(/already attached/);
    expect((await agent.post('/api/attachments').send({ recordType: 'Vendor', recordId: vendorId, docKind: 'other', fileName: 'run.exe', contentBase64: PDF })).body.error).toMatch(/cannot be attached/);
    const big = Buffer.alloc(15 * 1024 * 1024 + 1, 65).toString('base64');
    const r = await agent.post('/api/attachments').send({ recordType: 'Vendor', recordId: vendorId, docKind: 'other', fileName: 'big.pdf', contentBase64: big });
    expect(r.body.error).toMatch(/limit is 15 MB/);
  });

  it('never deletes a file: removing needs a reason, archives the row and keeps the file', async () => {
    const list = (await agent.get(`/api/attachments?recordType=Vendor&recordId=${vendorId}`)).body.data;
    const id = list[0].id;
    expect((await agent.delete(`/api/attachments/${id}`)).status).toBe(409);
    expect((await agent.post(`/api/attachments/${id}/archive`).send({ reason: '' })).status).toBe(400);
    const r = await agent.post(`/api/attachments/${id}/archive`).send({ reason: 'Wrong PAN uploaded' });
    expect(r.body.data).toMatchObject({ isArchived: true, archivedReason: 'Wrong PAN uploaded' });

    const row = await prisma.attachment.findUniqueOrThrow({ where: { id } });
    expect(fs.existsSync(path.join(process.env.FILE_STORAGE_DIR!, row.storageKey))).toBe(true);
    expect((await agent.get(`/api/attachments?recordType=Vendor&recordId=${vendorId}`)).body.data).toHaveLength(0);
    const v = (await agent.get(`/api/vendors/${vendorId}`)).body.data;
    expect(v.documents.find((d: { kind: string }) => d.kind === 'pan').present).toBe(false);
  });

  it('F161: lists the vendor under missing documents until its required files are attached', async () => {
    const r = await agent.get('/api/attachments/missing');
    const row = r.body.data.rows.find((x: { recordId: string }) => x.recordId === vendorId);
    expect(row.missing).toEqual(['PAN card', 'Cancelled cheque']);
    for (const kind of ['pan', 'cancelled_cheque']) {
      await agent.post('/api/attachments').send({ recordType: 'Vendor', recordId: vendorId, docKind: kind, fileName: `${kind}.pdf`, contentBase64: Buffer.from(`%PDF ${kind}`).toString('base64') });
    }
    const again = await agent.get('/api/attachments/missing');
    expect(again.body.data.rows.some((x: { recordId: string }) => x.recordId === vendorId)).toBe(false);
  });

  it('F010: an imported statement keeps its file, filed under Bank statements', async () => {
    const acct = await agent.post('/api/settings/bank-accounts').send({
      bankName: 'IDFC FIRST Bank', accountName: 'Entelechy Labs Private Limited', accountNumber: `D${Date.now()}`, ifsc: 'IDFB0080152',
      accountType: 'business_current', owner: 'Entelechy', openingBalance: '1000', openingDate: '2026-11-01', parserFormat: 'idfc_v1',
    });
    const csv = 'Transaction Date,Value Date,Particulars,Cheque No.,Debit,Credit,Balance\n2026-11-03,2026-11-03,CHG/SMS CHARGES,,10,,990\n';
    const imp = await agent.post('/api/bank/imports').send({ bankAccountId: acct.body.data.id, fileName: 'idfc nov.csv', contentBase64: Buffer.from(csv).toString('base64') });
    const batch = (await agent.get(`/api/bank/imports/${imp.body.data.id}`)).body.data;
    expect(batch.attachments).toHaveLength(1);
    expect(batch.attachments[0]).toMatchObject({ docKind: 'statement', mimeType: 'text/csv' });
    expect(batch.attachments[0].folderPath).toBe('/Finance/26-27/Bank-statements/IDFC-2026-11-03-to-2026-11-03'.replace('Bank-statements', 'Bank statements'));
  });

  it('attaches proof to a bank row (F021)', async () => {
    const t = await prisma.bankTxn.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
    const r = await agent.post('/api/attachments').send({ recordType: 'BankTxn', recordId: t.id, docKind: 'proof', fileName: 'receipt.jpg', contentBase64: Buffer.from('jpegdata').toString('base64') });
    expect(r.status).toBe(200);
    expect(r.body.data.folderPath).toMatch(/^\/Finance\/\d{2}-\d{2}\/Bank\//);
  });
});
