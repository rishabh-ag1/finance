import { useState } from 'react';
import { Lock, LockOpen } from 'lucide-react';
import { Button, Card, ErrorNote, Field, Modal, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { formatDateTime } from '../../lib/format';
import { apiErrorMessage } from '../../lib/utils';
import { monthLabel, useSettings, useSettingsMutation, type PeriodMonth } from './api';

// F008 period lock (BR-36): a locked month cannot be changed; unlocking needs a reason.
export function PeriodLockTab() {
  const { data } = useSettings<{ fy: string; months: PeriodMonth[] }>('period-locks');
  const { hasPermission } = useAuth();
  const lock = useSettingsMutation<{ month: string }>('period-locks', 'post');
  const [unlocking, setUnlocking] = useState<string | null>(null);
  const canEdit = hasPermission('financeSettings', 'edit');

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600">
        Lock a month once it is reviewed: its transactions can then not be changed, so dashboards for closed months never shift silently.
        A month can only be locked when nothing of it is left in the review queue.
      </p>
      <ErrorNote>{lock.isError && apiErrorMessage(lock.error, 'Could not lock the month')}</ErrorNote>
      <Card className="divide-y divide-gray-100">
        {data?.months.map((m) => (
          <div key={m.month} className="p-3 sm:p-4 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-3 min-w-0">
              {m.isLocked ? <Lock className="w-4 h-4 text-emerald-700 shrink-0" /> : <LockOpen className="w-4 h-4 text-gray-300 shrink-0" />}
              <div className="min-w-0">
                <div className="font-medium text-gray-900">{monthLabel(m.month)}</div>
                <div className="text-xs text-gray-500">
                  {m.isLocked && m.lockedAt && `Locked by ${m.lockedBy} on ${formatDateTime(m.lockedAt)}`}
                  {!m.isLocked && m.unlockedAt && `Unlocked by ${m.unlockedBy}: ${m.unlockReason}`}
                  {!m.isLocked && !m.unlockedAt && (m.canLock ? 'Open' : 'Not ended yet')}
                </div>
              </div>
            </div>
            {canEdit && (m.isLocked
              ? <Button variant="danger" onClick={() => setUnlocking(m.month)}>Unlock</Button>
              : m.canLock && <Button variant="secondary" disabled={lock.isPending} onClick={() => lock.mutate({ url: 'period-locks/lock', body: { month: m.month } })}>Lock</Button>)}
          </div>
        ))}
      </Card>
      {unlocking && <UnlockMonth month={unlocking} onClose={() => setUnlocking(null)} />}
    </div>
  );
}

function UnlockMonth({ month, onClose }: { month: string; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const unlock = useSettingsMutation<{ month: string; reason: string }>('period-locks', 'post');
  return (
    <Modal title={`Unlock ${monthLabel(month)}`} onClose={onClose} footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button variant="danger" disabled={unlock.isPending} onClick={() => unlock.mutate({ url: 'period-locks/unlock', body: { month, reason } }, { onSuccess: onClose })}>Unlock</Button>
    </>}>
      <ErrorNote>{unlock.isError && apiErrorMessage(unlock.error, 'Could not unlock')}</ErrorNote>
      <p className="text-sm text-gray-600">The unlock and your reason are kept in the audit log. Lock the month again when you are done.</p>
      <Field label="Why does this month need changes?"><TextInput value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </Modal>
  );
}
