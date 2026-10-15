import type { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { withAudit, type AuditContext } from '../lib/audit';
import { UserError } from '../lib/http';
import { FINANCE_MODULES, type RolePermissions } from '../lib/permissions';
import { hashPassword, MIN_PASSWORD_LENGTH } from './auth.service';

/**
 * F171 users and roles. v1 has the two founders as Admin; other roles (Approver, Finance, Sales,
 * Viewer / CA) are permission sets of view / edit per finance module, kept in Role rows the same
 * way the Bloc CRM does. Users are deactivated, never deleted.
 */

export function modules() {
  return Object.entries(FINANCE_MODULES).map(([key, label]) => ({ key, label }));
}

function cleanPermissions(p: Record<string, { view?: boolean; edit?: boolean }>): RolePermissions {
  const out: RolePermissions = {};
  for (const key of Object.keys(FINANCE_MODULES)) {
    const x = p[key];
    if (!x) continue;
    // Edit without view makes no sense: edit implies view.
    if (x.edit) out[key] = { view: true, edit: true };
    else if (x.view) out[key] = { view: true };
  }
  return out;
}

export async function listRoles() {
  const roles = await prisma.role.findMany({ include: { _count: { select: { users: true } } }, orderBy: { name: 'asc' } });
  return roles.map((r) => ({ id: r.id, name: r.name, description: r.description, permissions: r.permissions as RolePermissions, isActive: r.isActive, users: r._count.users }));
}

export async function saveRole(ctx: AuditContext, id: string | null, input: { name: string; description?: string | null; permissions: Record<string, { view?: boolean; edit?: boolean }>; isActive?: boolean }) {
  const name = input.name.trim().toUpperCase().replace(/\s+/g, '_');
  if (!/^[A-Z][A-Z0-9_]{1,40}$/.test(name)) throw new UserError('Name the role in letters, digits and _ (for example FINANCE_VIEWER)');
  const permissions = cleanPermissions(input.permissions) as Prisma.InputJsonValue;
  if (id) {
    const r = await prisma.role.findUnique({ where: { id }, include: { users: { where: { isActive: true } } } });
    if (!r) throw new UserError('Role not found', 404);
    if (r.users.some((u) => u.id === ctx.userId) && !(input.permissions.financeUsers?.edit)) throw new UserError('You would lose access to Users and roles: keep "Users and roles" editable on your own role');
    if (input.isActive === false && r.users.length) throw new UserError('Move its users to another role before switching the role off');
  }
  await withAudit({ ...ctx, reason: ctx.reason ?? (id ? `Role ${name} changed` : `Role ${name} added`) }, (tx) => id
    ? tx.role.update({ where: { id }, data: { name, description: input.description?.trim() || null, permissions, isActive: input.isActive ?? true } })
    : tx.role.create({ data: { name, description: input.description?.trim() || null, permissions } }));
  return listRoles();
}

export async function listUsers() {
  const users = await prisma.user.findMany({ include: { role: true }, orderBy: [{ isActive: 'desc' }, { firstName: 'asc' }] });
  return users.map((u) => ({ id: u.id, email: u.email, firstName: u.firstName, lastName: u.lastName, roleId: u.roleId, roleName: u.role?.name ?? null, isActive: u.isActive, lastLoginAt: u.lastLoginAt, locked: !!u.lockedUntil && u.lockedUntil > new Date() }));
}

export async function createUser(ctx: AuditContext, input: { email: string; firstName: string; lastName: string; roleId: string; password: string }) {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new UserError('Enter a valid e-mail');
  if (!input.firstName.trim()) throw new UserError('Enter the first name');
  if (input.password.length < MIN_PASSWORD_LENGTH) throw new UserError(`The first password needs at least ${MIN_PASSWORD_LENGTH} characters; ask them to change it after signing in`);
  const role = await prisma.role.findUnique({ where: { id: input.roleId } });
  if (!role || !role.isActive) throw new UserError('Choose a role');
  if (await prisma.user.findUnique({ where: { email } })) throw new UserError('Someone already signs in with this e-mail');
  const passwordHash = await hashPassword(input.password);
  await withAudit({ ...ctx, reason: ctx.reason ?? `User ${email} added` }, (tx) => tx.user.create({ data: { email, firstName: input.firstName.trim(), lastName: input.lastName.trim(), roleId: role.id, passwordHash } }));
  return listUsers();
}

export async function updateUser(ctx: AuditContext, id: string, input: { roleId?: string; isActive?: boolean }) {
  const u = await prisma.user.findUnique({ where: { id } });
  if (!u) throw new UserError('User not found', 404);
  if (id === ctx.userId && (input.isActive === false || (input.roleId && input.roleId !== u.roleId))) throw new UserError('You cannot switch off or change your own access; ask the other admin');
  if (input.roleId) {
    const role = await prisma.role.findUnique({ where: { id: input.roleId } });
    if (!role || !role.isActive) throw new UserError('Choose a role');
  }
  await withAudit({ ...ctx, reason: ctx.reason ?? (input.isActive === false ? `User ${u.email} switched off` : `User ${u.email} changed`) }, (tx) => tx.user.update({
    where: { id }, data: { ...(input.roleId ? { roleId: input.roleId } : {}), ...(input.isActive !== undefined ? { isActive: input.isActive } : {}) },
  }));
  return listUsers();
}
