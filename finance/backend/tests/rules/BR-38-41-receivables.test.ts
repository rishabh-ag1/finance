import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/lib/money';
import { checkReceipt, dso, invoicePayment, suggestInvoicesForCredit } from '../../src/lib/receivables';

const d = (v: string) => new Decimal(v);

// BR-38 receipt matching. Worked example: invoice Rs 1,18,000 (taxable Rs 1,00,000 + GST Rs 18,000);
// the hotel deducts 2% on taxable = Rs 2,000 and pays Rs 1,16,000. Suggested: receipt Rs 1,16,000 +
// TDS receivable Rs 2,000, invoice fully settled.
describe('BR-38 suggesting the invoice for a bank credit', () => {
  const inv = (o: object = {}) => ({ id: 'a', docNumber: 'ELPL/26-27/00007', outstanding: d('118000'), taxable: d('100000'), dueDate: '2026-10-20', customerNames: ['Lake View Hotels'], deductsTds: true, ...o });

  it('Rs 1,16,000 from the hotel against Rs 1,18,000: receipt Rs 1,16,000 + TDS Rs 2,000 (2% of taxable), settled', () => {
    const [s] = suggestInvoicesForCredit({ amount: d('116000'), date: '2026-10-22', counterparty: 'LAKE VIEW HOTELS PVT LTD' }, [inv()]);
    expect(s).toMatchObject({ invoiceId: 'a', receipt: '116000.00', tds: '2000.00', tdsRate: '2', settles: true });
    expect(s.confidence).toBeGreaterThanOrEqual(0.8);
  });
  it('the exact outstanding with the name scores above an amount-only match; at most 3 are shown', () => {
    const many = [inv({ id: 'x', customerNames: ['Someone Else'], outstanding: d('116000') }), inv({ id: 'y', outstanding: d('116000') }), inv({ id: 'z', outstanding: d('116000'), dueDate: '2026-01-01' }), inv({ id: 'w', outstanding: d('116000'), customerNames: ['Other'] })];
    const s = suggestInvoicesForCredit({ amount: d('116000'), date: '2026-10-22', counterparty: 'LAKE VIEW HOTELS' }, many);
    expect(s).toHaveLength(3);
    expect(s[0].invoiceId).toBe('y');
    expect(s.find((x) => x.invoiceId === 'z')).toBeUndefined(); // more than 60 days from its due date
  });
  it('no TDS is suggested for a customer that does not deduct it, and a part payment is a lower-confidence part receipt', () => {
    expect(suggestInvoicesForCredit({ amount: d('116000'), date: '2026-10-22', counterparty: 'LAKE VIEW' }, [inv({ deductsTds: false })])[0]).toMatchObject({ tds: '0.00', settles: false });
  });
});

// BR-41: receipt + TDS deducted = amount allocated to the invoice; what is not allocated is an advance.
describe('BR-41 receipt, TDS and allocation', () => {
  it('Rs 1,16,000 + TDS Rs 2,000 allocated Rs 1,18,000 to one invoice: nothing left over', () => {
    expect(checkReceipt({ amount: d('116000'), tds: d('2000'), charges: d('0'), allocations: [{ amount: d('118000'), outstanding: d('118000'), label: 'ELPL/26-27/00007' }] })).toEqual({ problems: [], advance: '0.00', total: '118000.00' });
  });
  it('more than the invoice owes, or more than was received, is refused; the rest is an advance', () => {
    expect(checkReceipt({ amount: d('50000'), tds: d('0'), charges: d('0'), allocations: [{ amount: d('60000'), outstanding: d('118000'), label: 'X' }] }).problems).toEqual(['Rs 60000.00 allocated is more than the Rs 50000.00 received (with TDS and charges)']);
    expect(checkReceipt({ amount: d('50000'), tds: d('0'), charges: d('0'), allocations: [{ amount: d('20000'), outstanding: d('10000'), label: 'X' }] }).problems).toEqual(['X: Rs 20000.00 is more than the Rs 10000.00 it owes']);
    expect(checkReceipt({ amount: d('50000'), tds: d('0'), charges: d('0'), allocations: [{ amount: d('10000'), outstanding: d('10000'), label: 'X' }] }).advance).toBe('40000.00');
  });
});

// Invoice payment state (Status Flows): received + TDS + credit notes against the total; BR-22 overdue.
describe('invoice payment state and BR-22 overdue', () => {
  it('unpaid, part paid, paid; overdue only while something is owed past the due date', () => {
    expect(invoicePayment({ total: d('118000'), received: d('0'), tds: d('0'), credited: d('0'), dueDate: '2026-10-13', today: '2026-10-14' })).toEqual({ state: 'unpaid', outstanding: '118000.00', overdue: true, daysOverdue: 1, bucket: '1_30' });
    expect(invoicePayment({ total: d('118000'), received: d('100000'), tds: d('2000'), credited: d('0'), dueDate: '2026-10-13', today: '2026-11-13' })).toMatchObject({ state: 'partly_paid', outstanding: '16000.00', daysOverdue: 31, bucket: '31_60' });
    expect(invoicePayment({ total: d('118000'), received: d('116000'), tds: d('2000'), credited: d('0'), dueDate: '2026-10-13', today: '2027-01-30' })).toMatchObject({ state: 'paid', outstanding: '0.00', overdue: false, bucket: null });
    expect(invoicePayment({ total: d('4548'), received: d('0'), tds: d('0'), credited: d('4548'), dueDate: '2026-10-08', today: '2026-10-20' })).toMatchObject({ state: 'paid', outstanding: '0.00' });
  });
  it('DSO: outstanding / sales of the last 90 days x 90', () => {
    expect(dso(d('300000'), d('900000'), 90)).toBe(30);
    expect(dso(d('1000'), d('0'), 90)).toBeNull();
  });
});
