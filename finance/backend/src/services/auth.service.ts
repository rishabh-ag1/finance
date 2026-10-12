import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { prisma } from '../config/database';
import { withAudit } from '../lib/audit';

// Same login as Bloc's crm/backend/src/services/auth.service.ts (bcrypt + JWT in an httpOnly
// cookie), plus the lockout that Bloc's User columns were made for.
const BCRYPT_ROUNDS = 12;
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const TOKEN_DAYS = 30;
export const MIN_PASSWORD_LENGTH = 10;

export type TokenPayload = {
    userId: string;
    roleId: string | null;
};

export type AuthUser = {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    roleId: string | null;
    role: {
        id: string;
        name: string;
        permissions: unknown;
    } | null;
};

export class AuthError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
    }
}

export async function hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
}

function jwtSecret(): string {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET not configured');
    return secret;
}

export const TOKEN_MAX_AGE_MS = TOKEN_DAYS * 24 * 60 * 60 * 1000;

export function generateToken(userId: string, roleId: string | null): string {
    const payload: TokenPayload = { userId, roleId };
    return jwt.sign(payload, jwtSecret(), { expiresIn: `${TOKEN_DAYS}d` });
}

export function verifyToken(token: string): TokenPayload {
    return jwt.verify(token, jwtSecret()) as TokenPayload;
}

const roleSelect = { select: { id: true, name: true, permissions: true } } as const;

function toAuthUser(user: {
    id: string; firstName: string; lastName: string; email: string; roleId: string | null;
    role: AuthUser['role'];
}): AuthUser {
    return {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        roleId: user.roleId,
        role: user.role,
    };
}

/**
 * Email + password login with lockout: 5 wrong passwords lock the account for 15 minutes.
 * The error never says whether the email exists.
 */
export async function loginUser(email: string, password: string): Promise<{ token: string; user: AuthUser }> {
    const GENERIC_ERROR = 'Invalid email or password';
    const user = await prisma.user.findUnique({
        where: { email: email.toLowerCase().trim() },
        include: { role: roleSelect },
    });

    if (!user) throw new AuthError(GENERIC_ERROR, 401);
    if (!user.isActive) throw new AuthError('Account is deactivated. Contact your administrator.', 403);
    if (!user.passwordHash) throw new AuthError('Account not fully set up. Contact your administrator.', 403);
    if (user.lockedUntil && user.lockedUntil > new Date()) {
        throw new AuthError('Too many wrong passwords. The account is locked for a few minutes; try again later.', 429);
    }

    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) {
        const attempts = user.failedLoginAttempts + 1;
        await withAudit({ userId: user.id, reason: 'failed login' }, (tx) =>
            tx.user.update({
                where: { id: user.id },
                data: attempts >= MAX_FAILED_ATTEMPTS
                    ? { failedLoginAttempts: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60 * 1000) }
                    : { failedLoginAttempts: attempts },
            }),
        );
        throw new AuthError(GENERIC_ERROR, 401);
    }

    await withAudit({ userId: user.id, reason: 'login' }, (tx) =>
        tx.user.update({
            where: { id: user.id },
            data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
        }),
    );

    return { token: generateToken(user.id, user.roleId), user: toAuthUser(user) };
}

export async function getUserById(userId: string): Promise<AuthUser | null> {
    const user = await prisma.user.findUnique({
        where: { id: userId, isActive: true },
        include: { role: roleSelect },
    });
    return user ? toAuthUser(user) : null;
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
        throw new AuthError(`The new password needs at least ${MIN_PASSWORD_LENGTH} characters.`, 400);
    }
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.passwordHash || !(await verifyPassword(currentPassword, user.passwordHash))) {
        throw new AuthError('The current password is not right.', 400);
    }
    const passwordHash = await hashPassword(newPassword);
    await withAudit({ userId, reason: 'password changed by the user' }, (tx) =>
        tx.user.update({ where: { id: userId }, data: { passwordHash } }),
    );
}
