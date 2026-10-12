import type { TxnNature } from '@prisma/client';
import { prisma } from '../config/database';
import { withAudit, type AuditContext } from '../lib/audit';
import { UserError } from '../lib/http';
import { NATURE_LABELS, resolveNature } from '../lib/nature';

/**
 * Categories and sub-categories (Category Master, BR-04). The nature set here is what new bank
 * rows inherit; a row keeps the nature it was given, so changing a category later does not
 * rewrite history (the change is in the audit log).
 */

export async function listCategories(includeInactive = true) {
    const rows = await prisma.category.findMany({
        where: includeInactive ? {} : { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        include: { subCategories: { orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], ...(includeInactive ? {} : { where: { isActive: true } }) } },
    });
    return rows.map((c) => ({
        id: c.id,
        name: c.name,
        natureDefault: c.natureDefault,
        isActive: c.isActive,
        subCategories: c.subCategories.map((s) => ({
            id: s.id,
            name: s.name,
            natureOverride: s.natureOverride,
            nature: resolveNature(c, s),
            plGroup: s.plGroup,
            note: s.note,
            isActive: s.isActive,
        })),
    }));
}

export function natureOptions() {
    return Object.entries(NATURE_LABELS).map(([value, label]) => ({ value: value as TxnNature, label }));
}

export async function saveCategory(ctx: AuditContext, id: string | null, input: { name: string; natureDefault: TxnNature; isActive: boolean }) {
    const name = input.name.trim();
    if (!name) throw new UserError('Give the category a name');
    const clash = await prisma.category.findUnique({ where: { name } });
    if (clash && clash.id !== id) throw new UserError('A category with this name exists');
    await withAudit(ctx, async (tx) => {
        if (id) {
            await tx.category.update({ where: { id }, data: { name, natureDefault: input.natureDefault, isActive: input.isActive } });
        } else {
            const last = await tx.category.aggregate({ _max: { sortOrder: true } });
            await tx.category.create({ data: { name, natureDefault: input.natureDefault, isActive: input.isActive, sortOrder: (last._max.sortOrder ?? 0) + 10 } });
        }
    });
    return listCategories();
}

export async function saveSubCategory(
    ctx: AuditContext,
    id: string | null,
    input: { categoryId: string; name: string; nature: TxnNature; plGroup?: string | null; note?: string | null; isActive: boolean },
) {
    const name = input.name.trim();
    if (!name) throw new UserError('Give the sub-category a name');
    const category = await prisma.category.findUnique({ where: { id: input.categoryId } });
    if (!category) throw new UserError('Category not found', 404);
    const clash = await prisma.subCategory.findUnique({ where: { categoryId_name: { categoryId: category.id, name } } });
    if (clash && clash.id !== id) throw new UserError('This category already has a sub-category with that name');
    const data = {
        categoryId: category.id,
        name,
        // Stored as an override only when it differs from the category's default.
        natureOverride: input.nature === category.natureDefault ? null : input.nature,
        plGroup: input.plGroup?.trim() || null,
        note: input.note?.trim() || null,
        isActive: input.isActive,
    };
    await withAudit(ctx, async (tx) => {
        if (id) await tx.subCategory.update({ where: { id }, data });
        else await tx.subCategory.create({ data: { ...data, sortOrder: 1000 } });
    });
    return listCategories();
}
