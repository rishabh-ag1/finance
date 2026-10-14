import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../../api';
import { Button, Card, ErrorNote, Field, MoneyInput, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { apiErrorMessage } from '../../lib/utils';
import { dateLabel } from './api';

type ReconSettings = {
  razorpaySettlementDays: number; codRemittanceDays: number; settlementToBankDays: number; graceDays: number;
  amountTolerance: string; expectedFeeRate: string; feeGstRate: string; trackFrom: string | null;
  holidays: { id: string; date: string; name: string }[];
};

function SettingsForm({ initial }: { initial: ReconSettings }) {
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('financeSettings', 'edit');
  const [f, setF] = useState(initial);
  const [holiday, setHoliday] = useState({ date: '', name: '' });
  const refresh = (d: ReconSettings) => { qc.setQueryData(['recon-settings'], d); for (const k of ['recon-tracker', 'recon-transit', 'forecast']) qc.invalidateQueries({ queryKey: [k] }); };
  const save = useMutation({ mutationFn: async () => (await api.put<{ data: ReconSettings }>('/recon/settings', { ...f, trackFrom: f.trackFrom || null })).data.data, onSuccess: refresh });
  const addHoliday = useMutation({ mutationFn: async () => (await api.post<{ data: ReconSettings }>('/recon/holidays', holiday)).data.data, onSuccess: (d) => { refresh(d); setF({ ...f, holidays: d.holidays }); setHoliday({ date: '', name: '' }); } });
  const removeHoliday = useMutation({ mutationFn: async (id: string) => (await api.post<{ data: ReconSettings }>(`/recon/holidays/${id}/remove`)).data.data, onSuccess: (d) => { refresh(d); setF({ ...f, holidays: d.holidays }); } });
  const num = (k: 'razorpaySettlementDays' | 'codRemittanceDays' | 'settlementToBankDays' | 'graceDays') => (
    <TextInput type="number" min={0} max={30} disabled={!canEdit} value={f[k]} onChange={(e) => setF({ ...f, [k]: Number(e.target.value) })} />
  );
  return (
    <div className="space-y-4">
      <Card className="p-4 sm:p-6 space-y-3">
        <h2 className="font-semibold text-gray-900">Expected dates (BR-45)</h2>
        <p className="text-sm text-gray-600">In working days: weekends and the holidays below are skipped. An order is overdue once the expected date plus the grace days has come.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Razorpay settles after (working days)">{num('razorpaySettlementDays')}</Field>
          <Field label="Shiprocket remits COD after delivery (working days)" hint="From your Shiprocket account (Q24)">{num('codRemittanceDays')}</Field>
          <Field label="Settlement reaches the bank after (working days)">{num('settlementToBankDays')}</Field>
          <Field label="Grace days before overdue">{num('graceDays')}</Field>
        </div>
      </Card>
      <Card className="p-4 sm:p-6 space-y-3">
        <h2 className="font-semibold text-gray-900">Checks (BR-46)</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="Amount tolerance (₹)"><MoneyInput disabled={!canEdit} value={f.amountTolerance} onChange={(e) => setF({ ...f, amountTolerance: e.target.value })} /></Field>
          <Field label="Expected Razorpay fee (%)"><MoneyInput disabled={!canEdit} value={f.expectedFeeRate} onChange={(e) => setF({ ...f, expectedFeeRate: e.target.value })} /></Field>
          <Field label="GST on the fee (%)"><MoneyInput disabled={!canEdit} value={f.feeGstRate} onChange={(e) => setF({ ...f, feeGstRate: e.target.value })} /></Field>
          <Field label="Track orders placed from" hint="Older orders are left out (no history is migrated)"><TextInput type="date" disabled={!canEdit} value={f.trackFrom ?? ''} onChange={(e) => setF({ ...f, trackFrom: e.target.value || null })} /></Field>
        </div>
        <ErrorNote>{save.isError && apiErrorMessage(save.error, 'Could not save')}</ErrorNote>
        {canEdit && <div className="text-right"><Button disabled={save.isPending} onClick={() => save.mutate()}>{save.isSuccess ? 'Saved' : 'Save'}</Button></div>}
      </Card>
      <Card className="p-4 sm:p-6 space-y-3">
        <h2 className="font-semibold text-gray-900">Bank holidays</h2>
        {f.holidays.length === 0 && <p className="text-sm text-gray-500">None added. Add the bank holidays of the year so expected dates skip them.</p>}
        <ul className="divide-y divide-gray-100 text-sm">
          {f.holidays.map((h) => (
            <li key={h.id} className="py-2 flex items-center justify-between gap-2">
              <span>{dateLabel(h.date)} · {h.name}</span>
              {canEdit && <Button variant="ghost" disabled={removeHoliday.isPending} onClick={() => removeHoliday.mutate(h.id)}>Remove</Button>}
            </li>
          ))}
        </ul>
        {canEdit && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <TextInput type="date" aria-label="Holiday date" value={holiday.date} onChange={(e) => setHoliday({ ...holiday, date: e.target.value })} />
            <TextInput placeholder="Name, e.g. Dussehra" value={holiday.name} onChange={(e) => setHoliday({ ...holiday, name: e.target.value })} />
            <Button variant="secondary" disabled={!holiday.date || holiday.name.trim().length < 2 || addHoliday.isPending} onClick={() => addHoliday.mutate()}>Add holiday</Button>
          </div>
        )}
        <ErrorNote>{(addHoliday.isError || removeHoliday.isError) && apiErrorMessage(addHoliday.error ?? removeHoliday.error, 'Could not save')}</ErrorNote>
      </Card>
    </div>
  );
}

// Order-to-bank settings (M18): cycles, grace, tolerances, holidays.
export function OrderToBankTab() {
  const { data } = useQuery({ queryKey: ['recon-settings'], queryFn: async () => (await api.get<{ data: ReconSettings }>('/recon/settings')).data.data });
  if (!data) return <p className="text-sm text-gray-500">Loading…</p>;
  return <SettingsForm initial={data} />;
}
