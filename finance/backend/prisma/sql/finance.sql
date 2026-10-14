-- Entelechy Finance - database rules Prisma cannot express.
-- Applied after every `prisma db push` by `npm run db:sync`. Must stay idempotent (safe to re-run).

-- ---------------------------------------------------------------------------
-- BR-43 Audit trail: one AuditLog row per created record and per changed field.
-- The acting user comes from the transaction setting finance.user_id, which the backend sets in
-- withAudit() (src/lib/audit.ts). A write without it is refused, so nothing is ever unattributed.
-- ---------------------------------------------------------------------------
create or replace function finance.audit_row() returns trigger
language plpgsql as $$
declare
  uid   text := nullif(current_setting('finance.user_id', true), '');
  rsn   text := nullif(current_setting('finance.reason', true), '');
  o     jsonb;
  n     jsonb;
  k     text;
  act   finance."AuditAction";
  -- Bookkeeping columns that change on their own and say nothing about the record.
  skip  text[] := array['updatedAt', 'failedLoginAttempts', 'lockedUntil', 'lastLoginAt'];
  -- Secrets: the change is logged, the value is not.
  mask  text[] := array['passwordHash'];
begin
  if uid is null then
    raise exception 'finance: % write without a user; wrap it in withAudit()', tg_table_name
      using errcode = 'P0002';
  end if;

  if tg_op = 'INSERT' then
    n := to_jsonb(new);
    for k in select unnest(mask) loop
      if n ? k then n := jsonb_set(n, array[k], '"***"'); end if;
    end loop;
    insert into finance."AuditLog" ("recordType", "recordId", "action", "newValue", "reason", "userId")
    values (tg_table_name, n->>'id', 'create', n, rsn, uid);
    return new;
  end if;

  -- UPDATE: one row per changed field.
  o := to_jsonb(old);
  n := to_jsonb(new);
  for k in select key from jsonb_each(n) loop
    continue when k = any(skip);
    continue when (o->k) is not distinct from (n->k);
    continue when k in ('createdBy', 'updatedBy');
    act := case
      when k = 'isArchived' and n->>k = 'true' then 'archive'
      when k = 'isLocked' and n->>k = 'false' then 'unlock'
      when k = 'cancelledAt' and n->k <> 'null'::jsonb then 'cancel'
      else 'update'
    end;
    insert into finance."AuditLog" ("recordType", "recordId", "action", "field", "oldValue", "newValue", "reason", "userId")
    values (
      tg_table_name, n->>'id', act, k,
      case when k = any(mask) then '"***"'::jsonb else o->k end,
      case when k = any(mask) then '"***"'::jsonb else n->k end,
      rsn, uid
    );
  end loop;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- No hard deletes (CLAUDE.md, BR-34, BR-43). Records are archived, cancelled or reversed.
-- The backend catches errcode P0003 and writes a 'delete_refused' audit row (src/lib/audit.ts).
-- ---------------------------------------------------------------------------
create or replace function finance.no_hard_delete() returns trigger
language plpgsql as $$
begin
  raise exception 'finance: % records cannot be deleted; archive, cancel or reverse them instead', tg_table_name
    using errcode = 'P0003';
end $$;

-- AuditLog itself is append only.
create or replace function finance.audit_log_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'finance: AuditLog is append only' using errcode = 'P0004';
end $$;

drop trigger if exists audit_log_append_only on finance."AuditLog";
create trigger audit_log_append_only
  before update or delete on finance."AuditLog"
  for each row execute function finance.audit_log_append_only();

drop trigger if exists audit_log_no_truncate on finance."AuditLog";
create trigger audit_log_no_truncate
  before truncate on finance."AuditLog"
  for each statement execute function finance.audit_log_append_only();

-- ---------------------------------------------------------------------------
-- createdBy / updatedBy: stamped from the acting user, so the app never has to pass them.
-- ---------------------------------------------------------------------------
create or replace function finance.stamp_actor() returns trigger
language plpgsql as $$
declare
  uid text := nullif(current_setting('finance.user_id', true), '');
  patch jsonb := '{}'::jsonb;
