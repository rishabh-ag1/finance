import type { AccountType, BankAccount, NumberSeries, TdsSection } from '@prisma/client';
import { prisma } from '../config/database';
import { withAudit, type AuditContext } from '../lib/audit';
import { ccHeadroom } from '../lib/cashCredit';
import { dateText, parseDate, parseOptionalDate } from '../lib/dates';
import { fyLabel, fyMonths, fyQuarter, fyRange, todayIST } from '../lib/fy';
import { gstinParts, isValidIfsc } from '../lib/gstin';
import { UserError } from '../lib/http';
import { Decimal, moneyText, parseMoney, parseOptionalMoney } from '../lib/money';
import { docNumberProblem, formatDocNumber, seriesProblem } from '../lib/numberSeries';

/** The single entity in v1 (D5). */
export async function getCompany() {
    const company = await prisma.company.findFirst();
    if (!company) throw new UserError('Company profile is missing. Run the seed (npm run db:seed).', 500);
    return company;
}

// ---------- Company profile and FY (F001, F002, BR-31) ----------

export async function companyView() {
    const c = await getCompany();
    const today = todayIST();
    return {
        id: c.id,
        legalName: c.legalName,
        brandName: c.brandName,
        cin: c.cin,
        pan: c.pan,
        tan: c.tan,
        gstin: c.gstin,
        udyamNo: c.udyamNo,
        registeredAddress: c.registeredAddress,
        stateCode: c.stateCode,
        email: c.email,
        phone: c.phone,
        incorporationDate: dateText(c.incorporationDate),
        taxInvoiceChaseDays: c.taxInvoiceChaseDays,
        fy: {
            startMonth: c.fyStartMonth,
            current: fyRange(today),
            quarter: fyQuarter(today),
            months: fyMonths(today),
        },
    };
}

export type CompanyInput = {
    legalName: string; brandName?: string | null; cin?: string | null; tan?: string | null; gstin: string;
    udyamNo?: string | null; registeredAddress: string; email?: string | null; phone?: string | null;
    incorporationDate?: string | null;
    taxInvoiceChaseDays?: number;
};

export async function updateCompany(ctx: AuditContext, input: CompanyInput) {
    const c = await getCompany();
    let parts;
    try {
        parts = gstinParts(input.gstin);
    } catch (e) {
        throw new UserError((e as Error).message);
    }
    if (input.tan && !/^[A-Z]{4}[0-9]{5}[A-Z]$/.test(input.tan.trim().toUpperCase())) {
        throw new UserError('TAN must be 4 letters, 5 digits, 1 letter (e.g. BLRE12345F)');
    }
    await withAudit(ctx, (tx) => tx.company.update({
        where: { id: c.id },
        data: {
            legalName: input.legalName.trim(),
            brandName: input.brandName?.trim() || null,
            cin: input.cin?.trim().toUpperCase() || null,
            tan: input.tan?.trim().toUpperCase() || null,
            gstin: input.gstin.trim().toUpperCase(),
            // PAN and state code always come from the GSTIN (BR-15), never typed separately.
            pan: parts.pan,
            stateCode: parts.stateCode,
            udyamNo: input.udyamNo?.trim() || null,
            registeredAddress: input.registeredAddress.trim(),
            email: input.email?.trim() || null,
            phone: input.phone?.trim() || null,
            incorporationDate: parseOptionalDate(input.incorporationDate, 'Incorporation date'),
            ...(input.taxInvoiceChaseDays !== undefined ? { taxInvoiceChaseDays: input.taxInvoiceChaseDays } : {}),
        },
    }));
    return companyView();
}

// ---------- Bank accounts (F003, BR-50) ----------

function maskAccount(n: string): string {
    return n.length <= 4 ? n : `•••• ${n.slice(-4)}`;
}

