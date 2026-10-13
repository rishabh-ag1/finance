import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middleware/auth.middleware';
import { handler, parseBody } from '../lib/http';
import * as bankImport from '../bank/import.service';

const router = Router();
const view = requirePermission('financeBank', 'view');
const edit = requirePermission('financeBank', 'edit');

const fileSchema = z.object({
    bankAccountId: z.string().min(1),
    fileName: z.string().min(1),
    contentBase64: z.string().min(1, 'choose a statement file'),
});

// F010-F013 statement import
router.post('/imports/preview', edit, handler((req) => bankImport.previewImport(parseBody(fileSchema, req.body))));
router.post('/imports', edit, handler((req) => bankImport.confirmImport({ userId: req.user!.id }, parseBody(fileSchema, req.body))));
router.get('/imports', view, handler((req) => bankImport.listBatches(typeof req.query.accountId === 'string' ? req.query.accountId : undefined)));
router.get('/imports/:id', view, handler((req) => bankImport.getBatch(String(req.params.id))));
router.get('/accounts/:id/totals', view, handler((req) => bankImport.accountTotals(String(req.params.id))));

export default router;
