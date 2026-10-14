import { GST_STATE_CODES } from '../lib/gstin';
import { formatINR } from '../lib/money';
import { esc } from './render';

/**
 * F095 / F104 PDF of a proforma, tax invoice or credit note. The layout lives in code (versioned
 * here); the look comes from the template settings version stored on the document. Compliance
 * fields (BR-32) are always printed and cannot be switched off. Tax invoices print three copies:
 * Original for Recipient, Duplicate for Transporter, Triplicate for Supplier.
 */
export const SALES_LAYOUT_VERSION = 'inv-v1';

export type SalesPdfData = {
  docType: 'proforma' | 'tax_invoice' | 'credit_note';
  docNumber: string | null;
  docDate: string;
  status: string;
  company: { legalName: string; brandName: string | null; address: string; gstin: string; pan: string; cin: string | null; email: string | null; phone: string | null; stateCode: string };
  billTo: { name: string; address: string; stateCode: string | null; gstin: string | null; phone?: string | null; email?: string | null };
  shipTo: { name: string; address: string; stateCode: string | null } | null;
  supplyType: 'b2b' | 'b2c';
  placeOfSupply: string;
  gstMode: string;
  reverseCharge: boolean;
  customerPoNo: string | null;
  customerPoDate: string | null;
  validUntil: string | null;
  dueDate: string | null;
  paymentTerms: string | null;
  ewayBillNo: string | null;
  transporter: string | null;
  vehicleNo: string | null;
  salesPerson: string | null;
  crmOrderNumber: string | null;
  against: { number: string; date: string } | null;
  creditReason: string | null;
  lines: { description: string; hsnSac: string; qty: string; unit: string; rate: string; discountPct: string; discount: string; taxable: string; gstRate: string; cgst: string; sgst: string; igst: string; lineTotal: string }[];
  hsnSummary: { hsn: string; rate: string; taxable: string; cgst: string; sgst: string; igst: string; tax: string }[];
  totals: { taxable: string; cgst: string; sgst: string; igst: string; roundOff: string; total: string; pieces: string };
  amountInWords: string;
  look: {
    version: number; accentColor: string; font: string; logo: string | null; signature: string | null; upiQr: string | null; upiId: string | null;
    bank: { accountName: string; bankName: string; accountNumber: string; ifsc: string } | null;
    warrantyText: string | null; declarationText: string | null; termsText: string | null; footerText: string | null; showDiscount: boolean; showHsnSummary: boolean;
  };
};

