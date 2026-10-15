import { useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../../api';

/** Ledger and review API shapes and hooks (money is text). */

export type Nature =
  | 'operating_income' | 'operating_expense' | 'cogs' | 'capex' | 'financing_in' | 'financing_out' | 'interest'
  | 'tax_payment' | 'advance' | 'transfer' | 'related_party' | 'refund_reversal' | 'reimbursement';
export type PartyType = 'vendor' | 'customer' | 'founder' | 'lender' | 'govt' | 'own_account' | 'other';
export type TxnStatus = 'review' | 'suggested' | 'categorised' | 'matched' | 'split' | 'transfer' | 'ignored';
export type RelatedPartyType = 'business_transfer' | 'director_loan' | 'capital' | 'undecided';

export const NATURE_LABEL: Record<Nature, string> = {
  operating_income: 'Operating Income', operating_expense: 'Operating Expense', cogs: 'COGS', capex: 'Capex',
  financing_in: 'Financing In', financing_out: 'Financing Out', interest: 'Interest', tax_payment: 'Tax Payment',
  advance: 'Advance', transfer: 'Transfer', related_party: 'Related Party', refund_reversal: 'Refund/Reversal', reimbursement: 'Reimbursement',
};
export const PARTY_LABEL: Record<PartyType, string> = {
  vendor: 'Vendor', customer: 'Customer', founder: 'Founder', lender: 'Lender', govt: 'Government', own_account: 'Own account', other: 'Other',
};
export const STATUS_LABEL: Record<TxnStatus, { text: string; tone: 'gray' | 'green' | 'amber' | 'red' | 'blue' }> = {
  review: { text: 'Review', tone: 'amber' },
  suggested: { text: 'Suggested', tone: 'blue' },
  categorised: { text: 'Categorised', tone: 'green' },
  matched: { text: 'Matched', tone: 'green' },
  split: { text: 'Split', tone: 'green' },
  transfer: { text: 'Transfer', tone: 'gray' },
  ignored: { text: 'Ignored', tone: 'gray' },
};
export const RELATED_LABEL: Record<RelatedPartyType, string> = {
  undecided: 'Undecided (ask the CA)', business_transfer: 'Business transfer', director_loan: 'Director loan', capital: 'Capital',
};

export type Split = { id: string; lineNo: number; amount: string; categoryId: string; subCategoryId: string | null; nature: Nature; partyType: PartyType | null; description: string | null; note: string | null };

export type LedgerTxn = {
  id: string; bankAccountId: string; bankName: string; accountNumberMasked: string; txnDate: string; narrationRaw: string;
  debit: string; credit: string; balance: string | null; isManual?: boolean; parseOk: boolean; mode: string | null; modeDetail: string | null;
  utr: string | null; counterpartyName: string | null; counterpartyIfsc: string | null; counterpartyAccount: string | null;
  remark: string | null; description: string | null; categoryId: string | null; subCategoryId: string | null; nature: Nature | null;
  partyType: PartyType | null; status: TxnStatus; categorisationReason: string | null; notes: string | null;
  relatedPartyType: RelatedPartyType | null; transferPairId: string | null; splits: Split[];
  linkedDocType: string | null; linkedDocId: string | null;
};

export type TxnDetail = LedgerTxn & { pair: { id: string; bankName: string; txnDate: string; debit: string; credit: string } | null };

export type LedgerPage = {
  totals: { count: number; inflow: string; outflow: string; net: string };
  rows: LedgerTxn[];
  nextOffset: number | null;
};

export type Category = {
  id: string; name: string; natureDefault: Nature; isActive: boolean;
  subCategories: { id: string; name: string; nature: Nature; isActive: boolean }[];
};

export function useCategories() {
  return useQuery({
    queryKey: ['categories'],
    queryFn: async () => (await api.get<{ data: Category[] }>('/categories')).data.data,
    staleTime: 60_000,
  });
}

/** "Capex › Tooling & Moulds" for a row. */
export function categoryText(cats: Category[] | undefined, categoryId: string | null, subCategoryId: string | null): string | null {
  if (!categoryId) return null;
  const c = cats?.find((x) => x.id === categoryId);
  if (!c) return null;
  const s = c.subCategories.find((x) => x.id === subCategoryId);
  return s ? `${c.name} › ${s.name}` : c.name;
}

export function useReviewCount() {
  return useQuery({
    queryKey: ['review-count'],
    queryFn: async () => (await api.get<{ data: { count: number } }>('/bank/review-count')).data.data.count,
    refetchInterval: 60_000,
  });
}

/** Refresh everything a change to a bank row can affect. */
export function useRefreshBank() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['ledger'] });
    qc.invalidateQueries({ queryKey: ['txn'] });
    qc.invalidateQueries({ queryKey: ['review-count'] });
    qc.invalidateQueries({ queryKey: ['bank-import'] });
    qc.invalidateQueries({ queryKey: ['audit'] });
  };
}

export const isZero = (v: string) => /^0+(\.0+)?$/.test(v);
