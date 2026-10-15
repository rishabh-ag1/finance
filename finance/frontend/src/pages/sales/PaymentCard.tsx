import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../../api';
import { Button, Card, Chip, ErrorNote } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { formatINR } from '../../lib/money';
import { apiErrorMessage } from '../../lib/utils';
import { dateLabel } from '../settings/api';
import { PAY_TONE, RECEIVABLE_KEYS, type DocReceivable } from '../receivables/api';
import type { SalesDoc } from './api';

/** F112 / F116 on an issued invoice or proforma: what is received, what is owed, receipts and reminders. */
export function PaymentCard({ d }: { d: SalesDoc }) {
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canSee = hasPermission('financeReceivables', 'view');
  const canEdit = hasPermission('financeReceivables', 'edit');
  const [reminder, setReminder] = useState<string | null>(null);
  const { data: p } = useQuery({ enabled: canSee, queryKey: ['sales-receivable', d.id], queryFn: async () => (await api.get<{ data: DocReceivable | null }>(`/sales/${d.id}/receivable`)).data.data });
  const getText = useMutation({ mutationFn: async () => (await api.get<{ data: { text: string } }>(`/sales/${d.id}/reminder`)).data.data.text, onSuccess: setReminder });
  const log = useMutation({
    mutationFn: async (channel: string) => (await api.post(`/sales/${d.id}/reminder`, { channel })).data.data,
    onSuccess: () => { setReminder(null); for (const k of RECEIVABLE_KEYS) qc.invalidateQueries({ queryKey: [k] }); },
  });
  if (!canSee || !p) return null;
  const isPi = d.docType === 'proforma';
  const phone = (d.billTo.phone ?? '').replace(/\D/g, '');
  const newReceipt = `/receipts/new?${d.crmCompanyId ? `companyId=${d.crmCompanyId}` : `name=${encodeURIComponent(d.billTo.name)}`}&docId=${d.id}`;
  return (
    <Card className="p-4 sm:p-6 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold text-gray-900">{isPi ? 'Advance received' : 'Payment'}</h2>
        {!isPi && <Chip tone={p.overdue ? 'red' : PAY_TONE[p.state]}>{p.stateLabel}{p.overdue ? ` · ${p.daysOverdue} day(s) late` : ''}</Chip>}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
        <div><div className="text-xs text-gray-500">Received</div><div className="num">{formatINR(p.received)}</div></div>
        {p.tds !== '0.00' && <div><div className="text-xs text-gray-500">TDS by customer</div><div className="num">{formatINR(p.tds)}</div></div>}
        {p.credited !== '0.00' && <div><div className="text-xs text-gray-500">Credit notes</div><div className="num">{formatINR(p.credited)}</div></div>}
        {!isPi && <div><div className="text-xs text-gray-500">Outstanding</div><div className="num font-semibold">{formatINR(p.outstanding)}</div></div>}
      </div>
      {p.receipts.length > 0 && (
        <ul className="divide-y divide-gray-100 text-sm">
          {p.receipts.map((r) => (
            <li key={r.allocationId} className="py-1.5 flex justify-between gap-2">
              <span className="truncate"><Link to={`/receipts/${r.receiptId}`} className="hover:underline">{r.receiptNo}</Link> · {dateLabel(r.receiptDate)} · {r.mode}{r.tds !== '0.00' ? ` · TDS ${formatINR(r.tds)}` : ''}</span>
              <span className="num shrink-0">{formatINR(r.amount)}</span>
            </li>
          ))}
        </ul>
      )}
      {canEdit && p.state !== 'paid' && (
        <div className="flex flex-wrap gap-2">
          <Link to={newReceipt} className="inline-flex items-center px-3 py-2 rounded-lg text-sm font-medium bg-[#0c2c55] text-white hover:bg-[#0e3261]">{isPi ? 'Record advance' : 'Record receipt'}</Link>
          {!isPi && <Button variant="secondary" disabled={getText.isPending} onClick={() => getText.mutate()}>Payment reminder</Button>}
        </div>
      )}
      {reminder && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2 text-sm">
          <p className="whitespace-pre-wrap select-all">{reminder}</p>
          <div className="flex flex-wrap gap-2">
            <a href={`https://wa.me/${phone.length >= 10 ? (phone.length === 10 ? `91${phone}` : phone) : ''}?text=${encodeURIComponent(reminder)}`} target="_blank" rel="noreferrer" className="inline-flex items-center px-3 py-2 rounded-lg text-sm font-medium bg-white border border-gray-200 hover:bg-gray-50">Open WhatsApp</a>
            <Button variant="secondary" onClick={() => navigator.clipboard?.writeText(reminder)}>Copy</Button>
            {['whatsapp', 'email', 'phone'].map((c) => <Button key={c} variant="ghost" disabled={log.isPending} onClick={() => log.mutate(c)}>Mark sent by {c === 'phone' ? 'call' : c === 'email' ? 'e-mail' : 'WhatsApp'}</Button>)}
          </div>
        </div>
      )}
      {p.reminders.length > 0 && <p className="text-xs text-gray-500">Reminded {p.reminders.map((r) => `${dateLabel(r.sharedOn)} (${r.channel})`).join(', ')}</p>}
      <ErrorNote>{(getText.isError && apiErrorMessage(getText.error, 'No reminder')) || (log.isError && apiErrorMessage(log.error, 'Not saved'))}</ErrorNote>
    </Card>
  );
}
