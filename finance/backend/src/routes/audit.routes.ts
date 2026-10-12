import { Router, Request, Response } from 'express';
import { requirePermission } from '../middleware/auth.middleware';
import { listAudit } from '../services/audit.service';

const router = Router();

/**
 * GET /api/audit?recordType=&recordId=&userId=&action=&before=<id>&limit=
 * Newest first; page with `before` = the last id of the previous page (F172).
 */
router.get('/', requirePermission('financeAudit', 'view'), async (req: Request, res: Response) => {
    try {
        const q = req.query as Record<string, string | undefined>;
        const data = await listAudit({
            recordType: q.recordType || undefined,
            recordId: q.recordId || undefined,
            userId: q.userId || undefined,
            action: q.action || undefined,
            before: q.before || undefined,
            limit: q.limit ? Number(q.limit) : undefined,
        });
        return res.json({ success: true, data });
    } catch (error) {
        console.error('Audit list error:', error);
        return res.status(500).json({ success: false, error: 'Could not load the audit log' });
    }
});

export default router;