begin
  if uid is null then return new; end if;  -- audit_row refuses the write anyway
  if tg_op = 'INSERT' and to_jsonb(new) ? 'createdBy' then
    patch := patch || jsonb_build_object('createdBy', uid);
  end if;
  if to_jsonb(new) ? 'updatedBy' then
    patch := patch || jsonb_build_object('updatedBy', uid);
  end if;
  if patch = '{}'::jsonb then return new; end if;
  return jsonb_populate_record(new, patch);
end $$;

-- ---------------------------------------------------------------------------
-- Settings checks (M01)
-- ---------------------------------------------------------------------------
alter table finance."BankAccount" drop constraint if exists bank_account_cc_limit;
alter table finance."BankAccount" add constraint bank_account_cc_limit           -- BR-50
  check ("accountType" <> 'cash_credit' or "sanctionedLimit" is not null);
alter table finance."BankAccount" drop constraint if exists bank_account_ifsc;
alter table finance."BankAccount" add constraint bank_account_ifsc
  check ("ifsc" ~ '^[A-Z]{4}0[A-Z0-9]{6}$');

alter table finance."GstRate" drop constraint if exists gst_rate_range;
alter table finance."GstRate" add constraint gst_rate_range
  check ("rate" >= 0 and "rate" <= 100 and ("effectiveTo" is null or "effectiveTo" >= "effectiveFrom"));

alter table finance."NumberSeries" drop constraint if exists number_series_next;
alter table finance."NumberSeries" add constraint number_series_next
  check ("nextNumber" >= 1 and "padding" between 1 and 8 and "pattern" like '%{N}%');

alter table finance."PeriodLock" drop constraint if exists period_lock_first_of_month;
alter table finance."PeriodLock" add constraint period_lock_first_of_month
  check (extract(day from "month") = 1);
alter table finance."PeriodLock" drop constraint if exists period_lock_unlock_reason;  -- BR-36
alter table finance."PeriodLock" add constraint period_lock_unlock_reason
  check ("isLocked" or coalesce(length(trim("unlockReason")), 0) > 0);

-- BR-30 / Documents & Numbering rule 4: a series' next number is never decreased.
create or replace function finance.number_series_never_down() returns trigger
language plpgsql as $$
begin
  if new."nextNumber" < old."nextNumber" then
    raise exception 'finance: series % next number cannot go down (% to %)', new."docType", old."nextNumber", new."nextNumber"
      using errcode = 'P0005';
  end if;
  return new;
end $$;
drop trigger if exists number_series_never_down on finance."NumberSeries";
create trigger number_series_never_down before update on finance."NumberSeries"
  for each row execute function finance.number_series_never_down();

-- BR-36: true when the month of this date is locked. Used by the triggers on dated records
-- (bank transactions from M2 on).
create or replace function finance.is_month_locked(entity text, d date) returns boolean
language sql stable as $$
  select exists (
    select 1 from finance."PeriodLock"
    where "entityId" = entity and "month" = date_trunc('month', d)::date and "isLocked"
  );
$$;

-- ---------------------------------------------------------------------------
-- Bank ledger (M02)
-- ---------------------------------------------------------------------------
alter table finance."BankTxn" drop constraint if exists bank_txn_one_side;
alter table finance."BankTxn" add constraint bank_txn_one_side                   -- exactly one of debit/credit
  check ("debit" >= 0 and "credit" >= 0 and (("debit" > 0) <> ("credit" > 0)));

-- BR-02: the imported facts of a bank row are never edited. Corrections are a note, a split,
-- an "ignored" status or a reversing entry, never a changed narration or amount.
create or replace function finance.bank_txn_facts_fixed() returns trigger
language plpgsql as $$
begin
  if new."narrationRaw" is distinct from old."narrationRaw"
     or new."txnDate" is distinct from old."txnDate"
     or new."debit" is distinct from old."debit"
     or new."credit" is distinct from old."credit"
     or new."balance" is distinct from old."balance"
     or new."bankAccountId" is distinct from old."bankAccountId"
     or new."dedupeKey" is distinct from old."dedupeKey" then
    raise exception 'finance: the imported date, narration, amounts and balance of a bank row cannot be changed'
      using errcode = 'P0006';
  end if;
  return new;
end $$;
drop trigger if exists bank_txn_facts_fixed on finance."BankTxn";
create trigger bank_txn_facts_fixed before update on finance."BankTxn"
  for each row execute function finance.bank_txn_facts_fixed();

