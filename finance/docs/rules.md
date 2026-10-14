# Entelechy Finance App - Business Rules

> Source of truth for HOW the app calculates and decides. IDs BR-## are permanent; never renumber or reuse.
> Every rule with a worked example must have a unit test that reproduces that example (`tests/rules/BR-xx.test.ts`).
> Format per rule (the sheet sync parses it): `## BR-xx - Title`, then one `- **Field:** value` line per field. Use `<br>` for line breaks inside a value.
> Tax rules marked [Verify] are seeded with old-Act values (Q15) and must stay configurable in settings, never hard-coded.

## BR-01 - Duplicate check on import

- **Module:** M02
- **Trigger:** Each row of an uploaded statement
- **Logic:** Key = account_id \| txn_date \| narration \| debit \| credit \| running balance. If the key exists, skip the row. Running balance is included because two genuine identical payments on the same day (same UPI amount to the same party) would otherwise collapse into one. The current Sync Key (date \| narration \| amount) has this gap.
- **Worked example:** Two ₹500 UPI payments to Porter on 5 Sep with identical narration: balances differ (10,500 then 10,000), so both rows are kept.
- **Confidence:** High

## BR-02 - Narration parsing

- **Module:** M02
- **Trigger:** On import
- **Logic:** Split narration on '/'. First token gives mode: IMPS, IMPS-OPM, NEFT, RTGS, UPI, IFT (IDFC internal), OPT/CBDT (tax payment), Ecom (card/gateway), ATM, CHG (charges). Then: reference/UTR, counterparty name, counterparty IFSC, remark. Unknown patterns keep raw text and go to Review. Parser patterns are per bank, one parser per parser_format on the bank account (idfc_v1 for IDFC). IDFC specifics: IMPS-OPM gives mode IMPS with detail OPM; IDFC repeats a truncated copy of the beneficiary name, which is removed; for IFT the second token is the other IDFC account number, not a UTR; UPI carries a bank code instead of an IFSC. The imported date, narration, amounts and balance can never be edited (database trigger).
- **Worked example:** IMPS-OPM/623112118032/MICRO INSTRUMENTS CO.../SBIN0002468/7009/AdvanceToolingPaymentM gives mode IMPS, UTR 623112118032, party MICRO INSTRUMENTS CO, IFSC SBIN0002468, remark AdvanceToolingPaymentM.
- **Confidence:** High

## BR-03 - Balance continuity

- **Module:** M02
- **Trigger:** On import
- **Logic:** First row's (balance - credit + debit) must equal the last stored balance for that account. File's last balance must equal opening + credits - debits. Mismatch: batch flagged, missing date range shown, import still allowed with a warning. On the first import the file continues from the account's opening balance; a file that starts with rows already imported continues from them.
- **Worked example:** Last stored balance 4,60,366 on 7 Sep. Next file's first row must back-calculate to 4,60,366.
- **Confidence:** High

## BR-04 - Nature of transaction

- **Module:** M02
- **Trigger:** Every bank row, bill, invoice
- **Logic:** Each line has a Nature: Operating Income, Operating Expense, COGS, Capex, Financing In (equity, share application money, loan received), Financing Out (loan principal repaid), Interest, Tax Payment (TDS deposit, GST paid), Advance (to vendor / from customer), Transfer (own accounts), Related Party, Refund/Reversal. Nature is set by the category (see Category Master) and can be overridden. P&L-style dashboards only use Operating Income, Operating Expense, COGS, Interest. Burn uses all operating outflows; capex shown separately.
- **Worked example:** ₹12,00,000 from Neos Kosmos on 4 Jun = Financing In (loan), not Income. ₹11,36,800 to Saiffi on 24 Jul = Capex (tooling). ₹19,600 OPT/CBDT on 5 Aug = Tax Payment, settles TDS payable, not a new expense.
- **Confidence:** High

## BR-05 - Auto-categorisation order

- **Module:** M02
- **Trigger:** New bank row
- **Logic:** 1) Matches an expected item (approved payment by UTR or amount+date+party; loan EMI; TDS challan) then take that item's category. 2) Counterparty name maps to a vendor (one of its bank-statement names) or customer: link the party and take its default category ('Vendor: Saiffi Industries'). 3) Keyword rules in priority order. 4) Category last used for this counterparty. 5) Review. Store the reason ('Matched PMT-0004', 'Rule: OPT/CBDT', 'Last used for MAKENICA PRIVATE LIMITED'). A suggestion puts the row in Suggested; a person accepts it (one by one or in bulk) to make it Categorised. Own-account transfers (BR-06) are paired before the rules run and are never re-categorised. Step 1 starts in Phase 2 and step 2 with vendors (Phase 1).
- **Worked example:** OPT/CBDT/... matches keyword rule 'OPT/CBDT' and becomes Tax Payment > TDS Deposit, then the app suggests the open TDS deductions of the previous month to link.
- **Confidence:** High

