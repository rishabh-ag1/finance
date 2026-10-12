import type { Request, Response, NextFunction } from 'express';
import { verifyToken, getUserById, type AuthUser } from '../services/auth.service';

// Same pattern as Bloc's crm/backend/src/middleware/auth.middleware.ts.

declare global {
    namespace Express {
        interface Request {
            user?: AuthUser;
        }
    }
}

/**
 * Separate from the CRM's "auth_token" because both apps run on localhost in development and
 * cookies are not port specific. Becomes the shared cookie when the apps are merged.
 */
export const AUTH_COOKIE = 'finance_auth_token';

/** Reads the JWT from the httpOnly cookie and attaches the user. 401 when missing or invalid. */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
        const token = req.cookies?.[AUTH_COOKIE];
        if (!token) {
            res.status(401).json({ success: false, error: 'Authentication required' });
            return;
        }

        let payload;
        try {
            payload = verifyToken(token);
        } catch {
            res.clearCookie(AUTH_COOKIE, { path: '/' });
            res.status(401).json({ success: false, error: 'Session expired. Please log in again.' });
            return;
        }

        const user = await getUserById(payload.userId);
        if (!user) {
            res.clearCookie(AUTH_COOKIE, { path: '/' });
            res.status(401).json({ success: false, error: 'User not found or deactivated.' });
            return;
        }

        req.user = user;
        next();
    } catch (error) {
        console.error('Auth middleware error:', error);
        res.status(500).json({ success: false, error: 'Authentication service error' });
    }
}

/** Checks the role's permission for a finance module and action. Use after requireAuth. */
export function requirePermission(module: string, action: 'view' | 'edit') {
    return (req: Request, res: Response, next: NextFunction): void => {
        const permissions = req.user?.role?.permissions as Record<string, Record<string, boolean>> | null | undefined;
        if (!req.user) {
            res.status(401).json({ success: false, error: 'Authentication required' });
            return;
        }
        if (permissions?.[module]?.[action] !== true) {
            res.status(403).json({ success: false, error: `Access denied: insufficient permission for ${module}.${action}` });
            return;
        }
        next();
    };
}