-- BR-36: no new or changed bank rows dated in a locked month.
create or replace function finance.bank_txn_month_open() returns trigger
language plpgsql as $$
begin
  if finance.is_month_locked(new."entityId", new."txnDate") then
    raise exception 'finance: % is in a locked month; unlock it in Settings > Period lock first', new."txnDate"
      using errcode = 'P0007';
  end if;
  return new;
end $$;
drop trigger if exists bank_txn_month_open on finance."BankTxn";
create trigger bank_txn_month_open before insert or update on finance."BankTxn"
  for each row execute function finance.bank_txn_month_open();

alter table finance."TxnSplit" drop constraint if exists txn_split_amount;
alter table finance."TxnSplit" add constraint txn_split_amount check ("amount" > 0);

alter table finance."CategorizationRule" drop constraint if exists rule_shape;
alter table finance."CategorizationRule" add constraint rule_shape check (
  "matchField" in ('narration', 'counterparty_name', 'mode', 'remark', 'utr')
  and "operator" in ('contains', 'equals', 'starts_with', 'regex')
  and ("direction" is null or "direction" in ('debit', 'credit'))
  and length(trim("matchValue")) > 0
);

-- BR-36 also covers split lines: their parent's month must be open.
create or replace function finance.txn_split_month_open() returns trigger
language plpgsql as $$
declare
  t record;
begin
  select "entityId", "txnDate" into t from finance."BankTxn" where id = new."bankTxnId";
  if finance.is_month_locked(t."entityId", t."txnDate") then
    raise exception 'finance: % is in a locked month; unlock it in Settings > Period lock first', t."txnDate"
      using errcode = 'P0007';
  end if;
  return new;
end $$;
drop trigger if exists txn_split_month_open on finance."TxnSplit";
create trigger txn_split_month_open before insert or update on finance."TxnSplit"
  for each row execute function finance.txn_split_month_open();