## BR-06 - Own-account transfer pairing

- **Module:** M02
- **Trigger:** Debit in one own account and credit in another
- **Logic:** Same amount, opposite direction, within 3 days, both accounts belong to Entelechy: pair them, Nature = Transfer, excluded from income and expense. Transfers from founder personal accounts are not Transfers; they are capital, loan from director or reimbursement (user picks). Own accounts = Entelechy's business current, cash credit, wallet and loan accounts. A narration naming the other account's number is preferred, then the closest date. Unpairing (with a reason) returns both rows to Review.
- **Worked example:** -
- **Confidence:** High

## BR-07 - Split transactions

- **Module:** M02
- **Trigger:** User splits a row
- **Logic:** Sum of split lines must equal the bank amount to the paisa. Each line has its own category, nature, party and linked document. The parent row shows 'Split (n)'. Editing a split replaces its lines; removing it (with a reason) archives the lines and returns the row to Review.
- **Worked example:** One ₹50,000 payment that clears two vendor bills of ₹30,000 and ₹20,000.
- **Confidence:** High

## BR-08 - Payment allocation and matching

- **Module:** M06/M02
- **Trigger:** Payment recorded or bank debit matched
- **Logic:** Payment amount = sum of allocations to bills + unallocated (becomes advance). Bill paid amount = sum of allocations + TDS on that bill + advances adjusted. Bank debit links to payment by UTR first, else amount + date (±3 days) + party name similarity. In the app: every rupee of a payment is allocated to a tax invoice or, as an advance, to a quote, proforma or PO (no unanchored amount). The UTR is looked for in the parsed UTR and anywhere in the narration; the amount must be equal and the account the same; names match when at least half of the words agree (IDFC's run-together names count); two equally good rows are left to a person. Matching runs when a payment is recorded and on every statement import, before the rules (BR-05 step 1); the bank row takes the document's category as a suggestion.
- **Worked example:** PMT-0002 ₹2,84,808 to Micro Instruments, UTR 623112118032, allocated to quote dated 18/08/2026 as advance.
- **Confidence:** High

## BR-09 - Advances against quote or proforma

- **Module:** M05/M06
- **Trigger:** Payment made against a Quote or Proforma
- **Logic:** Payment is recorded as Vendor Advance linked to the quote/PI. When the tax invoice arrives (F057) the advance is applied to it. Advances appear on the vendor 360 and AP dashboard as 'Advance paid, tax invoice pending'. In the app: entering the tax invoice that replaces the quote / proforma moves its paid advances onto the invoice; cancelling that invoice moves them back. Advances paid on a PO are set against a tax invoice of that PO by a person, from the bill page.
- **Worked example:** Valco proforma 931842454696864: ₹62,640 paid 1 Sep. Status stays 'Awaiting tax invoice' until Valco's tax invoice is attached; then the tax invoice shows advances applied ₹62,640 and nothing owed.
- **Confidence:** High

## BR-10 - Money out without a tax invoice

- **Module:** M05
- **Trigger:** Daily
- **Logic:** Sum of advances not yet adjusted against a tax invoice. Any advance older than N days (default 15, Settings > Company) appears in the chase list; the list also shows every quote and proforma still awaiting its tax invoice. ITC on the GST portion cannot be claimed until the tax invoice is in hand.
- **Worked example:** Current figure from AP Dashboard: ₹3,85,508.
- **Confidence:** High

## BR-11 - TDS base and timing

- **Module:** M07
- **Trigger:** Bill saved or payment made, whichever first
- **Logic:** TDS is deducted at the earlier of credit (bill booked) or payment (including advance). Base = taxable value excluding GST when GST is shown separately on the invoice; on an advance against a quote without GST break-up, base = advance amount unless the GST portion is identifiable (in the app: an advance on a quote, proforma or PO takes its GST share from that document, base = advance x taxable / total). When the tax invoice later arrives, TDS already deducted on the advance is netted so it is not deducted twice. In the app: a tax invoice gets its TDS when entered; a quote or proforma gets none until its advance is paid (M06). The app suggests the TDS and keeps the suggestion with its reasoning; a different figure needs a reason.
- **Worked example:** Saiffi bill 040: taxable ₹9,80,000, GST ₹1,76,400, TDS 2% on ₹9,80,000 = ₹19,600. Net paid ₹11,36,800.
- **Confidence:** High on GST exclusion. [Verify] advance treatment with CA.

## BR-12 - TDS rate and thresholds

- **Module:** M07
- **Trigger:** Bill or payment for a vendor with a TDS section
- **Logic:** Rate = section rate for deductee type. Deductee type from PAN 4th character: P (individual) or H (HUF) use individual rate; C, F, T, A, B, etc. use 'others' rate. No PAN on file: higher no-PAN rate. Lower deduction certificate overrides rate up to its limit and validity. Thresholds: deduct only if the single payment or FY aggregate crosses the section's thresholds; once the aggregate threshold is crossed, deduct on the full FY amount including earlier payments. All rates and thresholds come from the TDS Section master.
- **Worked example:** Saiffi Industries GSTIN 06ANJPA3053F1ZI gives PAN ANJPA3053F, 4th character P = individual (proprietorship). Contract work rate for individuals has been 1%, but 2% (₹19,600) was deducted. Makenica (₹37,401, no TDS) may have needed TDS if it is contract work rather than a purchase of goods. Threshold catch-up: a company vendor billed ₹85,000 under 194C this FY without TDS, then ₹20,000: FY total ₹1,05,000 crosses ₹1,00,000, so TDS is 2% of ₹1,05,000 = ₹2,100. Lower deduction certificate: its rate applies within its dates and while the FY total stays within its limit.
- **Confidence:** [Verify] Rates, thresholds and new section numbers under Income-tax Act 2025. Saiffi 1% vs 2% and Makenica: confirm with CA.

## BR-13 - TDS deposit due date

- **Module:** M07
- **Trigger:** Daily
- **Logic:** TDS deducted in a month is due by the 7th of the next month; deductions in March are due by 30 April. Dashboard shows amount and days left. Late deposit: interest per month or part month at the rate in settings (1.5% for deducted-not-deposited). In the app: counted in calendar months from the month of deduction to the month of deposit (as TRACES does, [Verify]); nothing when deposited by the due date; the rate is in Company settings.
- **Worked example:** Saiffi deducted 24 Jul, deposited 5 Aug (on time). Micro Instruments deducted 19 Aug, deposited 7 Sep (on the due date). Had Saiffi's ₹19,600 been deposited on 8 Aug: July and August = 2 months x 1.5% = ₹588 interest.
- **Confidence:** High on dates. [Verify] interest rate under new Act.

## BR-14 - Challan matching

- **Module:** M07
- **Trigger:** Challan recorded or OPT/CBDT bank row imported
- **Logic:** Challan amount = sum of linked deductions + interest + fee. Linked deductions move to Deposited. Bank row with OPT/CBDT and same amount and date is linked to the challan. In the app: one challan pays one section (ITNS 281); the OPT/CBDT row of the challan total within 3 days links by itself when only one fits; an OPT/CBDT row with no challan suggests one open deduction of exactly its amount, else all open deductions of one month when they add up to it.
- **Worked example:** 7 Sep: three challans ₹1,080 (Valco), ₹5,812 (Micro Instruments), ₹1,700 (VideAim), each matched to one deduction.
- **Confidence:** High

## BR-15 - GSTIN and PAN validation

- **Module:** M03
- **Trigger:** Vendor or customer saved
- **Logic:** GSTIN: 15 characters, 2-digit state code, 10-character PAN, entity number, 'Z', checksum. Checksum validated in code; status (active/cancelled) validated by API. PAN: 5 letters, 4 digits, 1 letter. PAN must equal GSTIN characters 3-12. IFSC: 4 letters, '0', 6 alphanumeric.
- **Worked example:** 06AAGCV6571J1ZW: state 06 (Haryana), PAN AAGCV6571J (C = company).
- **Confidence:** High

## BR-16 - Vendor bank detail changes

- **Module:** M03
- **Trigger:** Bank account edited on an active vendor
- **Logic:** Requires founder approval; old details kept in history; any payment request in the next 30 days shows a 'bank details recently changed' warning. Protects against invoice-redirection fraud. The approval must come from a founder other than the one who entered the change. The first account of a vendor that is not yet active is approved on entry (onboarding). A newer request replaces an older pending one (kept as rejected). Approval marks the old account superseded.
- **Worked example:** -
- **Confidence:** High

## BR-17 - PO status and over-billing

- **Module:** M04
- **Trigger:** Bill linked or payment made against a PO
- **Logic:** Billed % = sum of linked tax invoice taxable values / PO taxable value. 0% = Issued; between 0 and 100% = Partially Billed; 100% = Fully Billed. A bill that pushes billed value above PO value + tolerance (default 0%) needs approval or a PO amendment.
- **Worked example:** Saiffi PO ELPL/PO/2026/001 value ₹28,91,000, billed so far ₹9,80,000 taxable on bill 040 = Partially Billed. Compared like for like on taxable value (excluding GST); BR-17 test.
- **Confidence:** High

## BR-18 - Net payable

- **Module:** M05
- **Trigger:** Bill saved
- **Logic:** Net payable = total invoice value (taxable + GST + other non-taxable fees) - TDS - advances adjusted. Outstanding = net payable - payments allocated + vendor debit notes - vendor credit notes against the bill.
- **Worked example:** VideAim PI0037: ₹17,000 + GST ₹3,060 + fees ₹1,000 = ₹21,060; TDS 10% of ₹17,000 = ₹1,700; net ₹19,360; paid ₹19,360; outstanding 0.
- **Confidence:** High

## BR-19 - Duplicate vendor bill

- **Module:** M05
- **Trigger:** Bill saved
- **Logic:** Block if the same vendor + same document number + same FY already exists (normalise case and spaces). Warn if same vendor + same amount within 7 days. A cancelled entry does not block entering the number again.
- **Worked example:** Vendor bill 'PI 0037' is refused when 'pi0037' from the same vendor is already entered for FY 26-27.
- **Confidence:** High

## BR-20 - GST split

- **Module:** M04/M05/M09
- **Trigger:** Line saved
- **Logic:** Compare supplier state and place of supply. Same state: CGST = SGST = rate/2. Different state: IGST = rate. Our state = 29 (Karnataka). Purchases: supplier state from vendor GSTIN; place of supply from delivery address. Sales: place of supply = ship-to state for goods. A supplier not registered for GST charges no GST. The rate on a line must be a GST rate in force on the document date (GST rate master).
- **Worked example:** Saiffi (06 Haryana) supplying to Entelechy (29) should be IGST 18%; Makenica (29) should be CGST 9% + SGST 9%.
- **Confidence:** High

## BR-21 - Rounding and amount in words

- **Module:** M04/M05/M09
- **Trigger:** Document totals
- **Logic:** Line amounts to 2 decimals; tax per line to 2 decimals; document total rounded to nearest rupee with a separate 'Round off' line (max ±0.99). Amount in words in Indian format (lakh, crore).
- **Worked example:** ₹37,401.28 shows as ₹37,401.00 with round off (0.28). Tax half-up per line: 2.5% of ₹999.00 = ₹24.975 shows as ₹24.98. ₹11,36,800 in words: Rupees Eleven Lakh Thirty Six Thousand Eight Hundred Only.
- **Confidence:** High

## BR-22 - Overdue status

- **Module:** M06/M10
- **Trigger:** Daily
- **Logic:** Document is Overdue when today > due date and outstanding > 0. Days overdue = today - due date.
- **Worked example:** A bill due 13 Oct 2026 is 1 day overdue on 14 Oct 2026.
- **Confidence:** High

## BR-23 - Due date

- **Module:** M05/M09
- **Trigger:** Document saved
- **Logic:** Due date = document date + payment term days (from vendor/customer default, overridable). Advance terms: due date = document date.
- **Worked example:** Bill dated 24 Jul 2026 on Net 30 is due 23 Aug 2026; on Advance or On receipt it is due 24 Jul 2026.
- **Confidence:** High

## BR-24 - Ageing buckets

- **Module:** M06/M10
- **Trigger:** Report run
- **Logic:** Buckets by days past due date: Not due, 1-30, 31-60, 61-90, 90+. Unapplied advances shown as a separate column.
- **Worked example:** 1 day past due goes in 1-30, 31 days in 31-60, 91 days in 90+; an advance on a PO that no invoice has used yet shows in the Advances column.
- **Confidence:** High

## BR-25 - MSME payment alert

- **Module:** M06
- **Trigger:** Daily
- **Logic:** For vendors registered as Micro or Small: max payment period = agreed terms, capped at 45 days from acceptance of goods/services. Alert at day 30 and 40. Unpaid amounts beyond the limit are also not deductible for income tax until paid, so this matters at year end. Acceptance is taken as the received date of the bill, else its date.
- **Worked example:** Micro vendor's bill accepted 1 Sep 2026 on Net 60: limit 16 Oct 2026 (45 days); alerts on 1 Oct (day 30) and 11 Oct (day 40); from 17 Oct it is past the limit.
- **Confidence:** High on 45 days. [Verify] tax disallowance provision under new Act.

## BR-26 - Approvals

- **Module:** M04/M06
- **Trigger:** PO submitted, payment request submitted
- **Logic:** Provision only; switched off at launch. When switched on: band by amount from settings, requester cannot approve own request, a both-founder band needs two distinct approvals, approval resets if the amount is edited.
- **Worked example:** Off by default.
- **Confidence:** High

## BR-27 - Founder reimbursement

- **Module:** M14
- **Trigger:** Expense claim approved
- **Logic:** Creates payable to the founder. Settled by a bank debit to the founder's account (Nature = Reimbursement). Founder balance = claims - reimbursements. Founder money put into the company is NOT a claim; it is capital, share application money or a director loan (user picks). As built (Step 12): the other founder approves, only with the receipt attached; approved claims count as spending (their category's nature) on the expense date, in the cash and accrual views and in burn; the reimbursement's bank row is categorised Founder Reimbursement (nature Reimbursement, outside burn) so the expense is never counted twice. Balance = approved and reimbursed claims - reimbursements not failed; rejected and withdrawn claims count for nothing; claims waiting for approval are shown apart. A reimbursement pays whole claims of one founder and matches its bank debit like a vendor payment (BR-08).
- **Worked example:** Rishabh's claims: ₹2,500 and ₹1,200 approved, ₹800 rejected. Owed ₹3,700. A ₹2,500 reimbursement is paid: owed ₹1,200. If that reimbursement fails, ₹3,700 is owed again.
- **Confidence:** High

