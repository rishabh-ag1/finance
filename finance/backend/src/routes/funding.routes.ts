import { Router, type Request } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middleware/auth.middleware';
import { handler, parseBody, zDate } from '../lib/http';
import * as funding from '../services/funding.service';

// M13 Funding & Loans (F140-F143, BR-28).
const router = Router();
const view = requirePermission('financeFunding', 'view');
const edit = requirePermission('financeFunding', 'edit');
const ctx = (req: Request, reason?: string | null) => ({ userId: req.user!.id, reason: reason ?? undefined });
const id = (req: Request) => String(req.params.id);
const opt = z.string().nullish();
const reasonBody = z.object({ reason: z.string().min(3, 'give a reason') });
const txnBody = z.object({ txnId: z.string().min(1) });

const capital = z.object({
    holderName: z.string(), founderUserId: opt, receiptDate: zDate, amount: z.string(), type: z.enum(funding.CAPITAL_TYPES),
    allotmentDate: zDate.nullish(), sharesAllotted: z.number().int().nullish(), notes: opt, bankTxnId: opt,
});
const loan = z.object({
    lender: z.string(), reference: opt, sanctionAmount: z.string(), disbursedAmount: z.string(), disbursedDate: zDate, interestRate: opt,
    repaymentType: z.enum(funding.REPAYMENT_TYPES), tenureMonths: z.number().int(), moratoriumMonths: z.number().int().nullish(), firstDueDate: zDate.nullish().or(z.literal('')),
    countsTowardCovenant: z.boolean().optional(), notes: opt, bankTxnId: opt,
});
const repayment = z.object({ paidDate: zDate, principal: z.string(), interest: opt, instalmentId: opt, reference: opt, notes: opt, bankTxnId: opt });

router.get('/funding', view, handler(() => funding.fundingOverview()));
router.get('/funding/setting', view, handler(() => funding.getFundingSetting()));
router.put('/funding/setting', edit, handler((req) => funding.saveFundingSetting(ctx(req), parseBody(z.object({ debtCap: z.string(), countSanctionedLimit: z.boolean() }), req.body))));
router.get('/funding/bank-rows', view, handler(() => funding.unexplainedRows()));

router.get('/capital', view, handler(() => funding.listCapital()));
router.post('/capital', edit, handler((req) => funding.createCapital(ctx(req), parseBody(capital, req.body))));
router.post('/capital/:id/allot', edit, handler((req) => funding.allotCapital(ctx(req), id(req), parseBody(z.object({ allotmentDate: zDate, sharesAllotted: z.number().int() }), req.body))));
router.post('/capital/:id/cancel', edit, handler((req) => funding.cancelCapital(ctx(req, parseBody(reasonBody, req.body).reason), id(req))));
router.get('/capital/:id/bank-candidates', view, handler((req) => funding.capitalCandidates(id(req))));
router.post('/capital/:id/link', edit, handler((req) => funding.linkCapital(ctx(req), id(req), parseBody(txnBody, req.body).txnId)));

router.get('/loans', view, handler(() => funding.listLoans()));
router.post('/loans/preview', view, handler((req) => funding.previewLoan(parseBody(loan, req.body))));
router.post('/loans', edit, handler((req) => funding.createLoan(ctx(req), parseBody(loan, req.body))));
router.get('/loans/:id', view, handler((req) => funding.getLoan(id(req))));
router.put('/loans/:id/terms', edit, handler((req) => funding.updateLoanTerms(ctx(req), id(req), parseBody(z.object({ interestRate: opt, reference: opt, notes: opt, countsTowardCovenant: z.boolean().optional() }), req.body))));
router.post('/loans/:id/cancel', edit, handler((req) => funding.cancelLoan(ctx(req, parseBody(reasonBody, req.body).reason), id(req))));
router.get('/loans/:id/bank-candidates', view, handler((req) => funding.loanCandidates(id(req))));
router.post('/loans/:id/link', edit, handler((req) => funding.linkLoan(ctx(req), id(req), parseBody(txnBody, req.body).txnId)));
router.get('/loans/:id/suggest-repayment', view, handler((req) => funding.suggestRepayment(id(req), typeof req.query.date === 'string' ? req.query.date : undefined)));
router.post('/loans/:id/repayments', edit, handler((req) => funding.recordRepayment(ctx(req), id(req), parseBody(repayment, req.body))));
router.post('/loan-repayments/:id/cancel', edit, handler((req) => funding.cancelRepayment(ctx(req, parseBody(reasonBody, req.body).reason), id(req))));
router.get('/loan-repayments/:id/bank-candidates', view, handler((req) => funding.repaymentCandidates(id(req))));
router.post('/loan-repayments/:id/link', edit, handler((req) => funding.linkRepayment(ctx(req), id(req), parseBody(txnBody, req.body).txnId)));

export default router;
