import { useQuery } from '@tanstack/react-query';
import api from '../../api';

/** Types of the /api/bills responses (money, quantities and dates are text). */

export type DocType = 'quote' | 'proforma' | 'tax_invoice' | 'debit_note' | 'credit_note';
export type DocStatus = 'awaiting_tax_invoice' | 'received' | 'approved' | 'partially_paid' | 'paid' | 'disputed' | 'replaced' | 'cancelled';

export const DOC_TYPES: [DocType, string][] = [
  ['tax_invoice', 'Tax invoice'], ['proforma', 'Proforma'], ['quote', 'Quote'], ['credit_note', 'Credit note'], ['debit_note', 'Debit note'],
];
export const DOC_STATUSES: [DocStatus, string][] = [
  ['awaiting_tax_invoice', 'Awaiting tax invoice'], ['received', 'Received'], ['approved', 'OK to pay'], ['partially_paid', 'Partially paid'],
  ['paid', 'Paid'], ['disputed', 'Disputed'], ['replaced', 'Replaced'], ['cancelled', 'Cancelled'],
];
export const DOC_STATUS_TONE: Record<DocStatus, 'gray' | 'green' | 'amber' | 'red' | 'blue'> = {
  awaiting_tax_invoice: 'amber', received: 'blue', approved: 'blue', partially_paid: 'amber', paid: 'green', disputed: 'red', replaced: 'gray', cancelled: 'gray',
};

export type BillRow = {
  id: string; docType: DocType; docTypeLabel: string; docNumber: string; docDate: string; fyLabel: string; status: DocStatus; statusLabel: string;
  overdue: boolean; vendorId: string; vendorName: string; vendorGstin: string | null; msme: string | null; poId: string | null; poNumber: string | null;
  taxableValue: string; cgst: string; sgst: string; igst: string; otherCharges: string; totalValue: string; tdsAmount: string;
  netPayable: string; paidAmount: string; outstanding: string; dueDate: string | null;
};

export type TdsSuggestion = { applicable: boolean; sectionId: string | null; rate: string; base: string; amount: string; reason: string };
type DocLink = { id: string; docType: DocType; docTypeLabel: string; docNumber: string; status: DocStatus; statusLabel: string; totalValue: string };

export type BillLine = {
  id: string; lineNo: number; poLineId: string | null; description: string; hsnSac: string | null; qty: string; unit: string; rate: string;
  discount: string; gstRate: string; taxable: string; cgst: string; sgst: string; igst: string; tax: string; lineTotal: string;
};

export type Bill = BillRow & {
  vendorStatus: string; receivedDate: string | null; placeOfSupplyState: string; gstMode: 'cgst_sgst' | 'igst' | 'none'; reverseCharge: boolean;
  roundOff: string; taxMismatch: string | null;
  tds: { applicable: boolean; sectionId: string | null; sectionLabel: string | null; verifiedByCa: boolean | null; base: string; rate: string; amount: string; overrideReason: string | null; suggestion: TdsSuggestion | null };
  advancesApplied: string; notesAdjustment: string; categoryId: string | null; subCategoryId: string | null; categoryName: string | null; subCategoryName: string | null;
  nature: string | null; paymentTermId: string | null; paymentTermLabel: string | null; itcEligible: boolean; notes: string | null; statusReason: string | null;
  approvedBy: string | null; approvedAt: string | null; enteredBy: string | null; enteredAt: string; poStatus: string | null;
  replaces: DocLink | null; replacedBy: DocLink | null; against: DocLink | null; notesAgainst: DocLink[];
  lines: BillLine[]; warnings: string[]; saveWarnings?: string[];
};

export type BillPreview = {
  gstMode: Bill['gstMode']; placeOfSupplyState: string; lines: { taxable: string; tax: string; lineTotal: string }[];
  taxableValue: string; cgst: string; sgst: string; igst: string; otherCharges: string; roundOff: string; totalValue: string;
  tds: { applicable: boolean; sectionId: string | null; base: string; rate: string; amount: string }; tdsSuggestion: TdsSuggestion | null;
  netPayable: string; dueDate: string | null; categoryId: string | null; subCategoryId: string | null; nature: string | null; warnings: string[];
};

export function useBill(id: string | undefined) {
  return useQuery({ enabled: !!id, queryKey: ['bill', id], queryFn: async () => (await api.get<{ data: Bill }>(`/bills/${id}`)).data.data });
}