## BR-28 - Loans and covenant

- **Module:** M13
- **Trigger:** Loan saved, EMI matched, new loan added
- **Logic:** Loan types: EMI (schedule generated, each EMI split into interest and principal), bullet, or flexible prepayment (no schedule; each repayment recorded; balance and days to final due date shown). Total debt = principal outstanding on all loans + drawn cash credit. Warn if total debt > ₹45,00,000 (Mesa aggregate cap).
- **Worked example:** Mesa ₹12,00,000 disbursed 4 Jun 2026, flexible: repay any time within 18 months.
- **Confidence:** High on logic. Interest terms from the Mesa agreement to be entered.

## BR-29 - Related party transactions

- **Module:** M02
- **Trigger:** Bank row from/to Newera Living, founders, Mesa
- **Logic:** Tagged Related Party with sub-type (business transfer, director loan, capital); the sub-type starts as Undecided until it is agreed with the CA. Shown in a separate report for the CA because they need specific accounting and disclosure.
- **Worked example:** ₹7,00,000 from Newera Living on 19 Aug: not income and not an own-account transfer. Needs a decision with the CA (business transfer consideration or loan).
- **Confidence:** High

## BR-30 - Document numbering

- **Module:** M09/M04
- **Trigger:** Document issued (not when drafted)
- **Logic:** Next number taken from the series inside a database transaction. Tax invoice and credit note numbers: unique per FY, consecutive, max 16 characters, only letters, digits, '-' and '/'. Numbers are never reused, including for cancelled documents. Series reset on 1 April: a per-FY series gets a new row for the new FY starting at 1, with the same pattern. Two people issuing at once get consecutive numbers (the series row is locked during the issue).
- **Worked example:** ELPL/26-27/0001 = 15 characters.
- **Confidence:** High

