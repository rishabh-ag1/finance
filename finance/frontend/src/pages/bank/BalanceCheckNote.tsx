import { formatINR } from '../../lib/money';
import { dateLabel } from '../settings/api';
import type { BalanceCheck } from './types';

/** BR-03 result in plain words. */
export function BalanceCheckNote({ check }: { check: Pick<BalanceCheck, 'status' | 'notes' | 'missingFrom' | 'missingTo'> & { fileOpening?: string; fileClosing?: string } }) {
  if (check.status === 'ok') {
    return (
      <p className="text-sm text-emerald-800 bg-emerald-50 rounded-lg px-3 py-2">
        Balances check out{check.fileOpening ? `: starts at ${formatINR(check.fileOpening)}, ends at ${formatINR(check.fileClosing)}` : ''}, and every row follows from the one before.
      </p>
    );
  }
  const tone = check.status === 'gap' ? 'text-amber-900 bg-amber-50' : 'text-red-800 bg-red-50';
  return (
    <div className={`text-sm rounded-lg px-3 py-2 space-y-1 ${tone}`}>
      <p className="font-medium">
        {check.status === 'gap' ? 'This file does not continue from the last imported balance.' : 'Balances inside this file do not add up.'}
        {' '}You can still import it; the batch keeps this warning.
      </p>
      {check.missingFrom && check.missingTo && <p>Probably missing: {dateLabel(check.missingFrom)} to {dateLabel(check.missingTo)}. Import that period too.</p>}
      <ul className="list-disc pl-5 text-xs">{check.notes.map((n) => <li key={n}>{n}</li>)}</ul>
    </div>
  );
}
