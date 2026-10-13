import { describe, expect, it } from 'vitest';
import { parseIdfcNarration } from '../../src/bank/parsers/idfcNarration';

// BR-02 Narration parsing. Worked example:
//   IMPS-OPM/623112118032/MICRO INSTRUMENTS CO.../SBIN0002468/7009/AdvanceToolingPaymentM gives
//   mode IMPS, UTR 623112118032, party MICRO INSTRUMENTS CO, IFSC SBIN0002468,
//   remark AdvanceToolingPaymentM. (Also acceptance check A4.)
// Unknown patterns keep the raw text and go to Review.
describe('BR-02 narration parsing (IDFC)', () => {
  it('parses the worked example, removing IDFC\'s repeated beneficiary name', () => {
    expect(parseIdfcNarration('IMPS-OPM/623112118032/MICRO INSTRUMENTS COMICRO INSTRUMENTS CO/SBIN0002468/7009/AdvanceToolingPaymentM')).toEqual({
      parsed: true,
      mode: 'IMPS',
      modeDetail: 'OPM',
      utr: '623112118032',
      counterpartyName: 'MICRO INSTRUMENTS CO',
      counterpartyIfsc: 'SBIN0002468',
      counterpartyAccount: null,
      counterpartyBank: null,
      ref2: '7009',
      remark: 'AdvanceToolingPaymentM',
    });
  });

  it('parses an inward IMPS (founder capital)', () => {
    expect(parseIdfcNarration('IMPS/615064116942/RISHABHSHIVDARS/HDFC0002524/4436/Investment')).toMatchObject({
      mode: 'IMPS', modeDetail: null, utr: '615064116942', counterpartyName: 'RISHABHSHIVDARS', counterpartyIfsc: 'HDFC0002524', remark: 'Investment',
    });
  });

  it('keeps an empty remark empty', () => {
    expect(parseIdfcNarration('IMPS-OPM/625516694126/TRINITY NDT WELDSOLUTIONS PRIVATE LIMITE/ICIC0001935/2088/')).toMatchObject({
      counterpartyName: 'TRINITY NDT WELDSOLUTIONS PRIVATE LIMITE', remark: null,
    });
  });

  it('parses RTGS, joining the rest of the narration into the remark', () => {
    expect(parseIdfcNarration('RTGS/IDFBR62026072403779464/SAIFFI INDUSTRIESPARVEZ AALAM/SBIN0050316/Tooling Advance')).toMatchObject({
      mode: 'RTGS', utr: 'IDFBR62026072403779464', counterpartyName: 'SAIFFI INDUSTRIESPARVEZ AALAM', counterpartyIfsc: 'SBIN0050316', remark: 'Tooling Advance',
    });
    expect(parseIdfcNarration('RTGS/KKBKR22026060423108701/NEOS KOSMOS TECHNOLOGIES PRIVATE/KKBK0000958//PHOB/Mesa School Loan KKBKR22026060423108701-NEOS01-R')).toMatchObject({
      mode: 'RTGS', utr: 'KKBKR22026060423108701', counterpartyName: 'NEOS KOSMOS TECHNOLOGIES PRIVATE', counterpartyIfsc: 'KKBK0000958',
      remark: 'PHOB/Mesa School Loan KKBKR22026060423108701-NEOS01-R',
    });
  });

  it('parses IDFC internal transfers (IFT): the second token is the other account', () => {
    expect(parseIdfcNarration('IFT/10245658808/NEWERA LIVING /7545890/Business Acc Transfer')).toMatchObject({
      mode: 'IFT', counterpartyAccount: '10245658808', counterpartyName: 'NEWERA LIVING', utr: '7545890', remark: 'Business Acc Transfer',
    });
    expect(parseIdfcNarration('IFT/10199987550/ASTRA SHIELD SOLUTIO/8950768')).toMatchObject({
      mode: 'IFT', counterpartyAccount: '10199987550', counterpartyName: 'ASTRA SHIELD SOLUTIO', utr: '8950768', remark: null,
    });
  });

  it('parses OPT/CBDT tax payments', () => {
    expect(parseIdfcNarration('OPT/CBDT/26080500079856/05-08-2026/12:12:07')).toMatchObject({
      mode: 'OPT', modeDetail: 'CBDT', utr: '26080500079856', counterpartyName: 'CBDT', remark: '05-08-2026 12:12:07',
    });
  });

  it('parses card / gateway (Ecom) payments', () => {
    expect(parseIdfcNarration('Ecom/67177144/PayUPaymen/INNOV8WORK/VirtualAddress')).toMatchObject({
      mode: 'ECOM', modeDetail: 'PayUPaymen', utr: '67177144', counterpartyName: 'INNOV8WORK', remark: 'VirtualAddress',
    });
  });

  it('parses UPI credits with a bank code instead of an IFSC', () => {
    expect(parseIdfcNarration('UPI/CR/625171485826/GOLLA RA/FDRL/7032121/Paid via SuperMoney UPI')).toMatchObject({
      mode: 'UPI', modeDetail: 'CR', utr: '625171485826', counterpartyName: 'GOLLA RA', counterpartyIfsc: null,
      counterpartyBank: 'FDRL', ref2: '7032121', remark: 'Paid via SuperMoney UPI',
    });
  });

  it('marks an unknown pattern as not parsed and keeps nothing invented', () => {
    expect(parseIdfcNarration('SOMETHING NEW 12345')).toEqual({
      parsed: false, mode: null, modeDetail: null, utr: null, counterpartyName: null, counterpartyIfsc: null,
      counterpartyAccount: null, counterpartyBank: null, ref2: null, remark: null,
    });
  });

  it('recognises bank charges and ATM by their first token', () => {
    expect(parseIdfcNarration('CHG/SMS CHARGES QTR SEP 2026')).toMatchObject({ parsed: true, mode: 'CHG', remark: 'SMS CHARGES QTR SEP 2026' });
    expect(parseIdfcNarration('ATM/CASH WDL/IDFC ATM KORAMANGALA')).toMatchObject({ parsed: true, mode: 'ATM' });
  });
});
