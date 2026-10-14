import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import api from '../../api';
import { Button, Card, Chip, ErrorNote, Facts, Field, Modal, PageHeader, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { formatINR } from '../../lib/money';
import { apiErrorMessage, cn } from '../../lib/utils';
import { dateLabel } from '../settings/api';
import { LINKED_BY, RECON_KEYS, type Settlement } from './api';

// F198 one settlement or COD remittance with its three-level tie-out (BR-47).
export function SettlementPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('financeOrders', 'edit');
  const [unlinking, setUnlinking] = useState(false);
  const [reason, setReason] = useState('');
  const { data: b, isLoading } = useQuery({ queryKey: ['recon-settlement', id], queryFn: async () => (await api.get<{ data: Settlement }>(`/recon/settlements/${id}`)).data.data });
  const act = useMutation({
    mutationFn: async ({ path, body }: { path: string; body: object }) => (await api.post<{ data: Settlement }>(`/recon/settlements/${id}/${path}`, body)).data.data,
    onSuccess: (d) => { qc.setQueryData(['recon-settlement', id], d); for (const k of RECON_KEYS) qc.invalidateQueries({ queryKey: [k] }); setUnlinking(false); setReason(''); },
  });
  if (isLoading || !b) return <p className="text-sm text-gray-500">Loading…</p>;
  const isRzp = b.source === 'razorpay';

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <PageHeader
        title={`${isRzp ? 'Razorpay settlement' : 'COD remittance'} ${b.externalId}`}
        subtitle={`${dateLabel(b.settledOn)}${b.utr ? ` · UTR ${b.utr}` : ''}`}
        action={<Chip tone={b.bankRow ? 'green' : 'amber'}>{b.bankRow ? 'In bank' : 'Not in the bank yet'}</Chip>}
      />

      <Card className="p-4 sm:p-6 space-y-3">
        <h2 className="font-semibold text-gray-900">Tie-out</h2>
        <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 text-sm">
          {([['Gross', b.totals.gross], ['Fees', b.totals.fees], ['GST on fees', b.totals.taxOnFees], ['Refunds', b.totals.refunds], ['Adjustments', b.totals.adjustments], ['Net', b.totals.net]] as const).map(([l, v]) => (
            <div key={l}><div className="text-xs text-gray-500">{l}</div><div className={cn('num', l === 'Net' && 'font-semibold')}>{formatINR(v)}</div></div>
          ))}
        </div>
        <ul className="space-y-1 text-sm">
          {b.levels.map((l) => (
            <li key={l.level} className="flex items-center gap-2">
              {l.ok === null ? <span className="w-4 h-4 rounded-full border border-gray-300 inline-block" /> : l.ok ? <Check className="w-4 h-4 text-emerald-600" /> : <X className="w-4 h-4 text-red-600" />}
              <span className="flex-1">Level {l.level}: {l.label}</span>
              <span className={cn('num', l.ok === false && 'text-red-700')}>{l.difference === null ? 'waits for the bank credit' : l.ok ? 'agrees' : `differs by ${formatINR(l.difference)}`}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="p-4 sm:p-6 space-y-2">
        <h2 className="font-semibold text-gray-900">Bank credit</h2>
        {b.bankRow ? (
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <Facts items={[{ label: 'Credit', value: <Link to={`/ledger?accountId=${b.bankRow.bankAccountId}&from=${b.bankRow.txnDate}&to=${b.bankRow.txnDate}`} className="text-blue-700 hover:underline">{dateLabel(b.bankRow.txnDate)} · {b.bankRow.counterpartyName ?? '—'} · {formatINR(b.bankRow.credit)}</Link> }, { label: 'Matched', value: LINKED_BY[b.matchedBy ?? ''] ?? b.matchedBy }]} />
            {canEdit && <Button variant="secondary" onClick={() => setUnlinking(true)}>Unlink</Button>}
          </div>
        ) : (
          <>
            {b.candidates.length === 0 && <p className="text-sm text-gray-500">No free bank credit near {dateLabel(b.settledOn)} yet. Import the statement; a credit of exactly {formatINR(b.totals.net)} with the UTR, or from {isRzp ? 'Razorpay' : 'Shiprocket'} in the expected days, links by itself.</p>}
            <ul className="divide-y divide-gray-100 text-sm">
              {b.candidates.map((c) => (
                <li key={c.id} className="py-2 flex items-center justify-between gap-2">
                  <span className="min-w-0"><span className="block">{dateLabel(c.txnDate)} · {c.counterpartyName ?? '—'} · <b className="num">{formatINR(c.credit)}</b>{c.sameAmount ? ' (same amount)' : ''}</span><span className="block text-[11px] text-gray-400 font-mono truncate">{c.narration}</span></span>
                  {canEdit && <Button variant="secondary" disabled={act.isPending} onClick={() => act.mutate({ path: 'link', body: { txnId: c.id } })}>Link</Button>}
                </li>
              ))}
            </ul>
          </>
        )}
        <ErrorNote>{act.isError && !unlinking && apiErrorMessage(act.error, 'That did not work')}</ErrorNote>
      </Card>

      <Card className="overflow-x-auto">
        <table className="min-w-full text-xs sm:text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="text-left font-medium px-3 py-2">{isRzp ? 'Payment' : 'AWB'}</th>
              <th className="text-left font-medium px-2 py-2">Order</th>
              <th className="text-right font-medium px-2 py-2">Order amount</th>
              <th className="text-right font-medium px-2 py-2">Gross</th>
              {isRzp && <th className="text-right font-medium px-2 py-2">Fee + GST</th>}
              {isRzp && <th className="text-right font-medium px-2 py-2">Refund / adj.</th>}
              <th className="text-right font-medium px-3 py-2">Net</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {b.lines.map((l) => (
              <tr key={l.id}>
                <td className="px-3 py-1.5 whitespace-nowrap">{l.awb ?? l.externalId}{l.type !== 'payment' && l.type !== 'cod' ? ` (${l.type})` : ''}</td>
                <td className="px-2 py-1.5 whitespace-nowrap">{l.orderNumber ? <Link to={`/order-to-bank/orders/${encodeURIComponent(l.orderNumber)}`} className="text-blue-700 hover:underline">{l.orderNumber}</Link> : <span className="text-amber-700">not linked</span>}</td>
                <td className={cn('text-right num px-2 py-1.5', l.orderAmount && l.orderAmount !== l.gross && 'text-red-700')}>{l.orderAmount ? formatINR(l.orderAmount) : '—'}</td>
                <td className="text-right num px-2 py-1.5">{formatINR(l.gross)}</td>
                {isRzp && <td className="text-right num px-2 py-1.5">{l.fee === '0.00' && l.taxOnFee === '0.00' ? '—' : `${formatINR(l.fee)} + ${formatINR(l.taxOnFee)}`}</td>}
                {isRzp && <td className="text-right num px-2 py-1.5">{l.refund !== '0.00' ? `-${formatINR(l.refund)}` : l.adjustment !== '0.00' ? formatINR(l.adjustment) : '—'}</td>}
                <td className="text-right num px-3 py-1.5">{formatINR(l.net)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {b.discrepancies.length > 0 && (
        <Card className="p-4 sm:p-6 space-y-2">
          <h2 className="font-semibold text-gray-900">Mismatches</h2>
          <ul className="divide-y divide-gray-100 text-sm">
            {b.discrepancies.map((d) => (
              <li key={d.id} className="py-2 flex items-start justify-between gap-2">
                <span className="min-w-0"><span className="block">{d.typeCode}. {d.typeLabel}</span><span className="block text-xs text-gray-500">{d.detail}</span></span>
                <Chip tone={d.status === 'open' ? 'amber' : 'gray'}>{d.status === 'open' ? 'Open' : d.status === 'resolved' ? 'Resolved' : 'Cleared'}</Chip>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {unlinking && (
        <Modal title="Unlink the bank credit" onClose={() => setUnlinking(false)} footer={<>
          <Button variant="secondary" onClick={() => setUnlinking(false)}>Back</Button>
          <Button variant="danger" disabled={reason.trim().length < 3 || act.isPending} onClick={() => act.mutate({ path: 'unlink', body: { reason } })}>Unlink</Button>
        </>}>
          <Field label="Reason"><TextInput autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <ErrorNote>{act.isError && apiErrorMessage(act.error, 'That did not work')}</ErrorNote>
        </Modal>
      )}
    </div>
  );
}
