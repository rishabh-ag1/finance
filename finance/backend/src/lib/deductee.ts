import type { DeducteeType } from '@prisma/client';

/**
 * BR-12 Deductee type from the PAN's 4th character: P individual, H HUF use the individual rate;
 * C company, F firm, and the rest (A, B, T, L, J, G...) use the "others" rate. No PAN on file
 * means the higher no-PAN rate applies (Phase 2 TDS); that vendor is "unknown".
 */
export function deducteeTypeFromPan(pan: string | null | undefined): DeducteeType {
  const p = (pan ?? '').trim().toUpperCase();
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(p)) return 'unknown';
  switch (p[3]) {
    case 'P': return 'individual';
    case 'H': return 'huf';
    case 'C': return 'company';
    case 'F': return 'firm';
    default: return 'others';
  }
}

/** Which TDS rate column applies (BR-12). */
export function rateColumn(t: DeducteeType): 'individual' | 'others' | 'no_pan' {
  if (t === 'unknown') return 'no_pan';
  return t === 'individual' || t === 'huf' ? 'individual' : 'others';
}

export const DEDUCTEE_LABEL: Record<DeducteeType, string> = {
  individual: 'Individual / proprietor',
  huf: 'HUF',
  company: 'Company',
  firm: 'Firm / LLP',
  others: 'Others (trust, AOP, govt...)',
  unknown: 'No PAN on file',
};
