import { Decimal } from './money';

/** BR-27: what each founder is owed. Approved (and reimbursed) claims minus reimbursements paid. */
export function founderBalances(
  claims: { founderId: string; amount: Decimal; status: string }[],
  reimbursements: { founderId: string; amount: Decimal }[],
) {
  const out: Record<string, { claimed: string; reimbursed: string; owed: string; waiting: string }> = {};
  const ids = new Set([...claims.map((c) => c.founderId), ...reimbursements.map((r) => r.founderId)]);
  for (const id of ids) {
    const sum = (rows: { amount: Decimal }[]) => rows.reduce((s, r) => s.plus(r.amount), new Decimal(0));
    const claimed = sum(claims.filter((c) => c.founderId === id && (c.status === 'approved' || c.status === 'reimbursed')));
    const waiting = sum(claims.filter((c) => c.founderId === id && c.status === 'submitted'));
    const reimbursed = sum(reimbursements.filter((r) => r.founderId === id));
    out[id] = { claimed: claimed.toFixed(2), reimbursed: reimbursed.toFixed(2), owed: claimed.minus(reimbursed).toFixed(2), waiting: waiting.toFixed(2) };
  }
  return out;
}