-- ---------------------------------------------------------------------------
-- Vendors (M03)
-- ---------------------------------------------------------------------------
-- BR-15: GSTIN shape, PAN shape, PAN = GSTIN characters 3-12, state code = GSTIN characters 1-2.
alter table finance."Vendor" drop constraint if exists vendor_tax_ids;
alter table finance."Vendor" add constraint vendor_tax_ids check (
  ("gstin" is null or "gstin" ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$')
  and ("pan" is null or "pan" ~ '^[A-Z]{5}[0-9]{4}[A-Z]$')
  and ("gstin" is null or (substring("gstin" from 3 for 10) = "pan" and substring("gstin" from 1 for 2) = "stateCode"))
  and ("gstRegistered" = ("gstin" is not null))
);
-- One vendor per GSTIN (prisma db push drops indexes it does not know; db:sync re-creates them).
create unique index if not exists vendor_gstin_uq on finance."Vendor" ("gstin") where "gstin" is not null and not "isArchived";

alter table finance."VendorBankAccount" drop constraint if exists vendor_bank_ifsc;
alter table finance."VendorBankAccount" add constraint vendor_bank_ifsc check ("ifsc" ~ '^[A-Z]{4}0[A-Z0-9]{6}$');
-- BR-16: at most one approved (current) bank account per vendor.
create unique index if not exists vendor_bank_one_current on finance."VendorBankAccount" ("vendorId") where "status" = 'approved';
-- BR-16: a decision is recorded with who and when; an approval never by the person who asked
-- for the change, except the first account of a vendor that is not active yet.
alter table finance."VendorBankAccount" drop constraint if exists vendor_bank_decision;
alter table finance."VendorBankAccount" add constraint vendor_bank_decision check (
  ("status" = 'pending') = ("decidedBy" is null)
);

-- ---------------------------------------------------------------------------
-- Purchase orders (M04)
-- ---------------------------------------------------------------------------
alter table finance."PoLine" drop constraint if exists po_line_amounts;
alter table finance."PoLine" add constraint po_line_amounts check (
  "qty" > 0 and "rate" >= 0 and "discount" >= 0 and "taxable" >= 0 and "gstRate" >= 0
  and "lineTotal" = "taxable" + "cgst" + "sgst" + "igst"
);
alter table finance."PurchaseOrder" drop constraint if exists po_shape;
alter table finance."PurchaseOrder" add constraint po_shape check (
  "gstMode" in ('cgst_sgst', 'igst', 'none')
  and ("status" in ('draft', 'pending_approval', 'cancelled') or "poNumber" is not null)
  and "total" = "taxable" + "cgst" + "sgst" + "igst" + "roundOff"
  and ("status" not in ('closed', 'cancelled') or length(trim(coalesce("statusReason", ''))) > 0)
);

-- Issued documents are immutable (CLAUDE.md, BR-30). Once a PO has a number, the number never
-- changes, it never goes back to draft, and its vendor, date, place of supply and amounts change
-- only through an amendment (F046), which sets finance.po_amend inside its transaction.
-- Billing, payment and send/close fields stay writable.
create or replace function finance.po_issued_fixed() returns trigger
language plpgsql as $$
begin
  if old."poNumber" is not null then
    if new."poNumber" is distinct from old."poNumber" then
      raise exception 'finance: PO number % cannot change', old."poNumber" using errcode = 'P0008';
    end if;
    if new."status" = 'draft' then
      raise exception 'finance: issued PO % cannot go back to draft', old."poNumber" using errcode = 'P0008';
    end if;
    if coalesce(current_setting('finance.po_amend', true), '') <> 'on' and (
         new."vendorId" is distinct from old."vendorId" or new."poDate" is distinct from old."poDate"
      or new."placeOfSupplyState" is distinct from old."placeOfSupplyState" or new."gstMode" is distinct from old."gstMode"
      or new."deliveryAddress" is distinct from old."deliveryAddress"
      or new."taxable" is distinct from old."taxable" or new."total" is distinct from old."total"
      or new."cgst" is distinct from old."cgst" or new."sgst" is distinct from old."sgst" or new."igst" is distinct from old."igst"
      or new."revisionNo" is distinct from old."revisionNo") then
      raise exception 'finance: PO % is issued; change it with an amendment', old."poNumber" using errcode = 'P0008';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists po_issued_fixed on finance."PurchaseOrder";
create trigger po_issued_fixed before update on finance."PurchaseOrder"
  for each row execute function finance.po_issued_fixed();

-- Lines of an issued PO: only qtyBilled moves, unless an amendment is running.
create or replace function finance.po_line_fixed() returns trigger
language plpgsql as $$
declare
  po record;
begin
  select "poNumber" into po from finance."PurchaseOrder" where id = new."poId";
  if po."poNumber" is null or coalesce(current_setting('finance.po_amend', true), '') = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' or (to_jsonb(new) - 'qtyBilled' - 'updatedAt' - 'updatedBy')
                          is distinct from (to_jsonb(old) - 'qtyBilled' - 'updatedAt' - 'updatedBy') then
    raise exception 'finance: PO % is issued; change its lines with an amendment', po."poNumber" using errcode = 'P0008';
  end if;
  return new;
end $$;
drop trigger if exists po_line_fixed on finance."PoLine";
create trigger po_line_fixed before insert or update on finance."PoLine"
  for each row execute function finance.po_line_fixed();

-- BR-36: no PO created, re-dated or issued in a locked month.
create or replace function finance.po_month_open() returns trigger
language plpgsql as $$
begin
  if (tg_op = 'INSERT' or new."poDate" is distinct from old."poDate"
      or (old."poNumber" is null and new."poNumber" is not null))
     and finance.is_month_locked(new."entityId", new."poDate") then
    raise exception 'finance: % is in a locked month; unlock it in Settings > Period lock first', new."poDate"
      using errcode = 'P0007';
  end if;
  return new;
end $$;
drop trigger if exists po_month_open on finance."PurchaseOrder";
create trigger po_month_open before insert or update on finance."PurchaseOrder"
  for each row execute function finance.po_month_open();

-- ---------------------------------------------------------------------------
-- Vendor documents (M05)
-- ---------------------------------------------------------------------------
-- BR-19: one document number per vendor per FY (case and spaces ignored). A cancelled entry
-- (entered in error) does not block entering it again.
drop index if exists finance.vendor_doc_number_uq;
create unique index vendor_doc_number_uq on finance."VendorDocument" ("vendorId", "fyLabel", "docNumberKey")
  where "status" <> 'cancelled';

alter table finance."VendorDocument" drop constraint if exists vendor_doc_shape;
alter table finance."VendorDocument" add constraint vendor_doc_shape check (
  "gstMode" in ('cgst_sgst', 'igst', 'none')
  and "totalValue" = "taxableValue" + "cgst" + "sgst" + "igst" + "otherCharges" + "roundOff"
  and "taxableValue" >= 0 and "otherCharges" >= 0 and "tdsAmount" >= 0 and "tdsBase" >= 0
  and (not "tdsApplicable" or "tdsSectionId" is not null)
  and ("status" not in ('cancelled', 'disputed') or length(trim(coalesce("statusReason", ''))) > 0)
  and ("docType" not in ('debit_note', 'credit_note') or "againstDocumentId" is not null)
  and length(trim("docNumber")) > 0
);
alter table finance."VendorDocumentLine" drop constraint if exists vendor_doc_line_amounts;
alter table finance."VendorDocumentLine" add constraint vendor_doc_line_amounts check (
  "qty" > 0 and "rate" >= 0 and "discount" >= 0 and "taxable" >= 0 and "gstRate" >= 0
  and "lineTotal" = "taxable" + "cgst" + "sgst" + "igst"
);

-- A paid, replaced or cancelled document is closed: only its payment figures and status move.
create or replace function finance.vendor_doc_closed_fixed() returns trigger
language plpgsql as $$
begin
  if old."status" in ('paid', 'replaced', 'cancelled')
     and (to_jsonb(new) - array['status', 'statusReason', 'advancesApplied', 'paidAmount', 'notesAdjustment',
                                'netPayable', 'outstanding', 'updatedAt', 'updatedBy'])
         is distinct from
         (to_jsonb(old) - array['status', 'statusReason', 'advancesApplied', 'paidAmount', 'notesAdjustment',
                                'netPayable', 'outstanding', 'updatedAt', 'updatedBy']) then
    raise exception 'finance: vendor document % is %; it cannot be edited', old."docNumber", old."status"
      using errcode = 'P0009';
  end if;
  return new;
end $$;
drop trigger if exists vendor_doc_closed_fixed on finance."VendorDocument";
create trigger vendor_doc_closed_fixed before update on finance."VendorDocument"
  for each row execute function finance.vendor_doc_closed_fixed();

create or replace function finance.vendor_doc_line_fixed() returns trigger
language plpgsql as $$
declare
  d record;
begin
  select "docNumber", "status" into d from finance."VendorDocument" where id = new."docId";
  if d."status" in ('paid', 'replaced', 'cancelled') then
    raise exception 'finance: vendor document % is %; its lines cannot change', d."docNumber", d."status"
      using errcode = 'P0009';
  end if;
  return new;
end $$;
drop trigger if exists vendor_doc_line_fixed on finance."VendorDocumentLine";
create trigger vendor_doc_line_fixed before insert or update on finance."VendorDocumentLine"
  for each row execute function finance.vendor_doc_line_fixed();

-- BR-36: no vendor document entered or re-dated in a locked month.
create or replace function finance.vendor_doc_month_open() returns trigger
language plpgsql as $$
begin
  if (tg_op = 'INSERT' or new."docDate" is distinct from old."docDate")
     and finance.is_month_locked(new."entityId", new."docDate") then
    raise exception 'finance: % is in a locked month; unlock it in Settings > Period lock first', new."docDate"
      using errcode = 'P0007';
  end if;
  return new;
end $$;
drop trigger if exists vendor_doc_month_open on finance."VendorDocument";
create trigger vendor_doc_month_open before insert or update on finance."VendorDocument"
  for each row execute function finance.vendor_doc_month_open();

-- ---------------------------------------------------------------------------
-- Payments out (M06)
-- ---------------------------------------------------------------------------
alter table finance."PaymentOut" drop constraint if exists payment_shape;
alter table finance."PaymentOut" add constraint payment_shape check (
  "amount" > 0 and "tdsAmount" >= 0
  and ("status" in ('requested', 'approved', 'cancelled') or ("paymentNo" is not null and "paidDate" is not null and "mode" is not null))
  and ("status" not in ('cancelled', 'failed') or length(trim(coalesce("statusReason", ''))) > 0)
  and (("status" = 'reconciled') = ("bankTxnId" is not null))
);
alter table finance."PaymentAllocation" drop constraint if exists payment_allocation_shape;
alter table finance."PaymentAllocation" add constraint payment_allocation_shape check (
  "amount" >= 0 and "tdsAmount" >= 0 and "amount" + "tdsAmount" > 0
  and (("docId" is null) <> ("poId" is null))
);

-- A numbered (paid) payment is fixed: its number, vendor, amount and date never change.
-- Corrections are a failure / reversal with a reason, never an edit.
create or replace function finance.payment_paid_fixed() returns trigger
language plpgsql as $$
begin
  if old."paymentNo" is not null and (
       new."paymentNo" is distinct from old."paymentNo" or new."vendorId" is distinct from old."vendorId"
    or new."amount" is distinct from old."amount" or new."tdsAmount" is distinct from old."tdsAmount"
    or new."paidDate" is distinct from old."paidDate") then
    raise exception 'finance: payment % is recorded; it cannot be changed, only marked failed', old."paymentNo"
      using errcode = 'P0010';
  end if;
  return new;
end $$;
drop trigger if exists payment_paid_fixed on finance."PaymentOut";
create trigger payment_paid_fixed before update on finance."PaymentOut"
  for each row execute function finance.payment_paid_fixed();

-- Allocations of a recorded payment: only archiving (failure) and applying an advance move.
create or replace function finance.payment_allocation_fixed() returns trigger
language plpgsql as $$
declare
  p record;
begin
  select "paymentNo" into p from finance."PaymentOut" where id = new."paymentId";
  if p."paymentNo" is null then return new; end if;
  if tg_op = 'INSERT' or (to_jsonb(new) - array['isArchived', 'appliedToDocId', 'appliedAt', 'updatedAt', 'updatedBy'])
                          is distinct from (to_jsonb(old) - array['isArchived', 'appliedToDocId', 'appliedAt', 'updatedAt', 'updatedBy']) then
    raise exception 'finance: payment % is recorded; its allocations cannot change', p."paymentNo" using errcode = 'P0010';
  end if;
  return new;
end $$;
drop trigger if exists payment_allocation_fixed on finance."PaymentAllocation";
create trigger payment_allocation_fixed before insert or update on finance."PaymentAllocation"
  for each row execute function finance.payment_allocation_fixed();

-- BR-36: no payment recorded or re-dated in a locked month.
create or replace function finance.payment_month_open() returns trigger
language plpgsql as $$
begin
  if new."paidDate" is not null and (tg_op = 'INSERT' or new."paidDate" is distinct from old."paidDate")
     and finance.is_month_locked(new."entityId", new."paidDate") then
    raise exception 'finance: % is in a locked month; unlock it in Settings > Period lock first', new."paidDate"
      using errcode = 'P0007';
  end if;
  return new;
end $$;
drop trigger if exists payment_month_open on finance."PaymentOut";
create trigger payment_month_open before insert or update on finance."PaymentOut"
  for each row execute function finance.payment_month_open();

-- Attach the audit, actor-stamp and no-delete triggers to every finance table except AuditLog.
-- New tables pick them up on the next `npm run db:sync`.
do $$
declare
  t record;
begin
  for t in
    select tablename from pg_tables
    where schemaname = 'finance' and tablename <> 'AuditLog'
  loop
    execute format('drop trigger if exists aa_stamp_actor on finance.%I', t.tablename);
    execute format('create trigger aa_stamp_actor before insert or update on finance.%I
                    for each row execute function finance.stamp_actor()', t.tablename);
    execute format('drop trigger if exists zz_audit on finance.%I', t.tablename);
    execute format('create trigger zz_audit after insert or update on finance.%I
                    for each row execute function finance.audit_row()', t.tablename);
    execute format('drop trigger if exists no_hard_delete on finance.%I', t.tablename);
    execute format('create trigger no_hard_delete before delete on finance.%I
                    for each row execute function finance.no_hard_delete()', t.tablename);
    execute format('drop trigger if exists no_truncate on finance.%I', t.tablename);
    execute format('create trigger no_truncate before truncate on finance.%I
                    for each statement execute function finance.no_hard_delete()', t.tablename);
  end loop;
end $$;
