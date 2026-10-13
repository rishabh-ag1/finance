import { prisma } from '../config/database';
import { dateText } from '../lib/dates';
import { documentChecklist } from './vendor.service';

/**
 * F161 Missing documents report: records that should hold a file but do not. In Phase 1:
 * vendors missing a required document (F036) and imported statements whose file was not kept.
 * Bills without an invoice copy, payments without proof and challans without a PDF join with
 * their records in Phase 2.
 */
export async function missingDocuments() {
  const active = await prisma.attachment.findMany({ where: { isArchived: false }, select: { recordType: true, recordId: true, docKind: true } });
  const kinds = new Map<string, Set<string>>();
  for (const a of active) {
    const key = `${a.recordType}:${a.recordId}`;
    if (!kinds.has(key)) kinds.set(key, new Set());
    kinds.get(key)!.add(a.docKind);
  }

  const vendors = await prisma.vendor.findMany({ where: { isArchived: false, status: { in: ['active', 'pending_review', 'draft'] } }, orderBy: { displayName: 'asc' } });
  const vendorRows = vendors
    .map((v) => ({
      recordType: 'Vendor' as const,
      recordId: v.id,
      label: v.displayName,
      detail: v.status === 'active' ? 'Active vendor' : `Vendor (${v.status.replace('_', ' ')})`,
      missing: documentChecklist(v, kinds.get(`Vendor:${v.id}`)).filter((d) => d.required && !d.present).map((d) => d.label),
      link: `/vendors/${v.id}`,
    }))
    .filter((r) => r.missing.length > 0);

  const batches = await prisma.bankImportBatch.findMany({ include: { bankAccount: true }, orderBy: { importedAt: 'desc' } });
  const batchRows = batches
    .filter((b) => !kinds.get(`BankImportBatch:${b.id}`)?.has('statement'))
    .map((b) => ({
      recordType: 'BankImportBatch' as const,
      recordId: b.id,
      label: b.fileName,
      detail: `${b.bankAccount.bankName} statement ${dateText(b.periodFrom)} to ${dateText(b.periodTo)}`,
      missing: ['Bank statement file'],
      link: `/imports/${b.id}`,
    }));

  const rows = [...vendorRows, ...batchRows];
  return { count: rows.length, rows };
}
