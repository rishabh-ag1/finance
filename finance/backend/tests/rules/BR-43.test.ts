import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../../src/config/database';
import { withAudit } from '../../src/lib/audit';
import { hashPassword } from '../../src/services/auth.service';
import { createApp } from '../../src/app';
import { adminPermissions } from '../../src/lib/permissions';
import { hasDb, uniqueEmail } from '../setup/db';

// BR-43 Audit trail: store table, record ID, field, old value, new value, user, timestamp,
// reason. Financial records can never be hard-deleted. (No worked example in rules.md; these
// tests pin the logic.)

async function makeUser(actor = 'system') {
    return withAudit({ userId: actor, reason: 'test' }, (tx) =>
        tx.user.create({ data: { email: uniqueEmail(), firstName: 'Test', lastName: 'User' } }),
    );
}

describe.skipIf(!hasDb)('BR-43 audit trail', () => {
    afterAll(() => prisma.$disconnect());

    it('writes one create row with the acting user and reason', async () => {
        const user = await makeUser('actor-1');
        const rows = await prisma.auditLog.findMany({ where: { recordType: 'User', recordId: user.id } });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ action: 'create', userId: 'actor-1', reason: 'test' });
        expect((rows[0].newValue as Record<string, unknown>).email).toBe(user.email);
    });

    it('writes one update row per changed field with old and new value', async () => {
        const user = await makeUser();
        await withAudit({ userId: 'actor-2' }, (tx) =>
            tx.user.update({ where: { id: user.id }, data: { firstName: 'Changed', lastName: 'Name' } }),
        );
        const rows = await prisma.auditLog.findMany({
            where: { recordId: user.id, action: 'update' },
            orderBy: { field: 'asc' },
        });
        expect(rows.map((r) => [r.field, r.oldValue, r.newValue, r.userId])).toEqual([
            ['firstName', 'Test', 'Changed', 'actor-2'],
            ['lastName', 'User', 'Name', 'actor-2'],
        ]);
    });

    it('logs a password change without the hash', async () => {
        const user = await makeUser();
        const passwordHash = await hashPassword('a-long-test-password');
        await withAudit({ userId: user.id }, (tx) => tx.user.update({ where: { id: user.id }, data: { passwordHash } }));
        const row = await prisma.auditLog.findFirstOrThrow({ where: { recordId: user.id, field: 'passwordHash' } });
        expect(row.newValue).toBe('***');
        expect(JSON.stringify(await prisma.auditLog.findMany({ where: { recordId: user.id } }))).not.toContain(passwordHash);
    });

    it('refuses a write that does not say who is acting', async () => {
        await expect(
            prisma.user.create({ data: { email: uniqueEmail(), firstName: 'No', lastName: 'Actor' } }),
        ).rejects.toThrow(/without a user/);
    });

    it('refuses a hard delete and keeps the record', async () => {
        const user = await makeUser();
        await expect(
            withAudit({ userId: 'actor-3' }, (tx) => tx.user.delete({ where: { id: user.id } })),
        ).rejects.toThrow(/cannot be deleted/);
        expect(await prisma.user.findUnique({ where: { id: user.id } })).not.toBeNull();
    });

    it('keeps the audit log append only', async () => {
        const user = await makeUser();
        const row = await prisma.auditLog.findFirstOrThrow({ where: { recordId: user.id } });
        await expect(prisma.auditLog.update({ where: { id: row.id }, data: { reason: 'edited' } })).rejects.toThrow(/append only/);
        await expect(prisma.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append only/);
    });
});

describe.skipIf(!hasDb)('BR-43 through the API', () => {
    const app = createApp();
    const password = 'correct-horse-battery';

    async function founder() {
        const passwordHash = await hashPassword(password);
        return withAudit({ userId: 'system' }, async (tx) => {
            const role = await tx.role.upsert({
                where: { name: 'TEST_ADMIN' },
                update: {},
                create: { name: 'TEST_ADMIN', permissions: adminPermissions() },
            });
            return tx.user.create({
                data: { email: uniqueEmail('founder'), firstName: 'F', lastName: 'One', passwordHash, roleId: role.id },
            });
        });
    }

    it('logs in, reads the audit log, and refuses a DELETE with an audit entry', async () => {
        const user = await founder();
        const agent = request.agent(app);

        const login = await agent.post('/api/auth/login').send({ email: user.email, password });
        expect(login.status).toBe(200);

        const me = await agent.get('/api/auth/me');
        expect(me.body.data.email).toBe(user.email);

        const del = await agent.delete(`/api/users/${user.id}`);
        expect(del.status).toBe(409);
        expect(del.body.error).toMatch(/never deleted/);

        const audit = await agent.get(`/api/audit?recordId=${user.id}&action=delete_refused`);
        expect(audit.status).toBe(200);
        expect(audit.body.data.rows).toHaveLength(1);
        expect(audit.body.data.rows[0]).toMatchObject({ recordType: 'users', userId: user.id, userName: 'F One' });
    });

    it('locks the account after 5 wrong passwords', async () => {
        const user = await founder();
        for (let i = 0; i < 5; i += 1) {
            const r = await request(app).post('/api/auth/login').send({ email: user.email, password: 'wrong-password' });
            expect(r.status).toBe(401);
        }
        const locked = await request(app).post('/api/auth/login').send({ email: user.email, password });
        expect(locked.status).toBe(429);
    });

    it('turns away requests without a session', async () => {
        const r = await request(app).get('/api/audit');
        expect(r.status).toBe(401);
    });
});
