import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Agent } from 'supertest';
import { prisma } from '../../src/config/database';
import { createApp } from '../../src/app';
import { hasDb } from '../setup/db';
import { loggedInFounder, seedOnce } from '../setup/fixtures';

// D39 spend by category on Home: largest first, shares add up, the same flows as category analytics.
describe.skipIf(!hasDb)('D39 spend by category', () => {
  let app: Express;
  let agent: Agent;
  beforeAll(async () => { await seedOnce(); app = createApp(); ({ agent } = await loggedInFounder(app)); }, 60_000);
  afterAll(async () => { await prisma.$disconnect(); });

  it('each period: categories largest first, amounts add to the total, shares to 100%', async () => {
    for (const period of ['month', '3m', 'fy']) {
      const d = (await agent.get('/api/dashboard/spend-by-category').query({ period })).body.data;
      expect(d.period).toBe(period);
      const amounts = d.rows.map((r: { amount: string }) => Number(r.amount));
      expect(amounts).toEqual([...amounts].sort((a, b) => b - a));
      expect(amounts.reduce((s: number, x: number) => s + x, 0)).toBeCloseTo(Number(d.total), 2);
      if (d.rows.length) expect(d.rows.reduce((s: number, r: { sharePercent: string }) => s + Number(r.sharePercent), 0)).toBeCloseTo(100, 0);
      expect(d.comparedWith === null).toBe(period === 'fy');
    }
  }, 120_000);

  it('the FY figures are the same spend as category analytics for the FY (nothing dated after today)', async () => {
    const d = (await agent.get('/api/dashboard/spend-by-category').query({ period: 'fy' })).body.data;
    const pivot = (await agent.get('/api/dashboard/categories').query({ kind: 'expense' })).body.data;
    const future = await prisma.bankTxn.count({ where: { txnDate: { gt: new Date(`${d.to}T00:00:00Z`) } } });
    if (future === 0) expect(Number(d.total)).toBeCloseTo(Number(pivot.grandTotal), 2);
    else expect(Number(d.total)).toBeLessThanOrEqual(Number(pivot.grandTotal) + 0.01);
  }, 120_000);
});
