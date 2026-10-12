import { execSync } from 'node:child_process';
import path from 'node:path';

/**
 * Before the test run: rebuild the test database from prisma/schema.prisma and
 * prisma/sql/finance.sql, exactly as `npm run db:sync` does for the real one.
 * Skipped (DB tests then skip themselves) when DATABASE_URL_TEST is not set.
 */
export default function setup(): void {
    const url = process.env.DATABASE_URL_TEST;
    if (!url) {
        console.warn('\n[tests] DATABASE_URL_TEST is not set: database tests are skipped.\n');
        return;
    }
    const dbName = new URL(url).pathname.replace(/^\//, '');
    if (!dbName.endsWith('_test')) {
        throw new Error(`DATABASE_URL_TEST must point at a database whose name ends in "_test" (got "${dbName}"); the tests reset it.`);
    }
    const cwd = path.resolve(__dirname, '../..');
    const env = { ...process.env, DATABASE_URL: url };
    execSync('npx prisma db push --force-reset --skip-generate', { cwd, env, stdio: 'inherit' });
    execSync('npx prisma db execute --file prisma/sql/finance.sql --schema prisma/schema.prisma', { cwd, env, stdio: 'inherit' });
}
