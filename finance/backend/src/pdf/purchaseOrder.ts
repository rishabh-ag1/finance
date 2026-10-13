import { amountInWords } from '../lib/gst';
import { GST_STATE_CODES } from '../lib/gstin';
import { Decimal, formatINR } from '../lib/money';
import { esc } from './render';

/**
 * PO PDF (Documents & Numbering: Purchase Order). The layout lives in code and is versioned;
 * every issued PO stores the version it was printed with.
 */
export const PO_TEMPLATE_VERSION = 'po-v1';

export type PoPdfData = {
  poNumber: string;
  poDate: string;
  revisionNo: number;
  company: { legalName: string; address: string; gstin: string; pan: string; cin: string | null; email: string | null; phone: string | null; stateCode: string };
  vendor: { name: string; address: string; gstin: string | null; pan: string | null; stateCode: string | null; contact: string | null };
  deliveryAddress: string;
  placeOfSupplyState: string;
  expectedDeliveryDate: string | null;
  quoteRef: string | null;
  paymentTerms: string | null;
  milestones: { label: string; percent: string }[];
  termsText: string | null;
  gstMode: string;
  lines: { description: string; hsnSac: string | null; qty: string; unit: string; rate: string; discount: string; gstRate: string; taxable: string; tax: string; lineTotal: string }[];
  totals: { taxable: string; cgst: string; sgst: string; igst: string; roundOff: string; total: string };
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const money = (v: string) => formatINR(v).replace('₹', '');
const day = (iso: string | null) => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}-${MONTHS[Number(m) - 1]}-${y}`;
};
const stateName = (code: string | null) => (code ? `${GST_STATE_CODES[code] ?? ''} (${code})` : '');
const multiline = (text: string) => esc(text).replace(/\n/g, '<br>');

const CSS = `
  * { box-sizing: border-box; }
  body { font-family: Inter, Arial, sans-serif; font-size: 10px; color: #111; margin: 0; }
  h1 { font-size: 18px; margin: 0; color: #0c2c55; letter-spacing: .5px; }
  .muted { color: #555; }
  .head { display: flex; justify-content: space-between; border-bottom: 2px solid #0c2c55; padding-bottom: 8px; }
  .co { font-weight: 700; font-size: 13px; }
  .grid { display: flex; gap: 10px; margin-top: 10px; }
  .box { flex: 1; border: 1px solid #ccc; padding: 6px 8px; }
  .label { font-size: 9px; text-transform: uppercase; color: #0c2c55; font-weight: 700; margin-bottom: 3px; }
  table.items { width: 100%; border-collapse: collapse; margin-top: 10px; }
  table.items th { background: #0c2c55; color: #fff; font-weight: 600; padding: 4px; text-align: left; }
  table.items th.r { text-align: right; }
  table.items td { border-bottom: 1px solid #ddd; padding: 4px; vertical-align: top; }
  .r { text-align: right; white-space: nowrap; }
  .totals { width: 45%; margin-left: auto; border-collapse: collapse; margin-top: 6px; }
  .totals td { padding: 3px 4px; }
  .totals tr.grand td { border-top: 2px solid #0c2c55; font-weight: 700; font-size: 12px; }
  .words { margin-top: 6px; font-weight: 600; }
  .sign { margin-top: 30px; text-align: right; }
  .foot { margin-top: 16px; font-size: 8.5px; color: #666; text-align: center; }
`;

export function purchaseOrderHtml(d: PoPdfData): string {
  const taxRows = d.gstMode === 'none' ? ''
    : d.gstMode === 'cgst_sgst'
      ? `<tr><td>CGST</td><td class="r">${money(d.totals.cgst)}</td></tr><tr><td>SGST</td><td class="r">${money(d.totals.sgst)}</td></tr>`
      : `<tr><td>IGST</td><td class="r">${money(d.totals.igst)}</td></tr>`;
  const roundOff = new Decimal(d.totals.roundOff).isZero() ? '' : `<tr><td>Round off</td><td class="r">${money(d.totals.roundOff)}</td></tr>`;
  const vendorIds = d.vendor.gstin ? `<br>GSTIN ${esc(d.vendor.gstin)}` : d.vendor.pan ? `<br>PAN ${esc(d.vendor.pan)}` : '';
  const rows = d.lines.map((l, i) => `<tr><td>${i + 1}</td><td>${multiline(l.description)}</td><td>${esc(l.hsnSac ?? '')}</td>
    <td class="r">${esc(l.qty)} ${esc(l.unit)}</td><td class="r">${money(l.rate)}</td>
    <td class="r">${new Decimal(l.discount).isZero() ? '' : money(l.discount)}</td><td class="r">${money(l.taxable)}</td>
    <td class="r">${d.gstMode === 'none' ? '-' : `${esc(l.gstRate)}%<br>${money(l.tax)}`}</td><td class="r">${money(l.lineTotal)}</td></tr>`).join('');
  const milestones = d.milestones.length
    ? `<ul style="margin:4px 0 0 14px;padding:0">${d.milestones.map((m) => `<li>${esc(m.percent)}% ${esc(m.label)}</li>`).join('')}</ul>` : '';
  const terms = d.paymentTerms || d.milestones.length
    ? `<div class="box" style="margin-top:10px"><div class="label">Payment terms</div>${esc(d.paymentTerms ?? '')}${milestones}</div>` : '';

  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div class="head">
  <div>
    <div class="co">${esc(d.company.legalName)}</div>
    <div class="muted">${multiline(d.company.address)}</div>
    <div>GSTIN ${esc(d.company.gstin)} · PAN ${esc(d.company.pan)}${d.company.cin ? ` · CIN ${esc(d.company.cin)}` : ''}</div>
    <div class="muted">${[d.company.email, d.company.phone].filter(Boolean).map(esc).join(' · ')}</div>
  </div>
  <div style="text-align:right">
    <h1>PURCHASE ORDER</h1>
    <div style="margin-top:6px"><b>PO No:</b> ${esc(d.poNumber)}${d.revisionNo ? ` <b>(Revision R${d.revisionNo})</b>` : ''}</div>
    <div><b>PO Date:</b> ${day(d.poDate)}</div>
    ${d.quoteRef ? `<div><b>Your quote:</b> ${esc(d.quoteRef)}</div>` : ''}
    ${d.expectedDeliveryDate ? `<div><b>Delivery by:</b> ${day(d.expectedDeliveryDate)}</div>` : ''}
  </div>
</div>
<div class="grid">
  <div class="box"><div class="label">Vendor</div><b>${esc(d.vendor.name)}</b><br>${multiline(d.vendor.address)}${vendorIds}
    ${d.vendor.stateCode ? `<br>State ${stateName(d.vendor.stateCode)}` : ''}${d.vendor.contact ? `<br>${esc(d.vendor.contact)}` : ''}</div>
  <div class="box"><div class="label">Deliver to</div>${multiline(d.deliveryAddress)}<br>Place of supply ${stateName(d.placeOfSupplyState)}</div>
</div>
<table class="items"><thead><tr>
  <th>#</th><th>Description</th><th>HSN/SAC</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Discount</th><th class="r">Taxable</th><th class="r">GST</th><th class="r">Amount</th>
</tr></thead><tbody>${rows}</tbody></table>
<table class="totals">
  <tr><td>Taxable value</td><td class="r">${money(d.totals.taxable)}</td></tr>
  ${taxRows}${roundOff}
  <tr class="grand"><td>Total (INR)</td><td class="r">₹${money(d.totals.total)}</td></tr>
</table>
<div class="words">${esc(amountInWords(new Decimal(d.totals.total)))}</div>
${terms}
${d.termsText ? `<div class="box" style="margin-top:8px"><div class="label">Terms and conditions</div>${multiline(d.termsText)}</div>` : ''}
<div class="sign">For <b>${esc(d.company.legalName)}</b><br><br><br>Authorised signatory</div>
<div class="foot">This is a computer-generated purchase order. Please quote the PO number on your invoice. Template ${PO_TEMPLATE_VERSION}</div>
</body></html>`;
}
