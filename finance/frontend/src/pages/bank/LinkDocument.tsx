import { Link } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import api from '../../api';
import { Button, ErrorNote } from '../../components/ui/kit';
import { formatINR } from '../../lib/money';
import { apiErrorMessage } from '../../lib/utils';
import { dateLabel } from '../settings/api';

type Option = { type: string; id: string; label: string; date: string | null; amount: string };

/** F020: link this bank row to the record it stands for (same amount, within 15 days, not yet linked). */
export function LinkDocument({ txnId, onDone }: { txnId: string; onDone: () => void }) {
  const { data } = useQuery({ queryKey: ['txn', txnId, 'documents'], queryFn: async () => (await api.get<{ data: { options: Option[] } }>(`/bank/txns/${txnId}/documents`)).data.data });
  const link = useMutation({ mutationFn: async (o: Option) => (await api.post(`/bank/txns/${txnId}/link`, { type: o.type, docId: o.id })).data.data, onSuccess: onDone });
  if (!data) return null;
  return (
    <div className="border-t border-gray-100 pt-3 space-y-1">
      <p className="text-sm font-medium text-gray-700">Link to a document</p>
      {data.options.length === 0 ? (
        <p className="text-xs text-gray-500">
          Nothing recorded with this amount within 15 days. Record it first: a <Link to="/payables?tab=payments" className="underline">payment</Link>, <Link to="/receipts/new" className="underline">receipt</Link>, <Link to="/funding" className="underline">loan or capital</Link>, or a <Link to="/tds" className="underline">TDS challan</Link>; it links by itself when the amount and date agree.
        </p>
      ) : (
        <ul className="divide-y divide-gray-100 text-sm">
          {data.options.map((o) => (
            <li key={`${o.type}-${o.id}`} className="py-1.5 flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">{o.label}{o.date ? ` · ${dateLabel(o.date)}` : ''} · {formatINR(o.amount)}</span>
              <Button variant="secondary" disabled={link.isPending} onClick={() => link.mutate(o)}>Link</Button>
            </li>
          ))}
        </ul>
      )}
      <ErrorNote>{link.isError && apiErrorMessage(link.error, 'Not linked')}</ErrorNote>
    </div>
  );
}
