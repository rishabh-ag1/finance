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
import purchaseRoutes from './routes/purchase.routes';
import billRoutes from './routes/bill.routes';
import paymentRoutes from './routes/payment.routes';
import tdsRoutes from './routes/tds.routes';
import claimRoutes from './routes/claim.routes';
import reconRoutes from './routes/recon.routes';
import customerRoutes from './routes/customer.routes';
import salesRoutes from './routes/sales.routes';
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
    app.use('/api/purchases', purchaseRoutes);
    app.use('/api/bills', billRoutes);
    app.use('/api/payments', paymentRoutes);
    app.use('/api/tds', tdsRoutes);
    app.use('/api/claims', claimRoutes);
    app.use('/api/recon', reconRoutes);
    app.use('/api', customerRoutes);
    app.use('/api', salesRoutes);

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
        // Rules enforced by the database (prisma/sql/finance.sql) explain themselves: show that text.
        const ruleMessage = (error instanceof Error ? error.message : String(error)).match(/finance: ([^"\\\n]+)/)?.[1];
        if (ruleMessage) {
            res.status(409).json({ success: false, error: ruleMessage.charAt(0).toUpperCase() + ruleMessage.slice(1) });
            return;
        }
        // A unique key in the database refused a second copy of something.
        if ((error as { code?: string })?.code === 'P2002') {
            res.status(409).json({ success: false, error: 'This is already recorded (same number or key). Check the existing entry.' });
            return;
        }
        console.error('Unhandled error:', error);
        res.status(500).json({ success: false, error: 'Something went wrong' });
    });

    return app;
}