const FONTS: Record<string, string> = {
  inter: "'Inter', 'Segoe UI', Arial, sans-serif", roboto: "'Roboto', 'Segoe UI', Arial, sans-serif",
  lato: "'Lato', 'Segoe UI', Arial, sans-serif", 'noto-serif': "'Noto Serif', Georgia, serif",
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (iso: string | null) => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}-${MONTHS[Number(m) - 1]}-${y}`;
};
const money = (v: string) => formatINR(v).replace('₹', '');
const nz = (v: string) => Number(v) !== 0;
const state = (code: string | null) => (code ? `${GST_STATE_CODES[code] ?? ''} (${code})` : '');
const lines = (text: string | null) => esc(text ?? '').replace(/\n/g, '<br>');

const TITLE = { proforma: 'PROFORMA INVOICE', tax_invoice: 'TAX INVOICE', credit_note: 'CREDIT NOTE' } as const;

function css(accent: string, font: string) {
  return `
  @page { size: A4; }
  body { font-family: ${FONTS[font] ?? FONTS.inter}; font-size: 9.5px; color: #1f2937; margin: 0; }
  .page { position: relative; page-break-after: always; }
  .page:last-child { page-break-after: auto; }
  .copy { text-align: right; font-size: 8.5px; color: #6b7280; text-transform: uppercase; letter-spacing: .04em; }
  .head { display: flex; justify-content: space-between; gap: 16px; border-bottom: 2px solid ${accent}; padding-bottom: 8px; }
  .co { font-size: 14px; font-weight: 700; color: ${accent}; }
  .logo { max-height: 46px; max-width: 160px; margin-bottom: 4px; }
  h1 { font-size: 15px; margin: 0; color: ${accent}; letter-spacing: .03em; }
  .muted { color: #6b7280; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 8px; }
  .box { border: 1px solid #d1d5db; border-radius: 4px; padding: 6px 8px; }
  .label { font-size: 8px; text-transform: uppercase; color: #6b7280; letter-spacing: .05em; margin-bottom: 2px; }
  table { width: 100%; border-collapse: collapse; }
  .items { margin-top: 8px; }
  .items th { background: ${accent}; color: #fff; font-weight: 600; padding: 4px; text-align: left; font-size: 8.5px; }
  .items td { border-bottom: 1px solid #e5e7eb; padding: 4px; vertical-align: top; }
  .r { text-align: right; }
  .totals { width: 46%; margin-left: auto; margin-top: 6px; }
  .totals td { padding: 2px 4px; }
  .grand td { border-top: 1.5px solid ${accent}; font-weight: 700; font-size: 11px; padding-top: 4px; }
  .words { margin-top: 4px; font-weight: 600; }
  .hsn { margin-top: 8px; font-size: 8.5px; }
  .hsn th, .hsn td { border: 1px solid #e5e7eb; padding: 3px; }
  .hsn th { background: #f3f4f6; }
  .bottom { display: grid; grid-template-columns: 1.4fr 1fr; gap: 10px; margin-top: 10px; }
  .qr { width: 86px; height: 86px; }
  .sign { text-align: right; margin-top: 6px; }
  .sign img { max-height: 48px; max-width: 160px; display: block; margin: 4px 0 4px auto; }
  .foot { margin-top: 10px; font-size: 8px; color: #6b7280; text-align: center; }
  .stamp { position: absolute; top: 260px; left: 0; right: 0; text-align: center; font-size: 64px; font-weight: 800; color: rgba(220, 38, 38, .18); transform: rotate(-18deg); letter-spacing: .1em; }
  .draft { color: rgba(107, 114, 128, .2); }
  `;
}

function page(d: SalesPdfData, copy: string) {
  const igst = d.gstMode === 'igst';
  const disc = d.look.showDiscount && d.lines.some((l) => nz(l.discount));
  const head = `<tr><th>#</th><th>Description</th><th>HSN/SAC</th><th class="r">Qty</th><th class="r">Rate</th>${disc ? '<th class="r">Disc %</th>' : ''}<th class="r">Taxable</th>
    ${igst ? '<th class="r">IGST</th>' : '<th class="r">CGST</th><th class="r">SGST</th>'}<th class="r">Amount</th></tr>`;
  const rows = d.lines.map((l, i) => `<tr><td>${i + 1}</td><td>${lines(l.description)}</td><td>${esc(l.hsnSac)}</td>
    <td class="r">${esc(l.qty)} ${esc(l.unit)}</td><td class="r">${money(l.rate)}</td>${disc ? `<td class="r">${nz(l.discountPct) ? `${esc(l.discountPct)}%` : ''}</td>` : ''}
    <td class="r">${money(l.taxable)}</td>
    ${igst ? `<td class="r">${esc(l.gstRate)}%<br>${money(l.igst)}</td>` : `<td class="r">${Number(l.gstRate) / 2}%<br>${money(l.cgst)}</td><td class="r">${Number(l.gstRate) / 2}%<br>${money(l.sgst)}</td>`}
    <td class="r">${money(l.lineTotal)}</td></tr>`).join('');
  const taxRows = igst
    ? `<tr><td>IGST</td><td class="r">${money(d.totals.igst)}</td></tr>`
    : `<tr><td>CGST</td><td class="r">${money(d.totals.cgst)}</td></tr><tr><td>SGST</td><td class="r">${money(d.totals.sgst)}</td></tr>`;
  const hsn = d.look.showHsnSummary && d.docType !== 'proforma' ? `<table class="hsn"><thead><tr><th>HSN/SAC</th><th class="r">Taxable</th><th class="r">Rate</th>
    ${igst ? '<th class="r">IGST</th>' : '<th class="r">CGST</th><th class="r">SGST</th>'}<th class="r">Total tax</th></tr></thead><tbody>
    ${d.hsnSummary.map((h) => `<tr><td>${esc(h.hsn)}</td><td class="r">${money(h.taxable)}</td><td class="r">${esc(h.rate)}%</td>
      ${igst ? `<td class="r">${money(h.igst)}</td>` : `<td class="r">${money(h.cgst)}</td><td class="r">${money(h.sgst)}</td>`}<td class="r">${money(h.tax)}</td></tr>`).join('')}</tbody></table>` : '';
  const meta = [
    ['Number', d.docNumber ?? 'DRAFT'], ['Date', day(d.docDate)],
    ...(d.against ? [['Against invoice', `${d.against.number} dated ${day(d.against.date)}`]] : []),
    ...(d.creditReason ? [['Reason', d.creditReason]] : []),
    ...(d.validUntil ? [['Valid until', day(d.validUntil)]] : []),
    ...(d.dueDate && d.docType === 'tax_invoice' ? [['Due date', day(d.dueDate)]] : []),
    ...(d.paymentTerms ? [['Payment terms', d.paymentTerms]] : []),
    ...(d.customerPoNo ? [['Your PO', `${d.customerPoNo}${d.customerPoDate ? ` dated ${day(d.customerPoDate)}` : ''}`]] : []),
    ...(d.crmOrderNumber ? [['Order', d.crmOrderNumber]] : []),
    ...(d.docType === 'tax_invoice' ? [['Reverse charge', d.reverseCharge ? 'Yes' : 'No']] : []),
    ...(d.ewayBillNo ? [['E-way bill', d.ewayBillNo]] : []),
    ...(d.transporter || d.vehicleNo ? [['Transport', [d.transporter, d.vehicleNo].filter(Boolean).join(' · ')]] : []),
    ...(d.salesPerson ? [['Sales', d.salesPerson]] : []),
  ].map(([k, v]) => `<div><b>${esc(k)}:</b> ${esc(v)}</div>`).join('');
  const bank = d.look.bank ? `<div class="label">Bank details</div>${esc(d.look.bank.accountName)}<br>${esc(d.look.bank.bankName)}<br>A/c ${esc(d.look.bank.accountNumber)} · IFSC ${esc(d.look.bank.ifsc)}` : '';
  const qr = d.look.upiQr && d.docType !== 'credit_note' ? `<div style="text-align:center"><img class="qr" src="${d.look.upiQr}"><div class="muted">Pay by UPI${d.look.upiId ? `<br>${esc(d.look.upiId)}` : ''}</div></div>` : '';
  const stamp = d.status === 'cancelled' ? '<div class="stamp">CANCELLED</div>' : d.status === 'draft' ? '<div class="stamp draft">DRAFT</div>' : '';
  const notTax = d.docType === 'proforma' ? '<div class="muted" style="margin-top:2px">This is not a tax invoice. No GST is payable on it.</div>' : '';

  return `<div class="page">${stamp}
<div class="copy">${esc(copy)}</div>
<div class="head">
  <div>
    ${d.look.logo ? `<img class="logo" src="${d.look.logo}">` : ''}
    <div class="co">${esc(d.company.legalName)}</div>
    ${d.company.brandName ? `<div class="muted">${esc(d.company.brandName)}</div>` : ''}
    <div class="muted">${lines(d.company.address)}</div>
    <div>GSTIN ${esc(d.company.gstin)} · PAN ${esc(d.company.pan)}${d.company.cin ? ` · CIN ${esc(d.company.cin)}` : ''}</div>
    <div class="muted">State ${state(d.company.stateCode)}${[d.company.email, d.company.phone].filter(Boolean).length ? ` · ${[d.company.email, d.company.phone].filter(Boolean).map(esc).join(' · ')}` : ''}</div>
  </div>
  <div style="text-align:right"><h1>${TITLE[d.docType]}</h1>${notTax}<div style="margin-top:6px">${meta}</div></div>
</div>
<div class="grid">
  <div class="box"><div class="label">Bill to</div><b>${esc(d.billTo.name)}</b><br>${lines(d.billTo.address)}
    ${d.billTo.stateCode ? `<br>State ${state(d.billTo.stateCode)}` : ''}${d.billTo.gstin ? `<br><b>GSTIN ${esc(d.billTo.gstin)}</b>` : ''}
    ${[d.billTo.phone, d.billTo.email].filter(Boolean).length ? `<br>${[d.billTo.phone, d.billTo.email].filter(Boolean).map(esc).join(' · ')}` : ''}</div>
  <div class="box"><div class="label">Ship to</div>${d.shipTo ? `<b>${esc(d.shipTo.name)}</b><br>${lines(d.shipTo.address)}${d.shipTo.stateCode ? `<br>State ${state(d.shipTo.stateCode)}` : ''}` : 'Same as bill to'}
    <br><b>Place of supply:</b> ${state(d.placeOfSupply)}</div>
</div>
<table class="items"><thead>${head}</thead><tbody>${rows}</tbody></table>
<table class="totals">
  <tr><td>Taxable value</td><td class="r">${money(d.totals.taxable)}</td></tr>
  ${taxRows}
  ${nz(d.totals.roundOff) ? `<tr><td>Round off</td><td class="r">${money(d.totals.roundOff)}</td></tr>` : ''}
  <tr class="grand"><td>Total (INR) · ${esc(d.totals.pieces)} pcs</td><td class="r">₹${money(d.totals.total)}</td></tr>
</table>
<div class="words">${esc(d.amountInWords)}</div>
${hsn}
<div class="bottom">
  <div>
    ${d.look.warrantyText ? `<div class="box"><div class="label">Warranty</div>${lines(d.look.warrantyText)}</div>` : ''}
    ${d.look.termsText ? `<div class="box" style="margin-top:6px"><div class="label">Terms</div>${lines(d.look.termsText)}</div>` : ''}
    ${d.look.declarationText ? `<div class="box" style="margin-top:6px"><div class="label">Declaration</div>${lines(d.look.declarationText)}</div>` : ''}
  </div>
  <div>
    <div class="box" style="display:flex;justify-content:space-between;gap:8px"><div>${bank}</div>${qr}</div>
    <div class="sign">For <b>${esc(d.company.legalName)}</b>${d.look.signature ? `<img src="${d.look.signature}">` : '<br><br><br>'}Authorised signatory</div>
  </div>
</div>
<div class="foot">${d.look.footerText ? `${lines(d.look.footerText)}<br>` : ''}This is a computer-generated document. Layout ${SALES_LAYOUT_VERSION}, template v${d.look.version}.</div>
</div>`;
}

export function salesDocumentHtml(d: SalesPdfData): string {
  const copies = d.docType === 'tax_invoice' ? ['Original for Recipient', 'Duplicate for Transporter', 'Triplicate for Supplier'] : [''];
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css(d.look.accentColor, d.look.font)}</style></head><body>${copies.map((c) => page(d, c)).join('')}</body></html>`;
}
