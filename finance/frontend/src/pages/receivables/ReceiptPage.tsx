import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../../api';
import { Button, Card, Chip, ErrorNote, Facts, Field, MoneyInput, PageHeader } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { formatINR } from '../../lib/money';
import { apiErrorMessage } from '../../lib/utils';
import { dateLabel } from '../settings/api';
import { RECEIVABLE_KEYS, type OpenDoc, type Receipt } from './api';

type Candidate = { id: string; txnDate: string; counterpartyName: string | null; utr: string | null; credit: string; narration: string };

function AllocateAdvance({ r }: { r: Receipt }) {
  const qc = useQueryClient();
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const { data: docs } = useQuery({
    queryKey: ['receivables', 'open-docs', r.crmCompanyId ?? r.customerName],
    queryFn: async () => (await api.get<{ data: OpenDoc[] }>('/receivables/open-docs', { params: r.crmCompanyId ? { companyId: r.crmCompanyId } : { name: r.customerName } })).data.data,
  });
  const save = useMutation({
    mutationFn: async () => (await api.post(`/receipts/${r.id}/allocate`, { allocations: Object.entries(alloc).filter(([, v]) => v && Number(v) > 0).map(([docId, amount]) => ({ docId, amount })) })).data.data,
    onSuccess: () => { setAlloc({}); for (const k of RECEIVABLE_KEYS) qc.invalidateQueries({ queryKey: [k] }); },
  });
  if (!docs?.length) return <p className="text-sm text-gray-500">No open invoices or proformas for this customer: the advance waits for the next invoice.</p>;
  return (
    <div className="space-y-2">
      {docs.map((d) => (
        <div key={d.id} className="grid grid-cols-[1fr_9rem] gap-2 items-end">
          <div className="text-sm min-w-0"><div className="font-medium truncate">{d.docNumber}</div><div className="text-xs text-gray-500">owes {formatINR(d.outstanding)}</div></div>
          <Field label="Amount"><MoneyInput value={alloc[d.id] ?? ''} onChange={(e) => setAlloc({ ...alloc, [d.id]: e.target.value })} /></Field>
        </div>
      ))}
      <ErrorNote>{save.isError && apiErrorMessage(save.error, 'Could not allocate')}</ErrorNote>
      <div className="text-right"><Button disabled={save.isPending} onClick={() => save.mutate()}>Set against these</Button></div>
    </div>
  );
}

