import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import api from '../api';
import { formatAuditValue, formatDateTime } from '../lib/format';
import { cn, CARD_SHADOW } from '../lib/utils';

type AuditRow = {
  id: string;
  recordType: string;
  recordId: string;
  action: 'create' | 'update' | 'archive' | 'cancel' | 'unlock' | 'delete_refused' | 'other';
  field: string | null;
  oldValue: unknown;
  newValue: unknown;
  reason: string | null;
  userId: string;
  userName: string;
  at: string;
};

type AuditPage = { rows: AuditRow[]; nextBefore: string | null };

const ACTION_LABEL: Record<AuditRow['action'], string> = {
  create: 'Created',
  update: 'Changed',
  archive: 'Archived',
  cancel: 'Cancelled',
  unlock: 'Unlocked',
  delete_refused: 'Delete refused',
  other: 'Other',
};

const ACTION_STYLE: Record<AuditRow['action'], string> = {
  create: 'bg-emerald-50 text-emerald-700',
  update: 'bg-blue-50 text-blue-700',
  archive: 'bg-gray-100 text-gray-700',
  cancel: 'bg-amber-50 text-amber-700',
  unlock: 'bg-amber-50 text-amber-700',
  delete_refused: 'bg-red-50 text-red-700',
  other: 'bg-gray-100 text-gray-700',
};

function ActionChip({ action }: { action: AuditRow['action'] }) {
  return <span className={cn('inline-block rounded-full px-2 py-0.5 text-xs font-medium', ACTION_STYLE[action])}>{ACTION_LABEL[action]}</span>;
}

/** What changed, in one line: "firstName: Test → Changed", or the record for a create. */
function changeText(r: AuditRow): string {
  if (r.action === 'create') return 'New record';
  if (r.action === 'delete_refused') return 'Tried to delete; refused';
  if (!r.field) return '—';
  return `${r.field}: ${formatAuditValue(r.oldValue)} → ${formatAuditValue(r.newValue)}`;
}

export function AuditPage() {
  const [recordType, setRecordType] = useState('');
  const [action, setAction] = useState('');

  const query = useInfiniteQuery({
    queryKey: ['audit', recordType, action],
    initialPageParam: '',
    queryFn: async ({ pageParam }) => {
      const res = await api.get<{ success: boolean; data: AuditPage }>('/audit', {
        params: { recordType: recordType || undefined, action: action || undefined, before: pageParam || undefined, limit: 50 },
      });
      return res.data.data;
    },
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });

  const rows = query.data?.pages.flatMap((p) => p.rows) ?? [];

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <div>
        <h1 className="font-instrument-serif text-3xl text-gray-900">Audit log</h1>
        <p className="text-sm text-gray-500">Every change to every record: who, when, what it was and what it became. Nothing here can be edited or removed.</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <input
          value={recordType}
          onChange={(e) => setRecordType(e.target.value.trim())}
          placeholder="Record type, e.g. User"
          className="flex-1 min-w-[160px] max-w-xs bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm"
        />
        <select
          value={action}
          onChange={(e) => setAction(e.target.value)}
          className="bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm"
        >
          <option value="">All actions</option>
          {Object.entries(ACTION_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>

      {query.isLoading && <p className="text-sm text-gray-500">Loading…</p>}
      {query.isError && <p className="text-sm text-red-600">Could not load the audit log.</p>}
      {!query.isLoading && rows.length === 0 && <p className="text-sm text-gray-500">No entries yet.</p>}

      {rows.length > 0 && (
        <>
          {/* Desktop: table */}
          <div className={cn('hidden md:block bg-white rounded-xl border border-gray-200 overflow-hidden', CARD_SHADOW)}>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left">
                <tr>
                  <th className="px-4 py-2.5">When (IST)</th>
                  <th className="px-4 py-2.5">Who</th>
                  <th className="px-4 py-2.5">Action</th>
                  <th className="px-4 py-2.5">Record</th>
                  <th className="px-4 py-2.5">Change</th>
                  <th className="px-4 py-2.5">Reason</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="px-4 py-2.5 whitespace-nowrap text-gray-600 num">{formatDateTime(r.at)}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap">{r.userName}</td>
                    <td className="px-4 py-2.5"><ActionChip action={r.action} /></td>
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-gray-800">{r.recordType}</div>
                      <div className="text-xs text-gray-400 font-mono">{r.recordId}</div>
                    </td>
                    <td className="px-4 py-2.5 text-gray-700 break-all max-w-sm">{changeText(r)}</td>
                    <td className="px-4 py-2.5 text-gray-500">{r.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Phone: cards, no horizontal scroll */}
          <ul className="md:hidden space-y-2">
            {rows.map((r) => (
              <li key={r.id} className="bg-white rounded-xl border border-gray-200 p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <ActionChip action={r.action} />
                  <span className="text-xs text-gray-500 num">{formatDateTime(r.at)}</span>
                </div>
                <div className="mt-2 font-medium text-gray-800">{r.recordType} <span className="text-gray-400 font-normal">by {r.userName}</span></div>
                <div className="mt-1 text-gray-700 break-all">{changeText(r)}</div>
                {r.reason && <div className="mt-1 text-xs text-gray-500">Reason: {r.reason}</div>}
              </li>
            ))}
          </ul>

          {query.hasNextPage && (
            <button
              onClick={() => query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
              className="w-full sm:w-auto px-4 py-2 rounded-lg border border-gray-200 bg-white text-sm hover:bg-gray-50"
            >
              {query.isFetchingNextPage ? 'Loading…' : 'Load older entries'}
            </button>
          )}
        </>
      )}
    </div>
  );
}
