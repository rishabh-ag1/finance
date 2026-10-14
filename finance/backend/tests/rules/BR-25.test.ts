import { describe, expect, it } from 'vitest';
import { msmeAlert } from '../../src/lib/payables';

// BR-25 MSME payment alert: for Micro and Small vendors the payment period is the agreed terms,
// capped at 45 days from acceptance. Alert at day 30 and day 40.
describe('BR-25 MSME 45-day limit', () => {
  const bill = { msmeType: 'micro' as const, acceptedOn: '2026-09-01', dueDate: '2026-10-31' };
  it('the limit is 45 days from acceptance even when the agreed terms are longer', () => {
    expect(msmeAlert(bill, '2026-09-15')).toMatchObject({ level: 'none', limitDate: '2026-10-16', daysSinceAcceptance: 14 });
  });
  it('warns at day 30 and day 40, then shows the breach', () => {
    expect(msmeAlert(bill, '2026-10-01').level).toBe('day30');
    expect(msmeAlert(bill, '2026-10-11').level).toBe('day40');
    expect(msmeAlert(bill, '2026-10-17').level).toBe('breached');
  });
  it('shorter agreed terms set an earlier limit', () => {
    expect(msmeAlert({ ...bill, dueDate: '2026-09-16' }, '2026-09-20')).toMatchObject({ level: 'breached', limitDate: '2026-09-16' });
  });
  it('does not apply to medium or non-MSME vendors', () => {
    expect(msmeAlert({ ...bill, msmeType: 'medium' }, '2026-12-01').level).toBe('none');
    expect(msmeAlert({ ...bill, msmeType: 'none' }, '2026-12-01').level).toBe('none');
  });
});
