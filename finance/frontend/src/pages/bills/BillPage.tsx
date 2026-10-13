import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import api from '../../api';
import { Attachments } from '../../components/Attachments';
import { Button, Card, Chip, ErrorNote, Facts, Field, Modal, PageHeader, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { formatDateTime } from '../../lib/format';
import { stateLabel } from '../../lib/gstStates';
import { formatINR } from '../../lib/money';
import { apiErrorMessage } from '../../lib/utils';
import { GST_MODE_LABEL } from '../purchases/api';
import { dateLabel } from '../settings/api';
import { DOC_STATUS_TONE, useBill, type Bill } from './api';

const linkButton = 'inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium bg-white border border-gray-200 text-gray-800 hover:bg-gray-50';

function DocLink({ d }: { d: NonNullable<Bill['replaces']> }) {
  return <Link to={`/bills/${d.id}`} className="text-blue-700 hover:underline">{d.docTypeLabel} {d.docNumber}</Link>;
}

// F057, F058 vendor document detail: OK to pay, hold, cancel, replace a proforma, notes.
export function BillPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('financeBills', 'edit');
  const { data: b, isLoading } = useBill(id);
  const [asking, setAsking] = useState<'dispute' | 'cancel' | null>(null);
  const [reason, setReason] = useState('');

  const act = useMutation({
    mutationFn: async ({ action, payload }: { action: string; payload?: object }) => (await api.post<{ data: Bill }>(`/bills/${id}/${action}`, payload ?? {})).data.data,
    onSuccess: (d) => { qc.setQueryData(['bill', id], d); qc.invalidateQueries({ queryKey: ['bills'] }); qc.invalidateQueries({ queryKey: ['po'] }); setAsking(null); setReason(''); },
  });

  if (isLoading || !b) return <p className="text-sm text-gray-500">Loading…</p>;
  const editable = ['awaiting_tax_invoice', 'received', 'approved', 'disputed'].includes(b.status) && b.paidAmount === '0.00';
  const isInvoice = b.docType === 'tax_invoice';
  const isNote = ['credit_note', 'debit_note'].includes(b.docType);

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <PageHeader
        title={`${b.docTypeLabel} ${b.docNumber}`}
        subtitle={<Link to={`/vendors/${b.vendorId}`} className="hover:underline">{b.vendorName}</Link>}
        action={<div className="flex gap-1"><Chip tone={DOC_STATUS_TONE[b.status]}>{b.statusLabel}</Chip>{b.overdue && <Chip tone="red">Overdue</Chip>}</div>}
      />

      {b.warnings.map((w) => (
        <p key={w} className="flex items-start gap-2 text-sm text-amber-900 bg-amber-50 rounded-lg px-3 py-2"><AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {w}</p>
      ))}
      {b.statusReason && ['cancelled', 'disputed', 'replaced'].includes(b.status) && <p className="text-sm text-gray-600">Reason: {b.statusReason}</p>}

      {canEdit && (
        <div className="flex flex-wrap gap-2">
          {editable && <Link to={`/bills/${b.id}/edit`} className={linkButton}>Edit</Link>}
          {isInvoice && b.status === 'received' && <Button disabled={act.isPending} onClick={() => act.mutate({ action: 'approve' })}>OK to pay</Button>}
          {b.status === 'awaiting_tax_invoice' && <Link to={`/bills/new?replaces=${b.id}`} className="inline-flex items-center px-3.5 py-2 rounded-lg text-sm font-medium bg-[#0c2c55] text-white hover:bg-[#0e3261]">Enter the tax invoice</Link>}
          {isInvoice && ['received', 'approved', 'partially_paid'].includes(b.status) && <Button variant="secondary" onClick={() => setAsking('dispute')}>Put on hold</Button>}
          {b.status === 'disputed' && <Button variant="secondary" disabled={act.isPending} onClick={() => act.mutate({ action: 'resolve' })}>Release hold</Button>}
          {isInvoice && !['cancelled', 'replaced'].includes(b.status) && <>
            <Link to={`/bills/new?against=${b.id}&type=credit_note`} className={linkButton}>Credit note</Link>
            <Link to={`/bills/new?against=${b.id}&type=debit_note`} className={linkButton}>Debit note</Link>
          </>}
          {!['cancelled', 'paid', 'replaced'].includes(b.status) && b.paidAmount === '0.00' && <Button variant="danger" onClick={() => setAsking('cancel')}>Cancel</Button>}
        </div>
      )}
      <ErrorNote>{act.isError && !asking && apiErrorMessage(act.error, 'That did not work')}</ErrorNote>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Card className="p-3"><div className="text-xs text-gray-500">Total</div><div className="font-semibold num">{formatINR(b.totalValue)}</div><div className="text-xs text-gray-500 num">taxable {formatINR(b.taxableValue)}</div></Card>
        <Card className="p-3"><div className="text-xs text-gray-500">TDS</div><div className="font-semibold num">{formatINR(b.tds.amount)}</div>{b.tds.applicable && <div className="text-xs text-gray-500">{b.tds.rate}% {b.tds.sectionLabel}</div>}</Card>
        <Card className="p-3"><div className="text-xs text-gray-500">Net payable</div><div className="font-semibold num">{formatINR(b.netPayable)}</div>{b.notesAdjustment !== '0.00' && <div className="text-xs text-gray-500 num">notes {formatINR(b.notesAdjustment)}</div>}</Card>
        <Card className="p-3"><div className="text-xs text-gray-500">Still owed</div><div className="font-semibold num text-red-700">{formatINR(b.outstanding)}</div><div className="text-xs text-gray-500 num">paid {formatINR(b.paidAmount)}</div></Card>
      </div>

      <Card className="p-4 sm:p-6">
        <Facts items={[
          { label: 'Document date', value: dateLabel(b.docDate) },
          { label: 'Due date', value: b.dueDate ? `${dateLabel(b.dueDate)}${b.paymentTermLabel ? ` (${b.paymentTermLabel})` : ''}` : null },
          { label: 'Purchase order', value: b.poId ? <Link to={`/purchase-orders/${b.poId}`} className="text-blue-700 hover:underline">{b.poNumber}</Link> : null },
          { label: 'Place of supply', value: `${stateLabel(b.placeOfSupplyState)} · ${GST_MODE_LABEL[b.gstMode]}${b.reverseCharge ? ' · reverse charge' : ''}` },
          { label: 'Category', value: b.categoryName ? `${b.categoryName}${b.subCategoryName ? ` > ${b.subCategoryName}` : ''}` : null },
          { label: 'Input credit', value: b.itcEligible ? 'Claimable' : 'Not claimable' },
          ...(b.replaces ? [{ label: 'Replaces', value: <DocLink d={b.replaces} /> }] : []),
          ...(b.replacedBy ? [{ label: 'Replaced by', value: <DocLink d={b.replacedBy} /> }] : []),
          ...(b.against ? [{ label: 'Against', value: <DocLink d={b.against} /> }] : []),
          ...(b.notesAgainst.length ? [{ label: 'Notes', value: <span className="space-x-2">{b.notesAgainst.map((n) => <DocLink key={n.id} d={n} />)}</span> }] : []),
          { label: 'Entered', value: `${formatDateTime(b.enteredAt)}${b.enteredBy ? ` by ${b.enteredBy}` : ''}` },
          ...(b.approvedAt ? [{ label: 'OK to pay', value: `${formatDateTime(b.approvedAt)} by ${b.approvedBy}` }] : []),
          ...(b.notes ? [{ label: 'Note', value: b.notes }] : []),
        ]} />
      </Card>

      {isInvoice && (
        <Card className="p-4 sm:p-6 text-sm space-y-1">
          <h2 className="font-semibold text-gray-900">TDS</h2>
          <p>{b.tds.applicable ? `${formatINR(b.tds.amount)} = ${b.tds.rate}% of ${formatINR(b.tds.base)} under ${b.tds.sectionLabel}` : 'No TDS on this bill.'}</p>
          {b.tds.suggestion && <p className="text-gray-600">Suggested: {b.tds.suggestion.applicable ? formatINR(b.tds.suggestion.amount) : 'none'}. {b.tds.suggestion.reason}</p>}
          {b.tds.overrideReason && <p className="text-amber-800">Changed from the suggestion: {b.tds.overrideReason}</p>}
          {b.tds.verifiedByCa === false && <p className="text-xs text-gray-500">This section's rates are not yet confirmed by the CA (Q15).</p>}
        </Card>
      )}

      <Card className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-gray-600 text-xs">
            <tr><th className="text-left px-3 py-2">#</th><th className="text-left px-3 py-2">Item</th><th className="text-right px-3 py-2">Qty</th><th className="text-right px-3 py-2">Rate</th><th className="text-right px-3 py-2">Taxable</th><th className="text-right px-3 py-2">GST</th><th className="text-right px-3 py-2">Amount</th></tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {b.lines.map((l) => (
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
          <tfoot>
            {b.gstMode === 'cgst_sgst' && <tr><td colSpan={6} className="px-3 pt-3 text-right text-gray-600">CGST + SGST</td><td className="px-3 pt-3 text-right num">{formatINR(b.cgst)} + {formatINR(b.sgst)}</td></tr>}
            {b.gstMode === 'igst' && <tr><td colSpan={6} className="px-3 pt-3 text-right text-gray-600">IGST</td><td className="px-3 pt-3 text-right num">{formatINR(b.igst)}</td></tr>}
            {b.otherCharges !== '0.00' && <tr><td colSpan={6} className="px-3 text-right text-gray-600">Other charges</td><td className="px-3 text-right num">{formatINR(b.otherCharges)}</td></tr>}
            {b.roundOff !== '0.00' && <tr><td colSpan={6} className="px-3 text-right text-gray-600">Round off</td><td className="px-3 text-right num">{formatINR(b.roundOff)}</td></tr>}
            <tr className="font-semibold"><td colSpan={6} className="px-3 py-2 text-right">Total</td><td className="px-3 py-2 text-right num">{formatINR(b.totalValue)}</td></tr>
          </tfoot>
        </table>
      </Card>

      <Card className="p-4 sm:p-6 space-y-2">
        <h2 className="font-semibold text-gray-900">Files</h2>
        <Attachments recordType="VendorDocument" recordId={b.id} kinds={['bill', 'proof', 'other']} onChange={() => qc.invalidateQueries({ queryKey: ['bill', id] })} />
      </Card>
      {isNote && <p className="text-xs text-gray-500">A {b.docTypeLabel.toLowerCase()} changes what is owed on the invoice it points to.</p>}

      {asking && (
        <Modal title={asking === 'dispute' ? 'Put this bill on hold' : 'Cancel this document'} onClose={() => setAsking(null)} footer={<>
          <Button variant="secondary" onClick={() => setAsking(null)}>Back</Button>
          <Button variant="danger" disabled={reason.trim().length < 3 || act.isPending} onClick={() => act.mutate({ action: asking, payload: { reason } })}>Confirm</Button>
        </>}>
          <p className="text-sm text-gray-600">{asking === 'dispute' ? 'A bill on hold is left out of payment runs until the hold is released.' : 'The document stays in the register, marked Cancelled. Use this for documents entered in error or withdrawn by the vendor.'}</p>
          <Field label="Reason"><TextInput autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <ErrorNote>{act.isError && apiErrorMessage(act.error, 'That did not work')}</ErrorNote>
        </Modal>
      )}
    </div>
  );
}
