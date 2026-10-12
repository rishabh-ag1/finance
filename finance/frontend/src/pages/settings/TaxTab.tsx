import { useState } from 'react';
import { Button, Card, Chip, ErrorNote, Field, Modal, MoneyInput, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { formatINR, formatRate } from '../../lib/money';
import { apiErrorMessage } from '../../lib/utils';
import { dateLabel, useSettings, useSettingsMutation, type GstRate, type TdsSection } from './api';

// F004 GST rates and F005 TDS sections: tax values are data with effective dates, never code.
export function TaxTab() {
  return (
    <div className="space-y-4">
      <GstRates />
      <TdsSections />
    </div>
  );
}

function GstRates() {
  const { data: rates } = useSettings<GstRate[]>('gst-rates');
  const { hasPermission } = useAuth();
  const [adding, setAdding] = useState(false);
  const current = rates?.filter((r) => r.isCurrent) ?? [];
  const past = rates?.filter((r) => !r.isCurrent) ?? [];
  return (
    <Card className="p-4 sm:p-6 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold text-gray-900">GST rates</h2>
        {hasPermission('financeSettings', 'edit') && <Button variant="secondary" onClick={() => setAdding(true)}>Add rate</Button>}
      </div>
      <div className="flex flex-wrap gap-2">
        {current.map((r) => <Chip key={r.id} tone="blue">{formatRate(r.rate)} since {dateLabel(r.effectiveFrom)}</Chip>)}
      </div>
      {current.some((r) => r.note?.includes('[Verify]')) && (
        <p className="text-xs text-amber-800 bg-amber-50 rounded-lg px-3 py-2">[Verify] Rates follow the Sep 2025 GST rationalisation (12% and 28% removed, 40% added). Confirm with the CA.</p>
      )}
      {past.length > 0 && (
        <details className="text-sm text-gray-600">
          <summary className="cursor-pointer">Earlier rates ({past.length})</summary>
          <ul className="mt-2 space-y-1">
            {past.map((r) => <li key={r.id}>{formatRate(r.rate)}: {dateLabel(r.effectiveFrom)} to {dateLabel(r.effectiveTo)}</li>)}
          </ul>
        </details>
      )}
      {adding && <AddGstRate onClose={() => setAdding(false)} />}
    </Card>
  );
}

function AddGstRate({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ rate: '', effectiveFrom: '', note: '' });
  const save = useSettingsMutation<typeof f>('gst-rates');
  return (
    <Modal title="Add GST rate" onClose={onClose} footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button disabled={save.isPending} onClick={() => save.mutate({ body: f }, { onSuccess: onClose })}>Save</Button>
    </>}>
      <ErrorNote>{save.isError && apiErrorMessage(save.error, 'Could not save')}</ErrorNote>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Rate %"><TextInput inputMode="decimal" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} /></Field>
        <Field label="From"><TextInput type="date" value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} /></Field>
      </div>
      <Field label="Note"><TextInput value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
    </Modal>
  );
}

function TdsSections() {
  const { data: sections } = useSettings<TdsSection[]>('tds-sections');
  const { hasPermission } = useAuth();
  const [editing, setEditing] = useState<TdsSection | 'new' | null>(null);
  const canEdit = hasPermission('financeSettings', 'edit');
  return (
    <Card className="p-4 sm:p-6 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold text-gray-900">TDS sections</h2>
        {canEdit && <Button variant="secondary" onClick={() => setEditing('new')}>Add section</Button>}
      </div>
      <p className="text-xs text-amber-800 bg-amber-50 rounded-lg px-3 py-2">
        Seeded with old-Act values. The Income-tax Act 2025 renumbered sections from 1 Apr 2026; each row stays [Verify] until the CA confirms it (Q15).
      </p>
      <ul className="divide-y divide-gray-100">
        {sections?.map((t) => (
          <li key={t.id} className="py-3 flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-medium text-gray-900">
                {t.codeOldAct}{t.codeNewAct ? ` / ${t.codeNewAct}` : ''} · {t.nature}
              </div>
              <div className="text-sm text-gray-600">
                Individual/HUF {formatRate(t.rateIndividual)} · Others {formatRate(t.rateOthers)} · No PAN {formatRate(t.rateNoPan)}
              </div>
              <div className="text-xs text-gray-500">
                {t.thresholdNote ?? [t.singleThreshold && `single ${formatINR(t.singleThreshold, { decimals: false })}`, t.annualThreshold && `FY ${formatINR(t.annualThreshold, { decimals: false })}`].filter(Boolean).join(' · ')}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {t.verifiedByCa ? <Chip tone="green">CA verified</Chip> : <Chip tone="amber">[Verify]</Chip>}
              {canEdit && <Button variant="ghost" onClick={() => setEditing(t)}>Edit</Button>}
            </div>
          </li>
        ))}
      </ul>
      {editing && <TdsForm section={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function TdsForm({ section, onClose }: { section: TdsSection | null; onClose: () => void }) {
  const [f, setF] = useState({
    codeOldAct: section?.codeOldAct ?? '', codeNewAct: section?.codeNewAct ?? '', nature: section?.nature ?? '',
    rateIndividual: section?.rateIndividual ?? '', rateOthers: section?.rateOthers ?? '', rateNoPan: section?.rateNoPan ?? '20',
    singleThreshold: section?.singleThreshold ?? '', annualThreshold: section?.annualThreshold ?? '', thresholdNote: section?.thresholdNote ?? '',
    effectiveFrom: section?.effectiveFrom ?? '', effectiveTo: section?.effectiveTo ?? '', verifiedByCa: section?.verifiedByCa ?? false,
    isActive: section?.isActive ?? true,
  });
  const save = useSettingsMutation<typeof f>('tds-sections', section ? 'put' : 'post');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title={section ? 'Edit TDS section' : 'Add TDS section'} onClose={onClose} footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button disabled={save.isPending} onClick={() => save.mutate({ url: section ? `tds-sections/${section.id}` : undefined, body: f }, { onSuccess: onClose })}>Save</Button>
    </>}>
      <ErrorNote>{save.isError && apiErrorMessage(save.error, 'Could not save')}</ErrorNote>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Section (old Act)"><TextInput value={f.codeOldAct} onChange={set('codeOldAct')} /></Field>
        <Field label="Section (2025 Act)"><TextInput value={f.codeNewAct} onChange={set('codeNewAct')} /></Field>
      </div>
      <Field label="Nature of payment"><TextInput value={f.nature} onChange={set('nature')} /></Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Individual/HUF %"><TextInput inputMode="decimal" value={f.rateIndividual} onChange={set('rateIndividual')} /></Field>
        <Field label="Others %"><TextInput inputMode="decimal" value={f.rateOthers} onChange={set('rateOthers')} /></Field>
        <Field label="No PAN %"><TextInput inputMode="decimal" value={f.rateNoPan} onChange={set('rateNoPan')} /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Single payment above"><MoneyInput value={f.singleThreshold} onChange={set('singleThreshold')} /></Field>
        <Field label="FY total above"><MoneyInput value={f.annualThreshold} onChange={set('annualThreshold')} /></Field>
      </div>
      <Field label="Threshold note"><TextInput value={f.thresholdNote} onChange={set('thresholdNote')} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="From"><TextInput type="date" value={f.effectiveFrom} onChange={set('effectiveFrom')} /></Field>
        <Field label="To"><TextInput type="date" value={f.effectiveTo} onChange={set('effectiveTo')} /></Field>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.verifiedByCa} onChange={(e) => setF({ ...f, verifiedByCa: e.target.checked })} /> Confirmed by the CA</label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> In use</label>
    </Modal>
  );
}
