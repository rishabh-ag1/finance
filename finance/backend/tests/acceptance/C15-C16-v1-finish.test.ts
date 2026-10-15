import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import type { Express } from 'express';
import request, { type Agent } from 'supertest';
import { prisma } from '../../src/config/database';
import { createApp } from '../../src/app';
import { computeGstinCheckDigit } from '../../src/lib/gstin';
import { closePdfBrowser } from '../../src/pdf/render';
import { hasDb } from '../setup/db';
import { loggedInFounder, seedOnce } from '../setup/fixtures';

// Phase 3 acceptance C15 (CA workbook, F180 / F181), C16 (no deletes) and the Phase 1-2 leftovers
// finished in Step 19: F020 link a bank row to any document, F022 manual entries, F038 vendor
// statement, F171 roles, F173 alerts, D36 / D37.
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
const binary = (res: NodeJS.ReadableStream & { setEncoding: (e: string) => void }, cb: (e: Error | null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe.skipIf(!hasDb)('Acceptance C15-C16 and the v1 leftovers', () => {
  let app: Express;
  let agent: Agent;
  let invoiceId = '';
  let invoiceNo = '';

  beforeAll(async () => {
    await seedOnce();
    app = createApp();
    ({ agent } = await loggedInFounder(app));
    await setSales(true);
    const companyId = (await prisma.crmCompany.create({ data: { name: `Harbour Hotels ${RUN}` } })).id;
    const hq = (await prisma.crmCompanyBranch.create({ data: { companyId, name: 'MG Road', addressLine1: '1 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001', gstNumber: gstin('29') } })).id;
    const trap = (await prisma.invProduct.create({ data: { name: `Bloc Trap Pro ${RUN}`, sku: `TRAPCA-${RUN}`, skuNumber: `TC${RUN}`, hsnCode: '8543', priceExclTax: '3900', taxRate: '18', priceInclTax: '4602' } })).id;
    const d = (await agent.post('/api/sales').send({ docType: 'tax_invoice', docDate: '2026-10-15', customer: { kind: 'outlet', companyId, branchId: hq }, lines: [{ invProductId: trap, qty: '3' }] })).body.data;
    const i = (await agent.post(`/api/sales/${d.id}/issue`)).body.data;
    invoiceId = i.id; invoiceNo = i.docNumber;
  }, 120_000);
  afterAll(async () => { await setSales(false); await closePdfBrowser(); await prisma.$disconnect(); });

  async function setSales(on: boolean) {
    const series = (await agent.get('/api/settings/number-series')).body.data as { id: string; docType: string; pattern: string; padding: number; nextNumber: number; isActive: boolean }[];
    for (const s of series.filter((x) => ['tax_invoice', 'proforma', 'credit_note'].includes(x.docType) && x.isActive !== on)) {
      await agent.put(`/api/settings/number-series/${s.id}`).send({ pattern: s.pattern, padding: s.padding, nextNumber: s.nextNumber, isActive: on, reason: on ? 'Test: invoicing switched on' : 'Test: invoicing switched off again' });
    }
  }

  it('C15: one XLSX for the month with the listed sheets; rows link to their files; the HSN summary ties to the invoices', async () => {
    const s = (await agent.get('/api/ca-pack').query({ month: '2026-10' })).body.data;
    expect(s.tie.ok).toBe(true);
    expect(s.counts.invoices).toBeGreaterThan(0);
    const res = await agent.get('/api/ca-pack/download').query({ month: '2026-10' }).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as Buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'Bank transactions', 'Vendor bills', 'Sales invoices', 'Credit notes', 'Receipts', 'Payments', 'TDS', 'TDS challans', 'Funding', 'GST outward B2B', 'GST outward B2C', 'HSN summary', 'GST inward']);
    const inv = wb.getWorksheet('Sales invoices')!;
    let found = false;
    inv.eachRow((row) => {
      if (row.getCell(1).value === invoiceNo) {
        found = true;
        expect(row.getCell(8).value).toBe(11700);
        expect((row.getCell(15).value as { hyperlink: string }).hyperlink).toMatch(/attachments\/.+\/file|drive\.google\.com/);
      }
    });
    expect(found).toBe(true);
    const hsn = wb.getWorksheet('HSN summary')!;
    const last = hsn.getRow(hsn.rowCount);
    expect(last.getCell(1).value).toBe('Ties to invoices less credit notes');
    expect(last.getCell(9).value).toBe('OK');
  }, 180_000);

  it('C16: deleting an issued invoice, a receipt or a loan is refused and audited', async () => {
    const rct = (await agent.post('/api/receipts').send({ receiptDate: '2026-10-15', customerName: `Walk-in ${RUN}`, mode: 'cash', amount: '100', allocations: [] })).body.data;
    const loan = (await agent.post('/api/loans').send({ lender: `Test lender ${RUN}`, sanctionAmount: '1000', disbursedAmount: '1000', disbursedDate: '2026-10-01', repaymentType: 'flexible', tenureMonths: 6 })).body.data;
    for (const [resource, rid] of [['sales', invoiceId], ['receipts', rct.id], ['loans', loan.id]] as const) {
      const r = await agent.delete(`/api/${resource}/${rid}`);
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/never deleted/);
      expect(await prisma.auditLog.count({ where: { recordId: rid, action: 'delete_refused' } })).toBeGreaterThan(0);
    }
    expect(await prisma.salesDocument.findUnique({ where: { id: invoiceId } })).not.toBeNull();
    await agent.post(`/api/loans/${loan.id}/cancel`).send({ reason: 'Test: clean up' });
    await agent.post(`/api/receipts/${rct.id}/cancel`).send({ reason: 'Test: clean up' });
  }, 60_000);

  it('F022: cash entries are added in date order with a running balance; statement accounts refuse them', async () => {
    const cash = (await agent.post('/api/settings/bank-accounts').send({ bankName: 'Cash', accountName: `Office cash ${RUN}`, accountNumber: `CASH${Date.now()}`, ifsc: '', accountType: 'wallet', owner: 'Entelechy', openingBalance: '5000', openingDate: '2026-10-01', parserFormat: null })).body.data;
    expect(cash.id).toBeTruthy();
    const e1 = await agent.post('/api/bank/manual').send({ bankAccountId: cash.id, txnDate: '2026-10-10', description: 'Courier', amount: '450', direction: 'out', note: 'Paid to Blue Dart counter' });
    expect(e1.status).toBe(200);
    expect(e1.body.data).toMatchObject({ debit: '450.00', balance: '4550.00', isManual: true, status: 'review' });
    expect((await agent.post('/api/bank/manual').send({ bankAccountId: cash.id, txnDate: '2026-10-05', description: 'Tea', amount: '100', direction: 'out', note: 'x' })).body.error).toMatch(/date order/);
    expect((await agent.post('/api/bank/manual').send({ bankAccountId: cash.id, txnDate: '2026-10-11', description: 'Tea', amount: '100', direction: 'out', note: '' })).body.error).toMatch(/note/);
    const idfc = (await agent.post('/api/settings/bank-accounts').send({ bankName: 'IDFC FIRST Bank', accountName: 'Entelechy', accountNumber: `M${Date.now()}`, ifsc: 'IDFB0080152', accountType: 'business_current', owner: 'Entelechy', openingBalance: '0', openingDate: '2026-10-01', parserFormat: 'idfc_v1' })).body.data;
    expect((await agent.post('/api/bank/manual').send({ bankAccountId: idfc.id, txnDate: '2026-10-11', description: 'x', amount: '1', direction: 'in', note: 'x' })).body.error).toMatch(/bank statements/);
  }, 60_000);

  it('F020: a bank credit is linked from the ledger to the capital receipt it stands for', async () => {
    const idfc = (await agent.post('/api/settings/bank-accounts').send({ bankName: 'IDFC FIRST Bank', accountName: 'Entelechy', accountNumber: `L${Date.now()}`, ifsc: 'IDFB0080152', accountType: 'business_current', owner: 'Entelechy', openingBalance: '0', openingDate: '2026-10-01', parserFormat: 'idfc_v1' })).body.data;
    const cap = (await agent.post('/api/capital').send({ holderName: `Arnav ${RUN}`, receiptDate: '2026-10-12', amount: '77777', type: 'paid_up_capital' })).body.data;
    await agent.post('/api/bank/imports').send({ bankAccountId: idfc.id, fileName: 'l.csv', contentBase64: csv(`${HEADER}2026-10-12,2026-10-12,IMPS/P${RUN}/SOMEONE ELSE/Capital,,,77777,77777`) });
    const row = await prisma.bankTxn.findFirstOrThrow({ where: { bankAccountId: idfc.id } });
    const docs = (await agent.get(`/api/bank/txns/${row.id}/documents`)).body.data;
    expect(docs.options).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'capital', id: cap.id })]));
    const linked = (await agent.post(`/api/bank/txns/${row.id}/link`).send({ type: 'capital', docId: cap.id })).body.data;
    expect(linked).toMatchObject({ linkedDocType: 'CapitalReceipt', linkedDocId: cap.id });
  }, 60_000);

  it('F038: a vendor statement runs bills against payments and TDS; its closing balance follows from the lines', async () => {
    const v = await prisma.vendorDocument.findFirst({ where: { docType: 'tax_invoice', status: { not: 'cancelled' } }, orderBy: { createdAt: 'desc' } });
    if (!v) return;
    const s = (await agent.get(`/api/vendors/${v.vendorId}/statement`).query({ from: '2026-04-01', to: '2026-12-31' })).body.data;
    const net = s.lines.reduce((x: number, l: { debit: string; credit: string }) => x + Number(l.debit) - Number(l.credit), Number(s.opening));
    expect(Number(s.closing)).toBeCloseTo(net, 2);
    expect((await agent.get(`/api/vendors/${v.vendorId}/overview`)).status).toBe(200);
  }, 60_000);

  it('F171: a viewer role for the CA can open the CA pack but not issue invoices; a switched-off user cannot sign in', async () => {
    const roles = (await agent.post('/api/roles').send({ name: `CA_VIEWER_${RUN}`, description: 'CA', permissions: { financeCaPack: { view: true }, financeSales: { view: true } } })).body.data;
    const role = roles.find((r: { name: string }) => r.name === `CA_VIEWER_${RUN}`);
    expect(role.permissions).toEqual({ financeCaPack: { view: true }, financeSales: { view: true } });
    const email = `ca.${RUN.toLowerCase()}@example.com`;
    const users = (await agent.post('/api/users').send({ email, firstName: 'CA', lastName: 'Firm', roleId: role.id, password: 'long-enough-pass' })).body.data;
    const u = users.find((x: { email: string }) => x.email === email);
    const ca = request.agent(app);
    expect((await ca.post('/api/auth/login').send({ email, password: 'long-enough-pass' })).status).toBe(200);
    expect((await ca.get('/api/ca-pack').query({ month: '2026-10' })).status).toBe(200);
    expect((await ca.post('/api/sales').send({})).status).toBe(403);
    await agent.put(`/api/users/${u.id}`).send({ isActive: false });
    expect((await request(app).post('/api/auth/login').send({ email, password: 'long-enough-pass' })).status).not.toBe(200);
  }, 60_000);

  it('F173 alerts and D36 / D37 answer', async () => {
    const a = await agent.get('/api/alerts');
    expect(a.status).toBe(200);
    expect(Array.isArray(a.body.data)).toBe(true);
    const f = (await agent.get('/api/recon/funnel').query({ from: '2026-10-01', to: '2026-10-31' })).body.data;
    expect(f).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
    expect(Array.isArray(f.months) && Array.isArray(f.daysToBank)).toBe(true);
  }, 120_000);
});
