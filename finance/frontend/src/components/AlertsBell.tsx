import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import api from '../api';
import { cn } from '../lib/utils';

type Alert = { key: string; tone: 'red' | 'amber' | 'blue'; text: string; to: string };
const DOT = { red: 'bg-red-500', amber: 'bg-amber-500', blue: 'bg-blue-500' };

/** F173 in-app alerts: a bell with a count; the list opens under it. Refreshed every 5 minutes. */
export function AlertsBell() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const { data } = useQuery({ queryKey: ['alerts'], refetchInterval: 5 * 60_000, queryFn: async () => (await api.get<{ data: Alert[] }>('/alerts')).data.data });
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const n = data?.length ?? 0;
  const urgent = data?.some((a) => a.tone === 'red');
  return (
    <div className="relative" ref={box}>
      <button onClick={() => setOpen(!open)} className="relative p-1.5 text-white/80 hover:text-white" title="Alerts" aria-label={`Alerts: ${n}`}>
        <Bell className="w-5 h-5" />
        {n > 0 && <span className={cn('absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full text-[10px] leading-4 text-white text-center', urgent ? 'bg-red-600' : 'bg-amber-500')}>{n > 99 ? '99+' : n}</span>}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-[min(22rem,calc(100vw-1.5rem))] max-h-[70vh] overflow-y-auto rounded-lg bg-white shadow-lg border border-gray-200 z-50">
          {n === 0 ? <p className="p-4 text-sm text-gray-500">Nothing needs you right now.</p> : (
            <ul className="divide-y divide-gray-100">
              {data!.map((a) => (
                <li key={a.key}>
                  <Link to={a.to} onClick={() => setOpen(false)} className="flex gap-2 px-3 py-2.5 text-sm text-gray-800 hover:bg-gray-50">
                    <span className={cn('mt-1.5 w-2 h-2 rounded-full shrink-0', DOT[a.tone])} />
                    <span>{a.text}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
