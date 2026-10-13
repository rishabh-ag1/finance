import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Agent } from 'supertest';
import { prisma } from '../../src/config/database';
import { createApp } from '../../src/app';
import { withAudit } from '../../src/lib/audit';
import { hasDb } from '../setup/db';
import { loggedInFounder, seedOnce } from '../setup/fixtures';

// Phase 1 acceptance checks A1-A4 (docs/phase-1-plan.md), on the real IDFC fixture
// data/fixtures/idfc_statement_rows.csv (30 May to 1 Oct 2026).
const FIXTURE = path.resolve(__dirname, '../../../data/fixtures/idfc_statement_rows.csv');
const file = (bankAccountId: string) => ({
  bankAccountId,
  fileName: 'idfc_statement_rows.csv',
  contentBase64: fs.readFileSync(FIXTURE).toString('base64'),
});

/** A fresh IDFC account per run (the test database keeps earlier runs' data). */
async function freshIdfcAccount(agent: Agent): Promise<string> {
  const r = await agent.post('/api/settings/bank-accounts').send({
    bankName: 'IDFC FIRST Bank', accountName: 'Entelechy Labs Private Limited', accountNumber: `TEST${Date.now()}9345`,
    ifsc: 'IDFB0080152', accountType: 'business_current', owner: 'Entelechy', openingBalance: '0', openingDate: '2026-05-29',
    parserFormat: 'idfc_v1',
  });
  if (r.status !== 200) throw new Error(`could not create account: ${JSON.stringify(r.body)}`);
  return r.body.data.id;
}

describe.skipIf(!hasDb)('Acceptance A1-A4: IDFC statement import', () => {
  let app: Express;
  let agent: Agent;
  let accountId = '';

  beforeAll(async () => {
    await seedOnce();
    app = createApp();
    ({ agent } = await loggedInFounder(app));
    accountId = await freshIdfcAccount(agent);
  });
  afterAll(() => prisma.$disconnect());

  it('A1: imports 22 rows, 0 duplicates, balance check passes', async () => {
    const preview = await agent.post('/api/bank/imports/preview').send(file(accountId));
    expect(preview.status).toBe(200);
    expect(preview.body.data).toMatchObject({ rowsTotal: 22, rowsNew: 22, rowsDuplicate: 0, rowsUnparsed: 0 });
    expect(preview.body.data.balanceCheck.status).toBe('ok');

    const r = await agent.post('/api/bank/imports').send(file(accountId));
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ rowsTotal: 22, rowsNew: 22, rowsDuplicate: 0, balanceCheckStatus: 'ok' });
    expect(await prisma.bankTxn.count({ where: { bankAccountId: accountId } })).toBe(22);
    expect(await prisma.bankTxn.count({ where: { bankAccountId: accountId, status: 'review' } })).toBe(22);
  });

  it('A2: importing the same file again adds 0 rows and finds 22 duplicates', async () => {
    const r = await agent.post('/api/bank/imports').send(file(accountId));
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ rowsTotal: 22, rowsNew: 0, rowsDuplicate: 22, balanceCheckStatus: 'ok' });
    expect(await prisma.bankTxn.count({ where: { bankAccountId: accountId } })).toBe(22);
  });

  it('A3: totals are inflow 20,01,181, outflow 15,90,312, closing 4,10,869 (as the Master Ledger)', async () => {
    const r = await agent.get(`/api/bank/accounts/${accountId}/totals`);
    expect(r.body.data).toMatchObject({
      rows: 22, inflow: '2001181.00', outflow: '1590312.00', closingBalance: '410869.00', lastStatementBalance: '410869.00', agrees: true,
    });

    // Same totals as the Master Ledger fixture.
    const ledger = fs.readFileSync(path.resolve(__dirname, '../../../data/fixtures/master_ledger_expected.csv'), 'utf8').trim().split('\n').slice(1);
    const sumCol = (i: number) => ledger.reduce((s, line) => s + Number(line.split(',')[i] || 0), 0); // whole rupees only in the fixture
    expect(sumCol(5)).toBe(2001181);
    expect(sumCol(6)).toBe(1590312);
  });

  it('A4: parses the Micro Instruments narration into mode, UTR, party and IFSC', async () => {
    const t = await prisma.bankTxn.findFirstOrThrow({ where: { bankAccountId: accountId, utr: '623112118032' } });
    expect(t).toMatchObject({
      mode: 'IMPS', utr: '623112118032', counterpartyName: 'MICRO INSTRUMENTS CO', counterpartyIfsc: 'SBIN0002468', remark: 'AdvanceToolingPaymentM',
    });
    expect(t.narrationRaw).toBe('IMPS-OPM/623112118032/MICRO INSTRUMENTS COMICRO INSTRUMENTS CO/SBIN0002468/7009/AdvanceToolingPaymentM');
  });

  it('BR-02: the imported facts of a row cannot be edited, even directly in the database', async () => {
    const t = await prisma.bankTxn.findFirstOrThrow({ where: { bankAccountId: accountId } });
    await expect(prisma.$transaction(async (tx) => {
      await tx.$queryRaw`select set_config('finance.user_id', 'tester', true)`;
      await tx.bankTxn.update({ where: { id: t.id }, data: { narrationRaw: 'edited' } });
    })).rejects.toThrow(/cannot be changed/);
  });

  it('BR-36: a locked month refuses new rows from an import', async () => {
    const other = await freshIdfcAccount(agent);
    // May cannot be locked through the API while A1's rows are in review (that is the rule), so
    // the lock is set directly here to test the database guard on bank rows.
    const company = await prisma.company.findFirstOrThrow();
    await withAudit({ userId: 'tester', reason: 'test: lock May' }, (tx) => tx.periodLock.upsert({
      where: { entityId_month: { entityId: company.id, month: new Date('2026-05-01T00:00:00Z') } },
      update: { isLocked: true, unlockedAt: null, unlockedBy: null, unlockReason: null },
      create: { entityId: company.id, month: new Date('2026-05-01T00:00:00Z'), lockedBy: 'tester' },
    }));
    try {
      const r = await agent.post('/api/bank/imports').send(file(other));
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/locked month/);
      expect(await prisma.bankTxn.count({ where: { bankAccountId: other } })).toBe(0);
    } finally {
      await agent.post('/api/settings/period-locks/unlock').send({ month: '2026-05-01', reason: 'test cleanup' });
    }
  });

  it('BR-36: May cannot be locked while its rows are still in Review', async () => {
    const r = await agent.post('/api/settings/period-locks/lock').send({ month: '2026-05-01' });
    if (r.status === 200) await agent.post('/api/settings/period-locks/unlock').send({ month: '2026-05-01', reason: 'test cleanup' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/review queue/);
  });
});
