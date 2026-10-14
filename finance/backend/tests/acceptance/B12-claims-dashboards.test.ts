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

// Phase 2 acceptance B12 (founder claim reimbursed, BR-27), plus Step 12's dashboards: accrual view
// (BR-35), payables (F132), 13-week forecast (F136) and founder balances on Home (D32).
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function testGstin(state: string) {
  const n = Date.now() + Math.floor(Math.random() * 1e6);
  const l = (i: number) => LETTERS[Math.floor(n / 26 ** i) % 26];
  const first14 = `${state}${l(0)}${l(1)}${l(2)}C${l(3)}${String(n % 10000).padStart(4, '0')}${l(4)}1Z`;
  return first14 + computeGstinCheckDigit(first14);
}
const PDF = Buffer.from('%PDF-1.4\n% receipt for tests\n').toString('base64');
const csv = (text: string) => Buffer.from(text).toString('base64');
const HEADER = 'Transaction Date,Value Date,Particulars,Cheque No.,Debit,Credit,Balance\n';
const utr = () => `${Date.now()}`.slice(-9) + String(Math.floor(Math.random() * 1000)).padStart(3, '0');
type Pivot = { rows: { categoryId: string; total: string }[] };
const rowTotal = (p: Pivot, categoryId: string) => Number(p.rows.find((r) => r.categoryId === categoryId)?.total ?? 0);

