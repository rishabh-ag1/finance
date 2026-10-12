import { AuditAction, Prisma } from '@prisma/client';
import { prisma } from '../config/database';

export type AuditFilter = {
    recordType?: string;
    recordId?: string;
    userId?: string;
    action?: string;
    /** Return rows older than this id (keyset paging). */
    before?: string;
    limit?: number;
};

export type AuditRow = {
    id: string;
    recordType: string;
    recordId: string;
    action: AuditAction;
    field: string | null;
    oldValue: Prisma.JsonValue;
    newValue: Prisma.JsonValue;
    reason: string | null;
    userId: string;
    userName: string;
    at: Date;
};

const ACTIONS = new Set<string>(Object.values(AuditAction));

export async function listAudit(f: AuditFilter): Promise<{ rows: AuditRow[]; nextBefore: string | null }> {
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
    const where: Prisma.AuditLogWhereInput = {
        ...(f.recordType && { recordType: f.recordType }),
        ...(f.recordId && { recordId: f.recordId }),
        ...(f.userId && { userId: f.userId }),
        ...(f.action && ACTIONS.has(f.action) && { action: f.action as AuditAction }),
        ...(f.before && /^\d+$/.test(f.before) && { id: { lt: BigInt(f.before) } }),
    };
    const rows = await prisma.auditLog.findMany({ where, orderBy: { id: 'desc' }, take: limit + 1 });
    const page = rows.slice(0, limit);

    const userIds = [...new Set(page.map((r) => r.userId))];
    const users = await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, firstName: true, lastName: true },
    });
    const names = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`]));

    return {
        rows: page.map((r) => ({
            ...r,
            id: r.id.toString(),
            userName: names.get(r.userId) ?? (r.userId === 'system' ? 'System' : r.userId),
        })),
        nextBefore: rows.length > limit ? page[page.length - 1].id.toString() : null,
    };
}
