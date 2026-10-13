# Entelechy Finance App

Internal finance and accounting app for **Entelechy Labs Private Limited** (brand: Bloc). It replaces the "Financials Master" Google Sheet: bank ledger, vendors, POs, vendor bills, payments, TDS, proformas and tax invoices (B2B + D2C), receivables, order-to-bank reconciliation, dashboards. Statutory books stay with the CA in Tally; this app is the operating system for finance and gives the CA a monthly Excel export.

Users in v1: Rishabh and Arnav only (both Admin, email + password login like the Bloc CRM).

This folder is built to move into the Bloc monorepo (github.com/Mani212005/Bloc) as `finance/` unchanged. Same stack, conventions and layout as Bloc's `crm/backend` and `crm/frontend`. Never change anything in the Bloc repo from here; a read-only copy for reference may sit at `../_reference/bloc`.

## Where the truth lives

| What | File | Notes |
|---|---|---|
| What the app does (modules, features, data model, statuses, documents, dashboards, integrations, roles, categories) | `docs/spec.md` | Tables map 1:1 to tabs in the Google Sheet PRD |
| How it calculates and decides | `docs/rules.md` | BR-01 to BR-50, each with trigger, logic, worked example, confidence |
| Decisions still open, and the founders' answers | `docs/open-questions.md` | Answers are typed in the Google Sheet; pull with `npm run spec:pull-answers` |
| History of spec changes | `docs/changelog.md` | |
| Phase 1 scope and acceptance tests | `docs/phase-1-plan.md` | Start here when building |
| Database schema | `backend/prisma/schema.prisma` + `backend/prisma/sql/finance.sql` | `db/phase1_schema.sql` is the original draft, kept for reference only |

