import { describe, expect, it } from 'vitest';
import { ccHeadroom, liquidity } from '../../src/lib/cashCredit';
import { Decimal } from '../../src/lib/money';

// BR-50 Cash credit accounts. Worked example: sanctioned Rs 20L, drawing power Rs 15L,
// drawn Rs 6L: headroom Rs 9L.
describe('BR-50 cash credit headroom', () => {
  it('uses the lower of sanctioned limit and drawing power', () => {
    expect(ccHeadroom(new Decimal('2000000'), new Decimal('1500000'), new Decimal('600000')).toFixed(2)).toBe('900000.00');
  });

  it('uses the sanctioned limit when no drawing power is entered', () => {
    expect(ccHeadroom(new Decimal('2000000'), null, new Decimal('600000')).toFixed(2)).toBe('1400000.00');
  });

  it('never shows negative headroom when overdrawn', () => {
    expect(ccHeadroom(new Decimal('2000000'), new Decimal('500000'), new Decimal('600000')).toFixed(2)).toBe('0.00');
  });

  it('adds headroom to cash for liquidity, but cash itself is unchanged', () => {
    expect(liquidity(new Decimal('410869'), new Decimal('900000')).toFixed(2)).toBe('1310869.00');
  });
});
