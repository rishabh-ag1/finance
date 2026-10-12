import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation } from '@tanstack/react-query';
import api from '../api';
import { useAuth } from '../context/auth';
import { apiErrorMessage, cn, CARD_SHADOW } from '../lib/utils';

const schema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: z.string().min(10, 'At least 10 characters'),
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, { path: ['confirmPassword'], message: 'The two passwords differ' });

type FormValues = z.infer<typeof schema>;

export function AccountPage() {
  const { user } = useAuth();
  const { register, handleSubmit, reset, formState: { errors } } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const change = useMutation({
    mutationFn: (v: FormValues) => api.post('/auth/change-password', { currentPassword: v.currentPassword, newPassword: v.newPassword }),
    onSuccess: () => reset(),
  });

  const input = 'w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';

  return (
    <div className="max-w-lg mx-auto space-y-4">
      <div>
        <h1 className="font-instrument-serif text-3xl text-gray-900">Your account</h1>
        <p className="text-sm text-gray-500">{user?.firstName} {user?.lastName} · {user?.email}</p>
      </div>

      <form onSubmit={handleSubmit((v) => change.mutate(v))} className={cn('bg-white rounded-xl border border-gray-200 p-4 sm:p-6 space-y-4', CARD_SHADOW)}>
        <h2 className="font-semibold text-gray-900">Change password</h2>
        {change.isSuccess && <p className="text-sm text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2">Password changed.</p>}
        {change.isError && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{apiErrorMessage(change.error, 'Could not change the password')}</p>}

        <label className="block text-sm">
          <span className="text-gray-700">Current password</span>
          <input type="password" autoComplete="current-password" className={input} {...register('currentPassword')} />
          {errors.currentPassword && <span className="text-xs text-red-600">{errors.currentPassword.message}</span>}
        </label>
        <label className="block text-sm">
          <span className="text-gray-700">New password</span>
          <input type="password" autoComplete="new-password" className={input} {...register('newPassword')} />
          {errors.newPassword && <span className="text-xs text-red-600">{errors.newPassword.message}</span>}
        </label>
        <label className="block text-sm">
          <span className="text-gray-700">Repeat new password</span>
          <input type="password" autoComplete="new-password" className={input} {...register('confirmPassword')} />
          {errors.confirmPassword && <span className="text-xs text-red-600">{errors.confirmPassword.message}</span>}
        </label>

        <button type="submit" disabled={change.isPending} className="w-full sm:w-auto px-4 py-2.5 rounded-lg bg-[#0c2c55] text-white text-sm font-medium disabled:opacity-60">
          {change.isPending ? 'Saving…' : 'Change password'}
        </button>
      </form>
    </div>
  );
}