## BR-31 - Financial year

- **Module:** M01
- **Trigger:** Any date
- **Logic:** FY runs 1 April to 31 March. FY label for 12 Oct 2026 = 26-27. Quarter: Q1 Apr-Jun, Q2 Jul-Sep, Q3 Oct-Dec, Q4 Jan-Mar.
- **Worked example:** FY 26-27 starts 1 Apr 2026; Entelechy was incorporated 22 May 2026, so April and most of May show zero.
- **Confidence:** High

## BR-32 - Tax invoice content

- **Module:** M09
- **Trigger:** Issue
- **Logic:** Must contain: supplier name, address, GSTIN; consecutive invoice no; date; recipient name, address and GSTIN (if registered); ship-to address if different; place of supply with state name and code; HSN per line; description; quantity and unit; value; discount; taxable value; tax rate and amount per tax head; total; whether reverse charge applies; signature. Unregistered recipient: name, address and state still captured above the threshold in settings.
- **Worked example:** -
- **Confidence:** High. [Verify] B2C unregistered-recipient threshold with CA.

## BR-33 - Proforma to tax invoice

- **Module:** M09
- **Trigger:** Convert
- **Logic:** Lines copied; PI marked Converted (fully or partly by quantity); advance receipts on the PI applied to the new invoice. For goods, advance received is not taxed at receipt; tax arises on the invoice.
- **Worked example:** -
- **Confidence:** Likely. [Verify] treatment of advances for goods with CA.

