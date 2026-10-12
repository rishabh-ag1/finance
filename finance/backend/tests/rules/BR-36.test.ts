import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/database';
import { createApp } from '../../src/app';
import { registerReviewCounter } from '../../src/services/settings.service';
import { hasDb } from '../setup/db';
import { loggedInFounder, seedOnce } from '../setup/fixtures';

// BR-36 Period lock: no create/edit/delete of records dated in a locked month. Admin unlock
// requires a reason and is audited. Lock requires zero rows in Review for that month.
// (No worked example in rules.md.) Enforcement on bank rows comes with M2.
describe.skipIf(!hasDb)('BR-36 period lock', () => {
    const app = createApp();
    let companyId = '';
    let reviewRows = 0;

    beforeAll(async () => {
        ({ companyId } = await seedOnce());
        registerReviewCounter(async () => reviewRows);
    });
    afterAll(() => prisma.$disconnect());

    it('locks an ended month and shows it as locked', async () => {
        const { agent } = await loggedInFounder(app);
        const r = await agent.post('/api/settings/period-locks/lock').send({ month: '2026-06-01' });
        expect(r.status).toBe(200);
        expect(r.body.data.months.find((m: { month: string }) => m.month === '2026-06-01').isLocked).toBe(true);
        expect(await prisma.$queryRaw`select finance.is_month_locked(${companyId}, '2026-06-15'::date) as locked`).toEqual([{ locked: true }]);
    });

    it('refuses to lock a month that has not ended', async () => {
        const { agent } = await loggedInFounder(app);
        const r = await agent.post('/api/settings/period-locks/lock').send({ month: '2099-01-01' });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/ended/);
    });

    it('refuses to lock while rows of the month are in review', async () => {
        const { agent } = await loggedInFounder(app);
        reviewRows = 2;
        const r = await agent.post('/api/settings/period-locks/lock').send({ month: '2026-07-01' });
        reviewRows = 0;
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/2 transaction\(s\).*review/);
    });

    it('needs a reason to unlock, and records the unlock in the audit log', async () => {
        const { agent, user } = await loggedInFounder(app);
        await agent.post('/api/settings/period-locks/lock').send({ month: '2026-08-01' });

        const noReason = await agent.post('/api/settings/period-locks/unlock').send({ month: '2026-08-01' });
        expect(noReason.status).toBe(400);

        const ok = await agent.post('/api/settings/period-locks/unlock').send({ month: '2026-08-01', reason: 'Late Razorpay fee entry' });
        expect(ok.status).toBe(200);
        const lock = await prisma.periodLock.findFirstOrThrow({ where: { month: new Date('2026-08-01T00:00:00Z') } });
        const audit = await prisma.auditLog.findFirstOrThrow({ where: { recordId: lock.id, action: 'unlock' } });
        expect(audit).toMatchObject({ userId: user.id, reason: 'Late Razorpay fee entry', field: 'isLocked' });
    });

    it('rejects an unlock without a reason at the database level too', async () => {
        const lock = await prisma.periodLock.findFirstOrThrow({ where: { month: new Date('2026-06-01T00:00:00Z') } });
        await expect(prisma.$transaction(async (tx) => {
            await tx.$queryRaw`select set_config('finance.user_id', 'tester', true)`;
            await tx.periodLock.update({ where: { id: lock.id }, data: { isLocked: false } });
        })).rejects.toThrow(/period_lock_unlock_reason/);
    });
});
