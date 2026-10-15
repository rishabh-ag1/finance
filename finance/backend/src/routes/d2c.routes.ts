import { Router, type Request } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middleware/auth.middleware';
import { handler, parseBody, zDate } from '../lib/http';
import * as d2c from '../services/d2c.service';
import * as crmApi from '../services/crmApi.service';
import * as refill from '../services/refill.service';

// F102 / F103 D2C invoicing and its fix-list, F099 refill plans, F105 CRM API keys and call log.
const router = Router();
const view = requirePermission('financeSales', 'view');
const edit = requirePermission('financeSales', 'edit');
const settingsView = requirePermission('financeSettings', 'view');
const settingsEdit = requirePermission('financeSettings', 'edit');
const ctx = (req: Request, reason?: string | null) => ({ userId: req.user!.id, reason: reason ?? undefined });
const opt = z.string().nullish();

router.get('/d2c', view, handler(() => d2c.d2cOverview()));
router.put('/d2c/setting', settingsEdit, handler((req) => d2c.saveD2cSetting(ctx(req), parseBody(z.object({ isOn: z.boolean(), startFrom: zDate.nullish() }), req.body) as { isOn: boolean; startFrom: string | null })));
router.post('/d2c/run', edit, handler((req) => d2c.runD2cBatch(ctx(req, 'D2C batch run by hand'))));
router.post('/d2c/orders/:orderNumber/retry', edit, handler((req) => d2c.retryOrder(ctx(req, 'D2C order tried again'), String(req.params.orderNumber))));

// A draft from a CRM order, priced as the order (B2B orders and one-offs the batch does not handle).
router.post('/sales/from-order', edit, handler(async (req) => {
    const b = parseBody(z.object({ orderNumber: z.string().min(1), docType: z.enum(['proforma', 'tax_invoice']), docDate: zDate.nullish() }), req.body);
    return (await d2c.draftFromOrder(ctx(req), { ...b, source: 'manual' })).doc;
}));

router.get('/refills', view, handler((req) => refill.listPlans({ companyId: typeof req.query.companyId === 'string' ? req.query.companyId : undefined })));
const plan = z.object({
    crmCompanyId: z.string().min(1), crmBranchId: z.string().min(1), invProductId: z.string().min(1), qty: z.string(), rate: opt,
    everyMonths: z.number().int(), nextDate: zDate, isActive: z.boolean().optional(), notes: opt,
});
router.post('/refills', edit, handler((req) => refill.savePlan(ctx(req), null, parseBody(plan, req.body))));
router.put('/refills/:id', edit, handler((req) => refill.savePlan(ctx(req), String(req.params.id), parseBody(plan, req.body))));
router.post('/refills/draft-due', edit, handler((req) => refill.draftDueRefills(ctx(req))));

router.get('/crm-api/keys', settingsView, handler(() => crmApi.listKeys()));
router.post('/crm-api/keys', settingsEdit, handler((req) => crmApi.createKey(ctx(req), parseBody(z.object({ name: z.string() }), req.body).name)));
router.post('/crm-api/keys/:id/revoke', settingsEdit, handler((req) => crmApi.revokeKey(ctx(req, parseBody(z.object({ reason: z.string().min(3, 'give a reason') }), req.body).reason), String(req.params.id))));
router.get('/crm-api/calls', settingsView, handler((req) => crmApi.listCalls({ orderNumber: typeof req.query.orderNumber === 'string' ? req.query.orderNumber : undefined })));

export default router;