function bankAccountView(a: BankAccount, withFullNumber = false) {
    const isCc = a.accountType === 'cash_credit';
    return {
        id: a.id,
        bankName: a.bankName,
        accountName: a.accountName,
        accountNumberMasked: maskAccount(a.accountNumber),
        ...(withFullNumber && { accountNumber: a.accountNumber }),
        ifsc: a.ifsc,
        branch: a.branch,
        accountType: a.accountType,
        owner: a.owner,
        openingBalance: moneyText(a.openingBalance),
        openingDate: dateText(a.openingDate),
        parserFormat: a.parserFormat,
        sanctionedLimit: moneyText(a.sanctionedLimit),
        drawingPower: moneyText(a.drawingPower),
        drawingPowerAsOf: dateText(a.drawingPowerAsOf),
        interestRate: a.interestRate?.toString() ?? null,
        renewalDate: dateText(a.renewalDate),
        // Drawn amount comes from the CC statement (M2); headroom shown against it then.
        headroomIfUndrawn: isCc && a.sanctionedLimit ? moneyText(ccHeadroom(a.sanctionedLimit, a.drawingPower, new Decimal(0))) : null,
        isActive: a.isActive,
        isArchived: a.isArchived,
    };
}

export async function listBankAccounts() {
    const rows = await prisma.bankAccount.findMany({ orderBy: [{ isArchived: 'asc' }, { createdAt: 'asc' }] });
    return rows.map((a) => bankAccountView(a));
}

export async function getBankAccount(id: string) {
    const a = await prisma.bankAccount.findUnique({ where: { id } });
    if (!a) throw new UserError('Bank account not found', 404);
    return bankAccountView(a, true);
}

export type BankAccountInput = {
    bankName: string; accountName: string; accountNumber: string; ifsc: string; branch?: string | null;
    accountType: AccountType; owner: string; openingBalance: string; openingDate: string; parserFormat?: string | null;
    sanctionedLimit?: string | null; drawingPower?: string | null; drawingPowerAsOf?: string | null;
    interestRate?: string | null; renewalDate?: string | null; isActive?: boolean;
};

function bankAccountData(input: BankAccountInput) {
    const ifsc = (input.ifsc ?? '').trim().toUpperCase();
    // A cash box or wallet has no IFSC (F022); every bank account does.
    if (!(input.accountType === 'wallet' && !ifsc) && !isValidIfsc(ifsc)) throw new UserError('IFSC must be 4 letters, then 0, then 6 letters or digits (e.g. IDFB0080152)');
    const accountNumber = input.accountNumber.replace(/\s/g, '');
    if (!/^[A-Za-z0-9]{4,30}$/.test(accountNumber)) throw new UserError('Account number must be 4 to 30 letters or digits');
    const isCc = input.accountType === 'cash_credit';
    const sanctionedLimit = parseOptionalMoney(input.sanctionedLimit, 'Sanctioned limit');
    if (isCc && !sanctionedLimit) throw new UserError('A cash credit account needs its sanctioned limit (BR-50)');
    const interestRate = input.interestRate?.trim() ? input.interestRate.trim() : null;
    if (interestRate && !/^\d{1,2}(\.\d{1,3})?$/.test(interestRate)) throw new UserError('Interest rate must be a percentage like 9.75');
    return {
        bankName: input.bankName.trim(),
        accountName: input.accountName.trim(),
        accountNumber,
        ifsc,
        branch: input.branch?.trim() || null,
        accountType: input.accountType,
        owner: input.owner.trim(),
        openingBalance: parseMoney(input.openingBalance, 'Opening balance'),
        openingDate: parseDate(input.openingDate, 'Opening date'),
        parserFormat: input.parserFormat?.trim() || null,
        sanctionedLimit: isCc ? sanctionedLimit : null,
        drawingPower: isCc ? parseOptionalMoney(input.drawingPower, 'Drawing power') : null,
        drawingPowerAsOf: isCc ? parseOptionalDate(input.drawingPowerAsOf, 'Drawing power as of') : null,
        interestRate: interestRate ? new Decimal(interestRate) : null,
        renewalDate: isCc ? parseOptionalDate(input.renewalDate, 'Renewal date') : null,
        isActive: input.isActive ?? true,
    };
}

export async function createBankAccount(ctx: AuditContext, input: BankAccountInput) {
    const company = await getCompany();
    const data = bankAccountData(input);
    const clash = await prisma.bankAccount.findUnique({ where: { bankName_accountNumber: { bankName: data.bankName, accountNumber: data.accountNumber } } });
    if (clash) throw new UserError('This bank account is already on file');
    const a = await withAudit(ctx, (tx) => tx.bankAccount.create({ data: { ...data, entityId: company.id } }));
    return bankAccountView(a);
}

export async function updateBankAccount(ctx: AuditContext, id: string, input: BankAccountInput) {
    await getBankAccount(id);
    const a = await withAudit(ctx, (tx) => tx.bankAccount.update({ where: { id }, data: bankAccountData(input) }));
    return bankAccountView(a);
}

