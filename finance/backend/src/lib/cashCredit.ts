import { Decimal } from './money';

/**
 * BR-50 Cash credit accounts. The CC balance is money drawn (a liability), not cash.
 * Headroom = min(sanctioned limit, drawing power) - drawn. Liquidity = cash + headroom.
 * Runway uses cash only (BR-37); liquidity is shown alongside.
 */
export function ccHeadroom(sanctionedLimit: Decimal, drawingPower: Decimal | null, drawn: Decimal): Decimal {
  const limit = drawingPower ? Decimal.min(sanctionedLimit, drawingPower) : sanctionedLimit;
  const headroom = limit.minus(drawn);
  return headroom.isNegative() ? new Decimal(0) : headroom;
}

export function liquidity(cash: Decimal, headroom: Decimal): Decimal {
  return cash.plus(headroom);
}
