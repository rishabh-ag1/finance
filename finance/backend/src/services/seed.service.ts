import type { Tx } from '../lib/audit';
import { groupCategoryMaster, readCategoryMaster } from '../lib/categoryMaster';
import { parseDate } from '../lib/dates';
import { fyLabel, todayIST } from '../lib/fy';
import { Decimal } from '../lib/money';

/**
 * Phase 1 master data. Every step only creates what is missing, so re-running the seed never
 * overwrites a value someone changed in Settings.
 */

// CLAUDE.md "Legal entity details". TAN is not on file yet.
const COMPANY = {
    legalName: 'Entelechy Labs Private Limited',
    brandName: 'Bloc',
    cin: 'U20211KA2026PTC221356',
    pan: 'AAJCE7255M',
    gstin: '29AAJCE7255M1ZX',
    udyamNo: 'UDYAM-KR-03-0704964',
    registeredAddress: 'Innov8 Mantri Commercio, Tower A, 5th Floor, Bellandur, Bengaluru 560103, Karnataka',
    stateCode: '29',
    fyStartMonth: 4,
    incorporationDate: parseDate('2026-05-22'),
    email: 'finance@blocinsects.com',
};

// IDFC is the only business account (Q6). Opening balance 0 the day before the first credit.
const IDFC = {
    bankName: 'IDFC FIRST Bank',
    accountName: 'Entelechy Labs Private Limited',
    accountNumber: '88062419345',
    ifsc: 'IDFB0080152',
    branch: 'Koramangala',
    accountType: 'business_current' as const,
    owner: 'Entelechy',
    openingBalance: new Decimal(0),
    openingDate: parseDate('2026-05-29'),
    parserFormat: 'idfc_v1',
};

// F004 lists 0/5/12/18/28. GST rates were rationalised from 22 Sep 2025 (12% and 28% removed,
// 40% added), so both sets are kept with their dates. [Verify] with the CA.
const GST_RATES: { rate: string; from: string; to: string | null; note: string }[] = [
    ...['0', '5', '12', '18', '28'].map((rate) => ({ rate, from: '2017-07-01', to: '2025-09-21', note: 'Rates before the Sep 2025 rationalisation' })),
    ...['0', '5', '18', '40'].map((rate) => ({ rate, from: '2025-09-22', to: null, note: '[Verify] Rates from 22 Sep 2025 rationalisation' })),
];

// F005, Q15: old-Act sections and values (as amended to FY 25-26), carried into FY 26-27 until
// the CA confirms the Income-tax Act 2025 section numbers and values. All [Verify].
const TDS_FROM = '2026-04-01';
const TDS_SECTIONS = [
    { codeOldAct: '194C', nature: 'Contract work', rateIndividual: '1', rateOthers: '2', rateNoPan: '20', singleThreshold: '30000', annualThreshold: '100000', thresholdNote: 'Single payment above 30,000 or FY total above 1,00,000' },
    { codeOldAct: '194J', nature: 'Professional fees', rateIndividual: '10', rateOthers: '10', rateNoPan: '20', singleThreshold: null, annualThreshold: '50000', thresholdNote: 'FY total above 50,000' },
    { codeOldAct: '194J', nature: 'Fees for technical services', rateIndividual: '2', rateOthers: '2', rateNoPan: '20', singleThreshold: null, annualThreshold: '50000', thresholdNote: 'FY total above 50,000' },
    { codeOldAct: '194I', nature: 'Rent - land, building, furniture', rateIndividual: '10', rateOthers: '10', rateNoPan: '20', singleThreshold: '50000', annualThreshold: null, thresholdNote: 'Rent above 50,000 per month or part of a month' },
    { codeOldAct: '194I', nature: 'Rent - plant and machinery', rateIndividual: '2', rateOthers: '2', rateNoPan: '20', singleThreshold: '50000', annualThreshold: null, thresholdNote: 'Rent above 50,000 per month or part of a month' },
    { codeOldAct: '194H', nature: 'Commission or brokerage', rateIndividual: '2', rateOthers: '2', rateNoPan: '20', singleThreshold: null, annualThreshold: '20000', thresholdNote: 'FY total above 20,000' },
];

// Documents & Numbering. Starting numbers are 1: a series can be raised later but never lowered.
// Tax invoice, credit note and proforma stay switched off until the invoicing entity is
// confirmed (CLAUDE.md "Open blocker").
const SERIES: { docType: string; pattern: string; padding: number; perFy: boolean; isActive: boolean; note: string | null }[] = [
    { docType: 'purchase_order', pattern: 'ELPL/PO/{FY}/{N}', padding: 3, perFy: true, isActive: true, note: 'FY format from now (Q8). Existing ELPL/PO/2026/001 stays as is. Confirm the starting number.' },
    { docType: 'proforma', pattern: 'ELPL/PI/{FY}/{N}', padding: 4, perFy: true, isActive: false, note: 'Off until the invoicing entity is confirmed.' },
    { docType: 'tax_invoice', pattern: 'ELPL/{FY}/{N}', padding: 5, perFy: true, isActive: false, note: 'Off until the invoicing entity is confirmed. One series for B2B and B2C (D2).' },
    { docType: 'credit_note', pattern: 'ELCN/{FY}/{N}', padding: 4, perFy: true, isActive: false, note: 'Off until the invoicing entity is confirmed.' },
    { docType: 'payment', pattern: 'PMT-{N}', padding: 4, perFy: false, isActive: true, note: 'Never resets. Set the next number when the Payment-Out Log is migrated (Phase 2).' },
    { docType: 'receipt', pattern: 'RCT-{N}', padding: 4, perFy: false, isActive: true, note: 'Never resets.' },
];