## BR-34 - Cancellation and credit notes

- **Module:** M09
- **Trigger:** User cancels or raises credit note
- **Logic:** Draft: delete allowed. Issued but not yet reported in GSTR-1: cancel allowed, number kept and stamped Cancelled. Already reported: no cancel; raise credit note referencing the invoice. Credit notes have their own series and reduce receivable and output GST.
- **Worked example:** -
- **Confidence:** High

## BR-35 - Cash view vs accrual view

- **Module:** M12
- **Trigger:** Dashboard toggle
- **Logic:** Cash view: bank rows by transaction date and category. Accrual view: vendor bills by bill date and sales invoices by invoice date, plus bank rows with no document. Never add both for the same item (bank rows linked to a document are excluded from accrual view). As built (Step 12): a bill counts at its cost, taxable value + other charges, plus its GST only when input credit cannot be claimed (itc_eligible off); debit notes add, credit notes subtract; cancelled and replaced documents never count. A bank row linked to a vendor payment is left out of the accrual view (advances included: the cost appears when the tax invoice arrives). Approved founder claims count in both views on the expense date (BR-27). Sales invoices join with Phase 3.
- **Worked example:** Saiffi bill 040 dated 24 Jul 2026: taxable ₹9,80,000, IGST ₹1,76,400 (credit claimable), TDS ₹19,600; ₹11,36,800 paid on 24 Jul and matched to its bank row. Cash view: capex ₹11,36,800 in July (what left the bank). Accrual view: capex ₹9,80,000 in July, once; the bank row is not added.
- **Confidence:** High

