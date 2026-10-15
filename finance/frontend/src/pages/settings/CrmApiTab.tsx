import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../../api';
import { Button, Card, Chip, ErrorNote, Field, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { apiErrorMessage } from '../../lib/utils';

type Key = { id: string; name: string; keyPrefix: string; actsAs: string | null; lastUsedAt: string | null; revokedAt: string | null; revokedReason: string | null; createdAt: string };
type Call = { id: string; at: string; crmUser: string | null; method: string; path: string; crmOrderNumber: string | null; docNumber: string | null; statusCode: number; error: string | null };
const when = (t: string) => new Date(t).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

// F105: keys the CRM uses to call the invoice API, and the log of every call.
export function CrmApiTab() {
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('financeSettings', 'edit');
  const [name, setName] = useState('');
  const [shown, setShown] = useState<{ name: string; key: string } | null>(null);
  const keys = useQuery({ queryKey: ['crm-api-keys'], queryFn: async () => (await api.get<{ data: Key[] }>('/crm-api/keys')).data.data });
  const calls = useQuery({ queryKey: ['crm-api-calls'], queryFn: async () => (await api.get<{ data: Call[] }>('/crm-api/calls')).data.data });
  const make = useMutation({
    mutationFn: async () => (await api.post<{ data: { name: string; key: string } }>('/crm-api/keys', { name })).data.data,
    onSuccess: (d) => { setShown(d); setName(''); qc.invalidateQueries({ queryKey: ['crm-api-keys'] }); },
  });
  const revoke = useMutation({
    mutationFn: async (k: Key) => {
      const reason = window.prompt(`Why is "${k.name}" revoked? The CRM stops working with it at once.`);
      if (!reason) return null;
      return (await api.post(`/crm-api/keys/${k.id}/revoke`, { reason })).data.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm-api-keys'] }),
  });
  return (
    <div className="space-y-4">
      <Card className="p-4 sm:p-6 space-y-3">
        <h2 className="font-semibold text-gray-900">CRM invoice API</h2>
        <p className="text-sm text-gray-600">
          The CRM creates, issues and fetches invoices through Finance, so numbering, GST and the register stay here. It sends a key in <code>X-Finance-Key</code> and the
          sales person's name in <code>X-Crm-User</code>; calls are recorded under the founder who made the key. Endpoints under <code>/api/integrations/crm/v1</code>:
          <code> POST /documents</code> (order number, proforma or tax invoice, issue now or not), <code>POST /documents/:id/issue</code>, <code>GET /orders/:orderNumber/documents</code>, <code>GET /documents/:id/pdf</code>.
        </p>
        {shown && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm space-y-1">
            <div className="font-medium">Key for {shown.name}: copy it now, it is not shown again.</div>
            <code className="block break-all select-all">{shown.key}</code>
            <Button variant="ghost" onClick={() => setShown(null)}>Done</Button>
          </div>
        )}
        {canEdit && (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="New key for" className="flex-1 min-w-48"><TextInput placeholder="CRM production" value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Button disabled={make.isPending || !name.trim()} onClick={() => make.mutate()}>Make key</Button>
          </div>
        )}
        <ErrorNote>{(make.isError && apiErrorMessage(make.error, 'Could not make the key')) || (revoke.isError && apiErrorMessage(revoke.error, 'Could not revoke'))}</ErrorNote>
        <ul className="divide-y divide-gray-100 text-sm">
          {keys.data?.length === 0 && <li className="py-2 text-gray-500">No keys yet.</li>}
          {keys.data?.map((k) => (
            <li key={k.id} className="py-2 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-medium">{k.name} <span className="text-gray-500 font-normal">{k.keyPrefix}…</span></div>
                <div className="text-xs text-gray-500">Made {when(k.createdAt)}{k.actsAs ? ` by ${k.actsAs}` : ''} · {k.lastUsedAt ? `last used ${when(k.lastUsedAt)}` : 'never used'}{k.revokedReason ? ` · revoked: ${k.revokedReason}` : ''}</div>
              </div>
              {k.revokedAt ? <Chip tone="red">Revoked</Chip> : canEdit ? <Button variant="ghost" disabled={revoke.isPending} onClick={() => revoke.mutate(k)}>Revoke</Button> : <Chip tone="green">Active</Chip>}
            </li>
          ))}
        </ul>
      </Card>
      <Card className="p-4 sm:p-6 space-y-3">
        <h2 className="font-semibold text-gray-900">Calls from the CRM</h2>
        {calls.data?.length === 0 && <p className="text-sm text-gray-500">No calls yet.</p>}
        <ul className="divide-y divide-gray-100 text-sm">
          {calls.data?.map((c) => (
            <li key={c.id} className="py-2 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate"><span className="font-medium">{c.crmUser ?? 'unknown'}</span> · {c.method} {c.path.replace('/api/integrations/crm/v1', '')}</div>
                <div className="text-xs text-gray-500 truncate">{when(c.at)}{c.crmOrderNumber ? ` · order ${c.crmOrderNumber}` : ''}{c.docNumber ? ` · ${c.docNumber}` : ''}{c.error ? ` · ${c.error}` : ''}</div>
              </div>
              <Chip tone={c.statusCode < 300 ? 'green' : c.statusCode < 500 ? 'amber' : 'red'}>{c.statusCode}</Chip>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
