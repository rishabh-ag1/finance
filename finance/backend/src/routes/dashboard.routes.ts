import { Router } from 'express';
import { requirePermission } from '../middleware/auth.middleware';
import { handler } from '../lib/http';
import * as dashboard from '../services/dashboard.service';

// F130 home, F131 category analytics (cash / accrual), F132 payables, F136 13-week forecast (M12).
const router = Router();
const view = requirePermission('financeHome', 'view');
const dateParam = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);

router.get('/home', view, handler((req) => dashboard.home({ asOf: dateParam(req.query.asOf) })));
router.get('/categories', view, handler((req) => dashboard.categoryPivot({
    fy: typeof req.query.fy === 'string' ? req.query.fy : undefined,
    kind: ['expense', 'income', 'capex'].includes(String(req.query.kind)) ? req.query.kind as 'expense' : 'expense',
    view: req.query.view === 'accrual' ? 'accrual' : 'cash',
})));
router.get('/spend-by-category', view, handler((req) => dashboard.spendByCategory({
    period: ['month', '3m', 'fy'].includes(String(req.query.period)) ? req.query.period as 'month' : '3m',
    view: req.query.view === 'accrual' ? 'accrual' : 'cash',
})));
router.get('/payables', requirePermission('financePayments', 'view'), handler((req) => dashboard.payables({ fy: typeof req.query.fy === 'string' ? req.query.fy : undefined })));
router.get('/forecast', view, handler((req) => dashboard.forecast({ asOf: dateParam(req.query.asOf) })));

export default router;