describe.skipIf(!hasDb)('Acceptance B12: founder claims, accrual view, payables and forecast', () => {
  let app: Express;
  let rishabh: Agent;
  let arnav: Agent;
  let arnavId = '';
  let arnavName = '';
  let idfc = '';
  let office = { categoryId: '', subCategoryId: '' };
  let capex = { categoryId: '', subCategoryId: '' };

  const claim = async (amount: string, over: object = {}) => {
    const r = await arnav.post('/api/claims').send({ expenseDate: '2026-09-10', paidFrom: 'HDFC card 4417', vendorName: 'Amazon', description: 'Lab supplies', amount, hasGstInvoice: false, ...office, ...over });
    if (r.status !== 200) throw new Error(r.body.error);
    return r.body.data as { id: string; status: string };
  };
  const receipt = (id: string) => arnav.post('/api/attachments').send({ recordType: 'ExpenseClaim', recordId: id, docKind: 'receipt', fileName: 'receipt.pdf', contentBase64: PDF });
  const owedTo = async (id: string) => ((await rishabh.get('/api/claims/balances')).body.data as { founderUserId: string; owed: string; waiting: string }[]).find((f) => f.founderUserId === id);

  beforeAll(async () => {
    await seedOnce();
    app = createApp();
    ({ agent: rishabh } = await loggedInFounder(app));
    const a = await loggedInFounder(app);
    arnav = a.agent;
    arnavId = a.user.id;
    arnavName = `Arnav Q${Date.now().toString(36).toUpperCase()}`;
    await withAudit({ userId: 'system', reason: 'test founder name' }, (tx) => tx.user.update({ where: { id: arnavId }, data: { firstName: arnavName.split(' ')[0], lastName: arnavName.split(' ')[1] } }));
    const sub = await prisma.subCategory.findFirstOrThrow({ where: { natureOverride: null, isActive: true, category: { natureDefault: 'operating_expense', isActive: true } } });
    office = { categoryId: sub.categoryId, subCategoryId: sub.id };
    const c = await prisma.category.findUniqueOrThrow({ where: { name: 'Capex' }, include: { subCategories: true } });
    capex = { categoryId: c.id, subCategoryId: c.subCategories[0].id };
    idfc = (await rishabh.post('/api/settings/bank-accounts').send({
      bankName: 'IDFC FIRST Bank', accountName: 'Entelechy Labs Private Limited', accountNumber: `C${Date.now()}`, ifsc: 'IDFB0080152',
      accountType: 'business_current', owner: 'Entelechy', openingBalance: '500000', openingDate: '2026-08-01', parserFormat: 'idfc_v1',
    })).body.data.id;
  }, 60_000);
  afterAll(async () => { await closePdfBrowser(); await prisma.$disconnect(); });

  it('BR-27: a claim needs the receipt and the other founder; money put in by a founder is not a claim', async () => {
    const c = await claim('2500');
    expect(c.status).toBe('submitted');
    expect((await arnav.post(`/api/claims/${c.id}/approve`)).body.error).toMatch(/other founder/);
    expect((await rishabh.post(`/api/claims/${c.id}/approve`)).body.error).toMatch(/receipt/);
    const funds = await prisma.category.findUniqueOrThrow({ where: { name: 'Founder Funds' } });
    const bad = await arnav.post('/api/claims').send({ expenseDate: '2026-09-10', paidFrom: 'Own savings', vendorName: 'Entelechy', amount: '50000', hasGstInvoice: false, categoryId: funds.id });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/not a claim/);
    // Only the founder withdraws their own claim; the other founder rejects instead.
    expect((await rishabh.post(`/api/claims/${c.id}/withdraw`).send({ reason: 'Not mine to withdraw' })).status).toBe(400);
    expect((await arnav.post(`/api/claims/${c.id}/withdraw`).send({ reason: 'Entered twice' })).body.data.status).toBe('cancelled');
  }, 60_000);

  it('B12: approved claims are owed to the founder; the bank debit to the founder settles them', async () => {
    const before = (await rishabh.get('/api/dashboard/categories?fy=26-27&kind=expense')).body.data as Pivot;
    const c1 = await claim('2500');
    const c2 = await claim('1200', { vendorName: 'Porter', expenseDate: '2026-09-12' });
    const c3 = await claim('800', { vendorName: 'Lunch' });
    for (const c of [c1, c2, c3]) expect((await receipt(c.id)).status).toBe(200);
    expect((await rishabh.post(`/api/claims/${c1.id}/approve`)).body.data).toMatchObject({ status: 'approved', statusLabel: 'To reimburse' });
    await rishabh.post(`/api/claims/${c2.id}/approve`);
    expect((await rishabh.post(`/api/claims/${c3.id}/reject`).send({ reason: 'Team lunch is personal' })).body.data.status).toBe('rejected');
    expect(await owedTo(arnavId)).toMatchObject({ owed: '3700.00', waiting: '0.00' });

    // An approved claim is spending on its expense date (cash view), even before it is paid back.
    const after = (await rishabh.get('/api/dashboard/categories?fy=26-27&kind=expense')).body.data as Pivot;
    expect(rowTotal(after, office.categoryId) - rowTotal(before, office.categoryId)).toBe(3700);
    const home = (await rishabh.get('/api/dashboard/home')).body.data;
    expect(home.founders.find((f: { founderUserId: string }) => f.founderUserId === arnavId)).toMatchObject({ owed: '3700.00' });

    // Reimburse the first claim: PMT number, claim reimbursed, Rs 1,200 still owed.
    const ref = utr();
    const r = await rishabh.post('/api/claims/reimbursements').send({ founderUserId: arnavId, claimIds: [c1.id], paidDate: '2026-09-15', mode: 'imps', fromBankAccountId: idfc, utr: ref });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'paid', amount: '2500.00' });
    expect(r.body.data.reimbursementNo).toMatch(/^PMT-\d{4,}$/);
    expect((await rishabh.get(`/api/claims/${c1.id}`)).body.data.status).toBe('reimbursed');
    expect(await owedTo(arnavId)).toMatchObject({ owed: '1200.00' });
    // Paying back a claim twice is refused.
    expect((await rishabh.post('/api/claims/reimbursements').send({ founderUserId: arnavId, claimIds: [c1.id], paidDate: '2026-09-15', mode: 'imps', fromBankAccountId: idfc, utr: utr() })).status).toBe(400);

    // The statement row matches by UTR and is categorised Founder Reimbursement (outside burn).
    const imp = await rishabh.post('/api/bank/imports').send({ bankAccountId: idfc, fileName: 'idfc.csv', contentBase64: csv(
      `${HEADER}2026-09-15,2026-09-15,IMPS-OPM/${ref}/${arnavName.toUpperCase()}/HDFC0000001/4417/Reimbursement,,2500,,497500\n`) });
    expect(imp.status).toBe(200);
    const rec = (await rishabh.get(`/api/claims/reimbursements/${r.body.data.id}`)).body.data;
    expect(rec).toMatchObject({ status: 'reconciled', matchedBy: 'utr' });
    const row = await prisma.bankTxn.findUniqueOrThrow({ where: { id: rec.bankRow.id } });
    expect(row).toMatchObject({ nature: 'reimbursement', partyType: 'founder', partyId: arnavId, linkedDocType: 'Reimbursement', status: 'suggested' });
    // Not counted twice: the cash view still shows the claims, not the reimbursement.
    const later = (await rishabh.get('/api/dashboard/categories?fy=26-27&kind=expense')).body.data as Pivot;
    expect(rowTotal(later, office.categoryId)).toBe(rowTotal(after, office.categoryId));

    // The forecast puts what is still owed in week 1.
    const f = (await rishabh.get('/api/dashboard/forecast')).body.data;
    expect(f.weeks).toHaveLength(13);
    expect(f.weeks[0].items.find((i: { label: string }) => i.label === `Owed to ${arnavName}`)).toMatchObject({ kind: 'claims', amount: '1200.00' });

    // A returned payment puts the claim back to be paid; the number stays.
    const failed = await rishabh.post(`/api/claims/reimbursements/${r.body.data.id}/failed`).send({ reason: 'Returned by the bank' });
    expect(failed.body.data).toMatchObject({ status: 'failed', reimbursementNo: r.body.data.reimbursementNo });
    expect((await rishabh.get(`/api/claims/${c1.id}`)).body.data.status).toBe('approved');
    expect(await owedTo(arnavId)).toMatchObject({ owed: '3700.00' });
  }, 90_000);

  it('BR-35: a bill paid from the bank counts once: its cost in accrual view, the cash in cash view', async () => {
    const vendorId = (await rishabh.post('/api/vendors').send({ displayName: `Saiffi ${Date.now()}`, vendorType: 'both', gstin: testGstin('29'), activate: true })).body.data.id;
    const cash0 = (await rishabh.get('/api/dashboard/categories?fy=26-27&kind=capex')).body.data as Pivot;
    const acc0 = (await rishabh.get('/api/dashboard/categories?fy=26-27&kind=capex&view=accrual')).body.data as Pivot;
    const pay0 = (await rishabh.get('/api/dashboard/payables?fy=26-27')).body.data;
    const bill = (await rishabh.post('/api/bills').send({
      docType: 'tax_invoice', vendorId, docNumber: `040-${Date.now()}`, docDate: '2026-09-24', ...capex,
      lines: [{ description: 'Mould', hsnSac: '8480', qty: '1', unit: 'Nos', rate: '98000', discount: '0', gstRate: '18' }],
    })).body.data;
    expect(bill).toMatchObject({ taxableValue: '98000.00', totalValue: '115640.00' });
    await rishabh.post('/api/attachments').send({ recordType: 'VendorDocument', recordId: bill.id, docKind: 'bill', fileName: 'bill.pdf', contentBase64: PDF });
    await rishabh.post(`/api/bills/${bill.id}/approve`);
    const ref = utr();
    const p = await rishabh.post('/api/payments').send({ vendorId, allocations: [{ docId: bill.id, gross: '115640' }], record: { paidDate: '2026-09-24', mode: 'neft', fromBankAccountId: idfc, utr: ref } });
    expect(p.status).toBe(200);
    await rishabh.post('/api/bank/imports').send({ bankAccountId: idfc, fileName: 'idfc2.csv', contentBase64: csv(
      `${HEADER}2026-09-24,2026-09-24,NEFT/${ref}/SAIFFI/HDFC0000002/Mould,,115640,,381860\n`) });
    expect((await rishabh.get(`/api/payments/${p.body.data.id}`)).body.data.status).toBe('reconciled');
    const cash1 = (await rishabh.get('/api/dashboard/categories?fy=26-27&kind=capex')).body.data as Pivot;
    const acc1 = (await rishabh.get('/api/dashboard/categories?fy=26-27&kind=capex&view=accrual')).body.data as Pivot;
    expect(rowTotal(cash1, capex.categoryId) - rowTotal(cash0, capex.categoryId)).toBe(115640);
    expect(rowTotal(acc1, capex.categoryId) - rowTotal(acc0, capex.categoryId)).toBe(98000);

    // F132: one more invoice received, with no PO, now paid.
    const pay1 = (await rishabh.get('/api/dashboard/payables?fy=26-27')).body.data;
    expect(pay1.received.count - pay0.received.count).toBe(1);
    expect(pay1.noPo.count - pay0.noPo.count).toBe(1);
    expect(pay1.byStatus.paid - pay0.byStatus.paid).toBe(1);
    expect(Number(pay1.paid.amount) - Number(pay0.paid.amount)).toBe(115640);
    expect(pay1.ageing.rows).toBeInstanceOf(Array);
  }, 90_000);
});
