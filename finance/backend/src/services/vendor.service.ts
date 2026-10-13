import type { MsmeType, Prisma, Vendor, VendorBankAccount, VendorStatus, VendorType } from '@prisma/client';
import { prisma } from '../config/database';
import { withAudit, type AuditContext } from '../lib/audit';
import { dateText, parseOptionalDate } from '../lib/dates';
import { deducteeTypeFromPan, DEDUCTEE_LABEL } from '../lib/deductee';
import { fyRange, todayIST } from '../lib/fy';
import { GST_STATE_CODES, gstinParts, isValidIfsc, isValidPan } from '../lib/gstin';
import { UserError } from '../lib/http';
import { Decimal, moneyText, parseOptionalMoney } from '../lib/money';
import { getCompany } from './settings.service';
import { listAttachments, presentKinds } from './attachment.service';

/**
 * M03 Vendors (F030-F038). PAN, state and deductee type come from the GSTIN / PAN, never typed
 * separately (BR-12, BR-15). Bank details change only through a request that another founder
 * approves once the vendor is active (BR-16); every version is kept.
 */

export const BANK_CHANGE_WARNING_DAYS = 30;

export type VendorInput = {
  displayName: string;
  legalName?: string | null;
  tradeName?: string | null;
  vendorType: VendorType;
  gstin?: string | null;
  /** Only for vendors without a GSTIN. */
  pan?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  contactName?: string | null;
  phone?: string | null;
  email?: string | null;
  defaultTdsSectionId?: string | null;
  ldcNumber?: string | null;
  ldcRate?: string | null;
  ldcValidFrom?: string | null;
  ldcValidTo?: string | null;
  ldcLimit?: string | null;
  msmeType?: MsmeType;
  udyamNo?: string | null;
  defaultCategoryId?: string | null;
  defaultSubCategoryId?: string | null;
  paymentTermId?: string | null;
  bankNames?: string[];
  notes?: string | null;
};

const text = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

/** Validates and normalises a vendor form (BR-12, BR-15). */
async function vendorData(input: VendorInput) {
  const gstin = text(input.gstin)?.toUpperCase() ?? null;
  let pan: string | null;
  let stateCode: string | null = null;
  let state = text(input.state);
  if (gstin) {
    try {
      const parts = gstinParts(gstin);
      pan = parts.pan;
      stateCode = parts.stateCode;
      state = parts.stateName;
    } catch (e) {
      throw new UserError((e as Error).message);
    }
    if (input.pan && input.pan.trim().toUpperCase() !== pan) throw new UserError(`PAN must be ${pan}, the PAN inside the GSTIN (BR-15)`);
  } else {
    pan = text(input.pan)?.toUpperCase() ?? null;
    if (pan && !isValidPan(pan)) throw new UserError('PAN must be 5 letters, 4 digits, 1 letter (e.g. ANJPA3053F)');
    if (state) {
      const code = Object.entries(GST_STATE_CODES).find(([, name]) => name.toLowerCase() === state!.toLowerCase())?.[0];
      stateCode = code ?? null;
    }
  }
  const pincode = text(input.pincode)?.replace(/\D/g, '') ?? null;
  if (pincode && !/^[1-9][0-9]{5}$/.test(pincode)) throw new UserError('PIN code must be 6 digits and cannot start with 0');
  const email = text(input.email);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new UserError('Email address does not look right');
  const msmeType = input.msmeType ?? 'none';
  const udyamNo = text(input.udyamNo)?.toUpperCase() ?? null;
  if (udyamNo && !/^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/.test(udyamNo)) throw new UserError('Udyam number looks like UDYAM-KR-03-0704964');
  if (msmeType !== 'none' && !udyamNo) throw new UserError('An MSME vendor needs its Udyam number');
  const ldcRate = text(input.ldcRate);
  if (ldcRate && !/^\d{1,2}(\.\d{1,2})?$/.test(ldcRate)) throw new UserError('Lower deduction rate must be a percentage like 0.5');

  if (input.defaultSubCategoryId) {
    const sub = await prisma.subCategory.findUnique({ where: { id: input.defaultSubCategoryId } });
    if (!sub || sub.categoryId !== input.defaultCategoryId) throw new UserError('The default sub-category belongs to another category');
  }
  const bankNames = [...new Set((input.bankNames ?? []).map((n) => n.trim().toUpperCase()).filter((n) => n.length >= 3))];

  return {
    displayName: input.displayName.trim(),
    legalName: text(input.legalName),
    tradeName: text(input.tradeName),
    vendorType: input.vendorType,
    gstRegistered: !!gstin,
    gstin,
    pan,
    deducteeType: deducteeTypeFromPan(pan),
    addressLine1: text(input.addressLine1),
    addressLine2: text(input.addressLine2),
    city: text(input.city),
    state,
    stateCode,
    pincode,
    contactName: text(input.contactName),
    phone: text(input.phone),
    email,
    defaultTdsSectionId: text(input.defaultTdsSectionId),
    ldcNumber: text(input.ldcNumber),
    ldcRate: ldcRate ? new Decimal(ldcRate) : null,
    ldcValidFrom: parseOptionalDate(input.ldcValidFrom, 'Certificate valid from'),
    ldcValidTo: parseOptionalDate(input.ldcValidTo, 'Certificate valid to'),
    ldcLimit: parseOptionalMoney(input.ldcLimit, 'Certificate limit'),
    msmeType,
    udyamNo,
    defaultCategoryId: text(input.defaultCategoryId),
    defaultSubCategoryId: text(input.defaultSubCategoryId),
    paymentTermId: text(input.paymentTermId),
    bankNames,
    notes: text(input.notes),
  };
}

