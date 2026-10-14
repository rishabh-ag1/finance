import { useQuery } from '@tanstack/react-query';
import api from '../../api';

/** Types of the /api/recon responses (money and dates are text). */

export type OrderStatus =
  | 'awaiting_payment' | 'awaiting_delivery' | 'paid_at_gateway' | 'delivered_awaiting_remittance' | 'settled' | 'remitted'
  | 'in_bank' | 'refunded' | 'rto_cancelled' | 'written_off' | 'nothing_due' | 'not_tracked';
export const STATUS_TONE: Record<OrderStatus, 'gray' | 'green' | 'amber' | 'red' | 'blue'> = {
  awaiting_payment: 'gray', awaiting_delivery: 'gray', paid_at_gateway: 'blue', delivered_awaiting_remittance: 'blue', settled: 'blue', remitted: 'blue',
  in_bank: 'green', refunded: 'gray', rto_cancelled: 'gray', written_off: 'red', nothing_due: 'gray', not_tracked: 'gray',
};
/** Order of the totals strip: the money's journey, then the end states. */
export const STATUS_ORDER: OrderStatus[] = ['awaiting_payment', 'awaiting_delivery', 'paid_at_gateway', 'delivered_awaiting_remittance', 'settled', 'remitted', 'in_bank', 'refunded', 'rto_cancelled', 'written_off', 'not_tracked'];
export const ROUTES: [string, string][] = [['razorpay', 'Razorpay'], ['cod', 'Shiprocket COD'], ['direct', 'Direct'], ['marketplace', 'Marketplace']];
export const CHANNELS: [string, string][] = [['SHOPIFY', 'Shopify'], ['WHATSAPP', 'WhatsApp'], ['MANUAL', 'Manual'], ['AMAZON', 'Amazon']];

export type TrackerRow = {
  orderNumber: string; orderDate: string; channel: string; customerName: string; paymentMethod: string; route: string; routeLabel: string;
  orderAmount: string; expectedAmount: string; collected: string; gatewayRef: string | null; settlementRef: string | null;
  status: OrderStatus; statusLabel: string; expectedDate: string | null; bankDate: string | null; overdue: boolean; discrepancies: number[];
};
export type Tracker = { from: string; to: string; readers: { crm: 'stub' | 'live'; inventory: 'stub' | 'live' }; overdue: number; totals: Record<OrderStatus, { label: string; count: number; amount: string }>; rows: TrackerRow[] };
type Stage = { count: number; amount: string; overdue: number; oldestExpected: string | null };
export type InTransit = { paidAtGateway: Stage; deliveredAwaitingRemittance: Stage; settledNotInBank: Stage; remittedNotInBank: Stage; total: string };

export type Discrepancy = {
  id: string; typeCode: number; typeLabel: string; orderNumber: string | null; batchId: string | null; gatewayPaymentId: string | null; amount: string; detail: string;
  suggestedAction: string; status: 'open' | 'cleared' | 'resolved'; detectedAt: string; clearedAt: string | null; resolutionAction: string | null; resolutionLabel: string | null;
  resolutionNote: string | null; resolvedAt: string | null;
};
export const RESOLUTIONS: [string, string][] = [
  ['chase_razorpay', 'Chased Razorpay'], ['chase_shiprocket', 'Chased Shiprocket'], ['refunded', 'Refunded the customer'], ['written_off', 'Written off'],
  ['crm_corrected', 'CRM order corrected'], ['linked_by_hand', 'Linked by hand'], ['other', 'Other'],
];

export type Level = { level: 1 | 2 | 3; label: string; difference: string | null; ok: boolean | null };
export type Candidate = { id: string; txnDate: string; counterpartyName: string | null; credit: string; narration: string; sameAmount: boolean };
export type Settlement = {
  id: string; source: 'razorpay' | 'shiprocket_cod'; externalId: string; utr: string | null; settledOn: string; matchedBy: string | null;
  totals: { gross: string; fees: string; taxOnFees: string; refunds: string; adjustments: string; net: string }; levels: Level[];
  bankRow: { id: string; txnDate: string; counterpartyName: string | null; credit: string; bankAccountId: string } | null;
  lines: { id: string; type: string; externalId: string; paymentId: string | null; awb: string | null; orderNumber: string | null; linkedBy: string | null; reference: string; orderAmount: string | null; gross: string; fee: string; taxOnFee: string; refund: string; adjustment: string; net: string }[];
  candidates: Candidate[]; discrepancies: Discrepancy[];
};
export type SettlementRow = { id: string; source: 'razorpay' | 'shiprocket_cod'; externalId: string; utr: string | null; settledOn: string; lines: number; gross: string; fees: string; net: string; inBank: boolean; matchedBy: string | null; expectedBank: string };

export type OrderDetail = {
  order: { orderNumber: string; orderDate: string; channel: string; paymentMethod: string; customerName: string; phone: string; email: string | null; shopifyOrderId: string | null; crmStatus: string; totalAmount: string; advancePaid: string; awb: string | null; codToCollect: string | null; shippedAt: string | null; deliveredAt: string | null };
  state: { route: string; routeLabel: string; status: OrderStatus; statusLabel: string; expectedAmount: string; collected: string; bankDate: string | null; expectedDate: string | null; overdueFrom: string | null; overdue: boolean };
  payments: { id: string; externalId: string; method: string | null; amount: string; fee: string; taxOnFee: string; refunded: string; status: string; capturedOn: string; linkedBy: string | null; settlement: { id: string; externalId: string; settledOn: string; bankDate: string | null } | null }[];
  remittances: { lineId: string; awb: string | null; amount: string; linkedBy: string | null; batch: { id: string; externalId: string; settledOn: string; bankDate: string | null } }[];
  direct: { id: string; amount: string; matchedBy: string; isArchived: boolean; archivedReason: string | null; bankRow: { id: string; txnDate: string; counterpartyName: string | null; credit: string } | null }[];
  writeOffs: { id: string; amount: string; reason: string; isArchived: boolean; archivedReason: string | null; createdAt: string }[];
  discrepancies: Discrepancy[];
};

export const LINKED_BY: Record<string, string> = {
  reference: 'order number in the report', amount_date: 'amount and date', manual: 'by hand', utr: 'UTR', amount_date_name: 'amount, date and name', payment: 'its payment', awb: 'AWB',
};

/** Everything an order-to-bank change can move. */
export const RECON_KEYS = ['recon-tracker', 'recon-transit', 'recon-order', 'recon-settlements', 'recon-settlement', 'recon-discrepancies', 'recon-discrepancy-count', 'recon-imports', 'recon-unlinked', 'dashboard-home', 'forecast', 'ledger'];

export function useDiscrepancyCount(enabled: boolean) {
  return useQuery({
    enabled, queryKey: ['recon-discrepancy-count'], refetchInterval: 120_000,
    queryFn: async () => (await api.get<{ data: number }>('/recon/discrepancies/count')).data.data,
  });
}

/** A chosen file as base64 for the JSON upload. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
