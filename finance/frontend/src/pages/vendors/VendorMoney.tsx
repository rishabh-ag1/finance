import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import api from '../../api';
import { Card, Chip, Field, TextInput } from '../../components/ui/kit';
import { formatINR } from '../../lib/money';
import { dateLabel } from '../settings/api';

const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const fyStart = () => { const t = today(); const y = Number(t.slice(0, 4)) - (Number(t.slice(5, 7)) < 4 ? 1 : 0); return `${y}-04-01`; };
type Overview = {
  outstanding: string; overdue: string; advances: string; paidThisFy: string; tdsByFy: { fy: string; amount: string }[];
  purchaseOrders: { id: string; poNumber: string | null; poDate: string; total: string; billed: string; status: string }[];
  documents: { id: string; docType: string; docNumber: string; docDate: string; dueDate: string | null; total: string; outstanding: string; status: string }[];
};
type Statement = { opening: string; closing: string; lines: { date: string; ref: string; detail: string; debit: string; credit: string; balance: string }[] };

/** F038 Vendor 360: what is owed, POs, bills, TDS and the statement for reconciliation. */
export function VendorMoney({ vendorId }: { vendorId: string }) {
  const [from, setFrom] = useState(fyStart());
  const [to, setTo] = useState(today());
  const { data: o } = useQuery({ queryKey: ['vendor', vendorId, 'overview'], queryFn: async () => (await api.get<{ data: Overview }>(`/vendors/${vendorId}/overview`)).data.data });
  const { data: st } = useQuery({ enabled: !!from && !!to, queryKey: ['vendor', vendorId, 'statement', from, to], queryFn: async () => (await api.get<{ data: Statement }>(`/vendors/${vendorId}/statement`, { params: { from, to } })).data.data });
  if (!o) return null;
  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Card className="p-3"><div className="text-xs text-gray-500">Owed to them</div><div className="text-lg font-semibold num">{formatINR(o.outstanding, { decimals: false })}</div>{o.overdue !== '0.00' && <div className="text-xs text-red-700">{formatINR(o.overdue, { decimals: false })} overdue</div>}</Card>
        <Card className="p-3"><div className="text-xs text-gray-500">Advances not yet billed</div><div className="text-lg font-semibold num">{formatINR(o.advances, { decimals: false })}</div></Card>
        <Card className="p-3"><div className="text-xs text-gray-500">Paid this FY</div><div className="text-lg font-semibold num">{formatINR(o.paidThisFy, { decimals: false })}</div></Card>
        <Card className="p-3"><div className="text-xs text-gray-500">TDS deducted</div>{o.tdsByFy.length ? o.tdsByFy.slice(0, 2).map((t) => <div key={t.fy} className="text-sm num">FY {t.fy}: {formatINR(t.amount)}</div>) : <div className="text-lg font-semibold">–</div>}</Card>
      </div>
      {(o.purchaseOrders.length > 0 || o.documents.length > 0) && (
        <Card className="p-4 sm:p-6 space-y-3">
          {o.purchaseOrders.length > 0 && (
            <div>
              <h2 className="font-semibold text-gray-900 mb-1">Purchase orders</h2>
              <ul className="divide-y divide-gray-100 text-sm">
                {o.purchaseOrders.slice(0, 10).map((p) => (
                  <li key={p.id} className="py-1.5 flex justify-between gap-2">
                    <Link to={`/purchase-orders/${p.id}`} className="truncate hover:underline">{p.poNumber ?? 'Draft'} · {dateLabel(p.poDate)}</Link>
                    <span className="shrink-0 num">{formatINR(p.total, { decimals: false })} <span className="text-xs text-gray-500">billed {formatINR(p.billed, { decimals: false })}</span></span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {o.documents.length > 0 && (
            <div>
              <h2 className="font-semibold text-gray-900 mb-1">Bills and quotes</h2>
              <ul className="divide-y divide-gray-100 text-sm">
                {o.documents.slice(0, 15).map((d) => (
                  <li key={d.id} className="py-1.5 flex justify-between gap-2">
                    <Link to={`/bills/${d.id}`} className="truncate hover:underline">{d.docNumber} · {d.docType.replace('_', ' ')} · {dateLabel(d.docDate)}</Link>
                    <span className="shrink-0 flex items-center gap-2"><span className="num">{formatINR(d.total, { decimals: false })}</span>{d.outstanding !== '0.00' && <Chip tone={d.dueDate && d.dueDate < today() ? 'red' : 'amber'}>owes {formatINR(d.outstanding, { decimals: false })}</Chip>}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}
      <Card className="p-4 sm:p-6 space-y-2">
        <h2 className="font-semibold text-gray-900">Statement</h2>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="From" className="w-40"><TextInput type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="to" className="w-40"><TextInput type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <a href={`${import.meta.env.VITE_API_URL}/vendors/${vendorId}/statement.pdf?from=${from}&to=${to}`} target="_blank" rel="noreferrer" className="inline-flex items-center px-3 py-2 rounded-lg text-sm font-medium bg-white border border-gray-200 hover:bg-gray-50">Statement PDF</a>
        </div>
        {st && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs sm:text-sm">
              <thead><tr className="text-left text-gray-500"><th className="py-1 pr-2">Date</th><th className="pr-2">Reference</th><th className="text-right pr-2">Billed</th><th className="text-right pr-2">Paid / TDS / notes</th><th className="text-right">Owed</th></tr></thead>
              <tbody className="divide-y divide-gray-100">
                <tr><td className="py-1 pr-2">{dateLabel(from)}</td><td className="pr-2 text-gray-500">Opening</td><td /><td /><td className="text-right num">{formatINR(st.opening)}</td></tr>
                {st.lines.map((l, i) => (
                  <tr key={i}><td className="py-1 pr-2 whitespace-nowrap">{dateLabel(l.date)}</td><td className="pr-2 whitespace-nowrap" title={l.detail}>{l.ref}</td><td className="text-right num pr-2">{l.debit !== '0.00' ? formatINR(l.debit) : ''}</td><td className="text-right num pr-2">{l.credit !== '0.00' ? formatINR(l.credit) : ''}</td><td className="text-right num">{formatINR(l.balance)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