async function gstinTaken(gstin: string | null, exceptId?: string) {
  if (!gstin) return;
  const other = await prisma.vendor.findFirst({ where: { gstin, isArchived: false, ...(exceptId && { id: { not: exceptId } }) } });
  if (other) throw new UserError(`${other.displayName} already has this GSTIN`);
}

export async function createVendor(ctx: AuditContext, input: VendorInput & { activate?: boolean }) {
  const company = await getCompany();
  const data = await vendorData(input);
  if (!data.displayName) throw new UserError('Give the vendor a name');
  await gstinTaken(data.gstin);
  const v = await withAudit(ctx, (tx) => tx.vendor.create({ data: { ...data, entityId: company.id, status: input.activate ? 'active' : 'draft' } }));
  return getVendor(v.id);
}

export async function updateVendor(ctx: AuditContext, id: string, input: VendorInput) {
  await loadVendor(id);
  const data = await vendorData(input);
  await gstinTaken(data.gstin, id);
  await withAudit(ctx, (tx) => tx.vendor.update({ where: { id }, data }));
  return getVendor(id);
}

const NEXT_STATUS: Record<VendorStatus, VendorStatus[]> = {
  draft: ['pending_review', 'active'],
  pending_review: ['active', 'draft'],
  active: ['blocked'],
  blocked: ['active'],
};

/** Vendor Status Flow (docs/spec.md): Draft -> Pending Review / Active -> Blocked (with reason) -> Active. */
export async function setVendorStatus(ctx: AuditContext, id: string, status: VendorStatus) {
  const v = await loadVendor(id);
  if (!NEXT_STATUS[v.status].includes(status)) throw new UserError(`A ${v.status.replace('_', ' ')} vendor cannot become ${status.replace('_', ' ')}`);
  if (status === 'blocked' && !ctx.reason?.trim()) throw new UserError('Say why the vendor is blocked');
  await withAudit(ctx, (tx) => tx.vendor.update({ where: { id }, data: { status, statusReason: status === 'blocked' ? ctx.reason!.trim() : null } }));
  return getVendor(id);
}

export async function archiveVendor(ctx: AuditContext, id: string) {
  await loadVendor(id);
  if (!ctx.reason?.trim()) throw new UserError('Say why the vendor is archived');
  await withAudit(ctx, (tx) => tx.vendor.update({ where: { id }, data: { isArchived: true } }));
  return getVendor(id);
}

async function loadVendor(id: string) {
  const v = await prisma.vendor.findUnique({ where: { id } });
  if (!v) throw new UserError('Vendor not found', 404);
  return v;
}

