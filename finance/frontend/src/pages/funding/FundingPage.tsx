import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import api from '../../api';
import { Button, Card, Chip, ErrorNote, Field, Modal, MoneyInput, PageHeader, Select, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { formatINR } from '../../lib/money';
import { apiErrorMessage, cn } from '../../lib/utils';
import { dateLabel } from '../settings/api';
import { CAPITAL_TYPES, FUNDING_KEYS, type BankRow, type Capital, type Covenant, type LoanRow, type Overview } from './api';

const TABS = [['overview', 'Overview'], ['loans', 'Loans'], ['capital', 'Capital'], ['bank', 'Bank rows']] as const;
const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

export function CovenantCard({ c }: { c: Covenant }) {
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const [editing, setEditing] = useState(false);
  const [cap, setCap] = useState(c.cap);
  const [sanctioned, setSanctioned] = useState(c.countSanctionedLimit);
  const save = useMutation({ mutationFn: async () => (await api.put('/funding/setting', { debtCap: cap, countSanctionedLimit: sanctioned })).data.data, onSuccess: () => { setEditing(false); for (const k of FUNDING_KEYS) qc.invalidateQueries({ queryKey: [k] }); } });
  const used = Math.min(100, Math.max(0, (Number(c.totalDebt) / Number(c.cap)) * 100));
  return (
    <Card className="p-4 sm:p-6 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold text-gray-900">Debt against the Mesa cap</h2>
        {hasPermission('financeFunding', 'edit') && !editing && <Button variant="ghost" onClick={() => setEditing(true)}>Change cap</Button>}
      </div>
      <div className="text-sm text-gray-700">
        Total debt <span className="num font-semibold">{formatINR(c.totalDebt)}</span> of <span className="num">{formatINR(c.cap)}</span>
        {c.breached ? <span className="text-red-700"> · above the cap</span> : <span className="text-gray-500"> · room {formatINR(c.headroom)}</span>}
      </div>
      <div className="h-2 rounded bg-gray-100 overflow-hidden"><div className={cn('h-full', c.breached ? 'bg-red-600' : used > 80 ? 'bg-amber-500' : 'bg-[#0c2c55]')} style={{ width: `${used}%` }} /></div>
      <p className="text-xs text-gray-500">Loans {formatINR(c.loansOutstanding)} + cash credit {c.countSanctionedLimit ? 'sanctioned' : 'drawn'} {formatINR(c.cashCredit)} (BR-28, Q14). Loans marked as not counting are left out.</p>
      {editing && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Debt cap (₹)" className="w-48"><MoneyInput value={cap} onChange={(e) => setCap(e.target.value)} /></Field>
          <label className="flex items-center gap-2 text-sm pb-2"><input type="checkbox" checked={sanctioned} onChange={(e) => setSanctioned(e.target.checked)} /> Count cash credit limits, not drawn</label>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>Save</Button>
          <Button variant="ghost" onClick={() => setEditing(false)}>Close</Button>
        </div>
      )}
      <ErrorNote>{save.isError && apiErrorMessage(save.error, 'Not saved')}</ErrorNote>
    </Card>
  );
}

