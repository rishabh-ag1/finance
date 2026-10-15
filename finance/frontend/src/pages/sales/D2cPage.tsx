import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../../api';
import { Button, Card, Chip, ErrorNote, Field, PageHeader, Select, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { formatINR } from '../../lib/money';
import { apiErrorMessage } from '../../lib/utils';
import { dateLabel } from '../settings/api';
import { SALES_KEYS, STATUS_TONE, type SalesDoc } from './api';

type DocRef = { id: string; docNumber: string | null; status: string; total: string; docDate: string | null } | null;
type Setting = { isOn: boolean; startFrom: string | null; lastRunAt: string | null; lastRunSummary: Summary | null; seriesOn: boolean };
type Summary = { checked: number; invoiced: number; fixList: number; creditNotes: number; note: string | null };
type Overview = {
  setting: Setting;
  fixList: { orderNumber: string; problems: string[]; since: string; lastCheckedAt: string; invoice: DocRef }[];
  invoiced: { orderNumber: string; invoice: DocRef; creditNote: DocRef; lastCheckedAt: string }[];
};

const summaryText = (s: Summary) => s.note ?? `${s.invoiced} invoiced, ${s.creditNotes} credit note${s.creditNotes === 1 ? '' : 's'} drafted, ${s.fixList} to fix`;
const docLink = (d: DocRef, empty = '—') => d ? <Link to={`/sales/${d.id}`} className="text-[#0c2c55] hover:underline">{d.docNumber ?? 'Draft'}</Link> : <span className="text-gray-400">{empty}</span>;

function SettingCard({ s }: { s: Setting }) {
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('financeSettings', 'edit');
  const [startFrom, setStartFrom] = useState(s.startFrom ?? '');
  const save = useMutation({
    mutationFn: async (isOn: boolean) => (await api.put('/d2c/setting', { isOn, startFrom: startFrom || null })).data.data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['d2c'] }),
  });
  return (
    <Card className="p-4 sm:p-6 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold text-gray-900">Automatic D2C invoices</h2>
        <Chip tone={s.isOn ? 'green' : 'gray'}>{s.isOn ? 'On' : 'Off'}</Chip>
      </div>
      <p className="text-sm text-gray-600">
        Every half hour, each D2C order that has shipped (Shiprocket pickup, or Shipped marked in the CRM for Porter and self-delivery) gets a B2C tax invoice dated the ship date,
        priced as the customer paid (BR-48). Returned or cancelled after shipping: a credit note is drafted for you to check and issue. Company orders, replacements and Amazon are left out.
      </p>
      {!s.seriesOn && <p className="text-sm text-amber-700">The tax invoice series is off (Settings › Numbering): the batch issues nothing until it is on.</p>}
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Invoice orders shipped from" hint="Orders shipped earlier are left alone" className="w-56">
          <TextInput type="date" disabled={!canEdit} value={startFrom} onChange={(e) => setStartFrom(e.target.value)} />
        </Field>
        {canEdit && (s.isOn
          ? <><Button variant="secondary" disabled={save.isPending} onClick={() => save.mutate(true)}>Save date</Button><Button variant="danger" disabled={save.isPending} onClick={() => save.mutate(false)}>Switch off</Button></>
          : <Button disabled={save.isPending || !startFrom} onClick={() => save.mutate(true)}>Switch on</Button>)}
      </div>
      <ErrorNote>{save.isError && apiErrorMessage(save.error, 'Could not save')}</ErrorNote>
    </Card>
  );
}

function FromOrder() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [f, setF] = useState({ orderNumber: '', docType: 'tax_invoice' });
  const make = useMutation({
    mutationFn: async () => (await api.post<{ data: SalesDoc }>('/sales/from-order', { orderNumber: f.orderNumber.trim(), docType: f.docType })).data.data,
    onSuccess: (d) => { for (const k of SALES_KEYS) qc.invalidateQueries({ queryKey: [k] }); navigate(`/sales/${d.id}`); },
  });
  return (
    <Card className="p-4 sm:p-6 space-y-3">
      <h2 className="font-semibold text-gray-900">Invoice a CRM order</h2>
      <p className="text-sm text-gray-600">Drafts a proforma or tax invoice priced exactly as the order (company orders bill to their outlet). Check it, then issue.</p>
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_12rem_auto] gap-2 items-end">
        <Field label="CRM order number"><TextInput placeholder="BLC-260900" value={f.orderNumber} onChange={(e) => setF({ ...f, orderNumber: e.target.value })} /></Field>
        <Field label="Document"><Select value={f.docType} onChange={(e) => setF({ ...f, docType: e.target.value })}><option value="tax_invoice">Tax invoice</option><option value="proforma">Proforma</option></Select></Field>
        <Button disabled={make.isPending || !f.orderNumber.trim()} onClick={() => make.mutate()}>Draft</Button>
      </div>
      <ErrorNote>{make.isError && apiErrorMessage(make.error, 'Could not draft')}</ErrorNote>
    </Card>
  );
}

