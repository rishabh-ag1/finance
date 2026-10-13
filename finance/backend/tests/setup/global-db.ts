import { execSync } from 'node:child_process';
import path from 'node:path';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
    export interface ProvidedContext {
        /** The test database was rebuilt and DB tests may run. */
        dbReady: boolean;
    }
}

/**
 * Before the test run: bring the test database up to prisma/schema.prisma and
 * prisma/sql/finance.sql, exactly as `npm run db:sync` does for the real one. It is never wiped
 * (the database refuses deletes anyway), so every test makes its own data and checks relative to it.
 * When DATABASE_URL_TEST is missing or the database can't be reached, DB tests are skipped
 * (with a loud warning) and the pure rule tests still run.
 */
export default function setup(project: TestProject): void {
    const url = process.env.DATABASE_URL_TEST;
    if (!url) {
        console.warn('\n[tests] DATABASE_URL_TEST is not set: database tests are SKIPPED.\n');
        project.provide('dbReady', false);
        return;
    }
    const dbName = new URL(url).pathname.replace(/^\//, '');
    if (!dbName.endsWith('_test')) {
        throw new Error(`DATABASE_URL_TEST must point at a database whose name ends in "_test" (got "${dbName}"); the tests reset it.`);
    }
    const cwd = path.resolve(__dirname, '../..');
    const env = { ...process.env, DATABASE_URL: url };
    try {
        // Same non-destructive sync as `npm run db:sync`; the tests tolerate data from earlier runs.
        // If a schema change ever needs data loss, drop and recreate the _test database by hand.
        execSync('npx prisma db push --skip-generate', { cwd, env, stdio: 'pipe' });
        execSync('npx prisma db execute --file prisma/sql/finance.sql --schema prisma/schema.prisma', { cwd, env, stdio: 'pipe' });
        project.provide('dbReady', true);
    } catch (error) {
        const out = error as { stdout?: Buffer; stderr?: Buffer };
        const detail = `${out.stdout?.toString() ?? ''}${out.stderr?.toString() ?? ''}`.trim().split('\n').slice(-3).join('\n');
        console.warn(`\n[tests] Could not prepare the test database, database tests are SKIPPED:\n${detail}\n`);
        project.provide('dbReady', false);
    }
}
