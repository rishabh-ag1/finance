import crypto from 'node:crypto';
import path from 'node:path';
import type { Attachment } from '@prisma/client';
import { prisma } from '../config/database';
import { withAudit, type AuditContext } from '../lib/audit';
import { dateText } from '../lib/dates';
import { fyLabel, todayIST } from '../lib/fy';
import { UserError } from '../lib/http';
import { activeStorage, storageFor } from '../storage';

/**
 * M15 Documents vault (F160, F161). Any record can hold files; they are filed under
 * /Finance/{FY}/{Module}/{Record} and named automatically. Attachments are never deleted:
 * removing one archives it with a reason and keeps the file.
 */

export const MAX_BYTES = 15 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.csv': 'text/csv',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export const DOC_KIND_LABEL: Record<string, string> = {
  gst_cert: 'GST certificate',
  pan: 'PAN card',
  cancelled_cheque: 'Cancelled cheque',
  msme_cert: 'Udyam certificate',
  agreement: 'Agreement',
  statement: 'Bank statement',
  proof: 'Proof',
  bill: 'Bill',
  receipt: 'Receipt',
  invoice_pdf: 'Invoice',
  logo: 'Logo',
  signature: 'Signature',
  po_pdf: 'Purchase order',
  quote: 'Quote',
  challan: 'Challan',
  form16a: 'Form 16A',
  other: 'Document',
};

/** Letters, digits and dashes only, so names work in Drive, Windows and URLs. */
export function slug(text: string, max = 40): string {
  return text.normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '') || 'file';
}

export type RecordContext = {
  /** Folder: /Finance/{fy}/{module}/{record} */
  fy: string;
  module: string;
  record: string;
  /** Start of the file name. */
  nameBase: string;
};

export function folderPathFor(c: RecordContext): string {
  return `/Finance/${c.fy}/${c.module}/${slug(c.record, 60)}`;
}

/** F160 naming: {record}_{kind}.{ext}, e.g. Saiffi-Industries_GST-certificate.pdf. */
export function fileNameFor(c: RecordContext, docKind: string, originalName: string): string {
  const ext = path.extname(originalName).toLowerCase();
  return `${slug(c.nameBase, 60)}_${slug(DOC_KIND_LABEL[docKind] ?? docKind)}${ext}`;
}

