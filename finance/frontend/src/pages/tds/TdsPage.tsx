import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import api from '../../api';
import { Attachments } from '../../components/Attachments';
import { Button, Card, Chip, ErrorNote, Field, Modal, PageHeader, Select, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { formatINR } from '../../lib/money';
import { apiErrorMessage, cn } from '../../lib/utils';
import { dateLabel, monthLabel } from '../settings/api';

type Entry = {
  id: string; status: string; statusLabel: string; vendorId: string; vendorName: string; pan: string | null; deducteeType: string; section: string;
  source: { kind: 'bill' | 'advance'; id: string; label: string } | null; deductionDate: string; month: string; quarter: number; fyLabel: string;
  baseAmount: string; rate: string; tdsAmount: string; dueDate: string; lateMonths: number; lateInterest: string;
  challan: { id: string; serial: string; bsrCode: string; depositDate: string } | null;
};
type Payable = { month: string; dueDate: string; daysLeft: number; overdue: boolean; count: number; amount: string; interestSoFar: string }[];
type BankRow = { id: string; txnDate: string; debit: string; narration: string; utr: string | null; suggestedEntryIds: string[] };
type ChallanRow = { id: string; challanSerial: string; bsrCode: string; depositDate: string; section: string; total: string; interest: string; deductions: number; linkedToBank: boolean; isCancelled: boolean };
type Quarter = {
  fy: string; quarter: number; rows: Entry[]; totals: { deducted: string; toDeposit: string; deposited: string }; notDeposited: number;
  filed: { filedOn: string; ackNo: string; notes: string | null } | null;
  vendors: { vendorId: string; vendorName: string; pan: string | null; tds: string; deductions: number; certificate: { id: string; certificateNo: string | null; issuedOn: string } | null }[];
};
type Threshold = { vendorId: string; vendorName: string; section: string; credited: string; tdsDeducted: string; annualThreshold: string | null; singleThreshold: string | null; left: string | null; status: 'crossed' | 'near' | 'below' | 'no_annual_limit' };

const TABS = [['deposit', 'To deposit'], ['register', 'Register'], ['challans', 'Challans'], ['quarter', 'Quarterly 26Q'], ['thresholds', 'Thresholds']] as const;
const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const currentFy = () => { const d = new Date(Date.now() + 5.5 * 3600_000); const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; return `${String(y).slice(2)}-${String(y + 1).slice(2)}`; };
const currentQuarter = () => { const m = new Date(Date.now() + 5.5 * 3600_000).getUTCMonth() + 1; return m >= 4 && m <= 6 ? 1 : m <= 9 && m >= 7 ? 2 : m >= 10 ? 3 : 4; };

function ChallanForm({ entries, bankRow, onClose }: { entries: Entry[]; bankRow: BankRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [picked, setPicked] = useState<string[]>(bankRow?.suggestedEntryIds ?? []);
  const [f, setF] = useState({ bsrCode: '', challanSerial: '', depositDate: bankRow?.txnDate ?? today(), interest: '', fee: '', total: bankRow?.debit ?? '' });
  const { data: pv } = useQuery({
    enabled: picked.length > 0, queryKey: ['challan-preview', picked, f.depositDate],
    queryFn: async () => (await api.post<{ data: { tdsAmount: string; suggestedInterest: string; totalWithInterest: string; sections: number } }>('/tds/challans/preview', { entryIds: picked, depositDate: f.depositDate })).data.data,
  });
  const save = useMutation({
    mutationFn: async () => api.post('/tds/challans', { ...f, entryIds: picked, interest: f.interest || '0', fee: f.fee || '0', bankTxnId: bankRow?.id ?? null }),
    onSuccess: () => { for (const k of ['tds-register', 'tds-payable', 'tds-bank-rows', 'tds-challans', 'dashboard-home']) qc.invalidateQueries({ queryKey: [k] }); onClose(); },
  });
  const open = entries.filter((e) => e.status === 'deducted');
  return (
    <Modal title={bankRow ? `Challan for the ${formatINR(bankRow.debit)} bank row of ${dateLabel(bankRow.txnDate)}` : 'Record a TDS challan'} onClose={onClose} footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button disabled={save.isPending || !picked.length || !f.bsrCode || !f.challanSerial || !f.total} onClick={() => save.mutate()}>Save challan</Button>
    </>}>
      <p className="text-sm text-gray-600">Tick the deductions this challan pays (one section per challan). Type the details as printed on the challan.</p>
      <ul className="max-h-56 overflow-y-auto divide-y divide-gray-100 text-sm border border-gray-100 rounded-lg">
        {open.length === 0 && <li className="p-2 text-gray-500">No TDS waiting to be deposited.</li>}
        {open.map((e) => (
          <li key={e.id} className="p-2 flex items-center gap-2">
            <input type="checkbox" aria-label={`Choose ${e.vendorName}`} checked={picked.includes(e.id)} onChange={() => setPicked((p) => (p.includes(e.id) ? p.filter((x) => x !== e.id) : [...p, e.id]))} />
            <span className="flex-1 min-w-0"><span className="block truncate">{e.vendorName} · {e.section}</span><span className="block text-xs text-gray-500">{dateLabel(e.deductionDate)} · due {dateLabel(e.dueDate)}</span></span>
            <span className="num">{formatINR(e.tdsAmount)}</span>
          </li>
        ))}
      </ul>
      {pv && <p className="text-sm">TDS chosen <b className="num">{formatINR(pv.tdsAmount)}</b>{pv.suggestedInterest !== '0.00' && <> · late interest at that date <b className="num">{formatINR(pv.suggestedInterest)}</b> (total {formatINR(pv.totalWithInterest)})</>}{pv.sections > 1 && <span className="text-red-700"> · more than one section chosen</span>}</p>}
      <div className="grid grid-cols-2 gap-3">
        <Field label="BSR code"><TextInput inputMode="numeric" value={f.bsrCode} onChange={(e) => setF({ ...f, bsrCode: e.target.value })} placeholder="7 digits" /></Field>
        <Field label="Challan serial"><TextInput inputMode="numeric" value={f.challanSerial} onChange={(e) => setF({ ...f, challanSerial: e.target.value })} /></Field>
        <Field label="Deposited on"><TextInput type="date" value={f.depositDate} onChange={(e) => setF({ ...f, depositDate: e.target.value })} /></Field>
        <Field label="Total paid"><TextInput inputMode="decimal" value={f.total} onChange={(e) => setF({ ...f, total: e.target.value })} /></Field>
        <Field label="Interest"><TextInput inputMode="decimal" value={f.interest} onChange={(e) => setF({ ...f, interest: e.target.value })} placeholder="0.00" /></Field>
        <Field label="Fee"><TextInput inputMode="decimal" value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })} placeholder="0.00" /></Field>
      </div>
      {!bankRow && <p className="text-xs text-gray-500">The OPT/CBDT bank row of the same total within 3 days is linked by itself.</p>}
      <ErrorNote>{save.isError && apiErrorMessage(save.error, 'Could not save the challan')}</ErrorNote>
    </Modal>
  );
}

