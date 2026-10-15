import { Router, type Request } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middleware/auth.middleware';
import { handler, parseBody, zDate } from '../lib/http';
import * as rec from '../services/receivables.service';

// M10 Receivables (F110-F117, F133): receipts, allocation, bank credits, ageing, statement, reminders.
const router = Router();
const view = requirePermission('financeReceivables', 'view');
const edit = requirePermission('financeReceivables', 'edit');
const ctx = (req: Request, reason?: string | null) => ({ userId: req.user!.id, reason: reason ?? undefined });
const id = (req: Request) => String(req.params.id);
const opt = z.string().nullish();
const q = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const reasonBody = z.object({ reason: z.string().min(3, 'give a reason') });

const allocation = z.object({ docId: z.string().min(1), amount: z.string(), tds: opt });
const receipt = z.object({
    receiptDate: zDate, companyId: opt, customerName: opt, mode: z.enum(rec.RECEIPT_MODES), toBankAccountId: opt, reference: opt,
    amount: z.string(), bankCharges: opt, tdsSectionId: opt, notes: opt, allocations: z.array(allocation), bankTxnId: opt,
});

router.get('/receivables/dashboard', view, handler(() => rec.receivablesDashboard()));
router.get('/receivables/outstanding', view, handler((req) => rec.outstandingList({ companyId: q(req.query.companyId), overdueOnly: req.query.overdue === '1', q: q(req.query.q) })));
router.get('/receivables/ageing', view, handler(() => rec.arAgeing()));
router.get('/receivables/tds', view, handler(() => rec.customerTds()));
router.get('/receivables/open-docs', view, handler((req) => rec.openDocsFor({ companyId: q(req.query.companyId), name: q(req.query.name) })));
router.get('/receivables/credits', view, handler(() => rec.unmatchedCredits()));
router.get('/receivables/credits/:id', view, handler((req) => rec.creditSuggestions(id(req))));
router.post('/receivables/credits/:id/receipt', edit, handler((req) => rec.receiptFromCredit(ctx(req), id(req), parseBody(z.object({ docId: z.string().min(1), tds: opt, tdsSectionId: opt }), req.body))));
router.get('/receivables/statement/:id', view, handler((req) => rec.customerStatement(id(req), String(req.query.from), String(req.query.to))));
router.get('/receivables/statement/:id/pdf', view, async (req, res, next) => {
    try {
        const f = await rec.statementPdf(id(req), String(req.query.from), String(req.query.to));
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${f.name.replace(/[^\w .-]/g, '_')}"`);
        res.send(f.pdf);
    } catch (e) { next(e); }
});

router.get('/receipts', view, handler((req) => rec.listReceipts({ companyId: q(req.query.companyId), q: q(req.query.q), from: q(req.query.from), to: q(req.query.to), status: q(req.query.status) })));
router.post('/receipts/preview', view, handler((req) => rec.previewReceipt(parseBody(receipt, req.body))));
router.post('/receipts', edit, handler((req) => rec.createReceipt(ctx(req), parseBody(receipt, req.body))));
router.get('/receipts/:id', view, handler((req) => rec.getReceipt(id(req))));
router.post('/receipts/:id/allocate', edit, handler((req) => rec.allocateReceipt(ctx(req), id(req), parseBody(z.object({ allocations: z.array(allocation) }), req.body).allocations)));
router.post('/receipts/allocations/:id/remove', edit, handler((req) => rec.removeAllocation(ctx(req, parseBody(reasonBody, req.body).reason), id(req))));
router.post('/receipts/:id/cancel', edit, handler((req) => rec.cancelReceipt(ctx(req, parseBody(reasonBody, req.body).reason), id(req))));
router.get('/receipts/:id/bank-candidates', view, handler((req) => rec.receiptBankCandidates(id(req))));
router.post('/receipts/:id/link', edit, handler((req) => rec.linkReceiptRow(ctx(req), id(req), parseBody(z.object({ txnId: z.string().min(1) }), req.body).txnId)));
router.post('/receipts/:id/unlink', edit, handler((req) => rec.unlinkReceiptRow(ctx(req, parseBody(reasonBody, req.body).reason), id(req))));

router.get('/sales/:id/receivable', view, handler((req) => rec.docReceivable(id(req))));
router.get('/sales/:id/reminder', view, handler((req) => rec.reminderText(id(req))));
router.post('/sales/:id/reminder', edit, handler((req) => rec.logReminder(ctx(req), id(req), parseBody(z.object({ channel: z.enum(['whatsapp', 'email', 'phone', 'other']), note: opt, sharedOn: zDate.nullish() }), req.body))));

export default router;
