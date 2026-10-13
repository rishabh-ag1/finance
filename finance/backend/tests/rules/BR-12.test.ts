import { describe, expect, it } from 'vitest';
import { deducteeTypeFromPan, rateColumn } from '../../src/lib/deductee';
import { gstinParts } from '../../src/lib/gstin';

// BR-12 TDS rate and thresholds - the deductee-type part (rates themselves are Phase 2).
// Worked example: Saiffi Industries GSTIN 06ANJPA3053F1ZI gives PAN ANJPA3053F, 4th character
// P = individual (proprietorship). Also acceptance check A10.
describe('BR-12 deductee type from PAN', () => {
  it('reads Saiffi as an individual (proprietor) from its GSTIN', () => {
    const { pan } = gstinParts('06ANJPA3053F1ZI');
    expect(pan).toBe('ANJPA3053F');
    expect(deducteeTypeFromPan(pan)).toBe('individual');
    expect(rateColumn('individual')).toBe('individual');
  });

  it('maps H to HUF (individual rate), C to company, F to firm, others to others', () => {
    expect(deducteeTypeFromPan('AAAHA1234A')).toBe('huf');
    expect(rateColumn('huf')).toBe('individual');
    expect(deducteeTypeFromPan('AAGCV6571J')).toBe('company'); // BR-15 example
    expect(deducteeTypeFromPan('AAJCE7255M')).toBe('company'); // Entelechy
    expect(deducteeTypeFromPan('AAAFA1234A')).toBe('firm');
    expect(deducteeTypeFromPan('AAATA1234A')).toBe('others');
    expect(rateColumn('company')).toBe('others');
  });

  it('treats a missing or malformed PAN as no PAN (higher rate)', () => {
    expect(deducteeTypeFromPan(null)).toBe('unknown');
    expect(deducteeTypeFromPan('ANJPA3053')).toBe('unknown');
    expect(rateColumn('unknown')).toBe('no_pan');
  });
});
