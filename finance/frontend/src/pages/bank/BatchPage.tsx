import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import api from '../../api';
import { Card, PageHeader } from '../../components/ui/kit';
import { formatDateTime } from '../../lib/format';
import { formatINR } from '../../lib/money';
import { dateLabel } from '../settings/api';
import { BalanceCheckNote } from './BalanceCheckNote';
import { BankRows } from './BankRows';
import type { Batch, BankTxn } from './types';

// One imported statement: its balance check and the rows it added (all in Review until M3).
export function BatchPage() {
  const { id } = useParams();
  const { data: b, isLoading } = useQuery({
    queryKey: ['bank-import', id],
    queryFn: async () => (await api.get<{ data: Batch & { rows: BankTxn[] } }>(`/bank/imports/${id}`)).data.data,
  });
  if (isLoading || !b) return <p className="text-sm text-gray-500">Loading…</p>;

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <PageHeader
        title={b.fileName}
        subtitle={<>{b.bankName} · {dateLabel(b.periodFrom)} – {dateLabel(b.periodTo)} · imported {formatDateTime(b.importedAt)} · <Link to="/import" className="text-blue-700 underline">Import another</Link></>}
      />
      <Card className="p-4 sm:p-6 space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <div><div className="text-gray-500">Rows in file</div><div className="text-lg font-semibold">{b.rowsTotal}</div></div>
          <div><div className="text-gray-500">Added</div><div className="text-lg font-semibold">{b.rowsNew}</div></div>
          <div><div className="text-gray-500">Skipped (already imported)</div><div className="text-lg font-semibold text-gray-500">{b.rowsDuplicate}</div></div>
          <div><div className="text-gray-500">Closing balance</div><div className="num">{formatINR(b.closingBalance)}</div></div>
        </div>
        <BalanceCheckNote check={{ status: b.balanceCheckStatus, notes: b.balanceCheckNotes, missingFrom: b.missingFrom, missingTo: b.missingTo, fileOpening: b.openingBalance, fileClosing: b.closingBalance }} />
      </Card>
      {b.rows.length > 0 ? (
        <>
          <p className="text-sm text-gray-600">These rows wait in the review queue for a category (next milestone).</p>
          <BankRows rows={b.rows.map((t) => ({
            key: t.id,
            txnDate: t.txnDate,
            narration: t.narrationRaw,
            parsed: t.parseOk,
            mode: t.mode,
            modeDetail: t.modeDetail,
            utr: t.utr,
            counterpartyName: t.counterpartyName,
            counterpartyIfsc: t.counterpartyIfsc,
            counterpartyAccount: t.counterpartyAccount,
            remark: t.remark,
            debit: t.debit,
            credit: t.credit,
            balance: t.balance,
            badge: { tone: 'amber', text: 'In review' },
          }))} />
        </>
      ) : (
        <p className="text-sm text-gray-500">This file added no new rows; everything in it was already imported.</p>
      )}
    </div>
  );
}
