import type { Tx } from '../lib/audit';
import { fyLabel } from '../lib/fy';
import { UserError } from '../lib/http';
import { formatDocNumber } from '../lib/numberSeries';

/**
 * BR-30: takes the next number of a series inside the issuing transaction. The series row is
 * locked (SELECT ... FOR UPDATE) so two people issuing at once get consecutive numbers, and the
 * number is only used if that transaction commits: no gaps, no reuse.
 * A per-FY series that has no row for the document's FY yet starts at 1 with the same pattern
 * (reset on 1 April).
 */
export async function takeNumber(tx: Tx, entityId: string, docType: string, docDate: string): Promise<string> {
  const fy = fyLabel(docDate);
  const latest = await tx.numberSeries.findFirst({ where: { entityId, docType }, orderBy: { createdAt: 'desc' } });
  if (!latest) throw new UserError(`There is no number series for ${docType}. Add it in Settings > Numbering.`);
  const perFy = latest.fyLabel !== null;
  const fyValue = perFy ? fy : null;

  let row = await tx.numberSeries.findFirst({ where: { entityId, docType, fyLabel: fyValue } });
  if (!row) {
    row = await tx.numberSeries.create({
      data: { entityId, docType, fyLabel: fyValue, pattern: latest.pattern, padding: latest.padding, isActive: latest.isActive, note: `Started for FY ${fy}` },
    });
  }
  const [locked] = await tx.$queryRaw<{ id: string; nextNumber: number; isActive: boolean; pattern: string; padding: number }[]>`
    select id, "nextNumber", "isActive", pattern, padding from finance."NumberSeries" where id = ${row.id} for update`;
  if (!locked.isActive) throw new UserError(`The ${docType.replace('_', ' ')} series is switched off in Settings > Numbering`);
  const number = formatDocNumber(locked.pattern, fyValue, locked.nextNumber, locked.padding);
  await tx.numberSeries.update({ where: { id: locked.id }, data: { nextNumber: locked.nextNumber + 1 } });
  return number;
}
