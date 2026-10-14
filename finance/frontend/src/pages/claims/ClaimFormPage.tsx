import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../api';
import { Button, Card, ErrorNote, Field, MoneyInput, PageHeader, Select, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { apiErrorMessage } from '../../lib/utils';
import { CategoryFields, type CategoryValue } from '../bank/CategoryFields';
import { useCategories } from '../bank/ledgerApi';
import { CLAIM_KEYS, useClaim, useFounders, type ClaimDetail } from './api';

const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

type Form = { founderUserId: string; expenseDate: string; paidFrom: string; vendorName: string; description: string; amount: string; hasGstInvoice: boolean; cat: CategoryValue };

function ClaimForm({ initial, claimId }: { initial: Form; claimId?: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: cats } = useCategories();
  const { data: founders } = useFounders();
  const [f, setF] = useState<Form>(initial);
  const save = useMutation({
    mutationFn: async () => {
      const body = {
        founderUserId: f.founderUserId || null, expenseDate: f.expenseDate, paidFrom: f.paidFrom, vendorName: f.vendorName, description: f.description || null,
        amount: f.amount, hasGstInvoice: f.hasGstInvoice, categoryId: f.cat.categoryId, subCategoryId: f.cat.subCategoryId || null,
      };
      const r = claimId ? await api.put<{ data: ClaimDetail }>(`/claims/${claimId}`, body) : await api.post<{ data: ClaimDetail }>('/claims', body);
      return r.data.data;
    },
    onSuccess: (c) => { for (const k of CLAIM_KEYS) qc.invalidateQueries({ queryKey: [k] }); navigate(`/claims/${c.id}`); },
  });

  return (
    <Card className="p-4 sm:p-6 space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Founder who paid">
          <Select value={f.founderUserId} disabled={!!claimId} onChange={(e) => setF({ ...f, founderUserId: e.target.value })}>
            {founders?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </Select>
        </Field>
        <Field label="Date of the expense"><TextInput type="date" max={today()} value={f.expenseDate} onChange={(e) => setF({ ...f, expenseDate: e.target.value })} /></Field>
        <Field label="Paid to" hint="The shop, vendor or service"><TextInput value={f.vendorName} onChange={(e) => setF({ ...f, vendorName: e.target.value })} /></Field>
        <Field label="Amount"><MoneyInput value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Field label="Paid from" hint="Personal account or card, e.g. HDFC card 4417"><TextInput value={f.paidFrom} onChange={(e) => setF({ ...f, paidFrom: e.target.value })} /></Field>
        <Field label="GST invoice in the company's name?">
          <Select value={f.hasGstInvoice ? 'yes' : 'no'} onChange={(e) => setF({ ...f, hasGstInvoice: e.target.value === 'yes' })}>
            <option value="no">No</option>
            <option value="yes">Yes</option>
          </Select>
        </Field>
        <Field label="What it was for" className="sm:col-span-2"><TextInput value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      </div>
      {cats && <CategoryFields cats={cats} value={f.cat} onChange={(cat) => setF({ ...f, cat })} compact hideNature />}
      <p className="text-xs text-gray-500">Attach the receipt on the next page. The other founder approves the claim; it then counts as spending on the expense date.</p>
      <ErrorNote>{save.isError && apiErrorMessage(save.error, 'Could not save the claim')}</ErrorNote>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={() => navigate(-1)}>Back</Button>
        <Button disabled={save.isPending || !f.amount || !f.vendorName || !f.paidFrom || !f.cat.categoryId} onClick={() => save.mutate()}>{claimId ? 'Save changes' : 'Submit claim'}</Button>
      </div>
    </Card>
  );
}

// F150: add or edit a founder expense claim.
export function ClaimFormPage({ mode }: { mode: 'new' | 'edit' }) {
  const { id } = useParams();
  const { user } = useAuth();
  const { data: c } = useClaim(mode === 'edit' ? id : undefined);
  if (mode === 'edit' && !c) return <p className="text-sm text-gray-500">Loading…</p>;
  const initial: Form = c
    ? { founderUserId: c.founderUserId, expenseDate: c.expenseDate, paidFrom: c.paidFrom, vendorName: c.vendorName, description: c.description ?? '', amount: c.amount, hasGstInvoice: c.hasGstInvoice, cat: { categoryId: c.categoryId, subCategoryId: c.subCategoryId ?? '', nature: '' } }
    : { founderUserId: user?.id ?? '', expenseDate: today(), paidFrom: '', vendorName: '', description: '', amount: '', hasGstInvoice: false, cat: { categoryId: '', subCategoryId: '', nature: '' } };
  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <PageHeader title={mode === 'edit' ? 'Edit claim' : 'New expense claim'} subtitle="A company expense you paid from your own account or card." />
      <ClaimForm initial={initial} claimId={c?.id} />
    </div>
  );
}
