import { Router, type Request } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middleware/auth.middleware';
import { handler, parseBody } from '../lib/http';
import * as categories from '../services/category.service';

const router = Router();
// Reading categories is needed by every page that categorises; changing them is a setting.
const view = requirePermission('financeBank', 'view');
const edit = requirePermission('financeSettings', 'edit');
const ctx = (req: Request) => ({ userId: req.user!.id });

const nature = z.enum(['operating_income', 'operating_expense', 'cogs', 'capex', 'financing_in', 'financing_out', 'interest', 'tax_payment', 'advance', 'transfer', 'related_party', 'refund_reversal', 'reimbursement']);
const categorySchema = z.object({ name: z.string(), natureDefault: nature, isActive: z.boolean() });
const subSchema = z.object({ categoryId: z.string(), name: z.string(), nature, plGroup: z.string().nullish(), note: z.string().nullish(), isActive: z.boolean() });

router.get('/', view, handler((req) => categories.listCategories(req.query.active !== '1')));
router.get('/natures', view, handler(async () => categories.natureOptions()));
router.post('/', edit, handler((req) => categories.saveCategory(ctx(req), null, parseBody(categorySchema, req.body))));
router.put('/:id', edit, handler((req) => categories.saveCategory(ctx(req), String(req.params.id), parseBody(categorySchema, req.body))));
router.post('/sub', edit, handler((req) => categories.saveSubCategory(ctx(req), null, parseBody(subSchema, req.body))));
router.put('/sub/:id', edit, handler((req) => categories.saveSubCategory(ctx(req), String(req.params.id), parseBody(subSchema, req.body))));

export default router;