const PAYMENT_TERMS = [
    { label: 'Advance', days: 0, isAdvance: true },
    { label: 'On receipt', days: 0, isAdvance: false },
    { label: 'On delivery', days: 0, isAdvance: false },
    { label: 'Net 7', days: 7, isAdvance: false },
    { label: 'Net 15', days: 15, isAdvance: false },
    { label: 'Net 30', days: 30, isAdvance: false },
    { label: 'Net 45', days: 45, isAdvance: false },
];

// BR-26 / Q9: provision only. The bands from the v1 default are kept, all switched off.
const APPROVAL_BANDS = [
    { amountFrom: '0', amountTo: '25000', approversRequired: 1 },
    { amountFrom: '25000', amountTo: '200000', approversRequired: 1 },
    { amountFrom: '200000', amountTo: null, approversRequired: 2 },
];

export async function seedMasters(tx: Tx): Promise<{ companyId: string }> {
    const company = (await tx.company.findFirst()) ?? (await tx.company.create({ data: COMPANY }));

    await tx.bankAccount.upsert({
        where: { bankName_accountNumber: { bankName: IDFC.bankName, accountNumber: IDFC.accountNumber } },
        update: {},
        create: { ...IDFC, entityId: company.id },
    });

    for (const g of GST_RATES) {
        const from = parseDate(g.from);
        await tx.gstRate.upsert({
            where: { rate_effectiveFrom: { rate: new Decimal(g.rate), effectiveFrom: from } },
            update: {},
            create: { rate: new Decimal(g.rate), effectiveFrom: from, effectiveTo: g.to ? parseDate(g.to) : null, note: g.note },
        });
    }

    for (const s of TDS_SECTIONS) {
        const effectiveFrom = parseDate(TDS_FROM);
        await tx.tdsSection.upsert({
            where: { codeOldAct_nature_effectiveFrom: { codeOldAct: s.codeOldAct, nature: s.nature, effectiveFrom } },
            update: {},
            create: {
                ...s,
                rateIndividual: new Decimal(s.rateIndividual),
                rateOthers: new Decimal(s.rateOthers),
                rateNoPan: new Decimal(s.rateNoPan),
                singleThreshold: s.singleThreshold ? new Decimal(s.singleThreshold) : null,
                annualThreshold: s.annualThreshold ? new Decimal(s.annualThreshold) : null,
                effectiveFrom,
                verifiedByCa: false,
            },
        });
    }

    const fy = fyLabel(todayIST());
    for (const s of SERIES) {
        const fyValue = s.perFy ? fy : null;
        const existing = await tx.numberSeries.findFirst({ where: { entityId: company.id, docType: s.docType, fyLabel: fyValue } });
        if (!existing) {
            await tx.numberSeries.create({
                data: { entityId: company.id, docType: s.docType, fyLabel: fyValue, pattern: s.pattern, padding: s.padding, isActive: s.isActive, note: s.note },
            });
        }
    }

    for (const [i, t] of PAYMENT_TERMS.entries()) {
        await tx.paymentTerm.upsert({ where: { label: t.label }, update: {}, create: { ...t, sortOrder: (i + 1) * 10 } });
    }

    if ((await tx.approvalRule.count()) === 0) {
        for (const appliesTo of ['purchase_order', 'payment']) {
            for (const b of APPROVAL_BANDS) {
                await tx.approvalRule.create({
                    data: {
                        appliesTo,
                        amountFrom: new Decimal(b.amountFrom),
                        amountTo: b.amountTo ? new Decimal(b.amountTo) : null,
                        approversRequired: b.approversRequired,
                        isEnabled: false,
                    },
                });
            }
        }
    }

    await seedCategories(tx);
    await seedRules(tx);
    return { companyId: company.id };
}

/**
 * Default categorisation rules (F017). Each comes from a decision already in the docs:
 * BR-05 (OPT/CBDT), A6 / BR-04 (Mesa loan), A8 / BR-29 (Newera Living), A7 / D6 (tooling as
 * Capex), Category Master notes (VideAim, Quick Shape, Makenica, Trinity NDT, founder funds).
 * Added once; edits in the Rules page are never overwritten.
 */
