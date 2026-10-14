# Phase 2 - Buy side, TDS and order-to-bank

Goal: every rupee going out is backed by a PO, a vendor document and a payment record, TDS is computed and tracked to the challan, and every CRM order is followed until its money is in the bank. Retires the PO Register, Vendor Invoice Register, Payment-Out Log, Accounts Payable Dashboard and the separate TDS workbook.

Modules: M04 Purchase Orders, M05 Vendor Documents, M06 Payables & Payments Out, M07 TDS Tracker, M14 Founder Expenses, M18 Order-to-Bank Reconciliation, M12 Dashboards (AP slice, accrual view).

Built without the pending setup (D14): no email (PDFs are downloaded or shared), Razorpay and Shiprocket built from their documented formats and tested on made-up data until keys and sample files are shared.

## Build order

Steps are the numbers of the list below (8 to 13, continuing after Phase 1's eight milestones M0-M7). They are not module IDs: Step 8 builds module M04, Step 9 M05, Step 10 M06, Step 11 M07, Step 12 M14 and the Phase 2 slice of M12, Step 13 M18.

8. **Purchase orders** (F040-F042, F044, F045, F047, F048; F043 milestones, F046 revisions): purchase item catalogue, PO lines with GST split from vendor state vs delivery state (BR-20), rounding (BR-21), PO number only on Issue (BR-30), PDF from an HTML template (Playwright, as in Bloc), billed / paid tracking and status (BR-17), short-close and cancel. Built (Step 8): B1, B2, B15, B16 pass.
9. **Vendor documents** (F050-F055, F057-F059): quote, proforma, tax invoice, debit and credit notes; lines prefilled from the PO; duplicate check (BR-19); due date from terms (BR-23); TDS suggested from the vendor's section, deductee type and FY aggregate (BR-11, BR-12) with override and reason; net payable (BR-18); proforma replaced by the tax invoice with advances moving across (BR-09); chase list of advances without a tax invoice (BR-10). Built (Step 9): B3, B4, B5, B6 pass; B7 passes except moving paid advances, which comes with payments (Step 10).
10. **Payments out** (F060, F061, F063-F065, F067; F062 kept off): due list, payment requests, record payment with UTR and proof, allocation to documents or as advance (BR-08), bank-change warning (BR-16), ageing (BR-24), MSME alerts (BR-25). Bank rows match payments by UTR, then amount + date + party, and take the document's category (BR-05 step 1). Built (Step 10): B7 (with advances), B8, B11 pass.
11. **TDS tracker** (F070-F075): deductions created from documents and advance payments (BR-11), payable by month with due dates (BR-13), challans matched to deductions and to OPT/CBDT bank rows (BR-14), 26Q quarter working for the CA, Form 16A status, FY aggregate per vendor per section. Built (Step 11): B9, B10 pass.
12. **Founder claims and AP dashboard** (F150, F151, F132; F131 accrual view, BR-35; F136 13-week forecast): claims create a payable to the founder, reimbursement matched to the bank debit (BR-27).
13. **Order-to-bank** (F190-F199, F200 view): CRM orders through the CRM reader and each order's delivery facts (shipped, delivered, AWB, COD to collect) through the Inventory reader of bloc-inv (D15; stub tables until connected), Razorpay payments and settlements, Shiprocket COD remittances from the remittance report file (Finance never calls Shiprocket, Q31), direct payments, statuses (BR-44), expected dates and overdue (BR-45), discrepancies (BR-46), three-level tie-out (BR-47).

Not in Phase 2: F056 reading bills from PDF (needs an AI key; later), F066 bank bulk file (P2), F076 customer TDS (P2), F134 and F135 (P2).

## Acceptance checks

| # | Check | Expected |
|---|---|---|
| B1 | Save a PO as draft, then issue it | No number while draft; ELPL/PO/26-27/001 on Issue (or the next number set in Settings, Q28); PDF stored with the PO |
| B2 | GST split (BR-20) | Saiffi (06) with place of supply Karnataka (29): IGST 18%. Makenica (29) to Karnataka: CGST 9% + SGST 9% |
| B3 | Saiffi tax invoice 040: taxable ₹9,80,000, IGST ₹1,76,400 | TDS 194C suggested at the individual rate from the master (PAN 4th letter P, BR-12); deducting 2% (₹19,600) instead needs an override reason; net payable ₹11,36,800 |
| B4 | VideAim PI0037 (BR-18) | ₹17,000 + GST ₹3,060 + fees ₹1,000 = ₹21,060; TDS 10% of ₹17,000 = ₹1,700; net ₹19,360; after a ₹19,360 payment outstanding is 0 |
| B5 | Bill linked to a PO (BR-17) | PO shows billed taxable and status Partially Billed until billed = PO value |
| B6 | Same vendor + document number + FY entered twice (BR-19) | Refused, ignoring case and spaces |
| B7 | Valco proforma ₹62,640 paid 1 Sep 2026 (BR-09, BR-10) | Shown as 'Awaiting tax invoice' and in the chase list; when the tax invoice is linked the advance moves to it |
| B8 | Payment with UTR 623112118032 recorded, then the statement row imported (BR-08) | Bank row linked to the payment, category taken from the document, payment Reconciled |
| B9 | TDS due dates (BR-13) | Deducted 24 Jul due 7 Aug; deducted in March due 30 Apr |
| B10 | Challans on 7 Sep 2026 (BR-14) | ₹1,080, ₹5,812 and ₹1,700 each matched to one deduction and one OPT/CBDT bank row; deductions Deposited |
| B11 | Ageing and MSME (BR-24, BR-25) | Buckets Not due / 1-30 / 31-60 / 61-90 / 90+; MSME bill alerts at day 30 and 40, limit 45 days |
| B12 | Founder claim reimbursed (BR-27) | Claim creates a payable to the founder; the bank debit to the founder settles it |
| B13 | Razorpay payment captured Fri 9 Oct 2026 (BR-45) | Expected settlement Wed 14 Oct; overdue from Fri 16 Oct |
| B14 | Three-level tie-out (BR-47) | Orders ₹5,996 gross, fees ₹119.92, GST on fees ₹21.59, net ₹5,854.49 equals the IDFC credit; any difference raises a discrepancy |
| B15 | Delete attempt on a PO, document or payment | Refused; cancel with reason instead; audit entry written |
| B16 | Phone width (375 px) | PO form, document entry and record payment usable without horizontal scroll |