// ---------- Bank details (F035, BR-16) ----------

export type BankInput = { accountName: string; accountNumber: string; ifsc: string; bankName?: string | null; branch?: string | null };

/**
 * New bank details for a vendor. The first account of a vendor that is not active yet is
 * approved straight away (onboarding). Any other change waits for another founder (BR-16);
 * a newer request replaces an older pending one.
 */
export async function requestBankChange(ctx: AuditContext, vendorId: string, input: BankInput) {
  const v = await loadVendor(vendorId);
  const ifsc = input.ifsc.trim().toUpperCase();
  if (!isValidIfsc(ifsc)) throw new UserError('IFSC must be 4 letters, then 0, then 6 letters or digits');
  const accountNumber = input.accountNumber.replace(/\s/g, '');
  if (!/^[0-9A-Za-z]{6,30}$/.test(accountNumber)) throw new UserError('Account number must be 6 to 30 letters or digits');
  if (!input.accountName.trim()) throw new UserError('Account holder name is needed');
  const current = await prisma.vendorBankAccount.findFirst({ where: { vendorId, status: 'approved' } });
  if (current && current.accountNumber === accountNumber && current.ifsc === ifsc) throw new UserError('These are already the vendor\'s bank details');
  const onboarding = !current && v.status !== 'active' && v.status !== 'blocked';
  const now = new Date();

  await withAudit({ ...ctx, reason: onboarding ? 'First bank account at onboarding' : 'Bank details change requested' }, async (tx) => {
    await tx.vendorBankAccount.updateMany({
      where: { vendorId, status: 'pending' },
      data: { status: 'rejected', decidedBy: ctx.userId, decidedAt: now, decisionNote: 'Replaced by a newer request' },
    });
    await tx.vendorBankAccount.create({
      data: {
        vendorId,
        accountName: input.accountName.trim(),
        accountNumber,
        ifsc,
        bankName: text(input.bankName),
        branch: text(input.branch),
        requestedBy: ctx.userId,
        ...(onboarding
          ? { status: 'approved', decidedBy: ctx.userId, decidedAt: now, decisionNote: 'First account at onboarding', validFrom: now }
          : { status: 'pending' }),
      },
    });
  });
  return getVendor(vendorId);
}

/** BR-16: another founder approves or rejects a pending change. Approval supersedes the old account. */
export async function decideBankChange(ctx: AuditContext, bankAccountId: string, approve: boolean, note?: string | null) {
  const b = await prisma.vendorBankAccount.findUnique({ where: { id: bankAccountId } });
  if (!b) throw new UserError('Bank details not found', 404);
  if (b.status !== 'pending') throw new UserError('This change was already decided');
  if (b.requestedBy === ctx.userId) throw new UserError('Another founder must approve bank details you entered (BR-16: protects against invoice-redirection fraud)', 403);
  if (!approve && !note?.trim()) throw new UserError('Say why the change is rejected');
  const now = new Date();
  await withAudit({ ...ctx, reason: note?.trim() || (approve ? 'Bank details approved' : undefined) }, async (tx) => {
    if (approve) {
      await tx.vendorBankAccount.updateMany({ where: { vendorId: b.vendorId, status: 'approved' }, data: { status: 'superseded', validTo: now } });
    }
    await tx.vendorBankAccount.update({
      where: { id: b.id },
      data: { status: approve ? 'approved' : 'rejected', decidedBy: ctx.userId, decidedAt: now, decisionNote: note?.trim() || null, ...(approve && { validFrom: now }) },
    });
  });
  return getVendor(b.vendorId);
}

/** BR-16 warning: the current details replaced older ones less than 30 days ago. */
export function bankRecentlyChanged(accounts: VendorBankAccount[], now = new Date()): boolean {
  const current = accounts.find((a) => a.status === 'approved');
  if (!current?.validFrom || !accounts.some((a) => a.status === 'superseded')) return false;
  return now.getTime() - current.validFrom.getTime() < BANK_CHANGE_WARNING_DAYS * 86_400_000;
}

// ---------- Documents checklist (F036) ----------

