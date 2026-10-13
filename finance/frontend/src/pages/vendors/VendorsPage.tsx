import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import api from '../../api';
import { Button, Card, Chip, PageHeader, Select, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { formatINR } from '../../lib/money';
import { dateLabel } from '../settings/api';
import { VendorForm } from './VendorForm';
import { MSME_LABEL, STATUS_CHIP, type VendorListRow, type VendorStatus } from './types';

// F030 vendor list: search, status, this FY's payments, warnings.
export function VendorsPage() {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [adding, setAdding] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['vendors', q, status],
    queryFn: async () => (await api.get<{ data: { fy: string; vendors: VendorListRow[] } }>('/vendors', { params: { q: q || undefined, status: status || undefined } })).data.data,
  });

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <PageHeader
        title="Vendors"
        subtitle="Everyone Entelechy pays: GSTIN, PAN, TDS, MSME and bank details in one place."
        action={hasPermission('financeVendors', 'edit') && <Button onClick={() => setAdding(true)}>Add vendor</Button>}
      />
      <div className="flex flex-wrap gap-2">
        <TextInput className="max-w-xs" placeholder="Search name, GSTIN or PAN" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select className="max-w-[12rem]" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option>
          {(Object.keys(STATUS_CHIP) as VendorStatus[]).map((s) => <option key={s} value={s}>{STATUS_CHIP[s].text}</option>)}
        </Select>
      </div>
      {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
      {data && data.vendors.length === 0 && <p className="text-sm text-gray-500">No vendors yet. Add one from its GSTIN.</p>}
      {data && data.vendors.length > 0 && (
        <Card className="divide-y divide-gray-100">
          {data.vendors.map((v) => (
            <Link key={v.id} to={`/vendors/${v.id}`} className="block p-3 sm:p-4 hover:bg-gray-50">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-gray-900 flex items-center gap-1.5">
                    {v.displayName}
                    {(v.pendingBankChange || v.bankRecentlyChanged) && <AlertTriangle className="w-4 h-4 text-amber-600" aria-label="Bank details changed or waiting for approval" />}
                  </div>
                  <div className="text-xs text-gray-500">
                    {[v.gstin ?? (v.pan ? `PAN ${v.pan}` : 'No GSTIN or PAN'), v.state, v.msmeType !== 'none' ? `MSME ${MSME_LABEL[v.msmeType]}` : null, v.tdsSection].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <div className="text-right">
                  <Chip tone={STATUS_CHIP[v.status].tone}>{STATUS_CHIP[v.status].text}</Chip>
                  <div className="text-xs text-gray-500 mt-1">Paid FY {data.fy}: <span className="num text-gray-800">{formatINR(v.paidThisFy, { decimals: false })}</span></div>
                  {v.lastPayment && <div className="text-xs text-gray-400">Last {dateLabel(v.lastPayment)}</div>}
                </div>
              </div>
            </Link>
          ))}
        </Card>
      )}
      {adding && <VendorForm vendor={null} onClose={() => setAdding(false)} onSaved={(id) => navigate(`/vendors/${id}`)} />}
    </div>
  );
}
