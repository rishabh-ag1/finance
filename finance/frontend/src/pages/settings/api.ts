import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../../api';

/** Types of the /api/settings responses (money, rates and dates are text). */

export type FyInfo = { startMonth: number; current: { from: string; to: string; label: string }; quarter: number; months: string[] };
export type Company = {
  id: string; legalName: string; brandName: string | null; cin: string | null; pan: string; tan: string | null; gstin: string;
  udyamNo: string | null; registeredAddress: string; stateCode: string; email: string | null; phone: string | null;
  incorporationDate: string | null; taxInvoiceChaseDays: number; fy: FyInfo;
};
export type AccountType = 'business_current' | 'cash_credit' | 'founder_personal' | 'loan' | 'wallet' | 'card';
export type BankAccount = {
  id: string; bankName: string; accountName: string; accountNumberMasked: string; accountNumber?: string; ifsc: string;
  branch: string | null; accountType: AccountType; owner: string; openingBalance: string; openingDate: string;
  parserFormat: string | null; sanctionedLimit: string | null; drawingPower: string | null; drawingPowerAsOf: string | null;
  interestRate: string | null; renewalDate: string | null; headroomIfUndrawn: string | null; isActive: boolean; isArchived: boolean;
};
export type GstRate = { id: string; rate: string; effectiveFrom: string; effectiveTo: string | null; note: string | null; isCurrent: boolean };
export type TdsSection = {
  id: string; codeOldAct: string; codeNewAct: string | null; nature: string; rateIndividual: string; rateOthers: string; rateNoPan: string;
  singleThreshold: string | null; annualThreshold: string | null; thresholdNote: string | null; effectiveFrom: string;
  effectiveTo: string | null; verifiedByCa: boolean; isActive: boolean;
};
export type NumberSeries = {
  id: string; docType: string; fyLabel: string | null; pattern: string; padding: number; nextNumber: number;
  nextPreview: string; isActive: boolean; note: string | null;
};
export type PaymentTerm = { id: string; label: string; days: number; isAdvance: boolean; isActive: boolean };
export type ApprovalRule = { id: string; appliesTo: string; amountFrom: string; amountTo: string | null; approversRequired: number; isEnabled: boolean };
export type PeriodMonth = {
  month: string; isLocked: boolean; lockedAt: string | null; lockedBy: string | null; unlockedAt: string | null;
  unlockedBy: string | null; unlockReason: string | null; canLock: boolean;
};

export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  business_current: 'Business current',
  cash_credit: 'Cash credit',
  founder_personal: 'Founder personal',
  loan: 'Loan',
  wallet: 'Wallet (Razorpay, Shiprocket)',
  card: 'Card',
};

export const DOC_TYPE_LABEL: Record<string, string> = {
  purchase_order: 'Purchase order',
  proforma: 'Proforma invoice',
  tax_invoice: 'Tax invoice',
  credit_note: 'Credit note',
  payment: 'Payment voucher',
  receipt: 'Receipt voucher',
};

export function useSettings<T>(path: string) {
  return useQuery({
    queryKey: ['settings', path],
    queryFn: async () => (await api.get<{ success: boolean; data: T }>(`/settings/${path}`)).data.data,
  });
}

/** POST/PUT to a settings endpoint, then refresh that endpoint's data. */
export function useSettingsMutation<TBody, TResult = unknown>(path: string, method: 'post' | 'put' = 'post', refresh: string[] = []) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ url, body }: { url?: string; body: TBody }) =>
      (await api[method]<{ success: boolean; data: TResult }>(`/settings/${url ?? path}`, body)).data.data,
    onSuccess: () => {
      for (const p of [path, ...refresh]) qc.invalidateQueries({ queryKey: ['settings', p] });
    },
  });
}

/** "2026-06-01" -> "Jun 2026" */
export function monthLabel(iso: string): string {
  const [y, m] = iso.split('-');
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]} ${y}`;
}

/** "2026-05-22" -> "22 May 2026" */
export function dateLabel(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${Number(d)} ${monthLabel(`${y}-${m}-01`).split(' ')[0]} ${y}`;
}
