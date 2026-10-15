import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import api from '../../api';
import { HistoryPanel } from '../../components/HistoryPanel';
import { Button, Card, Chip, ErrorNote, Facts, Field, Modal, MoneyInput, PageHeader, Select, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { fileUrl } from '../../lib/attachments';
import { formatDateTime } from '../../lib/format';
import { stateLabel } from '../../lib/gstStates';
import { formatINR } from '../../lib/money';
import { apiErrorMessage } from '../../lib/utils';
import { dateLabel } from '../settings/api';
import { PaymentCard } from './PaymentCard';
import { CREDIT_REASONS, SALES_KEYS, STATUS_TONE, pdfPreviewUrl, useSalesDoc, type SalesDoc } from './api';

const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
type Asking = 'cancel' | 'convert' | 'credit' | 'transport' | null;

// F091-F098 one proforma, tax invoice or credit note.
export function SalesDocPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('financeSales', 'edit');
  const { data: d, isLoading } = useSalesDoc(id);
  const [asking, setAsking] = useState<Asking>(null);
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(today());
  const [qty, setQty] = useState<Record<string, string>>({});
  const [rates, setRates] = useState<Record<string, string>>({});
  const [creditReason, setCreditReason] = useState('return');
  const [transport, setTransport] = useState({ ewayBillNo: '', transporter: '', vehicleNo: '' });

  const refresh = () => { for (const k of SALES_KEYS) qc.invalidateQueries({ queryKey: [k] }); };
  const act = useMutation({
    mutationFn: async ({ path, body, method = 'post' }: { path: string; body?: object; method?: 'post' | 'put' }) => (await api[method]<{ data: SalesDoc }>(`/sales/${id}/${path}`, body ?? {})).data.data,
    onSuccess: (r, v) => {
      refresh();
      setAsking(null); setReason('');
      if (v.path === 'convert' || v.path === 'credit-note') navigate(`/sales/${r.id}`);
      else qc.setQueryData(['sales-doc', id], r);
    },
  });

  if (isLoading || !d) return <p className="text-sm text-gray-500">Loading…</p>;
  const isDraft = d.status === 'draft';
  const issued = !!d.docNumber && d.status !== 'cancelled';
  const pi = d.docType === 'proforma';
  const ti = d.docType === 'tax_invoice';
  const openConvert = () => { setQty(Object.fromEntries(d.lines.map((l) => [l.id, l.remainingToConvert ?? '0']))); setAsking('convert'); };
  const openCredit = () => { setQty(Object.fromEntries(d.lines.map((l) => [l.id, '0']))); setRates({}); setAsking('credit'); };
  const openTransport = () => { setTransport({ ewayBillNo: d.ewayBillNo ?? '', transporter: d.transporter ?? '', vehicleNo: d.vehicleNo ?? '' }); setAsking('transport'); };

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <PageHeader
        title={d.docNumber ?? `Draft ${d.docTypeLabel.toLowerCase()}`}
        subtitle={`${d.docTypeLabel} · ${d.billTo.name} · ${dateLabel(d.docDate)}`}
        action={<Chip tone={STATUS_TONE[d.status] ?? 'gray'}>{d.statusLabel}</Chip>}
      />
      {d.statusReason && <p className="text-sm text-gray-600">Reason: {d.statusReason}</p>}
      {isDraft && d.problems.length > 0 && (
        <Card className="p-3 space-y-1">
          <div className="text-sm font-medium text-gray-900">Before it can be issued</div>
          {d.problems.map((p) => <div key={p} className="flex items-start gap-2 text-sm text-red-800"><AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />{p}</div>)}
        </Card>
      )}
      {[...d.warnings, ...(d.ewayNeeded && !d.ewayBillNo && issued && ti ? ['Above the e-way bill threshold: add the e-way bill number before dispatch (BR-42)'] : [])].map((w) => (
        <p key={w} className="flex items-start gap-2 text-sm text-amber-900 bg-amber-50 rounded-lg px-3 py-2"><AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />{w}</p>
      ))}

      <div className="flex flex-wrap gap-2">
        {d.pdfAttachmentId
          ? <a href={fileUrl(d.pdfAttachmentId)} target="_blank" rel="noreferrer" className="inline-flex items-center px-3.5 py-2 rounded-lg text-sm font-medium bg-white border border-gray-200 text-gray-800 hover:bg-gray-50">Open PDF</a>
          : <a href={pdfPreviewUrl(d.id)} target="_blank" rel="noreferrer" className="inline-flex items-center px-3.5 py-2 rounded-lg text-sm font-medium bg-white border border-gray-200 text-gray-800 hover:bg-gray-50">{isDraft ? 'Preview PDF' : 'PDF'}</a>}
        {canEdit && isDraft && d.docType !== 'credit_note' && <Link to={`/sales/${d.id}/edit`} className="inline-flex items-center px-3.5 py-2 rounded-lg text-sm font-medium bg-white border border-gray-200 text-gray-800 hover:bg-gray-50">Edit</Link>}
        {canEdit && isDraft && <Button disabled={act.isPending || d.problems.length > 0} onClick={() => act.mutate({ path: 'issue' })}>Issue</Button>}
        {canEdit && issued && !d.sentAt && <Button variant="secondary" disabled={act.isPending} onClick={() => act.mutate({ path: 'sent' })}>Mark sent</Button>}
        {canEdit && issued && pi && !d.acceptedAt && <Button variant="secondary" disabled={act.isPending} onClick={() => act.mutate({ path: 'accepted' })}>Mark accepted</Button>}
        {canEdit && issued && pi && d.conversion !== 'converted' && <Button onClick={openConvert}>Make tax invoice</Button>}
        {canEdit && issued && ti && <Button variant="secondary" onClick={openCredit}>Credit note</Button>}
        {canEdit && issued && ti && <Button variant="secondary" onClick={openTransport}>E-way bill / transport</Button>}
        {canEdit && issued && !d.pdfAttachmentId && <Button variant="secondary" disabled={act.isPending} onClick={() => act.mutate({ path: 'print' })}>File the PDF</Button>}
        {canEdit && (d.cancelRoute === 'cancel' || d.cancelRoute === 'discard') && <Button variant="danger" onClick={() => setAsking('cancel')}>{d.cancelRoute === 'discard' ? 'Discard draft' : 'Cancel'}</Button>}
      </div>
      {d.cancelRoute === 'credit_note' && <p className="text-xs text-gray-500">GSTR-1 for this month is filed: this invoice can no longer be cancelled; raise a credit note instead (BR-34).</p>}
      <ErrorNote>{act.isError && !asking && apiErrorMessage(act.error, 'That did not work')}</ErrorNote>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Card className="p-4">
          <div className="text-xs uppercase text-gray-500 mb-1">Bill to · {d.supplyType.toUpperCase()}</div>
          <div className="font-medium text-gray-900">{d.billTo.name}</div>
          <div className="text-sm text-gray-600">{d.billTo.address}</div>
          <div className="text-sm text-gray-600">{stateLabel(d.billTo.stateCode)}{d.billTo.gstin ? ` · GSTIN ${d.billTo.gstin}` : ''}</div>
          {d.crmCompanyId && <Link to={`/customers/${d.crmCompanyId}`} className="text-xs text-blue-700 hover:underline">Customer page</Link>}
        </Card>
        <Card className="p-4">
          <div className="text-xs uppercase text-gray-500 mb-1">Ship to</div>
          <div className="font-medium text-gray-900">{d.shipTo.name}</div>
          <div className="text-sm text-gray-600">{d.shipTo.address}</div>
          <div className="text-sm text-gray-600">Place of supply {stateLabel(d.placeOfSupply)} · {d.gstMode === 'igst' ? 'IGST' : 'CGST + SGST'}</div>
        </Card>
      </div>

      <Card className="overflow-x-auto">
        <table className="min-w-full text-xs sm:text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr><th className="text-left font-medium px-3 py-2">Item</th><th className="text-right font-medium px-2 py-2">Qty</th><th className="text-right font-medium px-2 py-2">Rate</th><th className="text-right font-medium px-2 py-2">Taxable</th><th className="text-right font-medium px-2 py-2">GST</th><th className="text-right font-medium px-3 py-2">Amount</th></tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {d.lines.map((l) => (
              <tr key={l.id}>
                <td className="px-3 py-1.5">{l.description}<div className="text-[11px] text-gray-500">HSN {l.hsnSac ?? '—'}{l.discountPct !== '0' ? ` · ${l.discountPct}% off` : ''}{l.priceSource ? ` · ${l.priceSource}` : ''}{l.remainingToConvert && l.remainingToConvert !== '0' && issued ? ` · ${l.remainingToConvert} left to invoice` : ''}{l.credited && l.credited !== '0' ? ` · ${l.credited} credited` : ''}</div></td>
                <td className="text-right num px-2 py-1.5">{l.qty} {l.unit}</td>
                <td className="text-right num px-2 py-1.5 whitespace-nowrap">{formatINR(l.rate)}</td>
                <td className="text-right num px-2 py-1.5 whitespace-nowrap">{formatINR(l.taxable)}</td>
                <td className="text-right num px-2 py-1.5 whitespace-nowrap">{Number(l.gstRate)}% {formatINR(l.tax)}</td>
                <td className="text-right num px-3 py-1.5 whitespace-nowrap">{formatINR(l.lineTotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="px-3 py-2 text-sm text-right space-y-0.5 border-t border-gray-100">
          <div>Taxable {formatINR(d.taxable)}</div>
          <div>{d.gstMode === 'igst' ? `IGST ${formatINR(d.igst)}` : `CGST ${formatINR(d.cgst)} · SGST ${formatINR(d.sgst)}`}{d.roundOff !== '0.00' ? ` · round off ${d.roundOff}` : ''}</div>
          <div className="text-base font-semibold">Total {formatINR(d.total)}</div>
          <div className="text-xs text-gray-500">{d.amountInWords}</div>
        </div>
      </Card>

      <Card className="p-4 sm:p-6">
        <Facts items={[
          ...(d.validUntil ? [{ label: 'Valid until', value: dateLabel(d.validUntil) }] : []),
          ...(ti && d.dueDate ? [{ label: 'Due', value: `${dateLabel(d.dueDate)}${d.paymentTerms ? ` (${d.paymentTerms})` : ''}` }] : []),
          ...(d.customerPoNo ? [{ label: 'Their PO', value: `${d.customerPoNo}${d.customerPoDate ? ` dated ${dateLabel(d.customerPoDate)}` : ''}` }] : []),
          ...(d.creditReasonLabel ? [{ label: 'Reason', value: d.creditReasonLabel }] : []),
          ...(d.ewayBillNo || d.transporter || d.vehicleNo ? [{ label: 'Transport', value: [d.ewayBillNo && `E-way bill ${d.ewayBillNo}`, d.transporter, d.vehicleNo].filter(Boolean).join(' · ') }] : []),
          ...(d.salesPerson ? [{ label: 'Sales person', value: d.salesPerson }] : []),
          ...(d.crmOrderNumber ? [{ label: 'CRM order', value: <Link to={`/order-to-bank/orders/${encodeURIComponent(d.crmOrderNumber)}`} className="text-blue-700 hover:underline">{d.crmOrderNumber}</Link> }] : []),
          ...(d.source !== 'manual' ? [{ label: 'Made by', value: d.sourceLabel }] : []),
          ...(d.issuedAt ? [{ label: 'Issued', value: `${formatDateTime(d.issuedAt)} · template v${d.templateVersion} (${d.layout})` }] : []),
          ...(d.sentAt ? [{ label: 'Sent', value: formatDateTime(d.sentAt) }] : []),
          ...(d.acceptedAt ? [{ label: 'Accepted', value: formatDateTime(d.acceptedAt) }] : []),
          ...(d.notes ? [{ label: 'Notes', value: d.notes }] : []),
        ]} />
      </Card>

      {d.status === 'issued' && d.docType !== 'credit_note' && <PaymentCard d={d} />}

      {d.related.length > 0 && (
        <Card className="p-4 sm:p-6 space-y-2">
          <h2 className="font-semibold text-gray-900">Linked documents</h2>
          <ul className="divide-y divide-gray-100 text-sm">
            {d.related.map((r) => (
              <li key={r.id} className="py-2 flex items-center justify-between gap-2">
                <Link to={`/sales/${r.id}`} className="text-blue-700 hover:underline min-w-0 truncate">{r.docTypeLabel} {r.docNumber ?? '(draft)'} · {dateLabel(r.docDate)}</Link>
                <span className="flex items-center gap-2"><span className="num">{formatINR(r.total)}</span><Chip tone={STATUS_TONE[r.status] ?? 'gray'}>{r.statusLabel}</Chip></span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {asking === 'cancel' && (
        <Modal title={d.cancelRoute === 'discard' ? 'Discard this draft' : `Cancel ${d.docNumber}`} onClose={() => setAsking(null)} footer={<>
          <Button variant="secondary" onClick={() => setAsking(null)}>Back</Button>
          <Button variant="danger" disabled={reason.trim().length < 3 || act.isPending} onClick={() => act.mutate({ path: 'cancel', body: { reason } })}>Confirm</Button>
        </>}>
          {d.cancelRoute === 'cancel' && <p className="text-sm text-gray-600">The number stays used and the PDF is stamped CANCELLED. This cannot be undone.</p>}
          <Field label="Reason"><TextInput autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <ErrorNote>{act.isError && apiErrorMessage(act.error, 'That did not work')}</ErrorNote>
        </Modal>
      )}
      {asking === 'convert' && (
        <Modal title="Make a tax invoice from this proforma" onClose={() => setAsking(null)} footer={<>
          <Button variant="secondary" onClick={() => setAsking(null)}>Back</Button>
          <Button disabled={act.isPending} onClick={() => act.mutate({ path: 'convert', body: { docDate: date, lines: d.lines.map((l) => ({ sourceLineId: l.id, qty: qty[l.id] || '0' })) } })}>Make draft</Button>
        </>}>
          <Field label="Invoice date"><TextInput type="date" max={today()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          {d.lines.map((l) => (
            <Field key={l.id} label={`${l.description} (left ${l.remainingToConvert})`}><TextInput inputMode="decimal" value={qty[l.id] ?? ''} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} /></Field>
          ))}
          <p className="text-xs text-gray-500">Advances received against the proforma are applied when receipts come in (Step 17).</p>
          <ErrorNote>{act.isError && apiErrorMessage(act.error, 'Could not make it')}</ErrorNote>
        </Modal>
      )}
      {asking === 'credit' && (
        <Modal title={`Credit note against ${d.docNumber}`} onClose={() => setAsking(null)} footer={<>
          <Button variant="secondary" onClick={() => setAsking(null)}>Back</Button>
          <Button disabled={act.isPending} onClick={() => act.mutate({ path: 'credit-note', body: { docDate: date, creditReason, lines: d.lines.map((l) => ({ sourceLineId: l.id, qty: qty[l.id] || '0', rate: rates[l.id] || null })) } })}>Make draft</Button>
        </>}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date"><TextInput type="date" max={today()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label="Why"><Select value={creditReason} onChange={(e) => setCreditReason(e.target.value)}>{CREDIT_REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
          </div>
          {d.lines.map((l) => (
            <div key={l.id} className="grid grid-cols-2 gap-2">
              <Field label={`${l.description}: qty (of ${l.qty})`}><TextInput inputMode="decimal" value={qty[l.id] ?? ''} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} /></Field>
              <Field label={`Credit rate (invoiced ${l.rate})`}><MoneyInput value={rates[l.id] ?? ''} placeholder={l.rate} onChange={(e) => setRates({ ...rates, [l.id]: e.target.value })} /></Field>
            </div>
          ))}
          <p className="text-xs text-gray-500">Goods returned: the quantity at the invoiced rate. Rate difference or discount: the quantity it applies to at the difference per unit.</p>
          <ErrorNote>{act.isError && apiErrorMessage(act.error, 'Could not make it')}</ErrorNote>
        </Modal>
      )}
      {asking === 'transport' && (
        <Modal title="E-way bill and transport" onClose={() => setAsking(null)} footer={<>
          <Button variant="secondary" onClick={() => setAsking(null)}>Back</Button>
          <Button disabled={act.isPending} onClick={() => act.mutate({ path: 'transport', method: 'put', body: transport })}>Save and print again</Button>
        </>}>
          <p className="text-sm text-gray-600">Make the e-way bill on the government portal from this invoice, then add its number here.</p>
          <Field label="E-way bill number"><TextInput value={transport.ewayBillNo} onChange={(e) => setTransport({ ...transport, ewayBillNo: e.target.value })} /></Field>
          <Field label="Transporter"><TextInput value={transport.transporter} onChange={(e) => setTransport({ ...transport, transporter: e.target.value })} /></Field>
          <Field label="Vehicle number"><TextInput value={transport.vehicleNo} onChange={(e) => setTransport({ ...transport, vehicleNo: e.target.value.toUpperCase() })} /></Field>
          <ErrorNote>{act.isError && apiErrorMessage(act.error, 'Could not save')}</ErrorNote>
        </Modal>
      )}
      <HistoryPanel recordId={id!} />
    </div>
  );
}
