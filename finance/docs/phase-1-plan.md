# Phase 1 - Foundations

Goal: bank statements imported and categorised in the app, vendors on file, and the "Master Ledger" tab of the Financials Master sheet retired.

Modules: M01 Settings & Masters, M02 Bank & Cash Ledger, M03 Vendors, M11 Products (read/stub), M15 Documents Vault, M16 Users, Roles & Audit.

## Build order

1. **Project skeleton**: Bloc-style monorepo folder (`finance/backend` Express 5 + Prisma, `finance/frontend` React 19 + Vite), Postgres schema `finance` via `prisma db push` + `prisma/sql/finance.sql`, email + password login for rishabh@ and arnav@blocinsects.com (same as the Bloc CRM), audit log enforced by database triggers (F170-F172, BR-43).
2. **Settings and masters** (F001-F009): company profile, FY (April start, BR-31), bank accounts incl. cash credit type (F003, BR-50), GST rates, TDS sections seeded with old-Act values [Verify], number series, approval rules table (switched off), payment terms, period lock.
3. **Categories**: seed `finance.category` / `finance.sub_category` from the Category Master table in docs/spec.md, including Nature (BR-04).
4. **Bank import** (F010-F013): IDFC parser for the statement format in `data/fixtures/idfc_statement_rows.csv`; duplicate check (BR-01); balance continuity (BR-03); narration parsing (BR-02).
5. **Ledger and review** (F014-F021): ledger list with filters and running totals, review queue, auto-categorisation (BR-05), rules manager (F017, P1), split (BR-07), own-account transfer pairing (BR-06), notes and attachments.
6. **Vendors** (F030-F038): GSTIN lookup, PAN derivation and deductee type (BR-12, BR-15), MSME, bank details with change control (BR-16), documents checklist, vendor 360 (payments only until Phase 2).
7. **Documents vault** (F160-F161): Drive upload and folder structure.
8. ~~**Migration** (F023)~~: dropped (D10). The old Master Ledger is not imported; the founders categorise and describe transactions in the app.
9. **Home dashboard, Phase 1 slice** (F130): cash, gross/net burn, runway (BR-37), review-queue count, category x month pivot (F131). Built (M7).

## Acceptance checks

Use the fixtures in `data/fixtures/` (real Entelechy IDFC data, 30 May to 1 Oct 2026).

| # | Check | Expected |
|---|---|---|
| A1 | Import `idfc_statement_rows.csv` into the IDFC account | 22 rows imported, 0 duplicates, balance check passes |
| A2 | Import the same file again | 0 new rows, 22 duplicates |
| A3 | Totals after import | Inflow ₹20,01,181; outflow ₹15,90,312; closing balance ₹4,10,869 (matches `master_ledger_expected.csv`) |
| A4 | Narration parsing on `IMPS-OPM/623112118032/MICRO INSTRUMENTS CO.../SBIN0002468/7009/AdvanceToolingPaymentM` | mode IMPS, UTR 623112118032, party MICRO INSTRUMENTS CO, IFSC SBIN0002468 |
| A5 | Rows with `OPT/CBDT` | Auto-categorised as Tax Payment > TDS Deposit (BR-05) |
| A6 | ₹12,00,000 from Neos Kosmos on 4 Jun 2026 | Nature Financing In (loan), excluded from income and burn |
| A7 | Tooling payments (Saiffi ₹11,36,800, Micro Instruments ₹2,84,808, Valco ₹62,640) | Nature Capex, excluded from burn, shown under capex |
| A8 | ₹7,00,000 from Newera Living on 19 Aug 2026 | Related Party, not income, not own-account transfer (BR-29) |
| A9 | Delete attempt on an imported bank row | Refused; ignore/reverse with note instead; audit entry written |
| A10 | Vendor with GSTIN 06ANJPA3053F1ZI | PAN ANJPA3053F, deductee type individual, state Haryana (06) |
| A11 | Runway with no operating income | Cash / average net burn of last 3 complete months, shown in months |
| A12 | Phone-width screen (375 px) | Ledger, review queue and vendor form usable without horizontal scroll |

## Not in Phase 1

POs, vendor bills, payments, TDS register, invoices, receivables, order-to-bank reconciliation, loans, CA export. Keep their tables out of the schema until their phase, but keep columns in Phase 1 tables that those phases will link to (e.g. `bank_txn.linked_doc_type/linked_doc_id`).