/** Where a record's files go, and that the record exists. */
export async function recordContext(recordType: string, recordId: string): Promise<RecordContext> {
  switch (recordType) {
    case 'Vendor': {
      const v = await prisma.vendor.findUnique({ where: { id: recordId } });
      if (!v) throw new UserError('Vendor not found', 404);
      return { fy: fyLabel(todayIST()), module: 'Vendors', record: v.displayName, nameBase: v.displayName };
    }
    case 'BankTxn': {
      const t = await prisma.bankTxn.findUnique({ where: { id: recordId } });
      if (!t) throw new UserError('Transaction not found', 404);
      const day = dateText(t.txnDate)!;
      const party = t.counterpartyName ?? t.mode ?? 'bank';
      const amount = (t.debit.greaterThan(0) ? t.debit : t.credit).toFixed(0);
      return { fy: fyLabel(day), module: 'Bank', record: `${day} ${party}`, nameBase: `${day}_${party}_${amount}` };
    }
    case 'BankImportBatch': {
      const b = await prisma.bankImportBatch.findUnique({ where: { id: recordId }, include: { bankAccount: true } });
      if (!b) throw new UserError('Import not found', 404);
      const from = dateText(b.periodFrom)!;
      const to = dateText(b.periodTo)!;
      const name = `${b.bankAccount.bankName.split(' ')[0]} ${from} to ${to}`;
      return { fy: fyLabel(from), module: 'Bank statements', record: name, nameBase: name };
    }
    case 'PurchaseOrder': {
      const po = await prisma.purchaseOrder.findUnique({ where: { id: recordId }, include: { vendor: true } });
      if (!po) throw new UserError('Purchase order not found', 404);
      const record = po.poNumber ?? `Draft ${po.id.slice(-6)}`;
      return { fy: fyLabel(dateText(po.poDate)!), module: 'Purchase orders', record, nameBase: `${record}_${po.vendor.displayName}` };
    }
    case 'VendorDocument': {
      const d = await prisma.vendorDocument.findUnique({ where: { id: recordId }, include: { vendor: true } });
      if (!d) throw new UserError('Document not found', 404);
      const record = `${d.vendor.displayName} ${d.docNumber}`;
      return { fy: d.fyLabel, module: 'Vendor bills', record, nameBase: `${d.vendor.displayName}_${d.docNumber}` };
    }
    case 'PaymentOut': {
      const p = await prisma.paymentOut.findUnique({ where: { id: recordId }, include: { vendor: true } });
      if (!p) throw new UserError('Payment not found', 404);
      const record = p.paymentNo ?? `Request ${p.id.slice(-6)}`;
      return { fy: fyLabel(dateText(p.paidDate ?? p.requestDate)!), module: 'Payments', record, nameBase: `${record}_${p.vendor.displayName}` };
    }
    case 'TdsChallan': {
      const c = await prisma.tdsChallan.findUnique({ where: { id: recordId } });
      if (!c) throw new UserError('Challan not found', 404);
      const record = `Challan ${c.bsrCode}-${c.challanSerial} ${dateText(c.depositDate)}`;
      return { fy: fyLabel(dateText(c.depositDate)!), module: 'TDS', record, nameBase: record };
    }
    case 'TdsCertificate': {
      const c = await prisma.tdsCertificate.findUnique({ where: { id: recordId } });
      if (!c) throw new UserError('Certificate not found', 404);
      const v = await prisma.vendor.findUniqueOrThrow({ where: { id: c.vendorId } });
      const record = `Form 16A Q${c.quarter} ${c.fyLabel} ${v.displayName}`;
      return { fy: c.fyLabel, module: 'TDS', record, nameBase: record };
    }
    case 'SalesDocument': {
      const d = await prisma.salesDocument.findUnique({ where: { id: recordId } });
      if (!d) throw new UserError('Document not found', 404);
      const day = dateText(d.docDate)!;
      const who = (d.billTo as { name?: string }).name ?? 'customer';
      const record = d.docNumber ?? `Draft ${d.id.slice(-6)}`;
      return { fy: d.fyLabel ?? fyLabel(day), module: 'Sales documents', record, nameBase: `${record}_${who}` };
    }
    case 'InvoiceTemplate': {
      return { fy: fyLabel(todayIST()), module: 'Settings', record: 'Invoice template', nameBase: 'Invoice-template' };
    }
    case 'ReconImport': {
      const i = await prisma.reconImport.findUnique({ where: { id: recordId } });
      if (!i) throw new UserError('Import not found', 404);
      const day = dateText(i.createdAt)!;
      const record = `${i.source === 'razorpay' ? 'Razorpay' : 'Shiprocket'} ${i.kind} ${day}`;
      return { fy: fyLabel(day), module: 'Order-to-bank', record, nameBase: record };
    }
    case 'ExpenseClaim': {
      const c = await prisma.expenseClaim.findUnique({ where: { id: recordId } });
      if (!c) throw new UserError('Claim not found', 404);
      const u = await prisma.user.findUniqueOrThrow({ where: { id: c.founderUserId } });
      const day = dateText(c.expenseDate)!;
      const record = `${day} ${u.firstName} ${c.vendorName}`;
      return { fy: fyLabel(day), module: 'Founder claims', record, nameBase: `${record}_${c.amount.toFixed(0)}` };
    }
    case 'Reimbursement': {
      const r = await prisma.reimbursement.findUnique({ where: { id: recordId } });
      if (!r) throw new UserError('Reimbursement not found', 404);
      const u = await prisma.user.findUniqueOrThrow({ where: { id: r.founderUserId } });
      const record = `${r.reimbursementNo} ${u.firstName}`;
      return { fy: fyLabel(dateText(r.paidDate)!), module: 'Founder claims', record, nameBase: record };
    }
    default:
      throw new UserError(`Files cannot be attached to ${recordType}`);
  }
}

export type UploadInput = { recordType: string; recordId: string; docKind: string; fileName: string; contentBase64: string; note?: string | null };

