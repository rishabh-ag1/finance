import { Router, Request, Response } from 'express';
import { AuthError, changePassword, loginUser, TOKEN_MAX_AGE_MS } from '../services/auth.service';
import { AUTH_COOKIE, requireAuth } from '../middleware/auth.middleware';

const router = Router();

const COOKIE_OPTIONS = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    maxAge: TOKEN_MAX_AGE_MS,
    path: '/',
};

function publicUser(user: NonNullable<Request['user']>) {
    return {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role ? { id: user.role.id, name: user.role.name, permissions: user.role.permissions } : null,
    };
}

/** POST /api/auth/login - email + password; sets the httpOnly JWT cookie. */
router.post('/login', async (req: Request, res: Response) => {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
        return res.status(400).json({ success: false, error: 'Email and password are required' });
    }
    try {
        const { token, user } = await loginUser(String(email), String(password));
        res.cookie(AUTH_COOKIE, token, COOKIE_OPTIONS);
        return res.status(200).json({ success: true, data: publicUser(user) });
    } catch (error) {
        if (error instanceof AuthError) return res.status(error.status).json({ success: false, error: error.message });
        console.error('Login error:', error);
        return res.status(500).json({ success: false, error: 'Login failed' });
    }
});

/** POST /api/auth/logout */
router.post('/logout', (_req: Request, res: Response) => {
    res.clearCookie(AUTH_COOKIE, { path: '/' });
    return res.status(200).json({ success: true, data: null });
});

/** GET /api/auth/me - restores the session in the frontend. */
router.get('/me', requireAuth, (req: Request, res: Response) => {
    return res.status(200).json({ success: true, data: publicUser(req.user!) });
});

/** POST /api/auth/change-password */
router.post('/change-password', requireAuth, async (req: Request, res: Response) => {
    const { currentPassword, newPassword } = req.body ?? {};
    if (!currentPassword || !newPassword) {
        return res.status(400).json({ success: false, error: 'Current and new password are required' });
    }
    try {
        await changePassword(req.user!.id, String(currentPassword), String(newPassword));
        return res.status(200).json({ success: true, data: null });
    } catch (error) {
        if (error instanceof AuthError) return res.status(error.status).json({ success: false, error: error.message });
        console.error('Change password error:', error);
        return res.status(500).json({ success: false, error: 'Could not change the password' });
    }
});

export default router;
