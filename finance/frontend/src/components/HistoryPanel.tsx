import { useQuery } from '@tanstack/react-query';
import api from '../api';
import { useAuth } from '../context/auth';
import { formatAuditValue, formatDateTime } from '../lib/format';
import { Card } from './ui/kit';

type Row = { id: string; action: string; field: string | null; oldValue: unknown; newValue: unknown; reason: string | null; userName: string; at: string };
const ACTION: Record<string, string> = { create: 'created', archive: 'archived', cancel: 'cancelled', unlock: 'unlocked', delete_refused: 'tried to delete (refused)', other: 'changed' };

/** F172: who changed what on this record, from what to what, and why (BR-43). Collapsed by default. */
export function HistoryPanel({ recordId, title = 'History' }: { recordId: string; title?: string }) {
  const { hasPermission } = useAuth();
  const can = hasPermission('financeAudit', 'view');
  const { data } = useQuery({
    enabled: can, queryKey: ['audit', 'record', recordId],
    queryFn: async () => (await api.get<{ data: { rows: Row[] } }>('/audit', { params: { recordId, limit: 100 } })).data.data.rows,
  });
  if (!can || !data?.length) return null;
  return (
    <Card className="p-4 sm:p-6">
      <details className="text-sm">
        <summary className="cursor-pointer font-semibold text-gray-900">{title} ({data.length})</summary>
        <ul className="mt-2 space-y-1 text-xs text-gray-600">
          {data.map((h) => (
            <li key={h.id}>
              <span className="text-gray-400">{formatDateTime(h.at)}</span> {h.userName}:{' '}
              {h.action === 'update' && h.field ? <>{h.field} {formatAuditValue(h.oldValue)} → {formatAuditValue(h.newValue)}</> : ACTION[h.action] ?? h.action}
              {h.reason && <span className="text-gray-400"> ({h.reason})</span>}
            </li>
          ))}
        </ul>
      </details>
    </Card>
  );
}
