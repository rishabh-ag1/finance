import request from 'supertest';
import type { Express } from 'express';
import { withAudit } from '../../src/lib/audit';
import { adminPermissions } from '../../src/lib/permissions';
import { hashPassword } from '../../src/services/auth.service';
import { seedMasters } from '../../src/services/seed.service';
import { uniqueEmail } from './db';

export const TEST_PASSWORD = 'correct-horse-battery';

/** Company, IDFC account, masters and categories, exactly as `npm run db:seed` makes them. */
export async function seedOnce(): Promise<{ companyId: string }> {
    return withAudit({ userId: 'system', reason: 'test seed' }, (tx) => seedMasters(tx), { timeoutMs: 120_000 });
}

/** A founder with full access, and a logged-in supertest agent for them. */
export async function loggedInFounder(app: Express) {
    const passwordHash = await hashPassword(TEST_PASSWORD);
    const user = await withAudit({ userId: 'system' }, async (tx) => {
        const role = await tx.role.upsert({
            where: { name: 'TEST_ADMIN' },
            update: {},
            create: { name: 'TEST_ADMIN', permissions: adminPermissions() },
        });
        return tx.user.create({
            data: { email: uniqueEmail('founder'), firstName: 'F', lastName: 'One', passwordHash, roleId: role.id },
        });
    });
    const agent = request.agent(app);
    const login = await agent.post('/api/auth/login').send({ email: user.email, password: TEST_PASSWORD });
    if (login.status !== 200) throw new Error(`test login failed: ${login.status}`);
    return { user, agent };
}
