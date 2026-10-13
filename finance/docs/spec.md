# Entelechy Finance App - Spec

> Source of truth for WHAT the app does. Business logic lives in `docs/rules.md`, open decisions in `docs/open-questions.md`, history in `docs/changelog.md`.
> Each `## ` heading below maps 1:1 to a tab in the Google Sheet "Entelechy Finance App - PRD v1"; `scripts/sync-spec-to-sheet.ts` pushes these tables to the sheet on every merge to main.
> Table rules: one row per item, `<br>` for line breaks inside a cell, escape pipes as `\|`. Keep column headers exactly as they are (the sync relies on them).

## README

Purpose, scope, principles, legend and key decisions.

| Section | Detail |
|---|---|
| What this app is | A single place to run day-to-day finance for Entelechy: every bank transaction categorised, vendors onboarded, POs raised, vendor bills and payments tracked, TDS tracked, customer proformas and tax invoices issued, receivables collected, and dashboards on income and expense by category. It replaces the Financials Master Google Sheet (Master Ledger, PO Register, Vendor Invoice Register, Payment-Out Log, AP Dashboard, Category Map). |
| What this app is not (out of scope v1) | GST return filing (GSTR-1/3B), e-invoice IRN generation, e-way bill generation, ITR, ROC/MCA filings, payroll processing, statutory audit, full double-entry general ledger, balance sheet. The CA keeps the statutory books (Zoho Books or Tally). This app produces a monthly CA export pack so the CA does not have to rebuild anything. |
| Important boundary | A tax invoice is a legal document even if filing is out of scope. If this app issues tax invoices, its invoice series is the legal series and must follow GST invoice rules (see Business Rules BR-30 to BR-34). The same series must never also be issued from Zoho, Shopify or anywhere else. Decision D2 below. |
| Users | v1: Rishabh and Arnav only (both Admin), signing in with email and password like the Bloc CRM. Sales issue invoices from the CRM through the invoice service (F105). CA receives a monthly Excel export. Other roles stay in the model for later. |
| Design principles | 1. Bank statement is the source of truth for cash. Every rupee in or out ends up categorised and, where relevant, matched to a document.<br>2. Documents drive status. A PO, bill or invoice status is computed from what is linked to it (bills, payments, receipts), not typed by hand.<br>3. Nothing is deleted. Cancel, reverse or credit-note instead, with an audit trail.<br>4. Masters are owned by one system each. Customers live in the CRM, products in the Inventory app, vendors and money in this app.<br>5. Every amount on a dashboard can be clicked down to the transactions behind it.<br>6. Tax rates, TDS sections, thresholds and numbering formats are data in settings, never hard-coded. Tax rules change (new Income-tax Act 2025 applies from 1 Apr 2026). |
| How to read this workbook |  |
| Module Map | The 18 modules, what each replaces today, priority and dependencies. Start here. |
| Feature WBS | Feature breakdown in the same style as the BLOC CRM sheet: Module > Page > Component > Sub-feature, with logic, priority and status. |
| Data Model | Every table and field: type, required, source (manual, auto-filled, computed, synced), validation and an example from real data. |
| Status Flows | Status lists and allowed transitions for vendors, POs, bills, payments, bank transactions, proformas, invoices, TDS. |
| Business Rules | The calculation and decision logic (TDS, GST split, matching, ageing, numbering, approvals) with worked examples. Each rule has an ID referenced from the WBS. |
| Documents & Numbering | PO, Proforma, Tax Invoice, Credit Note, Payment and Receipt vouchers: numbering format, mandatory content, PDF layout notes. |
| Dashboards & Reports | Every metric with its exact definition and formula, filters and drill-down. |
| Integrations | How this app connects to the CRM, Inventory app, Shiprocket, Razorpay, Shopify, bank statements, Google Drive and the CA. |
| Roles & Access | Who can view, create, approve and export what. |
| Category Master | Income and expense categories (from the current Category_Map) with the new Nature field that keeps capex, loans and equity out of the P&L view. |
| Open Questions | Decisions I need from you. Each has a default that v1 assumes until answered. |
| Change Log | Version history of this document. |
| Legend |  |
| P0 | Must have for v1 launch (replaces the current sheet). |
| P1 | v1 if time allows, otherwise first update after launch. |
| P2 | Later. Documented now so the data model leaves room for it. |
| (*) | Compulsory field |
| (O) | Optional field |
| (AF) | Auto-filled (from a master, API or another record) |
| (C) | Computed by the system, not editable |
| (CTA) | Button / action |
| (SYNC) | Comes from another system (CRM, Inventory, Razorpay etc.) |
| [Verify] | Tax or legal point to confirm with the CA before build. Confidence noted in the rule. |
| Key decisions (recommended defaults) |  |
| D1 - Accounting depth | Recommended: v1 is a categorised cash ledger plus document sub-ledgers (payables, receivables, TDS, advances, loans). No double-entry general ledger. Reason: double entry is where Zoho/Tally complexity comes from, the CA maintains the statutory books anyway, and your dashboards only need categorised cash plus open balances. Every record still carries Nature and Category so it maps cleanly to ledger accounts in the CA export. Revisit if you want a balance sheet inside the app. |
| D2 - Who issues tax invoices | Decided: this app issues all proformas and tax invoices, both B2B and D2C, on one number series. The customer's GSTIN decides B2B vs B2C (BR-49). D2C invoices are created automatically when the CRM order ships (BR-48). Nothing else (Shopify, Zoho) may issue invoices on this series. |
| D3 - Bank data | Recommended: upload bank statement files (IDFC XLS/CSV first) with a parser and duplicate check. Direct bank APIs and Account Aggregator need licences or partner integrations and are not worth it at current volume (about 30-60 transactions a month). |
| D4 - Architecture | Decided: TypeScript, Postgres, and the same stack and layout as the Bloc monorepo (Express 5 + Prisma backend, React 19 + Vite frontend, `prisma db push`), so the app moves into Bloc as `finance/` unchanged. Finance is built as its own app first and shares the CRM database (Bloc's EC2 Postgres, `bloccrm`) later. Finance tables live in their own `finance` schema from day one. Finance reads CRM data through one CRM reader module in its backend (stub tables until the apps share a database), not through database views, because views over CRM tables would block the CRM's `prisma db push` when it changes a column. |
| D5 - Entities | Decided: Entelechy Labs (ELPL) only. Newera Living history stays in the old sheets. entity_id kept in the schema anyway. |
| D6 - Capex vs expense | Recommended: tooling, moulds and dies are Capex, not Expense. Today the Master Ledger books ₹11.37L (Saiffi), ₹2.85L (Micro Instruments) and ₹62.6K (Valco) tooling as Expense, which overstates monthly burn and opex in any dashboard. The new Nature field fixes this. |
| D7 - Order-to-bank visibility | Decided: every CRM order is tracked until its money is in the bank, across Razorpay (2-3 day settlement), Shiprocket COD (remitted after delivery) and direct payments, with automatic discrepancy checks (M18). |
| D8 - Approvals and banks | Decided: approval limits switched off at launch, kept as a setting. IDFC is the only business account today; a PNB cash credit account can be added later without changes (BR-50). |
| D9 - Build order | Decided (13 Oct 2026): finish Phase 1 (M0-M7), then Phase 2 (buy side, TDS, order-to-bank), then Phase 3 (customers, proformas, tax invoices, receivables). Invoicing is not pulled forward. Before the invoice series is switched on, the CA confirms which entity invoices customers (the old proforma sheet still issues under Newera Living). |
| D10 - No migration of the old Master Ledger | Decided (13 Oct 2026): the Financials Master history is not imported (F023 dropped). No descriptions, categories or notes are carried over; the founders categorise and describe transactions in the app. Categories and sub-categories are added and edited in the app (Categories page, or 'New sub-category' while categorising). The seeded default rules set a category only, never a description, and can be switched off. |
| D11 - File storage until Google Cloud is set up (temporary) | Decided (13 Oct 2026): until a Google Cloud service account exists, attachments are stored on the app server in backend/.files with the same /Finance/{FY}/{Module}/{Record} layout (FILE_STORAGE=local). To switch to Google Drive: create the service account, create a folder in a Shared Drive and share it with the service account as Content manager, set FILE_STORAGE=drive, GOOGLE_SERVICE_ACCOUNT_JSON and DRIVE_ROOT_FOLDER_ID, then move the existing local files into Drive (one-off script). The database keeps where each file is, so both kinds work during the move. |
| D12 - Environments | Decided (13 Oct 2026): code in github.com/rishabh-ag1/finance (folder finance/) until it moves into the Bloc monorepo as finance/. Development: Postgres 17 on the founder's PC (port 5433), databases entelechy_finance and entelechy_finance_test. Production target: Bloc's EC2 Postgres (bloccrm), schema finance, PM2. Bloc repo is reference only; never changed from this project. |
| D13 - Pending setup (to finish when moving to Google Cloud) | Open checklist: 1) Google Cloud service account + Shared Drive folder, then switch file storage to Drive (D11). 2) The same service account shared on this Google Sheet as Editor, plus GitHub secrets SPEC_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON, so docs sync to this sheet on every merge (until then the sheet is updated by hand from the repo). 3) GSTINAPI_KEY (the CRM's gstinapi.in key) in the backend settings for GSTIN 'Fetch'. 4) Postgres as a Windows service on port 5433 on the development PC, or the shared Bloc database. 5) A real IDFC statement download before the first real import (Q30). |

## Module Map

Modules, what each replaces, priority, build phase, dependencies and owned records.

| ID | Module | Purpose | Replaces today | Primary users | Priority | Phase | Depends on | Owns these records |
|---|---|---|---|---|---|---|---|---|
| M01 | Settings & Masters | Company profile, financial year, bank accounts, tax rates, TDS sections, payment terms, number series, approval limits, period lock. | ⚙️ Config tab | Founders | P0 | 1 | - | company, bank_account, tax_rate, tds_section, number_series, approval_rule, period_lock |
| M02 | Bank & Cash Ledger | Import bank statements, parse narrations, remove duplicates, auto-categorise, split, pair internal transfers, match to bills/invoices/TDS/loans. The new Master Ledger. | Raw Bank Import, Master Ledger | Finance team | P0 | 1 | M01, M15 | bank_import_batch, bank_txn, txn_split, categorization_rule |
| M03 | Vendors | Vendor onboarding with GSTIN/PAN validation, bank details, TDS profile, MSME status, documents, vendor 360 view. | Vendor columns repeated in PO and Invoice registers | Finance team, founders | P0 | 1 | M01 | vendor, vendor_contact, vendor_bank_account |
| M04 | Purchase Orders | Create PO from template, approve, generate PDF, send, amend with revision, track billed vs ordered. PO Register view. | PO Register | Founders, ops | P0 | 2 | M03, M11 | purchase_order, po_line, po_revision |
| M05 | Vendor Documents (Bills) | Capture quotes, proformas and tax invoices from vendors, link to PO, GST break-up, TDS computed, due date. Vendor Invoice Register view. | Vendor Invoice Register | Finance team | P0 | 2 | M03, M04, M07 | vendor_document, vendor_document_line |
| M06 | Payables & Payments Out | Payment requests, approval, recording payment, allocating to bills or as advance, adjusting advances when tax invoice arrives, ageing, MSME 45-day alerts. | Payment-Out Log, Accounts Payable Dashboard | Finance team, founders (approve) | P0 | 2 | M02, M05 | payment_out, payment_allocation, vendor_advance |
| M07 | TDS Tracker | TDS deducted per bill/payment, payable by month, challan deposit matched to bank (OPT/CBDT lines), quarterly 26Q view, 16A issued status, customer TDS receivable. | TDS-2026-27.xlsx (separate file) | Finance team, CA | P0 | 2 | M01, M05, M06, M02 | tds_entry, tds_challan, tds_receivable |
| M08 | Customers | Read customers, companies, outlets, billing and shipping addresses, GSTIN from the CRM. Finance-only fields (credit terms, credit limit, TDS behaviour) stored here. | CRM company page | Finance team, sales | P0 | 3 | CRM integration | customer_finance_profile (customer itself is owned by CRM) |
| M09 | Sales Documents | Quotation (P2), Proforma Invoice, Tax Invoice, Credit Note, Delivery Challan (P2). Create from CRM order or manually, PDF, send, convert PI to invoice. | Made outside the system today (confirm, Q3) | Sales, finance team | P0 | 3 | M08, M11, M01 | sales_document, sales_document_line |
| M10 | Receivables & Collections | Record receipts, match bank credits, Razorpay settlements and Shiprocket COD remittances to invoices, customer TDS, ageing, reminders. | Nothing structured today | Finance team | P0 | 3 | M02, M09 | payment_in, receipt_allocation, settlement_batch |
| M11 | Products & Price List | Read products, SKUs, HSN, GST rate, unit from the Inventory app. Finance keeps price lists (MRP, HoReCa price, distributor price) and purchase item catalogue for POs. | Pricing scattered across sheets | Founders | P0 | 1 | Inventory integration | price_list, price_list_item, purchase_item |
| M12 | Dashboards & Analytics | Cash position, burn, runway, income and expense by category and month, AP/AR ageing, TDS due, PO status, vendor and customer 360. | Accounts Payable Dashboard, P&L tab, Burn/Runway tab | Founders | P0 | 1 (slice), 2, 3 | M02-M10 | None (read only) |
| M13 | Funding & Loans | Equity and share application money, loans (Mesa ₹12L), repayment schedules, interest vs principal split, covenant check against the Mesa ₹45L aggregate debt cap. | Nothing structured today | Founders | P1 | 3 | M02 | funding_round, capital_receipt, loan, loan_schedule |
| M14 | Founder Expenses & Reimbursements | Expenses paid from personal accounts (HDFC, SBI, Axis, BOM), receipts, reimbursement owed to each founder, settlement. | Payment Source column (Arnav / Rishabh) | Founders | P1 | 2 | M02 | expense_claim, reimbursement |
| M15 | Documents Vault | Every record can hold files (PO PDF, vendor invoice, payment proof, challan). Stored in Google Drive folders the app creates, linked by ID; in a local folder with the same layout until Google Cloud is set up (D11). | Drive links typed into sheet cells | Everyone | P0 | 1 | Google Drive | attachment |
| M16 | Users, Roles & Audit | Login (email and password, the same as the Bloc CRM, D4), roles, approval rights, full audit log of who changed what. | - | Founders | P0 | 1 | - | user, role, audit_log |
| M17 | CA Export Pack | Monthly export of categorised ledger, vendor bills, sales invoices, TDS register, receipts, payments in CSV/XLSX, plus Tally/Zoho import format (P2). | Manual sharing with CA | Finance team, CA | P1 | 3 | All | export_job |
| M18 | Order-to-Bank Reconciliation | Track every CRM order until its money is in the bank: Razorpay payments and settlements, Shiprocket COD remittances, direct UPI/bank payments. Money in transit, overdue settlements and discrepancies at order level. | Nothing today (checked by hand, if at all) | Founders, finance team | P0 | 2 | M02, M10, CRM, Razorpay, Shiprocket | gateway_transaction, settlement_batch, settlement_line, recon_discrepancy, order_payment_status |
| Build phases |  |  |  |  |  |  |  |  |
| Phase 1 | Foundations: M01, M02, M03, M11 (read), M15, M16. Outcome: bank statements imported and categorised in the app; Financials Master Master Ledger retired. |  |  |  |  |  |  |  |
| Phase 2 | Buy side and collections visibility: M04, M05, M06, M07, M14, M18, M12 (cash, AP and money-in-transit dashboards). Outcome: PO Register, Vendor Invoice Register, Payment-Out Log, TDS file retired; every CRM order traced to the bank. |  |  |  |  |  |  |  |
| Phase 3 | Sell side: M08, M09, M10, M13, M17, M12 (AR and full dashboards). Outcome: proformas and tax invoices issued from the app, receivables tracked, CA pack generated. |  |  |  |  |  |  |  |

## Feature WBS

Every feature. IDs F### are permanent; never renumber or reuse. Rules column refers to docs/rules.md, Open Q to docs/open-questions.md.

| ID | Module | Page / Screen | Component | Sub-feature | Description & logic | Type | Priority | Rules | Open Q | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| F001 | M01 Settings | Company Profile | Legal details | Name, CIN, PAN, TAN, GSTIN, Udyam, registered address, logo, signature image | Shown on every PDF. GSTIN state code (29) drives CGST/SGST vs IGST. Signature image used on PO and invoice PDFs. | Field | P0 | BR-20 |  | Built (M1) |
| F002 | M01 Settings | Company Profile | Financial year | FY start month, current FY, FY label format (26-27) | FY runs April to March. Entelechy's first FY (26-27) starts 1 Apr 2026 with zero activity until incorporation on 22 May 2026; April shows as zero, not missing. | Field | P0 | BR-31 | Q12 | Built (M1) |
| F003 | M01 Settings | Bank Accounts | Account list | Add/edit account: bank, account no (masked in UI), IFSC, type (Business current / Cash credit / Founder personal / Loan / Wallet), owner, opening balance and date, statement format. Cash credit adds: sanctioned limit, drawing power and as-of date, interest rate, renewal date. | IDFC current account is the only business account today; a PNB cash credit account is expected. Adding a bank needs only a new account record and a statement parser for that bank's format, nothing else changes. A cash credit balance is money drawn (a liability), not cash (BR-50). Founder personal accounts are only used to record founder-paid expenses (M14). Razorpay and Shiprocket can be added as type Wallet. | Field | P0 | BR-01 | Q6 | Built (M1) |
| F004 | M01 Settings | Tax Masters | GST rates | Rate list with effective dates: 0/5/12/18/28 until 21 Sep 2025, then 0/5/18/40 from the Sep 2025 rationalisation [Verify] | Rates are data with effective-from dates so a rate change does not rewrite old invoices. Ending a rate keeps it on old documents. | Field | P0 | BR-20 | Q29 | Built (M1) |
| F005 | M01 Settings | Tax Masters | TDS sections | Section code (old and new Act), nature of payment, rate for individual/HUF, rate for others, single-payment threshold, FY aggregate threshold, no-PAN rate, effective dates | Seeded with the sections you use today (contract work, professional/technical fees, rent, commission). CA must confirm values before go-live because the Income-tax Act 2025 renumbered sections from 1 Apr 2026. | Field | P0 | BR-12, BR-13 | Q15 | Built (M1) |
| F006 | M01 Settings | Number Series | Series setup | Prefix, FY token, padding, next number, reset rule, per document type | Numbers are assigned only when a document is issued, inside a database transaction, so there are no gaps or duplicates. | Field | P0 | BR-30 | Q8 | Built (M1) |
| F007 | M01 Settings | Approval Rules | Thresholds | Amount bands for PO approval and payment approval, approver role per band | Provision only. Approvals are switched off at launch: any Admin can issue POs and record payments. The band table stays in Settings so limits can be switched on later without code changes. | Field | P0 | BR-26 | Q9 | Built (M1) |
| F008 | M01 Settings | Period Lock | Month close | Lock a month after review; locked months cannot be edited except by admin with reason | Prevents dashboards for closed months changing silently. Unlock is logged in audit. | CTA | P1 | BR-36 |  | Built (M1) |
| F009 | M01 Settings | Payment Terms | Terms list | Advance, On receipt, Net 7, Net 15, Net 30, Net 45, custom days | Default terms set per vendor and customer, copied to documents, editable per document. | Field | P0 | BR-23 |  | Built (M1) |
| F010 | M02 Bank Ledger | Statement Import | Upload | Upload CSV or XLSX statement, pick account, preview parsed rows (new / already imported / not recognised / locked month), then confirm | Parser per bank format (IDFC first, parser_format idfc_v1). The header row is found by its column names; the account number printed above the table must match the chosen account (last 4 digits). Newest-first exports are put in date order. Old .xls and PDF not read yet (PDF P1). | CTA | P0 | BR-01, BR-02 | Q6, Q30 | Built (M2) |
| F011 | M02 Bank Ledger | Statement Import | Duplicate check | Skip rows already imported; show count of new vs duplicate rows before confirming | Duplicate key includes running balance so two genuine identical payments on the same day are not dropped. | Auto | P0 | BR-01 |  | Built (M2) |
| F012 | M02 Bank Ledger | Statement Import | Balance check | Opening balance + credits - debits must equal closing balance of the file and continue from the last imported balance | If there is a gap (missing days) the batch is flagged and the user is told which dates are missing. | Auto | P0 | BR-03 |  | Built (M2) |
| F013 | M02 Bank Ledger | Statement Import | Narration parsing | Extract mode (IMPS/NEFT/RTGS/UPI/IFT/OPT/Ecom/ATM/charges), UTR, counterparty name, counterparty IFSC, remark | Parsed fields are stored separately from the raw narration, which is never edited. | Auto | P0 | BR-02 |  | Built (M2) |
| F014 | M02 Bank Ledger | Transactions | Ledger list | Columns: date, account, counterparty, description, category, sub-category, nature, in, out, balance, match status, linked document, attachments | Filters: account, date range, category, nature, status, amount range, counterparty. Filters are kept in the page address, so a filtered view can be bookmarked or shared (saved views). Running totals of inflow, outflow and net for the filter (like the current top row). | View | P0 |  |  | Built (M3) |
| F015 | M02 Bank Ledger | Transactions | Auto-categorisation | Suggest category, sub-category, nature, vendor/customer for each new row | Order: 1) exact match to an expected payment or receipt, 2) counterparty mapping from vendor/customer master, 3) keyword rules, 4) last category used for this counterparty, 5) Review. Suggestions shown with the reason. | Auto | P0 | BR-04, BR-05 |  | Built (M3) |
| F016 | M02 Bank Ledger | Transactions | Review queue | Inbox of uncategorised or suggested rows; accept, change or bulk-accept | Count shown on home dashboard. A month cannot be locked while rows are in Review. | View | P0 | BR-36 |  | Built (M3) |
| F017 | M02 Bank Ledger | Transactions | Rules manager | Create rule from a transaction: if narration contains / counterparty is / amount between, then set category, sub-category, nature, party | Rules have priority order and a test button showing how many past rows they would match. Seeded with default rules taken from decisions in this spec: OPT/CBDT (BR-05), Neos Kosmos loan (A6), Newera Living (A8, BR-29), Saiffi / Micro Instruments / Valco tooling (A7, D6), VideAim patent, Quick Shape and Makenica prototyping, Trinity NDT testing and founder funds (Category Master notes). Rules are switched off, never deleted. | CTA | P1 | BR-05 |  | Built (M3) |
| F018 | M02 Bank Ledger | Transactions | Split | Split one bank row into several lines with their own category, party and document | Lines must add up to the bank amount. Example: one payment covering two bills. | Popup | P0 | BR-07 |  | Built (M3) |
| F019 | M02 Bank Ledger | Transactions | Transfer pairing | Detect and pair transfers between own accounts | Paired transfers are Nature = Transfer and excluded from income/expense. | Auto | P0 | BR-06 |  | Built (M3) |
| F020 | M02 Bank Ledger | Transactions | Match to document | Link a bank row to a payment out, receipt, TDS challan, loan instalment, capital receipt | Matching creates or confirms the payment record so the bill or invoice status updates. | CTA | P0 | BR-08, BR-38 |  | Spec drafted |
| F021 | M02 Bank Ledger | Transactions | Notes & attachments | Free-text note, attach proof |  | Field | P0 |  |  | Built (M3 notes, M5 attachments) |
| F022 | M02 Bank Ledger | Cash Entries | Manual entry | Record cash or wallet transactions not on a bank statement | Must have an attachment or note. Shown with a 'manual' badge. | CTA | P1 |  |  | Spec drafted |
| F023 | M02 Bank Ledger | Migration | Import from Financials Master | One-time import of Master Ledger rows with category, sub-category and Sync Key | Existing categories mapped to the new Category Master; tooling rows re-tagged as Capex; capital and Mesa loan rows re-tagged as Financing. | CTA | P0 | BR-04 |  | Dropped (D10: founders categorise in the app; nothing migrated) |
| F030 | M03 Vendors | Vendor List | List | Name, type, GSTIN, PAN, state, MSME, TDS section, outstanding payable, advances, last payment | Search and filter. Vendor status chip. | View | P0 |  |  | Built (M4) |
| F031 | M03 Vendors | Add Vendor | GSTIN lookup | Enter GSTIN, fetch legal name, trade name, address, state, registration status | Same provider as the CRM (gstinapi.in, GSTINAPI_KEY), lookups cached so the free quota is not spent twice; without a key the details are typed and the offline checksum, PAN and state checks still run. PAN is derived from GSTIN characters 3-12. Unregistered vendors enter PAN manually. | Field | P0 | BR-15 |  | Built (M4) |
| F032 | M03 Vendors | Add Vendor | Basic details | Display name*, legal name (AF), vendor type* (Goods / Services / Both), category default, contact person, phone, email, address (AF), pincode lookup | Pincode fills city and state (same India Post API as CRM). | Field | P0 |  |  | Built (M4) |
| F033 | M03 Vendors | Add Vendor | Tax profile | GST registered (Y/N), GSTIN, PAN*, deductee type (AF from PAN 4th character), default TDS section, lower deduction certificate (number, rate, validity, limit) | Deductee type decides the TDS rate (individual/HUF vs others). | Field | P0 | BR-12, BR-15 |  | Built (M4) |
| F034 | M03 Vendors | Add Vendor | MSME | Udyam number, enterprise type (Micro/Small/Medium), certificate upload | Micro and Small vendors get the 45-day payment alert. | Field | P0 | BR-25 |  | Built (M4) |
| F035 | M03 Vendors | Add Vendor | Bank details | Account name, number, IFSC (validated, bank and branch auto-filled), cancelled cheque upload | Changing bank details on an existing vendor needs founder approval and is logged (fraud control). | Field | P0 | BR-16 |  | Built (M4) |
| F036 | M03 Vendors | Add Vendor | Documents | GST certificate, PAN, cancelled cheque, MSME certificate, agreement/NDA | Checklist shows what is missing. Vendor can be Active without all documents, but payment request shows a warning. | Field | P0 |  |  | Built (M5) |
| F037 | M03 Vendors | Add Vendor | Onboarding form link | Send vendor a link to fill their own details and upload documents | Submission lands as Pending Review. Saves typing for new vendors. | CTA | P2 |  |  | Spec drafted |
| F038 | M03 Vendors | Vendor 360 | Overview | All POs, bills, payments, advances, TDS deducted, outstanding, ageing, documents for one vendor | Vendor statement downloadable as PDF for reconciliation with the vendor. | View | P0 |  |  | In progress (M4: details, warnings, bank history, documents, payments from bank rows; POs, bills, TDS and statement PDF in Phase 2) |
| F040 | M04 Purchase Orders | PO Register | List | PO no, date, vendor, GSTIN, description, PO value, billed, paid, balance to bill, status, PDF link | Same columns as the current PO Register plus computed billed and paid. | View | P0 |  |  | Spec drafted |
| F041 | M04 Purchase Orders | Create PO | Header | Vendor*, PO date*, expected delivery date, delivery address (Ambala CM premises / Bangalore / custom), payment terms, reference quote no, notes | Vendor details auto-filled. Place of supply from delivery address. | Field | P0 | BR-20 |  | Spec drafted |
| F042 | M04 Purchase Orders | Create PO | Lines | Item (from purchase catalogue or free text)*, description, HSN/SAC, qty*, unit, rate*, discount, GST rate, amount (C) | GST split computed from vendor state vs delivery state. | Field | P0 | BR-20 |  | Spec drafted |
| F043 | M04 Purchase Orders | Create PO | Terms | Payment milestones (e.g. 40% advance, 60% on delivery), warranty, delivery terms, standard T&C template | Milestones create expected payments that show on the cash forecast. | Field | P1 |  |  | Spec drafted |
| F044 | M04 Purchase Orders | Create PO | Approve & issue | Issue PO (approval step only if approvals are switched on) | Approvals off (default): Issue assigns the PO number and generates the PDF straight away. Approvals on: PO goes to the approver for its amount band first. | CTA | P0 | BR-26, BR-30 | Q9 | Spec drafted |
| F045 | M04 Purchase Orders | PO Detail | Send | Email PDF to vendor (from app) or download / share on WhatsApp | Sent date logged. | CTA | P0 |  |  | Spec drafted |
| F046 | M04 Purchase Orders | PO Detail | Amend | Change quantities/rates after issue; creates revision R1, R2 with change log | PO number stays the same; PDF shows revision number. | CTA | P1 |  |  | Spec drafted |
| F047 | M04 Purchase Orders | PO Detail | Linked records | Bills, payments, advances, GRNs (from Inventory) linked to this PO with totals | Status computed from billed and received amounts. | View | P0 | BR-17 |  | Spec drafted |
| F048 | M04 Purchase Orders | PO Detail | Close / cancel | Short-close a PO with balance, or cancel with reason | Cancelled only if nothing billed or paid. | CTA | P0 |  |  | Spec drafted |
| F050 | M05 Vendor Bills | Vendor Invoice Register | List | Doc type, doc no, tax invoice no, date, status, PO, vendor, GSTIN, taxable, GST (CGST/SGST/IGST), other fees, total, TDS, net payable, paid, outstanding, due date, file | Same columns as current Vendor Invoice Register. Filters and totals. | View | P0 |  |  | Spec drafted |
| F051 | M05 Vendor Bills | Add Document | Document type | Quote / Proforma / Tax Invoice / Debit Note / Credit Note from vendor | Quote and Proforma create a payable reference for advances but are flagged 'awaiting tax invoice'. | Field | P0 | BR-09 |  | Spec drafted |
| F052 | M05 Vendor Bills | Add Document | Header | Vendor*, doc no*, doc date*, PO link, place of supply (AF), reverse charge Y/N, due date (C from terms, editable), upload file* | Duplicate check on vendor + doc no + FY. | Field | P0 | BR-19, BR-23 |  | Spec drafted |
| F053 | M05 Vendor Bills | Add Document | Lines | Description, HSN/SAC, qty, rate, taxable, GST rate, CGST, SGST, IGST, other charges (non-taxable fees) | Prefill from PO lines when linked. GST split computed but editable to match the vendor's document exactly, with a mismatch warning. | Field | P0 | BR-20 |  | Spec drafted |
| F054 | M05 Vendor Bills | Add Document | TDS | TDS applicable (AF), section (AF from vendor), base (AF taxable value), rate (AF), amount (C) | Applies threshold checks using vendor's FY aggregate. Override needs a reason. | Field | P0 | BR-11, BR-12, BR-13 |  | Spec drafted |
| F055 | M05 Vendor Bills | Add Document | Category | Category, sub-category, nature (Opex/Capex/COGS) | Default from vendor. Used for accrual-view dashboards. | Field | P0 | BR-04 |  | Spec drafted |
| F056 | M05 Vendor Bills | Add Document | Read from PDF | Upload vendor invoice PDF/image and pre-fill fields | AI extraction of vendor, GSTIN, number, date, lines, tax. User confirms every field. | Auto | P1 |  |  | Spec drafted |
| F057 | M05 Vendor Bills | Bill Detail | Replace proforma with tax invoice | When the tax invoice for a proforma/quote arrives, link it; advances move across automatically | Closes the 'money out without tax invoice' item. | CTA | P0 | BR-09, BR-10 |  | Spec drafted |
| F058 | M05 Vendor Bills | Bill Detail | Dispute / hold | Mark disputed with reason; excluded from payment runs |  | CTA | P1 |  |  | Spec drafted |
| F059 | M05 Vendor Bills | Reminders | Tax invoice chase | List of advances paid with no tax invoice after N days; one-click email/WhatsApp reminder to vendor | Default N = 15 days. Currently ₹3,85,508 paid without a tax invoice. | Auto | P0 | BR-10 |  | Spec drafted |
| F060 | M06 Payables | Payables | Due list | Bills due this week / overdue / upcoming, with net payable after TDS and advances | Sort by due date; MSME vendors highlighted. | View | P0 | BR-22, BR-25 |  | Spec drafted |
| F061 | M06 Payables | Payment Request | Create | Select bill(s) or PO milestone or advance; amount; purpose; requested by | Payment request is a draft payment. Advance requests require a quote/PI or PO. | CTA | P0 | BR-26 |  | Spec drafted |
| F062 | M06 Payables | Payment Request | Approve | Approve (only when approvals are switched on) | Off at launch. When on: approver sees vendor, bill, TDS, bank details and documents checklist. The 'bank details changed in last 30 days' warning shows at Record Payment either way. | CTA | P1 | BR-26, BR-16 | Q9 | Spec drafted |
| F063 | M06 Payables | Record Payment | Payment details | Date*, amount*, mode*, from account*, UTR*, TDS deducted (C), proof upload | When the bank statement is imported, the matching bank row is linked automatically by UTR or amount + date + party. | Field | P0 | BR-08 |  | Spec drafted |
| F064 | M06 Payables | Record Payment | Allocation | Allocate payment across one or more bills; any unallocated amount becomes an advance | Bill status updates: Partially Paid / Paid. | Auto | P0 | BR-08, BR-09 |  | Spec drafted |
| F065 | M06 Payables | Payment-Out Log | List | Payment ID, date, vendor, documents linked, amount, mode, UTR, TDS deposited?, proof | Same as current Payment-Out Log. | View | P0 |  |  | Spec drafted |
| F066 | M06 Payables | Payment Run | Bulk payment file | Select approved payments and download a bank bulk-upload file (IDFC format) |  | CTA | P2 |  |  | Spec drafted |
| F067 | M06 Payables | Ageing | AP ageing | Outstanding by vendor in buckets |  | Report | P0 | BR-24 |  | Spec drafted |
| F070 | M07 TDS | TDS Register | Deductions | Every TDS deduction: vendor, PAN, section, bill/payment, date of deduction, base, rate, amount, month, quarter, deposit status | Created automatically from bills and payments. | View | P0 | BR-11 |  | Spec drafted |
| F071 | M07 TDS | TDS Register | Payable summary | TDS payable by month with due date and days left | Due 7th of next month; March deductions due 30 April. | View | P0 | BR-13 |  | Spec drafted |
| F072 | M07 TDS | Challans | Record challan | Challan no (CIN/BSR, serial), date, section, amount, interest, late fee, linked deductions, challan PDF | Bank rows with narration OPT/CBDT are suggested for matching. Deductions linked to a challan become Deposited. | CTA | P0 | BR-14 |  | Spec drafted |
| F073 | M07 TDS | Quarterly View | 26Q working | Quarter-wise deductee list for the CA to file the return; mark return filed with acknowledgement no | Export in the format your CA uses. Filing itself out of scope. | Report | P0 |  | Q16 | Spec drafted |
| F074 | M07 TDS | Quarterly View | 16A status | Mark Form 16A issued per vendor per quarter, upload PDF |  | Field | P1 |  |  | Spec drafted |
| F075 | M07 TDS | Vendor thresholds | Aggregate tracker | Per vendor per section: FY paid/credited to date vs threshold | Warns before the payment that crosses the threshold so TDS is not missed. | Auto | P0 | BR-12 |  | Spec drafted |
| F076 | M07 TDS | Customer TDS | TDS receivable | TDS deducted by customers on our invoices; match to Form 26AS quarterly | Customers usually do not deduct TDS. Kept for the occasional large chain that does. | View | P2 | BR-41 |  | Spec drafted |
| F080 | M08 Customers | Customer List | List | Customer, company, outlets, GSTIN, state, terms, outstanding, overdue, last invoice, last receipt | Customer, company and outlet records are read from the CRM. Finance never creates a customer that does not exist in the CRM (except one-off walk-ins, P1). | View | P0 |  | Q5 | Spec drafted |
| F081 | M08 Customers | Customer Finance Profile | Finance fields | Credit terms, credit limit, invoice email(s), deducts TDS? (Y/N, section), billing entity per outlet | Stored in Finance, keyed by CRM customer/outlet ID. Defaults: payment terms = On delivery; deducts TDS = No. Credit terms set per customer when given. | Field | P0 | BR-41 | Q4 | Spec drafted |
| F082 | M08 Customers | Customer 360 | Overview | Orders (CRM), proformas, invoices, receipts, credit notes, outstanding, ageing, statement PDF |  | View | P0 |  |  | Spec drafted |
| F083 | M08 Customers | Credit control | Credit limit check | Warn (P0) or block (P1) a new invoice when outstanding + new invoice > credit limit, or anything is overdue > 30 days |  | Auto | P1 | BR-24 |  | Spec drafted |
| F090 | M09 Sales Documents | Proforma Invoice | Create | Customer*/outlet* (from CRM), bill-to and ship-to (AF), place of supply (AF), date*, validity date, lines (product from catalogue, qty, rate from price list, discount, GST), freight, notes, bank details, terms | Can be created from a CRM order (button in CRM) or here. No GST liability on a proforma. | CTA | P0 | BR-20, BR-33 | Q3 | Spec drafted |
| F091 | M09 Sales Documents | Proforma Invoice | Send & track | PDF, email/WhatsApp, status Sent / Accepted / Expired | Advance received against a PI is recorded as customer advance. | CTA | P0 |  |  | Spec drafted |
| F092 | M09 Sales Documents | Proforma Invoice | Convert | Convert PI to Tax Invoice in one click (all or part quantity) | Copies lines, links PI no, applies any advance received. | CTA | P0 | BR-33 |  | Spec drafted |
| F093 | M09 Sales Documents | Tax Invoice | Create | Same fields as PI plus: invoice no (C on issue), reverse charge (N), e-way bill no (O), transporter, vehicle no, PO ref of customer, CRM order ID | Draft has no number. Issue assigns the number and locks the document. B2B or B2C is decided by whether the customer has a GSTIN (BR-49). D2C invoices are created automatically from CRM orders when shipped (BR-48, F102); B2B invoices from a CRM order or manually. | CTA | P0 | BR-30, BR-32, BR-42 | Q2 | Spec drafted |
| F094 | M09 Sales Documents | Tax Invoice | Validations on issue | Mandatory fields present, GSTIN valid for B2B, HSN present on every line, totals tie out, place of supply set | Cannot issue until all pass. Errors shown in plain words. | Auto | P0 | BR-32 |  | Spec drafted |
| F095 | M09 Sales Documents | Tax Invoice | PDF | Original for recipient / Duplicate for transporter / Triplicate for supplier copies, amount in words, signature, bank details, UPI QR | Template in Documents & Numbering. | Auto | P0 | BR-21, BR-32 |  | Spec drafted |
| F096 | M09 Sales Documents | Tax Invoice | Cancel | Cancel an issued invoice with reason; number is kept and shown as cancelled | If GSTR-1 for that month is already filed, cancellation is not allowed; a credit note must be raised instead. | CTA | P0 | BR-34 |  | Spec drafted |
| F097 | M09 Sales Documents | Credit Note | Create | Against an invoice: return, rate difference, discount; lines, GST reversal | Reduces receivable. Notifies Inventory app if goods are returned. | CTA | P0 | BR-34 |  | Spec drafted |
| F098 | M09 Sales Documents | Invoice Register | List | All sales documents with status, customer, amount, GST, received, outstanding, due date, CRM order ID | Filters by channel (HoReCa / D2C / Marketplace). | View | P0 |  |  | Spec drafted |
| F099 | M09 Sales Documents | Recurring | Sachet refill subscriptions | Auto-create monthly invoices for HoReCa customers on a consumables plan | Sachet refills will be sold to HoReCa. Plan per outlet (SKU, qty, frequency, price); invoices auto-drafted each cycle and pushed to CRM as orders for dispatch. | Auto | P1 |  | Q11 | Spec drafted |
| F100 | M09 Sales Documents | Quotation | Create | Price quote before PI | Probably handled in CRM; keep out of Finance unless needed. | CTA | P2 |  | Q3 | Spec drafted |
| F101 | M09 Sales Documents | Delivery Challan | Create | Goods moved without sale (demo units, trials, stock transfer to CM) | Needed if you send trial devices to hotels (Q10). | CTA | P2 |  | Q10 | Spec drafted |
| F110 | M10 Receivables | Receivables | Outstanding list | Invoice, customer, due date, days overdue, amount due, last reminder |  | View | P0 | BR-22, BR-24 |  | Spec drafted |
| F111 | M10 Receivables | Record Receipt | Receipt details | Date*, customer*, amount*, mode*, account*, reference/UTR, TDS deducted by customer, bank charges | Unallocated amount becomes customer advance. | CTA | P0 | BR-38, BR-41 |  | Spec drafted |
| F112 | M10 Receivables | Record Receipt | Allocation | Allocate receipt across invoices; invoice status updates |  | Auto | P0 | BR-38 |  | Spec drafted |
| F113 | M10 Receivables | Bank match | Suggest invoice for bank credit | Bank credit matched by amount, customer name in narration, UTR | Suggestions listed with a confidence score; user confirms. | Auto | P0 | BR-38 |  | Spec drafted |
| F114 | M10 Receivables | Settlements | Razorpay settlement import | Razorpay sync | Pulled daily from the Razorpay API: payments, refunds, settlements and per-payment settlement mapping. One settlement batch matches one bank credit and many orders. Feeds M18. | Auto | P0 | BR-39, BR-44 to BR-47 | Q23 | Spec drafted |
| F115 | M10 Receivables | Settlements | Shiprocket COD remittance import | Shiprocket COD remittance import | Shiprocket API (remittance data at AWB level). Freight is charged to the wallet, not deducted, so remittance = COD collected. Maps AWBs to CRM orders. COD arrives days after delivery, so delivered-but-not-remitted COD is tracked as money in transit. Feeds M18. | Auto | P0 | BR-40, BR-44 to BR-47 | Q24 | Spec drafted |
| F116 | M10 Receivables | Reminders | Payment reminders | Email/WhatsApp reminder templates at due date, +7, +15, +30 days | Manual send in P0, scheduled in P1. | CTA | P1 |  |  | Spec drafted |
| F117 | M10 Receivables | Ageing | AR ageing | Outstanding by customer in buckets |  | Report | P0 | BR-24 |  | Spec drafted |
| F120 | M11 Products | Product Catalogue | Synced products | SKU, name, HSN, GST rate, unit, active (from Inventory app) | Read only here. | View | P0 |  | Q5 | Spec drafted |
| F121 | M11 Products | Price Lists | Price list setup | List name (MRP / HoReCa / Distributor / Marketplace), price per SKU, inclusive or exclusive of GST, effective dates | Invoice line rate defaults from the customer's price list. | Field | P0 |  |  | Spec drafted |
| F122 | M11 Products | Purchase Items | Purchase catalogue | Items you buy repeatedly (moulds, PCBs, LEDs, mesh, boxes, sachet raw material) with HSN, unit, last rate, preferred vendor | Speeds up PO creation and gives price history. | Field | P1 |  |  | Spec drafted |
| F130 | M12 Dashboards | Home | Founder dashboard | Cash, cash credit headroom, money in transit (Razorpay and COD not yet in bank), burn, runway, AP due, AR due, TDS due, order payment discrepancies, items needing action | Definitions in Dashboards & Reports tab. Phase 1 slice (cash view from the bank ledger): cash per account, cash credit headroom, runway, net and gross burn by month, capex and funding apart from burn, action items (review queue, uncategorised rows of the last 3 months, statements not imported for 7 days, vendor bank changes waiting, missing documents). Money in transit, AP, AR, TDS and order discrepancies come with Phases 2-3. | View | P0 | BR-37 |  | Phase 1 slice built (M7) |
| F131 | M12 Dashboards | Category Analytics | Income & expense by category | Month x category pivot, trend, MoM change, drill to transactions | Cash view and accrual view toggle. Phase 1: cash view only, tabs Spending (operating expense, COGS, interest), Income (operating income) and Capex; FY picker; expand a category to its sub-categories; every amount opens those bank rows in the ledger. Ignored rows and rows waiting for review are left out. Accrual view comes with bills and invoices. | View | P0 | BR-35 |  | Phase 1 slice built (M7) |
| F132 | M12 Dashboards | Payables Dashboard | AP metrics | All metrics from the current Accounts Payable Dashboard plus ageing and MSME alerts |  | View | P0 |  |  | Spec drafted |
| F133 | M12 Dashboards | Receivables Dashboard | AR metrics | Outstanding, overdue, DSO, top debtors, collection trend |  | View | P0 |  |  | Spec drafted |
| F134 | M12 Dashboards | Unit economics | Per-unit view | Revenue, COGS, logistics, marketing per unit sold (needs units from CRM/Inventory) |  | View | P2 |  |  | Spec drafted |
| F135 | M12 Dashboards | Budget vs actual | Budget | Monthly budget per category; variance |  | View | P2 |  |  | Spec drafted |
| F136 | M12 Dashboards | Cash forecast | 13-week forecast | Opening cash + expected receipts (invoice due dates) - expected payments (bills due, PO milestones, loan EMIs, TDS, salaries) |  | View | P1 |  |  | Spec drafted |
| F140 | M13 Funding & Loans | Capital | Capital receipts | Founder, date, amount, type (paid-up capital / share application money / allotted), allotment date, share count | Tracks the ₹26L promoter funds and allotment status. | Field | P1 | BR-04 |  | Spec drafted |
| F141 | M13 Funding & Loans | Loans | Loan register | Lender, sanction amount, disbursed, rate, tenure, repayment type (EMI / bullet / flexible prepayment), final due date, agreement upload | Mesa ₹12L seeded as flexible: repayable any time within 18 months of disbursement (final due ~Dec 2027). | Field | P1 | BR-28 |  | Spec drafted |
| F142 | M13 Funding & Loans | Loans | Schedule | Repayment schedule for EMI loans; for flexible loans, record each prepayment and show balance and days to final due date | Interest is an expense; principal is Financing-out. | Auto | P1 | BR-28 |  | Spec drafted |
| F143 | M13 Funding & Loans | Loans | Covenant check | Total debt outstanding vs Mesa ₹45L aggregate cap; warning when adding a new loan | Total debt including the PNB cash credit (drawn or sanctioned, per Q14) vs the Mesa ₹45L cap; warning when adding a new loan or credit line. | Auto | P1 | BR-28 | Q14 | Spec drafted |
| F150 | M14 Founder Expenses | Expense Claims | Add claim | Founder, date, paid from (personal account / card), vendor, amount, GST invoice (Y/N), category, receipt upload* | Creates 'payable to founder'. Shows in category analytics on the claim date. | CTA | P1 | BR-27 | Q6 | Spec drafted |
| F151 | M14 Founder Expenses | Expense Claims | Reimburse | Pay one or many claims; matched to bank debit to the founder |  | CTA | P1 | BR-27 |  | Spec drafted |
| F160 | M15 Documents | Attachments | Upload | Attach files to any record; stored in Drive under /Finance/FY/Module/Record no | File named automatically, e.g. ELPL-PO-2026-001_Saiffi.pdf ({record}_{kind}.{ext}). PDF, images, CSV, Excel and Word up to 15 MB; the same file twice on one record is refused. Removing a file archives it with a reason (the file is kept). Imported bank statements are kept with their import. Files go to Google Drive once a service account is set up; until then to a local folder with the same layout. | CTA | P0 |  |  | Built (M5) |
| F161 | M15 Documents | Attachments | Missing documents report | Records missing a required file (bill without invoice copy, payment without proof, challan without PDF) |  | Report | P0 |  |  | Built (M5: vendors missing required documents, imports without their statement file; Phase 2 records join later) |
| F170 | M16 Users | Login | Email and password | Sign in with an @blocinsects.com email and password (bcrypt, httpOnly session cookie), the same login as the Bloc CRM. 5 wrong passwords lock the account for 15 minutes. | Moves to the CRM's single login when the apps are merged. Users change their own password on the Account page. | Auto | P0 |  |  | Built (M0) |
| F171 | M16 Users | Roles | Role assignment | Admin, Approver, Finance, Sales, Viewer/CA | v1 users: Rishabh and Arnav only, both Admin. Other roles stay in the model for later. | Field | P0 |  |  | Spec drafted |
| F172 | M16 Users | Audit | Audit log | Who changed which field from what to what, when; viewable on every record |  | Auto | P0 | BR-43 |  | In progress (M0: full audit log page; per-record panel comes with each module) |
| F173 | M16 Users | Notifications | Alerts | Approvals pending, TDS due in 3 days, MSME payment due, invoices overdue, statement not imported for 7 days | In-app + email in P0; WhatsApp/Slack P1. | Auto | P0 |  |  | Spec drafted |
| F180 | M17 CA Export | Monthly pack | Export | Monthly Excel workbook for the CA (Tally user): all transactions with category, party, GST and TDS columns; vendor bills; sales invoices; credit notes; receipts; payments; TDS register | Documents stay in the shared Drive folder; the workbook links each row to its file. | CTA | P1 |  | Q16 | Spec drafted |
| F181 | M17 CA Export | Monthly pack | GST working | Outward supplies by invoice (B2B/B2C), HSN summary, inward invoices with GST for ITC check | Information for the CA only. Not a GSTR file. | Report | P1 |  |  | Spec drafted |
| F182 | M17 CA Export | Tally / Zoho import | Voucher export | Export in Tally XML or Zoho Books import CSV | Only if the CA wants it (Q16). | CTA | P2 |  | Q16 | Spec drafted |
| F024 | M02 Bank Ledger | Statement Import | PNB parser | Parser for the PNB cash credit statement format | Built when the CC account opens. Same duplicate and balance checks; balances are negative while drawn. | Auto | P1 | BR-01, BR-50 | Q25 | Spec drafted |
| F102 | M09 Sales Documents | Tax Invoice | D2C auto-invoicing | Create and issue a B2C tax invoice for each D2C CRM order when it ships: Shiprocket pickup, or 'Shipped' marked manually in CRM for Porter / self-delivery | Uses customer name, delivery address and state from the CRM order. Runs as a batch; failures (missing address, missing HSN on product) go to a fix-list instead of blocking the batch. | Auto | P0 | BR-48, BR-49 | Q27 | Spec drafted |
| F103 | M09 Sales Documents | Credit Note | RTO and post-dispatch cancellation | Auto-draft a credit note when an invoiced order is RTO'd or cancelled after dispatch | Finance reviews and issues. RTO credit notes counted in reports so RTO cost is visible. | Auto | P0 | BR-48, BR-34 |  | Spec drafted |
| F190 | M18 Order-to-Bank | Order Payment Tracker | Tracker list | One row per CRM order: order no, date, channel, customer, payment method, order amount, invoice no, collection route (Razorpay / Shiprocket COD / Direct), gateway reference (payment ID or AWB), collected amount, settlement or remittance ID, expected bank date, bank credit date, net received, fees, status, discrepancy | Status is computed from linked records (BR-44), never typed. Default filter: last 60 days, not 'In bank'. | View | P0 | BR-44 |  | Spec drafted |
| F191 | M18 Order-to-Bank | Order Payment Tracker | Filters and totals | Filter by status, route, channel, age, discrepancy only, date range; totals per status at the top | Answers 'how much is paid by customers but not yet in my bank' in one click. | View | P0 |  |  | Spec drafted |
| F192 | M18 Order-to-Bank | Sources | Razorpay link | Link each Razorpay payment to its CRM order | Match on the ID stored on the CRM order (Razorpay order/payment ID or Shopify order number in payment notes). Unlinked payments go to the discrepancy queue. | Auto | P0 | BR-44, BR-46 | Q23 | Spec drafted |
| F193 | M18 Order-to-Bank | Sources | Shiprocket COD link | Link COD orders to remittances by AWB | Delivery status already flows into the CRM from Shiprocket; Finance reads it. Remittance file maps AWB to remittance ID and amount. | Auto | P0 | BR-44, BR-45 | Q24 | Spec drafted |
| F194 | M18 Order-to-Bank | Sources | Bank match for settlements | Match each Razorpay settlement and Shiprocket remittance to its IDFC credit | By UTR/settlement reference in narration first, then exact amount within the expected date window. | Auto | P0 | BR-47 |  | Spec drafted |
| F195 | M18 Order-to-Bank | Sources | Direct payments | Orders paid by UPI, QR code, bank transfer or cash (mostly HoReCa) | Seen only via bank statement import or the CRM order being marked paid. Matched by amount + date + customer name; unmatched credits stay in the bank review queue. Cash needs a deposit entry when banked. | Auto | P0 | BR-38, BR-44 |  | Spec drafted |
| F196 | M18 Order-to-Bank | Discrepancies | Discrepancy queue | Every mismatch with type, amount, likely cause and the records involved; resolve with an action and note (chase Razorpay, chase Shiprocket, refund, write off, CRM order corrected) | Types in BR-46. Resolved items keep their history. | View | P0 | BR-46 |  | Spec drafted |
| F197 | M18 Order-to-Bank | Money in transit | Summary | Paid at Razorpay but not settled; delivered COD not remitted; settled or remitted but not seen in bank. Each with count, value and age against expected date. | Also feeds the cash forecast (expected inflows). | View | P0 | BR-45 |  | Spec drafted |
| F198 | M18 Order-to-Bank | Settlement detail | Batch view | One settlement or remittance: orders included, gross, fees, GST on fees, refunds, adjustments, net, bank row | Tie-out shown at each level (BR-47). | View | P0 | BR-47 |  | Spec drafted |
| F199 | M18 Order-to-Bank | Alerts | Overdue money | Alert when: COD delivered and not remitted past expected date; Razorpay payment not settled past expected date; settlement not in bank after 2 days; fees above expected rate | Daily digest by email; in-app badge. | Auto | P0 | BR-45, BR-46 |  | Spec drafted |
| F200 | M18 Order-to-Bank | CRM write-back | Payment status in CRM | Show the order's payment status (e.g. 'In bank 14 Oct', 'Awaiting COD remittance') on the CRM order page | Same database, so the CRM reads the order_payment_status view. No sync job. | View | P1 | BR-44 |  | Spec drafted |
| F104 | M09 Sales Documents | Invoice Templates | Template settings | Three layers. 1) Data: computed by the app, never edited on the template. 2) Template settings page (no code): legal details, logo, accent colour, font from a short list, bank details, UPI QR, signature image, warranty / declaration / terms text, column toggles (disc %, HSN summary), discount line labels, live preview on a sample invoice. 3) Layout: one HTML/CSS template per document family (tax invoice, proforma, credit note, PO) rendered to PDF by the server; changed in code and versioned. | Design reference = current Sales <> Master Data proforma layout (or a Canva/PDF mock you supply once). Word/Canva files are not used at runtime. Compliance fields (GSTIN, HSN, place of supply, tax split, invoice no) cannot be switched off. B2B/B2C and IGST vs CGST+SGST blocks switch automatically. Every issued document stores its template version and a frozen PDF, so later template changes never alter issued invoices. | Field | P0 | BR-32 | Q3 | Spec drafted |
| F105 | M09 Sales Documents | Invoice Service | Invoice API for CRM | CRM calls Finance to create, issue and fetch PDFs for proformas and invoices; Finance assigns numbers, stores the record and returns invoice no + PDF link | Sales issue invoices from the CRM screen, but numbering, tax maths, templates and the register live only in Finance (one source of truth). Every call logged with user and CRM order ID. | Auto | P0 | BR-30, BR-48, BR-49 | Q19 | Spec drafted |
| F106 | M09 Sales Documents | Invoice header | Sales person | Quotation sent by' / sales owner on every proforma and invoice | Carried over from the current PI sheet; used for sales reports. | Field | P1 |  |  | Spec drafted |

