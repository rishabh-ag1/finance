import { defineConfig } from 'vitest/config';
import dotenv from 'dotenv';
import os from 'node:os';
import path from 'node:path';

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
        // Setup hooks seed and import the fixture into a test database that grows run after run.
        hookTimeout: 60000,
        env: {
            DATABASE_URL: testDb,
            JWT_SECRET: 'test-only-secret-not-used-anywhere-else',
            NODE_ENV: 'test',
            // Attachments written by tests go to a temp folder, never the real file store.
            FILE_STORAGE: 'local',
            FILE_STORAGE_DIR: path.join(os.tmpdir(), 'entelechy-finance-test-files'),
        },
    },
});
