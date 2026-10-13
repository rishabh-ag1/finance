import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Agent } from 'supertest';
import { prisma } from '../../src/config/database';
import { createApp } from '../../src/app';
import { countsAsOperatingIncome, countsInGrossBurn, isPnl } from '../../src/lib/nature';
import { hasDb } from '../setup/db';
import { loggedInFounder, seedOnce } from '../setup/fixtures';

// Phase 1 acceptance checks A5-A9 (docs/phase-1-plan.md) on the real IDFC fixture, plus
// BR-06 (transfer pairing), BR-07 (split) and F014 ledger totals through the API.
const FIXTURE = fs.readFileSync(path.resolve(__dirname, '../../../data/fixtures/idfc_statement_rows.csv'));
const csv = (text: string) => Buffer.from(text).toString('base64');
const HEADER = 'Transaction Date,Value Date,Particulars,Cheque No.,Debit,Credit,Balance\n';

async function account(agent: Agent, over: Record<string, unknown> = {}): Promise<string> {
  const r = await agent.post('/api/settings/bank-accounts').send({
    bankName: 'IDFC FIRST Bank', accountName: 'Entelechy Labs Private Limited', accountNumber: `T${Date.now()}${Math.floor(Math.random() * 1e4)}`,
    ifsc: 'IDFB0080152', accountType: 'business_current', owner: 'Entelechy', openingBalance: '0', openingDate: '2026-05-29',
    parserFormat: 'idfc_v1', ...over,
  });
  if (r.status !== 200) throw new Error(`account: ${JSON.stringify(r.body)}`);
  return r.body.data.id;
}