## Data Model

Tables owned by Finance plus fields read from CRM/Inventory. Source: Manual, AF (auto-filled), C (computed), SYNC, Import.

| Table | Field | Type | Req | Source | Validation / logic | Example | Notes |
|---|---|---|---|---|---|---|---|
| (all tables) | id, entity_id, created_at, created_by, updated_at, updated_by, is_archived | text (cuid), text, timestamptz, text, timestamptz, text, bool | Y | C | entity_id = Entelechy for v1. No hard deletes: the database refuses DELETE and TRUNCATE on every finance table. In Prisma, tables are PascalCase and columns camelCase (createdAt, isArchived), as in Bloc. |  | Audit log captures every change (BR-43) through database triggers |
| company | legal_name, brand_name | text | Y | Manual |  | Entelechy Labs Private Limited, Bloc |  |
| company | cin, pan, tan, gstin, udyam_no | text | Y | Manual | BR-15 formats | U20211KA2026PTC221356 |  |
| company | registered_address, state_code | text | Y | Manual | state_code from GSTIN | Innov8 Mantri Commercio, Bellandur; 29 |  |
| company | logo_file_id, signature_file_id, fy_start_month, incorporation_date, email, phone | text, text, int, date, text, text | Y (fy_start_month, incorporation_date) | Manual | fy_start_month = 4; PAN and state_code are always read from the GSTIN on save (BR-15) | 22 May 2026; finance@blocinsects.com | Months before incorporation show as zero (Q12) |
| bank_account | bank_name, account_name, account_number, ifsc, branch | text | Y | Manual | IFSC format; account number shown masked except last 4 | IDFC FIRST, Koramangala |  |
| bank_account | account_type | enum | Y | Manual | business_current, cash_credit, founder_personal, loan, wallet, card | business_current |  |
| bank_account | owner, opening_balance, opening_date, parser_format, is_active | text, numeric, date, text, bool | Y | Manual |  | Entelechy; 0; 29 May 2026; idfc_xls_v1 |  |
| bank_import_batch | entity_id, bank_account_id, file_name, file_hash, file_drive_id, period_from, period_to, rows_total, rows_new, rows_duplicate, opening_balance, closing_balance, total_debit, total_credit, balance_check_status, balance_check_note, missing_from, missing_to, imported_by, imported_at | mixed | Y | C/Import | BR-01, BR-03. status: ok, gap, mismatch; missing_from/to = dates probably missing when the file does not continue from the stored balance | idfc_statement_rows.csv, 22 rows, ok | One per uploaded file; file_drive_id filled by the documents vault (M15) |
| bank_txn | entity_id, bank_account_id, batch_id, seq, txn_date, value_date | text, text, text, int, date, date | Y | Import | seq = position in the account's statement, orders rows within a day | 24 Jul 2026 |  |
| bank_txn | narration_raw, cheque_no | text | Y | Import | Never edited: a database trigger refuses changes to date, narration, amounts, balance and dedupe key (BR-02) | RTGS/IDFBR62026072403779464/SAIFFI INDUSTRIESPARVEZ AALAM/SBIN0050316/Tooling Advance |  |
| bank_txn | debit, credit, balance | numeric | Y | Import | Exactly one of debit/credit > 0 | 1136800, 0, 163200 |  |
| bank_txn | dedupe_key | text unique | Y | C | BR-01 |  | Unique per account |
| bank_txn | parse_ok, mode, mode_detail, utr, counterparty_name, counterparty_ifsc, counterparty_account, counterparty_bank, ref2, remark | bool, text... | N | C | BR-02. mode_detail = OPM, CBDT, CR/DR, gateway; counterparty_account for IFT; counterparty_bank = UPI bank code; ref2 = second reference | RTGS, IDFBR62026072403779464, SAIFFI INDUSTRIESPARVEZ AALAM, SBIN0050316, Tooling Advance | parse_ok false = pattern not recognised, row goes to Review |
| bank_txn | description | text | N | Manual | Human description shown in ledger | Tooling advance payment to Saiffi Industries (TDS deducted) |  |
| bank_txn | category_id, sub_category_id, nature | uuid, uuid, enum | Y before lock | AF/Manual | BR-04, BR-05 | Capex > Tooling & Moulds | Null when split; lines carry category |
| bank_txn | party_type, party_id | enum, uuid | N | AF/Manual | vendor, customer, founder, lender, govt, own_account, other | vendor: Saiffi Industries |  |
| bank_txn | status | enum | Y | C | See Status Flows | matched |  |
| bank_txn | (locked months) | - | - | C | BR-36: a database trigger refuses inserting or changing a row dated in a locked month |  |  |
| bank_txn | categorisation_reason, transfer_pair_id, notes | text, uuid, text | N | C/Manual |  | Matched PMT-0001 |  |
| bank_txn | related_party_type | text | N | AF/Manual | BR-29: business_transfer, director_loan, capital, undecided (default when a row becomes Related Party) | undecided (Newera Rs 7L) | Decided with the CA |
| txn_split | bank_txn_id, line_no, amount, category_id, sub_category_id, nature, party_type, description, linked_doc_type, linked_doc_id, note, is_archived | mixed | Y | Manual | Sum = parent amount to the paisa (BR-07); amount > 0; a locked month refuses changes (BR-36) | 10,000 + 8,700 for Makenica 18,700 | Unsplit archives the lines, never deletes them |
| categorization_rule | name, priority, match_field, operator, match_value, direction, amount_min, amount_max, set_category_id, set_sub_category_id, set_nature, set_party_type, set_description, is_active, is_seeded | mixed | Y | Manual | BR-05. match_field: narration, counterparty_name, mode, remark, utr; operator: contains, equals, starts_with, regex (case-insensitive); direction: debit, credit or both | OPT/CBDT: narration starts_with 'OPT/CBDT', debit, then Taxes > TDS Deposit | is_seeded = one of the default rules (F017) |
| category | name, nature_default, sort_order, is_active | mixed | Y | Manual | Seeded from the Category Master table below (the seed reads this file) | Logistics_Delivery, Operating Expense | Default nature = the nature most of its sub-categories have |
| sub_category | category_id, name, nature_override, pl_group, note, is_active | mixed | Y | Manual | nature_override set only when it differs from the category default; P&L group per sub-category | Shiprocket; Operations_Admin > GST & Taxes overrides to Tax Payment | Changing a nature never rewrites transactions already categorised |
| vendor | display_name, legal_name, trade_name | text | Y | Manual/AF | legal_name from GSTIN API | Saiffi Industries |  |
| vendor | vendor_type | enum | Y | Manual | goods, services, both | goods |  |
| vendor | gst_registered, gstin, pan, deductee_type | bool, text, text, enum | Y (pan N) | Manual/AF | BR-15: PAN = GSTIN characters 3-12 and state code = characters 1-2 (database check); one active vendor per GSTIN. deductee_type from PAN 4th char (BR-12): individual, huf, company, firm, others, unknown (no PAN = no-PAN rate) | true, 06ANJPA3053F1ZI, ANJPA3053F, individual | PAN typed only for vendors without GSTIN |
| vendor | address_line1, address_line2, city, state, state_code, pincode | text | Y | AF/Manual | Pincode API | Ambala, Haryana, 06 |  |
| vendor | contact_name, phone, email | text | N | Manual |  | Parvez Alam |  |
| vendor | default_tds_section_id, ldc_number, ldc_rate, ldc_valid_from, ldc_valid_to, ldc_limit | mixed | N | Manual | BR-12 | contract work | LDC = lower deduction certificate |
| vendor | msme_type, udyam_no | enum, text | N | Manual | micro, small, medium, none |  | BR-25 |
| vendor | default_category_id, default_sub_category_id, payment_terms_id | uuid | N | Manual |  | Capex > Tooling & Moulds; Advance |  |
| vendor | status, status_reason, bank_names, notes, is_archived | enum, text, text[], text, bool | Y | C/Manual | See Status Flows; blocking needs a reason. bank_names = how the vendor appears in bank narrations (BR-05 step 2) | active; SAIFFI INDUSTRIES |  |
| vendor_bank_account | vendor_id, account_name, account_number, ifsc, bank_name, branch, status, requested_by, requested_at, decided_by, decided_at, decision_note, valid_from, valid_to | mixed | Y | Manual/AF | BR-16. status: pending, approved, rejected, superseded; one approved per vendor (database index); IFSC lookup fills bank and branch | SAIFFI INDUSTRIES, SBIN0050316, approved | Every version kept; account number shown masked |
| vendor_document_file | vendor_id, doc_kind, attachment_id, valid_to | mixed | N | Manual | doc_kind: gst_cert, pan, cancelled_cheque, msme_cert, agreement, other |  | Stored as attachment rows with doc_kind (M15); checklist shown on the vendor page |
| gstin_lookup | gstin, status, legal_name, trade_name, address, state_code, pincode, fetched_at | mixed | Y | C | I11 cache: one row per GSTIN | 06ANJPA3053F1ZI, ACTIVE | Saves the gstinapi.in free quota |
| purchase_order | po_number | text unique | Y on issue | C | BR-30; series PO | ELPL/PO/2026/001 | Null while draft |
| purchase_order | vendor_id, po_date, expected_delivery_date, delivery_address, place_of_supply_state | mixed | Y | Manual/AF |  | Saiffi; 22 Jul 2026 |  |
| purchase_order | quote_ref, payment_terms_text, milestones_json, terms_text, notes | mixed | N | Manual | milestones: [{label, percent or amount, due_trigger}] | 40% advance, 60% on T1 approval |  |
| purchase_order | subtotal, cgst, sgst, igst, total | numeric | Y | C | Sum of lines | 28,91,000 (confirm incl. or excl. GST) |  |
| purchase_order | billed_taxable, billed_total, paid_total, advance_total, balance_to_bill | numeric | Y | C | BR-17 |  |  |
| purchase_order | status, revision_no, approved_by, approved_at, sent_at, pdf_attachment_id | mixed | Y | C | See Status Flows | partially_billed, R0 |  |
| po_line | po_id, line_no, purchase_item_id, description, hsn_sac, qty, unit, rate, discount, taxable, gst_rate, cgst, sgst, igst, line_total, qty_received (SYNC), qty_billed (C) | mixed | Y | Manual/C | BR-20 | Tooling moulds, 1 set | qty_received from Inventory GRN |
| vendor_document | doc_type | enum | Y | Manual | quote, proforma, tax_invoice, debit_note, credit_note | tax_invoice |  |
| vendor_document | vendor_id, doc_number, doc_date, received_date, po_id | mixed | Y (po_id N) | Manual | BR-19 duplicate check | Saiffi, 040, 24 Jul 2026, ELPL/PO/2026/001 |  |
| vendor_document | replaces_document_id | uuid | N | Manual | Tax invoice linked to the quote/PI it replaces (F057) |  |  |
| vendor_document | place_of_supply_state, reverse_charge | text, bool | Y | AF |  | 29, false |  |
| vendor_document | taxable_value, cgst, sgst, igst, other_charges, round_off, total_value | numeric | Y | C/Manual | Lines sum; editable to match vendor copy with warning | 9,80,000; 0; 0; 1,76,400; 0; 0; 11,56,400 |  |
| vendor_document | tds_applicable, tds_section_id, tds_base, tds_rate, tds_amount, tds_override_reason | mixed | Y | AF/C | BR-11, BR-12 | true, contract work, 9,80,000, 2%, 19,600 |  |
| vendor_document | advances_applied, net_payable, paid_amount, outstanding | numeric | Y | C | BR-18 | 0; 11,36,800; 11,36,800; 0 |  |
| vendor_document | category_id, sub_category_id, nature | mixed | Y | AF/Manual |  | Capex > Tooling & Moulds |  |
| vendor_document | payment_terms_id, due_date, status, itc_eligible, attachment_id, notes | mixed | Y | AF/C | BR-23 |  | itc_eligible is info for CA |
| vendor_document_line | doc_id, po_line_id, description, hsn_sac, qty, unit, rate, taxable, gst_rate, cgst, sgst, igst | mixed | Y | Manual/AF |  |  |  |
| payment_out | payment_no | text unique | Y | C | Series PMT | PMT-0001 | Keep existing numbering |
| payment_out | vendor_id (or payee_type + payee_id), request_date, requested_by, purpose | mixed | Y | Manual |  |  |  |
| payment_out | amount, tds_amount_on_advance, mode, from_bank_account_id, paid_date, utr, proof_attachment_id | mixed | Y on paid | Manual | BR-08 | 11,36,800; RTGS; IDFC; 24 Jul 2026; IDFBR62026072403779464 |  |
| payment_out | status, approved_by_1, approved_by_2, approved_at, bank_txn_id | mixed | Y | C | BR-26 | reconciled |  |
| payment_allocation | payment_out_id, target_type, target_id, amount | mixed | Y | Manual/C | target_type: vendor_document, po_milestone, advance |  |  |
| vendor_advance | vendor_id, payment_out_id, against_doc_id, amount, applied_amount, balance, applied_to_doc_id | mixed | Y | C | BR-09 | Valco ₹62,640 against PI 931842454696864 |  |
| tds_section | code_old_act, code_new_act, nature, rate_individual, rate_others, rate_no_pan, single_threshold, annual_threshold, effective_from, effective_to | mixed | Y | Manual (CA confirms) | BR-12 | 194C / [new Act code], contract work, 1%, 2%, 20%, 30,000, 1,00,000 | [Verify] all values |
| gst_rate | rate, effective_from, effective_to, note | numeric(5,2), date, date, text | Y | Manual | F004. 0 to 100; unique per rate and start date | 18, 22 Sep 2025 | [Verify] Sep 2025 rates |
| payment_term | label, days, is_advance, sort_order, is_active | mixed | Y | Manual | F009, BR-23. Advance terms: due on the document date | Net 30, 30 | Seeded: Advance, On receipt, On delivery, Net 7/15/30/45 |
| approval_rule | applies_to, amount_from, amount_to, approvers_required, is_enabled | mixed | Y | Manual | F007, BR-26. All bands off (Q9) | payment, 2,00,000, -, 2, off |  |
| period_lock | entity_id, month, is_locked, locked_at, locked_by, unlocked_at, unlocked_by, unlock_reason | mixed | Y | Manual | F008, BR-36. month = first day; unlock needs a reason (database check); only ended months can be locked | 1 Jun 2026, locked |  |
| tds_entry | source_type, source_id, vendor_id, pan, section_id, deduction_date, base_amount, rate, tds_amount, month, quarter, fy | mixed | Y | C | BR-11 | Saiffi, 24 Jul 2026, 9,80,000, 2%, 19,600, Jul, Q2, 26-27 |  |
| tds_entry | status, challan_id, return_filed_quarter, form16a_issued, form16a_attachment_id | mixed | Y | C/Manual |  | deposited |  |
| tds_challan | challan_serial, bsr_code, deposit_date, section_id, tds_amount, interest, fee, total, bank_txn_id, attachment_id | mixed | Y | Manual | BR-14 | 5 Aug 2026, ₹19,600 |  |
| customer (SYNC from CRM) | crm_customer_id, crm_company_id, crm_outlet_id, name, gstin, billing_address, shipping_address, state_code, contacts | mixed | Y | SYNC | Read only in Finance |  | CRM fields: Company Name, Outlet Name, GST number, Billing Address, Shipping Address |
| customer_finance_profile | crm_customer_id, crm_outlet_id, payment_terms_id, credit_limit, invoice_emails, deducts_tds, tds_section_id, price_list_id, channel | mixed | N | Manual | channel: horeca, d2c, marketplace, distributor |  |  |
| product (SYNC from Inventory) | inv_product_id, sku, name, hsn, gst_rate, unit, is_active | mixed | Y | SYNC | Read only in Finance |  |  |
| price_list / price_list_item | name, tax_inclusive, effective_from; product_id, price, min_qty | mixed | Y | Manual |  | HoReCa price list |  |
| purchase_item | name, hsn_sac, unit, default_gst_rate, preferred_vendor_id, last_rate | mixed | N | Manual/C |  | Aluminium extrusion die |  |
| sales_document | doc_type | enum | Y | Manual | quotation, proforma, tax_invoice, credit_note, delivery_challan | tax_invoice |  |
| sales_document | doc_number, doc_date, series_id | mixed | Y on issue | C | BR-30 | ELPL/26-27/0001 |  |
| sales_document | crm_customer_id, crm_outlet_id, crm_order_id, bill_to_json, ship_to_json, place_of_supply_state, customer_gstin | mixed | Y | SYNC/AF | Snapshot at issue so later CRM edits do not change an issued invoice |  |  |
| sales_document | customer_po_ref, reverse_charge, eway_bill_no, transporter, vehicle_no, channel | mixed | N | Manual | BR-42 |  |  |
| sales_document | subtotal, discount, taxable_value, cgst, sgst, igst, freight, round_off, total, amount_in_words | numeric/text | Y | C | BR-20, BR-21 |  |  |
| sales_document | source_doc_id (PI for invoice, invoice for CN), advances_applied, received_amount, tds_by_customer, outstanding, due_date | mixed | Y | C | BR-33, BR-41 |  |  |
| sales_document | status, issued_at, issued_by, cancelled_at, cancel_reason, pdf_attachment_id, sent_at | mixed | Y | C | See Status Flows |  |  |
| sales_document_line | doc_id, line_no, product_id, description, hsn, qty, unit, rate, discount, taxable, gst_rate, cgst, sgst, igst, line_total | mixed | Y | AF/Manual | HSN required |  |  |
| payment_in | receipt_no, crm_customer_id, receipt_date, amount, mode, to_bank_account_id, reference, tds_deducted, bank_charges, settlement_batch_id, bank_txn_id, status | mixed | Y | Manual/C | BR-38 | RCT-0001 |  |
| receipt_allocation | payment_in_id, sales_document_id, amount | mixed | Y | Manual/C |  |  |  |
| settlement_batch | source (razorpay, shiprocket_cod, amazon), settlement_id, settlement_date, gross, fees, tax_on_fees, refunds, adjustments, net, bank_txn_id | mixed | Y | Import | BR-39, BR-40 |  |  |
| capital_receipt | founder, receipt_date, amount, type, allotment_date, shares_allotted, bank_txn_id | mixed | Y | Manual | type: paid_up_capital, share_application_money | Rishabh, 30 May 2026, 50,000, paid_up_capital |  |
| loan | lender, sanction_amount, disbursed_amount, disbursed_date, interest_rate, tenure_months, moratorium_months, emi_amount, emi_day, agreement_attachment_id, counts_toward_covenant | mixed | Y | Manual | BR-28 | Neos Kosmos (Mesa), 12,00,000, 4 Jun 2026 |  |
| loan_schedule | loan_id, instalment_no, due_date, principal, interest, total, paid_date, bank_txn_id | mixed | Y | C |  |  |  |
| expense_claim | founder, expense_date, paid_from, vendor_name, amount, has_gst_invoice, category_id, sub_category_id, attachment_id, status, reimbursement_txn_id | mixed | Y | Manual | BR-27 |  |  |
| number_series | doc_type, fy_label, pattern, padding, next_number, is_active, note | mixed | Y | Manual | BR-30. pattern uses {FY} and {N}; fy_label null = never resets (PMT, RCT); next_number can only go up (database check); tax invoice / credit note checked for 16 characters | tax_invoice, 26-27, ELPL/{FY}/{N}, 5, 1, off | Sales series (tax invoice, credit note, proforma) seeded off until the invoicing entity is confirmed; switching on needs a reason |
| attachment | record_type, record_id, doc_kind, file_name, original_name, mime_type, size_bytes, sha256, storage, storage_key, folder_path, note, uploaded_by, is_archived, archived_reason | mixed | Y | C | F160. doc_kind: gst_cert, pan, cancelled_cheque, msme_cert, agreement, statement, proof, bill, other. storage: drive or local; storage_key = Drive file id or local path; folder_path = /Finance/{FY}/{Module}/{Record} | Vendor, Saiffi-Industries_GST-certificate.pdf, /Finance/26-27/Vendors/Saiffi-Industries | Never deleted: removing archives with a reason |
| approval | record_type, record_id, approver_id, decision, comment, decided_at | mixed | Y | Manual | BR-26 |  |  |
| audit_log | record_type, record_id, action, field, old_value, new_value, user_id, at, reason | bigint, text, enum, text, jsonb, jsonb, text, timestamptz, text | Y | C | BR-43. action: create, update, archive, cancel, unlock, delete_refused, other. Written by a database trigger on every insert/update of every finance table, in the same transaction; one row per changed field; password hashes masked. | update, field firstName, Test to Changed | Append only (the database refuses update and delete). user_id = User.id, or 'system' for seed and jobs |
| user | first_name, last_name, email, password_hash, role_id, is_active, failed_login_attempts, locked_until, last_login_at | mixed | Y | Manual | @blocinsects.com only; same shape as the Bloc CRM User | Rishabh Agarwal | Seeded with the two founders (Q18) |
| role | name, description, permissions, is_active | text, text, jsonb, bool | Y | Manual | permissions = {module: {view, edit}} as in Bloc; finance modules prefixed (financeBank, financeVendors, ...) | FINANCE_ADMIN | Joins the CRM's Role rows on merge |
| bank_account | sanctioned_limit, drawing_power, drawing_power_as_of, interest_rate, renewal_date | numeric, numeric, date, numeric, date | Y for cash_credit | Manual | BR-50 | PNB CC (when opened) | Cash credit accounts only |
| crm_order (SYNC, same database) | crm_order_id, order_date, channel, customer_id, payment_method, order_amount, cod_amount, razorpay_order_id / payment_id, shopify_order_no, shiprocket_order_id, awb, shipment_status, shipped_at, delivered_at, rto_flag, cancelled_at | mixed | Y | SYNC (read via view) | Owned by CRM; Finance never writes |  | Q23: confirm which payment IDs the CRM stores |
| gateway_transaction | source (razorpay), external_payment_id, external_order_id, crm_order_id, method (card/upi/netbanking/wallet), amount, fee, tax_on_fee, status (captured/refunded/failed), captured_at, refunded_amount, settlement_id, raw_json | mixed | Y | Import (API) | Unique on source + external_payment_id | pay_XXXX, ₹1,499, fee ₹29.98 |  |
| settlement_line | settlement_batch_id, gateway_transaction_id or awb, crm_order_id, gross, fee, tax_on_fee, refund, adjustment, net | mixed | Y | Import | Sum of net = batch net (BR-47) |  | One row per order inside a settlement or COD remittance |
| order_payment_status (view / materialised) | crm_order_id, route (razorpay/cod/direct), order_amount, invoice_id, collected_amount, collected_at, settlement_batch_id, expected_bank_date, bank_txn_id, bank_date, fees, net_received, status, is_overdue, discrepancy_types, discrepancy_amount | mixed | Y | C | BR-44 to BR-47 |  | Readable by CRM (F200) |
| recon_discrepancy | crm_order_id or settlement_batch_id, type_code, amount, detected_at, suggested_action, resolution_action, resolution_note, resolved_by, resolved_at | mixed | Y | C / Manual | BR-46 | type 1, ₹499 |  |
| recon_settings | razorpay_settlement_days, cod_remittance_days, settlement_to_bank_days, grace_days, amount_tolerance, expected_fee_rate, holiday_list | mixed | Y | Manual | BR-45, BR-46 | 3, [from Shiprocket], 1, 2, ₹1, 2% |  |

