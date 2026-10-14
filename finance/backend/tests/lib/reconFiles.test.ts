import { describe, expect, it } from 'vitest';
import { parseRazorpayTable, parseShiprocketTable } from '../../src/recon/files';

// Razorpay dashboard exports (amounts in rupees; Razorpay's fee column includes the GST on it) and
// Shiprocket's COD remittance report. Column names from the documented formats; [Verify] with one
// real file of each (D13 item 7).
const table = (csv: string) => csv.trim().split('\n').map((l) => l.split(','));

describe('Razorpay reports', () => {
  it('payments report: one row per payment, fee split into fee and GST on fee', () => {
    const r = parseRazorpayTable(table(`
id,amount,currency,status,order_id,method,amount_refunded,description,email,contact,notes,fee,tax,created_at
pay_B14a,1499,INR,captured,order_X1,upi,0,#BLC-1001,a@b.in,+919800000001,{"shopify_order_id":"BLC-1001"},35.38,5.40,09/10/2026 14:23:11
pay_B14b,2998,INR,refunded,order_X2,card,2998,,c@d.in,+919800000002,,70.75,10.79,2026-10-09 16:00:00
pay_fail,500,INR,failed,order_X3,card,0,,,,,0,0,2026-10-09 17:00:00`));
    expect(r.kind).toBe('payments');
    if (r.kind !== 'payments') return;
    expect(r.payments).toHaveLength(2);
    expect(r.payments[0]).toMatchObject({ externalId: 'pay_B14a', amount: '1499.00', fee: '29.98', taxOnFee: '5.40', status: 'captured', capturedOn: '2026-10-09', method: 'upi', refunded: '0.00' });
    expect(r.payments[0].reference).toContain('BLC-1001');
    expect(r.payments[1]).toMatchObject({ status: 'refunded', refunded: '2998.00' });
    expect(r.skipped).toBe(1);
  });

  it('settlement recon report: lines grouped into settlements (B14 totals)', () => {
    const r = parseRazorpayTable(table(`
entity_id,type,debit,credit,amount,currency,fee,tax,settled,created_at,settled_at,settlement_id,settlement_utr,payment_id,order_id,order_receipt,method,description,notes
pay_1,payment,0,1463.62,1499,INR,35.38,5.40,1,09/10/2026 10:00:00,14/10/2026 09:00:00,setl_B14,UTR998877,,order_1,BLC-1001,upi,,
pay_2,payment,0,2927.25,2998,INR,70.75,10.79,1,09/10/2026 11:00:00,14/10/2026 09:00:00,setl_B14,UTR998877,,order_2,BLC-1002,card,,
pay_3,payment,0,1463.62,1499,INR,35.38,5.40,1,09/10/2026 12:00:00,14/10/2026 09:00:00,setl_B14,UTR998877,,order_3,BLC-1003,upi,,`));
    expect(r.kind).toBe('settlements');
    if (r.kind !== 'settlements') return;
    expect(r.settlements).toHaveLength(1);
    const s = r.settlements[0];
    expect(s).toMatchObject({ externalId: 'setl_B14', utr: 'UTR998877', settledOn: '2026-10-14', gross: '5996.00', fees: '119.92', taxOnFees: '21.59', refunds: '0.00', adjustments: '0.00', net: '5854.49' });
    expect(s.lines[1]).toMatchObject({ type: 'payment', paymentId: 'pay_2', gross: '2998.00', fee: '59.96', taxOnFee: '10.79', net: '2927.25', reference: 'BLC-1002 order_2' });
  });

  it('refunds and adjustments reduce or add to the net', () => {
    const r = parseRazorpayTable(table(`
entity_id,type,debit,credit,amount,fee,tax,settled_at,settlement_id,settlement_utr,payment_id,order_receipt
pay_1,payment,0,980.00,1000,20.00,3.05,15/10/2026,setl_2,UTR1,,
rfnd_1,refund,300,0,300,0,0,15/10/2026,setl_2,UTR1,pay_old,
adj_1,adjustment,0,5,5,0,0,15/10/2026,setl_2,UTR1,,`));
    if (r.kind !== 'settlements') throw new Error('kind');
    expect(r.settlements[0]).toMatchObject({ gross: '1000.00', refunds: '300.00', adjustments: '5.00', net: '685.00' });
    expect(r.settlements[0].lines[1]).toMatchObject({ type: 'refund', paymentId: 'pay_old', refund: '300.00', net: '-300.00' });
  });

  it('a file that is neither report is refused', () => {
    expect(() => parseRazorpayTable(table('a,b\n1,2'))).toThrow(/Razorpay/);
  });
});

describe('Shiprocket COD remittance report', () => {
  it('one remittance per CRF ID / UTR, lines by AWB', () => {
    const r = parseShiprocketTable(table(`
CRF ID,Remittance Date,UTR,AWB Code,Order ID,COD Amount
CRF1001,15-10-2026,SRUTR55,1234567890,BLC-260501,1499.00
CRF1001,15-10-2026,SRUTR55,1234567891,BLC-260502,999.00
CRF1002,17-10-2026,SRUTR56,1234567892,BLC-260503,2998.00`));
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ externalId: 'CRF1001', utr: 'SRUTR55', settledOn: '2026-10-15', net: '2498.00' });
    expect(r[0].lines[0]).toMatchObject({ awb: '1234567890', reference: 'BLC-260501', gross: '1499.00', net: '1499.00' });
  });
  it('names the missing column', () => {
    expect(() => parseShiprocketTable(table('Order ID,COD Amount\nX,1'))).toThrow(/AWB/);
  });
});
