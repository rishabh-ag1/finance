import type { TxnNature } from '@prisma/client';
import { Decimal } from './money';
import { countsAsOperatingIncome, countsInGrossBurn } from './nature';

/**
 * BR-37 Burn and runway (D02-D05).
 *   Gross burn (month) = Operating Expense + COGS + Interest outflows.
 *   Net burn = gross burn - Operating Income receipts.
 *   Runway (months) = cash in business current accounts today (no cash credit headroom, BR-50)
 *                     / average net burn of the last 3 complete months.
 *   Capex and loan principal are separate lines, never in burn. Net burn <= 0: "Cash positive".
 */

export type Flow = { month: string; nature: TxnNature; direction: 'in' | 'out'; amount: Decimal };

export type MonthFigures = {
  month: string;
  operatingIncome: Decimal;
  operatingExpense: Decimal;
  cogs: Decimal;
  interest: Decimal;
  grossBurn: Decimal;
  netBurn: Decimal;
  capex: Decimal;
  financingIn: Decimal;
  financingOut: Decimal;
  taxPaid: Decimal;
  otherIn: Decimal;
  otherOut: Decimal;
};

const zero = () => new Decimal(0);

export function monthFigures(month: string, flows: Flow[]): MonthFigures {
  const f: MonthFigures = {
    month, operatingIncome: zero(), operatingExpense: zero(), cogs: zero(), interest: zero(), grossBurn: zero(), netBurn: zero(),
    capex: zero(), financingIn: zero(), financingOut: zero(), taxPaid: zero(), otherIn: zero(), otherOut: zero(),
  };
  for (const x of flows.filter((y) => y.month === month)) {
    if (x.direction === 'out') {
      if (countsInGrossBurn(x.nature)) f.grossBurn = f.grossBurn.plus(x.amount);
      if (x.nature === 'operating_expense') f.operatingExpense = f.operatingExpense.plus(x.amount);
      else if (x.nature === 'cogs') f.cogs = f.cogs.plus(x.amount);
      else if (x.nature === 'interest') f.interest = f.interest.plus(x.amount);
      else if (x.nature === 'capex') f.capex = f.capex.plus(x.amount);
      else if (x.nature === 'financing_out') f.financingOut = f.financingOut.plus(x.amount);
      else if (x.nature === 'tax_payment') f.taxPaid = f.taxPaid.plus(x.amount);
      else if (x.nature !== 'transfer') f.otherOut = f.otherOut.plus(x.amount);
    } else {
      if (countsAsOperatingIncome(x.nature)) f.operatingIncome = f.operatingIncome.plus(x.amount);
      else if (x.nature === 'financing_in') f.financingIn = f.financingIn.plus(x.amount);
      else if (x.nature !== 'transfer') f.otherIn = f.otherIn.plus(x.amount);
    }
  }
  f.netBurn = f.grossBurn.minus(f.operatingIncome);
  return f;
}

export type Runway =
  | { kind: 'months'; months: Decimal; averageNetBurn: Decimal }
  | { kind: 'cash_positive'; averageNetBurn: Decimal };

/** Runway from today's cash and the net burn of the last three complete months. */
export function runway(cash: Decimal, lastThreeNetBurn: Decimal[]): Runway {
  if (lastThreeNetBurn.length === 0) throw new Error('Runway needs the last three months');
  const average = lastThreeNetBurn.reduce((s, x) => s.plus(x), zero()).dividedBy(lastThreeNetBurn.length);
  if (!average.greaterThan(0)) return { kind: 'cash_positive', averageNetBurn: average };
  return { kind: 'months', months: cash.dividedBy(average).toDecimalPlaces(1, Decimal.ROUND_DOWN), averageNetBurn: average.toDecimalPlaces(2) };
}

/** "2026-10-13" -> the three complete months before it: ["2026-07-01", "2026-08-01", "2026-09-01"]. */
export function lastCompleteMonths(asOf: string, count = 3): string[] {
  const [y, m] = asOf.split('-').map(Number);
  const out: string[] = [];
  for (let i = count; i >= 1; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
