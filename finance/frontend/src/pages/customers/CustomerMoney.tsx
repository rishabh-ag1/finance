import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import api from '../../api';
import { Card, Chip, Field, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { formatINR } from '../../lib/money';
import { dateLabel } from '../settings/api';
import { PAY_TONE, type OutstandingRow } from '../receivables/api';

const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const fyStart = () => { const t = today(); const y = Number(t.slice(0, 4)) - (Number(t.slice(5, 7)) < 4 ? 1 : 0); return `${y}-04-01`; };
type Statement = { opening: string; closing: string; outstanding: string; advances: string; lines: { date: string; kind: string; ref: string; detail: string; debit: string; credit: string; balance: string; docId?: string }[] };

/** F082: what a customer owes, its open invoices and its statement (PDF). */
export function CustomerMoney({ companyId }: { companyId: string }) {
  const { hasPermission } = useAuth();
  const [from, setFrom] = useState(fyStart());
  const [to, setTo] = useState(today());
  const canSee = hasPermission('financeReceivables', 'view');
  const { data: out } = useQuery({ enabled: canSee, queryKey: ['receivables', 'outstanding', 'company', companyId], queryFn: async () => (await api.get<{ data: { rows: OutstandingRow[]; totals: { outstanding: string; overdue: string } } }>('/receivables/outstanding', { params: { companyId } })).data.data });
  const { data: st } = useQuery({ enabled: canSee && !!from && !!to, queryKey: ['receivables', 'statement', companyId, from, to], queryFn: async () => (await api.get<{ data: Statement }>(`/receivables/statement/${companyId}`, { params: { from, to } })).data.data });
  if (!canSee) return null;
  return (
    <Card className="p-4 sm:p-6 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold text-gray-900">Owed and paid</h2>
        <Link to={`/receipts/new?companyId=${companyId}`} className="text-sm text-[#0c2c55] hover:underline">Record receipt</Link>
      </div>
      {out && (
        <p className="text-sm text-gray-700">
          Owes {formatINR(out.totals.outstanding)}{out.totals.overdue !== '0.00' ? `, ${formatINR(out.totals.overdue)} overdue` : ''}{st && st.advances !== '0.00' ? `; advances held ${formatINR(st.advances)}` : ''}.
        </p>
      )}
      {!!out?.rows.length && (
        <ul className="divide-y divide-gray-100 text-sm">
          {out.rows.map((r) => (
            <li key={r.id} className="py-1.5 flex justify-between gap-2">
              <span className="truncate"><Link to={`/sales/${r.id}`} className="hover:underline">{r.docNumber}</Link> · {r.dueDate ? `due ${dateLabel(r.dueDate)}` : 'no due date'}</span>
              <span className="shrink-0 flex items-center gap-2"><span className="num">{formatINR(r.outstanding)}</span><Chip tone={r.overdue ? 'red' : PAY_TONE[r.state]}>{r.overdue ? `${r.daysOverdue}d late` : r.stateLabel}</Chip></span>
            </li>
          ))}
        </ul>
      )}
      <div className="pt-2 border-t border-gray-100 space-y-2">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Statement from" className="w-40"><TextInput type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="to" className="w-40"><TextInput type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <a href={`${import.meta.env.VITE_API_URL}/receivables/statement/${companyId}/pdf?from=${from}&to=${to}`} target="_blank" rel="noreferrer" className="inline-flex items-center px-3 py-2 rounded-lg text-sm font-medium bg-white border border-gray-200 hover:bg-gray-50">Statement PDF</a>
        </div>
        {st && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs sm:text-sm">
              <thead><tr className="text-left text-gray-500"><th className="py-1 pr-2">Date</th><th className="pr-2">Reference</th><th className="text-right pr-2">Invoiced</th><th className="text-right pr-2">Paid / credited</th><th className="text-right">Balance</th></tr></thead>
              <tbody className="divide-y divide-gray-100">
                <tr><td className="py-1 pr-2">{dateLabel(from)}</td><td className="pr-2 text-gray-500">Opening</td><td /><td /><td className="text-right num">{formatINR(st.opening)}</td></tr>
                {st.lines.map((l, i) => (
                  <tr key={i}>
                    <td className="py-1 pr-2 whitespace-nowrap">{dateLabel(l.date)}</td>
                    <td className="pr-2 whitespace-nowrap">{l.docId ? <Link to={`/sales/${l.docId}`} className="hover:underline">{l.ref}</Link> : l.ref}</td>
                    <td className="text-right num pr-2">{l.debit !== '0.00' ? formatINR(l.debit) : ''}</td>
                    <td className="text-right num pr-2">{l.credit !== '0.00' ? formatINR(l.credit) : ''}</td>
                    <td className="text-right num">{formatINR(l.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}
