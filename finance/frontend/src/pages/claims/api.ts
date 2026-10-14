import { useQuery } from '@tanstack/react-query';
import api from '../../api';
import type { Nature } from '../bank/ledgerApi';

/** Types of the /api/claims responses (money and dates are text). */

export type ClaimStatus = 'submitted' | 'approved' | 'reimbursed' | 'rejected' | 'cancelled';
export const CLAIM_STATUS_TONE: Record<ClaimStatus, 'gray' | 'green' | 'amber' | 'red' | 'blue'> = {
  submitted: 'amber', approved: 'blue', reimbursed: 'green', rejected: 'red', cancelled: 'gray',
};
export const CLAIM_STATUSES: [ClaimStatus, string][] = [
  ['submitted', 'Waiting for approval'], ['approved', 'To reimburse'], ['reimbursed', 'Reimbursed'], ['rejected', 'Rejected'], ['cancelled', 'Withdrawn'],
];

export type Claim = {
  id: string; founderUserId: string; founderName: string; expenseDate: string; paidFrom: string; vendorName: string; description: string | null;
  amount: string; hasGstInvoice: boolean; categoryId: string; subCategoryId: string | null; categoryName: string; subCategoryName: string | null; nature: Nature;
  status: ClaimStatus; statusLabel: string; statusReason: string | null; approvedByName: string | null; approvedAt: string | null; reimbursementId: string | null;
};
export type ClaimDetail = Claim & {
  hasReceipt: boolean;
  reimbursement: { id: string; reimbursementNo: string; paidDate: string; status: string; statusLabel: string } | null;
};
export type FounderBalance = { founderUserId: string; founderName: string; claimed: string; reimbursed: string; owed: string; waiting: string };
export type ReimbursementStatus = 'paid' | 'reconciled' | 'failed';
export const REIMBURSEMENT_TONE: Record<ReimbursementStatus, 'green' | 'amber' | 'red'> = { paid: 'amber', reconciled: 'green', failed: 'red' };
export type Reimbursement = {
  id: string; reimbursementNo: string; founderUserId: string; founderName: string; amount: string; paidDate: string; mode: string; utr: string | null;
  status: ReimbursementStatus; statusLabel: string; statusReason: string | null; bankTxnId: string | null; matchedBy: string | null;
};
export type ReimbursementDetail = Reimbursement & {
  fromAccount: string | null;
  bankRow: { id: string; txnDate: string; counterpartyName: string | null; debit: string } | null;
  claims: Claim[];
};

export function useFounders() {
  return useQuery({ queryKey: ['claim-founders'], queryFn: async () => (await api.get<{ data: { id: string; name: string }[] }>('/claims/founders')).data.data });
}
export function useClaim(id: string | undefined) {
  return useQuery({ enabled: !!id, queryKey: ['claim', id], queryFn: async () => (await api.get<{ data: ClaimDetail }>(`/claims/${id}`)).data.data });
}
/** Everything a claim change can move. */
export const CLAIM_KEYS = ['claims', 'claim', 'claim-balances', 'reimbursements', 'reimbursement', 'dashboard-home', 'dashboard-categories', 'forecast', 'ledger'];
