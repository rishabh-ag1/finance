import { Chip } from '../../components/ui/kit';
import { formatINR } from '../../lib/money';
import { dateLabel } from '../settings/api';

/** One statement row as a table (desktop) or a card (phone), used by preview and batch pages. */
export type RowLike = {
  key: string;
  txnDate: string;
  narration: string;
  parsed: boolean;
  mode: string | null;
  modeDetail: string | null;
  utr: string | null;
  counterpartyName: string | null;
  counterpartyIfsc: string | null;
  counterpartyAccount: string | null;
  remark: string | null;
  debit: string;
  credit: string;
  balance: string | null;
  badge?: { tone: 'gray' | 'green' | 'amber' | 'red' | 'blue'; text: string };
};

const isZero = (v: string) => /^0+(\.0+)?$/.test(v);

function Party({ r }: { r: RowLike }) {
  if (!r.parsed) return <span className="text-amber-700">Not recognised: goes to review</span>;
  return (
    <>
      <span className="font-medium text-gray-900">{r.counterpartyName ?? '—'}</span>
      <span className="block text-xs text-gray-500">
        {[r.mode && `${r.mode}${r.modeDetail ? ` ${r.modeDetail}` : ''}`, r.utr && `UTR ${r.utr}`, r.counterpartyIfsc, r.counterpartyAccount && `A/c ${r.counterpartyAccount}`, r.remark]
          .filter(Boolean).join(' · ')}
      </span>
    </>
  );
}

export function BankRows({ rows }: { rows: RowLike[] }) {
  return (
    <>
      <div className="hidden md:block bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left">
            <tr>
              <th className="px-3 py-2.5">Date</th>
              <th className="px-3 py-2.5">Party and details</th>
              <th className="px-3 py-2.5 text-right">Out</th>
              <th className="px-3 py-2.5 text-right">In</th>
              <th className="px-3 py-2.5 text-right">Balance</th>
              <th className="px-3 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="align-top">
                <td className="px-3 py-2.5 whitespace-nowrap text-gray-600">{dateLabel(r.txnDate)}</td>
                <td className="px-3 py-2.5 max-w-md">
                  <Party r={r} />
                  <span className="block text-[11px] text-gray-400 font-mono break-all mt-0.5">{r.narration}</span>
                </td>
                <td className="px-3 py-2.5 text-right num text-red-700 whitespace-nowrap">{isZero(r.debit) ? '' : formatINR(r.debit)}</td>
                <td className="px-3 py-2.5 text-right num text-emerald-700 whitespace-nowrap">{isZero(r.credit) ? '' : formatINR(r.credit)}</td>
                <td className="px-3 py-2.5 text-right num text-gray-600 whitespace-nowrap">{formatINR(r.balance)}</td>
                <td className="px-3 py-2.5">{r.badge && <Chip tone={r.badge.tone}>{r.badge.text}</Chip>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="md:hidden space-y-2">
        {rows.map((r) => (
          <li key={r.key} className="bg-white rounded-xl border border-gray-200 p-3 text-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0"><Party r={r} /></div>
              <div className={`num whitespace-nowrap font-medium ${isZero(r.debit) ? 'text-emerald-700' : 'text-red-700'}`}>
                {isZero(r.debit) ? `+${formatINR(r.credit)}` : `-${formatINR(r.debit)}`}
              </div>
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-gray-500">
              <span>{dateLabel(r.txnDate)} · bal {formatINR(r.balance)}</span>
              {r.badge && <Chip tone={r.badge.tone}>{r.badge.text}</Chip>}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