## Status Flows

Allowed statuses and transitions. (C) = computed by the system, (M) = user action. Users never type a computed status.

| Object | Status | Meaning | How it is set | Next allowed | Side effects / locks |
|---|---|---|---|---|---|
| Vendor | Draft | Being created, not usable on POs or payments | (M) Save | Pending Review, Active |  |
| Vendor | Pending Review | Submitted (or self-onboarded), needs finance check | (M) Submit | Active, Draft |  |
| Vendor | Active | Can be used everywhere | (M) Approve | Blocked | Missing documents shown as warnings, not blocks |
| Vendor | Blocked | No new POs or payments | (M) Block with reason | Active | Open bills stay visible |
| Purchase Order | Draft | Editable, no number | (M) Save | Pending Approval, deleted |  |
| Purchase Order | Pending Approval | Waiting for approver(s) per band | (M) Submit | Approved, Draft (rejected) | Editing sends it back to Draft |
| Purchase Order | Approved | Number assigned, PDF generated | (C) Final approval | Sent, Cancelled | Lines locked; changes only via amendment |
| Purchase Order | Sent | Shared with vendor | (M) Send / mark sent | Partially Billed, Fully Billed, Cancelled, Closed |  |
| Purchase Order | Partially Billed | Some value billed by tax invoice | (C) BR-17 | Fully Billed, Closed | Amendment allowed (revision) |
| Purchase Order | Fully Billed | Billed value = PO value | (C) BR-17 | Closed |  |
| Purchase Order | Closed | Short-closed or complete | (M) Close | - | No new bills can link |
| Purchase Order | Cancelled | Cancelled before any billing/payment | (M) Cancel with reason | - | Number kept |
| Vendor Document | Awaiting Tax Invoice | Quote or proforma captured; advance may be paid | (C) doc_type quote/proforma | Replaced, Cancelled | Counts in 'money out without tax invoice' |
| Vendor Document | Received | Tax invoice entered, not yet approved for payment | (M) Save | Approved, Disputed, Cancelled |  |
| Vendor Document | Approved | OK to pay | (M) Approve | Partially Paid, Paid, Disputed |  |
| Vendor Document | Partially Paid | 0 < paid < net payable | (C) BR-18 | Paid, Overdue |  |
| Vendor Document | Paid | Outstanding = 0 | (C) BR-18 | - | Locked |
| Vendor Document | Overdue | Past due date, outstanding > 0 | (C) BR-22 | Partially Paid, Paid | Shown as a flag alongside the payment status |
| Vendor Document | Disputed | On hold | (M) Dispute with reason | Approved, Cancelled | Excluded from payment runs |
| Vendor Document | Replaced | Quote/PI superseded by the tax invoice | (C) F057 | - | Advances moved to the tax invoice |
| Vendor Document | Cancelled | Entered in error or withdrawn by vendor | (M) Cancel with reason | - | Only if nothing allocated |
| Payment Out | Requested | Draft payment awaiting approval | (M) Create request | Approved, Rejected |  |
| Payment Out | Approved | Approved, not yet paid | (C) Final approval | Paid, Cancelled | Amount locked; edit resets approval |
| Payment Out | Paid | Marked paid with UTR and date | (M) Record payment | Reconciled, Failed | TDS entry created if not already |
| Payment Out | Reconciled | Linked to bank statement row | (C) Bank match | - | Locked |
| Payment Out | Failed / Reversed | Bank returned the payment | (M) or (C) reversal row | Requested (retry) | Allocations removed |
| Payment Out | Rejected / Cancelled | Not going ahead | (M) | - |  |
| Bank Transaction | Review | No confident suggestion | (C) Import | Suggested, Categorised, Ignored | Blocks month lock |
| Bank Transaction | Suggested | Category suggested by rules, not confirmed | (C) BR-05 | Categorised, Review | Blocks month lock |
| Bank Transaction | Categorised | Category confirmed, no document link needed or not yet linked | (M) Confirm / bulk accept | Matched, Split |  |
| Bank Transaction | Matched | Linked to payment, receipt, challan, loan EMI or capital receipt | (C) Match | Categorised (unmatch) | Category inherited from the document |
| Bank Transaction | Split | Divided into lines | (M) Split | Review (unsplit, with a reason) | Each line has its own status |
| Bank Transaction | Transfer | Paired own-account transfer | (C) BR-06 | Review (unpair, with a reason; both rows) | Excluded from income/expense |
| Bank Transaction | Ignored | Reversal pair or test credit with note | (M) with note | Review | Excluded from dashboards; audited |
| Proforma Invoice | Draft | Editable, no number | (M) Save | Issued |  |
| Proforma Invoice | Issued / Sent | Number assigned, shared with customer | (M) Issue / Send | Accepted, Expired, Cancelled, Converted |  |
| Proforma Invoice | Accepted | Customer confirmed or advance received | (M) or (C) advance receipt | Converted, Partly Converted |  |
| Proforma Invoice | Partly Converted | Some quantity invoiced | (C) | Converted |  |
| Proforma Invoice | Converted | Fully invoiced | (C) | - | Locked |
| Proforma Invoice | Expired | Validity date passed without acceptance | (C) daily | Issued (revalidate) |  |
| Tax Invoice | Draft | Editable, no number | (M) Save | Issued, deleted |  |
| Tax Invoice | Issued | Number assigned, locked | (M) Issue (passes BR-32 checks) | Sent, Partially Paid, Paid, Cancelled | Customer and address snapshot stored |
| Tax Invoice | Sent | Shared with customer | (M) Send | Partially Paid, Paid |  |
| Tax Invoice | Partially Paid | 0 < received + TDS < total | (C) | Paid |  |
| Tax Invoice | Paid | Received + TDS + credit notes = total | (C) | - |  |
| Tax Invoice | Overdue | Past due, outstanding > 0 | (C) BR-22 | Partially Paid, Paid | Flag alongside status |
| Tax Invoice | Cancelled | Cancelled before reporting in GSTR-1 | (M) BR-34 | - | Number kept, PDF watermarked |
| Credit Note | Draft / Issued / Applied / Refunded | Applied = adjusted against invoice; Refunded = money returned | (M)/(C) |  |  |
| TDS Entry | Deducted | Deduction recorded on bill/payment | (C) BR-11 | Deposited | Shows in payable for that month |
| TDS Entry | Deposited | Linked to challan | (C) BR-14 | Return Filed |  |
| TDS Entry | Return Filed | Included in quarterly return | (M) mark quarter filed | 16A Issued |  |
| TDS Entry | 16A Issued | Certificate shared with vendor | (M) | - |  |
| Expense Claim | Submitted / Approved / Reimbursed / Rejected |  | (M)/(C) on bank match |  |  |
| Order Payment (M18) | Awaiting payment | Prepaid order not yet captured, direct-pay order not yet received, or credit order not yet due | (C) BR-44 | Paid at gateway, In bank, Cancelled | Credit orders show the due date |
| Order Payment (M18) | Awaiting delivery | COD order shipped, not yet delivered | (C) from CRM/Shiprocket status | Delivered, RTO / Cancelled |  |
| Order Payment (M18) | Paid at gateway | Razorpay captured; waiting for settlement | (C) Razorpay sync | Settled, Refunded | Counts as money in transit |
| Order Payment (M18) | Delivered, awaiting remittance | COD collected by courier; waiting for Shiprocket remittance | (C) delivery status | Remitted, RTO / Cancelled | Counts as money in transit |
| Order Payment (M18) | Settled / Remitted | Included in a Razorpay settlement or Shiprocket remittance; waiting for bank credit | (C) settlement or remittance import | In bank | Counts as money in transit |
| Order Payment (M18) | In bank | Settlement/remittance/receipt matched to an IDFC credit | (C) BR-47 | Refunded (later refund) | Final |
| Order Payment (M18) | Refunded | Money returned to customer | (C) Razorpay refund or manual refund | - | Links to credit note if invoiced |
| Order Payment (M18) | RTO / Cancelled | Nothing expected | (C) CRM status | - | Credit note if already invoiced (BR-48) |
| Order Payment (M18) | Written off | Accepted loss with reason | (M) Admin | - | Audited |
| Order Payment (M18) | Flag: Overdue | Past expected bank date + grace | (C) BR-45 | Clears when the next stage is reached | Shown with any state above |
| Order Payment (M18) | Flag: Discrepancy | One or more BR-46 checks failed | (C) BR-46 | Cleared when resolved with a note | Shown with any state above |

