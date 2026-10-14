import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { Banknote, ChartColumn, Percent, ClipboardList, FileText, History, House, Landmark, ListChecks, LogOut, PanelLeftClose, PanelLeftOpen, ReceiptText, Settings, Tags, Truck, Upload, UserRound, Wand2, type LucideIcon, CalendarRange, WalletCards, ArrowRightLeft } from 'lucide-react';
import { useAuth } from '../context/auth';
import { cn } from '../lib/utils';
import { useReviewCount } from '../pages/bank/ledgerApi';
import { useDiscrepancyCount } from '../pages/orders/api';

const SIDEBAR_STORAGE_KEY = 'bloc-finance:sidebar-expanded';

type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  module: string;
  /** Not built yet: shown greyed out so the founders can see what is coming. */
  soon?: boolean;
  /** Shows a count next to the label. */
  badge?: 'review' | 'discrepancies';
};

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Home', icon: House, module: 'financeHome' },
  { to: '/analytics', label: 'Category analytics', icon: ChartColumn, module: 'financeHome' },
  { to: '/forecast', label: 'Cash forecast', icon: CalendarRange, module: 'financeHome' },
  { to: '/import', label: 'Import statement', icon: Upload, module: 'financeBank' },
  { to: '/ledger', label: 'Bank ledger', icon: Landmark, module: 'financeBank' },
  { to: '/review', label: 'Review queue', icon: ListChecks, module: 'financeBank', badge: 'review' },
  { to: '/rules', label: 'Rules', icon: Wand2, module: 'financeRules' },
  { to: '/vendors', label: 'Vendors', icon: Truck, module: 'financeVendors' },
  { to: '/purchase-orders', label: 'Purchase orders', icon: ClipboardList, module: 'financePurchases' },
  { to: '/bills', label: 'Vendor bills', icon: ReceiptText, module: 'financeBills' },
  { to: '/payables', label: 'Payables', icon: Banknote, module: 'financePayments' },
  { to: '/tds', label: 'TDS', icon: Percent, module: 'financeTds' },
  { to: '/claims', label: 'Founder claims', icon: WalletCards, module: 'financeClaims' },
  { to: '/order-to-bank', label: 'Order-to-bank', icon: ArrowRightLeft, module: 'financeOrders', badge: 'discrepancies' },
  { to: '/documents', label: 'Documents', icon: FileText, module: 'financeDocuments' },
  { to: '/categories', label: 'Categories', icon: Tags, module: 'financeSettings' },
  { to: '/settings', label: 'Settings', icon: Settings, module: 'financeSettings' },
  { to: '/audit', label: 'Audit log', icon: History, module: 'financeAudit' },
];