function DepositTab({ canEdit }: { canEdit: boolean }) {
  const [form, setForm] = useState<{ bankRow: BankRow | null } | null>(null);
  const { data: payable } = useQuery({ queryKey: ['tds-payable'], queryFn: async () => (await api.get<{ data: Payable }>('/tds/payable')).data.data });
  const { data: reg } = useQuery({ queryKey: ['tds-register', 'deducted'], queryFn: async () => (await api.get<{ data: { rows: Entry[] } }>('/tds/register', { params: { status: 'deducted' } })).data.data });
  const { data: rows } = useQuery({ queryKey: ['tds-bank-rows'], queryFn: async () => (await api.get<{ data: BankRow[] }>('/tds/bank-rows')).data.data });
  return (
    <div className="space-y-4">
      {payable?.length === 0 && <Card className="p-4 text-sm text-gray-500">No TDS is waiting to be deposited.</Card>}
      {!!payable?.length && (
        <Card className="divide-y divide-gray-100">
          {payable.map((m) => (
            <div key={m.month} className="px-3 sm:px-4 py-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="font-medium">TDS of {monthLabel(m.month)} <span className="text-gray-500 font-normal">({m.count} deduction{m.count === 1 ? '' : 's'})</span></div>
                <div className={cn('text-xs', m.overdue ? 'text-red-700' : 'text-gray-500')}>
                  Due {dateLabel(m.dueDate)} · {m.overdue ? `${-m.daysLeft} days late` : `${m.daysLeft} days left`}{m.interestSoFar !== '0.00' && ` · interest so far ${formatINR(m.interestSoFar)}`}
                </div>
              </div>
              <span className="num font-semibold">{formatINR(m.amount)}</span>
            </div>
          ))}
        </Card>
      )}
      {canEdit && <Button onClick={() => setForm({ bankRow: null })}>Record a challan</Button>}

      <Card className="p-4 sm:p-6 space-y-2">
        <h2 className="font-semibold text-gray-900">TDS payments in the bank statement without a challan</h2>
        <p className="text-sm text-gray-600">OPT/CBDT rows from imported statements. Each shows the deductions it most likely pays (BR-14).</p>
        {rows?.length === 0 && <p className="text-sm text-gray-500">None.</p>}
        <ul className="divide-y divide-gray-100 text-sm">
          {rows?.map((r) => (
            <li key={r.id} className="py-2 flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0"><span className="block">{dateLabel(r.txnDate)} · <span className="num">{formatINR(r.debit)}</span>{r.suggestedEntryIds.length ? ` · matches ${r.suggestedEntryIds.length} deduction${r.suggestedEntryIds.length === 1 ? '' : 's'}` : ' · no matching deduction'}</span><span className="block text-[11px] text-gray-400 font-mono truncate">{r.narration}</span></span>
              {canEdit && <Button variant="secondary" onClick={() => setForm({ bankRow: r })}>Record challan</Button>}
            </li>
          ))}
        </ul>
      </Card>
      {form && reg && <ChallanForm entries={reg.rows} bankRow={form.bankRow} onClose={() => setForm(null)} />}
    </div>
  );
}

