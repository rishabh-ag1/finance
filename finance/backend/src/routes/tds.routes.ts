import { Router, type Request } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middleware/auth.middleware';
import { handler, parseBody, zDate } from '../lib/http';
import * as tds from '../services/tds.service';

// M07 TDS tracker (F070-F075).
const router = Router();
const view = requirePermission('financeTds', 'view');
const edit = requirePermission('financeTds', 'edit');
const ctx = (req: Request, reason?: string | null) => ({ userId: req.user!.id, reason: reason ?? undefined });
const id = (req: Request) => String(req.params.id);
const q = (req: Request, k: string) => (typeof req.query[k] === 'string' && req.query[k] ? String(req.query[k]) : undefined);
const amount = z.string().regex(/^[\d,]{0,14}(\.\d{1,2})?$/, 'must be an amount').nullish();
const fyQuarter = { fy: z.string().regex(/^\d{2}-\d{2}$/), quarter: z.number().int().min(1).max(4) };

router.get('/register', view, handler((req) => tds.register({
    fy: q(req, 'fy'), quarter: q(req, 'quarter') ? Number(q(req, 'quarter')) : undefined, vendorId: q(req, 'vendorId'), status: q(req, 'status'), sectionId: q(req, 'sectionId'),
})));
router.get('/payable', view, handler(() => tds.payable()));
router.get('/thresholds', view, handler((req) => tds.thresholds(q(req, 'fy'))));
router.get('/bank-rows', view, handler(() => tds.unmatchedTdsRows()));
router.get('/challans', view, handler((req) => tds.listChallans(q(req, 'fy'))));
router.post('/challans/preview', view, handler((req) => {
    const b = parseBody(z.object({ entryIds: z.array(z.string()), depositDate: zDate }), req.body);
    return tds.previewChallan(b.entryIds, b.depositDate);
}));
router.get('/challans/:id', view, handler((req) => tds.getChallan(id(req))));
router.post('/challans', edit, handler((req) => tds.recordChallan(ctx(req), parseBody(z.object({
    challanSerial: z.string().min(1, 'enter the challan serial'), bsrCode: z.string().min(7, 'the BSR code has 7 digits'), depositDate: zDate,
    entryIds: z.array(z.string()).min(1, 'choose the deductions'), interest: amount, fee: amount,
    total: z.string().regex(/^[\d,]{1,14}(\.\d{1,2})?$/, 'enter the challan total'), bankTxnId: z.string().nullish(), notes: z.string().nullish(),
}), req.body))));
router.post('/challans/:id/link', edit, handler((req) => tds.linkChallanBankRow(ctx(req), id(req), parseBody(z.object({ txnId: z.string() }), req.body).txnId)));
router.post('/challans/:id/cancel', edit, handler((req) => tds.cancelChallan(ctx(req, parseBody(z.object({ reason: z.string().min(3) }), req.body).reason), id(req))));
router.get('/quarter', view, handler((req) => tds.quarterView(q(req, 'fy') ?? '', Number(q(req, 'quarter') ?? 0))));
router.get('/quarter/export', view, async (req, res, next) => {
    try {
        const fy = q(req, 'fy') ?? ''; const quarter = Number(q(req, 'quarter') ?? 0);
        const file = await tds.quarterWorkbook(fy, quarter);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="26Q_Q${quarter}_${fy}.xlsx"`);
        res.send(file);
    } catch (e) { next(e); }
});
router.post('/returns', edit, handler((req) => tds.markReturnFiled(ctx(req), parseBody(z.object({ ...fyQuarter, filedOn: zDate, ackNo: z.string().min(3, 'enter the acknowledgement number'), notes: z.string().nullish() }), req.body))));
router.post('/certificates', edit, handler((req) => tds.markCertificateIssued(ctx(req), parseBody(z.object({ ...fyQuarter, vendorId: z.string(), issuedOn: zDate, certificateNo: z.string().nullish() }), req.body))));
router.post('/backfill', edit, handler((req) => tds.backfillTdsEntries(ctx(req))));

export default router;