export function AppLayout() {
  const { user, logout, hasPermission } = useAuth();
  const navigate = useNavigate();
  // On a phone the sidebar starts as icons only so the page keeps its width; the saved choice is the desktop one.
  const isNarrow = () => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 767px)').matches;
  const [expanded, setExpanded] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    if (isNarrow()) return false;
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) !== 'false';
  });

  useEffect(() => {
    if (typeof window === 'undefined' || isNarrow()) return;
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, expanded ? 'true' : 'false');
  }, [expanded]);

  const { data: reviewCount } = useReviewCount();
  // F199: open order-to-bank mismatches as a badge (the daily e-mail digest waits for a mail account, D13).
  const { data: discrepancyCount } = useDiscrepancyCount(hasPermission('financeOrders', 'view'));
  const items = NAV_ITEMS.filter((item) => hasPermission(item.module, 'view'));

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="crm-shell min-h-screen flex flex-col">
      <header className="h-14 flex items-center px-3 sm:px-8 shrink-0 bg-[#0c2c55]">
        <div className="flex items-center justify-between w-full gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <img src="/bloc-logo.jpg" alt="Bloc" className="h-10 w-auto object-contain" />
            <span className="font-instrument-serif text-xl text-white/90 truncate">Finance</span>
          </div>

          <div className="flex items-center gap-3 sm:gap-4">
            {user && (
              <NavLink to="/account" className="flex items-center gap-2" title="Your account">
                <div className="w-7 h-7 rounded-full bg-white/20 flex items-center justify-center text-white text-xs font-semibold">
                  {user.firstName[0]}{user.lastName[0]}
                </div>
                <div className="text-right hidden sm:block">
                  <p className="text-sm font-medium text-white leading-tight">{user.firstName} {user.lastName}</p>
                  <p className="text-xs text-white/60 leading-tight">
                    {user.role?.name ? user.role.name.replace(/_/g, ' ') : 'No role'}
                  </p>
                </div>
              </NavLink>
            )}
            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 text-sm text-white/70 hover:text-white transition-colors"
              title="Sign out"
            >
              <LogOut className="w-4 h-4" />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        <aside className={cn('bg-white border-r border-gray-200 shrink-0 transition-[width] duration-200', expanded ? 'w-[220px]' : 'w-14')}>
          <nav className="py-4">
            <div className={cn('pb-3', expanded ? 'px-3' : 'px-2')}>
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className={cn('w-full h-8 inline-flex items-center text-gray-500 hover:bg-gray-50 rounded-md', expanded ? 'justify-start px-3' : 'justify-center')}
                title={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
                aria-label={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
              >
                {expanded ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
              </button>
            </div>
            {items.map(({ to, label, icon: Icon, soon, badge }) =>
              soon ? (
                <span
                  key={to}
                  title={expanded ? 'Coming in a later milestone' : `${label} (coming soon)`}
                  className={cn('flex items-center gap-3 py-2.5 text-sm text-gray-300 cursor-not-allowed', expanded ? 'px-6' : 'justify-center')}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {expanded && <span className="truncate">{label}</span>}
                  {expanded && <span className="ml-auto text-[10px] uppercase tracking-wide">soon</span>}
                </span>
              ) : (
                <NavLink
                  key={to}
                  to={to}
                  end={to === '/'}
                  title={!expanded ? label : undefined}
                  className={({ isActive }) => cn(
                    'flex items-center gap-3 py-2.5 text-sm transition-colors',
                    expanded ? 'px-6' : 'justify-center',
                    isActive ? 'text-blue-700 bg-blue-50/80 font-medium border-l-[3px] border-[#3B82F6]' : 'text-gray-700 hover:bg-gray-50/90',
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {expanded && <span className="truncate">{label}</span>}
                  {badge === 'discrepancies' && !!discrepancyCount && (
                    <span title={`${discrepancyCount} open mismatches`} className={cn('rounded-full bg-red-500 px-1.5 text-[10.5px] font-bold leading-[16px] text-white', expanded ? 'ml-auto' : '-ml-2')}>
                      {discrepancyCount}
                    </span>
                  )}
                  {badge === 'review' && !!reviewCount && (
                    <span title={`${reviewCount} to review`} className={cn('rounded-full bg-amber-500 px-1.5 text-[10.5px] font-bold leading-[16px] text-white', expanded ? 'ml-auto' : '-ml-2')}>
                      {reviewCount}
                    </span>
                  )}
                </NavLink>
              )
            )}
            <NavLink
              to="/account"
              title={!expanded ? 'Your account' : undefined}
              className={({ isActive }) => cn(
                'mt-4 flex items-center gap-3 py-2.5 text-sm border-t border-gray-100',
                expanded ? 'px-6' : 'justify-center',
                isActive ? 'text-blue-700 font-medium' : 'text-gray-500 hover:bg-gray-50/90',
              )}
            >
              <UserRound className="h-4 w-4 shrink-0" />
              {expanded && <span className="truncate">Your account</span>}
            </NavLink>
          </nav>
        </aside>

        <main className="flex-1 min-w-0 overflow-x-hidden overflow-y-auto bg-gray-50 p-3 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
