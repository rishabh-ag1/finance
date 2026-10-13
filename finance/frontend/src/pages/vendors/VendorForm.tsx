import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import api from '../../api';
import { Button, ErrorNote, Field, Modal, MoneyInput, Select, TextInput } from '../../components/ui/kit';
import { apiErrorMessage } from '../../lib/utils';
import { useSettings, type PaymentTerm, type TdsSection } from '../settings/api';
import { CategoryFields, type CategoryValue } from '../bank/CategoryFields';
import { useCategories } from '../bank/ledgerApi';
import { MSME_LABEL, TYPE_LABEL, type MsmeType, type Vendor, type VendorType } from './types';

type GstinOutcome =
  | { ok: true; result: { status: string; legalName: string | null; tradeName: string | null; address: string | null; stateName: string; pincode: string | null; cached: boolean } }
  | { ok: false; message: string };

// F031-F034: add or edit a vendor. PAN, state and deductee type are read from the GSTIN on save.
export function VendorForm({ vendor, onClose, onSaved }: { vendor: Vendor | null; onClose: () => void; onSaved: (id: string) => void }) {
  const qc = useQueryClient();
  const { data: cats } = useCategories();
  const { data: tds } = useSettings<TdsSection[]>('tds-sections');
  const { data: terms } = useSettings<PaymentTerm[]>('payment-terms');
  const [f, setF] = useState({
    displayName: vendor?.displayName ?? '', legalName: vendor?.legalName ?? '', tradeName: vendor?.tradeName ?? '',
    vendorType: (vendor?.vendorType ?? 'goods') as VendorType, gstin: vendor?.gstin ?? '', pan: vendor?.gstin ? '' : vendor?.pan ?? '',
    addressLine1: vendor?.addressLine1 ?? '', addressLine2: vendor?.addressLine2 ?? '', city: vendor?.city ?? '', state: vendor?.state ?? '',
    pincode: vendor?.pincode ?? '', contactName: vendor?.contactName ?? '', phone: vendor?.phone ?? '', email: vendor?.email ?? '',
    defaultTdsSectionId: vendor?.defaultTdsSectionId ?? '', ldcNumber: vendor?.ldcNumber ?? '', ldcRate: vendor?.ldcRate ?? '',
    ldcValidFrom: vendor?.ldcValidFrom ?? '', ldcValidTo: vendor?.ldcValidTo ?? '', ldcLimit: vendor?.ldcLimit ?? '',
    msmeType: (vendor?.msmeType ?? 'none') as MsmeType, udyamNo: vendor?.udyamNo ?? '', paymentTermId: vendor?.paymentTermId ?? '',
    bankNames: (vendor?.bankNames ?? []).join(', '), notes: vendor?.notes ?? '',
  });
  const [cat, setCat] = useState<CategoryValue>({ categoryId: vendor?.defaultCategoryId ?? '', subCategoryId: vendor?.defaultSubCategoryId ?? '', nature: '' });
  const [lookupNote, setLookupNote] = useState('');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  const fetchGstin = useMutation({
    mutationFn: async () => (await api.get<{ data: GstinOutcome }>(`/vendors/lookup/gstin/${f.gstin.trim().toUpperCase()}`)).data.data,
    onSuccess: (o) => {
      if (!o.ok) { setLookupNote(o.message); return; }
      const r = o.result;
      setLookupNote(r.status === 'ACTIVE' ? `Registered and active${r.cached ? ' (saved lookup)' : ''}.` : `GST status: ${r.status}. Check before paying this vendor.`);
      setF((p) => ({
        ...p,
        legalName: r.legalName ?? p.legalName,
        tradeName: r.tradeName ?? p.tradeName,
        displayName: p.displayName || r.tradeName || r.legalName || '',
        addressLine1: p.addressLine1 || r.address || '',
        state: r.stateName,
        pincode: p.pincode || r.pincode || '',
        bankNames: p.bankNames || (r.legalName ?? '').toUpperCase(),
      }));
    },
  });
  const fetchPin = useMutation({
    mutationFn: async () => (await api.get<{ data: { ok: true; city: string; state: string } | { ok: false; message: string } }>(`/vendors/lookup/pincode/${f.pincode}`)).data.data,
    onSuccess: (o) => { if (o.ok) setF((p) => ({ ...p, city: o.city, state: p.gstin ? p.state : o.state })); else setLookupNote(o.message); },
  });

  const save = useMutation({
    mutationFn: async (activate: boolean) => {
      const body = {
        ...f,
        bankNames: f.bankNames.split(',').map((s) => s.trim()).filter(Boolean),
        defaultCategoryId: cat.categoryId || null,
        defaultSubCategoryId: cat.subCategoryId || null,
        ...(vendor ? {} : { activate }),
      };
      const res = vendor ? await api.put(`/vendors/${vendor.id}`, body) : await api.post('/vendors', body);
      return res.data.data as Vendor;
    },
    onSuccess: (v) => { qc.invalidateQueries({ queryKey: ['vendors'] }); qc.invalidateQueries({ queryKey: ['vendor', v.id] }); onSaved(v.id); },
  });

  const hasGstin = f.gstin.trim().length > 0;

  return (
    <Modal
      title={vendor ? `Edit ${vendor.displayName}` : 'Add vendor'}
      onClose={onClose}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        {!vendor && <Button variant="secondary" disabled={save.isPending} onClick={() => save.mutate(false)}>Save as draft</Button>}
        <Button disabled={save.isPending} onClick={() => save.mutate(true)}>{vendor ? 'Save' : 'Save and activate'}</Button>
      </>}
    >
      <ErrorNote>{save.isError && apiErrorMessage(save.error, 'Could not save')}</ErrorNote>

      <Field label="GSTIN" hint="PAN, state and deductee type are read from it. Leave empty for an unregistered vendor.">
        <div className="flex gap-2">
          <TextInput className="font-mono uppercase" maxLength={15} value={f.gstin} onChange={set('gstin')} placeholder="06ANJPA3053F1ZI" />
          <Button variant="secondary" disabled={f.gstin.trim().length !== 15 || fetchGstin.isPending} onClick={() => fetchGstin.mutate()} title="Fetch details from the GST register">
            <Search className="w-4 h-4" />
          </Button>
        </div>
      </Field>
      {(lookupNote || fetchGstin.isError) && <p className="text-xs text-gray-600 bg-gray-50 rounded-lg px-3 py-2">{fetchGstin.isError ? apiErrorMessage(fetchGstin.error, 'Lookup failed') : lookupNote}</p>}
      {!hasGstin && (
        <Field label="PAN" hint="Without a PAN, TDS is at the higher no-PAN rate."><TextInput className="font-mono uppercase" maxLength={10} value={f.pan} onChange={set('pan')} /></Field>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Name used in the app"><TextInput value={f.displayName} onChange={set('displayName')} /></Field>
        <Field label="Supplies">
          <Select value={f.vendorType} onChange={set('vendorType')}>{Object.entries(TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        </Field>
        <Field label="Legal name"><TextInput value={f.legalName} onChange={set('legalName')} /></Field>
        <Field label="Trade name"><TextInput value={f.tradeName} onChange={set('tradeName')} /></Field>
      </div>

      <Field label="Name in bank statements" hint="Comma separated, e.g. SAIFFI INDUSTRIES. Bank rows paid to these names are linked to this vendor.">
        <TextInput className="uppercase" value={f.bankNames} onChange={set('bankNames')} />
      </Field>

      <Field label="Address"><TextInput value={f.addressLine1} onChange={set('addressLine1')} /></Field>
      <TextInput value={f.addressLine2} onChange={set('addressLine2')} placeholder="Address line 2" />
      <div className="grid grid-cols-3 gap-3">
        <Field label="PIN code">
          <TextInput inputMode="numeric" maxLength={6} value={f.pincode} onChange={set('pincode')} onBlur={() => f.pincode.length === 6 && fetchPin.mutate()} />
        </Field>
        <Field label="City"><TextInput value={f.city} onChange={set('city')} /></Field>
        <Field label="State"><TextInput value={f.state} disabled={hasGstin} onChange={set('state')} /></Field>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field label="Contact person"><TextInput value={f.contactName} onChange={set('contactName')} /></Field>
        <Field label="Phone"><TextInput inputMode="tel" value={f.phone} onChange={set('phone')} /></Field>
        <Field label="Email"><TextInput type="email" value={f.email} onChange={set('email')} /></Field>
      </div>

      <p className="text-sm font-medium text-gray-700 pt-1">Tax and terms</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Default TDS section" hint="Rates come from Settings > GST & TDS [Verify]">
          <Select value={f.defaultTdsSectionId} onChange={set('defaultTdsSectionId')}>
            <option value="">No TDS</option>
            {tds?.filter((t) => t.isActive).map((t) => <option key={t.id} value={t.id}>{t.codeOldAct} · {t.nature}</option>)}
          </Select>
        </Field>
        <Field label="Payment terms">
          <Select value={f.paymentTermId} onChange={set('paymentTermId')}>
            <option value="">—</option>
            {terms?.filter((t) => t.isActive).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </Select>
        </Field>
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-gray-600">Lower deduction certificate</summary>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
          <Field label="Certificate number"><TextInput value={f.ldcNumber} onChange={set('ldcNumber')} /></Field>
          <Field label="Rate %"><TextInput inputMode="decimal" value={f.ldcRate} onChange={set('ldcRate')} /></Field>
          <Field label="Valid from"><TextInput type="date" value={f.ldcValidFrom} onChange={set('ldcValidFrom')} /></Field>
          <Field label="Valid to"><TextInput type="date" value={f.ldcValidTo} onChange={set('ldcValidTo')} /></Field>
          <Field label="Up to amount"><MoneyInput value={f.ldcLimit} onChange={set('ldcLimit')} /></Field>
        </div>
      </details>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="MSME" hint="Micro and small vendors must be paid within 45 days.">
          <Select value={f.msmeType} onChange={set('msmeType')}>{Object.entries(MSME_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        </Field>
        {f.msmeType !== 'none' && <Field label="Udyam number"><TextInput className="uppercase" value={f.udyamNo} onChange={set('udyamNo')} placeholder="UDYAM-HR-02-0012345" /></Field>}
      </div>

      <p className="text-sm font-medium text-gray-700 pt-1">Default category for this vendor's payments</p>
      {cats && <CategoryFields compact cats={cats} value={cat} onChange={setCat} />}
      <Field label="Notes"><TextInput value={f.notes} onChange={set('notes')} /></Field>
    </Modal>
  );
}
