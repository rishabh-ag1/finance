import { Link } from 'react-router';
import { useAuth } from '../context/auth';
import { cn, CARD_SHADOW } from '../lib/utils';

// Placeholder until milestone M7 (F130 home dashboard: cash, burn, runway, review queue).
const MILESTONES = [
  { id: 'M0', title: 'Sign-in and audit log', done: true },
  { id: 'M1', title: 'Settings and categories', done: true },
  { id: 'M2', title: 'Bank statement import', done: true },
  { id: 'M3', title: 'Ledger and review queue', done: true },
  { id: 'M4', title: 'Vendors', done: true },
  { id: 'M5', title: 'Documents vault', done: true },
  { id: 'M6', title: 'Master Ledger migration: dropped, you categorise in the app', done: true },
  { id: 'M7', title: 'Home dashboard', done: false },
];

export function HomePage() {
  const { user } = useAuth();
  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div>
        <h1 className="font-instrument-serif text-3xl text-gray-900">Hello, {user?.firstName}</h1>
        <p className="text-sm text-gray-500">Cash, burn and runway will appear here. For now, this is how far Phase 1 has come.</p>
      </div>
      <ol className={cn('bg-white rounded-xl border border-gray-200 divide-y divide-gray-100', CARD_SHADOW)}>
        {MILESTONES.map((m) => (
          <li key={m.id} className="flex items-center gap-3 px-4 py-3 text-sm">
            <span className={cn('w-2.5 h-2.5 rounded-full shrink-0', m.done ? 'bg-emerald-500' : 'bg-gray-200')} />
            <span className="font-mono text-xs text-gray-400 w-6">{m.id}</span>
            <span className={m.done ? 'text-gray-900' : 'text-gray-400'}>{m.title}</span>
          </li>
        ))}
      </ol>
      <p className="text-sm text-gray-500">
        Every change you make is recorded in the <Link to="/audit" className="text-blue-700 underline">audit log</Link>.
      </p>
    </div>
  );
}
