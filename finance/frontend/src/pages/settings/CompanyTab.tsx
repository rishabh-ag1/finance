import { useState } from 'react';
import { Button, Card, ErrorNote, Facts, Field, Modal, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { apiErrorMessage } from '../../lib/utils';
import { dateLabel, monthLabel, useSettings, useSettingsMutation, type Company } from './api';

// F001 company profile, F002 financial year (BR-31).
export function CompanyTab() {
  const { data: c, isLoading } = useSettings<Company>('company');
  const { hasPermission } = useAuth();
  const [editing, setEditing] = useState(false);
  if (isLoading || !c) return <p className="text-sm text-gray-500">Loading…</p>;

  return (
    <div className="space-y-4">
      <Card className="p-4 sm:p-6 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold text-gray-900">Legal details</h2>
          {hasPermission('financeSettings', 'edit') && <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>}
        </div>
        <Facts items={[
          { label: 'Legal name', value: c.legalName },
          { label: 'Brand', value: c.brandName },
          { label: 'GSTIN', value: <span className="font-mono">{c.gstin}</span> },
          { label: 'PAN (from GSTIN)', value: <span className="font-mono">{c.pan}</span> },
          { label: 'State code (from GSTIN)', value: c.stateCode },
          { label: 'CIN', value: c.cin },
          { label: 'TAN', value: c.tan ?? <span className="text-amber-700">Not on file</span> },
          { label: 'Udyam', value: c.udyamNo },
          { label: 'Registered address', value: c.registeredAddress },
          { label: 'Documents sent from', value: c.email },
          { label: 'Incorporated', value: dateLabel(c.incorporationDate) },
        ]} />
      </Card>

      <Card className="p-4 sm:p-6 space-y-3">
        <h2 className="font-semibold text-gray-900">Financial year</h2>
        <p className="text-sm text-gray-600">
          FY <strong>{c.fy.current.label}</strong> runs {dateLabel(c.fy.current.from)} to {dateLabel(c.fy.current.to)}. Today is in Q{c.fy.quarter}.
          The year always starts in April; months before incorporation show as zero, not missing.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {c.fy.months.map((m) => (
            <span key={m} className={`text-xs px-2 py-1 rounded-md ${c.incorporationDate && m < c.incorporationDate.slice(0, 7) + '-01' ? 'bg-gray-50 text-gray-400' : 'bg-blue-50 text-blue-800'}`}>
              {monthLabel(m)}
            </span>
          ))}
        </div>
      </Card>

      {editing && <EditCompany company={c} onClose={() => setEditing(false)} />}
    </div>
  );
}

function EditCompany({ company, onClose }: { company: Company; onClose: () => void }) {
  const [form, setForm] = useState({
    legalName: company.legalName, brandName: company.brandName ?? '', gstin: company.gstin, cin: company.cin ?? '',
    tan: company.tan ?? '', udyamNo: company.udyamNo ?? '', registeredAddress: company.registeredAddress,
    email: company.email ?? '', phone: company.phone ?? '', incorporationDate: company.incorporationDate ?? '',
  });
  const save = useSettingsMutation<typeof form>('company', 'put');
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <Modal
      title="Edit legal details"
      onClose={onClose}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button disabled={save.isPending} onClick={() => save.mutate({ body: form }, { onSuccess: onClose })}>{save.isPending ? 'Saving…' : 'Save'}</Button>
      </>}
    >
      <ErrorNote>{save.isError && apiErrorMessage(save.error, 'Could not save')}</ErrorNote>
      <Field label="Legal name"><TextInput value={form.legalName} onChange={set('legalName')} /></Field>
      <Field label="Brand"><TextInput value={form.brandName} onChange={set('brandName')} /></Field>
      <Field label="GSTIN" hint="PAN and state code are read from the GSTIN."><TextInput className="font-mono uppercase" value={form.gstin} onChange={set('gstin')} /></Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="CIN"><TextInput value={form.cin} onChange={set('cin')} /></Field>
        <Field label="TAN"><TextInput className="uppercase" value={form.tan} onChange={set('tan')} /></Field>
        <Field label="Udyam number"><TextInput value={form.udyamNo} onChange={set('udyamNo')} /></Field>
        <Field label="Incorporated on"><TextInput type="date" value={form.incorporationDate} onChange={set('incorporationDate')} /></Field>
        <Field label="Email for documents"><TextInput type="email" value={form.email} onChange={set('email')} /></Field>
        <Field label="Phone"><TextInput value={form.phone} onChange={set('phone')} /></Field>
      </div>
      <Field label="Registered address"><TextInput value={form.registeredAddress} onChange={set('registeredAddress')} /></Field>
    </Modal>
  );
}
