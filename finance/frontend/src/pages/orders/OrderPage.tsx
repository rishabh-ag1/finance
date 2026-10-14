import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../../api';
import { Button, Card, Chip, ErrorNote, Facts, Field, Modal, PageHeader, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { formatINR } from '../../lib/money';
import { apiErrorMessage } from '../../lib/utils';
import { dateLabel } from '../settings/api';
import { LINKED_BY, RECON_KEYS, STATUS_TONE, type Candidate, type OrderDetail } from './api';

// F190 order detail: its route, what has been collected, settled and banked, and its mismatches.
export function OrderPage() {
  const { id } = useParams();
  const orderNumber = decodeURIComponent(id ?? '');
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('financeOrders', 'edit');
  const [asking, setAsking] = useState<{ kind: 'write-off' | 'undo-write-off' | 'unlink-credit' | 'unlink-payment'; target?: string } | null>(null);
  const [reason, setReason] = useState('');
  const [linking, setLinking] = useState(false);
  const { data: o, isLoading, error } = useQuery({ queryKey: ['recon-order', orderNumber], queryFn: async () => (await api.get<{ data: OrderDetail }>(`/recon/orders/${encodeURIComponent(orderNumber)}`)).data.data });
  const { data: credits } = useQuery({
    enabled: linking, queryKey: ['recon-order-credits', orderNumber],
    queryFn: async () => (await api.get<{ data: Candidate[] }>(`/recon/orders/${encodeURIComponent(orderNumber)}/credits`)).data.data,
  });
  const done = () => { for (const k of RECON_KEYS) qc.invalidateQueries({ queryKey: [k] }); setAsking(null); setReason(''); setLinking(false); };
  const act = useMutation({
    mutationFn: async ({ path, body }: { path: string; body?: object }) => (await api.post(path, body ?? {})).data,
    onSuccess: done,
  });

  if (isLoading) return <p className="text-sm text-gray-500">Loading…</p>;
  if (!o) return <ErrorNote>{apiErrorMessage(error, 'Order not found')}</ErrorNote>;
  const s = o.state;
  const written = o.writeOffs.find((w) => !w.isArchived);
  const askPath = () => {
    if (!asking) return '';
    if (asking.kind === 'unlink-credit') return `/recon/order-links/${asking.target}/unlink`;
    if (asking.kind === 'unlink-payment') return `/recon/payments/${asking.target}/unlink`;
    return `/recon/orders/${encodeURIComponent(orderNumber)}/${asking.kind}`;
  };

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <PageHeader
        title={o.order.orderNumber}
        subtitle={`${o.order.customerName} · ${dateLabel(o.order.orderDate)} · ${o.order.channel} · ${o.order.paymentMethod}`}
        action={<Chip tone={s.overdue ? 'red' : STATUS_TONE[s.status]}>{s.statusLabel}{s.overdue ? ' · overdue' : ''}</Chip>}
      />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Card className="p-3"><div className="text-xs text-gray-500">Route</div><div className="font-semibold">{s.routeLabel}</div></Card>
        <Card className="p-3"><div className="text-xs text-gray-500">Expected</div><div className="font-semibold num">{formatINR(s.expectedAmount)}</div></Card>
        <Card className="p-3"><div className="text-xs text-gray-500">Collected</div><div className="font-semibold num">{formatINR(s.collected)}</div></Card>
        <Card className="p-3"><div className="text-xs text-gray-500">{s.bankDate ? 'In bank' : 'Expected by'}</div><div className={s.overdue ? 'font-semibold text-red-700' : 'font-semibold'}>{s.bankDate ? dateLabel(s.bankDate) : s.expectedDate ? dateLabel(s.expectedDate) : '—'}</div></Card>
      </div>

      {canEdit && (
        <div className="flex flex-wrap gap-2">
          {s.route === 'direct' && !s.bankDate && <Button variant="secondary" onClick={() => setLinking(true)}>Link a bank credit</Button>}
          {!written && !['in_bank', 'nothing_due', 'not_tracked'].includes(s.status) && <Button variant="danger" onClick={() => setAsking({ kind: 'write-off' })}>Write off</Button>}
          {written && <Button variant="secondary" onClick={() => setAsking({ kind: 'undo-write-off' })}>Undo write-off</Button>}
        </div>
      )}
      <ErrorNote>{act.isError && !asking && apiErrorMessage(act.error, 'That did not work')}</ErrorNote>
      {written && <p className="text-sm text-gray-700 bg-red-50 rounded-lg px-3 py-2">Written off {formatINR(written.amount)}: {written.reason}</p>}

      <Card className="p-4 sm:p-6">
        <Facts items={[
          { label: 'Order total', value: formatINR(o.order.totalAmount) },
          ...(o.order.advancePaid !== '0.00' ? [{ label: 'Advance paid', value: `${formatINR(o.order.advancePaid)} (not tracked separately yet)` }] : []),
          { label: 'CRM status', value: o.order.crmStatus },
          ...(o.order.shopifyOrderId ? [{ label: 'Shopify order', value: o.order.shopifyOrderId }] : []),
          ...(o.order.awb ? [{ label: 'AWB', value: o.order.awb }] : []),
          ...(o.order.codToCollect ? [{ label: 'COD to collect (bloc-inv)', value: formatINR(o.order.codToCollect) }] : []),
          ...(o.order.shippedAt ? [{ label: 'Shipped', value: dateLabel(o.order.shippedAt) }] : []),
          ...(o.order.deliveredAt ? [{ label: 'Delivered', value: dateLabel(o.order.deliveredAt) }] : []),
          { label: 'Customer', value: [o.order.phone, o.order.email].filter(Boolean).join(' · ') },
        ]} />
      </Card>

      {o.payments.length > 0 && (
        <Card className="p-4 sm:p-6 space-y-2">
          <h2 className="font-semibold text-gray-900">Razorpay payments</h2>
          <ul className="divide-y divide-gray-100 text-sm">
            {o.payments.map((p) => (
              <li key={p.id} className="py-2 flex items-start justify-between gap-2">
                <span className="min-w-0">
                  <span className="block">{p.externalId} · {dateLabel(p.capturedOn)}{p.method ? ` · ${p.method.toUpperCase()}` : ''}</span>
                  <span className="block text-xs text-gray-500">
                    Fee {formatINR(p.fee)} + GST {formatINR(p.taxOnFee)}{p.refunded !== '0.00' ? ` · refunded ${formatINR(p.refunded)}` : ''} · linked by {LINKED_BY[p.linkedBy ?? ''] ?? p.linkedBy}
                    {p.settlement && <> · <Link to={`/order-to-bank/settlements/${p.settlement.id}`} className="text-blue-700 hover:underline">settled {dateLabel(p.settlement.settledOn)}</Link>{p.settlement.bankDate ? `, in bank ${dateLabel(p.settlement.bankDate)}` : ''}</>}
                  </span>
                </span>
                <span className="text-right shrink-0">
                  <span className="block num">{formatINR(p.amount)}</span>
                  {canEdit && <button className="text-xs text-gray-500 hover:underline" onClick={() => setAsking({ kind: 'unlink-payment', target: p.id })}>Not this order</button>}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {o.remittances.length > 0 && (
        <Card className="p-4 sm:p-6 space-y-2">
          <h2 className="font-semibold text-gray-900">COD remittances</h2>
          <ul className="divide-y divide-gray-100 text-sm">
            {o.remittances.map((r) => (
              <li key={r.lineId} className="py-2 flex justify-between gap-2">
                <Link to={`/order-to-bank/settlements/${r.batch.id}`} className="text-blue-700 hover:underline min-w-0 truncate">{r.batch.externalId} · {dateLabel(r.batch.settledOn)}{r.batch.bankDate ? ` · in bank ${dateLabel(r.batch.bankDate)}` : ''}</Link>
                <span className="num">{formatINR(r.amount)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {o.direct.length > 0 && (
        <Card className="p-4 sm:p-6 space-y-2">
          <h2 className="font-semibold text-gray-900">Bank credits</h2>
          <ul className="divide-y divide-gray-100 text-sm">
            {o.direct.map((d) => (
              <li key={d.id} className={`py-2 flex items-start justify-between gap-2 ${d.isArchived ? 'opacity-50 line-through' : ''}`}>
                <span className="min-w-0">
                  {d.bankRow ? <Link to={`/ledger?from=${d.bankRow.txnDate}&to=${d.bankRow.txnDate}`} className="text-blue-700 hover:underline">{dateLabel(d.bankRow.txnDate)} · {d.bankRow.counterpartyName ?? '—'} · credit {formatINR(d.bankRow.credit)}</Link> : '—'}
                  <span className="block text-xs text-gray-500">Linked by {LINKED_BY[d.matchedBy] ?? d.matchedBy}{d.archivedReason ? ` · removed: ${d.archivedReason}` : ''}</span>
                </span>
                <span className="text-right shrink-0">
                  <span className="block num">{formatINR(d.amount)}</span>
                  {canEdit && !d.isArchived && <button className="text-xs text-gray-500 hover:underline" onClick={() => setAsking({ kind: 'unlink-credit', target: d.id })}>Unlink</button>}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {o.discrepancies.length > 0 && (
        <Card className="p-4 sm:p-6 space-y-2">
          <h2 className="font-semibold text-gray-900">Mismatches</h2>
          <ul className="divide-y divide-gray-100 text-sm">
            {o.discrepancies.map((d) => (
              <li key={d.id} className="py-2 flex items-start justify-between gap-2">
                <span className="min-w-0"><span className="block">{d.typeCode}. {d.typeLabel}</span><span className="block text-xs text-gray-500">{d.detail}{d.resolutionNote ? ` · ${d.resolutionLabel}: ${d.resolutionNote}` : ''}</span></span>
                <Chip tone={d.status === 'open' ? 'amber' : 'gray'}>{d.status === 'open' ? 'Open' : d.status === 'resolved' ? 'Resolved' : 'Cleared'}</Chip>
              </li>
            ))}
          </ul>
          {o.discrepancies.some((d) => d.status === 'open') && <Link to="/order-to-bank?tab=discrepancies" className="text-sm text-blue-700 hover:underline">Resolve in the queue</Link>}
        </Card>
      )}

      {linking && (
        <Modal title="Link a bank credit" onClose={() => setLinking(false)}>
          <p className="text-sm text-gray-600">Credits within 45 days after the order; same amount first. A credit that pays several orders can be linked to each of them.</p>
          {!credits && <p className="text-sm text-gray-500">Loading…</p>}
          {credits?.length === 0 && <p className="text-sm text-gray-500">No free credits in that window. Import the statement first.</p>}
          <ul className="divide-y divide-gray-100 text-sm max-h-80 overflow-y-auto">
            {credits?.map((c) => (
              <li key={c.id} className="py-2 flex items-center justify-between gap-2">
                <span className="min-w-0"><span className="block">{dateLabel(c.txnDate)} · {c.counterpartyName ?? '—'} · <b className="num">{formatINR(c.credit)}</b>{c.sameAmount ? ' (same amount)' : ''}</span><span className="block text-[11px] text-gray-400 font-mono truncate">{c.narration}</span></span>
                <Button variant="secondary" disabled={act.isPending} onClick={() => act.mutate({ path: `/recon/orders/${encodeURIComponent(orderNumber)}/link-credit`, body: { txnId: c.id } })}>Link</Button>
              </li>
            ))}
          </ul>
          <ErrorNote>{act.isError && apiErrorMessage(act.error, 'Could not link it')}</ErrorNote>
        </Modal>
      )}

      {asking && (
        <Modal title={asking.kind === 'write-off' ? 'Write off what is still owed' : asking.kind === 'undo-write-off' ? 'Undo the write-off' : 'Remove the link'} onClose={() => setAsking(null)} footer={<>
          <Button variant="secondary" onClick={() => setAsking(null)}>Back</Button>
          <Button variant="danger" disabled={reason.trim().length < 3 || act.isPending} onClick={() => act.mutate({ path: askPath(), body: { reason } })}>Confirm</Button>
        </>}>
          <Field label="Reason"><TextInput autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <ErrorNote>{act.isError && apiErrorMessage(act.error, 'That did not work')}</ErrorNote>
        </Modal>
      )}
    </div>
  );
}
