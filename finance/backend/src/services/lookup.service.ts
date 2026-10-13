import { prisma } from '../config/database';
import { withAudit, type AuditContext } from '../lib/audit';
import { GST_STATE_CODES, isValidIfsc, validateGstinChecksum } from '../lib/gstin';
import { UserError } from '../lib/http';

/**
 * Outside lookups used when entering vendors (and customers later):
 *  - GSTIN (I11): gstinapi.in, same provider and key (GSTINAPI_KEY) as the Bloc CRM, cached in
 *    GstinLookup so the 100 free lookups a month are not spent twice. Fails soft: a failure to
 *    check never blocks a save; the offline checksum always runs.
 *  - IFSC (I13): Razorpay's free IFSC API.
 *  - PIN code (I12): India Post, same as the CRM.
 */

const TIMEOUT_MS = 8000;

async function getJson(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json', ...headers } });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export type GstinLookupResult = {
  gstin: string;
  status: 'ACTIVE' | 'INACTIVE' | 'CANCELLED' | 'NOT_FOUND' | 'UNKNOWN';
  legalName: string | null;
  tradeName: string | null;
  address: string | null;
  stateCode: string;
  stateName: string;
  pincode: string | null;
  cached: boolean;
};

export type GstinLookupOutcome = { ok: true; result: GstinLookupResult } | { ok: false; message: string };

function mapStatus(raw: string | null | undefined): GstinLookupResult['status'] {
  const s = (raw || '').toLowerCase();
  if (s.includes('cancel')) return 'CANCELLED';
  if (s.includes('inactive') || s.includes('suspend')) return 'INACTIVE';
  if (s.includes('active')) return 'ACTIVE';
  return 'UNKNOWN';
}

type GstinApiBody = {
  data?: { legal_name?: string | null; trade_name?: string | null; status?: string | null; address?: string | null; pincode?: string | null; state_code?: string | null };
  error?: string;
};

export async function lookupGstin(ctx: AuditContext, gstinRaw: string, forceRefresh = false): Promise<GstinLookupOutcome> {
  const check = validateGstinChecksum(gstinRaw);
  if (!check.valid) throw new UserError(check.reason);
  const gstin = check.normalized;
  const stateCode = gstin.slice(0, 2);
  const stateName = GST_STATE_CODES[stateCode]!;

  if (!forceRefresh) {
    const cached = await prisma.gstinLookup.findUnique({ where: { gstin } });
    if (cached) {
      return { ok: true, result: { gstin, status: cached.status as GstinLookupResult['status'], legalName: cached.legalName, tradeName: cached.tradeName, address: cached.address, stateCode, stateName, pincode: cached.pincode, cached: true } };
    }
  }

  const key = process.env.GSTINAPI_KEY;
  if (!key) return { ok: false, message: 'GSTIN lookup is not set up (GSTINAPI_KEY in backend .env). Enter the details by hand; the GSTIN checksum, PAN and state are still checked.' };

  let result: GstinLookupResult;
  try {
    const { status, body } = await getJson(`https://www.gstinapi.in/v1/gstin/${gstin}`, { 'x-api-key': key });
    if (status === 404) {
      result = { gstin, status: 'NOT_FOUND', legalName: null, tradeName: null, address: null, stateCode, stateName, pincode: null, cached: false };
    } else if (status !== 200) {
      return { ok: false, message: (body as GstinApiBody | null)?.error || `GSTIN service answered ${status}; try again later or enter the details by hand.` };
    } else {
      const d = (body as GstinApiBody).data ?? {};
      result = { gstin, status: mapStatus(d.status), legalName: d.legal_name || null, tradeName: d.trade_name || null, address: d.address || null, stateCode, stateName, pincode: d.pincode || null, cached: false };
    }
  } catch (e) {
    return { ok: false, message: `Could not reach the GSTIN service (${(e as Error).message}). Enter the details by hand.` };
  }

  await withAudit({ ...ctx, reason: 'GSTIN lookup' }, (tx) => tx.gstinLookup.upsert({
    where: { gstin },
    update: { status: result.status, legalName: result.legalName, tradeName: result.tradeName, address: result.address, stateCode, pincode: result.pincode, fetchedAt: new Date() },
    create: { gstin, status: result.status, legalName: result.legalName, tradeName: result.tradeName, address: result.address, stateCode, pincode: result.pincode },
  }));
  return { ok: true, result };
}

export async function lookupIfsc(ifscRaw: string): Promise<{ ok: true; bank: string; branch: string; city: string | null } | { ok: false; message: string }> {
  const ifsc = ifscRaw.trim().toUpperCase();
  if (!isValidIfsc(ifsc)) throw new UserError('IFSC must be 4 letters, then 0, then 6 letters or digits');
  try {
    const { status, body } = await getJson(`https://ifsc.razorpay.com/${ifsc}`);
    if (status === 404) return { ok: false, message: 'No bank branch has this IFSC. Check it on the cancelled cheque.' };
    if (status !== 200) return { ok: false, message: `IFSC service answered ${status}` };
    const b = body as { BANK?: string; BRANCH?: string; CITY?: string };
    return { ok: true, bank: b.BANK ?? '', branch: b.BRANCH ?? '', city: b.CITY ?? null };
  } catch (e) {
    return { ok: false, message: `Could not reach the IFSC service (${(e as Error).message})` };
  }
}

export async function lookupPincode(pinRaw: string): Promise<{ ok: true; city: string; state: string } | { ok: false; message: string }> {
  const pin = pinRaw.replace(/\D/g, '');
  if (!/^[1-9][0-9]{5}$/.test(pin)) throw new UserError('PIN code must be 6 digits and cannot start with 0');
  try {
    const { status, body } = await getJson(`https://api.postalpincode.in/pincode/${pin}`);
    const first = Array.isArray(body) ? (body[0] as { Status?: string; PostOffice?: { District?: string; Division?: string; Name?: string; State?: string }[] }) : null;
    const office = first?.Status === 'Success' ? first.PostOffice?.[0] : undefined;
    if (status !== 200 || !office?.State) return { ok: false, message: 'No location found for this PIN code' };
    return { ok: true, city: office.District || office.Division || office.Name || '', state: office.State };
  } catch (e) {
    return { ok: false, message: `Could not reach the PIN code service (${(e as Error).message})` };
  }
}
