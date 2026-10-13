import { useSearchParams } from 'react-router';
import { PageHeader } from '../../components/ui/kit';
import { cn } from '../../lib/utils';
import { CompanyTab } from './CompanyTab';
import { BankAccountsTab } from './BankAccountsTab';
import { TaxTab } from './TaxTab';
import { SeriesTab } from './SeriesTab';
import { TermsTab } from './TermsTab';
import { PeriodLockTab } from './PeriodLockTab';
import { PurchasingTab } from './PurchasingTab';

const TABS = [
  { key: 'company', label: 'Company & FY', body: CompanyTab },
  { key: 'banks', label: 'Bank accounts', body: BankAccountsTab },
  { key: 'tax', label: 'GST & TDS', body: TaxTab },
  { key: 'series', label: 'Numbering', body: SeriesTab },
  { key: 'terms', label: 'Terms & approvals', body: TermsTab },
  { key: 'purchasing', label: 'Purchasing', body: PurchasingTab },
  { key: 'locks', label: 'Period lock', body: PeriodLockTab },
] as const;

// M01 Settings & Masters (F001-F009).
export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const active = TABS.find((t) => t.key === params.get('tab')) ?? TABS[0];
  const Body = active.body;
  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <PageHeader title="Settings" subtitle="Company, bank accounts, tax masters, numbering, terms and month locks. Every change is in the audit log." />
      <nav className="flex gap-1 overflow-x-auto overflow-y-hidden -mx-3 px-3 sm:mx-0 sm:px-0 border-b border-gray-200">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setParams({ tab: t.key })}
            className={cn('shrink-0 px-3 py-2 text-sm border-b-2 -mb-px', t.key === active.key ? 'border-[#0c2c55] text-[#0c2c55] font-medium' : 'border-transparent text-gray-500 hover:text-gray-800')}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <Body />
    </div>
  );
}
