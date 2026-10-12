/** True when the run has a test database (see vitest.config.ts). DB suites use describe.skipIf(!hasDb). */
export const hasDb = Boolean(process.env.DATABASE_URL);

let counter = 0;
/** A unique email per test, so suites never collide on the unique index. */
export function uniqueEmail(prefix = 'user'): string {
    counter += 1;
    return `${prefix}.${Date.now()}.${counter}@blocinsects.com`;
}
