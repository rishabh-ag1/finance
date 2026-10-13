/**
 * BR-02 Narration parsing for IDFC FIRST Bank (parser format idfc_v1).
 * The narration is split on '/'; the first token gives the mode. Parsed fields are stored next to
 * the raw narration, which is never changed. Patterns seen in Entelechy's statements:
 *
 *   IMPS[-OPM]/<utr>/<name>/<ifsc>/<ref>/<remark>
 *   RTGS|NEFT/<utr>/<name>/<ifsc>/<remark...>
 *   IFT/<other account>/<name>/<ref>[/<remark>]          (IDFC to IDFC)
 *   OPT/CBDT/<challan ref>/<date>/<time>                 (tax payment)
 *   Ecom/<ref>/<gateway>/<merchant>/<remark>             (card / payment gateway)
 *   UPI/CR|DR/<utr>/<name>/<bank code>/<ref>/<remark>
 *   ATM/..., CHG/...                                     (cash, charges)
 *
 * Anything else comes back with parsed: false and goes to Review.
 */

export type ParsedNarration = {
  parsed: boolean;
  mode: string | null;
  modeDetail: string | null;
  utr: string | null;
  counterpartyName: string | null;
  counterpartyIfsc: string | null;
  counterpartyAccount: string | null;
  counterpartyBank: string | null;
  ref2: string | null;
  remark: string | null;
};

const EMPTY: ParsedNarration = {
  parsed: false, mode: null, modeDetail: null, utr: null, counterpartyName: null, counterpartyIfsc: null,
  counterpartyAccount: null, counterpartyBank: null, ref2: null, remark: null,
};

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;

const clean = (s: string | undefined): string | null => {
  const t = (s ?? '').trim();
  return t ? t : null;
};

/** Remaining tokens as one remark; empty tokens (from '//') are dropped. */
const restText = (tokens: string[]): string | null => clean(tokens.map((t) => t.trim()).filter(Boolean).join('/'));

/**
 * IDFC repeats the beneficiary name and truncates the copy: "MICRO INSTRUMENTS COMICRO INSTRUMENTS CO".
 * When the tail of the name (8+ characters) is a prefix of what comes before it, keep the first copy.
 */
export function dedupeRepeatedName(name: string): string {
  const s = name.trim();
  for (let k = 8; k <= s.length - 8; k++) {
    const head = s.slice(0, k);
    const tail = s.slice(k);
    if (head.startsWith(tail)) return head.trim();
  }
  return s;
}

const name = (s: string | undefined) => {
  const c = clean(s);
  return c ? dedupeRepeatedName(c) : null;
};

export function parseIdfcNarration(narration: string): ParsedNarration {
  const tokens = narration.split('/');
  const head = tokens[0].trim().toUpperCase();

  // IMPS and IMPS-OPM (outward payment)
  if (head === 'IMPS' || head.startsWith('IMPS-')) {
    const [, utr, party, ifsc, ref, ...rest] = tokens;
    if (!utr || !IFSC.test((ifsc ?? '').trim())) return { ...EMPTY };
    return {
      ...EMPTY, parsed: true, mode: 'IMPS', modeDetail: head.includes('-') ? head.split('-')[1] : null,
      utr: clean(utr), counterpartyName: name(party), counterpartyIfsc: clean(ifsc), ref2: clean(ref), remark: restText(rest),
    };
  }

  if (head === 'RTGS' || head === 'NEFT') {
    const [, utr, party, ifsc, ...rest] = tokens;
    if (!utr || !IFSC.test((ifsc ?? '').trim())) return { ...EMPTY };
    return { ...EMPTY, parsed: true, mode: head, utr: clean(utr), counterpartyName: name(party), counterpartyIfsc: clean(ifsc), remark: restText(rest) };
  }

  if (head === 'IFT') {
    const [, account, party, ref, ...rest] = tokens;
    if (!account || !party) return { ...EMPTY };
    return { ...EMPTY, parsed: true, mode: 'IFT', counterpartyAccount: clean(account), counterpartyName: name(party), utr: clean(ref), remark: restText(rest) };
  }

  if (head === 'OPT') {
    const [, authority, ref, ...rest] = tokens;
    return {
      ...EMPTY, parsed: true, mode: 'OPT', modeDetail: clean(authority), utr: clean(ref),
      counterpartyName: clean(authority), remark: clean(rest.map((t) => t.trim()).filter(Boolean).join(' ')),
    };
  }

  if (head === 'ECOM') {
    const [, ref, gateway, merchant, ...rest] = tokens;
    return { ...EMPTY, parsed: true, mode: 'ECOM', utr: clean(ref), modeDetail: clean(gateway), counterpartyName: name(merchant), remark: restText(rest) };
  }

  if (head === 'UPI') {
    const [, direction, utr, party, bank, ref, ...rest] = tokens;
    const bankToken = clean(bank);
    const bankIsIfsc = !!bankToken && IFSC.test(bankToken);
    return {
      ...EMPTY, parsed: true, mode: 'UPI', modeDetail: clean(direction), utr: clean(utr), counterpartyName: name(party),
      counterpartyIfsc: bankIsIfsc ? bankToken : null, counterpartyBank: bankIsIfsc ? null : bankToken, ref2: clean(ref), remark: restText(rest),
    };
  }

  if (head === 'ATM' || head === 'CHG') {
    return { ...EMPTY, parsed: true, mode: head, remark: restText(tokens.slice(1)) };
  }

  return { ...EMPTY };
}