## Documents & Numbering

Documents the app generates, numbering formats, mandatory content, and the review of the current invoice layout.

| Document | Number format | Example | Length | Reset | Created from | Must show on PDF | Layout notes | Sent via |
|---|---|---|---|---|---|---|---|---|
| Purchase Order | ELPL/PO/{FY}/{NNN} | ELPL/PO/26-27/002 | 17 | FY (switched now; existing ELPL/PO/2026/001 stays as is) | Manual, or from a purchase request | Company name, address, GSTIN, PAN; PO no, date, revision; vendor name, address, GSTIN; delivery address; lines with HSN, qty, unit, rate, GST, totals; amount in words; payment milestones; delivery date; T&C; authorised signatory | Match the signed Saiffi PO layout so vendors see no change | Email PDF, WhatsApp share, download |
| Proforma Invoice | ELPL/PI/{FY}/{NNNN} | ELPL/PI/26-27/0001 | 18 | FY | CRM order or manual | Title 'Proforma Invoice', clearly marked 'not a tax invoice'; same body as tax invoice; validity date; bank details and UPI QR for advance | Same template as tax invoice with different title and footer | Email, WhatsApp, download |
| Tax Invoice (B2B and B2C) | ELPL/{FY}/{NNNNN} | ELPL/26-27/00001 | 16 (max allowed) | FY | B2B: proforma, CRM order or manual. D2C: automatic when CRM order ships (BR-48) | All BR-32 fields; 'Original for Recipient' / 'Duplicate for Transporter' / 'Triplicate for Supplier'; HSN summary table; amount in words; reverse charge: No; e-way bill no if any; bank details; UPI QR; signature; declaration | One series for B2B and B2C; 5 digits leave room for D2C volume. B2B shows recipient GSTIN; B2C shows name, address, state (BR-49) | Email, WhatsApp, download; link back to CRM order |
| (Separate D2C series) | Not used | - | - | - | - | - | Dropped: one series covers both since this app issues all invoices | - |
| Credit Note | ELCN/{FY}/{NNNN} | ELCN/26-27/0001 | 15 | FY | Tax invoice | Original invoice no and date, reason, lines, GST reversed |  | Email, download |
| Payment Voucher | PMT-{NNNN} | PMT-0006 | 8 | Never (continue current) | Payment out | Internal only: vendor, bills settled, TDS, UTR, approvers |  | Internal |
| Receipt Voucher | RCT-{NNNN} | RCT-0001 | 8 | Never | Payment in | Customer, invoices settled, mode, reference; can be emailed as payment acknowledgement |  | Email (optional) |
| Vendor Statement | - | - | - | - | Vendor 360 | Opening balance, bills, payments, TDS, advances, closing balance for a date range |  | Email, download |
| Customer Statement | - | - | - | - | Customer 360 | Opening balance, invoices, receipts, credit notes, closing balance |  | Email, download |
| Delivery Challan (P2) | ELDC/{FY}/{NNN} | ELDC/26-27/001 | 14 | FY | Manual | Consignor, consignee, items, qty, value, purpose (trial/demo/job work) |  | Download |
| Numbering rules |  |  |  |  |  |  |  |  |
| 1 | Number assigned only at Issue/Approve, inside one database transaction (BR-30). |  |  |  |  |  |  |  |
| 2 | No gaps, no reuse. A cancelled document keeps its number and shows 'CANCELLED'. |  |  |  |  |  |  |  |
| 3 | Only letters, digits, '/' and '-' in tax invoice and credit note numbers; max 16 characters. |  |  |  |  |  |  |  |
| 4 | Admin can set the starting number of a series once (for migration), never decrease it. |  |  |  |  |  |  |  |
| Current invoice layout (Sales <> Master Data, Proforma Invoice tab) |  |  |  |  |  |  |  |  |
| Kept | Title; contact email and phone; brand line; company address and GSTIN; invoice date and number; Bill to and Ship to (with customer PO no and date); customer GSTIN and state code; lines with S.No, description, qty, rate (excl. GST), disc %; additional B2B discount line; taxable amount; IGST or CGST + SGST; total with piece count; amount in words; 12-month warranty text; bank details; declaration; authorised signatory; computer-generated note; 'quotation sent by'. |  |  |  |  |  |  |  |
| Added for tax invoices | HSN per line and HSN summary; place of supply (state name and code); tax rate and amount per tax head; reverse charge: No; round off; e-way bill no when applicable. |  |  |  |  |  |  |  |
| Must change | Legal name, address, GSTIN and bank account must be Entelechy Labs Pvt Ltd (29AAJCE7255M1ZX, IDFC 88062419345). The current sheet still prints Newera Living (29AAYFN4098H1ZB, account 10245658808) on documents dated Jul and Aug 2026. |  |  |  |  |  |  |  |
| Numbers seen today | PI-BLC2607 to PI-BLC2645, BLC-251153, BLC-251491, BLC-260580, 260430, 260435, 260442, TL-20604. These are Newera-era series; Entelechy's series start fresh in the app. |  |  |  |  |  |  |  |
| Prices seen today (excl. GST) | Trap Pro ₹4,236.44; Trap Pro distributor ₹2,541.53; mosquito lure sachet ₹253.39 on PIs but ₹120.34 on the tax-invoice template; sachet pack of 2 ₹507.63; pack of 4 ₹846.61; pack of 6 ₹401.69; mouse repellent sachet ₹250. Free sachets are added as lines at 100% discount. Price list to be confirmed before seeding (F121). |  |  |  |  |  |  |  |

