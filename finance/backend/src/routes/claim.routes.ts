import { Router, type Request } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middleware/auth.middleware';
import { handler, parseBody, zDate } from '../lib/http';
import * as claims from '../services/claim.service';
import { PAYMENT_MODES } from '../services/payment.service';

// M14 Founder expenses & reimbursements (F150, F151, D32).
const router = Router();
const view = requirePermission('financeClaims', 'view');
const edit = requirePermission('financeClaims', 'edit');
const ctx = (req: Request, reason?: string | null) => ({ userId: req.user!.id, reason: reason ?? undefined });
const id = (req: Request) => String(req.params.id);
const opt = z.string().nullish();
const amount = z.string().regex(/^[\d,]{1,14}(\.\d{1,2})?$/, 'must be an amount like 1200.50');
const reasonBody = z.object({ reason: z.string().min(3, 'give a reason') });
const query = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

const claimSchema = z.object({
    founderUserId: opt,
    expenseDate: zDate,
    paidFrom: z.string().min(1, 'say which account or card paid it'),
    vendorName: z.string().min(1, 'enter who was paid'),
    description: opt,
    amount,
    hasGstInvoice: z.boolean(),
    categoryId: z.string().min(1, 'choose a category'),
    subCategoryId: opt,
});
const reimburseSchema = z.object({
    founderUserId: z.string().min(1),
    claimIds: z.array(z.string()).min(1, 'choose the claims this pays'),
    paidDate: zDate,
    mode: z.enum(PAYMENT_MODES),
    fromBankAccountId: z.string().min(1, 'choose the account it was paid from'),
    utr: opt,
    notes: opt,
});

router.get('/founders', view, handler(() => claims.founders()));
router.get('/balances', view, handler(() => claims.balances()));
router.get('/reimbursements', view, handler(() => claims.listReimbursements()));
router.get('/reimbursements/:id', view, handler((req) => claims.getReimbursement(id(req))));
router.get('/reimbursements/:id/bank-candidates', view, handler((req) => claims.reimbursementBankCandidates(id(req))));
router.post('/reimbursements', edit, handler((req) => claims.reimburse(ctx(req), parseBody(reimburseSchema, req.body))));
router.post('/reimbursements/:id/failed', edit, handler((req) => claims.markReimbursementFailed(ctx(req, parseBody(reasonBody, req.body).reason), id(req))));
router.post('/reimbursements/:id/link', edit, handler((req) => claims.linkReimbursementRow(ctx(req), id(req), parseBody(z.object({ txnId: z.string() }), req.body).txnId)));
router.post('/reimbursements/:id/unlink', edit, handler((req) => claims.unlinkReimbursementRow(ctx(req, parseBody(reasonBody, req.body).reason), id(req))));

router.get('/', view, handler((req) => claims.listClaims({ founderUserId: query(req.query.founderUserId), status: query(req.query.status) })));
router.get('/:id', view, handler((req) => claims.getClaim(id(req))));
router.post('/', edit, handler((req) => claims.createClaim(ctx(req), parseBody(claimSchema, req.body))));
router.put('/:id', edit, handler((req) => claims.updateClaim(ctx(req), id(req), parseBody(claimSchema, req.body))));
router.post('/:id/approve', edit, handler((req) => claims.approveClaim(ctx(req), id(req))));
router.post('/:id/reject', edit, handler((req) => claims.closeClaim(ctx(req, parseBody(reasonBody, req.body).reason), id(req), 'rejected')));
router.post('/:id/withdraw', edit, handler((req) => claims.closeClaim(ctx(req, parseBody(reasonBody, req.body).reason), id(req), 'cancelled')));

export default router;
