import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import authRoutes from './routes/auth.routes';
import auditRoutes from './routes/audit.routes';
import { requireAuth } from './middleware/auth.middleware';
import settingsRoutes from './routes/settings.routes';
import categoryRoutes from './routes/category.routes';
import bankRoutes from './routes/bank.routes';
import vendorRoutes from './routes/vendor.routes';
import attachmentRoutes from './routes/attachment.routes';
import dashboardRoutes from './routes/dashboard.routes';
import { DeleteRefusedError, refuseDelete } from './lib/audit';
import { UserError } from './lib/http';

/** Built separately from index.ts so tests can call the API without opening a port. */
export function createApp() {
    const app = express();

    app.use(cors({
        origin: [process.env.FRONTEND_URL || 'http://localhost:5174'],
        credentials: true,
    }));
    app.use(cookieParser());
    // Statements and attachments travel as base64 inside JSON: 15 MB files need about 20 MB.
    app.use(express.json({ limit: '25mb' }));

    // ============================
    // PUBLIC ROUTES
    // ============================
    app.get('/api/health', (_req, res) => { res.json({ success: true, data: { ok: true } }); });
    app.use('/api/auth', authRoutes);

    // ============================
    // PROTECTED ROUTES
    // ============================
    app.use('/api', requireAuth);
    app.use('/api/audit', auditRoutes);
    app.use('/api/settings', settingsRoutes);
    app.use('/api/categories', categoryRoutes);
    app.use('/api/bank', bankRoutes);
    app.use('/api/vendors', vendorRoutes);
    app.use('/api/attachments', attachmentRoutes);
    app.use('/api/dashboard', dashboardRoutes);

    // No hard deletes anywhere (BR-43, A9): every DELETE is refused and leaves an audit row.
    app.delete('/api/:resource/:id', async (req: Request, res: Response, next: NextFunction) => {
        try {
            const resource = String(req.params.resource);
            const id = String(req.params.id);
            await refuseDelete({ userId: req.user!.id }, resource, id);
        } catch (error) {
            next(error);
        }
    });

    app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
        if (error instanceof DeleteRefusedError || error instanceof UserError) {
            res.status(error.status).json({ success: false, error: error.message });
            return;
        }
        console.error('Unhandled error:', error);
        res.status(500).json({ success: false, error: 'Something went wrong' });
    });

    return app;
}
