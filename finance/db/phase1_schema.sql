-- Entelechy Finance App - Phase 1 draft schema (Postgres 15+)
-- Starting point for migrations. Field definitions follow docs/spec.md (Data Model) and docs/rules.md.
-- All Finance tables live in the "finance" schema. CRM and Inventory data are read through views added later.

create schema if not exists finance;
create extension if not exists pgcrypto;

-- ---------- Enums ----------
create type finance.account_type as enum ('business_current','cash_credit','founder_personal','loan','wallet','card');
create type finance.txn_nature as enum (
  'operating_income','operating_expense','cogs','capex','financing_in','financing_out','interest',
  'tax_payment','advance','transfer','related_party','refund_reversal','reimbursement');
create type finance.bank_txn_status as enum ('review','suggested','categorised','matched','split','transfer','ignored');
create type finance.party_type as enum ('vendor','customer','founder','lender','govt','own_account','other');
create type finance.vendor_type as enum ('goods','services','both');
create type finance.deductee_type as enum ('individual','huf','company','firm','others');
create type finance.msme_type as enum ('micro','small','medium','none');
create type finance.vendor_status as enum ('draft','pending_review','active','blocked');
create type finance.user_role as enum ('admin','approver','finance','sales','viewer');

-- ---------- Users & audit (M16) ----------
create table finance.app_user (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique check (email like '%@blocinsects.com'),
  role finance.user_role not null default 'admin',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table finance.audit_log (            -- BR-43, append only
  id bigserial primary key,
  record_type text not null,
  record_id uuid not null,
  action text not null check (action in ('create','update','archive','cancel','unlock','other')),
  field text,
  old_value jsonb,
  new_value jsonb,
  reason text,
  user_id uuid references finance.app_user(id),
  at timestamptz not null default now()
);
create index on finance.audit_log (record_type, record_id);

-- Common columns used below: entity_id (single entity in v1), created_*/updated_*, is_archived (no hard deletes).

-- ---------- Settings & masters (M01) ----------
create table finance.company (
  id uuid primary key default gen_random_uuid(),
  legal_name text not null,
  brand_name text,
  cin text, pan text not null, tan text, gstin text not null, udyam_no text,
  registered_address text not null,
  state_code char(2) not null,
  fy_start_month smallint not null default 4 check (fy_start_month = 4),
  logo_drive_id text, signature_drive_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table finance.bank_account (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references finance.company(id),
  bank_name text not null,
  account_name text not null,
  account_number text not null,
  ifsc text not null check (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  branch text,
  account_type finance.account_type not null,
  owner text not null,
  opening_balance numeric(14,2) not null default 0,
  opening_date date not null,
  parser_format text,                       -- e.g. idfc_xls_v1, pnb_cc_v1
  sanctioned_limit numeric(14,2),           -- cash credit only (BR-50)
  drawing_power numeric(14,2),
  drawing_power_as_of date,
  interest_rate numeric(6,3),
  renewal_date date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (bank_name, account_number),
  check (account_type <> 'cash_credit' or sanctioned_limit is not null)
);

create table finance.gst_rate (
  id uuid primary key default gen_random_uuid(),
  rate numeric(5,2) not null,
  effective_from date not null,
  effective_to date
);

create table finance.tds_section (           -- values seeded from old Act, marked [Verify] (Q15)
  id uuid primary key default gen_random_uuid(),
  code_old_act text not null,
  code_new_act text,
  nature text not null,
  rate_individual numeric(5,2) not null,
  rate_others numeric(5,2) not null,
  rate_no_pan numeric(5,2) not null,
  single_threshold numeric(14,2),
  annual_threshold numeric(14,2),
  effective_from date not null,
  effective_to date,
  verified_by_ca boolean not null default false
);

create table finance.number_series (         -- BR-30
  id uuid primary key default gen_random_uuid(),
  doc_type text not null,                    -- purchase_order, proforma, tax_invoice, credit_note, payment, receipt, ...
  fy_label text,                             -- '26-27'; null for never-reset series (PMT, RCT)
  prefix text not null,
  padding smallint not null,
  next_number integer not null default 1 check (next_number >= 1),
  unique (doc_type, fy_label)
);

create table finance.payment_term (
  id uuid primary key default gen_random_uuid(),
  label text not null unique,
  days integer not null default 0
);

create table finance.approval_rule (         -- provision only; approvals off at launch
  id uuid primary key default gen_random_uuid(),
  applies_to text not null check (applies_to in ('purchase_order','payment')),
  amount_from numeric(14,2) not null,
  amount_to numeric(14,2),
  approvers_required smallint not null default 1,
  is_enabled boolean not null default false
);

create table finance.period_lock (           -- BR-36
  month date primary key check (extract(day from month) = 1),
  locked_at timestamptz not null default now(),
  locked_by uuid references finance.app_user(id),
  unlocked_at timestamptz,
  unlocked_by uuid references finance.app_user(id),
  unlock_reason text
);

-- ---------- Categories ----------
create table finance.category (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  nature_default finance.txn_nature not null,
  pl_group text,
  sort_order integer not null default 0,
  is_active boolean not null default true
);

create table finance.sub_category (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references finance.category(id),
  name text not null,
  nature_override finance.txn_nature,
  pl_group text,
  is_active boolean not null default true,
  unique (category_id, name)
);

-- ---------- Vendors (M03) ----------
create table finance.vendor (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references finance.company(id),
  display_name text not null,
  legal_name text, trade_name text,
  vendor_type finance.vendor_type not null,
  gst_registered boolean not null default false,
  gstin text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$'),
  pan text not null check (pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  deductee_type finance.deductee_type not null,      -- from PAN 4th char (BR-12)
  address_line1 text, address_line2 text, city text, state text, state_code char(2), pincode char(6),
  contact_name text, phone text, email text,
  default_tds_section_id uuid references finance.tds_section(id),
  ldc_number text, ldc_rate numeric(5,2), ldc_valid_from date, ldc_valid_to date, ldc_limit numeric(14,2),
  msme_type finance.msme_type not null default 'none',
  udyam_no text,
  default_category_id uuid references finance.category(id),
  default_sub_category_id uuid references finance.sub_category(id),
  payment_term_id uuid references finance.payment_term(id),
  status finance.vendor_status not null default 'draft',
  is_archived boolean not null default false,
  created_at timestamptz not null default now(), created_by uuid references finance.app_user(id),
  updated_at timestamptz not null default now(), updated_by uuid references finance.app_user(id),
  check (gstin is null or substring(gstin from 3 for 10) = pan)        -- BR-15
);
create unique index vendor_gstin_uq on finance.vendor (gstin) where gstin is not null;

create table finance.vendor_bank_account (    -- BR-16: changes need founder approval, history kept
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references finance.vendor(id),
  account_name text not null,
  account_number text not null,
  ifsc text not null check (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  bank_name text, branch text,
  is_primary boolean not null default true,
  approved_by uuid references finance.app_user(id),
  approved_at timestamptz,
  valid_from timestamptz not null default now(),
  valid_to timestamptz
);

-- ---------- Attachments (M15) ----------
create table finance.attachment (
  id uuid primary key default gen_random_uuid(),
  record_type text not null,
  record_id uuid not null,
  doc_kind text,                              -- gst_cert, pan, cancelled_cheque, msme_cert, bill, proof, challan, ...
  drive_file_id text not null,
  file_name text not null,
  mime_type text,
  uploaded_by uuid references finance.app_user(id),
  uploaded_at timestamptz not null default now()
);
create index on finance.attachment (record_type, record_id);

-- ---------- Bank ledger (M02) ----------
create table finance.bank_import_batch (
  id uuid primary key default gen_random_uuid(),
  bank_account_id uuid not null references finance.bank_account(id),
  file_drive_id text,
  file_name text not null,
  period_from date, period_to date,
  rows_total integer not null default 0,
  rows_new integer not null default 0,
  rows_duplicate integer not null default 0,
  opening_balance numeric(14,2),
  closing_balance numeric(14,2),
  balance_check_status text not null check (balance_check_status in ('ok','gap','mismatch')),
  balance_check_note text,
  imported_by uuid references finance.app_user(id),
  imported_at timestamptz not null default now()
);

create table finance.categorization_rule (    -- BR-05
  id uuid primary key default gen_random_uuid(),
  priority integer not null,
  match_field text not null check (match_field in ('narration','counterparty_name','mode','remark')),
  operator text not null check (operator in ('contains','equals','starts_with','regex')),
  match_value text not null,
  amount_min numeric(14,2), amount_max numeric(14,2),
  direction text check (direction in ('debit','credit')),
  set_category_id uuid references finance.category(id),
  set_sub_category_id uuid references finance.sub_category(id),
  set_nature finance.txn_nature,
  set_party_type finance.party_type,
  set_party_id uuid,
  is_active boolean not null default true
);

create table finance.bank_txn (
  id uuid primary key default gen_random_uuid(),
  bank_account_id uuid not null references finance.bank_account(id),
  batch_id uuid references finance.bank_import_batch(id),   -- null for manual cash entries (F022)
  txn_date date not null,
  value_date date,
  narration_raw text not null,               -- never edited (BR-02)
  cheque_no text,
  debit numeric(14,2) not null default 0 check (debit >= 0),
  credit numeric(14,2) not null default 0 check (credit >= 0),
  balance numeric(14,2),
  dedupe_key text not null,                  -- BR-01: account|date|narration|debit|credit|balance
  mode text, utr text, counterparty_name text, counterparty_ifsc text, remark text,   -- parsed (BR-02)
  description text,
  category_id uuid references finance.category(id),
  sub_category_id uuid references finance.sub_category(id),
  nature finance.txn_nature,
  party_type finance.party_type,
  party_id uuid,
  status finance.bank_txn_status not null default 'review',
  categorisation_reason text,
  transfer_pair_id uuid references finance.bank_txn(id),
  linked_doc_type text,                      -- filled from Phase 2 (payment_out, payment_in, tds_challan, ...)
  linked_doc_id uuid,
  is_manual boolean not null default false,
  notes text,
  created_at timestamptz not null default now(), created_by uuid references finance.app_user(id),
  updated_at timestamptz not null default now(), updated_by uuid references finance.app_user(id),
  check ((debit > 0) <> (credit > 0)),       -- exactly one side
  unique (bank_account_id, dedupe_key)
);
create index on finance.bank_txn (bank_account_id, txn_date);
create index on finance.bank_txn (status);

create table finance.txn_split (               -- BR-07
  id uuid primary key default gen_random_uuid(),
  bank_txn_id uuid not null references finance.bank_txn(id),
  amount numeric(14,2) not null check (amount > 0),
  category_id uuid not null references finance.category(id),
  sub_category_id uuid references finance.sub_category(id),
  nature finance.txn_nature not null,
  party_type finance.party_type,
  party_id uuid,
  linked_doc_type text,
  linked_doc_id uuid,
  note text
);
-- Enforce "sum of splits = parent amount" in the service layer inside the same transaction (BR-07).

-- ---------- Products (M11) - stub until the Inventory app is connected ----------
create table finance.inv_product_stub (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  name text not null,
  hsn text,
  gst_rate numeric(5,2),
  unit text not null default 'pcs',
  is_active boolean not null default true
);
create view finance.inv_product as select * from finance.inv_product_stub;   -- swap to the Inventory app's table later

-- ---------- Helpful views ----------
create view finance.v_ledger as
select t.*, a.bank_name, a.account_type, c.name as category, s.name as sub_category
from finance.bank_txn t
join finance.bank_account a on a.id = t.bank_account_id
left join finance.category c on c.id = t.category_id
left join finance.sub_category s on s.id = t.sub_category_id;