function RegisterTab() {
  const [f, setF] = useState({ fy: currentFy(), quarter: '', status: '' });
  const { data } = useQuery({
    queryKey: ['tds-register', f],
    queryFn: async () => (await api.get<{ data: { rows: Entry[]; totals: { count: number; deducted: string; toDeposit: string; deposited: string } } }>('/tds/register', { params: { fy: f.fy || undefined, quarter: f.quarter || undefined, status: f.status || undefined } })).data.data,
  });
  return (
    <div className="space-y-3">
      <Card className="p-3 grid grid-cols-3 gap-2">
        <TextInput aria-label="FY" value={f.fy} onChange={(e) => setF({ ...f, fy: e.target.value })} placeholder="26-27" />
        <Select aria-label="Quarter" value={f.quarter} onChange={(e) => setF({ ...f, quarter: e.target.value })}><option value="">Any quarter</option>{[1, 2, 3, 4].map((q) => <option key={q} value={q}>Q{q}</option>)}</Select>
        <Select aria-label="Status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          <option value="">Any status</option><option value="deducted">To deposit</option><option value="deposited">Deposited</option><option value="return_filed">Return filed</option><option value="certificate_issued">Form 16A issued</option><option value="cancelled">Cancelled</option>
        </Select>
      </Card>
      {data && (
        <div className="grid grid-cols-3 gap-2">
          <Card className="p-3"><div className="text-xs text-gray-500">Deducted</div><div className="font-semibold num">{formatINR(data.totals.deducted, { decimals: false })}</div></Card>
          <Card className="p-3"><div className="text-xs text-gray-500">To deposit</div><div className="font-semibold num text-amber-700">{formatINR(data.totals.toDeposit, { decimals: false })}</div></Card>
          <Card className="p-3"><div className="text-xs text-gray-500">Deposited</div><div className="font-semibold num">{formatINR(data.totals.deposited, { decimals: false })}</div></Card>
        </div>
      )}
      {data?.rows.length === 0 && <Card className="p-4 text-sm text-gray-500">No deductions here.</Card>}
      {!!data?.rows.length && (
        <Card className="divide-y divide-gray-100">
          {data.rows.map((e) => (
            <div key={e.id} className="px-3 sm:px-4 py-3 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="font-medium truncate">{e.vendorName} · {e.section}</div>
                <div className="text-xs text-gray-500">
                  {dateLabel(e.deductionDate)} · {e.rate}% of {formatINR(e.baseAmount, { decimals: false })} · PAN {e.pan ?? 'not on file'}
                  {e.source && <> · <Link to={e.source.kind === 'bill' ? `/bills/${e.source.id}` : `/payments/${e.source.id}`} className="underline">{e.source.label}</Link></>}
                  {e.challan && ` · challan ${e.challan.bsrCode}/${e.challan.serial} of ${dateLabel(e.challan.depositDate)}`}
                  {e.lateInterest !== '0.00' && <span className="text-red-700"> · late interest {formatINR(e.lateInterest)}</span>}
                </div>
              </div>
              <div className="flex items-center gap-2"><span className="num font-medium">{formatINR(e.tdsAmount)}</span><Chip tone={e.status === 'deducted' ? 'amber' : e.status === 'cancelled' ? 'gray' : 'green'}>{e.statusLabel}</Chip></div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

function ChallansTab({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const { data } = useQuery({ queryKey: ['tds-challans'], queryFn: async () => (await api.get<{ data: ChallanRow[] }>('/tds/challans')).data.data });
  const cancel = useMutation({
    mutationFn: async (id: string) => api.post(`/tds/challans/${id}/cancel`, { reason }),
    onSuccess: () => { for (const k of ['tds-challans', 'tds-register', 'tds-payable', 'tds-bank-rows']) qc.invalidateQueries({ queryKey: [k] }); setOpen(null); setReason(''); },
  });
  return (
    <div className="space-y-3">
      {data?.length === 0 && <Card className="p-4 text-sm text-gray-500">No challans yet.</Card>}
      {!!data?.length && (
        <Card className="divide-y divide-gray-100">
          {data.map((c) => (
            <div key={c.id} className={cn('px-3 sm:px-4 py-3 space-y-2', c.isCancelled && 'opacity-60')}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium">{dateLabel(c.depositDate)} · BSR {c.bsrCode} · serial {c.challanSerial}</div>
                  <div className="text-xs text-gray-500">{c.section} · {c.deductions} deduction{c.deductions === 1 ? '' : 's'}{c.interest !== '0.00' && ` · interest ${formatINR(c.interest)}`}{c.linkedToBank ? ' · in the bank statement' : ' · not yet linked to a bank row'}</div>
                </div>
                <div className="flex items-center gap-2"><span className="num font-medium">{formatINR(c.total)}</span>{c.isCancelled ? <Chip>Cancelled</Chip> : <Button variant="ghost" onClick={() => setOpen(open === c.id ? null : c.id)}>{open === c.id ? 'Close' : 'Open'}</Button>}</div>
              </div>
              {open === c.id && (
                <div className="space-y-2 border-t border-gray-100 pt-2">
                  <Attachments recordType="TdsChallan" recordId={c.id} kinds={['challan', 'other']} compact />
                  {canEdit && (
                    <div className="flex flex-wrap gap-2 items-end">
                      <Field label="Cancel with a reason" className="flex-1"><TextInput value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. entered against the wrong deduction" /></Field>
                      <Button variant="danger" disabled={reason.trim().length < 3 || cancel.isPending} onClick={() => cancel.mutate(c.id)}>Cancel challan</Button>
                    </div>
                  )}
                  <ErrorNote>{cancel.isError && apiErrorMessage(cancel.error, 'Could not cancel')}</ErrorNote>
                </div>
              )}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

function QuarterTab({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const [sel, setSel] = useState({ fy: currentFy(), quarter: String(currentQuarter() === 1 ? 4 : currentQuarter() - 1) });
  const [filing, setFiling] = useState({ filedOn: today(), ackNo: '' });
  const [cert, setCert] = useState<{ vendorId: string; vendorName: string } | null>(null);
  const [certForm, setCertForm] = useState({ issuedOn: today(), certificateNo: '' });
  const key = ['tds-quarter', sel];
  const { data } = useQuery({ queryKey: key, queryFn: async () => (await api.get<{ data: Quarter }>('/tds/quarter', { params: { fy: sel.fy, quarter: sel.quarter } })).data.data });
  const file = useMutation({ mutationFn: async () => api.post('/tds/returns', { fy: sel.fy, quarter: Number(sel.quarter), ...filing }), onSuccess: () => qc.invalidateQueries({ queryKey: key }) });
  const issue = useMutation({ mutationFn: async () => api.post('/tds/certificates', { fy: sel.fy, quarter: Number(sel.quarter), vendorId: cert!.vendorId, ...certForm }), onSuccess: () => { qc.invalidateQueries({ queryKey: key }); setCert(null); } });
  return (
    <div className="space-y-3">
      <Card className="p-3 flex flex-wrap gap-2 items-end">
        <Field label="FY"><TextInput value={sel.fy} onChange={(e) => setSel({ ...sel, fy: e.target.value })} className="w-24" /></Field>
        <Field label="Quarter"><Select value={sel.quarter} onChange={(e) => setSel({ ...sel, quarter: e.target.value })} className="w-24">{[1, 2, 3, 4].map((q) => <option key={q} value={q}>Q{q}</option>)}</Select></Field>
        <a href={`${import.meta.env.VITE_API_URL}/tds/quarter/export?fy=${sel.fy}&quarter=${sel.quarter}`} className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium bg-white border border-gray-200 text-gray-800 hover:bg-gray-50"><Download className="w-4 h-4" /> Excel for the CA</a>
      </Card>
      {data && (
        <>
          <p className="text-sm text-gray-600">Q{data.quarter} FY {data.fy}: {data.rows.length} deduction{data.rows.length === 1 ? '' : 's'}, TDS {formatINR(data.totals.deducted)}.{data.notDeposited > 0 && <span className="text-amber-800"> {data.notDeposited} not deposited yet.</span>} Filing itself is done by the CA.</p>
          <Card className="p-4 sm:p-6 space-y-2">
            <h2 className="font-semibold text-gray-900">Return (26Q)</h2>
            {data.filed ? <p className="text-sm">Filed on {dateLabel(data.filed.filedOn)}, acknowledgement {data.filed.ackNo}.</p> : canEdit && (
              <div className="flex flex-wrap gap-2 items-end">
                <Field label="Filed on"><TextInput type="date" value={filing.filedOn} onChange={(e) => setFiling({ ...filing, filedOn: e.target.value })} /></Field>
                <Field label="Acknowledgement no" className="flex-1"><TextInput value={filing.ackNo} onChange={(e) => setFiling({ ...filing, ackNo: e.target.value })} /></Field>
                <Button disabled={!filing.ackNo.trim() || file.isPending} onClick={() => file.mutate()}>Mark filed</Button>
              </div>
            )}
            <ErrorNote>{file.isError && apiErrorMessage(file.error, 'Could not mark the return filed')}</ErrorNote>
          </Card>
          <Card className="divide-y divide-gray-100">
            {data.vendors.length === 0 && <p className="p-4 text-sm text-gray-500">No deductions in this quarter.</p>}
            {data.vendors.map((v) => (
              <div key={v.vendorId} className="px-3 sm:px-4 py-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0"><div className="font-medium truncate">{v.vendorName}</div><div className="text-xs text-gray-500">PAN {v.pan ?? 'not on file'} · {v.deductions} deduction{v.deductions === 1 ? '' : 's'}</div></div>
                <div className="flex items-center gap-2">
                  <span className="num">{formatINR(v.tds)}</span>
                  {v.certificate ? <Chip tone="green">16A {v.certificate.certificateNo ?? ''} {dateLabel(v.certificate.issuedOn)}</Chip>
                    : canEdit && data.filed && <Button variant="secondary" onClick={() => setCert({ vendorId: v.vendorId, vendorName: v.vendorName })}>Form 16A given</Button>}
                </div>
              </div>
              {v.certificate && <Attachments compact recordType="TdsCertificate" recordId={v.certificate.id} kinds={['form16a']} />}
              </div>
            ))}
          </Card>
        </>
      )}
      {cert && (
        <Modal title={`Form 16A for ${cert.vendorName}`} onClose={() => setCert(null)} footer={<><Button variant="secondary" onClick={() => setCert(null)}>Cancel</Button><Button disabled={issue.isPending} onClick={() => issue.mutate()}>Save</Button></>}>
          <Field label="Given on"><TextInput type="date" value={certForm.issuedOn} onChange={(e) => setCertForm({ ...certForm, issuedOn: e.target.value })} /></Field>
          <Field label="Certificate number"><TextInput value={certForm.certificateNo} onChange={(e) => setCertForm({ ...certForm, certificateNo: e.target.value })} /></Field>
          <p className="text-xs text-gray-500">After saving, attach the PDF under the vendor's line.</p>
          <ErrorNote>{issue.isError && apiErrorMessage(issue.error, 'Could not save')}</ErrorNote>
        </Modal>
      )}
    </div>
  );
}

function ThresholdsTab() {
  const { data } = useQuery({ queryKey: ['tds-thresholds'], queryFn: async () => (await api.get<{ data: Threshold[] }>('/tds/thresholds')).data.data });
  const tone = { crossed: 'red', near: 'amber', below: 'gray', no_annual_limit: 'gray' } as const;
  const text = { crossed: 'Over the FY limit', near: 'Near the FY limit', below: 'Below', no_annual_limit: 'No FY limit' } as const;
  return (
    <div className="space-y-2">
      <p className="text-sm text-gray-600">This FY, per vendor with a TDS section: billed and advanced so far against the section's limits (BR-12). Over the FY limit, TDS is due on the whole year, earlier bills included.</p>
      {data?.length === 0 && <Card className="p-4 text-sm text-gray-500">No vendor has a TDS section yet. Set one on the vendor page.</Card>}
      {!!data?.length && (
        <Card className="divide-y divide-gray-100">
          {data.map((t) => (
            <div key={t.vendorId} className="px-3 sm:px-4 py-3 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0"><Link to={`/vendors/${t.vendorId}`} className="font-medium hover:underline">{t.vendorName}</Link><div className="text-xs text-gray-500">{t.section}{t.annualThreshold && ` · FY limit ${formatINR(t.annualThreshold, { decimals: false })}`}{t.singleThreshold && ` · single bill ${formatINR(t.singleThreshold, { decimals: false })}`}{t.left && t.status !== 'crossed' && ` · ${formatINR(t.left, { decimals: false })} left`}</div></div>
              <div className="flex items-center gap-2"><span className="num">{formatINR(t.credited, { decimals: false })}</span><Chip tone={tone[t.status]}>{text[t.status]}</Chip></div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

// M07 TDS tracker: F070 register, F071 to deposit, F072 challans, F073-F074 quarter, F075 thresholds.
export function TdsPage() {
  const [params, setParams] = useSearchParams();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('financeTds', 'edit');
  const tab = TABS.find(([k]) => k === params.get('tab'))?.[0] ?? 'deposit';
  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <PageHeader title="TDS" subtitle="Deducted on bills and advances, deposited by challan, filed quarterly by the CA. Rates are the old-Act values until the CA confirms them (Q15)." />
      <nav className="flex gap-1 overflow-x-auto -mx-3 px-3 sm:mx-0 sm:px-0 border-b border-gray-200">
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setParams({ tab: k })} className={cn('shrink-0 px-3 py-2 text-sm border-b-2 -mb-px', tab === k ? 'border-[#0c2c55] text-[#0c2c55] font-medium' : 'border-transparent text-gray-500 hover:text-gray-800')}>{label}</button>
        ))}
      </nav>
      {tab === 'deposit' && <DepositTab canEdit={canEdit} />}
      {tab === 'register' && <RegisterTab />}
      {tab === 'challans' && <ChallansTab canEdit={canEdit} />}
      {tab === 'quarter' && <QuarterTab canEdit={canEdit} />}
      {tab === 'thresholds' && <ThresholdsTab />}
    </div>
  );
}
