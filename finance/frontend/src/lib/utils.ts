import axios from 'axios';
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Combine Tailwind classes; tailwind-merge resolves conflicts. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Shared elevated-card shadow: a tight contact shadow plus a soft wide blur. */
export const CARD_SHADOW =
  'shadow-[0_1px_2px_rgba(15,23,42,0.05),0_12px_28px_-10px_rgba(15,23,42,0.16)]';

/** The API's `{ error }` message for a failed request, else the error's own message. */
export function apiErrorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const apiError = (err.response?.data as { error?: unknown } | undefined)?.error;
    if (typeof apiError === 'string' && apiError) return apiError;
  }
  return err instanceof Error && err.message ? err.message : fallback;
}
