import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import api from '../../api';
import { FunnelTab } from './FunnelTab';
import { Button, Card, Chip, ErrorNote, Field, Modal, PageHeader, Select, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { formatDateTime } from '../../lib/format';
import { formatINR } from '../../lib/money';
import { apiErrorMessage, cn } from '../../lib/utils';
import { dateLabel } from '../settings/api';
import {
  CHANNELS, RECON_KEYS, RESOLUTIONS, ROUTES, STATUS_ORDER, STATUS_TONE, fileToBase64,
  type Discrepancy, type InTransit, type SettlementRow, type Tracker,
} from './api';

const TABS = [['tracker', 'Orders'], ['discrepancies', 'Discrepancies'], ['settlements', 'Settlements'], ['funnel', 'Funnel'], ['import', 'Import reports']] as const;
const short = (v: string | null | undefined) => formatINR(v ?? '0', { decimals: false });

// F197 money in transit.
function Transit() {
  const { data: t } = useQuery({ queryKey: ['recon-transit'], queryFn: async () => (await api.get<{ data: InTransit }>('/recon/in-transit')).data.data });
  if (!t) return null;
  const cards: [string, InTransit['paidAtGateway'], string][] = [
    ['Paid at Razorpay, not settled', t.paidAtGateway, 'paid_at_gateway'],
    ['COD delivered, not remitted', t.deliveredAwaitingRemittance, 'delivered_awaiting_remittance'],
    ['Settled, not in the bank', t.settledNotInBank, 'settled'],
    ['Remitted, not in the bank', t.remittedNotInBank, 'remitted'],
  ];
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-700">Money in transit</h2>
        <span className="text-sm text-gray-600">Total <b className="num">{short(t.total)}</b></span>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        {cards.map(([label, s, status]) => (
          <Link key={label} to={status === 'settled' || status === 'remitted' ? '/order-to-bank?tab=settlements&notInBank=true' : `/order-to-bank?tab=tracker&status=${status}`} className="block hover:opacity-90">
            <Card className="p-3 h-full">
              <div className="text-xs text-gray-500">{label}</div>
              <div className="text-lg font-semibold num">{short(s.amount)}</div>
              <div className={cn('text-xs', s.overdue ? 'text-red-700' : 'text-gray-500')}>{s.count} · {s.overdue ? `${s.overdue} overdue` : s.oldestExpected ? `next due ${dateLabel(s.oldestExpected)}` : 'none due'}</div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}

// F190 / F191 tracker.
function TrackerTab() {
  const [params, setParams] = useSearchParams();
  const f = { status: params.get('status') ?? '', route: params.get('route') ?? '', channel: params.get('channel') ?? '', q: params.get('q') ?? '', from: params.get('from') ?? '', to: params.get('to') ?? '', showInBank: params.get('showInBank') === 'true', discrepancyOnly: params.get('discrepancyOnly') === 'true' };
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { replace: true }); };
  const { data, isLoading } = useQuery({
    queryKey: ['recon-tracker', f],
    queryFn: async () => (await api.get<{ data: Tracker }>('/recon/tracker', { params: { ...f, status: f.status || undefined, route: f.route || undefined, channel: f.channel || undefined, q: f.q || undefined, from: f.from || undefined, to: f.to || undefined } })).data.data,
  });
  return (
    <div className="space-y-3">
      <Card className="p-3 sm:p-4 grid grid-cols-2 sm:grid-cols-4 gap-2">
        <TextInput placeholder="Order, customer, phone, AWB, pay_ id" value={f.q} onChange={(e) => set('q', e.target.value)} className="col-span-2" />
        <Select value={f.route} onChange={(e) => set('route', e.target.value)} aria-label="Route"><option value="">Any route</option>{ROUTES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        <Select value={f.channel} onChange={(e) => set('channel', e.target.value)} aria-label="Channel"><option value="">Any channel</option>{CHANNELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        <Field label="Ordered from"><TextInput type="date" value={f.from} onChange={(e) => set('from', e.target.value)} /></Field>
        <Field label="to"><TextInput type="date" value={f.to} onChange={(e) => set('to', e.target.value)} /></Field>
        <label className="flex items-center gap-2 text-sm self-end pb-2"><input type="checkbox" checked={f.showInBank} onChange={(e) => set('showInBank', e.target.checked ? 'true' : '')} /> Show finished</label>
        <label className="flex items-center gap-2 text-sm self-end pb-2"><input type="checkbox" checked={f.discrepancyOnly} onChange={(e) => set('discrepancyOnly', e.target.checked ? 'true' : '')} /> Mismatches only</label>
      </Card>
      {data && (
        <div className="flex gap-1.5 overflow-x-auto -mx-3 px-3 sm:mx-0 sm:px-0 pb-1">
          <button onClick={() => set('status', '')} className={cn('shrink-0 rounded-full border px-3 py-1 text-xs', !f.status ? 'bg-[#0c2c55] text-white border-[#0c2c55]' : 'bg-white border-gray-200 text-gray-700')}>{f.showInBank ? 'All' : 'All open'}</button>
          {STATUS_ORDER.filter((k) => data.totals[k]?.count).map((k) => (
            <button key={k} onClick={() => set('status', f.status === k ? '' : k)} className={cn('shrink-0 rounded-full border px-3 py-1 text-xs whitespace-nowrap', f.status === k ? 'bg-[#0c2c55] text-white border-[#0c2c55]' : 'bg-white border-gray-200 text-gray-700')}>
              {data.totals[k].label} · {data.totals[k].count} · {short(data.totals[k].amount)}
            </button>
          ))}
        </div>
      )}
      {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
      {data && (data.readers.crm === 'stub' || data.readers.inventory === 'stub') && (
        <p className="flex items-start gap-2 text-xs text-gray-600 bg-amber-50 rounded-lg px-3 py-2">
          <AlertTriangle className="w-4 h-4 mt-px shrink-0 text-amber-600" />
          Not connected to the {data.readers.crm === 'stub' ? 'CRM' : ''}{data.readers.crm === 'stub' && data.readers.inventory === 'stub' ? ' or ' : ''}{data.readers.inventory === 'stub' ? 'bloc-inv' : ''} database yet: orders are read from stand-in tables until Finance runs on the same server (D15, Q33).
        </p>
      )}
      {data && (
        <p className="text-xs text-gray-500">Orders placed {dateLabel(data.from)} to {dateLabel(data.to)}{data.overdue ? <span className="text-red-700"> · {data.overdue} overdue</span> : ''}. Orders come from the CRM; delivery facts from bloc-inv.</p>
      )}
      {data?.rows.length === 0 && <Card className="p-4 text-sm text-gray-500">No orders match.</Card>}
      {!!data?.rows.length && (
        <Card className="divide-y divide-gray-100">
          {data.rows.map((r) => (
            <Link key={r.orderNumber} to={`/order-to-bank/orders/${encodeURIComponent(r.orderNumber)}`} className="block px-3 sm:px-4 py-3 hover:bg-gray-50/70">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-gray-900 truncate">{r.orderNumber} · {r.customerName}</div>
                  <div className="text-xs text-gray-500 truncate">{dateLabel(r.orderDate)} · {r.routeLabel}{r.gatewayRef ? ` · ${r.gatewayRef}` : ''}{r.settlementRef ? ` · ${r.settlementRef}` : ''}</div>
                  <div className="text-xs text-gray-500">
                    {r.bankDate ? `In bank ${dateLabel(r.bankDate)}` : r.expectedDate ? <span className={r.overdue ? 'text-red-700' : ''}>Expected {dateLabel(r.expectedDate)}{r.overdue ? ' · overdue' : ''}</span> : null}
                    {r.discrepancies.length > 0 && <span className="text-amber-800"> · {r.discrepancies.length} mismatch{r.discrepancies.length === 1 ? '' : 'es'}</span>}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="num font-medium">{formatINR(r.expectedAmount)}</div>
                  <Chip tone={r.overdue ? 'red' : STATUS_TONE[r.status]}>{r.statusLabel}</Chip>
                </div>
              </div>
            </Link>
          ))}
        </Card>
      )}
    </div>
  );
}

function ResolveModal({ d, onClose }: { d: Discrepancy; onClose: () => void }) {
  const qc = useQueryClient();
  const [action, setAction] = useState(d.typeCode === 3 || d.typeCode === 4 || d.typeCode === 5 ? 'chase_razorpay' : d.typeCode === 9 || d.typeCode === 10 ? 'chase_shiprocket' : 'crm_corrected');
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: async () => (await api.post(`/recon/discrepancies/${d.id}/resolve`, { action, note })).data,
    onSuccess: () => { for (const k of RECON_KEYS) qc.invalidateQueries({ queryKey: [k] }); onClose(); },
  });
  return (
    <Modal title={`Resolve: ${d.typeLabel}`} onClose={onClose} footer={<>
      <Button variant="secondary" onClick={onClose}>Back</Button>
      <Button disabled={note.trim().length < 3 || save.isPending} onClick={() => save.mutate()}>Mark resolved</Button>
    </>}>
      <p className="text-sm text-gray-600">{d.detail}. Suggested: {d.suggestedAction}.</p>
      <Field label="What was done"><Select value={action} onChange={(e) => setAction(e.target.value)}>{RESOLUTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
      <Field label="Note"><TextInput autoFocus value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <ErrorNote>{save.isError && apiErrorMessage(save.error, 'Could not save')}</ErrorNote>
    </Modal>
  );
}

// F196 discrepancy queue (BR-46).
function DiscrepanciesTab() {
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('financeOrders', 'edit');
  const [status, setStatus] = useState('open');
  const [type, setType] = useState('');
  const [resolving, setResolving] = useState<Discrepancy | null>(null);
  const { data } = useQuery({
    queryKey: ['recon-discrepancies', status, type],
    queryFn: async () => (await api.get<{ data: { rows: Discrepancy[]; open: { typeCode: number; typeLabel: string; count: number; amount: string }[] } }>('/recon/discrepancies', { params: { status, type: type || undefined } })).data.data,
  });
  const refresh = useMutation({
    mutationFn: async () => (await api.post('/recon/discrepancies/refresh')).data,
    onSuccess: () => { for (const k of RECON_KEYS) qc.invalidateQueries({ queryKey: [k] }); },
  });
  return (
    <div className="space-y-3">
      <Card className="p-3 sm:p-4 flex flex-wrap items-center gap-2">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" className="w-auto">
          <option value="open">Open</option><option value="resolved">Resolved</option><option value="cleared">Cleared by itself</option>
        </Select>
        <Select value={type} onChange={(e) => setType(e.target.value)} aria-label="Type" className="w-auto">
          <option value="">Any type</option>
          {data?.open.map((t) => <option key={t.typeCode} value={t.typeCode}>{t.typeCode}. {t.typeLabel} ({t.count})</option>)}
        </Select>
        {canEdit && <Button variant="secondary" className="ml-auto" disabled={refresh.isPending} onClick={() => refresh.mutate()}><RefreshCw className="w-4 h-4 inline mr-1" />Check again</Button>}
      </Card>
      <ErrorNote>{refresh.isError && apiErrorMessage(refresh.error, 'Could not run the checks')}</ErrorNote>
      {data?.rows.length === 0 && <Card className="p-4 text-sm text-gray-500">{status === 'open' ? 'No open mismatches.' : 'None.'}</Card>}
      {!!data?.rows.length && (
        <Card className="divide-y divide-gray-100">
          {data.rows.map((d) => (
            <div key={d.id} className="px-3 sm:px-4 py-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium text-gray-900">{d.typeCode}. {d.typeLabel}</div>
                <div className="text-sm text-gray-700">{d.detail}</div>
                <div className="text-xs text-gray-500">
                  {d.orderNumber && <Link to={`/order-to-bank/orders/${encodeURIComponent(d.orderNumber)}`} className="text-blue-700 hover:underline">{d.orderNumber}</Link>}
                  {d.batchId && <Link to={`/order-to-bank/settlements/${d.batchId}`} className="text-blue-700 hover:underline">Open the settlement</Link>}
                  {d.gatewayPaymentId && <Link to="/order-to-bank?tab=import" className="text-blue-700 hover:underline">Link the payment</Link>}
                  {' · '}found {formatDateTime(d.detectedAt)}
                  {d.status === 'resolved' && <> · {d.resolutionLabel}: {d.resolutionNote}</>}
                  {d.status === 'open' && <> · {d.suggestedAction}</>}
                </div>
              </div>
              <div className="text-right shrink-0 space-y-1">
                {d.amount !== '0.00' && <div className="num font-medium">{formatINR(d.amount)}</div>}
                {d.status === 'open' && canEdit && <Button variant="secondary" onClick={() => setResolving(d)}>Resolve</Button>}
              </div>
            </div>
          ))}
        </Card>
      )}
      {resolving && <ResolveModal d={resolving} onClose={() => setResolving(null)} />}
    </div>
  );
}

function SettlementsTab() {
  const [params, setParams] = useSearchParams();
  const source = params.get('source') ?? '';
  const notInBank = params.get('notInBank') === 'true';
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { replace: true }); };
  const { data } = useQuery({
    queryKey: ['recon-settlements', source, notInBank],
    queryFn: async () => (await api.get<{ data: SettlementRow[] }>('/recon/settlements', { params: { source: source || undefined, notInBank: notInBank || undefined } })).data.data,
  });
  return (
    <div className="space-y-3">
      <Card className="p-3 sm:p-4 flex flex-wrap items-center gap-3">
        <Select value={source} onChange={(e) => set('source', e.target.value)} aria-label="Source" className="w-auto">
          <option value="">Razorpay and COD</option><option value="razorpay">Razorpay settlements</option><option value="shiprocket_cod">Shiprocket COD remittances</option>
        </Select>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={notInBank} onChange={(e) => set('notInBank', e.target.checked ? 'true' : '')} /> Not in the bank yet</label>
      </Card>
      {data?.length === 0 && <Card className="p-4 text-sm text-gray-500">No settlements. Import a Razorpay Settlement Recon report or a Shiprocket remittance file.</Card>}
      {!!data?.length && (
        <Card className="divide-y divide-gray-100">
          {data.map((b) => (
            <Link key={b.id} to={`/order-to-bank/settlements/${b.id}`} className="block px-3 sm:px-4 py-3 hover:bg-gray-50/70">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-gray-900 truncate">{b.source === 'razorpay' ? 'Razorpay' : 'COD'} {b.externalId}</div>
                  <div className="text-xs text-gray-500 truncate">{dateLabel(b.settledOn)} · {b.lines} line{b.lines === 1 ? '' : 's'} · gross {short(b.gross)}{b.fees !== '0.00' ? ` · fees ${formatINR(b.fees)}` : ''}{b.utr ? ` · ${b.utr}` : ''}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="num font-medium">{formatINR(b.net)}</div>
                  <Chip tone={b.inBank ? 'green' : 'amber'}>{b.inBank ? 'In bank' : `Expected ${dateLabel(b.expectedBank)}`}</Chip>
                </div>
              </div>
            </Link>
          ))}
        </Card>
      )}
    </div>
  );
}

type ImportRow = { id: string; source: string; kind: string; fileName: string; rows: number; added: number; repeated: number; skipped: number; createdAt: string };
type Unlinked = { id: string; externalId: string; amount: string; capturedOn: string; method: string | null; reference: string; contact: string | null; status: string };

function ImportTab() {
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('financeOrders', 'edit');
  const [source, setSource] = useState<'razorpay' | 'shiprocket_cod'>('razorpay');
  const [file, setFile] = useState<File | null>(null);
  const [linking, setLinking] = useState<Unlinked | null>(null);
  const [orderNumber, setOrderNumber] = useState('');
  const { data: imports } = useQuery({ queryKey: ['recon-imports'], queryFn: async () => (await api.get<{ data: ImportRow[] }>('/recon/imports')).data.data });
  const { data: unlinked } = useQuery({ queryKey: ['recon-unlinked'], queryFn: async () => (await api.get<{ data: Unlinked[] }>('/recon/payments/unlinked')).data.data });
  const done = () => { for (const k of RECON_KEYS) qc.invalidateQueries({ queryKey: [k] }); };
  const upload = useMutation({
    mutationFn: async () => (await api.post<{ data: ImportRow }>('/recon/imports', { source, fileName: file!.name, contentBase64: await fileToBase64(file!) })).data.data,
    onSuccess: () => { setFile(null); done(); },
  });
  const link = useMutation({
    mutationFn: async () => (await api.post(`/recon/payments/${linking!.id}/link`, { orderNumber })).data,
    onSuccess: () => { setLinking(null); setOrderNumber(''); done(); },
  });
  return (
    <div className="space-y-4">
      {canEdit && (
        <Card className="p-4 sm:p-6 space-y-3">
          <h2 className="font-semibold text-gray-900">Import a report</h2>
          <p className="text-sm text-gray-600">
            Razorpay: Dashboard &gt; Reports, download the <b>Payments</b> report (captured payments) or the <b>Settlement Recon</b> report (what each settlement paid out). Shiprocket: the <b>COD remittance</b> report with one row per AWB.
            CSV or XLSX. Importing the same report again adds only what is new.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <Select value={source} onChange={(e) => setSource(e.target.value as 'razorpay')} aria-label="Report from">
              <option value="razorpay">Razorpay (Payments or Settlement Recon)</option><option value="shiprocket_cod">Shiprocket COD remittance</option>
            </Select>
            <input type="file" accept=".csv,.xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm sm:col-span-1 min-w-0" />
            <Button disabled={!file || upload.isPending} onClick={() => upload.mutate()}>{upload.isPending ? 'Importing…' : 'Import'}</Button>
          </div>
          <ErrorNote>{upload.isError && apiErrorMessage(upload.error, 'Could not import the file')}</ErrorNote>
          {upload.data && <p className="text-sm text-emerald-800 bg-emerald-50 rounded-lg px-3 py-2">{upload.data.kind}: {upload.data.added} new, {upload.data.repeated} already imported{upload.data.skipped ? `, ${upload.data.skipped} skipped (failed or not captured)` : ''}.</p>}
        </Card>
      )}

      {!!unlinked?.length && (
        <Card className="p-4 sm:p-6 space-y-2">
          <h2 className="font-semibold text-gray-900">Razorpay payments with no order ({unlinked.length})</h2>
          <p className="text-sm text-gray-600">The report did not name a CRM order and no single order had the same amount and date. Link each to its order.</p>
          <ul className="divide-y divide-gray-100 text-sm">
            {unlinked.map((p) => (
              <li key={p.id} className="py-2 flex items-center justify-between gap-2">
                <span className="min-w-0"><span className="block">{p.externalId} · {dateLabel(p.capturedOn)} · {formatINR(p.amount)}{p.method ? ` · ${p.method.toUpperCase()}` : ''}</span><span className="block text-xs text-gray-500 truncate">{p.reference || p.contact || 'No reference'}</span></span>
                {canEdit && <Button variant="secondary" onClick={() => setLinking(p)}>Link</Button>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="p-4 sm:p-6 space-y-2">
        <h2 className="font-semibold text-gray-900">Imported reports</h2>
        {imports?.length === 0 && <p className="text-sm text-gray-500">None yet.</p>}
        <ul className="divide-y divide-gray-100 text-sm">
          {imports?.map((i) => (
            <li key={i.id} className="py-2 flex justify-between gap-2">
              <span className="min-w-0 truncate">{i.source === 'razorpay' ? 'Razorpay' : 'Shiprocket'} {i.kind} · {i.fileName}</span>
              <span className="text-xs text-gray-500 whitespace-nowrap">{i.added} new · {formatDateTime(i.createdAt)}</span>
            </li>
          ))}
        </ul>
      </Card>

      {linking && (
        <Modal title={`Link ${linking.externalId}`} onClose={() => setLinking(null)} footer={<>
          <Button variant="secondary" onClick={() => setLinking(null)}>Back</Button>
          <Button disabled={!orderNumber.trim() || link.isPending} onClick={() => link.mutate()}>Link</Button>
        </>}>
          <p className="text-sm text-gray-600">{formatINR(linking.amount)} captured {dateLabel(linking.capturedOn)}. {linking.reference}</p>
          <Field label="CRM order number"><TextInput autoFocus placeholder="BLC-260501" value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} /></Field>
          <ErrorNote>{link.isError && apiErrorMessage(link.error, 'Could not link it')}</ErrorNote>
        </Modal>
      )}
    </div>
  );
}

// M18 order-to-bank (F190-F199).
export function OrderToBankPage() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.find(([k]) => k === params.get('tab'))?.[0] ?? 'tracker';
  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <PageHeader title="Order-to-bank" subtitle="Every customer order until its money is in the bank: Razorpay, Shiprocket COD and direct payments." />
      <Transit />
      <nav className="flex gap-1 overflow-x-auto -mx-3 px-3 sm:mx-0 sm:px-0 border-b border-gray-200">
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setParams({ tab: k })} className={cn('shrink-0 px-3 py-2 text-sm border-b-2 -mb-px', tab === k ? 'border-[#0c2c55] text-[#0c2c55] font-medium' : 'border-transparent text-gray-500 hover:text-gray-800')}>{label}</button>
        ))}
      </nav>
      {tab === 'tracker' && <TrackerTab />}
      {tab === 'discrepancies' && <DiscrepanciesTab />}
      {tab === 'settlements' && <SettlementsTab />}
      {tab === 'funnel' && <FunnelTab />}
      {tab === 'import' && <ImportTab />}
    </div>
  );
}