/** What a vendor file should hold (F036); present = an active attachment of that kind (M15). */
export function documentChecklist(v: Pick<Vendor, 'gstRegistered' | 'msmeType'>, present: Set<string> = new Set()) {
  return [
    { kind: 'gst_cert', label: 'GST certificate', required: v.gstRegistered },
    { kind: 'pan', label: 'PAN card', required: true },
    { kind: 'cancelled_cheque', label: 'Cancelled cheque', required: true },
    { kind: 'msme_cert', label: 'Udyam (MSME) certificate', required: v.msmeType !== 'none' },
    { kind: 'agreement', label: 'Agreement / NDA', required: false },
  ].map((d) => ({ ...d, present: present.has(d.kind) }));
}

// ---------- Reading (F030, F038) ----------

const mask = (n: string) => `•••• ${n.slice(-4)}`;

function bankView(b: VendorBankAccount, names: Map<string, string>) {
  return {
    id: b.id,
    accountName: b.accountName,
    accountNumberMasked: mask(b.accountNumber),
    ifsc: b.ifsc,
    bankName: b.bankName,
    branch: b.branch,
    status: b.status,
    requestedBy: names.get(b.requestedBy) ?? b.requestedBy,
    requestedById: b.requestedBy,
    requestedAt: b.requestedAt,
    decidedBy: b.decidedBy ? names.get(b.decidedBy) ?? b.decidedBy : null,
    decidedAt: b.decidedAt,
    decisionNote: b.decisionNote,
    validFrom: b.validFrom,
    validTo: b.validTo,
  };
}

/** Bank rows that belong to a vendor: linked to it, or paid to one of its bank names. */
function vendorTxnWhere(v: Pick<Vendor, 'id' | 'bankNames'>): Prisma.BankTxnWhereInput {
  return {
    OR: [
      { partyId: v.id },
      ...v.bankNames.map((n) => ({ counterpartyName: { contains: n, mode: 'insensitive' as const } })),
    ],
  };
}

export async function listVendors(f: { q?: string; status?: VendorStatus; includeArchived?: boolean }) {
  const vendors = await prisma.vendor.findMany({
    where: {
      ...(f.includeArchived ? {} : { isArchived: false }),
      ...(f.status && { status: f.status }),
      ...(f.q && {
        OR: [
          { displayName: { contains: f.q, mode: 'insensitive' } },
          { legalName: { contains: f.q, mode: 'insensitive' } },
          { gstin: { contains: f.q.toUpperCase() } },
          { pan: { contains: f.q.toUpperCase() } },
        ],
      }),
    },
    orderBy: { displayName: 'asc' },
    include: { bankAccounts: true },
  });
  const fy = fyRange(todayIST());
  const tds = new Map((await prisma.tdsSection.findMany()).map((t) => [t.id, `${t.codeOldAct} ${t.nature}`]));
  const out = [];
  for (const v of vendors) {
    const paid = await prisma.bankTxn.aggregate({
      where: { AND: [vendorTxnWhere(v), { debit: { gt: 0 }, status: { not: 'ignored' }, txnDate: { gte: new Date(`${fy.from}T00:00:00Z`), lte: new Date(`${fy.to}T00:00:00Z`) } }] },
      _sum: { debit: true },
      _max: { txnDate: true },
    });
    out.push({
      id: v.id,
      displayName: v.displayName,
      vendorType: v.vendorType,
      gstin: v.gstin,
      pan: v.pan,
      state: v.state,
      msmeType: v.msmeType,
      tdsSection: v.defaultTdsSectionId ? tds.get(v.defaultTdsSectionId) ?? null : null,
      status: v.status,
      isArchived: v.isArchived,
      paidThisFy: moneyText(paid._sum.debit ?? new Decimal(0)),
      lastPayment: dateText(paid._max.txnDate),
      pendingBankChange: v.bankAccounts.some((b) => b.status === 'pending'),
      bankRecentlyChanged: bankRecentlyChanged(v.bankAccounts),
    });
  }
  return { fy: fy.label, vendors: out };
}

