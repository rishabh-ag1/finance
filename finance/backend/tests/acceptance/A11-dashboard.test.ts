import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Agent } from 'supertest';
import { prisma } from '../../src/config/database';
import { createApp } from '../../src/app';
import { categoryPivot, home } from '../../src/services/dashboard.service';
import { hasDb } from '../setup/db';
import { loggedInFounder, seedOnce } from '../setup/fixtures';

// Acceptance A11 and the F130 / F131 dashboards on the real IDFC fixture, as of 13 Oct 2026.
// The founders' review is simulated first: Innov8 -> Virtual Office, salaries -> Intern Salary,
// the Rs 1,180 out-and-back pair ignored. Everything else keeps the rules' suggestions.
const FIXTURE = fs.readFileSync(path.resolve(__dirname, '../../../data/fixtures/idfc_statement_rows.csv'));

describe.skipIf(!hasDb)('Acceptance A11: home dashboard and category analytics', () => {
  let app: Express;
  let agent: Agent;
  let acct = '';

  beforeAll(async () => {
    await seedOnce();
    app = createApp();
    ({ agent } = await loggedInFounder(app));
    const a = await agent.post('/api/settings/bank-accounts').send({
      bankName: 'IDFC FIRST Bank', accountName: 'Entelechy Labs Private Limited', accountNumber: `H${Date.now()}`,
      ifsc: 'IDFB0080152', accountType: 'business_current', owner: 'Entelechy', openingBalance: '0', openingDate: '2026-05-29', parserFormat: 'idfc_v1',
    });
    acct = a.body.data.id;
    await agent.post('/api/bank/imports').send({ bankAccountId: acct, fileName: 'idfc.csv', contentBase64: FIXTURE.toString('base64') });

    const cat = async (name: string, sub: string) => {
      const c = await prisma.category.findUniqueOrThrow({ where: { name }, include: { subCategories: true } });
      return { categoryId: c.id, subCategoryId: c.subCategories.find((s) => s.name === sub)!.id };
    };
    const row = (text: string) => prisma.bankTxn.findFirstOrThrow({ where: { bankAccountId: acct, narrationRaw: { contains: text } } });
    await agent.post(`/api/bank/txns/${(await row('INNOV8WORK')).id}/categorise`).send(await cat('Operations_Admin', 'Virtual Office'));
    for (const who of ['MANI JOSHI', 'NIHAL ABHAY KIRAN']) {
      await agent.post(`/api/bank/txns/${(await row(who)).id}/categorise`).send(await cat('Salaries_People', 'Intern Salary'));
    }
    for (const text of ['ASTRA SHIELD', 'NEWERA LIVING /17694473', 'GOLLA RA']) {
      await agent.post(`/api/bank/txns/${(await row(text)).id}/ignore`).send({ note: 'Reversal pair / test credit' });
    }
  });
  afterAll(() => prisma.$disconnect());

  it('D01: cash is the last statement balance of the business account (Rs 4,10,869)', async () => {
    const h = await home({ asOf: '2026-10-13', accountIds: [acct] });
    expect(h.cash.total).toBe('410869.00');
    expect(h.cashCredit).toBeNull();
  });

  it('A11: runway = cash / average net burn of Jul, Aug, Sep (no operating income), in months', async () => {
    const h = await home({ asOf: '2026-10-13', accountIds: [acct] });
    expect(h.lastThreeMonths.map((m) => [m.month, m.grossBurn, m.operatingIncome, m.netBurn])).toEqual([
      ['2026-07-01', '0.00', '0.00', '0.00'],        // Saiffi tooling is capex
      ['2026-08-01', '12980.00', '0.00', '12980.00'], // Innov8 virtual office; Micro Instruments capex; TDS is tax
      ['2026-09-01', '40152.00', '0.00', '40152.00'], // R&D 30,152 + salary 10,000; VideAim patent capex
    ]);
    expect(h.runway).toEqual({ kind: 'months', months: '23.1', averageNetBurn: '17710.67' });
  });

  it('D05/D06: capex and funding are shown apart from burn', async () => {
    const h = await home({ asOf: '2026-10-13', accountIds: [acct] });
    expect(h.capex.fy).toBe('1503608.00'); // Saiffi + Micro Instruments + Valco + VideAim
    expect(h.funding.fy).toBe('1300000.00'); // founders 50,000 x 2 + Mesa loan 12,00,000; Newera is related party
    expect(h.funding.bySubCategory).toEqual(expect.arrayContaining([
      { name: 'Loan Received', amount: '1200000.00' },
      { name: 'Investment - Rishabh', amount: '50000.00' },
      { name: 'Investment - Arnav', amount: '50000.00' },
    ]));
    expect(h.thisMonth.grossBurn).toBe('4200.00'); // October salary
  });

  it('D11: category x month shows operating spend only, with sub-categories', async () => {
    const p = await categoryPivot({ fy: '26-27', kind: 'expense', accountIds: [acct] });
    const i = (m: string) => p.months.indexOf(m);
    expect(p.months[0]).toBe('2026-04-01');
    expect(p.totals[i('2026-08-01')]).toBe('12980.00');
    expect(p.totals[i('2026-09-01')]).toBe('40152.00');
    expect(p.grandTotal).toBe('57332.00');
    const rnd = p.rows.find((r) => r.name === 'R&D')!;
    expect(rnd.values[i('2026-09-01')]).toBe('30152.00');
    expect(rnd.subCategories.map((s) => s.name).sort()).toEqual(['Electrical / Lab Testing', 'Prototyping / 3D Printing']);
    expect(p.rows.some((r) => r.name === 'Capex' || r.name === 'Taxes' || r.name === 'Financing')).toBe(false);
  });

  it('D12 and capex views', async () => {
    const income = await categoryPivot({ fy: '26-27', kind: 'income', accountIds: [acct] });
    expect(income.grandTotal).toBe('0.00'); // no operating income yet
    const capex = await categoryPivot({ fy: '26-27', kind: 'capex', accountIds: [acct] });
    expect(capex.grandTotal).toBe('1503608.00');
  });

  it('serves the home dashboard over the API with action items', async () => {
    const r = await agent.get('/api/dashboard/home');
    expect(r.status).toBe(200);
    expect(r.body.data.actions).toEqual(expect.objectContaining({ review: expect.any(Number), missingDocuments: expect.any(Number) }));
    expect(r.body.data.runway.kind).toMatch(/months|cash_positive/);
  });
});