// F102 D2C auto-invoicing, its fix-list, and F103 RTO credit notes.
export function D2cPage() {
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('financeSales', 'edit');
  const { data, isLoading } = useQuery({ queryKey: ['d2c'], queryFn: async () => (await api.get<{ data: Overview }>('/d2c')).data.data });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['d2c'] }); for (const k of SALES_KEYS) qc.invalidateQueries({ queryKey: [k] }); };
  const run = useMutation({ mutationFn: async () => (await api.post<{ data: Summary }>('/d2c/run')).data.data, onSuccess: refresh });
  const retry = useMutation({ mutationFn: async (orderNumber: string) => (await api.post(`/d2c/orders/${encodeURIComponent(orderNumber)}/retry`)).data.data, onSuccess: refresh });
  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <PageHeader
        title="D2C invoices"
        subtitle={<><Link to="/sales" className="text-[#0c2c55] hover:underline">Invoices</Link> › orders invoiced when they ship, and the ones that need fixing</>}
        action={canEdit && data?.setting.isOn && <Button disabled={run.isPending} onClick={() => run.mutate()}>{run.isPending ? 'Running…' : 'Run now'}</Button>}
      />
      {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
      {data && <SettingCard key={`${data.setting.isOn}-${data.setting.startFrom}`} s={data.setting} />}
      {(run.data || data?.setting.lastRunSummary) && (
        <p className="text-sm text-gray-600">
          {run.data ? `Just now: ${summaryText(run.data)}` : `Last run ${new Date(data!.setting.lastRunAt!).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}: ${summaryText(data!.setting.lastRunSummary!)}`}
        </p>
      )}
      <ErrorNote>{(run.isError && apiErrorMessage(run.error, 'The batch failed')) || (retry.isError && apiErrorMessage(retry.error, 'Could not try again'))}</ErrorNote>

      {data && (
        <Card className="p-4 sm:p-6 space-y-3">
          <h2 className="font-semibold text-gray-900">To fix ({data.fixList.length})</h2>
          {data.fixList.length === 0 && <p className="text-sm text-gray-500">Nothing to fix.</p>}
          <ul className="divide-y divide-gray-100">
            {data.fixList.map((r) => (
              <li key={r.orderNumber} className="py-3 flex flex-col sm:flex-row sm:items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-gray-900">{r.orderNumber}{r.invoice && <span className="text-sm font-normal text-gray-500"> · draft {docLink(r.invoice)}</span>}</div>
                  <ul className="text-sm text-red-700 list-disc pl-5">{r.problems.map((p) => <li key={p}>{p}</li>)}</ul>
                  <div className="text-xs text-gray-500">Fix it in the CRM or bloc-inv, then try again. Last checked {new Date(r.lastCheckedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</div>
                </div>
                {canEdit && data.setting.isOn && <Button variant="secondary" className="shrink-0" disabled={retry.isPending} onClick={() => retry.mutate(r.orderNumber)}>Try again</Button>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {data && (
        <Card className="p-4 sm:p-6 space-y-3">
          <h2 className="font-semibold text-gray-900">Invoiced by the batch</h2>
          {data.invoiced.length === 0 && <p className="text-sm text-gray-500">None yet.</p>}
          {data.invoiced.length > 0 && (
            <table className="w-full text-sm table-fixed">
              <thead><tr className="text-left text-xs text-gray-500"><th className="py-1 w-[34%]">Order</th><th className="w-[33%]">Invoice</th><th className="w-[33%]">Credit note (RTO)</th></tr></thead>
              <tbody className="divide-y divide-gray-100">
                {data.invoiced.map((r) => (
                  <tr key={r.orderNumber}>
                    <td className="py-2 truncate">{r.orderNumber}</td>
                    <td className="truncate">{docLink(r.invoice)}{r.invoice && <span className="hidden sm:inline text-gray-500"> · {dateLabel(r.invoice.docDate!)} · {formatINR(r.invoice.total)}</span>}</td>
                    <td className="truncate">{docLink(r.creditNote)}{r.creditNote && <span className="ml-1"><Chip tone={STATUS_TONE[r.creditNote.status] ?? 'gray'}>{r.creditNote.status === 'draft' ? 'To review' : r.creditNote.status}</Chip></span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {canEdit && <FromOrder />}
    </div>
  );
}