export async function getVendor(id: string) {
  const v = await prisma.vendor.findUnique({ where: { id }, include: { bankAccounts: { orderBy: { requestedAt: 'desc' } } } });
  if (!v) throw new UserError('Vendor not found', 404);
  const userIds = [...new Set(v.bankAccounts.flatMap((b) => [b.requestedBy, b.decidedBy].filter((x): x is string => !!x)))];
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, firstName: true, lastName: true } });
  const names = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`]));

  const txns = await prisma.bankTxn.findMany({ where: vendorTxnWhere(v), orderBy: [{ txnDate: 'desc' }, { seq: 'desc' }], take: 200 });
  const fy = fyRange(todayIST());
  const paid = txns.filter((t) => t.debit.greaterThan(0) && t.status !== 'ignored');
  const sum = (rows: typeof txns) => rows.reduce((s, t) => s.plus(t.debit), new Decimal(0));
  const inFy = paid.filter((t) => dateText(t.txnDate)! >= fy.from && dateText(t.txnDate)! <= fy.to);
  const checklist = documentChecklist(v, await presentKinds('Vendor', v.id));

  const current = v.bankAccounts.find((b) => b.status === 'approved') ?? null;
  const warnings: string[] = [];
  if (bankRecentlyChanged(v.bankAccounts)) warnings.push(`Bank details changed less than ${BANK_CHANGE_WARNING_DAYS} days ago. Confirm with the vendor by phone before paying (BR-16).`);
  if (v.bankAccounts.some((b) => b.status === 'pending')) warnings.push('A bank details change is waiting for another founder\'s approval.');
  if (!current) warnings.push('No approved bank details on file.');
  if (v.deducteeType === 'unknown') warnings.push('No PAN on file: TDS would be at the higher no-PAN rate.');
  const missing = checklist.filter((d) => d.required && !d.present).map((d) => d.label);
  if (missing.length) warnings.push(`Documents missing: ${missing.join(', ')}.`);
  if (v.status === 'blocked') warnings.push(`Blocked: ${v.statusReason}`);

  return {
    id: v.id,
    displayName: v.displayName,
    legalName: v.legalName,
    tradeName: v.tradeName,
    vendorType: v.vendorType,
    gstRegistered: v.gstRegistered,
    gstin: v.gstin,
    pan: v.pan,
    deducteeType: v.deducteeType,
    deducteeLabel: DEDUCTEE_LABEL[v.deducteeType],
    addressLine1: v.addressLine1,
    addressLine2: v.addressLine2,
    city: v.city,
    state: v.state,
    stateCode: v.stateCode,
    pincode: v.pincode,
    contactName: v.contactName,
    phone: v.phone,
    email: v.email,
    defaultTdsSectionId: v.defaultTdsSectionId,
    ldcNumber: v.ldcNumber,
    ldcRate: v.ldcRate?.toString() ?? null,
    ldcValidFrom: dateText(v.ldcValidFrom),
    ldcValidTo: dateText(v.ldcValidTo),
    ldcLimit: moneyText(v.ldcLimit),
    msmeType: v.msmeType,
    udyamNo: v.udyamNo,
    defaultCategoryId: v.defaultCategoryId,
    defaultSubCategoryId: v.defaultSubCategoryId,
    paymentTermId: v.paymentTermId,
    bankNames: v.bankNames,
    notes: v.notes,
    status: v.status,
    statusReason: v.statusReason,
    isArchived: v.isArchived,
    currentBank: current ? bankView(current, names) : null,
    bankHistory: v.bankAccounts.map((b) => bankView(b, names)),
    documents: checklist,
    attachments: await listAttachments('Vendor', v.id),
    warnings,
    payments: {
      fy: fy.label,
      paidThisFy: moneyText(sum(inFy)),
      paidAllTime: moneyText(sum(paid)),
      rows: txns.map((t) => ({
        id: t.id, txnDate: dateText(t.txnDate), debit: moneyText(t.debit), credit: moneyText(t.credit),
        narrationRaw: t.narrationRaw, counterpartyName: t.counterpartyName, utr: t.utr, status: t.status, description: t.description,
      })),
    },
  };
}
