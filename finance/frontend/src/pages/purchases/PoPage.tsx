import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Download, Send } from 'lucide-react';
import api from '../../api';
import { Attachments } from '../../components/Attachments';
import { Button, Card, Chip, ErrorNote, Facts, Field, Modal, PageHeader, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { fileUrl } from '../../lib/attachments';
import { formatDateTime } from '../../lib/format';
import { stateLabel } from '../../lib/gstStates';
import { formatINR } from '../../lib/money';
import { apiErrorMessage } from '../../lib/utils';
import { dateLabel } from '../settings/api';
import { DOC_STATUS_TONE, type BillRow } from '../bills/api';
import { GST_MODE_LABEL, PO_STATUS_TONE, usePo, type Po } from './api';

const linkButton = 'inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium';

// F045-F048 PO detail: issue, send, amend, close or cancel; linked billing and payments.
export function PoPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('financePurchases', 'edit');
  const { data: po, isLoading } = usePo(id);
  const [asking, setAsking] = useState<'close' | 'cancel' | 'reject' | null>(null);
  const [reason, setReason] = useState('');
  const canSeeBills = hasPermission('financeBills', 'view');
  const { data: bills } = useQuery({
    enabled: canSeeBills && !!id,
    queryKey: ['bills', 'po', id],
    queryFn: async () => (await api.get<{ data: { rows: BillRow[] } }>('/bills', { params: { poId: id } })).data.data.rows,
  });

  const act = useMutation({
    mutationFn: async ({ action, payload }: { action: string; payload?: object }) => (await api.post<{ data: Po }>(`/purchases/pos/${id}/${action}`, payload ?? {})).data.data,
    onSuccess: (p) => {
      qc.setQueryData(['po', id], p);
      qc.invalidateQueries({ queryKey: ['pos'] });
      qc.invalidateQueries({ queryKey: ['attachments', 'PurchaseOrder', id] });
      setAsking(null);
      setReason('');
    },
  });

  if (isLoading || !po) return <p className="text-sm text-gray-500">Loading…</p>;
  const issued = !!po.poNumber;
  const open = ['approved', 'sent', 'partially_billed', 'fully_billed'].includes(po.status);
  const pdfName = `${po.poNumber?.replace(/\//g, '-')}.pdf`;

  /** F045: share the PDF on a phone (WhatsApp etc.), or download it and open WhatsApp on a computer. */
  const share = async () => {
    if (!po.pdfAttachmentId) return;
    const text = `Purchase order ${po.poNumber} from Entelechy Labs Private Limited, total ${formatINR(po.total)}.`;
    const blob = await (await fetch(fileUrl(po.pdfAttachmentId, true), { credentials: 'include' })).blob();
    const file = new File([blob], pdfName, { type: 'application/pdf' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], text }); } catch { return; }
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = pdfName;
      a.click();
      window.open(`https://wa.me/?text=${encodeURIComponent(`${text} PDF attached.`)}`, '_blank', 'noopener');
    }
    act.mutate({ action: 'sent', payload: { via: 'whatsapp' } });
  };

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <PageHeader
        title={po.poNumber ? `${po.poNumber}${po.revisionNo ? ` R${po.revisionNo}` : ''}` : 'Draft purchase order'}
        subtitle={<Link to={`/vendors/${po.vendorId}`} className="hover:underline">{po.vendorName}</Link>}
        action={<Chip tone={PO_STATUS_TONE[po.status]}>{po.statusLabel}</Chip>}
      />

      {po.vendorBankChangedRecently && open && (
        <p className="flex items-start gap-2 text-sm text-amber-900 bg-amber-50 rounded-lg px-3 py-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> This vendor's bank details changed in the last 30 days. Confirm them by phone before paying (BR-16).
        </p>
      )}
      {po.statusReason && ['closed', 'cancelled', 'draft'].includes(po.status) && <p className="text-sm text-gray-600">Reason: {po.statusReason}</p>}

      {canEdit && (
        <div className="flex flex-wrap gap-2">
          {po.status === 'draft' && <>
            <Link to={`/purchase-orders/${po.id}/edit`} className={`${linkButton} bg-white border border-gray-200 text-gray-800 hover:bg-gray-50`}>Edit</Link>
            <Button disabled={act.isPending} onClick={() => act.mutate({ action: 'issue' })}>Issue PO</Button>
            <Button variant="danger" onClick={() => setAsking('cancel')}>Discard draft</Button>
          </>}
          {po.status === 'pending_approval' && <>
            <Button disabled={act.isPending} onClick={() => act.mutate({ action: 'approve' })}>Approve</Button>
            <Button variant="secondary" onClick={() => setAsking('reject')}>Send back</Button>
          </>}
          {issued && po.pdfAttachmentId && <>
            <a href={fileUrl(po.pdfAttachmentId, true)} className={`${linkButton} bg-white border border-gray-200 text-gray-800 hover:bg-gray-50`}><Download className="w-4 h-4" /> PDF</a>
            {open && <Button variant="secondary" onClick={share}><Send className="w-4 h-4 inline -mt-0.5" /> Share / WhatsApp</Button>}
            {open && !po.sentAt && <Button variant="ghost" onClick={() => act.mutate({ action: 'sent', payload: { via: 'other' } })}>Mark as sent</Button>}
          </>}
          {hasPermission('financePayments', 'edit') && ['approved', 'sent', 'partially_billed'].includes(po.status) && (
            <Link to={`/payments/new?poId=${po.id}&vendorId=${po.vendorId}`} className={`${linkButton} bg-white border border-gray-200 text-gray-800 hover:bg-gray-50`}>Pay advance</Link>
          )}
          {['approved', 'sent', 'partially_billed'].includes(po.status) && (
            <Link to={`/purchase-orders/${po.id}/amend`} className={`${linkButton} bg-white border border-gray-200 text-gray-800 hover:bg-gray-50`}>Amend</Link>
          )}
          {open && <Button variant="secondary" onClick={() => setAsking('close')}>Close</Button>}
          {issued && open && po.billedTaxable === '0.00' && po.paidTotal === '0.00' && <Button variant="danger" onClick={() => setAsking('cancel')}>Cancel PO</Button>}
          {issued && !po.pdfAttachmentId && <Button variant="secondary" onClick={() => act.mutate({ action: 'print' })}>Print PDF</Button>}
        </div>
      )}
      <ErrorNote>{act.isError && !asking && apiErrorMessage(act.error, 'That did not work')}</ErrorNote>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Card className="p-3"><div className="text-xs text-gray-500">PO value</div><div className="font-semibold num">{formatINR(po.total)}</div><div className="text-xs text-gray-500 num">taxable {formatINR(po.taxable)}</div></Card>
        <Card className="p-3"><div className="text-xs text-gray-500">Billed (taxable)</div><div className="font-semibold num">{formatINR(po.billedTaxable)}</div></Card>
        <Card className="p-3"><div className="text-xs text-gray-500">Balance to bill</div><div className="font-semibold num">{formatINR(po.balanceToBill)}</div></Card>
        <Card className="p-3"><div className="text-xs text-gray-500">Paid</div><div className="font-semibold num">{formatINR(po.paidTotal)}</div>{po.advanceTotal !== '0.00' && <div className="text-xs text-gray-500 num">advance {formatINR(po.advanceTotal)}</div>}</Card>
      </div>

      <Card className="p-4 sm:p-6">
        <Facts items={[
          { label: 'PO date', value: dateLabel(po.poDate) },
          { label: 'Expected delivery', value: po.expectedDeliveryDate ? dateLabel(po.expectedDeliveryDate) : null },
          { label: 'Deliver to', value: <span className="whitespace-pre-line">{po.deliveryAddress}</span> },
          { label: 'Place of supply', value: stateLabel(po.placeOfSupplyState) },
          { label: 'GST', value: GST_MODE_LABEL[po.gstMode] },
          { label: "Vendor's quote", value: po.quoteRef },
          { label: 'Payment terms', value: po.paymentTermsText },
          { label: 'Milestones', value: po.milestones.length ? po.milestones.map((m) => `${m.percent}% ${m.label}`).join(', ') : null },
          { label: 'Issued', value: po.issuedAt ? `${formatDateTime(po.issuedAt)}${po.issuedBy ? ` by ${po.issuedBy}` : ''}` : null },
          { label: 'Sent', value: po.sentAt ? `${formatDateTime(po.sentAt)} (${po.sentVia})` : null },
          ...(po.approvals.length ? [{ label: 'Approved by', value: po.approvals.map((a) => a.name).join(', ') }] : []),
          ...(po.notes ? [{ label: 'Internal note', value: po.notes }] : []),
        ]} />
      </Card>

      <Card className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-gray-600 text-xs">
            <tr><th className="text-left px-3 py-2">#</th><th className="text-left px-3 py-2">Item</th><th className="text-right px-3 py-2">Qty</th><th className="text-right px-3 py-2">Rate</th><th className="text-right px-3 py-2">Taxable</th><th className="text-right px-3 py-2">GST</th><th className="text-right px-3 py-2">Amount</th></tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {po.lines.map((l) => (
              <tr key={l.id}>
                <td className="px-3 py-2 text-gray-500">{l.lineNo}</td>
                <td className="px-3 py-2 min-w-[12rem]">{l.description}{l.hsnSac && <span className="block text-xs text-gray-500">HSN/SAC {l.hsnSac}</span>}</td>
                <td className="px-3 py-2 text-right num whitespace-nowrap">{l.qty} {l.unit}</td>
                <td className="px-3 py-2 text-right num">{formatINR(l.rate)}</td>
                <td className="px-3 py-2 text-right num">{formatINR(l.taxable)}</td>
                <td className="px-3 py-2 text-right num whitespace-nowrap">{Number(l.gstRate)}% · {formatINR(l.tax)}</td>
                <td className="px-3 py-2 text-right num">{formatINR(l.lineTotal)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="text-sm">
            <tr><td colSpan={6} className="px-3 pt-3 text-right text-gray-600">Taxable value</td><td className="px-3 pt-3 text-right num">{formatINR(po.taxable)}</td></tr>
            {po.gstMode === 'cgst_sgst' && <>
              <tr><td colSpan={6} className="px-3 text-right text-gray-600">CGST</td><td className="px-3 text-right num">{formatINR(po.cgst)}</td></tr>
              <tr><td colSpan={6} className="px-3 text-right text-gray-600">SGST</td><td className="px-3 text-right num">{formatINR(po.sgst)}</td></tr>
            </>}
            {po.gstMode === 'igst' && <tr><td colSpan={6} className="px-3 text-right text-gray-600">IGST</td><td className="px-3 text-right num">{formatINR(po.igst)}</td></tr>}
            {po.roundOff !== '0.00' && <tr><td colSpan={6} className="px-3 text-right text-gray-600">Round off</td><td className="px-3 text-right num">{formatINR(po.roundOff)}</td></tr>}
            <tr className="font-semibold"><td colSpan={6} className="px-3 py-2 text-right">Total</td><td className="px-3 py-2 text-right num">{formatINR(po.total)}</td></tr>
            <tr><td colSpan={7} className="px-3 pb-3 text-right text-xs text-gray-500">{po.amountInWords}</td></tr>
          </tfoot>
        </table>
      </Card>

      {canSeeBills && issued && (
        <Card className="p-4 sm:p-6 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-semibold text-gray-900">Vendor documents</h2>
            {hasPermission('financeBills', 'edit') && ['approved', 'sent', 'partially_billed'].includes(po.status) && (
              <Link to={`/bills/new?poId=${po.id}`} className={`${linkButton} bg-white border border-gray-200 text-gray-800 hover:bg-gray-50`}>Record bill</Link>
            )}
          </div>
          {bills?.length === 0 && <p className="text-sm text-gray-500">No bills or proformas linked yet.</p>}
          <ul className="divide-y divide-gray-100 text-sm">
            {bills?.map((b) => (
              <li key={b.id} className="py-2 flex items-center justify-between gap-2">
                <Link to={`/bills/${b.id}`} className="text-blue-700 hover:underline">{b.docTypeLabel} {b.docNumber} · {dateLabel(b.docDate)}</Link>
                <span className="flex items-center gap-2"><span className="num">{formatINR(b.totalValue)}</span><Chip tone={DOC_STATUS_TONE[b.status]}>{b.statusLabel}</Chip></span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {po.revisions.length > 0 && (
        <Card className="p-4 sm:p-6 space-y-2">
          <h2 className="font-semibold text-gray-900">Amendments</h2>
          <ul className="text-sm space-y-1">
            {po.revisions.map((r) => <li key={r.revisionNo}><b>R{r.revisionNo + 1}</b>: {r.reason} <span className="text-gray-500">({r.by}, {formatDateTime(r.at)})</span></li>)}
          </ul>
        </Card>
      )}

      <Card className="p-4 sm:p-6 space-y-2">
        <h2 className="font-semibold text-gray-900">Files</h2>
        <Attachments recordType="PurchaseOrder" recordId={po.id} kinds={['quote', 'agreement', 'other']} />
      </Card>
      <p className="text-xs text-gray-500">Every change to this PO is in the <Link className="underline" to="/audit">audit log</Link>.</p>

      {asking && (
        <Modal
          title={asking === 'close' ? 'Close this PO' : asking === 'reject' ? 'Send back to draft' : po.poNumber ? 'Cancel this PO' : 'Discard this draft'}
          onClose={() => setAsking(null)}
          footer={<>
            <Button variant="secondary" onClick={() => setAsking(null)}>Back</Button>
            <Button variant={asking === 'close' ? 'primary' : 'danger'} disabled={reason.trim().length < 3 || act.isPending} onClick={() => act.mutate({ action: asking, payload: { reason } })}>Confirm</Button>
          </>}
        >
          <p className="text-sm text-gray-600">
            {asking === 'close' && 'No new bills can be linked after closing. The balance is not ordered any more.'}
            {asking === 'cancel' && (po.poNumber ? `${po.poNumber} stays in the register, marked Cancelled. Nothing is deleted.` : 'The draft is kept, marked Cancelled. Nothing is deleted.')}
            {asking === 'reject' && 'The PO goes back to draft so it can be changed.'}
          </p>
          <Field label="Reason"><TextInput autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <ErrorNote>{act.isError && apiErrorMessage(act.error, 'That did not work')}</ErrorNote>
        </Modal>
      )}
    </div>
  );
}
