import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { X } from 'lucide-react';
import { cn, CARD_SHADOW } from '../../lib/utils';

/** Small shared building blocks so every finance page looks the same. */

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-instrument-serif text-3xl text-gray-900">{title}</h1>
        {subtitle && <p className="text-sm text-gray-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('bg-white rounded-xl border border-gray-200', CARD_SHADOW, className)}>{children}</div>;
}

export function Button({ variant = 'primary', className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost' }) {
  const styles = {
    primary: 'bg-[#0c2c55] text-white hover:bg-[#0e3261]',
    secondary: 'bg-white border border-gray-200 text-gray-800 hover:bg-gray-50',
    danger: 'bg-white border border-red-200 text-red-700 hover:bg-red-50',
    ghost: 'text-blue-700 hover:bg-blue-50',
  }[variant];
  return <button type="button" className={cn('px-3.5 py-2 rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed', styles, className)} {...props} />;
}

const inputClass = 'w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-500';

export function Field({ label, hint, error, children, className }: { label: string; hint?: ReactNode; error?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn('block text-sm', className)}>
      <span className="block text-gray-700 mb-1">{label}</span>
      {children}
      {hint && !error && <span className="block text-xs text-gray-400 mt-1">{hint}</span>}
      {error && <span className="block text-xs text-red-600 mt-1">{error}</span>}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(inputClass, props.className)} />;
}

/** Text field for money: keeps what was typed as text and shows the numeric keypad on phones. */
export function MoneyInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input inputMode="decimal" placeholder="0.00" {...props} className={cn(inputClass, 'num', props.className)} />;
}

export function Select({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cn(inputClass, props.className)}>{children}</select>;
}

export function Chip({ tone = 'gray', children }: { tone?: 'gray' | 'green' | 'amber' | 'red' | 'blue'; children: ReactNode }) {
  const styles = {
    gray: 'bg-gray-100 text-gray-700',
    green: 'bg-emerald-50 text-emerald-700',
    amber: 'bg-amber-50 text-amber-800',
    red: 'bg-red-50 text-red-700',
    blue: 'bg-blue-50 text-blue-700',
  }[tone];
  return <span className={cn('inline-block rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', styles)}>{children}</span>;
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p role="alert" className="text-sm text-red-700 bg-red-50 rounded-lg px-3 py-2">{children}</p>;
}

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/40 p-0 sm:p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label={title}
        className="w-full sm:max-w-lg max-h-[92vh] overflow-y-auto bg-white rounded-t-2xl sm:rounded-2xl shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 sm:px-6 py-3 border-b border-gray-100 sticky top-0 bg-white">
          <h2 className="font-semibold text-gray-900">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-gray-700"><X className="w-5 h-5" /></button>
        </div>
        <div className="px-4 sm:px-6 py-4 space-y-4">{children}</div>
        {footer && <div className="px-4 sm:px-6 py-3 border-t border-gray-100 flex justify-end gap-2 sticky bottom-0 bg-white">{footer}</div>}
      </div>
    </div>
  );
}

/** Lines up label/value pairs; wraps to one column on phones. */
export function Facts({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
      {items.map((i) => (
        <div key={i.label} className="min-w-0">
          <dt className="text-gray-500">{i.label}</dt>
          <dd className="text-gray-900 break-words">{i.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
