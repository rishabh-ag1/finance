import { useQuery } from '@tanstack/react-query';
import api from '../../api';
import type { TdsSuggestion } from '../bills/api';

/** Types of the /api/payments responses (money and dates are text). */

export type PaymentStatus = 'requested' | 'approved' | 'paid' | 'reconciled' | 'failed' | 'cancelled';
export const PAYMENT_STATUS_TONE: Record<PaymentStatus, 'gray' | 'green' | 'amber' | 'red' | 'blue'> = {
  requested: 'amber', approved: 'blue', paid: 'amber', reconciled: 'green', failed: 'red', cancelled: 'gray',
};
export const PAYMENT_STATUSES: [PaymentStatus, string][] = [
  ['requested', 'Waiting for approval'], ['approved', 'To pay'], ['paid', 'Paid, not in bank yet'], ['reconciled', 'In bank statement'], ['failed', 'Failed'], ['cancelled', 'Cancelled'],
];
export const MODES: [string, string][] = [['neft', 'NEFT'], ['rtgs', 'RTGS'], ['imps', 'IMPS'], ['upi', 'UPI'], ['ift', 'IDFC to IDFC'], ['cheque', 'Cheque'], ['cash', 'Cash'], ['other', 'Other']];

export type PaymentRow = {
  id: string; paymentNo: string | null; vendorId: string; vendorName: string; status: PaymentStatus; statusLabel: string;
  requestDate: string; paidDate: string | null; amount: string; tdsAmount: string; mode: string | null; utr: string | null; purpose: string | null; reconciled: boolean;
};

export type PaymentAllocationView = {
  id: string; docId: string | null; poId: string | null; label: string; isAdvance: boolean; gross: string; amount: string; tdsAmount: string;
  tdsRate: string; tdsSection: string | null; tdsOverrideReason: string | null; appliedTo: { id: string; label: string } | null; isArchived: boolean;
};

export type Payment = PaymentRow & {
  statusReason: string | null; notes: string | null; fromBankAccount: string | null; fromBankAccountId: string | null;
  vendorBank: { accountName: string; accountNumberMasked: string; ifsc: string; bankName: string | null } | null;
  requestedBy: string | null; paidBy: string | null; paidAt: string | null; approvals: { name: string; at: string }[]; matchedBy: string | null;
  bankRow: { id: string; txnDate: string; counterpartyName: string | null; debit: string; utr: string | null; status: string } | null;
  allocations: PaymentAllocationView[]; warnings: string[]; saveWarnings?: string[];
};

export type PaymentPreview = {
  allocations: { docId: string | null; poId: string | null; label: string; isAdvance: boolean; gross: string; amount: string; tdsAmount: string; tdsRate: string; tdsBase: string; tdsSuggestion: TdsSuggestion | null; tdsOverrideReason: string | null }[];
  amount: string; tdsAmount: string; warnings: string[];
};

export type DocPayment = { paymentId: string; paymentNo: string | null; status: PaymentStatus; statusLabel: string; paidDate: string | null; gross: string; tdsAmount: string; how: string; isArchived: boolean };

export function usePayment(id: string | undefined) {
  return useQuery({ enabled: !!id, queryKey: ['payment', id], queryFn: async () => (await api.get<{ data: Payment }>(`/payments/${id}`)).data.data });
}
