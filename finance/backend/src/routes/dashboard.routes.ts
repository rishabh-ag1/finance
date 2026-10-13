import { Router } from 'express';
import { requirePermission } from '../middleware/auth.middleware';
import { handler } from '../lib/http';
import * as dashboard from '../services/dashboard.service';

// F130 home and F131 category analytics (M12, Phase 1 slice).
const router = Router();
const view = requirePermission('financeHome', 'view');
const dateParam = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);

router.get('/home', view, handler((req) => dashboard.home({ asOf: dateParam(req.query.asOf) })));
router.get('/categories', view, handler((req) => dashboard.categoryPivot({
    fy: typeof req.query.fy === 'string' ? req.query.fy : undefined,
    kind: ['expense', 'income', 'capex'].includes(String(req.query.kind)) ? req.query.kind as 'expense' : 'expense',
})));

export default router;
