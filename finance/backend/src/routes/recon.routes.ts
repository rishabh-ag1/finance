import { Router, type Request } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middleware/auth.middleware';
import { handler, parseBody, zDate } from '../lib/http';
import * as recon from '../services/recon.service';

// M18 Order-to-bank (F190-F199).
const router = Router();
const view = requirePermission('financeOrders', 'view');
const edit = requirePermission('financeOrders', 'edit');
const ctx = (req: Request, reason?: string | null) => ({ userId: req.user!.id, reason: reason ?? undefined });
const id = (req: Request) => String(req.params.id);
const q = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const reasonBody = z.object({ reason: z.string().min(3, 'give a reason') });
const days = z.number().int().min(0).max(30);
const money = z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, 'must be an amount like 1.00');

router.get('/tracker', view, handler((req) => recon.tracker({
    from: q(req.query.from), to: q(req.query.to), status: q(req.query.status), route: q(req.query.route), channel: q(req.query.channel), q: q(req.query.q),
    discrepancyOnly: req.query.discrepancyOnly === 'true', showInBank: req.query.showInBank === 'true',
})));
router.get('/in-transit', view, handler(() => recon.moneyInTransit()));
router.get('/orders/:id/status', view, handler((req) => recon.orderStatusForCrm(id(req))));
router.get('/orders/:id', view, handler((req) => recon.orderDetail(id(req))));
router.get('/orders/:id/credits', view, handler((req) => recon.orderCreditCandidates(id(req))));
router.post('/orders/:id/link-credit', edit, handler((req) => {
    const b = parseBody(z.object({ txnId: z.string(), amount: money.nullish() }), req.body);
    return recon.linkOrderCredit(ctx(req), id(req), b.txnId, b.amount);
}));
router.post('/order-links/:id/unlink', edit, handler((req) => recon.unlinkOrderCredit(ctx(req, parseBody(reasonBody, req.body).reason), id(req))));
router.post('/orders/:id/write-off', edit, handler((req) => recon.writeOff(ctx(req, parseBody(reasonBody, req.body).reason), id(req))));
router.post('/orders/:id/undo-write-off', edit, handler((req) => recon.undoWriteOff(ctx(req, parseBody(reasonBody, req.body).reason), id(req))));

router.get('/payments/unlinked', view, handler(() => recon.unlinkedPayments()));
router.post('/payments/:id/link', edit, handler((req) => recon.linkPayment(ctx(req), id(req), parseBody(z.object({ orderNumber: z.string().min(1) }), req.body).orderNumber.trim())));
router.post('/payments/:id/unlink', edit, handler((req) => recon.unlinkPayment(ctx(req, parseBody(reasonBody, req.body).reason), id(req))));

router.get('/settlements', view, handler((req) => recon.listSettlements({ source: q(req.query.source), notInBank: req.query.notInBank === 'true' })));
router.get('/settlements/:id', view, handler((req) => recon.getSettlement(id(req))));
router.post('/settlements/:id/link', edit, handler((req) => recon.linkSettlementRow(ctx(req), id(req), parseBody(z.object({ txnId: z.string() }), req.body).txnId)));
router.post('/settlements/:id/unlink', edit, handler((req) => recon.unlinkSettlementRow(ctx(req, parseBody(reasonBody, req.body).reason), id(req))));

router.get('/discrepancies', view, handler((req) => recon.listDiscrepancies({ status: q(req.query.status), type: req.query.type ? Number(req.query.type) : undefined })));
router.get('/discrepancies/count', view, handler(() => recon.openDiscrepancyCount()));
router.post('/discrepancies/refresh', edit, handler((req) => recon.refreshDiscrepancies(ctx(req))));
router.post('/discrepancies/:id/resolve', edit, handler((req) => {
    const b = parseBody(z.object({ action: z.enum(recon.RESOLUTIONS), note: z.string().min(3, 'add a note') }), req.body);
    return recon.resolveDiscrepancy(ctx(req), id(req), b.action, b.note);
}));

router.get('/imports', view, handler(() => recon.listImports()));
router.post('/imports', edit, handler((req) => recon.importReport(ctx(req), parseBody(z.object({
    source: z.enum(['razorpay', 'shiprocket_cod']), fileName: z.string().min(1), contentBase64: z.string().min(1),
}), req.body))));

router.get('/settings', view, handler(() => recon.getReconSettings()));
router.put('/settings', requirePermission('financeSettings', 'edit'), handler((req) => recon.saveReconSettings(ctx(req), parseBody(z.object({
    razorpaySettlementDays: days, codRemittanceDays: days, settlementToBankDays: days, graceDays: days,
    amountTolerance: money, expectedFeeRate: money, feeGstRate: money, trackFrom: zDate.nullish().or(z.literal('')),
}), req.body))));
router.post('/holidays', requirePermission('financeSettings', 'edit'), handler((req) => {
    const b = parseBody(z.object({ date: zDate, name: z.string().min(2) }), req.body);
    return recon.addHoliday(ctx(req), b.date, b.name);
}));
router.post('/holidays/:id/remove', requirePermission('financeSettings', 'edit'), handler((req) => recon.removeHoliday(ctx(req), id(req))));

export default router;
