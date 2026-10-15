import { Router, type Request } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middleware/auth.middleware';
import { handler, parseBody, zDate } from '../lib/http';
import { todayIST } from '../lib/fy';
import * as customers from '../services/customer.service';

// M08 Customers (F080-F082) and M11 Products & price lists (F120, F121).
const router = Router();
const view = requirePermission('financeCustomers', 'view');
const edit = requirePermission('financeCustomers', 'edit');
const ctx = (req: Request, reason?: string | null) => ({ userId: req.user!.id, reason: reason ?? undefined });
const id = (req: Request) => String(req.params.id);
const opt = z.string().nullish();

const profileSchema = z.object({
    paymentTermId: opt, creditLimit: opt, invoiceEmails: z.array(z.string()).optional(), deductsTds: z.boolean().nullish(),
    tdsSectionId: opt, priceListId: opt, channel: opt, billToBranchId: opt, notes: opt,
});

router.get('/customers', view, handler((req) => customers.listCustomers({ q: typeof req.query.q === 'string' ? req.query.q : undefined })));
router.get('/customers/:id', view, handler((req) => customers.getCustomer(id(req))));
router.put('/customers/:id/profile', edit, handler((req) => customers.saveProfile(ctx(req), id(req), null, parseBody(profileSchema, req.body))));
router.put('/customers/:id/outlets/:branchId/profile', edit, handler((req) => customers.saveProfile(ctx(req), id(req), String(req.params.branchId), parseBody(profileSchema, req.body))));

router.get('/products', view, handler(() => customers.listProducts()));
router.get('/products/:id/price', view, handler((req) => customers.linePrice({
    invProductId: id(req), companyId: typeof req.query.companyId === 'string' ? req.query.companyId : null,
    branchId: typeof req.query.branchId === 'string' ? req.query.branchId : null,
    date: typeof req.query.date === 'string' ? req.query.date : todayIST(), qty: Number(req.query.qty ?? 1) || 1,
})));

const listSchema = z.object({ name: z.string().min(2), kind: z.enum(customers.PRICE_LIST_KINDS), taxInclusive: z.boolean(), notes: opt, isActive: z.boolean().optional() });
router.get('/price-lists', view, handler(() => customers.listPriceLists()));
router.get('/price-lists/:id', view, handler((req) => customers.getPriceList(id(req))));
router.post('/price-lists', edit, handler((req) => customers.savePriceList(ctx(req), null, parseBody(listSchema, req.body))));
router.put('/price-lists/:id', edit, handler((req) => customers.savePriceList(ctx(req), id(req), parseBody(listSchema, req.body))));
router.post('/price-lists/:id/prices', edit, handler((req) => customers.addPrice(ctx(req), id(req), parseBody(z.object({
    invProductId: z.string().min(1), price: z.string().min(1), minQty: z.number().int().min(1).optional(), effectiveFrom: zDate,
}), req.body))));
router.post('/price-items/:id/end', edit, handler((req) => customers.endPrice(ctx(req), id(req), parseBody(z.object({ lastDay: zDate }), req.body).lastDay)));
router.post('/price-items/:id/archive', edit, handler((req) => customers.archivePrice(ctx(req, parseBody(z.object({ reason: z.string().min(3) }), req.body).reason), id(req))));

export default router;
