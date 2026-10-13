import type { ReactNode } from 'react';
import { Chip } from '../../components/ui/kit';
import { formatINR } from '../../lib/money';
import { cn } from '../../lib/utils';
import { dateLabel } from '../settings/api';
import { categoryText, isZero, NATURE_LABEL, STATUS_LABEL, type Category, type LedgerTxn } from './ledgerApi';

/** Ledger rows: a table on desktop, cards on phones (no sideways scrolling, A12). */
export function LedgerRows({ rows, cats, onOpen, select }: {
  rows: LedgerTxn[];
  cats: Category[] | undefined;
  onOpen: (id: string) => void;
  /** Optional checkbox column (review queue bulk accept). */
  select?: { selected: Set<string>; toggle: (id: string) => void; canSelect: (t: LedgerTxn) => boolean };
}) {
  const what = (t: LedgerTxn): ReactNode => {
    if (t.status === 'split') return `Split (${t.splits.length})`;
    const text = categoryText(cats, t.categoryId, t.subCategoryId);
    return text ?? <span className="text-amber-700">Needs a category</span>;
  };
  const who = (t: LedgerTxn) => t.description || t.counterpartyName || t.narrationRaw;

  return (
    <>
      <div className="hidden md:block bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left">
            <tr>
              {select && <th className="pl-3 py-2.5 w-8"></th>}
              <th className="px-3 py-2.5">Date</th>
              <th className="px-3 py-2.5">Party / description</th>
              <th className="px-3 py-2.5">Category</th>
              <th className="px-3 py-2.5 text-right">Out</th>
              <th className="px-3 py-2.5 text-right">In</th>
              <th className="px-3 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className={cn('align-top cursor-pointer hover:bg-blue-50/40', t.status === 'ignored' && 'opacity-50')} onClick={() => onOpen(t.id)}>
                {select && (
                  <td className="pl-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                    {select.canSelect(t) && <input type="checkbox" aria-label="Select" checked={select.selected.has(t.id)} onChange={() => select.toggle(t.id)} />}
                  </td>
                )}
                <td className="px-3 py-2.5 whitespace-nowrap text-gray-600">{dateLabel(t.txnDate)}</td>
                <td className="px-3 py-2.5 max-w-xs">
                  <span className="block text-gray-900 truncate">{who(t)}</span>
                  {t.description && t.counterpartyName && <span className="block text-xs text-gray-500 truncate">{t.counterpartyName}</span>}
                </td>
                <td className="px-3 py-2.5 max-w-xs">
                  <span className="block truncate">{what(t)}</span>
                  <span className="block text-xs text-gray-500 truncate">
                    {t.nature ? NATURE_LABEL[t.nature] : ''}{t.status === 'suggested' && t.categorisationReason ? ` · ${t.categorisationReason}` : ''}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-right num text-red-700 whitespace-nowrap">{isZero(t.debit) ? '' : formatINR(t.debit)}</td>
                <td className="px-3 py-2.5 text-right num text-emerald-700 whitespace-nowrap">{isZero(t.credit) ? '' : formatINR(t.credit)}</td>
                <td className="px-3 py-2.5"><Chip tone={STATUS_LABEL[t.status].tone}>{STATUS_LABEL[t.status].text}</Chip></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="md:hidden space-y-2">
        {rows.map((t) => (
          <li key={t.id} className={cn('bg-white rounded-xl border border-gray-200 p-3 text-sm flex gap-2', t.status === 'ignored' && 'opacity-50')}>
            {select && select.canSelect(t) && (
              <input type="checkbox" aria-label="Select" className="mt-1" checked={select.selected.has(t.id)} onChange={() => select.toggle(t.id)} />
            )}
            <button className="flex-1 min-w-0 text-left" onClick={() => onOpen(t.id)}>
              <div className="flex items-start justify-between gap-2">
                <span className="font-medium text-gray-900 truncate">{who(t)}</span>
                <span className={`num whitespace-nowrap font-medium ${isZero(t.debit) ? 'text-emerald-700' : 'text-red-700'}`}>
                  {isZero(t.debit) ? `+${formatINR(t.credit)}` : `-${formatINR(t.debit)}`}
                </span>
              </div>
              <div className="text-xs text-gray-600 truncate">{what(t)}</div>
              <div className="mt-1 flex items-center justify-between gap-2 text-xs text-gray-500">
                <span>{dateLabel(t.txnDate)}{t.status === 'suggested' && t.categorisationReason ? ` · ${t.categorisationReason}` : ''}</span>
                <Chip tone={STATUS_LABEL[t.status].tone}>{STATUS_LABEL[t.status].text}</Chip>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