/** No delete: an account is archived (hidden from pickers) with a reason. */
export async function setBankAccountArchived(ctx: AuditContext, id: string, isArchived: boolean) {
    await getBankAccount(id);
    if (isArchived && !ctx.reason?.trim()) throw new UserError('Say why the account is archived');
    const a = await withAudit(ctx, (tx) => tx.bankAccount.update({ where: { id }, data: { isArchived, isActive: !isArchived } }));
    return bankAccountView(a);
}

// ---------- Tax masters (F004, F005) ----------

export async function listGstRates() {
    const rows = await prisma.gstRate.findMany({ orderBy: [{ effectiveFrom: 'desc' }, { rate: 'asc' }] });
    const today = todayIST();
    return rows.map((g) => ({
        id: g.id,
        rate: g.rate.toString(),
        effectiveFrom: dateText(g.effectiveFrom),
        effectiveTo: dateText(g.effectiveTo),
        note: g.note,
        isCurrent: dateText(g.effectiveFrom)! <= today && (!g.effectiveTo || dateText(g.effectiveTo)! >= today),
    }));
}

export async function addGstRate(ctx: AuditContext, input: { rate: string; effectiveFrom: string; note?: string | null }) {
    if (!/^\d{1,2}(\.\d{1,2})?$/.test(input.rate.trim())) throw new UserError('GST rate must be a percentage like 18 or 0.25');
    const rate = new Decimal(input.rate.trim());
    const effectiveFrom = parseDate(input.effectiveFrom, 'Effective from');
    const exists = await prisma.gstRate.findUnique({ where: { rate_effectiveFrom: { rate, effectiveFrom } } });
    if (exists) throw new UserError('This rate already starts on that date');
    await withAudit(ctx, (tx) => tx.gstRate.create({ data: { rate, effectiveFrom, note: input.note?.trim() || null } }));
    return listGstRates();
}

/** Ends a rate: it stays on old documents, new ones stop offering it. */
export async function endGstRate(ctx: AuditContext, id: string, effectiveTo: string) {
    const g = await prisma.gstRate.findUnique({ where: { id } });
    if (!g) throw new UserError('GST rate not found', 404);
    const to = parseDate(effectiveTo, 'Effective to');
    if (to < g.effectiveFrom) throw new UserError('The end date is before the start date');
    await withAudit(ctx, (tx) => tx.gstRate.update({ where: { id }, data: { effectiveTo: to } }));
    return listGstRates();
}

function tdsView(t: TdsSection) {
    return {
        id: t.id,
        codeOldAct: t.codeOldAct,
        codeNewAct: t.codeNewAct,
        nature: t.nature,
        rateIndividual: t.rateIndividual.toString(),
        rateOthers: t.rateOthers.toString(),
        rateNoPan: t.rateNoPan.toString(),
        singleThreshold: moneyText(t.singleThreshold),
        annualThreshold: moneyText(t.annualThreshold),
        thresholdNote: t.thresholdNote,
        effectiveFrom: dateText(t.effectiveFrom),
        effectiveTo: dateText(t.effectiveTo),
        verifiedByCa: t.verifiedByCa,
        isActive: t.isActive,
    };
}

export async function listTdsSections() {
    const rows = await prisma.tdsSection.findMany({ orderBy: [{ codeOldAct: 'asc' }, { nature: 'asc' }] });
    return rows.map(tdsView);
}

export type TdsSectionInput = {
    codeOldAct: string; codeNewAct?: string | null; nature: string; rateIndividual: string; rateOthers: string; rateNoPan: string;
    singleThreshold?: string | null; annualThreshold?: string | null; thresholdNote?: string | null;
    effectiveFrom: string; effectiveTo?: string | null; verifiedByCa?: boolean; isActive?: boolean;
};

function rate(v: string, field: string): Decimal {
    if (!/^\d{1,2}(\.\d{1,2})?$/.test(v.trim())) throw new UserError(`${field} must be a percentage like 2 or 0.1`);
    return new Decimal(v.trim());
}