## BR-36 - Period lock

- **Module:** M01
- **Trigger:** Month locked
- **Logic:** No create/edit/delete of records dated in a locked month. Admin unlock requires a reason and is audited. Lock requires zero rows in Review for that month, and only a month that has ended can be locked.
- **Worked example:** -
- **Confidence:** High

## BR-37 - Burn and runway

- **Module:** M12
- **Trigger:** Dashboard
- **Logic:** Gross burn (month) = Operating Expense + COGS + Interest outflows. Net burn = gross burn - Operating Income receipts. Runway (months) = cash in business current accounts today (excluding cash credit headroom, BR-50) / average net burn of last 3 complete months. Capex and loan principal shown as separate lines, not in burn. If net burn <= 0, runway shows 'Cash positive'. Money in transit (BR-45) is shown next to cash but not added to it. Rows that are ignored or still waiting for review are left out; a split row counts by its lines. Runway is rounded down to one decimal.
- **Worked example:** IDFC fixture as of 13 Oct 2026, after review (Innov8 -> Virtual Office, salaries -> Intern Salary, the Rs 1,180 out-and-back pair ignored). Cash Rs 4,10,869. Net burn Jul Rs 0 (Saiffi tooling is capex), Aug Rs 12,980 (Innov8; Micro Instruments is capex, TDS is tax), Sep Rs 40,152 (R&D Rs 30,152 + salary Rs 10,000; VideAim patent is capex). Average Rs 17,710.67, runway 4,10,869 / 17,710.67 = 23.1 months. Capex FY Rs 15,03,608 and funding Rs 13,00,000 are shown apart.
- **Confidence:** High

## BR-38 - Receipt matching

- **Module:** M10
- **Trigger:** Bank credit imported
- **Logic:** Suggest invoices whose outstanding equals the credit amount (or credit + plausible TDS at 1%/2%/10%), customer name fuzzy-matches the narration, within 60 days of due date. Show top 3 with confidence. If credit is less than outstanding by exactly a TDS rate, suggest 'record TDS deducted by customer'.
- **Worked example:** Invoice ₹1,18,000 (taxable ₹1,00,000 + GST ₹18,000). Hotel deducts 2% on taxable = ₹2,000 and pays ₹1,16,000. App suggests: receipt ₹1,16,000 + TDS receivable ₹2,000, invoice fully settled.
- **Confidence:** High

## BR-39 - Razorpay settlement

