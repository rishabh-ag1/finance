import { Router, type Request } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middleware/auth.middleware';
import { handler, parseBody, zDate, zMoney } from '../lib/http';
import * as settings from '../services/settings.service';

const router = Router();
const view = requirePermission('financeSettings', 'view');
const edit = requirePermission('financeSettings', 'edit');

const ctx = (req: Request, reason?: string | null) => ({ userId: req.user!.id, reason: reason ?? undefined });
const optText = z.string().nullish();
const optMoney = zMoney.nullish().or(z.literal(''));
const optDate = zDate.nullish().or(z.literal(''));

// ---------- Company and FY ----------
router.get('/company', view, handler(() => settings.companyView()));
router.put('/company', edit, handler((req) => settings.updateCompany(ctx(req), parseBody(z.object({
    legalName: z.string().min(2),
    brandName: optText,
    cin: optText,
    tan: optText,
    gstin: z.string().min(15),
    udyamNo: optText,
    registeredAddress: z.string().min(5),
    email: optText,
    phone: optText,
    incorporationDate: optDate,
    taxInvoiceChaseDays: z.number().int().min(1).max(365).optional(),
}), req.body))));

// ---------- Bank accounts ----------
const bankAccountSchema = z.object({
    bankName: z.string().min(2),
    accountName: z.string().min(2),
    accountNumber: z.string().min(4),
    ifsc: z.string().max(11).optional().default(''),
    branch: optText,
    accountType: z.enum(['business_current', 'cash_credit', 'founder_personal', 'loan', 'wallet', 'card']),
    owner: z.string().min(1),
    openingBalance: zMoney,
    openingDate: zDate,
    parserFormat: optText,
    sanctionedLimit: optMoney,
    drawingPower: optMoney,
    drawingPowerAsOf: optDate,
    interestRate: optText,
    renewalDate: optDate,
    isActive: z.boolean().optional(),
});
router.get('/bank-accounts', view, handler(() => settings.listBankAccounts()));
router.get('/bank-accounts/:id', view, handler((req) => settings.getBankAccount(String(req.params.id))));
router.post('/bank-accounts', edit, handler((req) => settings.createBankAccount(ctx(req), parseBody(bankAccountSchema, req.body))));
router.put('/bank-accounts/:id', edit, handler((req) => settings.updateBankAccount(ctx(req), String(req.params.id), parseBody(bankAccountSchema, req.body))));
router.post('/bank-accounts/:id/archive', edit, handler((req) => {
    const b = parseBody(z.object({ isArchived: z.boolean(), reason: optText }), req.body);
    return settings.setBankAccountArchived(ctx(req, b.reason), String(req.params.id), b.isArchived);
}));

// ---------- GST rates and TDS sections ----------
router.get('/gst-rates', view, handler(() => settings.listGstRates()));
router.post('/gst-rates', edit, handler((req) => settings.addGstRate(ctx(req), parseBody(z.object({ rate: z.string(), effectiveFrom: zDate, note: optText }), req.body))));
router.post('/gst-rates/:id/end', edit, handler((req) => {
    const b = parseBody(z.object({ effectiveTo: zDate }), req.body);
    return settings.endGstRate(ctx(req), String(req.params.id), b.effectiveTo);
}));

const tdsSchema = z.object({
    codeOldAct: z.string().min(3),
    codeNewAct: optText,
    nature: z.string().min(2),
    rateIndividual: z.string(),
    rateOthers: z.string(),
    rateNoPan: z.string(),
    singleThreshold: optMoney,
    annualThreshold: optMoney,
    thresholdNote: optText,
    effectiveFrom: zDate,
    effectiveTo: optDate,
    verifiedByCa: z.boolean().optional(),
    isActive: z.boolean().optional(),
});
router.get('/tds-sections', view, handler(() => settings.listTdsSections()));
router.post('/tds-sections', edit, handler((req) => settings.createTdsSection(ctx(req), parseBody(tdsSchema, req.body))));
router.put('/tds-sections/:id', edit, handler((req) => settings.updateTdsSection(ctx(req), String(req.params.id), parseBody(tdsSchema, req.body))));

// ---------- Number series ----------
router.get('/number-series', view, handler(() => settings.listNumberSeries()));
router.put('/number-series/:id', edit, handler((req) => {
    const b = parseBody(z.object({
        pattern: z.string().min(3),
        padding: z.number().int(),
        nextNumber: z.number().int().min(1),
        isActive: z.boolean(),
        note: optText,
        reason: optText,
    }), req.body);
    return settings.updateNumberSeries(ctx(req, b.reason), String(req.params.id), b);
}));

// ---------- Payment terms and approval rules ----------
const termSchema = z.object({ label: z.string(), days: z.number().int(), isAdvance: z.boolean(), isActive: z.boolean() });
router.get('/payment-terms', view, handler(() => settings.listPaymentTerms()));
router.post('/payment-terms', edit, handler((req) => settings.savePaymentTerm(ctx(req), null, parseBody(termSchema, req.body))));
router.put('/payment-terms/:id', edit, handler((req) => settings.savePaymentTerm(ctx(req), String(req.params.id), parseBody(termSchema, req.body))));
router.get('/approval-rules', view, handler(() => settings.listApprovalRules()));

// ---------- Period lock ----------
router.get('/period-locks', view, handler((req) => settings.listPeriodLocks(typeof req.query.date === 'string' ? req.query.date : undefined)));
router.post('/period-locks/lock', edit, handler((req) => {
    const b = parseBody(z.object({ month: zDate }), req.body);
    return settings.lockMonth(ctx(req), b.month);
}));
router.post('/period-locks/unlock', edit, handler((req) => {
    const b = parseBody(z.object({ month: zDate, reason: z.string().min(3, 'say why the month is unlocked') }), req.body);
    return settings.unlockMonth(ctx(req, b.reason), b.month);
}));

export default router;
