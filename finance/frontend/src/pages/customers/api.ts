/** Types of the customer, product and price-list responses (money and dates are text). */

export type Profile = {
  paymentTermId: string | null; paymentTerms: string | null; creditLimit: string | null; invoiceEmails: string[]; deductsTds: boolean;
  tdsSection: string | null; tdsSectionId: string | null; priceListId: string | null; priceList: string | null; channel: string; channelLabel: string; billToBranchId: string | null;
};
export type OwnProfile = {
  paymentTermId: string | null; creditLimit: string | null; invoiceEmails: string[]; deductsTds: boolean | null; tdsSectionId: string | null;
  priceListId: string | null; channel: string | null; billToBranchId: string | null; notes: string | null;
};
export type CustomerRow = Profile & {
  id: string; name: string; chainType: string; outlets: number; gstins: string[]; states: string[];
  outstanding: string | null; overdue: string | null; lastInvoice: string | null; lastReceipt: string | null;
};
export type Outlet = {
  id: string; name: string; address: string; state: string | null; stateCode: string | null; stateName: string | null; gstin: string | null; gstinProblem: string | null;
  invoiceType: 'B2B' | 'B2C'; isActive: boolean; hasOwnProfile: boolean; profile: Profile; own: OwnProfile | null;
};
export type Customer = {
  id: string; name: string; chainType: string; profile: Profile; own: OwnProfile | null; outlets: Outlet[];
  contacts: { id: string; name: string | null; phone: string; email: string | null; role: string | null }[];
  orders: { orderNumber: string; orderDate: string; channel: string; paymentMethod: string; totalAmount: string; status: string; outletId: string | null }[];
};
export type ProductRow = {
  id: string; sku: string; skuNumber: string; name: string; hsn: string | null; gstRate: string; priceExclTax: string; priceInclTax: string;
  unitCost: string | null; unitCostFrom: string | null; aliases: string[]; isActive: boolean; problems: string[]; prices: Record<string, string | null>;
};
export type PriceListRow = { id: string; name: string; kind: string; kindLabel: string; taxInclusive: boolean; isActive: boolean; notes: string | null; items?: number; customers: number };
export type PriceListDetail = Omit<PriceListRow, 'customers' | 'items'> & {
  items: { id: string; invProductId: string; sku: string; productName: string; price: string; minQty: number; effectiveFrom: string; effectiveTo: string | null; isArchived: boolean; current: boolean; upcoming: boolean; rateBeforeGst: string | null }[];
};

export const CHANNELS: [string, string][] = [['horeca', 'HoReCa'], ['distributor', 'Distributor'], ['marketplace', 'Marketplace'], ['d2c', 'D2C']];
export const KINDS: [string, string][] = [['mrp', 'MRP'], ['horeca', 'HoReCa'], ['distributor', 'Distributor'], ['marketplace', 'Marketplace'], ['other', 'Other']];
export const CUSTOMER_KEYS = ['customers', 'customer', 'products', 'price-lists', 'price-list'];
