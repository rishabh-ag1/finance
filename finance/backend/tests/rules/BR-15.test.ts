import { describe, expect, it } from 'vitest';
import { gstinParts, isValidIfsc, isValidPan, validateGstinChecksum } from '../../src/lib/gstin';

// BR-15 GSTIN and PAN validation. Worked example: 06AAGCV6571J1ZW: state 06 (Haryana),
// PAN AAGCV6571J (C = company). Also acceptance check A10's GSTIN and Entelechy's own.
describe('BR-15 GSTIN, PAN, IFSC', () => {
  it('reads state 06 Haryana and PAN AAGCV6571J from 06AAGCV6571J1ZW', () => {
    expect(gstinParts('06AAGCV6571J1ZW')).toEqual({ stateCode: '06', stateName: 'Haryana', pan: 'AAGCV6571J' });
  });

  it('reads PAN ANJPA3053F and Haryana from Saiffi\'s GSTIN 06ANJPA3053F1ZI (A10)', () => {
    expect(gstinParts('06anjpa3053f1zi')).toEqual({ stateCode: '06', stateName: 'Haryana', pan: 'ANJPA3053F' });
  });

  it('accepts Entelechy\'s own GSTIN 29AAJCE7255M1ZX (Karnataka)', () => {
    expect(validateGstinChecksum('29AAJCE7255M1ZX')).toEqual({ valid: true, normalized: '29AAJCE7255M1ZX' });
  });

  it('rejects a typo through the checksum', () => {
    const r = validateGstinChecksum('06AAGCV6571J1ZX');
    expect(r.valid).toBe(false);
  });

  it('rejects wrong shapes', () => {
    expect(validateGstinChecksum('06AAGCV6571J1Z').valid).toBe(false);
    expect(validateGstinChecksum('99AAGCV6571J1ZW').valid).toBe(false);
  });

  it('checks PAN (5 letters, 4 digits, 1 letter) and IFSC (4 letters, 0, 6 alphanumeric)', () => {
    expect(isValidPan('AAJCE7255M')).toBe(true);
    expect(isValidPan('AAJCE7255')).toBe(false);
    expect(isValidIfsc('IDFB0080152')).toBe(true);
    expect(isValidIfsc('IDFB1080152')).toBe(false);
  });
});
