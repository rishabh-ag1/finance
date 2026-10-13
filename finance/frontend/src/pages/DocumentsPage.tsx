import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import api from '../api';
import { Card, Chip, PageHeader } from '../components/ui/kit';

type Missing = { recordType: string; recordId: string; label: string; detail: string; missing: string[]; link: string };

// F161 Missing documents: records that should hold a file but do not.
export function DocumentsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['missing-docs'],
    queryFn: async () => (await api.get<{ data: { count: number; rows: Missing[] } }>('/attachments/missing')).data.data,
  });
  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <PageHeader
        title="Documents"
        subtitle="Files are attached on each record (vendors, bank rows, statements) and filed under /Finance/FY/Module/Record. This list shows what is still missing."
      />
      {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
      {data && data.count === 0 && <p className="text-sm text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2">Nothing missing. Every record has its required files.</p>}
      {data && data.count > 0 && (
        <Card className="divide-y divide-gray-100">
          {data.rows.map((r) => (
            <Link key={`${r.recordType}:${r.recordId}`} to={r.link} className="block p-3 sm:p-4 hover:bg-gray-50">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-gray-900 truncate">{r.label}</div>
                  <div className="text-xs text-gray-500">{r.detail}</div>
                </div>
                <div className="flex flex-wrap gap-1 justify-end">{r.missing.map((m) => <Chip key={m} tone="amber">{m}</Chip>)}</div>
              </div>
            </Link>
          ))}
        </Card>
      )}
      <p className="text-xs text-gray-500">Bills without an invoice copy, payments without proof and TDS challans without a PDF join this list with Phase 2.</p>
    </div>
  );
}
