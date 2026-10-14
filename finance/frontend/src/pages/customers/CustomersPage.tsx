import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import api from '../../api';
import { Card, Chip, PageHeader, TextInput } from '../../components/ui/kit';
import { formatINR } from '../../lib/money';
import type { CustomerRow } from './api';

// F080 customers: the CRM's companies with their outlets and Finance's terms.
export function CustomersPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const { data, isLoading } = useQuery({
    queryKey: ['customers', q],
    queryFn: async () => (await api.get<{ data: CustomerRow[] }>('/customers', { params: { q: q || undefined } })).data.data,
  });
  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <PageHeader title="Customers" subtitle="Companies and outlets come from the CRM; payment terms, credit limits and price lists are kept here. Add a new customer in the CRM." />
      <Card className="p-3 sm:p-4">
        <TextInput placeholder="Search by company name" value={q} onChange={(e) => setParams(e.target.value ? { q: e.target.value } : {}, { replace: true })} />
      </Card>
      {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
      {data?.length === 0 && <Card className="p-4 text-sm text-gray-500">{q ? 'No customer matches.' : 'No companies in the CRM yet (or Finance is not connected to the CRM database yet).'}</Card>}
      {!!data?.length && (
        <Card className="divide-y divide-gray-100">
          {data.map((c) => (
            <Link key={c.id} to={`/customers/${c.id}`} className="block px-3 sm:px-4 py-3 hover:bg-gray-50/70">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-gray-900 truncate">{c.name}</div>
                  <div className="text-xs text-gray-500 truncate">{c.outlets} outlet{c.outlets === 1 ? '' : 's'}{c.states.length ? ` · ${c.states.join(', ')}` : ''}{c.gstins.length ? ` · ${c.gstins.length} GSTIN${c.gstins.length === 1 ? '' : 's'}` : ' · no GSTIN'}</div>
                  <div className="text-xs text-gray-500">{c.paymentTerms ?? '—'}{c.creditLimit ? ` · limit ${formatINR(c.creditLimit, { decimals: false })}` : ''}{c.priceList ? ` · ${c.priceList}` : ''}{c.deductsTds ? ' · deducts TDS' : ''}</div>
                </div>
                <Chip tone="gray">{c.channelLabel}</Chip>
              </div>
            </Link>
          ))}
        </Card>
      )}
    </div>
  );
}
