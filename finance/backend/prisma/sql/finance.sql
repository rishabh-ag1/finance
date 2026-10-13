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
