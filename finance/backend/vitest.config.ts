import { defineConfig } from 'vitest/config';
import dotenv from 'dotenv';

dotenv.config();

// DB tests run against DATABASE_URL_TEST only (never the dev database). Its name must end in
// "_test" so test data can never land in the real database.
const testDb = process.env.DATABASE_URL_TEST ?? '';

export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        globalSetup: ['tests/setup/global-db.ts'],
        fileParallelism: false,
        testTimeout: 20000,
        env: {
            DATABASE_URL: testDb,
            JWT_SECRET: 'test-only-secret-not-used-anywhere-else',
            NODE_ENV: 'test',
        },
    },
});
