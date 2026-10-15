/** Types of the /api/funding, /api/loans and /api/capital responses (money and dates are text). */

export const FUNDING_KEYS = ['funding', 'loans', 'loan', 'capital', 'home', 'forecast'];
export const CAPITAL_TYPES: [string, string][] = [['paid_up_capital', 'Paid-up capital'], ['share_application_money', 'Share application money']];
export const REPAYMENT_TYPES: [string, string][] = [['flexible', 'Flexible (repay any time)'], ['emi', 'EMI'], ['bullet', 'Bullet (principal at the end)']];

export type Covenant = { totalDebt: string; cap: string; headroom: string; breached: boolean; warning: string | null; loansOutstanding: string; cashCredit: string; countSanctionedLimit: boolean };
export type Capital = {
  id: string; holderName: string; receiptDate: string; amount: string; type: string; typeLabel: string; allotmentDate: string | null; sharesAllotted: number | null;
  allotted: boolean; pendingAllotment: { days: number; overdue: boolean } | null; inBank: boolean; bankTxnId: string | null; status: 'recorded' | 'cancelled'; statusReason: string | null; notes: string | null;
};
export type LoanRow = {
  id: string; lender: string; reference: string | null; sanctionAmount: string; disbursedAmount: string; disbursedDate: string; interestRate: string | null;
  repaymentType: string; repaymentTypeLabel: string; tenureMonths: number; moratoriumMonths: number; firstDueDate: string | null; finalDueDate: string;
  countsTowardCovenant: boolean; principalRepaid: string; interestPaid: string; balance: string; daysToFinalDue: number; overdue: boolean;
  nextDue: { instalmentNo: number | null; dueDate: string; total: string } | null; inBank: boolean; status: 'active' | 'closed' | 'cancelled'; statusReason: string | null; notes: string | null;
};
export type Instalment = { id: string; instalmentNo: number; dueDate: string; openingBalance: string; principal: string; interest: string; total: string; closingBalance: string; paid: boolean };
export type Repayment = { id: string; paidDate: string; principal: string; interest: string; total: string; instalmentNo: number | null; inBank: boolean; reference: string | null; status: 'recorded' | 'cancelled'; statusReason: string | null };
export type Loan = LoanRow & { schedule: Instalment[]; repayments: Repayment[]; covenant: Covenant };
export type Overview = {
  fy: string;
  capital: {
    total: string; thisFy: string;
    byHolder: { holderName: string; paidUp: string; shareApplication: string; pendingAllotment: string }[];
    allotmentOverdue: { id: string; holderName: string; amount: string; receiptDate: string; days: number }[];
  };
  loans: { outstanding: string; receivedThisFy: string; active: number; overdue: number; nextDue: { id: string; lender: string; dueDate: string; total: string } | null };
  covenant: Covenant;
  unexplained: number;
};
export type Candidate = { id: string; txnDate: string; counterpartyName: string | null; amount: string; narration: string };
export type BankRow = { id: string; txnDate: string; credit: string; debit: string; counterpartyName: string | null; narration: string; category: string | null };
