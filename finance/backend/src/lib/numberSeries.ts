/**
 * BR-30 Document numbering - formats and checks. Numbers are only assigned when a document is
 * issued, inside the issuing transaction (Phase 2/3); this file is the shared formatting part.
 * A series pattern uses {FY} for the FY label and {N} for the zero-padded number:
 *   tax invoice "ELPL/{FY}/{N}" padding 5 -> ELPL/26-27/00001
 */

export const STRICT_DOC_TYPES = ['tax_invoice', 'credit_note'] as const;
const STRICT_MAX_LENGTH = 16;
const STRICT_CHARS = /^[A-Za-z0-9/-]+$/;

export function formatDocNumber(pattern: string, fyLabel: string | null, n: number, padding: number): string {
  if (!Number.isInteger(n) || n < 1) throw new Error('Document number must be a whole number from 1');
  if (pattern.includes('{FY}') && !fyLabel) throw new Error(`Series ${pattern} needs an FY label`);
  return pattern.replace('{FY}', fyLabel ?? '').replace('{N}', String(n).padStart(padding, '0'));
}

/** Plain-English problem with a document number, or null when it is fine. */
export function docNumberProblem(docType: string, number: string): string | null {
  if (!(STRICT_DOC_TYPES as readonly string[]).includes(docType)) return null;
  if (number.length > STRICT_MAX_LENGTH) return `${number} is ${number.length} characters; GST allows at most ${STRICT_MAX_LENGTH}`;
  if (!STRICT_CHARS.test(number)) return `${number} may only contain letters, digits, '/' and '-'`;
  return null;
}

/**
 * Checks a series setup before it is saved: the pattern has {N}, and the longest number the
 * series can produce this FY still passes docNumberProblem.
 */
export function seriesProblem(s: { docType: string; pattern: string; padding: number; fyLabel: string | null }): string | null {
  if (!s.pattern.includes('{N}')) return 'The pattern needs {N} where the number goes';
  if (s.padding < 1 || s.padding > 8) return 'Padding must be between 1 and 8 digits';
  const longest = formatDocNumber(s.pattern, s.fyLabel ?? '00-00', 10 ** s.padding - 1, s.padding);
  return docNumberProblem(s.docType, longest);
}
