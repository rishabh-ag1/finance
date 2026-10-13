import { Router, type Request } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middleware/auth.middleware';
import { handler, parseBody, zMoney } from '../lib/http';
import { refuseDelete } from '../lib/audit';
import * as bankImport from '../bank/import.service';
import * as ledger from '../bank/ledger.service';
import * as rules from '../bank/rules.service';

const router = Router();
const view = requirePermission('financeBank', 'view');
const edit = requirePermission('financeBank', 'edit');
const rulesView = requirePermission('financeRules', 'view');
const rulesEdit = requirePermission('financeRules', 'edit');
const ctx = (req: Request) => ({ userId: req.user!.id });
const id = (req: Request) => String(req.params.id);

const NATURES = ['operating_income', 'operating_expense', 'cogs', 'capex', 'financing_in', 'financing_out', 'interest', 'tax_payment', 'advance', 'transfer', 'related_party', 'refund_reversal', 'reimbursement'] as const;
const PARTY_TYPES = ['vendor', 'customer', 'founder', 'lender', 'govt', 'own_account', 'other'] as const;
const nature = z.enum(NATURES);
const partyType = z.enum(PARTY_TYPES);

// ---------- F010-F013 statement import ----------
const fileSchema = z.object({
    bankAccountId: z.string().min(1),
    fileName: z.string().min(1),
    contentBase64: z.string().min(1, 'choose a statement file'),
});
router.post('/imports/preview', edit, handler((req) => bankImport.previewImport(parseBody(fileSchema, req.body))));
router.post('/imports', edit, handler((req) => bankImport.confirmImport(ctx(req), parseBody(fileSchema, req.body))));
router.get('/imports', view, handler((req) => bankImport.listBatches(typeof req.query.accountId === 'string' ? req.query.accountId : undefined)));
router.get('/imports/:id', view, handler((req) => bankImport.getBatch(id(req))));
router.get('/accounts/:id/totals', view, handler((req) => bankImport.accountTotals(id(req))));

// ---------- F014-F021 ledger and review ----------
const q = (req: Request, k: string) => (typeof req.query[k] === 'string' && req.query[k] ? String(req.query[k]) : undefined);
router.get('/txns', view, handler((req) => ledger.listLedger({
    accountId: q(req, 'accountId'),
    from: q(req, 'from'),
    to: q(req, 'to'),
    status: q(req, 'status') as ledger.LedgerFilter['status'],
    categoryId: q(req, 'categoryId'),
    nature: q(req, 'nature') as ledger.LedgerFilter['nature'],
    direction: q(req, 'direction') as ledger.LedgerFilter['direction'],
    q: q(req, 'q'),
    min: q(req, 'min'),
    max: q(req, 'max'),
    limit: q(req, 'limit') ? Number(q(req, 'limit')) : undefined,
    offset: q(req, 'offset') ? Number(q(req, 'offset')) : undefined,
})));
router.get('/review-count', view, handler(() => ledger.reviewCount()));
router.get('/txns/:id', view, handler((req) => ledger.getTxn(id(req))));

router.post('/txns/:id/categorise', edit, handler((req) => ledger.categorise(ctx(req), id(req), parseBody(z.object({
    categoryId: z.string().min(1, 'pick a category'),
    subCategoryId: z.string().nullish(),
    nature: nature.nullish(),
    partyType: partyType.nullish(),
    description: z.string().nullish(),
    notes: z.string().nullish(),
    relatedPartyType: z.enum(['business_transfer', 'director_loan', 'capital', 'undecided']).nullish(),
}), req.body))));
router.post('/txns/accept', edit, handler((req) => ledger.acceptSuggestions(ctx(req), parseBody(z.object({ ids: z.array(z.string()).min(1) }), req.body).ids)));
router.post('/txns/:id/ignore', edit, handler((req) => ledger.ignore(ctx(req), id(req), parseBody(z.object({ note: z.string().min(3, 'say why') }), req.body).note)));
router.post('/txns/:id/restore', edit, handler((req) => ledger.restore(ctx(req), id(req))));
router.post('/txns/:id/notes', edit, handler((req) => {
    const b = parseBody(z.object({ notes: z.string().nullable(), description: z.string().nullish() }), req.body);
    return ledger.setNotes(ctx(req), id(req), b.notes, b.description);
}));
router.post('/txns/:id/split', edit, handler((req) => ledger.split(ctx(req), id(req), parseBody(z.object({
    lines: z.array(z.object({
        amount: zMoney,
        categoryId: z.string().min(1, 'pick a category for every line'),
        subCategoryId: z.string().nullish(),
        nature: nature.nullish(),
        partyType: partyType.nullish(),
        description: z.string().nullish(),
        note: z.string().nullish(),
    })).min(2, 'a split needs at least two lines'),
}), req.body).lines)));
router.post('/txns/:id/unsplit', edit, handler((req) => ledger.unsplit(ctx(req), id(req), parseBody(z.object({ reason: z.string() }), req.body).reason)));
router.post('/txns/:id/unpair', edit, handler((req) => ledger.unpair(ctx(req), id(req), parseBody(z.object({ reason: z.string() }), req.body).reason)));
router.post('/rerun-rules', edit, handler((req) => ledger.rerunRules(ctx(req))));
// A9: bank rows are never deleted; ignore them with a note instead.
router.delete('/txns/:id', edit, handler((req) => refuseDelete(ctx(req), 'BankTxn', id(req))));

// ---------- F017 rules manager ----------
const ruleSchema = z.object({
    name: z.string(),
    priority: z.number().int().min(0).max(100000),
    matchField: z.enum(['narration', 'counterparty_name', 'mode', 'remark', 'utr']),
    operator: z.enum(['contains', 'equals', 'starts_with', 'regex']),
    matchValue: z.string(),
    direction: z.enum(['debit', 'credit']).nullable(),
    amountMin: zMoney.nullish().or(z.literal('')),
    amountMax: zMoney.nullish().or(z.literal('')),
    setCategoryId: z.string().min(1, 'pick a category'),
    setSubCategoryId: z.string().nullish(),
    setNature: nature.nullish(),
    setPartyType: partyType.nullish(),
    setDescription: z.string().nullish(),
    isActive: z.boolean(),
});
router.get('/rules', rulesView, handler(() => rules.listRules()));
router.post('/rules', rulesEdit, handler((req) => rules.saveRule(ctx(req), null, parseBody(ruleSchema, req.body))));
router.put('/rules/:id', rulesEdit, handler((req) => rules.saveRule(ctx(req), id(req), parseBody(ruleSchema, req.body))));
router.post('/rules/test', rulesView, handler((req) => rules.testRule(parseBody(ruleSchema.pick({
    matchField: true, operator: true, matchValue: true, direction: true, amountMin: true, amountMax: true,
}), req.body))));
router.delete('/rules/:id', rulesEdit, handler((req) => refuseDelete(ctx(req), 'CategorizationRule', id(req))));


export default router;