function tdsData(input: TdsSectionInput) {
    return {
        codeOldAct: input.codeOldAct.trim().toUpperCase(),
        codeNewAct: input.codeNewAct?.trim() || null,
        nature: input.nature.trim(),
        rateIndividual: rate(input.rateIndividual, 'Rate for individual/HUF'),
        rateOthers: rate(input.rateOthers, 'Rate for others'),
        rateNoPan: rate(input.rateNoPan, 'Rate without PAN'),
        singleThreshold: parseOptionalMoney(input.singleThreshold, 'Single payment threshold'),
        annualThreshold: parseOptionalMoney(input.annualThreshold, 'FY threshold'),
        thresholdNote: input.thresholdNote?.trim() || null,
        effectiveFrom: parseDate(input.effectiveFrom, 'Effective from'),
        effectiveTo: parseOptionalDate(input.effectiveTo, 'Effective to'),
        verifiedByCa: input.verifiedByCa ?? false,
        isActive: input.isActive ?? true,
    };
}

export async function createTdsSection(ctx: AuditContext, input: TdsSectionInput) {
    const t = await withAudit(ctx, (tx) => tx.tdsSection.create({ data: tdsData(input) }));
    return tdsView(t);
}

export async function updateTdsSection(ctx: AuditContext, id: string, input: TdsSectionInput) {
    if (!(await prisma.tdsSection.findUnique({ where: { id } }))) throw new UserError('TDS section not found', 404);
    const t = await withAudit(ctx, (tx) => tx.tdsSection.update({ where: { id }, data: tdsData(input) }));
    return tdsView(t);
}

// ---------- Number series (F006, BR-30) ----------

function seriesView(s: NumberSeries) {
    return {
        id: s.id,
        docType: s.docType,
        fyLabel: s.fyLabel,
        pattern: s.pattern,
        padding: s.padding,
        nextNumber: s.nextNumber,
        nextPreview: formatDocNumber(s.pattern, s.fyLabel, s.nextNumber, s.padding),
        isActive: s.isActive,
        note: s.note,
    };
}

export async function listNumberSeries() {
    const rows = await prisma.numberSeries.findMany({ orderBy: [{ docType: 'asc' }, { fyLabel: 'desc' }] });
    return rows.map(seriesView);
}

export type NumberSeriesInput = { pattern: string; padding: number; nextNumber: number; isActive: boolean; note?: string | null };

const GST_SERIES = new Set(['tax_invoice', 'credit_note', 'proforma']);

export async function updateNumberSeries(ctx: AuditContext, id: string, input: NumberSeriesInput) {
    const s = await prisma.numberSeries.findUnique({ where: { id } });
    if (!s) throw new UserError('Number series not found', 404);
    const problem = seriesProblem({ docType: s.docType, pattern: input.pattern, padding: input.padding, fyLabel: s.fyLabel });
    if (problem) throw new UserError(problem);
    if (input.nextNumber < s.nextNumber) {
        throw new UserError(`The next number can only go up (it is ${s.nextNumber}); numbers are never reused (BR-30)`);
    }
    const preview = formatDocNumber(input.pattern, s.fyLabel, input.nextNumber, input.padding);
    const tooLong = docNumberProblem(s.docType, preview);
    if (tooLong) throw new UserError(tooLong);
    if (input.isActive && !s.isActive && GST_SERIES.has(s.docType) && !ctx.reason?.trim()) {
        throw new UserError('Switching on a sales document series needs a reason: confirm which entity invoices customers (CLAUDE.md open blocker)');
    }
    const updated = await withAudit(ctx, (tx) => tx.numberSeries.update({
        where: { id },
        data: { pattern: input.pattern.trim(), padding: input.padding, nextNumber: input.nextNumber, isActive: input.isActive, note: input.note?.trim() || null },
    }));
    return seriesView(updated);
}

// ---------- Payment terms (F009) and approval rules (F007) ----------

export async function listPaymentTerms() {
    return prisma.paymentTerm.findMany({
        orderBy: [{ sortOrder: 'asc' }, { days: 'asc' }],
        select: { id: true, label: true, days: true, isAdvance: true, isActive: true },
    });
}

export async function savePaymentTerm(ctx: AuditContext, id: string | null, input: { label: string; days: number; isAdvance: boolean; isActive: boolean }) {
    const label = input.label.trim();
    if (!label) throw new UserError('Give the term a name');
    if (!Number.isInteger(input.days) || input.days < 0 || input.days > 365) throw new UserError('Days must be a whole number from 0 to 365');
    const clash = await prisma.paymentTerm.findUnique({ where: { label } });
    if (clash && clash.id !== id) throw new UserError('A term with this name exists');
    const data = { label, days: input.isAdvance ? 0 : input.days, isAdvance: input.isAdvance, isActive: input.isActive };
    await withAudit(ctx, async (tx) => {
        if (id) await tx.paymentTerm.update({ where: { id }, data });
        else await tx.paymentTerm.create({ data: { ...data, sortOrder: 1000 + input.days } });
    });
    return listPaymentTerms();
}