// F111 a receipt: where it went, its bank row, and its advance.
export function ReceiptPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('financeReceivables', 'edit');
  const { data: r } = useQuery({ queryKey: ['receipt', id], queryFn: async () => (await api.get<{ data: Receipt }>(`/receipts/${id}`)).data.data });
  const candidates = useQuery({ enabled: !!r && r.status === 'recorded' && !r.inBank && r.source === 'manual' && r.mode !== 'cash', queryKey: ['receipt', id, 'candidates'], queryFn: async () => (await api.get<{ data: Candidate[] }>(`/receipts/${id}/bank-candidates`)).data.data });
  const refresh = () => { for (const k of RECEIVABLE_KEYS) qc.invalidateQueries({ queryKey: [k] }); };
  const act = useMutation({
    mutationFn: async (a: { path: string; body?: object }) => (await api.post(`/receipts/${a.path}`, a.body ?? {})).data.data,
    onSuccess: refresh,
  });
  const withReason = (question: string, path: string) => { const reason = window.prompt(question); if (reason) act.mutate({ path, body: { reason } }); };
  if (!r) return <p className="text-sm text-gray-500">Loading…</p>;
  const active = r.allocations.filter((a) => !a.isArchived);
  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <PageHeader
        title={`${r.receiptNo} · ${r.customerName}`}
        subtitle={<><Link to="/receivables?tab=receipts" className="text-[#0c2c55] hover:underline">Receivables</Link> › receipt of {dateLabel(r.receiptDate)}</>}
        action={canEdit && r.status === 'recorded' && <Button variant="danger" disabled={act.isPending} onClick={() => withReason('Why is this receipt cancelled? Its allocations are removed and the invoices owe again.', `${r.id}/cancel`)}>Cancel receipt</Button>}
      />
      {r.status === 'cancelled' && <Card className="p-3 text-sm text-red-700">Cancelled: {r.statusReason}</Card>}
      <Card className="p-4 sm:p-6">
        <Facts items={[
          { label: 'Received', value: <span className="num">{formatINR(r.amount)}</span> },
          ...(r.tds !== '0.00' ? [{ label: 'TDS deducted by customer', value: <span className="num">{formatINR(r.tds)}</span> }] : []),
          ...(r.bankCharges !== '0.00' ? [{ label: 'Gateway / bank charges', value: <span className="num">{formatINR(r.bankCharges)}{r.gstOnCharges !== '0.00' ? ` (GST ${formatINR(r.gstOnCharges)})` : ''}</span> }] : []),
          { label: 'Total settled', value: <span className="num">{formatINR(r.total)}</span> },
          { label: 'How', value: `${r.modeLabel}${r.reference ? ` · ${r.reference}` : ''}` },
          ...(r.toBankAccount ? [{ label: 'Into', value: r.toBankAccount }] : []),
          ...(r.crmOrderNumber ? [{ label: 'CRM order', value: <Link to={`/order-to-bank/orders/${encodeURIComponent(r.crmOrderNumber)}`} className="text-blue-700 hover:underline">{r.crmOrderNumber}</Link> }] : []),
          ...(r.notes ? [{ label: 'Notes', value: r.notes }] : []),
        ]} />
      </Card>
      <ErrorNote>{act.isError && apiErrorMessage(act.error, 'That did not work')}</ErrorNote>

      <Card className="p-4 sm:p-6 space-y-2">
        <h2 className="font-semibold text-gray-900">Set against</h2>
        {active.length === 0 && <p className="text-sm text-gray-500">Nothing yet.</p>}
        <ul className="divide-y divide-gray-100 text-sm">
          {r.allocations.map((a) => (
            <li key={a.id} className={`py-2 flex items-start justify-between gap-2 ${a.isArchived ? 'text-gray-400' : ''}`}>
              <div className="min-w-0">
                <Link to={`/sales/${a.docId}`} className="hover:underline">{a.docNumber ?? 'Document'}</Link>{a.docType === 'proforma' && ' (advance on proforma)'}
                {a.tds !== '0.00' && <span className="text-xs text-gray-500"> · TDS {formatINR(a.tds)}</span>}
                {a.isArchived && <div className="text-xs">Removed: {a.archivedReason}</div>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="num">{formatINR(a.amount)}</span>
                {canEdit && !a.isArchived && r.status === 'recorded' && <Button variant="ghost" disabled={act.isPending} onClick={() => withReason('Why is this allocation removed?', `allocations/${a.id}/remove`)}>Remove</Button>}
              </div>
            </li>
          ))}
        </ul>
        {r.advance !== '0.00' && (
          <div className="pt-2 border-t border-gray-100 space-y-2">
            <div className="flex items-center gap-2"><Chip tone="blue">Advance</Chip><span className="text-sm">{formatINR(r.advance)} not yet set against an invoice</span></div>
            {canEdit && <AllocateAdvance r={r} />}
          </div>
        )}
      </Card>

      {r.status === 'recorded' && r.mode !== 'cash' && (
        <Card className="p-4 sm:p-6 space-y-2">
          <h2 className="font-semibold text-gray-900">Bank statement</h2>
          {r.source !== 'manual' && <p className="text-sm text-gray-600">{r.source === 'settlement' ? 'Part of a Razorpay settlement or COD remittance: the bank credit is linked to the settlement in Order-to-bank.' : 'Paid directly for a CRM order: the bank credit is linked to the order.'}</p>}
          {r.bankRow && (
            <div className="flex items-start justify-between gap-2 text-sm">
              <div className="min-w-0"><div>{dateLabel(r.bankRow.txnDate)} · {formatINR(r.bankRow.credit)}</div><div className="text-xs text-gray-500 truncate">{r.bankRow.narration}</div></div>
              {canEdit && r.source === 'manual' && <Button variant="ghost" disabled={act.isPending} onClick={() => withReason('Why is this the wrong bank row?', `${r.id}/unlink`)}>Unlink</Button>}
            </div>
          )}
          {!r.bankRow && r.source === 'manual' && (
            <>
              <p className="text-sm text-gray-600">Not found in an imported statement yet. It links by itself when the statement with this credit is imported, or pick the row:</p>
              {candidates.data?.length === 0 && <p className="text-sm text-gray-500">No free credit of {formatINR(r.amount)} within 10 days.</p>}
              <ul className="divide-y divide-gray-100 text-sm">
                {candidates.data?.map((c) => (
                  <li key={c.id} className="py-2 flex items-start justify-between gap-2">
                    <div className="min-w-0"><div>{dateLabel(c.txnDate)} · {c.counterpartyName ?? ''}</div><div className="text-xs text-gray-500 truncate">{c.narration}</div></div>
                    {canEdit && <Button variant="secondary" disabled={act.isPending} onClick={() => act.mutate({ path: `${r.id}/link`, body: { txnId: c.id } })}>Link</Button>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
