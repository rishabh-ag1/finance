import { useState } from 'react';
import { Button, Card, Chip, ErrorNote, Field, Modal, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { apiErrorMessage } from '../../lib/utils';
import { DOC_TYPE_LABEL, useSettings, useSettingsMutation, type NumberSeries } from './api';

// F006 number series (BR-30). Numbers are taken only when a document is issued.
export function SeriesTab() {
  const { data: series } = useSettings<NumberSeries[]>('number-series');
  const { hasPermission } = useAuth();
  const [editing, setEditing] = useState<NumberSeries | null>(null);
  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600">
        Numbers are given only when a document is issued, never reused, and a series can be moved forward but never back.
        Tax invoices and credit notes: at most 16 characters, letters, digits, / and - only.
      </p>
      <Card className="divide-y divide-gray-100">
        {series?.map((s) => (
          <div key={s.id} className="p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-medium text-gray-900">{DOC_TYPE_LABEL[s.docType] ?? s.docType} {s.fyLabel && <span className="text-gray-400 font-normal">FY {s.fyLabel}</span>}</div>
              <div className="text-sm">Next: <span className="font-mono">{s.nextPreview}</span></div>
              {s.note && <div className="text-xs text-gray-500 mt-0.5">{s.note}</div>}
            </div>
            <div className="flex items-center gap-2">
              {s.isActive ? <Chip tone="green">On</Chip> : <Chip tone="amber">Off</Chip>}
              {hasPermission('financeSettings', 'edit') && <Button variant="ghost" onClick={() => setEditing(s)}>Edit</Button>}
            </div>
          </div>
        ))}
      </Card>
      {editing && <SeriesForm series={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function SeriesForm({ series, onClose }: { series: NumberSeries; onClose: () => void }) {
  const [f, setF] = useState({ pattern: series.pattern, padding: String(series.padding), nextNumber: String(series.nextNumber), isActive: series.isActive, note: series.note ?? '', reason: '' });
  const save = useSettingsMutation('number-series', 'put');
  const switchingOnSales = f.isActive && !series.isActive && ['tax_invoice', 'credit_note', 'proforma'].includes(series.docType);
  const preview = f.pattern.replace('{FY}', series.fyLabel ?? '').replace('{N}', (f.nextNumber || '1').padStart(Number(f.padding) || 1, '0'));
  return (
    <Modal title={`Edit ${DOC_TYPE_LABEL[series.docType] ?? series.docType} series`} onClose={onClose} footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button disabled={save.isPending} onClick={() => save.mutate({
        url: `number-series/${series.id}`,
        body: { pattern: f.pattern, padding: Number(f.padding), nextNumber: Number(f.nextNumber), isActive: f.isActive, note: f.note, reason: f.reason },
      }, { onSuccess: onClose })}>Save</Button>
    </>}>
      <ErrorNote>{save.isError && apiErrorMessage(save.error, 'Could not save')}</ErrorNote>
      <Field label="Pattern" hint="{FY} = 26-27, {N} = the number"><TextInput className="font-mono" value={f.pattern} onChange={(e) => setF({ ...f, pattern: e.target.value })} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Digits"><TextInput inputMode="numeric" value={f.padding} onChange={(e) => setF({ ...f, padding: e.target.value })} /></Field>
        <Field label="Next number" hint={`Cannot go below ${series.nextNumber}`}><TextInput inputMode="numeric" value={f.nextNumber} onChange={(e) => setF({ ...f, nextNumber: e.target.value })} /></Field>
      </div>
      <p className="text-sm">Next document: <span className="font-mono">{preview}</span> <span className="text-gray-400">({preview.length} characters)</span></p>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Series is on</label>
      {switchingOnSales && (
        <Field label="Reason (required)" hint="Confirm with the CA which entity invoices customers before switching on a sales series.">
          <TextInput value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        </Field>
      )}
      <Field label="Note"><TextInput value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
    </Modal>
  );
}
