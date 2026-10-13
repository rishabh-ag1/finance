import { Router, type Request } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middleware/auth.middleware';
import { handler, parseBody, zDate } from '../lib/http';
import * as bills from '../services/bill.service';

// M05 Vendor documents (F050-F059).
const router = Router();
const view = requirePermission('financeBills', 'view');
const edit = requirePermission('financeBills', 'edit');
const ctx = (req: Request, reason?: string | null) => ({ userId: req.user!.id, reason: reason ?? undefined });
const id = (req: Request) => String(req.params.id);
const opt = z.string().nullish();
const amount = z.string().regex(/^-?[\d,]{0,14}(\.\d{1,2})?$/, 'must be an amount').nullish();
const reasonBody = z.object({ reason: z.string().min(3, 'give a reason') });

const lineSchema = z.object({
    poLineId: opt,
    description: z.string().min(1, 'describe the item'),
    hsnSac: opt,
    qty: z.string().regex(/^[\d,]{1,12}(\.\d{1,3})?$/, 'must be a quantity like 2 or 1.5'),
    unit: opt,
    rate: z.string().regex(/^[\d,]{1,12}(\.\d{1,4})?$/, 'must be a rate like 1200.50'),
    discount: amount,
    gstRate: z.string().regex(/^\d{1,2}(\.\d{1,2})?$/, 'must be a GST rate like 18'),
    cgst: amount, sgst: amount, igst: amount,
});
const billSchema = z.object({
    docType: z.enum(['quote', 'proforma', 'tax_invoice', 'debit_note', 'credit_note']),
    vendorId: z.string().min(1, 'choose a vendor'),
    docNumber: z.string().min(1, "enter the vendor's document number"),
    docDate: zDate,
    receivedDate: zDate.nullish().or(z.literal('')),
    poId: opt,
    replacesDocumentId: opt,
    againstDocumentId: opt,
    placeOfSupplyState: opt,
    reverseCharge: z.boolean().optional(),
    lines: z.array(lineSchema).min(1, 'add at least one line'),
    otherCharges: amount,
    roundOff: amount,
    tds: z.object({
        applicable: z.boolean(), sectionId: opt, rate: z.string().regex(/^\d{1,2}(\.\d{1,2})?$/).nullish().or(z.literal('')),
        base: amount, amount, overrideReason: opt,
    }).nullish(),
    categoryId: opt,
    subCategoryId: opt,
    paymentTermId: opt,
    dueDate: zDate.nullish().or(z.literal('')),
    itcEligible: z.boolean().optional(),
    notes: opt,
});
const parse = (req: Request) => parseBody(billSchema, req.body) as bills.BillInput;

router.get('/', view, handler((req) => bills.listBills({
    vendorId: typeof req.query.vendorId === 'string' ? req.query.vendorId : undefined,
    poId: typeof req.query.poId === 'string' ? req.query.poId : undefined,
    status: typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined,
    docType: typeof req.query.docType === 'string' && req.query.docType ? req.query.docType : undefined,
    q: typeof req.query.q === 'string' && req.query.q ? req.query.q : undefined,
    fy: typeof req.query.fy === 'string' && req.query.fy ? req.query.fy : undefined,
    overdue: req.query.overdue === '1',
    open: req.query.open === '1',
})));
router.get('/chase', view, handler(() => bills.chaseList()));
router.post('/preview', view, handler((req) => bills.previewBill(parse(req), typeof req.query.id === 'string' ? req.query.id : null)));
router.get('/:id', view, handler((req) => bills.getBill(id(req))));
router.post('/', edit, handler((req) => bills.createBill(ctx(req), parse(req))));
router.put('/:id', edit, handler((req) => bills.updateBill(ctx(req), id(req), parse(req))));
router.post('/:id/approve', edit, handler((req) => bills.approveBill(ctx(req), id(req))));
router.post('/:id/dispute', edit, handler((req) => bills.disputeBill(ctx(req, parseBody(reasonBody, req.body).reason), id(req))));
router.post('/:id/resolve', edit, handler((req) => bills.resolveDispute(ctx(req), id(req))));
router.post('/:id/cancel', edit, handler((req) => bills.cancelBill(ctx(req, parseBody(reasonBody, req.body).reason), id(req))));

export default router;