export function attachmentView(a: Attachment, names?: Map<string, string>) {
  return {
    id: a.id,
    recordType: a.recordType,
    recordId: a.recordId,
    docKind: a.docKind,
    docKindLabel: DOC_KIND_LABEL[a.docKind] ?? a.docKind,
    fileName: a.fileName,
    originalName: a.originalName,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    storage: a.storage,
    folderPath: a.folderPath,
    note: a.note,
    uploadedBy: names?.get(a.uploadedBy) ?? a.uploadedBy,
    uploadedAt: a.createdAt,
    isArchived: a.isArchived,
    archivedReason: a.archivedReason,
  };
}

/** F160: stores the file, then records it (audited). */
export async function upload(ctx: AuditContext, input: UploadInput) {
  if (!DOC_KIND_LABEL[input.docKind]) throw new UserError('Unknown document type');
  const ext = path.extname(input.fileName).toLowerCase();
  const mimeType = MIME_BY_EXT[ext];
  if (!mimeType) throw new UserError(`${ext || 'This file type'} cannot be attached. Use PDF, an image (JPG, PNG, WEBP, HEIC), CSV, Excel or Word.`);
  const content = Buffer.from(input.contentBase64, 'base64');
  if (content.length === 0) throw new UserError('The file is empty');
  if (content.length > MAX_BYTES) throw new UserError(`The file is ${(content.length / 1024 / 1024).toFixed(1)} MB; the limit is 15 MB`);

  const context = await recordContext(input.recordType, input.recordId);
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  const same = await prisma.attachment.findFirst({ where: { recordType: input.recordType, recordId: input.recordId, sha256, isArchived: false } });
  if (same) throw new UserError(`This file is already attached as ${same.fileName}`);

  const folderPath = folderPathFor(context);
  const fileName = fileNameFor(context, input.docKind, input.fileName);
  const storage = activeStorage();
  const stored = await storage.put(folderPath, fileName, mimeType, content);
  const a = await withAudit({ ...ctx, reason: ctx.reason ?? 'File attached' }, (tx) => tx.attachment.create({
    data: {
      recordType: input.recordType,
      recordId: input.recordId,
      docKind: input.docKind,
      fileName,
      originalName: input.fileName,
      mimeType,
      sizeBytes: content.length,
      sha256,
      storage: stored.storage,
      storageKey: stored.storageKey,
      folderPath,
      note: input.note?.trim() || null,
      uploadedBy: ctx.userId,
    },
  }));
  return attachmentView(a);
}

export async function listAttachments(recordType: string, recordId: string, includeArchived = false) {
  const rows = await prisma.attachment.findMany({
    where: { recordType, recordId, ...(includeArchived ? {} : { isArchived: false }) },
    orderBy: { createdAt: 'desc' },
  });
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.uploadedBy))] } }, select: { id: true, firstName: true, lastName: true } });
  const names = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`]));
  return rows.map((a) => attachmentView(a, names));
}

export async function download(id: string): Promise<{ content: Buffer; mimeType: string; fileName: string }> {
  const a = await prisma.attachment.findUnique({ where: { id } });
  if (!a) throw new UserError('File not found', 404);
  return { content: await storageFor(a.storage).get(a.storageKey), mimeType: a.mimeType, fileName: a.fileName };
}

/** Removing an attachment archives it with a reason (no hard deletes); the file stays in storage. */
export async function archive(ctx: AuditContext, id: string) {
  const a = await prisma.attachment.findUnique({ where: { id } });
  if (!a) throw new UserError('File not found', 404);
  if (a.isArchived) throw new UserError('This file is already removed');
  const reason = ctx.reason?.trim();
  if (!reason) throw new UserError('Say why the file is removed');
  const updated = await withAudit({ ...ctx, reason }, (tx) => tx.attachment.update({ where: { id }, data: { isArchived: true, archivedReason: reason } }));
  return attachmentView(updated);
}

/** The kinds of active files a record has, for checklists. */
export async function presentKinds(recordType: string, recordId: string): Promise<Set<string>> {
  const rows = await prisma.attachment.findMany({ where: { recordType, recordId, isArchived: false }, select: { docKind: true } });
  return new Set(rows.map((r) => r.docKind));
}