- **Module:** M10
- **Trigger:** Settlement imported
- **Logic:** Settlement amount (bank credit) = sum of captured payments - refunds - fees - GST on fees (- adjustments). Creates: gross receipts per order/invoice, fee expense (Bank Charges / Payment Gateway), GST on fees (input credit). One bank row matched to one settlement batch. As built (Step 13): settlements are imported, tied out (BR-47) and matched to one bank credit, which is categorised Revenue / Razorpay at its net. Fees and GST on fees are shown per settlement; booking them as expense and input credit comes with receivables (M10, Phase 3).
- **Worked example:** -
- **Confidence:** High

## BR-40 - Shiprocket COD remittance

- **Module:** M10
- **Trigger:** Remittance imported
- **Logic:** Remittance amount = sum of COD collected for listed AWBs - any freight/charges deducted (if that setting is on). Each AWB maps to a CRM order and its invoice.
- **Worked example:** -
- **Confidence:** Likely. Confirm your Shiprocket remittance settings (Q13).

## BR-41 - TDS deducted by customers

- **Module:** M10/M07
- **Trigger:** Receipt with TDS
- **Logic:** Receipt + TDS deducted = amount allocated to the invoice. TDS receivable tracked per customer per quarter and matched to Form 26AS/AIS later.
- **Worked example:** -
- **Confidence:** High. Rare for Entelechy customers; switched off per customer by default.

## BR-42 - E-way bill field

- **Module:** M09
- **Trigger:** Invoice for goods above threshold
- **Logic:** If invoice value of a consignment exceeds the e-way bill threshold in settings, show a warning and a field for the e-way bill number. Generating the e-way bill stays outside the app in v1.
- **Worked example:** -
- **Confidence:** High on need. [Verify] threshold (₹50,000 consignment value) with CA.

## BR-43 - Audit trail

- **Module:** M16
- **Trigger:** Any create/update/delete
- **Logic:** Store table, record ID, field, old value, new value, user, timestamp, reason (if required). Issued documents, payments and approvals can never be hard-deleted.
- **Worked example:** -
- **Confidence:** High

## BR-44 - Order payment status

- **Module:** M18
- **Trigger:** Any change to the order, gateway payment, remittance, settlement or bank match
- **Logic:** Route decided by the CRM order's payment method. As built (Step 13, Q35): FREE or replacement: nothing to collect; Amazon: marketplace, not tracked; COD: Shiprocket COD; RAZORPAY, and UPI on a Shopify order (Magic Checkout records UPI for prepaid Shopify orders): Razorpay; other UPI and bank transfer: direct. Expected amount: COD to collect from bloc-inv for COD (else the balance due), the order total otherwise. Razorpay (prepaid): Awaiting payment, then Paid at gateway, then Settled, then In bank. Shiprocket COD: Awaiting delivery, then Delivered (awaiting remittance), then Remitted, then In bank. Direct (UPI / bank transfer / cash / credit customers): Awaiting payment (or Due date for credit), then In bank. End states outside the route: Refunded, RTO / Cancelled (nothing expected), Written off. Flags on top of any state: Overdue (BR-45) and Discrepancy (BR-46). A Razorpay order is Refunded when refunds reach the captured amount; a cancelled order with nothing collected is RTO / Cancelled; a direct order is In bank once linked credits reach the order total less the tolerance. Advances on COD orders are shown, not yet tracked separately (Q35).
- **Worked example:** COD order ₹1,499 delivered 10 Oct: 'Delivered, awaiting remittance'. Shiprocket remittance on 15 Oct includes its AWB: 'Remitted'. Remittance credit hits IDFC 15 Oct and is matched: 'In bank'.
- **Confidence:** High

## BR-45 - Expected bank date and overdue

- **Module:** M18
- **Trigger:** Daily
- **Logic:** Razorpay: capture date + settlement cycle (setting, default 3 working days, matching the 2-3 days you see). COD: delivery date + remittance cycle (setting, taken from your Shiprocket account). Settlement or remittance to bank: same or next working day. Overdue when today > expected date + grace days (setting, default 2). Bank holidays and weekends skipped via a holiday list in settings. As built (Step 13): all cycles in working days; an event on a non-working day counts from the next working day (Saturday + 1 = Monday); overdue from expected + grace working days, inclusive (the worked example). COD remittance cycle default 5 working days [Verify] (Q24). Delivered date from bloc-inv.
- **Worked example:** Razorpay payment captured Friday 9 Oct: expected settlement Wednesday 14 Oct (3 working days), overdue from Friday 16 Oct.
- **Confidence:** High on logic. Cycle values to be read from your Razorpay and Shiprocket accounts (Q24).

