import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { parseBody, UserError, zDate } from '../lib/http';
import * as api from '../services/crmApi.service';

/**
 * F105 Invoice API for the CRM, at /api/integrations/crm/v1. Not behind the founders' login: the
 * CRM sends its key in X-Finance-Key and the acting CRM user in X-Crm-User. Every call, refused or
 * not, is logged with that user and the CRM order.
 */
const router = Router();

type Call = { keyId: string | null; actsAs: string | null; crmUser: string | null; orderNumber: string | null; docId: string | null; docNumber: string | null; error: string | null };
const call = (res: Response) => res.locals.crmCall as Call;

router.use(async (req: Request, res: Response, next: NextFunction) => {
    const key = await api.keyFor(req.header('x-finance-key') ?? undefined).catch(() => null);
    const crmUser = req.header('x-crm-user')?.trim().slice(0, 120) || null;
    res.locals.crmCall = { keyId: key?.id ?? null, actsAs: key?.actsAsUserId ?? null, crmUser, orderNumber: null, docId: null, docNumber: null, error: null } satisfies Call;
    res.on('finish', () => {
        const c = call(res);
        api.logCall({ keyId: c.keyId, actsAs: c.actsAs, crmUser: c.crmUser, method: req.method, path: req.originalUrl.split('?')[0], crmOrderNumber: c.orderNumber, docId: c.docId, docNumber: c.docNumber, statusCode: res.statusCode, error: c.error })
            .catch((e) => console.error('CRM API call not logged:', e));
    });
    if (!key) { call(res).error = 'Missing or revoked key'; res.status(401).json({ success: false, error: 'Missing or revoked API key (X-Finance-Key)' }); return; }
    if (!crmUser) { call(res).error = 'No CRM user'; res.status(400).json({ success: false, error: 'Name the CRM user in X-Crm-User' }); return; }
    next();
});

const ctx = (res: Response) => ({ userId: call(res).actsAs!, crmUser: call(res).crmUser! });
const done = (res: Response, d: { id: string; docNumber: string | null; crmOrderNumber?: string | null }) => {
    Object.assign(call(res), { docId: d.id, docNumber: d.docNumber, orderNumber: d.crmOrderNumber ?? call(res).orderNumber });
    res.json({ success: true, data: d });
};
const wrap = (fn: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response) => {
    try {
        await fn(req, res);
    } catch (e) {
        const msg = e instanceof UserError ? e.message : (e instanceof Error ? e.message : String(e)).match(/finance: ([^"\\\n]+)/)?.[1];
        if (!(e instanceof UserError) && !msg) console.error('CRM API error:', e);
        call(res).error = msg ?? 'Something went wrong';
        res.status(e instanceof UserError ? e.status : msg ? 409 : 500).json({ success: false, error: msg ?? 'Something went wrong' });
    }
};

router.post('/documents', wrap(async (req, res) => {
    const b = parseBody(z.object({ orderNumber: z.string().min(1), docType: z.enum(['proforma', 'tax_invoice']), docDate: zDate.nullish(), issue: z.boolean().optional(), salesPerson: z.string().nullish() }), req.body);
    call(res).orderNumber = b.orderNumber;
    done(res, await api.apiCreate(ctx(res), b));
}));
router.post('/documents/:id/issue', wrap(async (req, res) => done(res, await api.apiIssue(ctx(res), String(req.params.id)))));
router.get('/documents/:id', wrap(async (req, res) => done(res, await api.apiGet(String(req.params.id)))));
router.get('/orders/:orderNumber/documents', wrap(async (req, res) => {
    call(res).orderNumber = String(req.params.orderNumber);
    res.json({ success: true, data: await api.apiOrderDocs(String(req.params.orderNumber)) });
}));
router.get('/documents/:id/pdf', wrap(async (req, res) => {
    const f = await api.apiPdf(String(req.params.id));
    call(res).docId = String(req.params.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${f.name.replace(/[^\w.-]/g, '_')}"`);
    res.send(f.pdf);
}));

export default router;
