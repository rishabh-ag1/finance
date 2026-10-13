export type VendorType = 'goods' | 'services' | 'both';
export type MsmeType = 'micro' | 'small' | 'medium' | 'none';
export type VendorStatus = 'draft' | 'pending_review' | 'active' | 'blocked';
export type DeducteeType = 'individual' | 'huf' | 'company' | 'firm' | 'others' | 'unknown';

export type VendorListRow = {
  id: string; displayName: string; vendorType: VendorType; gstin: string | null; pan: string | null; state: string | null;
  msmeType: MsmeType; tdsSection: string | null; status: VendorStatus; isArchived: boolean; paidThisFy: string;
  lastPayment: string | null; pendingBankChange: boolean; bankRecentlyChanged: boolean;
};

export type BankVersion = {
  id: string; accountName: string; accountNumberMasked: string; ifsc: string; bankName: string | null; branch: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'superseded'; requestedBy: string; requestedById: string; requestedAt: string;
  decidedBy: string | null; decidedAt: string | null; decisionNote: string | null; validFrom: string | null; validTo: string | null;
};

export type Vendor = {
  id: string; displayName: string; legalName: string | null; tradeName: string | null; vendorType: VendorType;
  gstRegistered: boolean; gstin: string | null; pan: string | null; deducteeType: DeducteeType; deducteeLabel: string;
  addressLine1: string | null; addressLine2: string | null; city: string | null; state: string | null; stateCode: string | null;
  pincode: string | null; contactName: string | null; phone: string | null; email: string | null; defaultTdsSectionId: string | null;
  ldcNumber: string | null; ldcRate: string | null; ldcValidFrom: string | null; ldcValidTo: string | null; ldcLimit: string | null;
  msmeType: MsmeType; udyamNo: string | null; defaultCategoryId: string | null; defaultSubCategoryId: string | null;
  paymentTermId: string | null; bankNames: string[]; notes: string | null; status: VendorStatus; statusReason: string | null;
  isArchived: boolean; currentBank: BankVersion | null; bankHistory: BankVersion[];
  documents: { kind: string; label: string; required: boolean; present: boolean }[];
  warnings: string[];
  payments: {
    fy: string; paidThisFy: string; paidAllTime: string;
    rows: { id: string; txnDate: string; debit: string; credit: string; narrationRaw: string; counterpartyName: string | null; utr: string | null; status: string; description: string | null }[];
  };
};

export const STATUS_CHIP: Record<VendorStatus, { text: string; tone: 'gray' | 'green' | 'amber' | 'red' | 'blue' }> = {
  draft: { text: 'Draft', tone: 'gray' },
  pending_review: { text: 'Pending review', tone: 'amber' },
  active: { text: 'Active', tone: 'green' },
  blocked: { text: 'Blocked', tone: 'red' },
};

export const MSME_LABEL: Record<MsmeType, string> = { micro: 'Micro', small: 'Small', medium: 'Medium', none: 'Not MSME' };
export const TYPE_LABEL: Record<VendorType, string> = { goods: 'Goods', services: 'Services', both: 'Goods and services' };