## Dashboards & Reports

Every metric with its exact definition and formula.

| ID | Dashboard / Report | Widget / Metric | Definition | Formula | Filters | Drill-down | Priority |
|---|---|---|---|---|---|---|---|
| D01 | Home | Cash in business accounts | Latest statement balance per business current account plus manual cash. Cash credit excluded (BR-50). | Sum of last balance per bank_account where type = business_current or wallet | As-of date | Per-account balances and last import date | P0 |
| D02 | Home | Gross burn (month) | Operating cash out | Sum of outflows with nature in (Operating Expense, COGS, Interest) | Month | Category breakdown | P0 |
| D03 | Home | Net burn (month) | Operating cash out minus operating cash in | D02 - sum of inflows with nature = Operating Income | Month | Inflows and outflows | P0 |
| D04 | Home | Runway (months) | How long cash lasts at recent burn | D01 / average D03 of last 3 complete months; 'Cash positive' if average <= 0 | - | Burn trend chart | P0 |
| D05 | Home | Capex this month / FY | Tooling, moulds, equipment | Sum of outflows with nature = Capex | Month, FY | Transactions | P0 |
| D06 | Home | Funding received (FY) | Equity and loans in | Sum of inflows with nature = Financing In, split by capital / share application money / loan | FY | Capital and loan registers | P0 |
| D07 | Home | Payables due (7 days) / overdue | Approved bills to pay | Sum outstanding where due_date <= today + 7; overdue separately | - | Due list | P0 |
| D08 | Home | Receivables due / overdue | Money owed to us | Sum outstanding of issued invoices; overdue separately | - | Outstanding list | P0 |
| D09 | Home | TDS payable and due date | TDS deducted last month not yet deposited | Sum tds_entry where status = Deducted grouped by month; days to due date | - | TDS register | P0 |
| D10 | Home | Action items | Things needing a person | Counts: bank rows in Review, approvals pending, advances without tax invoice > 15 days, MSME payments near 45 days, statements not imported for 7+ days, missing attachments | - | Each list | P0 |
| D11 | Category Analytics | Expense by category x month | Pivot table | Sum of outflows (or bills in accrual view) by category and month, nature in Operating Expense / COGS | FY, nature, category, vendor, account | Category, then sub-category, then transactions | P0 |
| D12 | Category Analytics | Income by category x month | Pivot table | Sum of inflows (or invoices in accrual view) by category and month | FY, channel | Transactions / invoices | P0 |
| D13 | Category Analytics | Month-on-month change | Change vs previous month | (This month - last month) / last month per category; guard last month = 0 | Month | - | P0 |
| D14 | Category Analytics | Top vendors by spend | Ranking | Sum of payments by vendor for the period | Period, category | Vendor 360 | P0 |
| D15 | Category Analytics | Management P&L | Simple P&L from categories | Income - COGS = Gross profit; - Operating expenses = Operating profit (EBITDA proxy); - Interest | Month, quarter, FY; cash or accrual | Category lines | P1 |
| D16 | Payables | Total invoices received (count) | From current AP Dashboard | Count of vendor documents (quote, PI, tax invoice) not cancelled | Period | Register | P0 |
| D17 | Payables | Total invoiced value | From current AP Dashboard | Sum total_value | Period | Register | P0 |
| D18 | Payables | Total net payable | From current AP Dashboard | Sum net_payable | Period | Register | P0 |
| D19 | Payables | Total paid to date incl. advances | From current AP Dashboard | Sum of payment_out amount (status Paid/Reconciled) | Period | Payment-Out Log | P0 |
| D20 | Payables | Total outstanding payable | From current AP Dashboard | Sum outstanding | - | Due list | P0 |
| D21 | Payables | Fully / partially / unpaid count | From current AP Dashboard | Count by status | - | Register filtered | P0 |
| D22 | Payables | Money out with no tax invoice yet | From current AP Dashboard | Sum vendor_advance.balance where linked doc is quote/PI (BR-10) | - | Chase list | P0 |
| D23 | Payables | Invoices with no PO | From current AP Dashboard | Count and value of tax invoices with po_id null | Period | Register filtered | P0 |
| D24 | Payables | AP ageing | Buckets | BR-24 | As-of date | Vendor, then bills | P0 |
| D25 | Payables | MSME exposure | Amounts at risk of breaching 45 days | Outstanding to micro/small vendors with days since acceptance > 30 | - | Bills | P0 |
| D26 | Receivables | AR ageing | Buckets | BR-24 | As-of date, channel | Customer, then invoices | P0 |
| D27 | Receivables | DSO | Days sales outstanding | AR outstanding / credit sales of last 90 days x 90 | - | - | P1 |
| D28 | Receivables | Collections trend | Money collected per month | Sum payment_in by month | Channel | Receipts | P0 |
| D29 | Purchase | PO status | Open PO commitments | Sum (PO value - billed) for POs not Closed/Cancelled; plus unpaid milestones | Vendor | PO Register | P0 |
| D30 | TDS | TDS register | All deductions | tds_entry list with challan details | FY, quarter, section, vendor | Source bill/payment | P0 |
| D31 | Funding | Debt vs covenant | Mesa aggregate debt cap | Sum principal outstanding (plus undrawn sanctioned if counted) vs ₹45L | - | Loan register | P1 |
| D32 | Founder | Founder balances | Owed to each founder | Approved claims - reimbursements per founder | - | Claims | P1 |
| D33 | Forecast | 13-week cash forecast | Expected cash by week | Opening cash + expected receipts (open invoices by due date) - expected payments (bills by due date, PO milestones, EMIs, TDS by 7th, recurring costs) | - | Each expected item | P1 |
| R01 | Report | Ledger export | All bank rows with categories | - | Period, account | - | P0 |
| R02 | Report | Vendor ledger / statement | - | - | Vendor, period | - | P0 |
| R03 | Report | Customer ledger / statement | - | - | Customer, period | - | P0 |
| R04 | Report | GST working for CA | Outward and inward GST by invoice and HSN | Information only | Month | - | P1 |
| R05 | Report | Related party transactions | Newera Living, founders, Mesa | BR-29 | FY | - | P1 |
| R06 | Report | Missing documents | Records without required attachment | F161 | - | - | P0 |
| D34 | Home / Order-to-Bank | Money in transit | Customer has paid (or courier has collected) but money is not yet in the bank | Sum by stage: Paid at gateway + Delivered awaiting remittance + Settled/Remitted not in bank; each split into on-time and overdue | Route, channel, age | Orders in that stage | P0 |
| D35 | Order-to-Bank | Discrepancies | Open mismatches | Count and value of open recon_discrepancy by type | Type, route, period | Discrepancy queue | P0 |
| D36 | Order-to-Bank | Order-to-bank funnel | Where each month's order value is | Order value, then collected, then settled/remitted, then in bank, then refunded/RTO, by order month | Month, channel | Orders | P0 |
| D37 | Order-to-Bank | Days to bank | Speed of collection | Average and 90th percentile of (bank date - order date) by route | Month, route | Orders | P1 |
| D38 | Home | Cash credit headroom and liquidity | Undrawn credit available | min(sanctioned, drawing power) - drawn; liquidity = cash + headroom (BR-50) | - | CC account | P1 |

