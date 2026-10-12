/**
 * BR-15 GSTIN, PAN and IFSC validation.
 * The GSTIN checksum and state codes are copied unchanged from Bloc's
 * crm/backend/src/services/gst.service.ts so both apps accept and reject the same numbers.
 */

const GSTIN_FORMAT_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const GSTIN_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/// GST state codes (GSTN spec), same table as Bloc's GST_STATE_CODES.
export const GST_STATE_CODES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '25': 'Daman and Diu', '26': 'Dadra and Nagar Haveli', '27': 'Maharashtra',
  '28': 'Andhra Pradesh (Old)', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep',
  '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
};

/** Public GSTN mod-36 check digit (Bloc's computeGstinCheckDigit). */
export function computeGstinCheckDigit(first14: string): string {
  let sum = 0;
  let factor = 1;
  for (let i = 0; i < 14; i++) {
    const code = GSTIN_CHARSET.indexOf(first14[i]!);
    const product = code * factor;
    sum += Math.floor(product / 36) + (product % 36);
    factor = factor === 1 ? 2 : 1;
  }
  const checksum = (36 - (sum % 36)) % 36;
  return GSTIN_CHARSET[checksum]!;
}

export type GstinChecksumResult =
  | { valid: true; normalized: string }
  | { valid: false; reason: string };

export function validateGstinChecksum(gstinRaw: string): GstinChecksumResult {
  const normalized = (gstinRaw || '').trim().toUpperCase();
  if (!GSTIN_FORMAT_REGEX.test(normalized)) {
    return { valid: false, reason: 'GSTIN must be 15 characters in the format 22AAAAA0000A1Z5' };
  }
  const expected = computeGstinCheckDigit(normalized.slice(0, 14));
  if (expected !== normalized[14]) {
    return { valid: false, reason: 'GSTIN checksum is invalid - check for a typo' };
  }
  if (!GST_STATE_CODES[normalized.slice(0, 2)]) {
    return { valid: false, reason: `GSTIN state code ${normalized.slice(0, 2)} does not exist` };
  }
  return { valid: true, normalized };
}

export type GstinParts = { stateCode: string; stateName: string; pan: string };

/** State and PAN read from a valid GSTIN: characters 1-2 and 3-12 (BR-15). */
export function gstinParts(gstinRaw: string): GstinParts {
  const result = validateGstinChecksum(gstinRaw);
  if (!result.valid) throw new Error(result.reason);
  const g = result.normalized;
  return { stateCode: g.slice(0, 2), stateName: GST_STATE_CODES[g.slice(0, 2)]!, pan: g.slice(2, 12) };
}

export function isValidPan(pan: string): boolean {
  return PAN_REGEX.test((pan || '').trim().toUpperCase());
}

export function isValidIfsc(ifsc: string): boolean {
  return IFSC_REGEX.test((ifsc || '').trim().toUpperCase());
}
