import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/database';
import { createApp } from '../src/app';
import { readCategoryMaster } from '../src/lib/categoryMaster';
import { hasDb } from './setup/db';
import { loggedInFounder, seedOnce } from './setup/fixtures';

// M1 Settings and masters: F001-F009, BR-04 seed, BR-30 series rules, BR-50 fields.
describe.skipIf(!hasDb)('M1 settings and masters', () => {
    const app = createApp();

    beforeAll(async () => { await seedOnce(); });
    afterAll(() => prisma.$disconnect());

    it('seeds once and never duplicates on a second run', async () => {
        await seedOnce();
        expect(await prisma.company.count()).toBe(1);
        expect(await prisma.bankAccount.count({ where: { bankName: 'IDFC FIRST Bank', accountNumber: '88062419345' } })).toBe(1);
        const master = readCategoryMaster();
        const subs = await prisma.subCategory.findMany({ include: { category: true } });
        for (const row of master) {
            expect(subs.filter((s) => s.category.name === row.category && s.name === row.subCategory)).toHaveLength(1);
        }
        expect(await prisma.paymentTerm.count()).toBe(7);
        expect(await prisma.approvalRule.count({ where: { isEnabled: true } })).toBe(0);
    });

    it('stamps who created a record from the logged-in user', async () => {
        const company = await prisma.company.findFirstOrThrow();
        expect(company.createdBy).toBe('system');
    });

    it('shows the company with FY 26-27 months starting in April (F002)', async () => {
        const { agent } = await loggedInFounder(app);
        const r = await agent.get('/api/settings/company');
        expect(r.status).toBe(200);
        expect(r.body.data).toMatchObject({ gstin: '29AAJCE7255M1ZX', pan: 'AAJCE7255M', stateCode: '29', incorporationDate: '2026-05-22' });
        expect(r.body.data.fy.months[0]).toMatch(/-04-01$/);
    });

    it('takes PAN and state from the GSTIN and rejects a bad checksum (BR-15)', async () => {
        const { agent } = await loggedInFounder(app);
        const current = (await agent.get('/api/settings/company')).body.data;
        const bad = await agent.put('/api/settings/company').send({ ...current, gstin: '29AAJCE7255M1ZY' });
        expect(bad.status).toBe(400);
        expect(bad.body.error).toMatch(/checksum/);
    });

    it('masks account numbers in the list and keeps money as text', async () => {
        const { agent } = await loggedInFounder(app);
        const r = await agent.get('/api/settings/bank-accounts');
        const idfc = r.body.data.find((a: { bankName: string }) => a.bankName === 'IDFC FIRST Bank');
        expect(idfc.accountNumberMasked).toBe('•••• 9345');
        expect(idfc.accountNumber).toBeUndefined();
        expect(idfc.openingBalance).toBe('0.00');
    });

    it('needs a sanctioned limit for a cash credit account and works out headroom (BR-50)', async () => {
        const { agent } = await loggedInFounder(app);
        const base = {
            bankName: 'Punjab National Bank', accountName: 'Entelechy Labs Private Limited', accountNumber: `CC${Date.now()}`,
            ifsc: 'PUNB0114510', accountType: 'cash_credit', owner: 'Entelechy', openingBalance: '0', openingDate: '2026-11-01',
        };
        const missing = await agent.post('/api/settings/bank-accounts').send(base);
        expect(missing.status).toBe(400);
        expect(missing.body.error).toMatch(/sanctioned limit/);

        const ok = await agent.post('/api/settings/bank-accounts').send({ ...base, sanctionedLimit: '20,00,000', drawingPower: '1500000' });
        expect(ok.status).toBe(200);
        expect(ok.body.data.headroomIfUndrawn).toBe('1500000.00');
    });

    it('refuses to delete a bank account; archiving needs a reason', async () => {
        const { agent } = await loggedInFounder(app);
        const idfc = (await agent.get('/api/settings/bank-accounts')).body.data[0];
        expect((await agent.delete(`/api/bank-accounts/${idfc.id}`)).status).toBe(409);
        expect((await agent.post(`/api/settings/bank-accounts/${idfc.id}/archive`).send({ isArchived: true })).status).toBe(400);
    });

    it('lets a series number go up but never down (BR-30)', async () => {
        const { agent } = await loggedInFounder(app);
        const po = (await agent.get('/api/settings/number-series')).body.data.find((s: { docType: string }) => s.docType === 'purchase_order');
        const n: number = po.nextNumber;
        expect(po.nextPreview).toBe(`ELPL/PO/${po.fyLabel}/${String(n).padStart(3, '0')}`);

        const up = await agent.put(`/api/settings/number-series/${po.id}`).send({ ...po, nextNumber: n + 1 });
        expect(up.status).toBe(200);
        expect(up.body.data.nextPreview).toBe(`ELPL/PO/${po.fyLabel}/${String(n + 1).padStart(3, '0')}`);

        const down = await agent.put(`/api/settings/number-series/${po.id}`).send({ ...po, nextNumber: n });
        expect(down.status).toBe(400);

        // The database refuses it too, whatever the code path.
        await expect(prisma.$transaction(async (tx) => {
            await tx.$queryRaw`select set_config('finance.user_id', 'tester', true)`;
            await tx.numberSeries.update({ where: { id: po.id }, data: { nextNumber: n } });
        })).rejects.toThrow(/cannot go down/);
    });

    it('keeps the tax invoice series off until a reason confirms the invoicing entity', async () => {
        const { agent } = await loggedInFounder(app);
        const inv = (await agent.get('/api/settings/number-series')).body.data.find((s: { docType: string }) => s.docType === 'tax_invoice');
        // Seeded off. The test database is never wiped and the invoice tests switch it on and back off,
        // so the next number depends on earlier runs; its format does not.
        expect(inv.isActive).toBe(false);
        expect(inv.nextPreview).toMatch(/^ELPL\/\d{2}-\d{2}\/\d{5}$/);
        const r = await agent.put(`/api/settings/number-series/${inv.id}`).send({ ...inv, isActive: true });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/entity/);
    });

    it('seeds TDS sections unverified and shows both GST rate sets', async () => {
        const { agent } = await loggedInFounder(app);
        const tds = (await agent.get('/api/settings/tds-sections')).body.data;
        expect(tds.every((t: { verifiedByCa: boolean }) => !t.verifiedByCa)).toBe(true);
        expect(tds.find((t: { codeOldAct: string; nature: string }) => t.codeOldAct === '194C')).toMatchObject({ rateIndividual: '1', rateOthers: '2' });
        const gst = (await agent.get('/api/settings/gst-rates')).body.data;
        expect(gst.filter((g: { isCurrent: boolean }) => g.isCurrent).map((g: { rate: string }) => g.rate)).toEqual(['0', '5', '18', '40']);
    });

    it('adds a sub-category whose nature differs from its category', async () => {
        const { agent } = await loggedInFounder(app);
        const cats = (await agent.get('/api/categories')).body.data;
        const marketing = cats.find((c: { name: string }) => c.name === 'Marketing');
        const r = await agent.post('/api/categories/sub').send({ categoryId: marketing.id, name: `Trade show stand ${Date.now()}`, nature: 'capex', isActive: true });
        expect(r.status).toBe(200);
        const sub = r.body.data.find((c: { name: string }) => c.name === 'Marketing').subCategories.find((s: { name: string }) => s.name.startsWith('Trade show stand'));
        expect(sub).toMatchObject({ natureOverride: 'capex', nature: 'capex' });
    });
});
