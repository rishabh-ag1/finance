import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middleware/auth.middleware';
import { handler, parseBody, zDate } from '../lib/http';
import * as sales from '../services/sales.service';

// M09 Sales documents (F090-F098, F104, F106) and GSTR-1 months (BR-34).
const router = Router();
const view = requirePermission('financeSales', 'view');
const edit = requirePermission('financeSales', 'edit');
const settingsEdit = requirePermission('financeSettings', 'edit');
const ctx = (req: Request, reason?: string | null) => ({ userId: req.user!.id, reason: reason ?? undefined });
const id = (req: Request) => String(req.params.id);
const opt = z.string().nullish();
const q = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const reasonBody = z.object({ reason: z.string().min(3, 'give a reason') });

const line = z.object({
    invProductId: opt, description: opt, hsnSac: opt, qty: z.string().min(1), unit: opt, rate: opt, discountPct: opt, gstRate: opt, sourceLineId: opt, priceSource: opt,
});
const customer = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('outlet'), companyId: z.string().min(1), branchId: z.string().min(1), shipToBranchId: opt }),
    z.object({
        kind: z.literal('one_off'), name: z.string(), address: z.string(), state: z.string(), gstin: opt, phone: opt, email: opt,
        shipTo: z.object({ name: z.string(), address: z.string(), state: z.string() }).nullish(),
    }),
]);
const docSchema = z.object({
    docType: z.enum(['proforma', 'tax_invoice']), docDate: zDate, customer, customerPoNo: opt, customerPoDate: zDate.nullish().or(z.literal('')),
    validUntil: zDate.nullish().or(z.literal('')), paymentTermId: opt, salesPerson: opt, notes: opt, ewayBillNo: opt, transporter: opt, vehicleNo: opt,
    lines: z.array(line),
});
const clean = <T extends { customerPoDate?: string | null; validUntil?: string | null }>(b: T) => ({ ...b, customerPoDate: b.customerPoDate || null, validUntil: b.validUntil || null });

const sendPdf = (res: Response, pdf: Buffer, name: string) => {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${name}"`);
    res.send(pdf);
};

router.get('/sales', view, handler((req) => sales.listDocs({
    docType: q(req.query.docType), status: q(req.query.status), q: q(req.query.q), from: q(req.query.from), to: q(req.query.to),
    companyId: q(req.query.companyId), supplyType: q(req.query.supplyType),
})));
router.post('/sales/preview', view, handler((req) => sales.previewDoc(clean(parseBody(docSchema, req.body)))));
router.get('/sales/:id', view, handler((req) => sales.getDoc(id(req))));
router.get('/sales/:id/preview.pdf', view, async (req, res, next) => {
    try { sendPdf(res, await sales.previewPdf(id(req)), 'preview.pdf'); } catch (e) { next(e); }
});
router.post('/sales', edit, handler((req) => sales.createDoc(ctx(req), clean(parseBody(docSchema, req.body)))));
router.put('/sales/:id', edit, handler((req) => sales.updateDoc(ctx(req), id(req), clean(parseBody(docSchema, req.body)))));
router.post('/sales/:id/issue', edit, handler((req) => sales.issueDoc(ctx(req), id(req))));
router.post('/sales/:id/print', edit, handler((req) => sales.printDoc(ctx(req), id(req))));
router.post('/sales/:id/cancel', edit, handler((req) => sales.cancelDoc(ctx(req, parseBody(reasonBody, req.body).reason), id(req))));
router.post('/sales/:id/sent', edit, handler((req) => sales.markDoc(ctx(req), id(req), 'sent')));
router.post('/sales/:id/accepted', edit, handler((req) => sales.markDoc(ctx(req), id(req), 'accepted')));
router.put('/sales/:id/transport', edit, handler((req) => sales.updateTransport(ctx(req), id(req), parseBody(z.object({ ewayBillNo: opt, transporter: opt, vehicleNo: opt }), req.body))));
router.post('/sales/:id/convert', edit, handler((req) => sales.convertProforma(ctx(req), id(req), parseBody(z.object({
    docDate: zDate, lines: z.array(z.object({ sourceLineId: z.string(), qty: z.string() })).optional(),
}), req.body))));
router.post('/sales/:id/credit-note', edit, handler((req) => sales.createCreditNote(ctx(req), id(req), parseBody(z.object({
    docDate: zDate, creditReason: z.enum(sales.CREDIT_REASONS), notes: opt, lines: z.array(z.object({ sourceLineId: z.string(), qty: z.string(), rate: opt })),
}), req.body))));

router.get('/sales-template', view, handler(() => sales.getTemplate()));
router.get('/sales-template/sample.pdf', view, async (_req, res, next) => {
    try { sendPdf(res, await sales.templateSample(), 'sample.pdf'); } catch (e) { next(e); }
});
router.put('/sales-template', settingsEdit, handler((req) => sales.saveTemplate(ctx(req), parseBody(z.object({
    accentColor: z.string(), font: z.string(), logoAttachmentId: opt, signatureAttachmentId: opt, bankAccountId: opt, upiId: opt, warrantyText: opt,
    declarationText: opt, termsText: opt, footerText: opt, showDiscount: z.boolean(), showHsnSummary: z.boolean(), ewayBillThreshold: z.string(),
}), req.body))));

router.get('/gstr1', view, handler(() => sales.listGstr1()));
router.post('/gstr1', settingsEdit, handler((req) => sales.markGstr1Filed(ctx(req), parseBody(z.object({ month: z.string().regex(/^\d{4}-\d{2}/), filedOn: zDate, arn: opt, notes: opt }), req.body))));
router.post('/gstr1/:id/unmark', settingsEdit, handler((req) => sales.unmarkGstr1(ctx(req, parseBody(reasonBody, req.body).reason), id(req))));

export default router;
