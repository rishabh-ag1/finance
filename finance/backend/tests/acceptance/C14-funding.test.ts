import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Agent } from 'supertest';
import { prisma } from '../../src/config/database';
import { createApp } from '../../src/app';
import { hasDb } from '../setup/db';
import { loggedInFounder, seedOnce } from '../setup/fixtures';

// Phase 3 acceptance C14 (loans and covenant, BR-28) and the capital register (F140).
const RUN = Date.now().toString(36).toUpperCase();
const csv = (text: string) => Buffer.from(text.trim() + '\n').toString('base64');
const HEADER = 'Transaction Date,Value Date,Particulars,Cheque No.,Debit,Credit,Balance\n';
const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

describe.skipIf(!hasDb)('Acceptance C14: funding and loans', () => {
  let app: Express;
  let agent: Agent;
  let idfc = '';
  const made: string[] = [];
  const lender = `Neos Kosmos ${RUN}`;

  beforeAll(async () => {
    await seedOnce();
    app = createApp();
    ({ agent } = await loggedInFounder(app));
    idfc = (await agent.post('/api/settings/bank-accounts').send({
      bankName: 'IDFC FIRST Bank', accountName: 'Entelechy Labs Private Limited', accountNumber: `F${Date.now()}`, ifsc: 'IDFB0080152',
      accountType: 'business_current', owner: 'Entelechy', openingBalance: '100000', openingDate: '2026-05-25', parserFormat: 'idfc_v1',
    })).body.data.id;
  }, 60_000);
  // Leave the practice database's debt as it was: test loans are repaid or cancelled.
  afterAll(async () => {
    for (const id of made) {
      const l = (await agent.get(`/api/loans/${id}`)).body.data;
      for (const r of l.repayments.filter((x: { status: string }) => x.status === 'recorded')) await agent.post(`/api/loan-repayments/${r.id}/cancel`).send({ reason: 'Test: clean up' });
      await agent.post(`/api/loans/${id}/cancel`).send({ reason: 'Test: clean up' });
    }
    await prisma.$disconnect();
  });

  it('C14: Mesa Rs 12,00,000 received 4 Jun 2026, flexible over 18 months: balance and days to 4 Dec 2027; matched to its bank credit', async () => {
    const r = await agent.post('/api/loans').send({ lender, sanctionAmount: '1200000', disbursedAmount: '1200000', disbursedDate: '2026-06-04', repaymentType: 'flexible', tenureMonths: 18 });
    expect(r.status).toBe(200);
    made.push(r.body.data.id);
    expect(r.body.data).toMatchObject({ finalDueDate: '2027-12-04', balance: '1200000.00', daysToFinalDue: daysBetween(today(), '2027-12-04'), repaymentTypeLabel: 'Flexible (repay any time)', schedule: [] });
    const st = await agent.post('/api/bank/imports').send({ bankAccountId: idfc, fileName: 'idfc.csv', contentBase64: csv(`${HEADER}2026-06-04,2026-06-04,NEFT/N${RUN}/NEOS KOSMOS ${RUN}/ICIC0000001/Loan,,,1200000,1300000`) });
    expect(st.status).toBe(200);
    const loan = (await agent.get(`/api/loans/${r.body.data.id}`)).body.data;
    expect(loan.inBank).toBe(true);
    const row = await prisma.bankTxn.findFirstOrThrow({ where: { bankAccountId: idfc, credit: '1200000' } });
    const fin = await prisma.category.findUniqueOrThrow({ where: { name: 'Financing' }, include: { subCategories: true } });
    expect(row).toMatchObject({ linkedDocType: 'Loan', categoryId: fin.id, subCategoryId: fin.subCategories.find((s) => s.name === 'Loan Received')!.id, nature: 'financing_in' });
  }, 120_000);

  it('C14: a new loan that takes total debt above Rs 45,00,000 warns before it is saved', async () => {
    const before = (await agent.get('/api/funding')).body.data.covenant;
    expect(before.cap).toBe('4500000.00');
    const room = Number(before.headroom);
    const small = (await agent.post('/api/loans/preview').send({ lender: 'Bank', sanctionAmount: '100000', disbursedAmount: '100000', disbursedDate: '2026-10-01', repaymentType: 'flexible', tenureMonths: 12 })).body.data;
    expect(small.covenant.breached).toBe(room < 100000);
    const big = String(Math.max(room, 0) + 100000);
    const over = (await agent.post('/api/loans/preview').send({ lender: 'Bank', sanctionAmount: big, disbursedAmount: big, disbursedDate: '2026-10-01', repaymentType: 'flexible', tenureMonths: 12 })).body.data;
    expect(over.covenant).toMatchObject({ breached: true });
    expect(over.covenant.warning).toMatch(/above the Rs 45,00,000.00 cap in the Mesa agreement \(by Rs 1,00,000.00\)/);
  }, 60_000);

  it('F142: an EMI loan gets its schedule; an instalment paid is split in the bank row into principal and interest', async () => {
    const r = await agent.post('/api/loans').send({ lender: `Small Bank ${RUN}`, sanctionAmount: '1000000', disbursedAmount: '1000000', disbursedDate: '2026-06-05', interestRate: '12', repaymentType: 'emi', tenureMonths: 12, firstDueDate: '2026-07-05' });
    expect(r.status).toBe(200);
    made.push(r.body.data.id);
    expect(r.body.data.schedule).toHaveLength(12);
    expect(r.body.data.schedule[0]).toMatchObject({ dueDate: '2026-07-05', principal: '78849.00', interest: '10000.00', total: '88849.00' });
    const s = (await agent.get(`/api/loans/${r.body.data.id}/suggest-repayment`)).body.data;
    expect(s).toMatchObject({ principal: '78849.00', interest: '10000.00' });
    const paid = await agent.post(`/api/loans/${r.body.data.id}/repayments`).send({ paidDate: '2026-07-05', principal: s.principal, interest: s.interest, instalmentId: s.instalmentId });
    expect(paid.status).toBe(200);
    expect(paid.body.data).toMatchObject({ balance: '921151.00', principalRepaid: '78849.00', interestPaid: '10000.00', nextDue: { instalmentNo: 2, dueDate: '2026-08-05' } });
    const st = await agent.post('/api/bank/imports').send({ bankAccountId: idfc, fileName: 'idfc2.csv', contentBase64: csv(`${HEADER}2026-07-05,2026-07-05,ACH/SMALL BANK ${RUN}/EMI 1,,88849,,1211151`) });
    expect(st.status).toBe(200);
    const row = await prisma.bankTxn.findFirstOrThrow({ where: { bankAccountId: idfc, debit: '88849' }, include: { splits: { where: { isArchived: false }, orderBy: { lineNo: 'asc' } } } });
    expect(row).toMatchObject({ status: 'split', linkedDocType: 'LoanRepayment' });
    expect(row.splits.map((x) => [x.amount.toFixed(2), x.nature])).toEqual([['78849.00', 'financing_out'], ['10000.00', 'interest']]);
    // The repayment's amount cannot be edited.
    await expect(prisma.loanRepayment.updateMany({ where: { loanId: r.body.data.id }, data: { principal: '1' } })).rejects.toThrow();
    // The next instalment is in the cash forecast if it falls in the 13 weeks.
    expect((await agent.get('/api/loans')).body.data.find((l: { id: string }) => l.id === r.body.data.id).nextDue.dueDate).toBe('2026-08-05');
  }, 120_000);

  it('F140: share application money waits for allotment (flagged after 60 days), then is allotted; paid-up capital counts at once', async () => {
    const holder = `Rishabh Agarwal ${RUN}`;
    const sam = (await agent.post('/api/capital').send({ holderName: holder, receiptDate: '2026-07-01', amount: '500000', type: 'share_application_money' })).body.data;
    expect(sam).toMatchObject({ allotted: false, pendingAllotment: { overdue: daysBetween('2026-07-01', today()) > 60 } });
    const ov = (await agent.get('/api/funding')).body.data;
    expect(ov.capital.byHolder.find((h: { holderName: string }) => h.holderName === holder)).toMatchObject({ shareApplication: '500000.00', pendingAllotment: '500000.00' });
    const allotted = (await agent.post(`/api/capital/${sam.id}/allot`).send({ allotmentDate: '2026-08-15', sharesAllotted: 50000 })).body.data;
    expect(allotted).toMatchObject({ allotted: true, sharesAllotted: 50000, pendingAllotment: null });
    const pu = (await agent.post('/api/capital').send({ holderName: holder, receiptDate: '2026-05-30', amount: '50000', type: 'paid_up_capital' })).body.data;
    expect(pu.allotted).toBe(true);
    await expect(prisma.capitalReceipt.update({ where: { id: pu.id }, data: { amount: '1' } })).rejects.toThrow();
  }, 60_000);
});