## Integrations

One owner system per record; others read it.

| ID | System | Direction | Objects | Trigger | Method (recommended) | Owner of truth | Priority | Notes / open points |
|---|---|---|---|---|---|---|---|---|
| I01 | BLOC CRM | CRM to Finance | Customer, company, outlet, contacts, GSTIN, billing and shipping address | On read (live) or on change | Same Postgres database later. Finance reads CRM tables through its CRM reader module (read-only queries); stub tables until the apps share a database; no sync job. | CRM | P0 | Decided: shared Postgres. CRM Company page already captures GSTIN (API lookup), billing address and outlet. |
| I02 | BLOC CRM | CRM to Finance | Order (lines, qty, price, channel, payment mode UPI/COD/Razorpay, advance paid, GST applicable toggle) | CTA 'Create Proforma' or 'Create Invoice' on CRM order; or Finance picks an order | Finance exposes an invoice service (create / issue / PDF / cancel). The CRM's 'Create invoice' button calls it; D2C invoices are created automatically when the order ships (BR-48). | CRM owns the order; Finance owns numbering, tax maths, templates and the invoice register | P0 | Sales issue invoices from the CRM, but the code and the log live in Finance (F105). GSTIN presence decides B2B vs B2C (BR-49). |
| I03 | BLOC CRM | Finance to CRM | Invoice no, invoice PDF link, invoice status, amount received, outstanding, overdue flag | On issue and on every receipt | Finance writes to its own tables; CRM reads the order_payment_status and invoice views. | Finance | P0 | Sales sees invoice and payment status on the order without opening Finance (F200). |
| I04 | Inventory app | Inventory to Finance | Products, SKU, HSN, GST rate, unit | On change | bloc-inv sends its catalog to the CRM's Product table; Finance reads products through its CRM reader module. | Inventory | P0 | Decided: shared Postgres. Confirm the Inventory app holds HSN and GST rate per SKU. |
| I05 | Inventory app | Inventory to Finance | Goods receipt (GRN) against PO line: qty received, date | On GRN | Webhook | Inventory | P1 | Enables PO vs receipt vs bill check (three-way match) before paying. |
| I06 | Inventory app | Finance to Inventory | Tax invoice issued (stock out for B2B if not already done by CRM dispatch); credit note with returned goods (stock in) | On issue | Webhook | Inventory owns stock | P1 | Decide which event reduces stock: CRM dispatch or Finance invoice. Only one may do it (Q7). |
| I07 | Banks (IDFC now, PNB cash credit later) | Bank to Finance | Statement rows | Manual upload weekly | File upload with a parser per bank (BR-01 to BR-03) | Bank | P0 | Adding a bank = new account record + parser (F003, F024). Later option: email-forwarded statements parsed automatically (P2). |
| I08 | Razorpay | Razorpay to Finance | Payments, refunds, settlements, per-payment settlement mapping, fees, tax on fees | Daily | Razorpay API (daily pull) | Razorpay | P0 | Feeds M18. Settlements reach IDFC in 2-3 days. Q23: which ID links a Razorpay payment to a CRM order. |
| I09 | Shiprocket | Shiprocket to Finance | Delivery status (already in CRM), COD remittances with AWB list, freight invoices | On remittance | Delivery status via CRM; COD remittance via Shiprocket API at AWB level | Shiprocket | P0 | Feeds M18. Freight charged to wallet, not deducted. Freight invoices become vendor bills (Logistics). |
| I10 | Shopify / Amazon | Via CRM | D2C and marketplace orders | - | Already flowing into CRM; Finance reads through CRM | CRM | P1 | Amazon settlement reports can be imported like Razorpay (P2). |
| I11 | GSTIN API | Finance to API | GSTIN details for vendors and customers | On entry | Same provider as CRM (gstinapi.in) | - | P0 | Same key (GSTINAPI_KEY) and response mapping as the CRM; Finance caches lookups in its own gstin_lookup table until the apps share a database. |
| I12 | India Post pincode API | Finance to API | City, state from pincode | On entry | Same as CRM | - | P0 |  |
| I13 | IFSC lookup (Razorpay IFSC API, free) | Finance to API | Bank and branch from IFSC | On entry | API | - | P0 | https://ifsc.razorpay.com/{IFSC}; fails soft (details can be typed). |
| I14 | Google Drive | Finance to Drive | All attachments and generated PDFs | On upload/generate | Drive API with service account; folder /Finance/{FY}/{Module}/ | Drive stores files; Finance stores IDs | P0 | Keeps files in your Workspace, searchable outside the app. Drive v3 REST with a service account (GOOGLE_SERVICE_ACCOUNT_JSON) under DRIVE_ROOT_FOLDER_ID, a folder in a Shared Drive (service accounts have no storage of their own). FILE_STORAGE=local keeps files on the server in the same layout until Drive is set up (D11). |
| I15 | Email (Google Workspace) | Finance out | PO, PI, invoice, reminders, statements | On send | Gmail API from finance@ or accounts@ mailbox | - | P0 | Sending address: finance@blocinsects.com. |
| I16 | WhatsApp | Finance out | Invoice and reminder messages with PDF link | On send | Share link (P0); WhatsApp Business API via your chosen provider (P2) | - | P1 | Ties into the WhatsApp automation you are setting up. |
| I17 | CA / Zoho Books / Tally | Finance to CA | Monthly pack; voucher import file | Month close | ZIP export (P1); Zoho Books API or Tally XML (P2) | CA books are statutory | P1 | CA uses Tally and wants a monthly Excel of transactions; documents go in one shared Drive folder. Tally XML import not needed in v1. |
| I18 | Claude (MCP) | Both | Ask questions of finance data; draft entries | On demand | Read-only MCP server over Finance views (P2) | - | P2 | Same pattern as the bloc-marketing MCP you already run. |