## BR-46 - Discrepancy detection

- **Module:** M18
- **Trigger:** Each sync and each bank import
- **Logic:** Raise a discrepancy when: 1) order amount differs from amount captured or COD collected (tolerance ₹1, setting); 2) gateway payment has no matching CRM order, or CRM prepaid order has no gateway payment; 3) payment captured but missing from settlements past expected date; 4) fee + GST on fee is above expected rate x gross + tolerance; 5) settlement or remittance not matched to a bank credit within 2 working days; 6) bank credit amount differs from settlement net; 7) refund in Razorpay but order not cancelled/returned in CRM, or the reverse; 8) two payments on one order; 9) COD delivered but not remitted past expected date; 10) COD remitted amount differs from order COD amount. Each has a type code, amount and suggested action. As built (Step 13): 11) settlement lines do not add up to the settlement net (BR-47 level 2); type 1 also for BR-47 level 1 and type 6 for level 3; type 2 both ways (a prepaid order with no payment after the grace days, and a Razorpay payment naming no order after the grace days); type 4 compares Razorpay fees with GST against gross x rate x (1 + GST rate) + tolerance. Checks cover the last 180 days (and not before Settings > Track from). A problem that stops failing is Cleared by itself; a Resolved one keeps its action and note.
- **Worked example:** CRM order ₹2,998, Razorpay captured ₹2,499 (customer used a coupon not recorded in CRM): type 1, amount ₹499, action 'correct CRM order or chase customer'.
- **Confidence:** High

## BR-47 - Three-level tie-out

- **Module:** M18
- **Trigger:** Settlement or remittance imported and bank matched
- **Logic:** Level 1: each order amount = its gross in the settlement/remittance. Level 2: sum of lines (gross - fees - GST on fees - refunds +/- adjustments) = settlement net. Level 3: settlement net = bank credit. Each level shows its difference; any non-zero difference creates a discrepancy. As built (Step 13): level 1 uses lines linked to an order (Razorpay: the order total; COD: COD to collect); level 3 waits until a bank credit is linked.
- **Worked example:** Illustrative only: 3 Razorpay orders ₹1,499 + ₹2,998 + ₹1,499 = ₹5,996 gross; fees at 2% = ₹119.92; GST 18% on fees = ₹21.59; net ₹5,854.49 must equal the IDFC credit.
- **Confidence:** High

## BR-48 - D2C invoice timing and RTO

- **Module:** M09
- **Trigger:** CRM order moves to Shipped (Shiprocket pickup, or marked Shipped manually for Porter / self-delivery)
- **Logic:** For goods, the tax invoice is issued at or before removal of goods, so the D2C invoice is issued when the order ships, not on delivery. Prepaid orders cancelled before shipping: no invoice, refund only. Orders RTO'd or cancelled after shipping: credit note against the invoice (auto-drafted, F103).
- **Worked example:** COD order shipped 8 Oct, invoice ELPL/26-27/00042 issued 8 Oct; RTO on 14 Oct creates credit note ELCN/26-27/0005.
- **Confidence:** High on timing. [Verify] RTO credit note handling with CA.

## BR-49 - B2B vs B2C invoice

- **Module:** M09
- **Trigger:** Invoice created
- **Logic:** Customer (or outlet) has a valid GSTIN: B2B invoice with recipient GSTIN; place of supply from ship-to state. No GSTIN: B2C invoice with name, address and state; place of supply = delivery state. Same number series for both. A HoReCa outlet without a GSTIN on file gets a B2C invoice, so the app prompts sales to capture GSTIN first, because a B2B customer cannot claim input tax credit on a B2C invoice.
- **Worked example:** Hotel with GSTIN 29XXXXX: B2B. Home customer in Pune: B2C, IGST, place of supply 27 (Maharashtra).
- **Confidence:** High

## BR-50 - Cash credit accounts

- **Module:** M01/M02/M12
- **Trigger:** CC account added or transaction on it
- **Logic:** CC balance = amount drawn (liability). Cash = sum of current account balances. CC headroom = min(sanctioned limit, drawing power) - drawn. Liquidity = cash + headroom. Runway uses cash only; liquidity shown alongside. CC interest debits = Interest. Moves between IDFC and the CC = Transfer (BR-06). Drawn CC balance counts toward total debt for the Mesa cap (Q14).
- **Worked example:** Sanctioned ₹20L, drawing power ₹15L, drawn ₹6L: headroom ₹9L.
- **Confidence:** High
