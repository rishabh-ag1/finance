import { createHash, randomBytes } from 'crypto';
import { prisma } from '../config/database';
import { withAudit, type AuditContext } from '../lib/audit';
import { dateText } from '../lib/dates';
import { UserError } from '../lib/http';
import { download } from './attachment.service';
import { draftFromOrder } from './d2c.service';
import { getDoc, issueDoc, previewPdf } from './sales.service';

/**
 * F105 Invoice API for the CRM. Sales issue invoices from the CRM screen, but numbering, tax maths,
 * templates and the register live here. The CRM authenticates with a key (only its hash is kept)
 * and names the CRM user on every call; every call is logged with that user and the CRM order.
 */

const hash = (key: string) => createHash('sha256').update(key).digest('hex');

export async function listKeys() {
  const keys = await prisma.crmApiKey.findMany({ orderBy: { createdAt: 'desc' } });
  const users = new Map((await prisma.user.findMany({ where: { id: { in: keys.map((k) => k.actsAsUserId) } }, select: { id: true, firstName: true, lastName: true } })).map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));
  return keys.map((k) => ({ id: k.id, name: k.name, keyPrefix: k.keyPrefix, actsAs: users.get(k.actsAsUserId) ?? null, lastUsedAt: k.lastUsedAt, revokedAt: k.revokedAt, revokedReason: k.revokedReason, createdAt: k.createdAt }));
}

/** A new key, shown once. The CRM's calls are recorded under the founder who made it. */
export async function createKey(ctx: AuditContext, name: string) {
  if (!name.trim()) throw new UserError('Name the key (for example "CRM production")');
  const key = `fin_${randomBytes(24).toString('hex')}`;
  const row = await withAudit({ ...ctx, reason: ctx.reason ?? `CRM API key "${name.trim()}" made` }, (tx) =>
    tx.crmApiKey.create({ data: { name: name.trim(), keyPrefix: key.slice(0, 10), keyHash: hash(key), actsAsUserId: ctx.userId } }));
  return { id: row.id, name: row.name, keyPrefix: row.keyPrefix, key };
}

export async function revokeKey(ctx: AuditContext, id: string) {
  const k = await prisma.crmApiKey.findUnique({ where: { id } });
  if (!k) throw new UserError('Key not found', 404);
  if (k.revokedAt) throw new UserError('This key is already revoked');
  const reason = ctx.reason?.trim();
  if (!reason) throw new UserError('Say why the key is revoked');
  await withAudit({ ...ctx, reason }, (tx) => tx.crmApiKey.update({ where: { id }, data: { revokedAt: new Date(), revokedReason: reason } }));
  return listKeys();
}

/** The key behind a request, or null. */
export async function keyFor(raw: string | undefined) {
  if (!raw || !raw.startsWith('fin_')) return null;
  const k = await prisma.crmApiKey.findUnique({ where: { keyHash: hash(raw.trim()) } });
  return k && !k.revokedAt ? k : null;
}

export async function logCall(f: { keyId: string | null; actsAs: string | null; crmUser: string | null; method: string; path: string; crmOrderNumber: string | null; docId: string | null; docNumber: string | null; statusCode: number; error: string | null }) {
  // A call with no valid key has no Finance user to record it under: it goes to the server log only.
  if (!f.actsAs) { console.warn(`CRM API refused: ${f.method} ${f.path} ${f.statusCode} ${f.error ?? ''}`); return; }
  await withAudit({ userId: f.actsAs, reason: `CRM API ${f.method} ${f.path}` }, async (tx) => {
    await tx.crmApiCall.create({ data: { keyId: f.keyId, crmUser: f.crmUser, method: f.method, path: f.path, crmOrderNumber: f.crmOrderNumber, docId: f.docId, docNumber: f.docNumber, statusCode: f.statusCode, error: f.error } });
    if (f.keyId) await tx.crmApiKey.update({ where: { id: f.keyId }, data: { lastUsedAt: new Date() } });
  });
}

export async function listCalls(f: { orderNumber?: string } = {}) {
  const rows = await prisma.crmApiCall.findMany({ where: f.orderNumber ? { crmOrderNumber: f.orderNumber } : {}, orderBy: { createdAt: 'desc' }, take: 200 });
  return rows.map((r) => ({ id: r.id, at: r.createdAt, crmUser: r.crmUser, method: r.method, path: r.path, crmOrderNumber: r.crmOrderNumber, docId: r.docId, docNumber: r.docNumber, statusCode: r.statusCode, error: r.error }));
}

// ---------- What the CRM can do ----------

type ApiCtx = AuditContext & { crmUser: string };
const pdfPath = (id: string) => `/api/integrations/crm/v1/documents/${id}/pdf`;

/** The CRM's view of a document: number, status, totals and where to fetch the PDF. */
export function apiDoc(d: Awaited<ReturnType<typeof getDoc>>) {
  return {
    id: d.id, docType: d.docType, docNumber: d.docNumber, status: d.status, docDate: d.docDate, crmOrderNumber: d.crmOrderNumber, supplyType: d.supplyType,
    customerName: (d.billTo as { name: string }).name, taxable: d.taxable, tax: d.tax, total: d.total, pdfUrl: pdfPath(d.id), problems: d.problems,
  };
}

/** Create a proforma or tax invoice for a CRM order, priced as the order; issue it straight away if asked. */
export async function apiCreate(ctx: ApiCtx, input: { orderNumber: string; docType: 'proforma' | 'tax_invoice'; docDate?: string | null; issue?: boolean; salesPerson?: string | null }) {
  const reason = `CRM: ${ctx.crmUser} on order ${input.orderNumber}`;
  const { doc } = await draftFromOrder({ userId: ctx.userId, reason }, { orderNumber: input.orderNumber, docType: input.docType, docDate: input.docDate, salesPerson: input.salesPerson ?? ctx.crmUser, source: 'crm_api' });
  if (!input.issue) return apiDoc(doc);
  return apiDoc(await issueDoc({ userId: ctx.userId, reason }, doc.id));
}

async function orderDoc(id: string) {
  const d = await prisma.salesDocument.findUnique({ where: { id } });
  // The CRM sees documents made for its orders only.
  if (!d || !d.crmOrderNumber) throw new UserError('Document not found', 404);
  return d;
}

export async function apiIssue(ctx: ApiCtx, id: string) {
  const d = await orderDoc(id);
  return apiDoc(await issueDoc({ userId: ctx.userId, reason: `CRM: ${ctx.crmUser} on order ${d.crmOrderNumber}` }, id));
}

export async function apiGet(id: string) {
  await orderDoc(id);
  return apiDoc(await getDoc(id));
}

export async function apiOrderDocs(orderNumber: string) {
  const rows = await prisma.salesDocument.findMany({ where: { crmOrderNumber: orderNumber, status: { not: 'discarded' } }, orderBy: { createdAt: 'asc' } });
  return rows.map((d) => ({ id: d.id, docType: d.docType, docNumber: d.docNumber, status: d.status, docDate: dateText(d.docDate), total: d.total.toFixed(2), pdfUrl: pdfPath(d.id) }));
}

/** The frozen PDF of an issued document, or a draft preview. */
export async function apiPdf(id: string) {
  const d = await orderDoc(id);
  if (d.pdfAttachmentId) {
    const f = await download(d.pdfAttachmentId);
    return { pdf: f.content, name: f.fileName };
  }
  return { pdf: await previewPdf(id), name: 'draft.pdf' };
}
