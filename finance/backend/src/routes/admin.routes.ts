import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middleware/auth.middleware';
import { handler, parseBody } from '../lib/http';
import * as users from '../services/users.service';
import * as caPack from '../services/caPack.service';
import * as alerts from '../services/alerts.service';
import * as recon from '../services/recon.service';

// F171 users and roles, F180 / F181 CA pack, F173 alerts, D36 / D37 order-to-bank dashboards.
const router = Router();
const usersView = requirePermission('financeUsers', 'view');
const usersEdit = requirePermission('financeUsers', 'edit');
const caView = requirePermission('financeCaPack', 'view');
const ordersView = requirePermission('financeOrders', 'view');
const ctx = (req: Request) => ({ userId: req.user!.id });
const id = (req: Request) => String(req.params.id);
const perms = z.record(z.string(), z.object({ view: z.boolean().optional(), edit: z.boolean().optional() }));

router.get('/users', usersView, handler(() => users.listUsers()));
router.post('/users', usersEdit, handler((req) => users.createUser(ctx(req), parseBody(z.object({ email: z.string(), firstName: z.string(), lastName: z.string(), roleId: z.string(), password: z.string() }), req.body))));
router.put('/users/:id', usersEdit, handler((req) => users.updateUser(ctx(req), id(req), parseBody(z.object({ roleId: z.string().optional(), isActive: z.boolean().optional() }), req.body))));
router.get('/roles', usersView, handler(async () => ({ roles: await users.listRoles(), modules: users.modules() })));
router.post('/roles', usersEdit, handler((req) => users.saveRole(ctx(req), null, parseBody(z.object({ name: z.string(), description: z.string().nullish(), permissions: perms }), req.body))));
router.put('/roles/:id', usersEdit, handler((req) => users.saveRole(ctx(req), id(req), parseBody(z.object({ name: z.string(), description: z.string().nullish(), permissions: perms, isActive: z.boolean().optional() }), req.body))));

router.get('/ca-pack', caView, handler((req) => caPack.caPackSummary(String(req.query.month))));
router.get('/ca-pack/download', caView, async (req: Request, res: Response, next) => {
    try {
        const f = await caPack.caPackWorkbook(String(req.query.month));
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${f.fileName.replace(/[^\w .-]/g, '_')}"`);
        res.send(f.buffer);
    } catch (e) { next(e); }
});

router.get('/alerts', handler((req) => alerts.alertsFor(req.user!)));

router.get('/recon/funnel', ordersView, handler((req) => recon.orderFunnel(String(req.query.from), String(req.query.to))));

export default router;