export const DEFAULT_RULES: {
    name: string; priority: number; matchField: string; operator: string; matchValue: string; direction: 'debit' | 'credit' | null;
    category: string; sub: string; partyType: 'vendor' | 'founder' | 'lender' | 'govt' | 'other'; description?: string;
}[] = [
    { name: 'OPT/CBDT', priority: 10, matchField: 'narration', operator: 'starts_with', matchValue: 'OPT/CBDT', direction: 'debit', category: 'Taxes', sub: 'TDS Deposit', partyType: 'govt' },
    { name: 'Mesa loan (Neos Kosmos)', priority: 20, matchField: 'counterparty_name', operator: 'contains', matchValue: 'NEOS KOSMOS', direction: 'credit', category: 'Financing', sub: 'Loan Received', partyType: 'lender' },
    { name: 'Newera Living', priority: 30, matchField: 'counterparty_name', operator: 'contains', matchValue: 'NEWERA LIVING', direction: null, category: 'Related Party', sub: 'Newera Living Transfer', partyType: 'other' },
    { name: 'Founder funds - Rishabh', priority: 40, matchField: 'counterparty_name', operator: 'contains', matchValue: 'RISHABH', direction: 'credit', category: 'Founder Funds', sub: 'Investment - Rishabh', partyType: 'founder' },
    { name: 'Founder funds - Arnav', priority: 41, matchField: 'counterparty_name', operator: 'contains', matchValue: 'ARNAV', direction: 'credit', category: 'Founder Funds', sub: 'Investment - Arnav', partyType: 'founder' },
    { name: 'Tooling - Saiffi', priority: 50, matchField: 'counterparty_name', operator: 'contains', matchValue: 'SAIFFI', direction: 'debit', category: 'Capex', sub: 'Tooling & Moulds', partyType: 'vendor' },
    { name: 'Tooling - Micro Instruments', priority: 51, matchField: 'counterparty_name', operator: 'contains', matchValue: 'MICRO INSTRUMENTS', direction: 'debit', category: 'Capex', sub: 'Tooling & Moulds', partyType: 'vendor' },
    { name: 'Tooling - Valco', priority: 52, matchField: 'counterparty_name', operator: 'contains', matchValue: 'VALCO', direction: 'debit', category: 'Capex', sub: 'Tooling & Moulds', partyType: 'vendor' },
    { name: 'Design patent - VideAim', priority: 60, matchField: 'counterparty_name', operator: 'contains', matchValue: 'VIDEAIM', direction: 'debit', category: 'Capex', sub: 'Design Registration / Patents', partyType: 'vendor' },
    { name: 'Prototyping - Quick Shape', priority: 70, matchField: 'counterparty_name', operator: 'contains', matchValue: 'QUICK SHAPE', direction: 'debit', category: 'R&D', sub: 'Prototyping / 3D Printing', partyType: 'vendor' },
    { name: 'Prototyping - Makenica', priority: 71, matchField: 'counterparty_name', operator: 'contains', matchValue: 'MAKENICA', direction: 'debit', category: 'R&D', sub: 'Prototyping / 3D Printing', partyType: 'vendor' },
    { name: 'Lab testing - Trinity NDT', priority: 80, matchField: 'counterparty_name', operator: 'contains', matchValue: 'TRINITY NDT', direction: 'debit', category: 'R&D', sub: 'Electrical / Lab Testing', partyType: 'vendor' },
];

export async function seedRules(tx: Tx): Promise<void> {
    for (const r of DEFAULT_RULES) {
        if (await tx.categorizationRule.findFirst({ where: { name: r.name, isSeeded: true } })) continue;
        const category = await tx.category.findUnique({ where: { name: r.category } });
        const sub = category && await tx.subCategory.findUnique({ where: { categoryId_name: { categoryId: category.id, name: r.sub } } });
        if (!category || !sub) throw new Error(`Default rule "${r.name}": ${r.category} > ${r.sub} is not in the Category Master`);
        await tx.categorizationRule.create({
            data: {
                name: r.name, priority: r.priority, matchField: r.matchField, operator: r.operator, matchValue: r.matchValue,
                direction: r.direction, setCategoryId: category.id, setSubCategoryId: sub.id, setPartyType: r.partyType,
                setDescription: r.description ?? null, isSeeded: true,
            },
        });
    }
}

/** Category Master from docs/spec.md: adds missing categories and sub-categories only. */
export async function seedCategories(tx: Tx): Promise<void> {
    for (const c of groupCategoryMaster(readCategoryMaster())) {
        const category = await tx.category.upsert({
            where: { name: c.name },
            update: {},
            create: { name: c.name, natureDefault: c.natureDefault, sortOrder: c.sortOrder },
        });
        for (const [i, s] of c.subs.entries()) {
            await tx.subCategory.upsert({
                where: { categoryId_name: { categoryId: category.id, name: s.name } },
                update: {},
                create: {
                    categoryId: category.id,
                    name: s.name,
                    natureOverride: s.natureOverride,
                    plGroup: s.plGroup || null,
                    note: s.note || null,
                    sortOrder: (i + 1) * 10,
                },
            });
        }
    }
}
