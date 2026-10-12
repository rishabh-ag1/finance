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
    act := case
      when k = 'isArchived' and n->>k = 'true' then 'archive'
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

-- Attach the audit and no-delete triggers to every finance table except AuditLog.
-- New tables pick them up on the next `npm run db:sync`.
do $$
declare
  t record;
begin
  for t in
    select tablename from pg_tables
    where schemaname = 'finance' and tablename <> 'AuditLog'
  loop
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
