import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../../api';
import { Attachments, type AttachmentRow } from '../../components/Attachments';
import { Button, Card, ErrorNote, Field, MoneyInput, Select, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { apiErrorMessage } from '../../lib/utils';
import { dateLabel, monthLabel, useSettings, type BankAccount } from './api';

type Template = {
  version: number; versions: number; layout: string; fonts: string[]; accentColor: string; font: string; logoAttachmentId: string | null; signatureAttachmentId: string | null;
  bankAccountId: string | null; upiId: string | null; warrantyText: string | null; declarationText: string | null; termsText: string | null; footerText: string | null;
  showDiscount: boolean; showHsnSummary: boolean; ewayBillThreshold: string; savedAt: string;
};
type Gstr1 = { id: string; month: string; filedOn: string; arn: string | null; notes: string | null };
const FONT_LABEL: Record<string, string> = { inter: 'Inter', roboto: 'Roboto', lato: 'Lato', 'noto-serif': 'Noto Serif' };
const area = 'w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0c2c55]/20';
const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

function TemplateForm({ t }: { t: Template }) {
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('financeSettings', 'edit');
  const [f, setF] = useState({ ...t, upiId: t.upiId ?? '', warrantyText: t.warrantyText ?? '', declarationText: t.declarationText ?? '', termsText: t.termsText ?? '', footerText: t.footerText ?? '' });
  const { data: accounts } = useSettings<BankAccount[]>('bank-accounts');
  const { data: files } = useQuery({ queryKey: ['attachments', 'InvoiceTemplate', 'sales'], queryFn: async () => (await api.get<{ data: AttachmentRow[] }>('/attachments', { params: { recordType: 'InvoiceTemplate', recordId: 'sales' } })).data.data });
  const save = useMutation({
    mutationFn: async () => (await api.put<{ data: Template }>('/sales-template', {
      accentColor: f.accentColor, font: f.font, logoAttachmentId: f.logoAttachmentId || null, signatureAttachmentId: f.signatureAttachmentId || null, bankAccountId: f.bankAccountId || null,
      upiId: f.upiId || null, warrantyText: f.warrantyText || null, declarationText: f.declarationText || null, termsText: f.termsText || null, footerText: f.footerText || null,
      showDiscount: f.showDiscount, showHsnSummary: f.showHsnSummary, ewayBillThreshold: f.ewayBillThreshold,
    })).data.data,
    onSuccess: (d) => qc.setQueryData(['sales-template'], d),
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF({ ...f, [k]: v });
  const kind = (k: string) => (files ?? []).filter((x) => x.docKind === k);
  return (
    <div className="space-y-4">
      <Card className="p-4 sm:p-6 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold text-gray-900">Invoice template · version {t.version}</h2>
          <a href={`${import.meta.env.VITE_API_URL}/sales-template/sample.pdf`} target="_blank" rel="noreferrer" className="text-sm text-blue-700 hover:underline">See a sample invoice</a>
        </div>
        <p className="text-sm text-gray-600">Each save is a new version. Issued documents keep the version they were printed with. GSTIN, HSN, place of supply, tax split and the number are always printed.</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="Accent colour"><input type="color" disabled={!canEdit} value={f.accentColor} onChange={(e) => set('accentColor', e.target.value)} className="h-10 w-full rounded-lg border border-gray-200" /></Field>
          <Field label="Font"><Select disabled={!canEdit} value={f.font} onChange={(e) => set('font', e.target.value)}>{t.fonts.map((x) => <option key={x} value={x}>{FONT_LABEL[x] ?? x}</option>)}</Select></Field>
          <Field label="E-way bill above (₹)" hint="[Verify] with the CA (BR-42)"><MoneyInput disabled={!canEdit} value={f.ewayBillThreshold} onChange={(e) => set('ewayBillThreshold', e.target.value)} /></Field>
          <Field label="Bank details printed">
            <Select disabled={!canEdit} value={f.bankAccountId ?? ''} onChange={(e) => set('bankAccountId', e.target.value)}>
              <option value="">None</option>
              {accounts?.filter((a) => a.owner === 'Entelechy' && !a.isArchived).map((a) => <option key={a.id} value={a.id}>{a.bankName} {a.accountNumberMasked}</option>)}
            </Select>
          </Field>
          <Field label="UPI ID for the QR code" hint="Empty: no QR"><TextInput disabled={!canEdit} placeholder="entelechy@idfcbank" value={f.upiId} onChange={(e) => set('upiId', e.target.value)} /></Field>
          <div className="flex flex-col justify-end gap-1 pb-2 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" disabled={!canEdit} checked={f.showDiscount} onChange={(e) => set('showDiscount', e.target.checked)} /> Discount % column</label>
            <label className="flex items-center gap-2"><input type="checkbox" disabled={!canEdit} checked={f.showHsnSummary} onChange={(e) => set('showHsnSummary', e.target.checked)} /> HSN summary table</label>
          </div>
          <Field label="Logo file">
            <Select disabled={!canEdit} value={f.logoAttachmentId ?? ''} onChange={(e) => set('logoAttachmentId', e.target.value)}>
              <option value="">None</option>{kind('logo').map((x) => <option key={x.id} value={x.id}>{x.originalName ?? x.fileName}</option>)}
            </Select>
          </Field>
          <Field label="Signature file">
            <Select disabled={!canEdit} value={f.signatureAttachmentId ?? ''} onChange={(e) => set('signatureAttachmentId', e.target.value)}>
              <option value="">None (signed by hand)</option>{kind('signature').map((x) => <option key={x.id} value={x.id}>{x.originalName ?? x.fileName}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Warranty"><textarea className={area} rows={2} disabled={!canEdit} value={f.warrantyText} onChange={(e) => set('warrantyText', e.target.value)} /></Field>
        <Field label="Terms"><textarea className={area} rows={2} disabled={!canEdit} value={f.termsText} onChange={(e) => set('termsText', e.target.value)} /></Field>
        <Field label="Declaration"><textarea className={area} rows={2} disabled={!canEdit} value={f.declarationText} onChange={(e) => set('declarationText', e.target.value)} /></Field>
        <Field label="Footer"><TextInput disabled={!canEdit} value={f.footerText} onChange={(e) => set('footerText', e.target.value)} /></Field>
        <ErrorNote>{save.isError && apiErrorMessage(save.error, 'Could not save')}</ErrorNote>
        {canEdit && <div className="text-right"><Button disabled={save.isPending} onClick={() => save.mutate()}>Save as version {t.version + 1}</Button></div>}
      </Card>
      <Card className="p-4 sm:p-6 space-y-2">
        <h2 className="font-semibold text-gray-900">Logo and signature files</h2>
        <p className="text-sm text-gray-600">Upload a PNG or JPG, then choose it above and save.</p>
        <Attachments recordType="InvoiceTemplate" recordId="sales" kinds={['logo', 'signature']} compact />
      </Card>
    </div>
  );
}

function Gstr1Card() {
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('financeSettings', 'edit');
  const [f, setF] = useState({ month: '', filedOn: today(), arn: '' });
  const { data } = useQuery({ queryKey: ['gstr1'], queryFn: async () => (await api.get<{ data: Gstr1[] }>('/gstr1')).data.data });
  const add = useMutation({ mutationFn: async () => (await api.post<{ data: Gstr1[] }>('/gstr1', { ...f, arn: f.arn || null })).data.data, onSuccess: (d) => { qc.setQueryData(['gstr1'], d); setF({ month: '', filedOn: today(), arn: '' }); } });
  return (
    <Card className="p-4 sm:p-6 space-y-3">
      <h2 className="font-semibold text-gray-900">GSTR-1 filed</h2>
      <p className="text-sm text-gray-600">Once a month's GSTR-1 is filed, its invoices can no longer be cancelled; they are corrected with a credit note (BR-34). Mark each month when the CA files it.</p>
      {data?.length === 0 && <p className="text-sm text-gray-500">No month marked yet.</p>}
      <ul className="divide-y divide-gray-100 text-sm">
        {data?.map((g) => <li key={g.id} className="py-2">{monthLabel(g.month)} · filed {dateLabel(g.filedOn)}{g.arn ? ` · ARN ${g.arn}` : ''}</li>)}
      </ul>
      {canEdit && (
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
          <TextInput type="month" aria-label="Month" value={f.month} onChange={(e) => setF({ ...f, month: e.target.value })} />
          <TextInput type="date" aria-label="Filed on" value={f.filedOn} onChange={(e) => setF({ ...f, filedOn: e.target.value })} />
          <TextInput placeholder="ARN (optional)" value={f.arn} onChange={(e) => setF({ ...f, arn: e.target.value })} />
          <Button variant="secondary" disabled={!f.month || add.isPending} onClick={() => add.mutate()}>Mark filed</Button>
        </div>
      )}
      <ErrorNote>{add.isError && apiErrorMessage(add.error, 'Could not save')}</ErrorNote>
    </Card>
  );
}

// F104 template settings and BR-34 GSTR-1 months.
export function InvoicesTab() {
  const { data } = useQuery({ queryKey: ['sales-template'], queryFn: async () => (await api.get<{ data: Template }>('/sales-template')).data.data });
  return (
    <div className="space-y-4">
      {data ? <TemplateForm key={data.version} t={data} /> : <p className="text-sm text-gray-500">Loading…</p>}
      <Gstr1Card />
    </div>
  );
}
