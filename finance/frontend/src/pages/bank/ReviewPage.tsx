import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import api from '../../api';
import { Button, ErrorNote, PageHeader } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { apiErrorMessage } from '../../lib/utils';
import { LedgerRows } from './LedgerRows';
import { TxnPanel } from './TxnPanel';
import { useCategories, useRefreshBank, type LedgerPage } from './ledgerApi';

// F016 review queue: rows with no category yet (Review) or with a rule's suggestion (Suggested).
// A month cannot be locked while any of its rows are here (BR-36).
export function ReviewPage() {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('financeBank', 'edit');
  const { data: cats } = useCategories();
  const refresh = useRefreshBank();
  const [open, setOpen] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { data, isLoading } = useQuery({
    queryKey: ['ledger', 'review-queue'],
    queryFn: async () => (await api.get<{ data: LedgerPage }>('/bank/txns', { params: { status: 'needs_review', limit: 500 } })).data.data,
  });
  const rows = data?.rows ?? [];
  const suggested = rows.filter((r) => r.status === 'suggested');

  const accept = useMutation({
    mutationFn: async (ids: string[]) => (await api.post<{ data: { accepted: number } }>('/bank/txns/accept', { ids })).data.data,
    onSuccess: () => { setSelected(new Set()); refresh(); },
  });
  const rerun = useMutation({
    mutationFn: async () => (await api.post<{ data: { checked: number; suggested: number } }>('/bank/rerun-rules')).data.data,
    onSuccess: () => refresh(),
  });

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <PageHeader
        title="Review queue"
        subtitle={<>{rows.length} row{rows.length === 1 ? '' : 's'} to check: {suggested.length} with a suggestion, {rows.length - suggested.length} with none. Accepting confirms the suggested category.</>}
      />
      {canEdit && rows.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <Button disabled={accept.isPending || selected.size === 0} onClick={() => accept.mutate([...selected])}>Accept selected ({selected.size})</Button>
          <Button variant="secondary" disabled={accept.isPending || suggested.length === 0} onClick={() => accept.mutate(suggested.map((r) => r.id))}>Accept all {suggested.length} suggestions</Button>
          <Button variant="ghost" disabled={rerun.isPending} onClick={() => rerun.mutate()}>Run rules again</Button>
        </div>
      )}
      <ErrorNote>{(accept.isError && apiErrorMessage(accept.error, 'Could not accept')) || (rerun.isError && apiErrorMessage(rerun.error, 'Could not run the rules'))}</ErrorNote>
      {rerun.data && <p className="text-sm text-gray-600">Rules checked {rerun.data.checked} row(s) and suggested a category for {rerun.data.suggested}.</p>}
      {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
      {!isLoading && rows.length === 0 && <p className="text-sm text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2">Nothing to review. Every imported row has a category.</p>}
      {rows.length > 0 && (
        <LedgerRows
          rows={rows}
          cats={cats}
          onOpen={setOpen}
          select={canEdit ? { selected, toggle, canSelect: (t) => t.status === 'suggested' } : undefined}
        />
      )}
      {open && <TxnPanel id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
