import { Router, type Request } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middleware/auth.middleware';
import { handler, parseBody, zDate } from '../lib/http';
import * as payments from '../services/payment.service';

// M06 Payables & payments out (F060-F067).
const router = Router();
const view = requirePermission('financePayments', 'view');
const edit = requirePermission('financePayments', 'edit');
const ctx = (req: Request, reason?: string | null) => ({ userId: req.user!.id, reason: reason ?? undefined });
const id = (req: Request) => String(req.params.id);
const opt = z.string().nullish();
const amount = z.string().regex(/^[\d,]{1,14}(\.\d{1,2})?$/, 'must be an amount like 1200.50');
const reasonBody = z.object({ reason: z.string().min(3, 'give a reason') });

const allocation = z.object({
    docId: opt,
    poId: opt,
    gross: amount,
    tds: z.object({
        applicable: z.boolean(), sectionId: opt, rate: z.string().regex(/^\d{1,2}(\.\d{1,2})?$/).nullish().or(z.literal('')),
        amount: amount.nullish().or(z.literal('')), overrideReason: opt,
    }).nullish(),
});
const paymentSchema = z.object({ vendorId: z.string().min(1, 'choose a vendor'), purpose: opt, notes: opt, allocations: z.array(allocation).min(1, 'add what this pays') });
const recordSchema = z.object({
    paidDate: zDate,
    mode: z.enum(payments.PAYMENT_MODES),
    fromBankAccountId: z.string().min(1, 'choose the account it was paid from'),
    utr: opt,
});

router.get('/', view, handler((req) => payments.listPayments({
    vendorId: typeof req.query.vendorId === 'string' && req.query.vendorId ? req.query.vendorId : undefined,
    status: typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined,
    q: typeof req.query.q === 'string' && req.query.q ? req.query.q : undefined,
    from: typeof req.query.from === 'string' && req.query.from ? req.query.from : undefined,
    to: typeof req.query.to === 'string' && req.query.to ? req.query.to : undefined,
})));
router.get('/due', view, handler(() => payments.dueList()));
router.get('/ageing', view, handler(() => payments.apAgeing()));
router.get('/for-document/:id', view, handler((req) => payments.paymentsForDoc(id(req))));
router.get('/advances-for/:id', view, handler((req) => payments.openAdvancesFor(id(req))));
router.post('/advances-for/:id/apply', edit, handler(async (req) => {
    await payments.applyAdvance(ctx(req), id(req), parseBody(z.object({ allocationId: z.string() }), req.body).allocationId);
    return payments.paymentsForDoc(id(req));
}));
router.post('/advances-for/:id/unapply', edit, handler(async (req) => {
    await payments.unapplyAdvance(ctx(req), id(req), parseBody(z.object({ allocationId: z.string() }), req.body).allocationId);
    return payments.paymentsForDoc(id(req));
}));
router.post('/preview', view, handler((req) => payments.previewPayment(parseBody(paymentSchema, req.body), typeof req.query.id === 'string' ? req.query.id : null)));
router.get('/:id', view, handler((req) => payments.getPayment(id(req))));
router.get('/:id/bank-candidates', view, handler((req) => payments.bankCandidates(id(req))));
router.post('/', edit, handler((req) => {
    const body = parseBody(paymentSchema.extend({ record: recordSchema.nullish() }), req.body);
    return payments.createPayment(ctx(req), body, body.record ?? undefined);
}));
router.put('/:id', edit, handler((req) => payments.updatePayment(ctx(req), id(req), parseBody(paymentSchema, req.body))));
router.post('/:id/approve', edit, handler((req) => payments.approvePayment(ctx(req), id(req))));
router.post('/:id/record', edit, handler((req) => payments.recordPaid(ctx(req), id(req), parseBody(recordSchema, req.body))));
router.post('/:id/cancel', edit, handler((req) => payments.cancelPayment(ctx(req, parseBody(reasonBody, req.body).reason), id(req))));
router.post('/:id/failed', edit, handler((req) => payments.markFailed(ctx(req, parseBody(reasonBody, req.body).reason), id(req))));
router.post('/:id/link', edit, handler((req) => payments.linkBankRow(ctx(req), id(req), parseBody(z.object({ txnId: z.string() }), req.body).txnId)));
router.post('/:id/unlink', edit, handler((req) => payments.unlinkBankRow(ctx(req, parseBody(reasonBody, req.body).reason), id(req))));

export default router;