## Roles & Access

Permission matrix. v1 has only two Admin users.

| Area | Admin (founders) | Approver | Finance | Sales | Viewer / CA |
|---|---|---|---|---|---|
| Settings, number series, tax masters | Full | View | View | - | View |
| Users and roles | Full | - | - | - | - |
| Bank import and categorisation | Full | View | Create, edit | - | View |
| Rules manager | Full | View | Create, edit | - | - |
| Vendors | Full | View | Create, edit (bank change needs Admin approval) | View | View |
| Purchase orders | Full | Approve | Create, edit drafts | Create drafts (request) | View |
| Vendor bills | Full | Approve | Create, edit | - | View |
| Payment requests | Full | Approve | Create | Create (request only) | View |
| Record payment / reconcile | Full | View | Create | - | View |
| TDS | Full | View | Create, edit | - | View, export |
| Customers finance profile | Full | View | Edit | View | View |
| Proforma invoices | Full | View | Create, issue | Create, issue | View |
| Tax invoices | Full | View | Create, issue | Create drafts (Q19: issue?) | View |
| Cancel invoice / credit note | Full | Approve | Request | - | View |
| Receipts | Full | View | Create | View | View |
| Loans and capital | Full | View | View | - | View |
| Founder expense claims | Full | Approve (not own) | View | - | View |
| Dashboards | All | All | All | Sales and AR only | All |
| Period lock / unlock | Full | - | Lock only | - | - |
| CA export | Full | - | Generate | - | Generate |
| Audit log | View | View | View own | - | View |

