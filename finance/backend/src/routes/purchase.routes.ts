import { Router, type Request } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middleware/auth.middleware';
import { handler, parseBody, zDate } from '../lib/http';
import * as po from '../services/po.service';

// M04 Purchase orders (F040-F048), delivery addresses and the purchase catalogue.
const router = Router();
const view = requirePermission('financePurchases', 'view');
const edit = requirePermission('financePurchases', 'edit');
const ctx = (req: Request, reason?: string | null) => ({ userId: req.user!.id, reason: reason ?? undefined });
const id = (req: Request) => String(req.params.id);
const opt = z.string().nullish();
const qtyText = z.string().regex(/^[\d,]{1,12}(\.\d{1,3})?$/, 'must be a quantity like 2 or 1.5');
const rateText = z.string().regex(/^[\d,]{1,12}(\.\d{1,4})?$/, 'must be a rate like 1200.50');
const reasonBody = z.object({ reason: z.string().min(3, 'give a reason') });

const lineSchema = z.object({
    purchaseItemId: opt,
    description: z.string().min(1, 'describe the item'),
    hsnSac: opt,
    qty: qtyText,
    unit: opt.transform((v) => v ?? undefined),
    rate: rateText,
    discount: z.string().regex(/^[\d,]{0,12}(\.\d{1,2})?$/, 'must be an amount').optional(),
    gstRate: z.string().regex(/^\d{1,2}(\.\d{1,2})?$/, 'must be a GST rate like 18'),
});
const poSchema = z.object({
    vendorId: z.string().min(1, 'choose a vendor'),
    poDate: zDate,
    expectedDeliveryDate: zDate.nullish().or(z.literal('')),
    deliveryAddressId: opt,
    deliveryAddress: opt,
    placeOfSupplyState: opt,
    quoteRef: opt,
    paymentTermId: opt,
    paymentTermsText: opt,
    milestones: z.array(z.object({ label: z.string(), percent: z.string() })).optional(),
    termsText: opt,
    notes: opt,
    lines: z.array(lineSchema).min(1, 'add at least one line'),
});

// ---------- Delivery addresses and catalogue ----------
const addressSchema = z.object({ label: z.string().min(2), address: z.string().min(5), stateCode: z.string().length(2), isActive: z.boolean().optional() });
router.get('/delivery-addresses', view, handler(() => po.listDeliveryAddresses()));
router.post('/delivery-addresses', edit, handler((req) => po.saveDeliveryAddress(ctx(req), null, parseBody(addressSchema, req.body))));
router.put('/delivery-addresses/:id', edit, handler((req) => po.saveDeliveryAddress(ctx(req), id(req), parseBody(addressSchema, req.body))));

const itemSchema = z.object({
    name: z.string().min(2), hsnSac: opt, unit: z.string().optional(),
    defaultGstRate: z.string().regex(/^\d{1,2}(\.\d{1,2})?$/).nullish().or(z.literal('')), preferredVendorId: opt, isArchived: z.boolean().optional(),
});
router.get('/items', view, handler((req) => po.listPurchaseItems(typeof req.query.q === 'string' ? req.query.q : undefined)));
router.post('/items', edit, handler((req) => po.savePurchaseItem(ctx(req), null, parseBody(itemSchema, req.body))));
router.put('/items/:id', edit, handler((req) => po.savePurchaseItem(ctx(req), id(req), parseBody(itemSchema, req.body))));

// ---------- Purchase orders ----------
router.get('/pos', view, handler((req) => po.listPos({
    status: typeof req.query.status === 'string' ? req.query.status : undefined,
    vendorId: typeof req.query.vendorId === 'string' ? req.query.vendorId : undefined,
    q: typeof req.query.q === 'string' ? req.query.q : undefined,
    open: req.query.open === '1',
})));
router.get('/pos/:id', view, handler((req) => po.getPo(id(req))));
router.post('/pos/preview', view, handler((req) => po.previewPo(parseBody(poSchema, req.body))));
router.post('/pos', edit, handler((req) => po.createDraft(ctx(req), parseBody(poSchema, req.body))));
router.put('/pos/:id', edit, handler((req) => po.updateDraft(ctx(req), id(req), parseBody(poSchema, req.body))));
router.post('/pos/:id/issue', edit, handler((req) => po.issue(ctx(req), id(req))));
router.post('/pos/:id/approve', edit, handler((req) => po.approve(ctx(req), id(req))));
router.post('/pos/:id/reject', edit, handler((req) => po.reject(ctx(req, parseBody(reasonBody, req.body).reason), id(req))));
router.post('/pos/:id/sent', edit, handler((req) => po.markSent(ctx(req), id(req), parseBody(z.object({ via: z.enum(['email', 'whatsapp', 'download', 'other']) }), req.body).via)));
router.post('/pos/:id/close', edit, handler((req) => po.close(ctx(req, parseBody(reasonBody, req.body).reason), id(req))));
router.post('/pos/:id/cancel', edit, handler((req) => po.cancel(ctx(req, parseBody(reasonBody, req.body).reason), id(req))));
router.post('/pos/:id/amend', edit, handler((req) => {
    const body = parseBody(poSchema.extend({ reason: z.string().min(3, 'say what changed and why') }), req.body);
    return po.amend(ctx(req, body.reason), id(req), body);
}));
router.post('/pos/:id/print', edit, handler(async (req) => { await po.printPdf(ctx(req), id(req)); return po.getPo(id(req)); }));

export default router;
