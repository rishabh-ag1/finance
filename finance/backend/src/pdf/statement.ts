import { formatINR } from '../lib/money';
import { esc } from './render';
import type { StatementLine } from '../services/receivables.service';

/** F082 customer statement: invoices, credit notes and receipts with a running balance. */
export type StatementPdfData = {
  company: { legalName: string; address: string; gstin: string; email: string | null };
  customer: { name: string; gstins: string[] };
  from: string; to: string; opening: string; closing: string; outstanding: string; advances: string; lines: StatementLine[];
};

const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
const amt = (v: string) => (Number(v) === 0 ? '' : formatINR(v));

export function statementHtml(d: StatementPdfData) {
  const rows = d.lines.map((l) => `<tr><td>${day(l.date)}</td><td>${esc(l.ref)}</td><td>${esc(l.detail)}</td><td class="r">${amt(l.debit)}</td><td class="r">${amt(l.credit)}</td><td class="r">${formatINR(l.balance)}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font-family: Inter, Arial, sans-serif; font-size: 11px; color: #111; margin: 28px; }
    h1 { font-size: 18px; margin: 0 0 4px; color: #0c2c55; } .muted { color: #555; }
    table { width: 100%; border-collapse: collapse; margin-top: 14px; } th, td { border-bottom: 1px solid #ddd; padding: 5px 6px; text-align: left; vertical-align: top; }
    th { background: #f3f5f8; font-weight: 600; } .r { text-align: right; white-space: nowrap; } .head { display: flex; justify-content: space-between; gap: 24px; }
    .totals td { font-weight: 600; border-bottom: none; }
  </style></head><body>
  <div class="head">
    <div><h1>Statement of account</h1><div class="muted">${day(d.from)} to ${day(d.to)}</div></div>
    <div style="text-align:right"><strong>${esc(d.company.legalName)}</strong><br>${esc(d.company.address)}<br>GSTIN ${esc(d.company.gstin)}${d.company.email ? `<br>${esc(d.company.email)}` : ''}</div>
  </div>
  <p><strong>${esc(d.customer.name)}</strong>${d.customer.gstins.length ? `<br>GSTIN ${d.customer.gstins.map(esc).join(', ')}` : ''}</p>
  <table><thead><tr><th>Date</th><th>Reference</th><th>Details</th><th class="r">Invoiced</th><th class="r">Received / credited</th><th class="r">Balance</th></tr></thead>
  <tbody><tr><td>${day(d.from)}</td><td></td><td>Opening balance</td><td></td><td></td><td class="r">${formatINR(d.opening)}</td></tr>${rows}
  <tr class="totals"><td></td><td></td><td>Closing balance</td><td></td><td></td><td class="r">${formatINR(d.closing)}</td></tr></tbody></table>
  <p class="muted">Owed on invoices today: ${formatINR(d.outstanding)}${Number(d.advances) > 0 ? `; advances held: ${formatINR(d.advances)}` : ''}. A positive balance is owed to ${esc(d.company.legalName)}.</p>
  </body></html>`;
}