describe.skipIf(!hasDb)('Acceptance A5-A9: ledger and review', () => {
  let app: Express;
  let agent: Agent;
  let acct = '';
  const row = (utrOrText: string) => prisma.bankTxn.findFirstOrThrow({
    where: { bankAccountId: acct, OR: [{ utr: utrOrText }, { narrationRaw: { contains: utrOrText } }] },
  });
  const names = async (t: { categoryId: string | null; subCategoryId: string | null }) => ({
    category: t.categoryId ? (await prisma.category.findUniqueOrThrow({ where: { id: t.categoryId } })).name : null,
    sub: t.subCategoryId ? (await prisma.subCategory.findUniqueOrThrow({ where: { id: t.subCategoryId } })).name : null,
  });

  beforeAll(async () => {
    await seedOnce();
    app = createApp();
    ({ agent } = await loggedInFounder(app));
    acct = await account(agent);
    const r = await agent.post('/api/bank/imports').send({ bankAccountId: acct, fileName: 'idfc.csv', contentBase64: FIXTURE.toString('base64') });
    if (r.status !== 200) throw new Error(`import: ${JSON.stringify(r.body)}`);
  });
  afterAll(() => prisma.$disconnect());

  it('A5: OPT/CBDT rows are auto-categorised as Taxes > TDS Deposit (Tax Payment)', async () => {
    const rows = await prisma.bankTxn.findMany({ where: { bankAccountId: acct, narrationRaw: { startsWith: 'OPT/CBDT' } } });
    expect(rows).toHaveLength(4);
    for (const t of rows) {
      expect(t).toMatchObject({ status: 'suggested', nature: 'tax_payment', partyType: 'govt', categorisationReason: 'Rule: OPT/CBDT' });
      expect(await names(t)).toEqual({ category: 'Taxes', sub: 'TDS Deposit' });
    }
  });

  it('A6: Rs 12,00,000 from Neos Kosmos on 4 Jun is Financing In (loan), outside income and burn', async () => {
    const t = await row('KKBKR22026060423108701');
    expect(t.credit.toFixed(2)).toBe('1200000.00');
    expect(t).toMatchObject({ nature: 'financing_in', partyType: 'lender' });
    expect(await names(t)).toEqual({ category: 'Financing', sub: 'Loan Received' });
    expect(isPnl(t.nature!)).toBe(false);
    expect(countsAsOperatingIncome(t.nature!)).toBe(false);
  });

  it('A7: tooling payments to Saiffi, Micro Instruments and Valco are Capex, outside burn', async () => {
    for (const [utr, amount] of [['IDFBR62026072403779464', '1136800.00'], ['623112118032', '284808.00'], ['624412362940', '62640.00']]) {
      const t = await row(utr);
      expect(t.debit.toFixed(2)).toBe(amount);
      expect(t.nature).toBe('capex');
      expect(await names(t)).toEqual({ category: 'Capex', sub: 'Tooling & Moulds' });
      expect(countsInGrossBurn(t.nature!)).toBe(false);
    }
    // Shown under capex: the ledger filtered by nature Capex adds them up (with VideAim's design patent).
    const ledger = await agent.get(`/api/bank/txns?accountId=${acct}&nature=capex`);
    expect(ledger.body.data.totals).toMatchObject({ count: 4, outflow: '1503608.00', inflow: '0.00' });
  });

  it('A8: Rs 7,00,000 from Newera Living on 19 Aug is Related Party, not income and not a transfer', async () => {
    const t = await row('7545890');
    expect(t.credit.toFixed(2)).toBe('700000.00');
    expect(t).toMatchObject({ nature: 'related_party', relatedPartyType: 'undecided', transferPairId: null });
    expect(t.status).not.toBe('transfer');
    expect(isPnl(t.nature!)).toBe(false);
  });

  it('A9: deleting a bank row is refused and audited; ignoring it needs a note and is audited', async () => {
    const t = await row('625171485826'); // Rs 1 UPI credit
    const del = await agent.delete(`/api/bank/txns/${t.id}`);
    expect(del.status).toBe(409);
    expect(await prisma.bankTxn.findUnique({ where: { id: t.id } })).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { recordId: t.id, action: 'delete_refused' } })).toBe(1);

    expect((await agent.post(`/api/bank/txns/${t.id}/ignore`).send({ note: '' })).status).toBe(400);
    const ok = await agent.post(`/api/bank/txns/${t.id}/ignore`).send({ note: 'Re 1 test credit (penny drop)' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('ignored');
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { recordId: t.id, field: 'status' }, orderBy: { id: 'desc' } });
    expect(audit).toMatchObject({ newValue: 'ignored', reason: 'Re 1 test credit (penny drop)' });
  });

  it('F016: rows with no rule stay in Review; bulk accept confirms suggestions', async () => {
    const innov8 = await row('67177144'); // no rule covers it and no test ever confirms it
    expect(innov8.status).toBe('review');
    const suggested = await prisma.bankTxn.findMany({ where: { bankAccountId: acct, status: 'suggested' }, select: { id: true } });
    const r = await agent.post('/api/bank/txns/accept').send({ ids: [...suggested.map((s) => s.id), innov8.id] });
    expect(r.body.data).toEqual({ accepted: suggested.length, skipped: 1 });
    expect(await prisma.bankTxn.count({ where: { bankAccountId: acct, status: 'suggested' } })).toBe(0);
  });

  it('BR-05 step 4: a counterparty categorised once is suggested the same way next time', async () => {
    const party = `TEST PARTY ${Date.now()}`; // unique per run
    const misc = await prisma.category.findUniqueOrThrow({ where: { name: 'Operations_Admin' }, include: { subCategories: true } });
    const sub = misc.subCategories.find((s) => s.name === 'Office / Admin Misc')!;

    const first = await account(agent, { openingBalance: '1000', openingDate: '2026-10-31' });
    await agent.post('/api/bank/imports').send({ bankAccountId: first, fileName: 'a.csv', contentBase64: csv(`${HEADER}2026-11-02,2026-11-02,IFT/10199987550/${party}/1111111,,500,,500\n`) });
    const t = await prisma.bankTxn.findFirstOrThrow({ where: { bankAccountId: first } });
    expect(t.status).toBe('review');
    const r = await agent.post(`/api/bank/txns/${t.id}/categorise`).send({ categoryId: misc.id, subCategoryId: sub.id, description: 'Paid by mistake' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'categorised', nature: 'operating_expense', categorisationReason: 'Set by hand', description: 'Paid by mistake' });

    const second = await account(agent, { openingBalance: '1000', openingDate: '2026-10-31' });
    await agent.post('/api/bank/imports').send({ bankAccountId: second, fileName: 'b.csv', contentBase64: csv(`${HEADER}2026-11-09,2026-11-09,IFT/10199987550/${party}/2222222,,300,,700\n`) });
    const next = await prisma.bankTxn.findFirstOrThrow({ where: { bankAccountId: second } });
    expect(next).toMatchObject({ status: 'suggested', categoryId: misc.id, subCategoryId: sub.id, categorisationReason: `Last used for ${party}` });
  });

  it('BR-07: splits Rs 18,700 into two lines; refuses lines that do not add up', async () => {
    const t = await row('626018943896'); // Makenica Rs 18,700
    const rnd = await prisma.category.findUniqueOrThrow({ where: { name: 'R&D' }, include: { subCategories: true } });
    const proto = rnd.subCategories.find((s) => s.name === 'Prototyping / 3D Printing')!;
    const mat = rnd.subCategories.find((s) => s.name === 'R&D Materials')!;
    const bad = await agent.post(`/api/bank/txns/${t.id}/split`).send({ lines: [
      { amount: '10000', categoryId: rnd.id, subCategoryId: proto.id }, { amount: '8699.99', categoryId: rnd.id, subCategoryId: mat.id },
    ] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/short by 0.01/);

    const ok = await agent.post(`/api/bank/txns/${t.id}/split`).send({ lines: [
      { amount: '10000', categoryId: rnd.id, subCategoryId: proto.id }, { amount: '8,700', categoryId: rnd.id, subCategoryId: mat.id },
    ] });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'split', categorisationReason: 'Split (2)' });
    expect(ok.body.data.splits.map((s: { amount: string }) => s.amount)).toEqual(['10000.00', '8700.00']);

    // Ledger filtered by sub-category's category counts the split lines.
    const l = await agent.get(`/api/bank/txns?accountId=${acct}&categoryId=${rnd.id}`);
    expect(l.body.data.rows.some((r: { id: string }) => r.id === t.id)).toBe(true);
  });

  it('BR-06: a debit in IDFC and the same credit in the PNB cash credit within 3 days pair as a Transfer', async () => {
    // A different amount every run: earlier runs' unpaired rows stay in the test database.
    const amt = 100000 + Math.floor(Math.random() * 90000);
    const idfc = await account(agent, { openingBalance: '500000', openingDate: '2026-10-31' });
    const pnb = await account(agent, {
      bankName: 'Punjab National Bank', ifsc: 'PUNB0114510', accountType: 'cash_credit', sanctionedLimit: '2000000', openingBalance: '0', openingDate: '2026-10-31',
    });
    await agent.post('/api/bank/imports').send({ bankAccountId: idfc, fileName: 'a.csv', contentBase64: csv(`${HEADER}2026-11-02,2026-11-02,NEFT/N306261234567/ENTELECHY LABS/PUNB0114510/To CC,,${amt},,${500000 - amt}\n`) });
    await agent.post('/api/bank/imports').send({ bankAccountId: pnb, fileName: 'b.csv', contentBase64: csv(`${HEADER}2026-11-04,2026-11-04,NEFT/N306261234567/ENTELECHY LABS/IDFB0080152/From IDFC,,,${amt},${amt}\n`) });
    const a = await prisma.bankTxn.findFirstOrThrow({ where: { bankAccountId: idfc } });
    const b = await prisma.bankTxn.findFirstOrThrow({ where: { bankAccountId: pnb } });
    expect(a).toMatchObject({ status: 'transfer', nature: 'transfer', transferPairId: b.id, partyType: 'own_account' });
    expect(b).toMatchObject({ status: 'transfer', nature: 'transfer', transferPairId: a.id });

    const un = await agent.post(`/api/bank/txns/${a.id}/unpair`).send({ reason: 'test' });
    expect(un.body.data.status).toBe('review');
    expect((await prisma.bankTxn.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('review');
  });

  it('F014: ledger totals follow the filter (all 22 rows: in 20,01,181, out 15,90,312)', async () => {
    const r = await agent.get(`/api/bank/txns?accountId=${acct}`);
    expect(r.body.data.totals).toEqual({ count: 22, inflow: '2001181.00', outflow: '1590312.00', net: '410869.00' });
    const june = await agent.get(`/api/bank/txns?accountId=${acct}&from=2026-06-01&to=2026-06-30&direction=in`);
    expect(june.body.data.totals).toMatchObject({ count: 3, inflow: '1251180.00' });
  });
});