## Category Master

Income/expense categories with Nature (BR-04). Seed data for the category tables.

| Category | Sub-category | Nature | Management P&L group | Change | Note |
|---|---|---|---|---|---|
| Revenue | Razorpay | Operating Income | Revenue |  | Via settlement batches (BR-39) |
| Revenue | Shiprocket COD Remittance | Operating Income | Revenue |  | BR-40 |
| Revenue | Direct Transfer | Operating Income | Revenue |  |  |
| Revenue | Cash Deposit | Operating Income | Revenue |  |  |
| Revenue | Aggregated Revenue | Operating Income | Revenue |  | Avoid for new entries; use the specific source |
| Revenue | Amazon | Operating Income | Revenue |  |  |
| Revenue | Paypal | Operating Income | Revenue |  |  |
| Revenue | HoReCa B2B Invoice Receipt | Operating Income | Revenue | New | Receipts against tax invoices |
| Grants / External Income | MSL Grant | Operating Income | Other income |  | Confirm grant terms with CA |
| Grants / External Income | MSL Cheque | Operating Income | Other income |  |  |
| Grants / External Income | Interest Income | Operating Income | Other income |  |  |
| Grants / External Income | Misc Income | Operating Income | Other income |  |  |
| Founder Funds | Investment - Arnav | Financing In | Below the line | Changed | Today booked as Type = Income. Split into Paid-up capital / Share application money / Director loan |
| Founder Funds | Investment - Rishabh | Financing In | Below the line | Changed | Same as above |
| Financing | Loan Received | Financing In | Below the line | New | Mesa ₹12L on 4 Jun is booked as Income today |
| Financing | Loan Principal Repaid | Financing Out | Below the line | New |  |
| Financing | Loan Interest | Interest | Interest | New |  |
| Related Party | Newera Living Transfer | Related Party | Below the line | New | ₹7L on 19 Aug and ₹1,180 on 10 Jun; treatment decided with CA (BR-29) |
| Inventory_COGS | Finished Goods Inventory | COGS | Cost of goods |  |  |
| Inventory_COGS | Contract Manufacturing | COGS | Cost of goods | New | Per-unit charges from Micro Instruments / Saiffi once production starts |
| Inventory_COGS | Components & Raw Material | COGS | Cost of goods | New | LEDs, PCBs, mesh, sachet material |
| Inventory_COGS | Dead / Damaged Inventory | COGS | Cost of goods |  |  |
| Inventory_COGS | Inbound Inventory Transport | COGS | Cost of goods |  |  |
| Inventory_COGS | Warehousing / Storage | Operating Expense | Operations |  |  |
| Capex | Tooling & Moulds | Capex | Capex (not in P&L) | New | Saiffi, Micro Instruments advances, Valco die. Today booked as Expense |
| Capex | Equipment & Devices | Capex | Capex (not in P&L) | New | Laptops, test equipment above capitalisation limit (Q20) |
| Capex | Design Registration / Patents | Capex | Capex (not in P&L) | New | VideAim design patent fees: CA to confirm capitalise vs expense |
| Logistics_Delivery | Shiprocket | Operating Expense | Fulfilment |  |  |
| Logistics_Delivery | Shipmozo | Operating Expense | Fulfilment |  |  |
| Logistics_Delivery | Shipway | Operating Expense | Fulfilment |  |  |
| Logistics_Delivery | Delhivery | Operating Expense | Fulfilment |  |  |
| Logistics_Delivery | Bluedart | Operating Expense | Fulfilment |  |  |
| Logistics_Delivery | Porter | Operating Expense | Fulfilment |  |  |
| Logistics_Delivery | Uber / Rapido | Operating Expense | Fulfilment |  |  |
| Logistics_Delivery | Return Logistics | Operating Expense | Fulfilment |  |  |
| Logistics_Delivery | Courier | Operating Expense | Fulfilment |  |  |
| Packaging_Printing | Boxes / Cartons | COGS | Cost of goods | Changed | Packaging per unit belongs in COGS for unit economics |
| Packaging_Printing | Stickers & Thank You Cards | COGS | Cost of goods | Changed |  |
| Packaging_Printing | Ziplocks | COGS | Cost of goods | Changed |  |
| Packaging_Printing | Tape | COGS | Cost of goods | Changed |  |
| Packaging_Printing | Bubble Wrap | COGS | Cost of goods | Changed |  |
| Packaging_Printing | Business Cards | Operating Expense | Marketing |  |  |
| Packaging_Printing | Printing (Misc) | Operating Expense | Operations |  |  |
| Marketing | Meta Ads | Operating Expense | Marketing |  |  |
| Marketing | WhatsApp Campaigns | Operating Expense | Marketing |  |  |
| Marketing | Samples & Trials | Operating Expense | Marketing | New | Devices given to hotels for trial |
| Marketing | Events & Exhibitions | Operating Expense | Marketing | New |  |
| Software_Subscriptions | ChatGPT | Operating Expense | Software |  |  |
| Software_Subscriptions | Canva | Operating Expense | Software |  |  |
| Software_Subscriptions | Shopify | Operating Expense | Software |  |  |
| Software_Subscriptions | Google Workspace | Operating Expense | Software |  |  |
| Software_Subscriptions | WhatsApp Manager | Operating Expense | Software |  |  |
| Software_Subscriptions | Dialer / Calling Tool | Operating Expense | Software |  |  |
| Software_Subscriptions | Hosting / Domain | Operating Expense | Software |  |  |
| Software_Subscriptions | AI / Automation Tools | Operating Expense | Software |  |  |
| Software_Subscriptions | AWS | Operating Expense | Software |  |  |
| Software_Subscriptions | Wisemelon | Operating Expense | Software |  |  |
| Software_Subscriptions | Internshala | Operating Expense | Software |  | Hiring platform; could move to People |
| Salaries_People | Full-time Salary | Operating Expense | People |  |  |
| Salaries_People | Intern Salary | Operating Expense | People |  |  |
| Salaries_People | Contractor / Freelancer | Operating Expense | People |  | Check TDS |
| Salaries_People | Travel Allowance | Operating Expense | People |  |  |
| Salaries_People | Incentives / Bonus | Operating Expense | People |  |  |
| Refunds_Returns | Customer Refund | Refund/Reversal | Revenue (contra) | Changed | Shown as a reduction of revenue, not an expense |
| Refunds_Returns | Order Cancellation | Refund/Reversal | Revenue (contra) | Changed |  |
| Refunds_Returns | Trial Refund | Refund/Reversal | Revenue (contra) | Changed |  |
| Refunds_Returns | Platform Charges / Cancellation | Operating Expense | Fulfilment |  |  |
| Operations_Admin | Virtual Office | Operating Expense | Operations |  |  |
| Operations_Admin | GST & Taxes | Tax Payment | Below the line | Changed | Split: GST paid, TDS deposit, other taxes |
| Operations_Admin | Airtel / Internet / Phone | Operating Expense | Operations |  |  |
| Operations_Admin | Document Courier | Operating Expense | Operations |  |  |
| Operations_Admin | Office / Admin Misc | Operating Expense | Operations |  |  |
| Operations_Admin | Business Travel (International) | Operating Expense | Operations |  |  |
| Operations_Admin | Business Travel (Domestic) | Operating Expense | Operations | New | Ambala visits |
| Operations_Admin | Unclassified / Misc. | Operating Expense | Operations |  | Should stay near zero; month cannot lock with large Misc |
| Operations_Admin | Bank Charges / Fees | Operating Expense | Operations |  | Includes payment gateway fees |
| Operations_Admin | Bank Verification / Adjustment | Refund/Reversal | Below the line | Changed | Penny drops and reversals net to zero |
| Operations_Admin | Legal / Registration / Compliance | Operating Expense | Professional fees |  |  |
| Operations_Admin | CA & Accounting Fees | Operating Expense | Professional fees | New |  |
| Taxes | TDS Deposit | Tax Payment | Below the line | New | OPT/CBDT rows; settles TDS payable |
| Taxes | GST Payment | Tax Payment | Below the line | New |  |
| R&D | Product Testing | Operating Expense | R&D |  |  |
| R&D | Sample Procurement | Operating Expense | R&D |  |  |
| R&D | R&D Materials | Operating Expense | R&D |  |  |
| R&D | Electrical / Lab Testing | Operating Expense | R&D |  | Trinity NDT mesh testing |
| R&D | Market Research | Operating Expense | R&D |  |  |
| R&D | NPD - Electricals | Operating Expense | R&D |  |  |
| R&D | Prototyping / 3D Printing | Operating Expense | R&D | New | Quick Shape, Makenica |
| Transfers | Inter-Bank Transfer | Transfer | Excluded |  | Own accounts only (BR-06) |
| Founder Reimbursement | Reimbursement to Founder | Reimbursement | Excluded | New | Expense already counted on the claim date (BR-27) |
