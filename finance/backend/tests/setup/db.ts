import { inject } from 'vitest';

/** True when global-db.ts rebuilt the test database. DB suites use describe.skipIf(!hasDb). */
export const hasDb = inject('dbReady');

let counter = 0;
/** A unique email per test, so suites never collide on the unique index. */
export function uniqueEmail(prefix = 'user'): string {
    counter += 1;
    return `${prefix}.${Date.now()}.${counter}@blocinsects.com`;
}
