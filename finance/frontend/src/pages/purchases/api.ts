import { useQuery } from '@tanstack/react-query';
import api from '../../api';

/** Types of the /api/purchases responses (money, quantities and dates are text). */

export type PoStatus = 'draft' | 'pending_approval' | 'approved' | 'sent' | 'partially_billed' | 'fully_billed' | 'closed' | 'cancelled';

export const PO_STATUS_TONE: Record<PoStatus, 'gray' | 'green' | 'amber' | 'red' | 'blue'> = {
  draft: 'gray', pending_approval: 'amber', approved: 'blue', sent: 'blue', partially_billed: 'amber', fully_billed: 'green', closed: 'gray', cancelled: 'red',
};

export type PoRow = {
  id: string; poNumber: string | null; poDate: string; vendorId: string; vendorName: string; vendorGstin: string | null;
  status: PoStatus; statusLabel: string; revisionNo: number; taxable: string; total: string; billedTaxable: string;
  paidTotal: string; balanceToBill: string; pdfAttachmentId: string | null; expectedDeliveryDate: string | null;
};

export type PoLine = {
  id: string; lineNo: number; purchaseItemId: string | null; description: string; hsnSac: string | null; qty: string; unit: string;
  rate: string; discount: string; gstRate: string; taxable: string; cgst: string; sgst: string; igst: string; tax: string; lineTotal: string; qtyBilled: string;
};

export type Po = PoRow & {
  vendorStatus: string; vendorStateCode: string | null; deliveryAddressId: string | null; deliveryAddress: string; placeOfSupplyState: string;
  gstMode: 'cgst_sgst' | 'igst' | 'none'; quoteRef: string | null; paymentTermId: string | null; paymentTermsText: string | null;
  milestones: { label: string; percent: string }[]; termsText: string | null; notes: string | null;
  cgst: string; sgst: string; igst: string; roundOff: string; amountInWords: string; billedTotal: string; advanceTotal: string;
  statusReason: string | null; issuedAt: string | null; issuedBy: string | null; approvals: { name: string; at: string }[];
  sentAt: string | null; sentVia: string | null; templateVersion: string | null; vendorBankChangedRecently: boolean;
  lines: PoLine[]; revisions: { revisionNo: number; reason: string; by: string | null; at: string }[];
};

export type PoPreview = {
  gstMode: Po['gstMode']; placeOfSupplyState: string; lines: { taxable: string; tax: string; lineTotal: string }[];
  taxable: string; cgst: string; sgst: string; igst: string; roundOff: string; total: string; amountInWords: string; warnings: string[];
};

export type DeliveryAddress = { id: string; label: string; address: string; stateCode: string; isActive: boolean };
export type PurchaseItem = { id: string; name: string; hsnSac: string | null; unit: string; defaultGstRate: string | null; lastRate: string | null; isArchived: boolean };

export const GST_MODE_LABEL: Record<Po['gstMode'], string> = { cgst_sgst: 'CGST + SGST (same state)', igst: 'IGST (other state)', none: 'No GST (unregistered vendor)' };

export function useDeliveryAddresses() {
  return useQuery({ queryKey: ['delivery-addresses'], queryFn: async () => (await api.get<{ data: DeliveryAddress[] }>('/purchases/delivery-addresses')).data.data });
}

export function usePurchaseItems() {
  return useQuery({ queryKey: ['purchase-items'], queryFn: async () => (await api.get<{ data: PurchaseItem[] }>('/purchases/items')).data.data });
}

export function usePo(id: string | undefined) {
  return useQuery({ enabled: !!id, queryKey: ['po', id], queryFn: async () => (await api.get<{ data: Po }>(`/purchases/pos/${id}`)).data.data });
}