function OverviewTab() {
  const { data } = useQuery({ queryKey: ['funding'], queryFn: async () => (await api.get<{ data: Overview }>('/funding')).data.data });
  if (!data) return <p className="text-sm text-gray-500">Loading…</p>;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Card className="p-3"><div className="text-xs text-gray-500">Capital received</div><div className="text-lg font-semibold num">{formatINR(data.capital.total, { decimals: false })}</div><div className="text-xs text-gray-500">FY {data.fy}: {formatINR(data.capital.thisFy, { decimals: false })}</div></Card>
        <Card className="p-3"><div className="text-xs text-gray-500">Loans outstanding</div><div className="text-lg font-semibold num">{formatINR(data.loans.outstanding, { decimals: false })}</div><div className="text-xs text-gray-500">{data.loans.active} active{data.loans.overdue ? ` · ${data.loans.overdue} overdue` : ''}</div></Card>
        <Card className="p-3"><div className="text-xs text-gray-500">Loans received FY {data.fy}</div><div className="text-lg font-semibold num">{formatINR(data.loans.receivedThisFy, { decimals: false })}</div></Card>
        <Card className="p-3"><div className="text-xs text-gray-500">Next repayment</div>{data.loans.nextDue ? <Link to={`/funding/loans/${data.loans.nextDue.id}`} className="block hover:underline"><div className="text-lg font-semibold num">{formatINR(data.loans.nextDue.total, { decimals: false })}</div><div className="text-xs text-gray-500">{data.loans.nextDue.lender} · {dateLabel(data.loans.nextDue.dueDate)}</div></Link> : <div className="text-lg font-semibold">–</div>}</Card>
      </div>
      <CovenantCard key={`${data.covenant.cap}-${data.covenant.countSanctionedLimit}`} c={data.covenant} />
      {data.capital.allotmentOverdue.length > 0 && (
        <Card className="p-4 space-y-1 border-amber-300">
          <h2 className="font-semibold text-amber-800">Share application money not allotted within 60 days</h2>
          <p className="text-xs text-gray-600">Allot shares or refund the money [Verify the timing with the CA].</p>
          <ul className="text-sm">{data.capital.allotmentOverdue.map((x) => <li key={x.id}>{x.holderName}: {formatINR(x.amount)} received {dateLabel(x.receiptDate)} ({x.days} days)</li>)}</ul>
        </Card>
      )}
      {data.capital.byHolder.length > 0 && (
        <Card className="p-4 space-y-2">
          <h2 className="font-semibold text-gray-900">Capital by person</h2>
          <table className="w-full text-sm table-fixed">
            <thead><tr className="text-xs text-gray-500 text-left"><th className="py-1 w-[34%]">Who</th><th className="text-right">Paid-up</th><th className="text-right">Share application</th><th className="text-right">Not allotted</th></tr></thead>
            <tbody className="divide-y divide-gray-100">
              {data.capital.byHolder.map((h) => (
                <tr key={h.holderName}><td className="py-1.5 truncate">{h.holderName}</td><td className="text-right num">{formatINR(h.paidUp, { decimals: false })}</td><td className="text-right num">{formatINR(h.shareApplication, { decimals: false })}</td><td className={cn('text-right num', h.pendingAllotment !== '0.00' && 'text-amber-700')}>{formatINR(h.pendingAllotment, { decimals: false })}</td></tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {data.unexplained > 0 && <p className="text-sm text-gray-600">{data.unexplained} bank row(s) categorised as funding are not linked to a loan or capital entry: see <Link to="/funding?tab=bank" className="text-[#0c2c55] hover:underline">Bank rows</Link>.</p>}
    </div>
  );
}

function LoansTab() {
  const { data } = useQuery({ queryKey: ['loans'], queryFn: async () => (await api.get<{ data: LoanRow[] }>('/loans')).data.data });
  if (!data) return <p className="text-sm text-gray-500">Loading…</p>;
  const shown = data.filter((l) => l.status !== 'cancelled');
  return shown.length === 0 ? <Card className="p-4 text-sm text-gray-500">No loans yet. Add the Mesa loan from its agreement.</Card> : (
    <Card className="divide-y divide-gray-100">
      {shown.map((l) => (
        <Link key={l.id} to={`/funding/loans/${l.id}`} className="block px-3 sm:px-4 py-3 hover:bg-gray-50/70">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-medium text-gray-900 truncate">{l.lender}</div>
              <div className="text-xs text-gray-500 truncate">{l.repaymentTypeLabel} · {formatINR(l.disbursedAmount, { decimals: false })} on {dateLabel(l.disbursedDate)}{l.interestRate ? ` · ${l.interestRate}%` : ''} · repay by {dateLabel(l.finalDueDate)}{l.status === 'active' ? ` (${l.daysToFinalDue} days)` : ''}</div>
            </div>
            <div className="text-right shrink-0">
              <div className="num font-medium">{formatINR(l.balance)}</div>
              {l.status === 'closed' ? <Chip tone="green">Repaid</Chip> : l.overdue ? <Chip tone="red">Overdue</Chip> : l.nextDue ? <Chip tone="blue">Next {dateLabel(l.nextDue.dueDate)}</Chip> : <Chip>Active</Chip>}
            </div>
          </div>
        </Link>
      ))}
    </Card>
  );
}

function CapitalForm({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ holderName: '', receiptDate: today(), amount: '', type: 'share_application_money', notes: '' });
  const save = useMutation({ mutationFn: async () => (await api.post('/capital', { ...f, notes: f.notes || null })).data.data, onSuccess: () => { for (const k of FUNDING_KEYS) qc.invalidateQueries({ queryKey: [k] }); onClose(); } });
  return (
    <Modal title="Capital received" onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button disabled={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="From (founder or investor)"><TextInput value={f.holderName} onChange={(e) => setF({ ...f, holderName: e.target.value })} /></Field>
        <Field label="Type"><Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{CAPITAL_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
        <Field label="Date received"><TextInput type="date" value={f.receiptDate} onChange={(e) => setF({ ...f, receiptDate: e.target.value })} /></Field>
        <Field label="Amount (₹)"><MoneyInput value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Field label="Notes" className="sm:col-span-2"><TextInput value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      </div>
      <p className="text-xs text-gray-500 mt-2">It links to its bank credit by itself when the statement is imported (same amount, within 3 days, name in the narration).</p>
      <ErrorNote>{save.isError && apiErrorMessage(save.error, 'Not saved')}</ErrorNote>
    </Modal>
  );
}

function CapitalTab() {
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('financeFunding', 'edit');
  const [adding, setAdding] = useState(false);
  const [allot, setAllot] = useState<Capital | null>(null);
  const [allotForm, setAllotForm] = useState({ allotmentDate: today(), sharesAllotted: '' });
  const { data } = useQuery({ queryKey: ['capital'], queryFn: async () => (await api.get<{ data: Capital[] }>('/capital')).data.data });
  const refresh = () => { for (const k of FUNDING_KEYS) qc.invalidateQueries({ queryKey: [k] }); };
  const doAllot = useMutation({ mutationFn: async () => (await api.post(`/capital/${allot!.id}/allot`, { allotmentDate: allotForm.allotmentDate, sharesAllotted: Number(allotForm.sharesAllotted) })).data.data, onSuccess: () => { setAllot(null); refresh(); } });
  const cancel = useMutation({ mutationFn: async (c: Capital) => { const reason = window.prompt(`Why is ${c.holderName}'s ${formatINR(c.amount)} cancelled?`); if (!reason) return null; return (await api.post(`/capital/${c.id}/cancel`, { reason })).data.data; }, onSuccess: refresh });
  return (
    <div className="space-y-3">
      {canEdit && <div className="text-right"><Button onClick={() => setAdding(true)}><Plus className="w-4 h-4 inline" /> Capital received</Button></div>}
      <ErrorNote>{cancel.isError && apiErrorMessage(cancel.error, 'Not cancelled')}</ErrorNote>
      {data?.length === 0 && <Card className="p-4 text-sm text-gray-500">No capital recorded yet.</Card>}
      {!!data?.length && (
        <Card className="divide-y divide-gray-100">
          {data.map((c) => (
            <div key={c.id} className={cn('px-3 sm:px-4 py-3 flex items-start justify-between gap-2', c.status === 'cancelled' && 'opacity-50')}>
              <div className="min-w-0">
                <div className="font-medium text-gray-900 truncate">{c.holderName} · {c.typeLabel}</div>
                <div className="text-xs text-gray-500 truncate">
                  {dateLabel(c.receiptDate)}{c.allotmentDate ? ` · allotted ${dateLabel(c.allotmentDate)} (${c.sharesAllotted?.toLocaleString('en-IN')} shares)` : ''}{c.status === 'cancelled' ? ` · cancelled: ${c.statusReason}` : ''}
                </div>
              </div>
              <div className="text-right shrink-0 space-y-1">
                <div className="num font-medium">{formatINR(c.amount)}</div>
                <div className="flex gap-1 justify-end flex-wrap">
                  {c.status === 'recorded' && !c.allotted && <Chip tone={c.pendingAllotment?.overdue ? 'red' : 'amber'}>Not allotted · {c.pendingAllotment?.days}d</Chip>}
                  {c.status === 'recorded' && <Chip tone={c.inBank ? 'green' : 'gray'}>{c.inBank ? 'In bank' : 'Not in bank yet'}</Chip>}
                </div>
                {canEdit && c.status === 'recorded' && (
                  <div className="flex gap-1 justify-end">
                    {!c.allotted && <Button variant="ghost" onClick={() => setAllot(c)}>Allot</Button>}
                    <Button variant="ghost" disabled={cancel.isPending} onClick={() => cancel.mutate(c)}>Cancel</Button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </Card>
      )}
      {adding && <CapitalForm onClose={() => setAdding(false)} />}
      {allot && (
        <Modal title={`Allot shares to ${allot.holderName}`} onClose={() => setAllot(null)} footer={<><Button variant="secondary" onClick={() => setAllot(null)}>Close</Button><Button disabled={doAllot.isPending} onClick={() => doAllot.mutate()}>Save</Button></>}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Allotment date"><TextInput type="date" value={allotForm.allotmentDate} onChange={(e) => setAllotForm({ ...allotForm, allotmentDate: e.target.value })} /></Field>
            <Field label="Shares allotted"><TextInput inputMode="numeric" value={allotForm.sharesAllotted} onChange={(e) => setAllotForm({ ...allotForm, sharesAllotted: e.target.value })} /></Field>
          </div>
          <ErrorNote>{doAllot.isError && apiErrorMessage(doAllot.error, 'Not saved')}</ErrorNote>
        </Modal>
      )}
    </div>
  );
}

function BankTab() {
  const { data } = useQuery({ queryKey: ['funding', 'bank-rows'], queryFn: async () => (await api.get<{ data: BankRow[] }>('/funding/bank-rows')).data.data });
  if (!data) return <p className="text-sm text-gray-500">Loading…</p>;
  return (
    <div className="space-y-2">
      <p className="text-sm text-gray-600">Bank rows categorised as Financing or Founder Funds (or from a lender or founder) that are not linked to a loan, repayment or capital entry. Record the entry with the same amount and date and it links; or link it from the loan or capital page.</p>
      {data.length === 0 ? <Card className="p-4 text-sm text-gray-500">Nothing to explain.</Card> : (
        <Card className="divide-y divide-gray-100 text-sm">
          {data.map((r) => (
            <div key={r.id} className="px-3 sm:px-4 py-2 flex justify-between gap-2">
              <div className="min-w-0"><div className="truncate">{dateLabel(r.txnDate)} · {r.counterpartyName ?? r.category ?? ''}</div><div className="text-xs text-gray-500 truncate">{r.narration}</div></div>
              <div className={cn('num font-medium shrink-0', r.credit ? 'text-emerald-700' : '')}>{r.credit ? `+${formatINR(r.credit)}` : `−${formatINR(r.debit)}`}</div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

// M13 Funding & Loans (F140-F143).
export function FundingPage() {
  const [params, setParams] = useSearchParams();
  const { hasPermission } = useAuth();
  const tab = TABS.find(([k]) => k === params.get('tab'))?.[0] ?? 'overview';
  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <PageHeader
        title="Funding & loans"
        subtitle="Capital from founders and investors, loans and their repayments, and total debt against the Mesa cap."
        action={hasPermission('financeFunding', 'edit') && <Link to="/funding/loans/new" className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium bg-[#0c2c55] text-white hover:bg-[#0e3261]"><Plus className="w-4 h-4" /> Loan</Link>}
      />
      <nav className="flex gap-1 overflow-x-auto -mx-3 px-3 sm:mx-0 sm:px-0 border-b border-gray-200">
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setParams({ tab: k })} className={cn('shrink-0 px-3 py-2 text-sm border-b-2 -mb-px', tab === k ? 'border-[#0c2c55] text-[#0c2c55] font-medium' : 'border-transparent text-gray-500 hover:text-gray-800')}>{label}</button>
        ))}
      </nav>
      {tab === 'overview' && <OverviewTab />}
      {tab === 'loans' && <LoansTab />}
      {tab === 'capital' && <CapitalTab />}
      {tab === 'bank' && <BankTab />}
    </div>
  );
}
