import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import api from '../../api';
import { Button, Card, Chip, ErrorNote, Field, Modal, PageHeader, Select, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { formatINR } from '../../lib/money';
import { apiErrorMessage, cn } from '../../lib/utils';
import { MODES } from '../payments/api';
import { dateLabel, useSettings, type BankAccount } from '../settings/api';
import { CLAIM_KEYS, CLAIM_STATUSES, CLAIM_STATUS_TONE, REIMBURSEMENT_TONE, useFounders, type Claim, type FounderBalance, type Reimbursement, type ReimbursementDetail } from './api';

const TABS = [['claims', 'Claims'], ['reimbursements', 'Reimbursements']] as const;
const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

/** F151: pay the chosen approved claims of one founder back. The total is worked out by the server. */
function ReimburseModal({ founder, claims, onClose }: { founder: FounderBalance; claims: Claim[]; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: accounts } = useSettings<BankAccount[]>('bank-accounts');
  const businessAccounts = (accounts ?? []).filter((a) => a.isActive && !a.isArchived && a.owner === 'Entelechy');
  const [rec, setRec] = useState({ paidDate: today(), mode: 'imps', fromBankAccountId: '', utr: '' });
  const save = useMutation({
    mutationFn: async () => (await api.post<{ data: ReimbursementDetail }>('/claims/reimbursements', { founderUserId: founder.founderUserId, claimIds: claims.map((c) => c.id), ...rec, utr: rec.utr || null })).data.data,
    onSuccess: (r) => { for (const k of CLAIM_KEYS) qc.invalidateQueries({ queryKey: [k] }); navigate(`/claims/reimbursements/${r.id}`); },
  });
  return (
    <Modal title={`Reimburse ${founder.founderName}`} onClose={onClose} footer={<>
      <Button variant="secondary" onClick={onClose}>Back</Button>
      <Button disabled={save.isPending || !rec.fromBankAccountId} onClick={() => save.mutate()}>Record reimbursement</Button>
    </>}>
      <p className="text-sm text-gray-600">{claims.length} claim{claims.length === 1 ? '' : 's'}: {claims.map((c) => `${c.vendorName} ${formatINR(c.amount, { decimals: false })}`).join(', ')}. The amount is their total and gets a PMT number.</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Paid on"><TextInput type="date" value={rec.paidDate} onChange={(e) => setRec({ ...rec, paidDate: e.target.value })} /></Field>
        <Field label="How"><Select value={rec.mode} onChange={(e) => setRec({ ...rec, mode: e.target.value })}>{MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
        <Field label="From account">
          <Select value={rec.fromBankAccountId} onChange={(e) => setRec({ ...rec, fromBankAccountId: e.target.value })}>
            <option value="">Choose</option>
            {businessAccounts.map((a) => <option key={a.id} value={a.id}>{a.bankName} {a.accountNumberMasked}</option>)}
          </Select>
        </Field>
        <Field label="UTR / reference"><TextInput value={rec.utr} onChange={(e) => setRec({ ...rec, utr: e.target.value })} /></Field>
      </div>
      <ErrorNote>{save.isError && apiErrorMessage(save.error, 'Could not record it')}</ErrorNote>
    </Modal>
  );
}

function ClaimsTab() {
  const [params, setParams] = useSearchParams();
  const { hasPermission, user } = useAuth();
  const canEdit = hasPermission('financeClaims', 'edit');
  const f = { founderUserId: params.get('founder') ?? '', status: params.get('status') ?? '' };
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { replace: true }); };
  const [picked, setPicked] = useState<string[]>([]);
  const [paying, setPaying] = useState(false);
  const { data: founders } = useFounders();
  const { data: balances } = useQuery({ queryKey: ['claim-balances'], queryFn: async () => (await api.get<{ data: FounderBalance[] }>('/claims/balances')).data.data });
  const { data: claims } = useQuery({
    queryKey: ['claims', f],
    queryFn: async () => (await api.get<{ data: Claim[] }>('/claims', { params: { founderUserId: f.founderUserId || undefined, status: f.status || undefined } })).data.data,
  });
  const pickedRows = (claims ?? []).filter((c) => picked.includes(c.id));
  const oneFounder = new Set(pickedRows.map((c) => c.founderUserId)).size === 1;
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const shown = (balances ?? []).filter((b) => b.claimed !== '0.00' || b.waiting !== '0.00' || b.founderUserId === user?.id);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {shown.map((b) => (
          <Card key={b.founderUserId} className="p-3">
            <div className="text-xs text-gray-500">Owed to {b.founderName}</div>
            <div className={cn('text-lg font-semibold num', b.owed !== '0.00' && 'text-[#0c2c55]')}>{formatINR(b.owed, { decimals: false })}</div>
            <div className="text-xs text-gray-500">Approved {formatINR(b.claimed, { decimals: false })} · paid back {formatINR(b.reimbursed, { decimals: false })}{b.waiting !== '0.00' && ` · ${formatINR(b.waiting, { decimals: false })} waiting for approval`}</div>
          </Card>
        ))}
      </div>
      <Card className="p-3 sm:p-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
        <Select value={f.founderUserId} onChange={(e) => set('founder', e.target.value)} aria-label="Founder">
          <option value="">All founders</option>
          {founders?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </Select>
        <Select value={f.status} onChange={(e) => set('status', e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          {CLAIM_STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
      </Card>
      {canEdit && picked.length > 0 && (
        <Card className="p-3 flex flex-wrap items-center justify-between gap-2 sticky top-2 z-10">
          <span className="text-sm">{picked.length} chosen{!oneFounder && <span className="text-red-700"> · one reimbursement is for one founder</span>}</span>
          <Button disabled={!oneFounder} onClick={() => setPaying(true)}>Reimburse these</Button>
        </Card>
      )}
      {claims?.length === 0 && <Card className="p-4 text-sm text-gray-500">No claims{f.status || f.founderUserId ? ' match' : ' yet'}.</Card>}
      {!!claims?.length && (
        <Card className="divide-y divide-gray-100">
          {claims.map((c) => (
            <div key={c.id} className="px-3 sm:px-4 py-3 flex items-center gap-3">
              {canEdit && <input type="checkbox" aria-label={`Choose ${c.vendorName} ${c.amount}`} disabled={c.status !== 'approved'} checked={picked.includes(c.id)} onChange={() => toggle(c.id)} />}
              <Link to={`/claims/${c.id}`} className="flex-1 min-w-0 hover:underline">
                <span className="block font-medium text-gray-900 truncate">{c.vendorName} · {c.founderName}</span>
                <span className="block text-xs text-gray-500 truncate">{dateLabel(c.expenseDate)} · {c.categoryName}{c.subCategoryName ? ` / ${c.subCategoryName}` : ''} · {c.paidFrom}</span>
              </Link>
              <div className="text-right shrink-0">
                <div className="num font-medium">{formatINR(c.amount)}</div>
                <Chip tone={CLAIM_STATUS_TONE[c.status]}>{c.statusLabel}</Chip>
              </div>
            </div>
          ))}
        </Card>
      )}
      {paying && oneFounder && (
        <ReimburseModal founder={(balances ?? []).find((b) => b.founderUserId === pickedRows[0].founderUserId) ?? { founderUserId: pickedRows[0].founderUserId, founderName: pickedRows[0].founderName, claimed: '0', reimbursed: '0', owed: '0', waiting: '0' }} claims={pickedRows} onClose={() => setPaying(false)} />
      )}
    </div>
  );
}

function ReimbursementsTab() {
  const { data } = useQuery({ queryKey: ['reimbursements'], queryFn: async () => (await api.get<{ data: Reimbursement[] }>('/claims/reimbursements')).data.data });
  if (!data) return <p className="text-sm text-gray-500">Loading…</p>;
  if (!data.length) return <Card className="p-4 text-sm text-gray-500">No reimbursements yet. Choose approved claims on the Claims tab to pay them back.</Card>;
  return (
    <Card className="divide-y divide-gray-100">
      {data.map((r) => (
        <Link key={r.id} to={`/claims/reimbursements/${r.id}`} className="block px-3 sm:px-4 py-3 hover:bg-gray-50/70">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="font-medium text-gray-900 truncate">{r.reimbursementNo} · {r.founderName}</div>
              <div className="text-xs text-gray-500">{dateLabel(r.paidDate)} · {r.mode.toUpperCase()}{r.utr ? ` · ${r.utr}` : ''}</div>
            </div>
            <div className="flex items-center gap-3">
              <span className="num font-medium">{formatINR(r.amount)}</span>
              <Chip tone={REIMBURSEMENT_TONE[r.status]}>{r.statusLabel}</Chip>
            </div>
          </div>
        </Link>
      ))}
    </Card>
  );
}

// M14: F150 claims, F151 reimbursements, D32 founder balances (BR-27).
export function ClaimsPage() {
  const [params, setParams] = useSearchParams();
  const { hasPermission } = useAuth();
  const tab = TABS.find(([k]) => k === params.get('tab'))?.[0] ?? 'claims';
  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <PageHeader
        title="Founder claims"
        subtitle="Company expenses a founder paid personally, and what has been paid back. Money a founder puts into the company is capital or a loan, not a claim."
        action={hasPermission('financeClaims', 'edit') && (
          <Link to="/claims/new" className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium bg-[#0c2c55] text-white hover:bg-[#0e3261]"><Plus className="w-4 h-4" /> New claim</Link>
        )}
      />
      <nav className="flex gap-1 overflow-x-auto -mx-3 px-3 sm:mx-0 sm:px-0 border-b border-gray-200">
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setParams({ tab: k })} className={cn('shrink-0 px-3 py-2 text-sm border-b-2 -mb-px', tab === k ? 'border-[#0c2c55] text-[#0c2c55] font-medium' : 'border-transparent text-gray-500 hover:text-gray-800')}>{label}</button>
        ))}
      </nav>
      {tab === 'claims' ? <ClaimsTab /> : <ReimbursementsTab />}
    </div>
  );
}
