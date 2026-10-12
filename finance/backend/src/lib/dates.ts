import { UserError } from './http';
/**
 * Business dates (@db.Date) travel as "YYYY-MM-DD" text. Prisma stores and returns them as
 * Dates at UTC midnight; these helpers convert both ways without time-zone drift.
 */

const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/;

export function parseDate(text: string, field = 'Date'): Date {
  if (!DATE_TEXT.test(text)) throw new UserError(`${field} must be YYYY-MM-DD`);
  const d = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== text) throw new UserError(`${field} is not a real date: ${text}`);
  return d;
}

export function parseOptionalDate(text: string | null | undefined, field = 'Date'): Date | null {
  return text ? parseDate(text, field) : null;
}

export function dateText(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}
