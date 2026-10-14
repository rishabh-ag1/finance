import { useQuery } from '@tanstack/react-query';
import api from '../../api';

/** Types of the /api/sales responses (money and dates are text). */

export type SalesDocType = 'proforma' | 'tax_invoice' | 'credit_note';
export const DOC_TYPES: [SalesDocType, string][] = [['tax_invoice', 'Tax invoices'], ['proforma', 'Proformas'], ['credit_note', 'Credit notes']];
export const STATUS_TONE: Record<string, 'gray' | 'green' | 'amber' | 'red' | 'blue'> = {
  draft: 'amber', issued: 'green', cancelled: 'red', discarded: 'gray', converted: 'blue', partly_converted: 'blue', expired: 'gray', accepted: 'green',
};
export const STATUSES: [string, string][] = [['draft', 'Draft'], ['issued', 'Issued'], ['partly_converted', 'Partly converted'], ['converted', 'Converted'], ['expired', 'Expired'], ['cancelled', 'Cancelled'], ['discarded', 'Discarded']];
export const CREDIT_REASONS: [string, string][] = [['return', 'Goods returned'], ['rate_difference', 'Rate difference'], ['discount', 'Discount after sale'], ['other', 'Other']];

export type Party = { name: string; address: string; stateCode: string | null; gstin: string | null; phone?: string | null; email?: string | null };
export type DocRow = {
  id: string; docType: SalesDocType; docTypeLabel: string; docNumber: string | null; docDate: string; status: string; statusLabel: string;
  customerName: string; customerGstin: string | null; supplyType: 'b2b' | 'b2c'; placeOfSupply: string; crmCompanyId: string | null; crmOrderNumber: string | null;
  taxable: string; tax: string; total: string; dueDate: string | null; validUntil: string | null; sent: boolean; salesPerson: string | null;
};
export type DocLine = {
  id: string; lineNo: number; invProductId: string | null; sku: string | null; description: string; hsnSac: string | null; qty: string; unit: string; rate: string;
  discountPct: string; discount: string; gstRate: string; taxable: string; tax: string; lineTotal: string; priceSource: string | null; sourceLineId: string | null;
  remainingToConvert: string | null; credited: string | null;
};
export type SalesDoc = DocRow & {
  billTo: Party; shipTo: Party; gstMode: string; reverseCharge: boolean; customerKind: 'outlet' | 'one_off' | 'order'; crmBranchId: string | null; shipToBranchId: string | null;
  customerPoNo: string | null; customerPoDate: string | null; paymentTermId: string | null; paymentTerms: string | null;
  ewayBillNo: string | null; transporter: string | null; vehicleNo: string | null; notes: string | null; creditReason: string | null; creditReasonLabel: string | null;
  statusReason: string | null; issuedAt: string | null; sentAt: string | null; acceptedAt: string | null; cancelledAt: string | null; templateVersion: number | null; layout: string;
  pdfAttachmentId: string | null; proformaId: string | null; againstInvoiceId: string | null;
  roundOff: string; cgst: string; sgst: string; igst: string; amountInWords: string;
  lines: DocLine[]; conversion: string | null; related: DocRow[]; problems: string[]; warnings: string[]; ewayNeeded: boolean; cancelRoute: 'discard' | 'cancel' | 'credit_note' | 'none';
};
export type Preview = {
  supplyType: 'b2b' | 'b2c'; placeOfSupply: string; gstMode: string; billTo: Party; shipTo: Party | null;
  lines: { description: string; hsnSac: string | null; qty: string; rate: string; discount: string; gstRate: string; taxable: string; tax: string; lineTotal: string; priceSource: string | null }[];
  totals: { taxable: string; cgst: string; sgst: string; igst: string; roundOff: string; total: string };
  amountInWords: string; dueDate: string | null; paymentTerms: string | null; warnings: string[]; problems: string[]; ewayNeeded: boolean;
};

export const SALES_KEYS = ['sales', 'sales-doc', 'customer'];
export const pdfPreviewUrl = (id: string) => `${import.meta.env.VITE_API_URL}/sales/${id}/preview.pdf`;

export function useSalesDoc(id: string | undefined) {
  return useQuery({ enabled: !!id, queryKey: ['sales-doc', id], queryFn: async () => (await api.get<{ data: SalesDoc }>(`/sales/${id}`)).data.data });
}
