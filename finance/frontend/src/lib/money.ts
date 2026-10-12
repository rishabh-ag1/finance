/**
 * Money arrives from the API as text ("1136800.00") and is only formatted here, never added up
 * in the browser (CLAUDE.md: no JS number arithmetic on money).
 */

/** ₹11,36,800.00 - Indian grouping. Works on the text, so no float rounding. */
export function formatINR(value: string | null | undefined, opts: { decimals?: boolean } = {}): string {
  if (value === null || value === undefined || value === '') return '—';
  const negative = value.trim().startsWith('-');
  const [wholeRaw, fracRaw = ''] = value.replace(/[^0-9.]/g, '').split('.');
  const whole = wholeRaw.replace(/^0+(?=\d)/, '') || '0';
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const grouped = rest ? `${rest},${last3}` : last3;
  const frac = (fracRaw + '00').slice(0, 2);
  const showDecimals = opts.decimals ?? true;
  return `${negative ? '-' : ''}₹${grouped}${showDecimals ? `.${frac}` : ''}`;
}

/** "12" -> "12%" for rates sent as text. */
export function formatRate(value: string | null | undefined): string {
  return value === null || value === undefined ? '—' : `${value}%`;
}
