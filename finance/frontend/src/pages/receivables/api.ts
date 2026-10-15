/** Types of the /api/receivables and /api/receipts responses (money and dates are text). */

export const RECEIPT_MODES: [string, string][] = [
  ['neft', 'NEFT'], ['rtgs', 'RTGS'], ['imps', 'IMPS'], ['upi', 'UPI'], ['cheque', 'Cheque'], ['cash', 'Cash'], ['razorpay', 'Razorpay'], ['cod', 'COD remittance'], ['other', 'Other'],
];
export const PAY_TONE: Record<string, 'gray' | 'green' | 'amber' | 'red' | 'blue'> = { unpaid: 'amber', partly_paid: 'blue', paid: 'green' };
export const RECEIVABLE_KEYS = ['receivables', 'receipts', 'receipt', 'sales', 'sales-doc', 'sales-receivable', 'customer', 'home', 'forecast'];

export type Payment = {
  state: 'unpaid' | 'partly_paid' | 'paid'; stateLabel: string; outstanding: string; overdue: boolean; daysOverdue: number; bucket: string | null;
  received: string; tds: string; credited: string;
};
export type DocReceivable = Payment & {
  receipts: { allocationId: string; receiptId: string; receiptNo: string; receiptDate: string; amount: string; tds: string; mode: string }[];
  reminders: { sharedOn: string; channel: string; note: string | null }[];
};
export type OutstandingRow = Payment & {
  id: string; docNumber: string; docDate: string; dueDate: string | null; customerName: string; crmCompanyId: string | null; crmOrderNumber: string | null;
  supplyType: string; source: string; total: string; lastReminder: string | null;
};
export type ReceiptRow = {
  id: string; receiptNo: string; receiptDate: string; customerName: string; crmCompanyId: string | null; mode: string; modeLabel: string; reference: string | null;
  amount: string; tds: string; bankCharges: string; gstOnCharges: string; total: string; allocated: string; advance: string; source: string; crmOrderNumber: string | null;
  inBank: boolean; status: 'recorded' | 'cancelled'; statusReason: string | null;
};
export type Receipt = ReceiptRow & {
  notes: string | null; matchedBy: string | null; toBankAccountId: string | null; toBankAccount: string | null;
  bankRow: { id: string; txnDate: string; credit: string; narration: string } | null;
  allocations: { id: string; docId: string; docNumber: string | null; docType: string | null; amount: string; tds: string; isArchived: boolean; archivedReason: string | null }[];
};
export type OpenDoc = { id: string; docType: string; docNumber: string; docDate: string; dueDate: string | null; total: string; taxable: string; outstanding: string; daysOverdue: number; customerName: string };
export type Suggestion = { invoiceId: string; docNumber: string; receipt: string; tds: string; tdsRate: string | null; settles: boolean; confidence: number; why: string; customerName: string };
export type Credit = { id: string; txnDate: string; credit: string; counterpartyName: string | null; narration: string; utr: string | null; suggestions: Suggestion[] };
export type Ageing = {
  labels: Record<string, string>;
  rows: { key: string; companyId: string | null; name: string; buckets: Record<string, string>; total: string; advances: string }[];
  totals: Record<string, string>;
};
export type Dashboard = {
  outstanding: string; overdue: string; invoicesOpen: number; dso: number | null; advances: string;
  topDebtors: { name: string; companyId: string | null; total: string; overdue: string }[];
  collections: { month: string; received: string; tds: string; gatewayCharges: string; gstOnCharges: string }[];
};
export const BUCKETS = ['not_due', '1_30', '31_60', '61_90', '90_plus'] as const;
