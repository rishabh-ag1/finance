/** Where each kind of linked record opens in the app. */
export function linkedRecordPath(type: string | null, id: string | null): string | null {
  if (!type || !id) return null;
  switch (type) {
    case 'PaymentOut': return `/payments/${id}`;
    case 'Receipt': return `/receipts/${id}`;
    case 'SettlementBatch': return `/order-to-bank/settlements/${id}`;
    case 'CrmOrder': return `/order-to-bank/orders/${encodeURIComponent(id)}`;
    case 'Loan': return `/funding/loans/${id}`;
    case 'CapitalReceipt': return '/funding?tab=capital';
    case 'TdsChallan': return '/tds';
    case 'Reimbursement': return '/claims';
    default: return null;
  }
}
export const LINKED_LABEL: Record<string, string> = {
  PaymentOut: 'Vendor payment', Receipt: 'Customer receipt', SettlementBatch: 'Settlement / remittance', CrmOrder: 'CRM order', Loan: 'Loan received',
  LoanRepayment: 'Loan repayment', CapitalReceipt: 'Capital', TdsChallan: 'TDS challan', Reimbursement: 'Founder reimbursement',
};
