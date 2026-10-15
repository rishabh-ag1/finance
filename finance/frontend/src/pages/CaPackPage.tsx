import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import api from '../api';
import { Button, Card, Chip, ErrorNote, Field, PageHeader, TextInput } from '../components/ui/kit';
import { formatINR } from '../lib/money';
import { apiErrorMessage } from '../lib/utils';

type Summary = {
  month: string; from: string; to: string; counts: Record<string, number>; unreviewed: number; withoutFile: number;
  tie: { hsnTaxable: string; documentsTaxable: string; difference: string; ok: boolean };
  hsn: { hsn: string; rate: string; qty: string; taxable: string; cgst: string; sgst: string; igst: string; tax: string; total: string }[];
};
const LABEL: Record<string, string> = { bank: 'Bank transactions', bills: 'Vendor bills', invoices: 'Sales invoices', credits: 'Credit notes', receipts: 'Receipts', payments: 'Payments', tds: 'TDS deducted', funding: 'Funding' };
const lastMonth = () => { const d = new Date(Date.now() + 5.5 * 3600_000); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };

// F180 / F181 the monthly workbook for the CA (Tally user, Q16) and the GST working.
export function CaPackPage() {
  const [month, setMonth] = useState(lastMonth());
  const { data, isLoading, error } = useQuery({ queryKey: ['ca-pack', month], enabled: /^\d{4}-\d{2}$/.test(month), queryFn: async () => (await api.get<{ data: Summary }>('/ca-pack', { params: { month } })).data.data });
  const download = useMutation({
    mutationFn: async () => {
      const r = await api.get('/ca-pack/download', { params: { month }, responseType: 'blob' });
      const url = URL.createObjectURL(r.data as Blob);
      const a = document.createElement('a');
      a.href = url; a.download = `CA pack ${month}.xlsx`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    },
  });
  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <PageHeader title="CA pack" subtitle="One Excel workbook per month for the CA: bank rows with category, party, GST and TDS; bills; invoices; credit notes; receipts; payments; TDS; funding; and the GST working. Rows link to their files." />
      <Card className="p-4 flex flex-wrap items-end gap-3">
        <Field label="Month" className="w-44"><TextInput type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
        <Button disabled={download.isPending || !data} onClick={() => download.mutate()}><Download className="w-4 h-4 inline mr-1" />{download.isPending ? 'Preparing…' : 'Download workbook'}</Button>
      </Card>
      <ErrorNote>{(error && apiErrorMessage(error, 'Could not prepare the pack')) || (download.isError && apiErrorMessage(download.error, 'Download failed'))}</ErrorNote>
      {isLoading && <p className="text-sm text-gray-500">Preparing…</p>}
      {data && (
        <>
          {(data.unreviewed > 0 || data.withoutFile > 0) && (
            <Card className="p-3 text-sm text-amber-800 space-y-1">
              {data.unreviewed > 0 && <p>{data.unreviewed} bank row(s) of the month are not reviewed yet: categorise them before sending.</p>}
              {data.withoutFile > 0 && <p>{data.withoutFile} bill(s) or invoice(s) have no file attached.</p>}
            </Card>
          )}
          <Card className="p-4 space-y-2">
            <h2 className="font-semibold text-gray-900">Sheets</h2>
            <ul className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
              {Object.entries(data.counts).map(([k, n]) => <li key={k} className="rounded-lg bg-gray-50 px-3 py-2"><div className="text-xs text-gray-500">{LABEL[k] ?? k}</div><div className="font-semibold">{n}</div></li>)}
            </ul>
            <p className="text-xs text-gray-500">Also: TDS challans, GST outward B2B, GST outward B2C, HSN summary, GST inward (with gateway fees' GST), and a summary sheet.</p>
          </Card>
          <Card className="p-4 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-semibold text-gray-900">HSN summary</h2>
              <Chip tone={data.tie.ok ? 'green' : 'red'}>{data.tie.ok ? 'Ties to the invoices' : `Differs by ${formatINR(data.tie.difference)}`}</Chip>
            </div>
            {data.hsn.length === 0 ? <p className="text-sm text-gray-500">No invoices or credit notes this month.</p> : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs sm:text-sm">
                  <thead><tr className="text-left text-gray-500"><th className="py-1 pr-2">HSN</th><th className="pr-2">Rate</th><th className="text-right pr-2">Qty</th><th className="text-right pr-2">Taxable</th><th className="text-right pr-2">Tax</th><th className="text-right">Value</th></tr></thead>
                  <tbody className="divide-y divide-gray-100">
                    {data.hsn.map((h) => <tr key={`${h.hsn}-${h.rate}`}><td className="py-1 pr-2">{h.hsn}</td><td className="pr-2">{h.rate}%</td><td className="text-right pr-2">{h.qty}</td><td className="text-right num pr-2">{formatINR(h.taxable)}</td><td className="text-right num pr-2">{formatINR(h.tax)}</td><td className="text-right num">{formatINR(h.total)}</td></tr>)}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-xs text-gray-500">Invoices less credit notes: taxable {formatINR(data.tie.documentsTaxable)}. Information for the CA, not a GSTR file.</p>
          </Card>
        </>
      )}
    </div>
  );
}
