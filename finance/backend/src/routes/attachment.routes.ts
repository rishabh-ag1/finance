import { Router, type Request } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middleware/auth.middleware';
import { handler, parseBody } from '../lib/http';
import { refuseDelete } from '../lib/audit';
import * as attachments from '../services/attachment.service';
import { missingDocuments } from '../services/missingDocs.service';

// F160-F161 documents vault. Viewing needs financeDocuments view; attaching needs edit.
const router = Router();
const view = requirePermission('financeDocuments', 'view');
const edit = requirePermission('financeDocuments', 'edit');
const ctx = (req: Request, reason?: string | null) => ({ userId: req.user!.id, reason: reason ?? undefined });

router.get('/missing', view, handler(() => missingDocuments()));
router.get('/', view, handler((req) => {
    const recordType = String(req.query.recordType ?? '');
    const recordId = String(req.query.recordId ?? '');
    return attachments.listAttachments(recordType, recordId, req.query.archived === '1');
}));
router.post('/', edit, handler((req) => attachments.upload(ctx(req), parseBody(z.object({
    recordType: z.string().min(1),
    recordId: z.string().min(1),
    docKind: z.string().min(1),
    fileName: z.string().min(1),
    contentBase64: z.string().min(1, 'choose a file'),
    note: z.string().nullish(),
}), req.body))));
router.get('/:id/file', view, async (req, res, next) => {
    try {
        const f = await attachments.download(String(req.params.id));
        res.setHeader('Content-Type', f.mimeType);
        res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${f.fileName.replace(/"/g, '')}"`);
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.send(f.content);
    } catch (error) {
        next(error);
    }
});
router.post('/:id/archive', edit, handler((req) => attachments.archive(ctx(req, parseBody(z.object({ reason: z.string() }), req.body).reason), String(req.params.id))));
router.delete('/:id', edit, handler((req) => refuseDelete(ctx(req), 'Attachment', String(req.params.id))));

export default router;
