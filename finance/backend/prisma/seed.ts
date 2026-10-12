import dotenv from 'dotenv';
dotenv.config();

import { prisma } from '../src/config/database';
import { withAudit } from '../src/lib/audit';
import { adminPermissions } from '../src/lib/permissions';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../src/services/auth.service';
import { seedMasters } from '../src/services/seed.service';

// v1 users: the two founders only, both Admin (Q18). Re-running the seed never resets a
// password that is already set.
const FOUNDERS = [
    { email: 'rishabh@blocinsects.com', firstName: 'Rishabh', lastName: 'Agarwal' },
    { email: 'arnav@blocinsects.com', firstName: 'Arnav', lastName: 'Gupta' },
];

export async function seedUsersAndRoles(firstPassword: string): Promise<void> {
    const passwordHash = await hashPassword(firstPassword);
    await withAudit({ userId: 'system', reason: 'seed' }, async (tx) => {
        const role = await tx.role.upsert({
            where: { name: 'FINANCE_ADMIN' },
            update: { permissions: adminPermissions() },
            create: {
                name: 'FINANCE_ADMIN',
                description: 'Founders: full access to every finance module',
                permissions: adminPermissions(),
            },
        });
        for (const f of FOUNDERS) {
            await tx.user.upsert({
                where: { email: f.email },
                update: { roleId: role.id },
                create: { ...f, roleId: role.id, passwordHash },
            });
        }
    });
}

async function main() {
    const firstPassword = process.env.SEED_ADMIN_PASSWORD;
    if (!firstPassword || firstPassword.length < MIN_PASSWORD_LENGTH) {
        throw new Error(`Set SEED_ADMIN_PASSWORD in .env (at least ${MIN_PASSWORD_LENGTH} characters) before seeding.`);
    }
    await seedUsersAndRoles(firstPassword);
    await withAudit({ userId: 'system', reason: 'seed' }, (tx) => seedMasters(tx), { timeoutMs: 120_000 });
    console.log('Seeded role FINANCE_ADMIN, the two founders, company, IDFC account, tax masters, number series, payment terms, approval bands (off) and the Category Master.');
}

if (require.main === module) {
    main()
        .catch((e) => { console.error(e); process.exit(1); })
        .finally(() => prisma.$disconnect());
}
