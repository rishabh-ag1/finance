import { formatInTimeZone } from 'date-fns-tz';

/** Display time zone for audit timestamps (CLAUDE.md: display in IST). Same as Bloc's BUSINESS_TZ. */
export const BUSINESS_TZ = 'Asia/Kolkata';

/** 12 Oct 2026, 14:05 (IST) */
export function formatDateTime(value: string | Date): string {
  return formatInTimeZone(new Date(value), BUSINESS_TZ, 'd MMM yyyy, HH:mm');
}

/** A JSON value from the audit log as short readable text. */
export function formatAuditValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
