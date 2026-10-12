import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';

/**
 * BR-43. Every write to a finance table goes through withAudit(). It opens a transaction and
 * tells the database who is acting (and why); the trigger finance.audit_row() then writes the
 * AuditLog rows inside the same transaction. A write outside withAudit() is refused by the
 * database (errcode P0002), so a change can never skip the audit log.
 */
export type AuditContext = {
    /** User.id of the person acting, or 'system' for seed and background jobs. */
    userId: string;
    /** Why, when the rule asks for one (unlock, ignore, override). */
    reason?: string;
};

export type Tx = Prisma.TransactionClient;

export async function withAudit<T>(
    ctx: AuditContext,
    fn: (tx: Tx) => Promise<T>,
    options: { timeoutMs?: number } = {},
): Promise<T> {
    if (!ctx.userId) throw new Error('withAudit needs a userId');
    return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`select set_config('finance.user_id', ${ctx.userId}, true), set_config('finance.reason', ${ctx.reason ?? ''}, true)`;
        return fn(tx);
    }, { timeout: options.timeoutMs ?? 10_000, maxWait: 10_000 });
}

/** Errcodes raised by prisma/sql/finance.sql. */
export const DB_ERR = {
    noUser: 'P0002',
    noHardDelete: 'P0003',
    auditAppendOnly: 'P0004',
} as const;

/** The Postgres errcode behind a Prisma error, when there is one. */
export function pgCode(err: unknown): string | undefined {
    const text = err instanceof Error ? err.message : String(err);
    return text.match(/P000[2-4]/)?.[0];
}

export class DeleteRefusedError extends Error {
    readonly status = 409;
    constructor(recordType: string) {
        super(`${recordType} records are never deleted. Archive, cancel or reverse them instead, with a note.`);
    }
}

/**
 * The answer to every delete request: refuse it and keep a trace (A9, BR-43).
 * The audit row is written in its own transaction, so it survives the refusal.
 */
export async function refuseDelete(ctx: AuditContext, recordType: string, recordId: string): Promise<never> {
    await prisma.auditLog.create({
        data: {
            recordType,
            recordId,
            action: 'delete_refused',
            reason: ctx.reason ?? null,
            userId: ctx.userId,
        },
    });
    throw new DeleteRefusedError(recordType);
}
