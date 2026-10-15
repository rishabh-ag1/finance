import { Router, type Request } from 'express';
import { z } from 'zod';
import * as vendorLedger from '../services/vendorLedger.service';
import { requirePermission } from '../middleware/auth.middleware';
import { handler, parseBody, zDate, zMoney } from '../lib/http';
import { refuseDelete } from '../lib/audit';
import * as vendors from '../services/vendor.service';
import * as lookup from '../services/lookup.service';

const router = Router();
const view = requirePermission('financeVendors', 'view');
const edit = requirePermission('financeVendors', 'edit');
const ctx = (req: Request, reason?: string | null) => ({ userId: req.user!.id, reason: reason ?? undefined });
const id = (req: Request) => String(req.params.id);
const opt = z.string().nullish();
const optMoney = zMoney.nullish().or(z.literal(''));
const optDate = zDate.nullish().or(z.literal(''));

const vendorSchema = z.object({
    displayName: z.string().min(2, 'give the vendor a name'),
    legalName: opt,
    tradeName: opt,
    vendorType: z.enum(['goods', 'services', 'both']),
    gstin: opt,
    pan: opt,
    addressLine1: opt,
    addressLine2: opt,
    city: opt,
    state: opt,
    pincode: opt,
    contactName: opt,
    phone: opt,
    email: opt,
    defaultTdsSectionId: opt,
    ldcNumber: opt,
    ldcRate: opt,
    ldcValidFrom: optDate,
    ldcValidTo: optDate,
    ldcLimit: optMoney,
    msmeType: z.enum(['micro', 'small', 'medium', 'none']).optional(),
    udyamNo: opt,
    defaultCategoryId: opt,
    defaultSubCategoryId: opt,
    paymentTermId: opt,
    bankNames: z.array(z.string()).optional(),
    notes: opt,
});

// ---------- Lookups (I11-I13) ----------
router.get('/lookup/gstin/:gstin', view, handler((req) => lookup.lookupGstin(ctx(req), String(req.params.gstin), req.query.refresh === '1')));
router.get('/lookup/ifsc/:ifsc', view, handler((req) => lookup.lookupIfsc(String(req.params.ifsc))));
router.get('/lookup/pincode/:pin', view, handler((req) => lookup.lookupPincode(String(req.params.pin))));

// ---------- Vendors (F030-F038) ----------
router.get('/', view, handler((req) => vendors.listVendors({
    q: typeof req.query.q === 'string' ? req.query.q : undefined,
    status: typeof req.query.status === 'string' && req.query.status ? req.query.status as 'draft' : undefined,
    includeArchived: req.query.archived === '1',
})));
router.post('/', edit, handler((req) => vendors.createVendor(ctx(req), parseBody(vendorSchema.extend({ activate: z.boolean().optional() }), req.body))));
router.get('/:id', view, handler((req) => vendors.getVendor(id(req))));
// F038 vendor 360 and statement.
router.get('/:id/overview', view, handler((req) => vendorLedger.vendorOverview(id(req))));
router.get('/:id/statement', view, handler((req) => vendorLedger.vendorStatement(id(req), String(req.query.from), String(req.query.to))));
router.get('/:id/statement.pdf', view, async (req, res, next) => {
    try {
        const f = await vendorLedger.vendorStatementPdf(id(req), String(req.query.from), String(req.query.to));
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${f.name.replace(/[^\w .-]/g, '_')}"`);
        res.send(f.pdf);
    } catch (e) { next(e); }
});
router.put('/:id', edit, handler((req) => vendors.updateVendor(ctx(req), id(req), parseBody(vendorSchema, req.body))));
router.post('/:id/status', edit, handler((req) => {
    const b = parseBody(z.object({ status: z.enum(['draft', 'pending_review', 'active', 'blocked']), reason: opt }), req.body);
    return vendors.setVendorStatus(ctx(req, b.reason), id(req), b.status);
}));
router.post('/:id/archive', edit, handler((req) => vendors.archiveVendor(ctx(req, parseBody(z.object({ reason: z.string() }), req.body).reason), id(req))));
router.post('/:id/bank', edit, handler((req) => vendors.requestBankChange(ctx(req), id(req), parseBody(z.object({
    accountName: z.string(), accountNumber: z.string(), ifsc: z.string(), bankName: opt, branch: opt,
}), req.body))));
router.post('/bank/:id/decide', edit, handler((req) => {
    const b = parseBody(z.object({ approve: z.boolean(), note: opt }), req.body);
    return vendors.decideBankChange(ctx(req), id(req), b.approve, b.note);
}));
router.delete('/:id', edit, handler((req) => refuseDelete(ctx(req), 'Vendor', id(req))));

export default router;