export async function listApprovalRules() {
    const rows = await prisma.approvalRule.findMany({ orderBy: [{ appliesTo: 'asc' }, { amountFrom: 'asc' }] });
    return rows.map((r) => ({
        id: r.id,
        appliesTo: r.appliesTo,
        amountFrom: moneyText(r.amountFrom),
        amountTo: moneyText(r.amountTo),
        approversRequired: r.approversRequired,
        isEnabled: r.isEnabled,
    }));
}

// ---------- Period lock (F008, BR-36) ----------

/**
 * Rows in Review/Suggested for a month block the lock (BR-36). Bank transactions arrive in M2;
 * until then nothing can be in review.
 */
export type ReviewCounter = (entityId: string, monthStart: Date) => Promise<number>;
const reviewCounters: ReviewCounter[] = [];
export function registerReviewCounter(counter: ReviewCounter): void {
    reviewCounters.push(counter);
}

export async function listPeriodLocks(anyDateInFy?: string) {
    const company = await getCompany();
    const day = anyDateInFy ?? todayIST();
    const months = fyMonths(day);
    const locks = await prisma.periodLock.findMany({ where: { entityId: company.id, month: { in: months.map((m) => parseDate(m)) } } });
    const byMonth = new Map(locks.map((l) => [dateText(l.month), l]));
    const userIds = [...new Set(locks.flatMap((l) => [l.lockedBy, l.unlockedBy].filter((x): x is string => !!x)))];
    const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, firstName: true, lastName: true } });
    const names = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`]));
    const name = (id: string | null) => (id ? names.get(id) ?? id : null);
    const thisMonth = `${todayIST().slice(0, 7)}-01`;
    return {
        fy: fyLabel(day),
        months: months.map((m) => {
            const l = byMonth.get(m);
            return {
                month: m,
                isLocked: l?.isLocked ?? false,
                lockedAt: l?.lockedAt ?? null,
                lockedBy: name(l?.lockedBy ?? null),
                unlockedAt: l?.unlockedAt ?? null,
                unlockedBy: name(l?.unlockedBy ?? null),
                unlockReason: l?.unlockReason ?? null,
                // A month can be locked once it is over.
                canLock: m < thisMonth,
            };
        }),
    };
}

export async function lockMonth(ctx: AuditContext, month: string) {
    const company = await getCompany();
    const monthDate = parseDate(month, 'Month');
    if (monthDate.getUTCDate() !== 1) throw new UserError('Pick the first day of the month');
    if (month >= `${todayIST().slice(0, 7)}-01`) throw new UserError('Only a month that has ended can be locked');
    let inReview = 0;
    for (const count of reviewCounters) inReview += await count(company.id, monthDate);
    if (inReview > 0) throw new UserError(`${inReview} transaction(s) of this month are still in the review queue; clear them before locking (BR-36)`);
    await withAudit(ctx, (tx) => tx.periodLock.upsert({
        where: { entityId_month: { entityId: company.id, month: monthDate } },
        update: { isLocked: true, lockedAt: new Date(), lockedBy: ctx.userId, unlockedAt: null, unlockedBy: null, unlockReason: null },
        create: { entityId: company.id, month: monthDate, lockedBy: ctx.userId },
    }));
    return listPeriodLocks(month);
}

export async function unlockMonth(ctx: AuditContext, month: string) {
    const company = await getCompany();
    const reason = ctx.reason?.trim();
    if (!reason) throw new UserError('Unlocking a month needs a reason (BR-36)');
    const monthDate = parseDate(month, 'Month');
    const lock = await prisma.periodLock.findUnique({ where: { entityId_month: { entityId: company.id, month: monthDate } } });
    if (!lock?.isLocked) throw new UserError('This month is not locked');
    await withAudit({ ...ctx, reason }, (tx) => tx.periodLock.update({
        where: { id: lock.id },
        data: { isLocked: false, unlockedAt: new Date(), unlockedBy: ctx.userId, unlockReason: reason },
    }));
    return listPeriodLocks(month);
}