Before implementing anything, read the relevant rows of `docs/spec.md` (by feature ID F###) and every rule it references in `docs/rules.md`. If code and docs disagree, the docs win unless the founder says otherwise; then update the docs.

## Keep the spec in sync (mandatory)

Every change that adds, removes or alters a feature, field, status, rule, document format, metric, integration or category must update the docs **in the same commit**:

1. Edit the matching row in `docs/spec.md` or section in `docs/rules.md`. New items get the next free ID (F###, BR-##, Q##, D##, I##). Never renumber or reuse an ID; mark dropped items "Dropped" in the Status/Confidence column instead of deleting them.
2. Add one row to `docs/changelog.md` (version, date, author, what changed and why).
3. Keep table columns and the `## ` headings exactly as they are; `scripts/sync-spec-to-sheet.ts` depends on them. One row per item, `<br>` for line breaks in a cell, `\|` for a literal pipe.
4. Pure refactors, styling and bug fixes that do not change behaviour need no doc change.

The pre-commit hook (`.githooks/pre-commit` at the repo root) blocks commits that touch finance-critical code without touching `finance/docs/`. If a change truly needs no doc update, commit with `SKIP_SPEC_CHECK=1` and say why in the commit message. Merges to `main` push the docs to the Google Sheet automatically (`.github/workflows/sync-spec.yml`).

When a founder's answer in `docs/open-questions.md` changes behaviour, apply it to spec/rules, mark the question answered, and log it.

## Stack and architecture

- TypeScript end to end. Postgres. Responsive web app (works on phone screens; approvals and expense capture designed mobile-first).
- **Same stack as Bloc** (copy its versions and idioms):
  - `backend/`: Express 5, TypeScript (CommonJS), ts-node + nodemon, Prisma 6 (`multiSchema`, cuid string ids, PascalCase models with camelCase columns). Responses are `{ success, data }` or `{ success: false, error }`.
  - `frontend/`: React 19, Vite 7, Tailwind 4, TanStack Query, react-router 7, react-hook-form + zod, axios (`src/api.ts`, `withCredentials`), lucide-react. Bloc's look: navy `#0c2c55` header, Inter, Instrument Serif titles.
  - Schema changes: **`prisma db push`, no migrations folder** (Bloc's rule). What Prisma cannot express (triggers, checks) lives in `backend/prisma/sql/finance.sql`; `npm run db:sync` runs both.
  - Hosting target: Bloc's EC2 box with PM2; Postgres on the same box (database `bloccrm`), Finance in its own schema. Not Supabase.
- **Login:** email + password (bcrypt), JWT in an httpOnly cookie, roles with `permissions` JSON `{ module: { view, edit } }`, same as Bloc. Finance modules are prefixed (`financeBank`, `financeVendors`, ...) so they can join the CRM's Role rows on merge. Cookie `finance_auth_token` until merge.
- **Audit (BR-43) is enforced by the database.** Every write goes through `withAudit({ userId, reason }, tx => ...)` (`backend/src/lib/audit.ts`). Triggers in `finance.sql` write `AuditLog` rows in the same transaction, refuse writes with no user, refuse every DELETE/TRUNCATE, and keep `AuditLog` append only. Every model needs a single `id` column.
- All Finance tables live in a dedicated Postgres schema named `finance`. The CRM and Inventory app are separate codebases that will share the same Postgres database later; Finance reads their data only through the **CRM reader module** (`backend/src/crm/`), never directly. Until the apps share a database it reads local stub tables of the same shape; switching to the real CRM tables is a config change in that module, not a change anywhere else. No database views over CRM tables: they would block the CRM's `prisma db push` when it changes a column.
- Products come from bloc-inv (its own repo) and reach the CRM's `Product` table; Finance reads products through the CRM reader too.
- Finance never writes to CRM or Inventory tables. The CRM reads Finance data through views (`order_payment_status`, invoice register).
- The invoice engine (numbering, tax maths, templates, PDF, register) lives only in this app. The CRM calls it through an API (F105); it never generates invoices itself.
- PDFs: HTML/CSS templates rendered server-side (headless Chromium via Playwright, which Bloc already uses). Template settings (logo, colours, legal details, bank, footer texts, column toggles) are editable in the app; layout lives in code and is versioned. Every issued document stores its template version and a frozen PDF.
- Files (bills, proofs, challans, PDFs) go to Google Drive under `/Finance/{FY}/{Module}/{Record no}`; the database stores Drive file IDs. Until a service account is set up, `FILE_STORAGE=local` keeps them in `backend/.files` with the same layout (`backend/src/storage/`). Attachments are never deleted, only archived with a reason.

## Non-negotiable rules for financial code

- **Money:** `Decimal @db.Decimal(14, 2)` in Prisma (`numeric(14,2)`); in TypeScript use `Prisma.Decimal` (decimal.js). Never use JS `number` for money arithmetic. Round tax per line to 2 decimals and the document total to the rupee with a separate round-off line (BR-21).
- **Dates:** business dates are `date` (no time zone); audit timestamps are `timestamptz`. Display in IST. Financial year is April to March (BR-31); FY label format `26-27`.
- **No hard deletes** of financial records. Cancel, reverse, or credit-note, with reason and audit (BR-34, BR-43). Every create/update writes `finance."AuditLog"` (database trigger); a refused delete writes a `delete_refused` row.
- **Numbering:** document numbers are assigned only on Issue, inside the same database transaction (`SELECT ... FOR UPDATE` on the series row). No gaps, no reuse, cancelled numbers stay visible. Tax invoice and credit note numbers max 16 characters, letters/digits/`/`/`-` only (BR-30).
- **Tax values are data, not code:** GST rates, TDS sections, rates, thresholds, due-date days, settlement cycles and tolerances live in settings tables with effective dates. TDS is seeded with old-Act values marked [Verify] (Q15).
- **Computed statuses are computed:** PO, bill, invoice, payment, bank transaction and order-payment statuses are derived from linked records (docs/spec.md, Status Flows). Never let a user type a computed status.
- **Issued documents are immutable.** Store a snapshot of customer/vendor details at issue time.
- **Period lock:** no edits to records dated in a locked month without admin unlock + reason (BR-36).
- **Bank data:** raw narration is never edited; parsed fields are stored separately (BR-02). Duplicate key includes running balance (BR-01).
- Every rule in `docs/rules.md` with a worked example gets a unit test that reproduces the example (`backend/tests/rules/BR-xx.test.ts`, Vitest; acceptance checks in `backend/tests/acceptance/`). Bloc itself has no tests; Finance does. Write the test first for anything touching tax, numbering, TDS, matching or reconciliation.

## Legal entity details (for templates and seed data)

- Entelechy Labs Private Limited, CIN U20211KA2026PTC221356, PAN AAJCE7255M, GSTIN 29AAJCE7255M1ZX, Udyam UDYAM-KR-03-0704964
- Registered office: Innov8 Mantri Commercio, Tower A, 5th Floor, Bellandur, Bengaluru 560103, Karnataka (state code 29)
- Bank: IDFC FIRST Bank, Koramangala branch, IFSC IDFB0080152, account ending 9345
- Sending address for documents: finance@blocinsects.com
- **Never** print Newera Living's name, GSTIN (29AAYFN4098H1ZB) or bank account on any Entelechy document. The old proforma sheet still does; do not copy those values.

## Temporary setups to replace (when moving to Google Cloud / the Bloc server)

Recorded as D11-D13 in `docs/spec.md` README (and the Google Sheet). Check this list whenever infrastructure changes:

1. **File storage is local** (`FILE_STORAGE=local`, files in `backend/.files`). Switch to Drive: Google Cloud service account, a folder in a Shared Drive shared with it as Content manager, then `FILE_STORAGE=drive`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `DRIVE_ROOT_FOLDER_ID`, and a one-off script to move the existing local files into Drive and update `Attachment.storage` / `storageKey`. The Drive driver (`backend/src/storage/drive.ts`) has not run against real credentials yet: test it first.
2. **The Google Sheet PRD is updated by hand** from the repo (no service account for `scripts/sync-spec-to-sheet.ts` yet). Once the service account exists: share the sheet with it as Editor and add GitHub secrets `SPEC_SHEET_ID` and `GOOGLE_SERVICE_ACCOUNT_JSON`; the workflow then syncs on every merge to `main`. Last manual update of the sheet: docs as of changelog v0.10 (13 Oct 2026; Open Questions Q28-Q30 added there too). Next manual update: push only rows changed since then (compare with the docs at the v0.10 commit; README rows in the sheet sit 3 rows lower than in spec.md because of blank spacer rows).
3. **GSTIN Fetch is off** until `GSTINAPI_KEY` (the CRM's gstinapi.in key) is set in `backend/.env`.
4. **Development database** is Postgres 17 on the founder's PC, port 5433, started outside the Windows service. Production target is Bloc's EC2 Postgres (`bloccrm`, schema `finance`).
5. **No real bank data yet**: wait for one real IDFC download (Q30) before the first real import; imported rows cannot be deleted.

## No migration of old data

The old Financials Master history is not imported (F023 dropped, D10). Never add code that carries over old descriptions, categories or notes. The founders categorise in the app and add categories / sub-categories there (Categories page or "+ New" in the categorise form). Default rules set a category only, never a description.

## Open blocker before invoicing goes live

Confirm with the founders and the CA which entity is invoicing customers today (the current proforma sheet still issues under Newera Living as of Aug 2026). Build the invoice engine, but do not seed a live invoice series or issue real invoices until this is confirmed.

## Scope discipline

- Build by phase (docs/spec.md, Module Map, Phase column). Phase 1 first: settings, bank ledger, categories, vendors, documents vault, users/audit.
- Do not build P2 features unless asked. Do not build GST return filing, e-invoice IRN, e-way bill generation, payroll, or a double-entry general ledger (out of scope, README in spec.md).
- Look and feel: the founders will iterate on UI through use. Treat UI as flexible; treat rules, numbering, tax and statuses as fixed by the docs.

## Commands

```bash
# Backend (finance/backend)
npm run dev        # API on PORT (default 3100)
npm run db:sync    # prisma db push + prisma/sql/finance.sql (triggers); run after every schema change
npx prisma generate
npm run db:seed    # role FINANCE_ADMIN + the two founders (first password from SEED_ADMIN_PASSWORD)
npm test           # Vitest; DB tests use DATABASE_URL_TEST (name must end in _test; it is reset)
npx tsc --noEmit

# Frontend (finance/frontend)
npm run dev        # Vite on 5174 (CRM uses 5173); API base from VITE_API_URL
npm run build && npm run lint
```

Commits: straight to `main`, prefixes `FEAT:` / `FIX:` / `CHORE:` (Bloc's style).

## Working style

- Indian number formatting (lakh/crore grouping, ₹). Plain English labels.
- Ask before guessing on anything in `docs/open-questions.md` that is still open; otherwise use the default listed there and say so.
- After finishing a feature, list which F### / BR-## it covers and which acceptance checks passed.
