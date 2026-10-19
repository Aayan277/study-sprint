-- Study Sprint limits and account deletion: run this in your Supabase project after setup.sql and media.sql
-- (SQL Editor → New query → paste → Run). It is safe to run again, and nothing is lost when you do. If you ever run
-- media.sql again, run this again after it. (SQL schema version 2: see "SQL changes log" in docs/sync-setup.md.)
--
-- What it does:
--   1. quotas          one row per person who should have a different amount of space than the default.
--   2. Media space     a person's folder in the "media" bucket (pictures and sounds) stops taking new files when the next
--                      one wouldn't fit in their limit (default 50 MB). Uploads from the same person are checked one at a
--                      time, so two at once can't both squeeze in.
--   3. Data space      a person's synced data (cards, reviews, settings) is limited too (default 40 MB). Going over is refused;
--                      deleting is always allowed. Every record must be a JSON object (or a deleted marker).
--   4. The whole project   the free plan stops working (read-only) at 500 MB of database and 1 GB of files, for everybody.
--                      So new pictures are refused when the whole bucket would pass 900 MB and new data when everyone's data
--                      would pass 300 MB (the real database is 1.1 to 1.6 times the counted size, plus indexes and the
--                      sign-in tables). The ceilings are in the table global_limits. The totals are kept EXACT in
--                      private.usage_totals (every insert, change and delete adds or takes off its bytes in the same
--                      transaction, and growth that would pass the ceiling is refused), so many people at once can't push
--                      past it.
--   5. File size       every file in the bucket is limited to 3 MB; every synced record to 64 KB (real cards are under 1 KB).
--   6. my_usage()      what the app shows under Settings → Your data.
--   7. delete_my_account()  lets a person delete their own account and data (Settings → Sync). Their pictures and sounds
--                      must be gone first (the app deletes them through the Storage API); otherwise it says "media_left".
--   8. app_config()    { "min_client": "4.36", "schema": 2 }: the oldest app version allowed to sync, and the SQL version.
--
-- Defaults: media 50 MB (52,428,800 bytes), data 40 MB (41,943,040 bytes) per person. Old copies of this file had 180 MB and
-- 80 MB: running this file lowers a default only if it is still the old one (a default you changed yourself is kept), and
-- anybody with their own row in the quotas table keeps their own numbers.
--
-- To give one named person more (change the email, the numbers are bytes):
--   insert into public.quotas (user_id, media_bytes_limit, data_bytes_limit)
--   select id, 209715200, 104857600 from auth.users where email = 'friend@example.com'
--   on conflict (user_id) do update set media_bytes_limit = excluded.media_bytes_limit, data_bytes_limit = excluded.data_bytes_limit
--   returning user_id;
-- (No row comes back if the email is wrong, so a typo is easy to see.)
-- (That uses up some of the project-wide ceiling too, so don't hand out more than the project can hold.)
--
-- To raise the minimum app version (everybody with an older app is asked to update before syncing):
--   update private.app_config_values set value = '4.40' where key = 'min_client';
-- Publish the new app version on the website FIRST, then raise this (otherwise everyone is asked to update to a version that
-- isn't there yet). Write it with two digits after the dot, like the app's version: '4.40', not '4.4'.

-- ---------- 0. the private schema, its log, and the numbers only the database may touch ----------
-- The checks below live in the schema "private" on purpose. Anything in "public" can also be called straight from the
-- internet as an RPC; the API only serves "public", so a function or table in "private" can be used by the rules but not
-- called or read from outside. (Do not add "private" to the API's exposed schemas in the Supabase settings.)
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create table if not exists private.schema_log (
  id      bigint generated always as identity primary key,
  file    text    not null,
  version integer not null,
  ran_at  timestamptz not null default now()
);
alter table private.schema_log enable row level security;
revoke all on private.schema_log from public, anon, authenticated;

-- One row per fuse: the exact number of bytes in use across the whole project. 'sync' = all synced data (as the
-- quota counts it), 'media' = all files in the bucket.
create table if not exists private.usage_totals (
  name  text   primary key,
  bytes bigint not null default 0 check (bytes >= 0)
);
alter table private.usage_totals enable row level security;
revoke all on private.usage_totals from public, anon, authenticated;
insert into private.usage_totals (name) values ('sync'), ('media') on conflict (name) do nothing;

-- Settings the owner can edit. min_client is only made if it isn't there yet, so running this file again never undoes your change.
create table if not exists private.app_config_values (key text primary key, value text not null);
alter table private.app_config_values enable row level security;
revoke all on private.app_config_values from public, anon, authenticated;
insert into private.app_config_values (key, value) values ('min_client', '4.36') on conflict (key) do nothing;

-- ---------- 1. quotas and the numbers behind them ----------
create table if not exists public.quotas (
  user_id           uuid   primary key references auth.users (id) on delete cascade,
  media_bytes_limit bigint not null default 52428800 check (media_bytes_limit >= 0)
);
alter table public.quotas add column if not exists data_bytes_limit bigint not null default 41943040 check (data_bytes_limit >= 0);
alter table public.quotas add column if not exists data_rows_limit bigint not null default 300000 check (data_rows_limit >= 0);
-- (The new default applies to rows added from now on. Rows already there keep what they have.)
alter table public.quotas alter column media_bytes_limit set default 52428800;
alter table public.quotas alter column data_bytes_limit set default 41943040;
alter table public.quotas enable row level security;
drop policy if exists "quotas: read own" on public.quotas;
create policy "quotas: read own" on public.quotas for select to authenticated using (user_id = (select auth.uid()));
-- Nobody but you (the project owner, in the SQL Editor or Table Editor) can change limits.
revoke all on public.quotas from anon, authenticated;
grant select on public.quotas to authenticated;

-- The project-wide ceilings, in bytes (you can change them: for example when you move to the Pro plan).
create table if not exists public.global_limits (name text primary key, bytes bigint not null check (bytes >= 0));
insert into public.global_limits (name, bytes) values ('media', 943718400), ('sync', 314572800) on conflict (name) do nothing;
-- (The data ceiling used to be 420 MB. It is lowered to 300 MB further down, after the totals are counted, and only if it is
-- still 420 MB and today's counted data is under 280 MB. See the status table at the very bottom.)
alter table public.global_limits enable row level security;
revoke all on public.global_limits from anon, authenticated;

-- How much synced data each person has (kept up to date by a trigger, so nothing has to add it all up).
create table if not exists public.sync_usage (
  user_id uuid   primary key references auth.users (id) on delete cascade,
  bytes   bigint not null default 0,
  rows    bigint not null default 0
);
alter table public.sync_usage enable row level security;
revoke all on public.sync_usage from anon, authenticated;

-- (Older copies cached the project-wide totals for a minute, which let a burst of writes go past the ceiling.)
drop table if exists public.usage_cache;

-- The default limits. Old copies of this file made them 180 MB and 80 MB; those are replaced by the new defaults,
-- but any other number (one you put there yourself) is left alone.
do $$
declare def text;
begin
  def := case when to_regprocedure('public.default_media_limit()') is null then null
              else pg_get_functiondef(to_regprocedure('public.default_media_limit()')) end;
  if def is null or def like '%188743680%' then
    create or replace function public.default_media_limit() returns bigint language sql immutable as 'select 52428800::bigint';
  end if;
  def := case when to_regprocedure('public.default_data_limit()') is null then null
              else pg_get_functiondef(to_regprocedure('public.default_data_limit()')) end;
  if def is null or def like '%83886080%' then
    create or replace function public.default_data_limit() returns bigint language sql immutable as 'select 41943040::bigint';
  end if;
end $$;
-- To change a default for everybody later, run for example (in the SQL Editor):
--   create or replace function public.default_media_limit() returns bigint language sql immutable as 'select 31457280::bigint';

-- The old versions took a user id as an argument; the policies that used them go first, then they do.
drop policy if exists "media: add own" on storage.objects;
drop policy if exists "media: change own" on storage.objects;
drop function if exists public.media_limit(uuid);
drop function if exists public.media_used(uuid);
drop function if exists public.media_may_store(text, text);       -- (older copies had it in the public schema, see the note at its new home below)

-- Helpers. They work on whoever is calling and can't be called by the app directly.
create or replace function public._media_limit(uid uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce((select q.media_bytes_limit from public.quotas q where q.user_id = uid), public.default_media_limit());
$$;

create or replace function public._data_limit(uid uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce((select q.data_bytes_limit from public.quotas q where q.user_id = uid), public.default_data_limit());
$$;

create or replace function public._rows_limit(uid uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce((select q.data_rows_limit from public.quotas q where q.user_id = uid), 300000::bigint);
$$;

-- Bytes a person's folder in the media bucket takes, leaving out one file (the one being replaced).
-- "collate C" lets the database use its index on file names.
create or replace function public._media_used(uid uuid, except_name text default '') returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum((o.metadata ->> 'size')::bigint), 0)::bigint
  from storage.objects o
  where o.bucket_id = 'media' and o.name collate "C" like uid::text || '/%' and o.name <> except_name;
$$;

-- What one synced record counts as: 200 bytes, twice its id (the primary key index holds it again) and its data as text
-- (or its binary size, if larger). Worked out from the content only, so a record always counts the same, whichever
-- way it is stored; the totals stay exact because of that.
create or replace function private.row_bytes(rid text, d jsonb) returns bigint
language sql immutable set search_path = '' as $$
  select 200 + 2 * octet_length(rid)
    + case when d is null then 0 else greatest(octet_length(d::text), pg_column_size((d::text)::jsonb)) end;
$$;

-- ---------- 2 + 5. media space and file size ----------
update storage.buckets set file_size_limit = 3145728 where id = 'media';

-- May the signed-in person store this file (name, and its size when the server already knows it)?
-- Yes if the person exists, the file fits in their space (their other files + this one <= their limit; when the size
-- isn't known yet, they need to be under the limit; for the project ceiling a full 3 MB is assumed), and the whole bucket stays under its ceiling (read from the exact
-- total). Runs under a per-person lock, so parallel uploads are checked one after another. The storage rules call it
-- as the person who is uploading, so that person must be allowed to run it (that is why it is in "private").
-- The last word is the trigger on storage.objects below: it adds each file's bytes to the exact total and refuses
-- the one that would pass the ceiling, atomically.
create or replace function private.media_may_store(objname text, size_text text) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare uid uuid := auth.uid(); lim bigint; used bigint; sz bigint; eff bigint; cap bigint; tot bigint; oldsz bigint;
begin
  if uid is null then return false; end if;
  if not exists (select 1 from auth.users u where u.id = uid) then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text, 0));
  lim := public._media_limit(uid);
  used := public._media_used(uid, objname);
  sz := case when size_text ~ '^[0-9]{1,12}$' then size_text::bigint end;
  -- Per person: when the size isn't known yet, they need to be under their limit (a file can then go over by up to 3 MB).
  if sz is null then
    if used >= lim then return false; end if;
  elsif used + sz > lim then
    return false;
  end if;
  -- Project ceiling: Storage's own check often runs before it knows the size, so assume the worst, a full 3 MB file.
  eff := coalesce(sz, 3145728);
  select g.bytes into cap from public.global_limits g where g.name = 'media';
  -- The exact total is kept by the trigger on storage.objects. If that trigger isn't there (it needs rights on Supabase's own
  -- table), fall back to adding the files up now.
  if exists (select 1 from pg_trigger tg where tg.tgrelid = 'storage.objects'::regclass and tg.tgname = 'media_total_track' and not tg.tgisinternal and tg.tgenabled <> 'D') then
    select t.bytes into tot from private.usage_totals t where t.name = 'media';
  else
    select coalesce(sum((o.metadata ->> 'size')::bigint), 0)::bigint into tot from storage.objects o where o.bucket_id = 'media';
  end if;
  -- (replacing a file only adds the difference)
  select coalesce(sum((o.metadata ->> 'size')::bigint), 0)::bigint into oldsz
    from storage.objects o where o.bucket_id = 'media' and o.name = objname;
  if tot is null then return false; end if;
  if tot + greatest(eff - oldsz, 0) > coalesce(cap, 943718400) then return false; end if;
  return true;
end;
$$;

-- Keeps the exact project-wide total of media bytes: every file added, replaced or deleted (by the app, by the
-- Storage API, or by you) changes it in the same transaction, and growth past the ceiling is refused.
create or replace function private.media_total_track() returns trigger
language plpgsql security definer set search_path = '' as $$
declare old_b bigint := 0; new_b bigint := 0; d bigint;
begin
  if tg_op <> 'INSERT' and old.bucket_id = 'media' and (old.metadata ->> 'size') ~ '^[0-9]{1,12}$' then
    old_b := (old.metadata ->> 'size')::bigint;
  end if;
  if tg_op <> 'DELETE' and new.bucket_id = 'media' and (new.metadata ->> 'size') ~ '^[0-9]{1,12}$' then
    new_b := (new.metadata ->> 'size')::bigint;
  end if;
  d := new_b - old_b;
  if d > 0 then
    update private.usage_totals t set bytes = t.bytes + d
      where t.name = 'media'
        and t.bytes + d <= coalesce((select g.bytes from public.global_limits g where g.name = 'media'), 943718400);
    if not found then raise exception 'media_server_full' using errcode = '54000'; end if;
  elsif d < 0 then
    update private.usage_totals t set bytes = greatest(0, t.bytes + d) where t.name = 'media';
  end if;
  return null;
end;
$$;

revoke all on function public.default_media_limit(), public.default_data_limit(), public._media_limit(uuid), public._data_limit(uuid),
  public._rows_limit(uuid), public._media_used(uuid, text) from public, anon, authenticated;
revoke all on function private.row_bytes(text, jsonb), private.media_total_track() from public, anon, authenticated;
revoke all on function private.media_may_store(text, text) from public, anon;
grant execute on function private.media_may_store(text, text) to authenticated;

-- The trigger sits on Supabase's own table storage.objects. It is only made if it isn't there yet. If this account isn't allowed to add
-- one, the script goes on (uploads are then checked against a live count, and the status table at the bottom says "NO").
do $$
begin
  if not exists (select 1 from pg_trigger tg where tg.tgrelid = 'storage.objects'::regclass and tg.tgname = 'media_total_track' and not tg.tgisinternal) then
    create trigger media_total_track
      after insert or delete or update of metadata, bucket_id on storage.objects
      for each row execute function private.media_total_track();
  end if;
exception when insufficient_privilege then
  raise warning 'Could not add the media_total_track trigger on storage.objects (not allowed). The status table at the bottom says so; until it is there, uploads are checked against a live count instead.';
end $$;

create policy "media: add own" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and private.media_may_store(name, metadata ->> 'size')
  );

-- Replacing a file counts too (a small file can't be swapped for a 3 MB one to get round the limit).
create policy "media: change own" on storage.objects for update to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and private.media_may_store(name, metadata ->> 'size')
  );

-- ---------- 3 + 4 + 5. synced data space ----------
-- "not valid" means records already stored aren't checked, only new and changed ones.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sync_items_data_size' and conrelid = 'public.sync_items'::regclass) then
    alter table public.sync_items
      add constraint sync_items_data_size check (data is null or octet_length(data::text) < 65536) not valid;
  end if;
end $$;

-- A record's id is at most 200 bytes (real ones are under 60: a UUID, "gloss:" + UUID, or deck id + "-" + number).
-- "not valid" again: stored rows aren't checked.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sync_items_id_size' and conrelid = 'public.sync_items'::regclass) then
    alter table public.sync_items
      add constraint sync_items_id_size check (octet_length(id) <= 200) not valid;
  end if;
end $$;

-- A record's data is a JSON object (the app never sends anything else), unless the record is a deleted marker, and a
-- record that is not deleted always has data. Added "not valid" first, so rows already stored can't make this file fail;
-- then it is checked against them. If some old row breaks the rule you get a WARNING instead of a failure; find them with
--   select user_id, store, id from public.sync_items where not deleted and coalesce(jsonb_typeof(data), '') <> 'object';
-- fix or delete them, then run:  alter table public.sync_items validate constraint sync_items_data_object;
-- (Until then it is still enforced for every new and changed row.)
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sync_items_data_object' and conrelid = 'public.sync_items'::regclass) then
    alter table public.sync_items
      add constraint sync_items_data_object check (deleted or coalesce(jsonb_typeof(data), '') = 'object') not valid;
  end if;
  begin
    alter table public.sync_items validate constraint sync_items_data_object;
  exception when check_violation then
    raise warning 'Some stored records are not JSON objects (see the note above this block in limits.sql). New records are checked; the old ones are not yet.';
  end;
end $$;

-- Keeps each person's byte and row counts and the project's exact total, and refuses growth over their limit (or the
-- project's). Every new row is checked, "deleted" markers (a row with no data) included, and so is each person's number
-- of rows (default 300,000). Only deleting and changes that make a row smaller are always allowed. It runs after the row is
-- stored (and only if it was: an older change that setup.sql ignores never gets here), under a per-person lock.
-- The project's total is changed with one conditional update ("add the growth, but only if it stays under the ceiling"):
-- if no row is updated the change is refused with sync_server_full, so two people at once can't both pass the ceiling.
-- Deleting rows (a person deleting their data, or their account) gives their bytes back to the total.
create or replace function public.sync_items_quota() returns trigger
language plpgsql security definer set search_path = '' as $$
declare uid uuid; old_b bigint := 0; new_b bigint := 0; growth bigint; cur bigint := 0; cur_rows bigint := 0;
begin
  if tg_op = 'DELETE' then uid := old.user_id; else uid := new.user_id; end if;
  if tg_op <> 'INSERT' then old_b := private.row_bytes(old.id, old.data); end if;
  if tg_op <> 'DELETE' then new_b := private.row_bytes(new.id, new.data); end if;
  growth := new_b - old_b;
  -- A change that doesn't change the size touches no counter (and so takes no lock that could deadlock with a recount).
  if tg_op = 'UPDATE' and growth = 0 then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text, 1));
  if tg_op <> 'DELETE' and growth > 0 then
    select u.bytes, u.rows into cur, cur_rows from public.sync_usage u where u.user_id = uid;
    cur := coalesce(cur, 0); cur_rows := coalesce(cur_rows, 0);
    if tg_op = 'INSERT' and cur_rows + 1 > public._rows_limit(uid) then
      raise exception 'sync_data_full' using errcode = '54000';
    end if;
    if cur + growth > public._data_limit(uid) then
      raise exception 'sync_data_full' using errcode = '54000';
    end if;
  end if;
  -- The project's exact total.
  if growth > 0 then
    update private.usage_totals t set bytes = t.bytes + growth
      where t.name = 'sync'
        and t.bytes + growth <= coalesce((select g.bytes from public.global_limits g where g.name = 'sync'), 314572800);
    if not found then
      raise exception 'sync_server_full' using errcode = '54000';
    end if;
  elsif growth < 0 then
    update private.usage_totals t set bytes = greatest(0, t.bytes + growth) where t.name = 'sync';
  end if;
  -- This person's counts. (No new counter row on a delete: when an account is removed its rows go too, and its counter row with them.)
  if tg_op = 'DELETE' then
    update public.sync_usage u set bytes = greatest(0, u.bytes + growth), rows = greatest(0, u.rows - 1) where u.user_id = uid;
  else
    insert into public.sync_usage as u (user_id, bytes, rows)
      values (uid, greatest(0, growth), case tg_op when 'INSERT' then 1 else 0 end)
    on conflict (user_id) do update
      set bytes = greatest(0, u.bytes + growth),
          rows = greatest(0, u.rows + case tg_op when 'INSERT' then 1 else 0 end);
  end if;
  return null;
end;
$$;

revoke all on function public.sync_items_quota() from public, anon, authenticated;

drop trigger if exists sync_items_quota on public.sync_items;
create trigger sync_items_quota
  after insert or update or delete on public.sync_items
  for each row execute function public.sync_items_quota();

-- Count everyone's synced data again from the rows themselves, and set the project's exact total to match (run by hand
-- if the numbers ever look wrong; it runs once at the end of this file too). It first takes the total's row lock, so
-- changes made while it counts wait a moment and are not lost.
create or replace function public.recount_sync_usage() returns void
language plpgsql security definer set search_path = '' as $$
begin
  update private.usage_totals set bytes = bytes where name = 'sync';
  update public.sync_usage set bytes = 0, rows = 0;
  insert into public.sync_usage (user_id, bytes, rows)
    select s.user_id, sum(private.row_bytes(s.id, s.data))::bigint, count(*)
    from public.sync_items s group by s.user_id
  on conflict (user_id) do update set bytes = excluded.bytes, rows = excluded.rows;
  insert into private.usage_totals (name, bytes) values ('sync', (select coalesce(sum(u.bytes), 0) from public.sync_usage u))
  on conflict (name) do update set bytes = excluded.bytes;
end;
$$;

-- The same for the pictures and sounds total.
create or replace function public.recount_media_usage() returns void
language plpgsql security definer set search_path = '' as $$
begin
  update private.usage_totals set bytes = bytes where name = 'media';
  insert into private.usage_totals (name, bytes)
    values ('media', (select coalesce(sum((o.metadata ->> 'size')::bigint), 0)::bigint from storage.objects o where o.bucket_id = 'media'))
  on conflict (name) do update set bytes = excluded.bytes;
end;
$$;
revoke all on function public.recount_sync_usage(), public.recount_media_usage() from public, anon, authenticated;

-- The old one-minute caches are gone.
drop function if exists public._total_media_bytes();
drop function if exists public._total_sync_bytes();

-- On the first run this sets the totals from what is really stored. Running the file again just checks them again.
select public.recount_sync_usage();
select public.recount_media_usage();

-- Lower the old 420 MB data ceiling to 300 MB, but only if it is still that number (a number you chose yourself is kept) and
-- the data already stored is under 280 MB (lowering it under what is stored would refuse everybody's new data at once).
update public.global_limits set bytes = 314572800
  where name = 'sync' and bytes = 440401920
    and (select t.bytes from private.usage_totals t where t.name = 'sync') < 293601280;

-- ---------- 6. my_usage() ----------
-- { "data_bytes", "data_limit", "media_bytes", "media_limit" } for whoever is signed in.
create or replace function public.my_usage() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'data_bytes',  coalesce((select u.bytes from public.sync_usage u where u.user_id = (select auth.uid())), 0),
    'data_limit',  public._data_limit((select auth.uid())),
    'media_bytes', public._media_used((select auth.uid())),
    'media_limit', public._media_limit((select auth.uid()))
  )
  where (select auth.uid()) is not null;
$$;

revoke all on function public.my_usage() from public, anon;
grant execute on function public.my_usage() to authenticated;

-- ---------- 7. delete_my_account() ----------
-- Deletes the signed-in person's synced data and then the account itself. Their pictures and sounds must be deleted first,
-- through the Storage API (the app does that): deleting file records with SQL would leave the files' bytes behind on
-- Supabase's storage, still counting against the 1 GB. So while any are left this stops with "media_left" and changes nothing.
-- ("Delete my synced data" is a plain delete of the person's rows with the app's own sign-in; the trigger above gives their bytes back.)
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  if exists (select 1 from storage.objects o where o.bucket_id = 'media' and o.name collate "C" like uid::text || '/%') then
    raise exception 'media_left' using errcode = '55006', hint = 'Delete the pictures and sounds through the Storage API first.';
  end if;
  delete from public.sync_items where user_id = uid;
  delete from public.quotas where user_id = uid;
  delete from auth.users where id = uid;
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- ---------- 8. app_config() ----------
-- { "min_client": "4.36", "schema": 2 }. min_client is the oldest app version that may sync (edit it with the line in the
-- header of this file); schema is the SQL version this project has: the lowest of what setup.sql, media.sql and limits.sql
-- each last logged (0 if one of them has never run). The app asks for it when it starts, and a project without this
-- function means "no minimum".
create or replace function public.app_config() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'min_client', coalesce((select v.value from private.app_config_values v where v.key = 'min_client'), '0'),
    'schema', (select case when count(*) = 3 then min(f.v) else 0 end
               from (select l.file, max(l.version) as v from private.schema_log l
                     where l.file in ('setup.sql', 'media.sql', 'limits.sql') group by l.file) f)
  );
$$;

revoke all on function public.app_config() from public;
grant execute on function public.app_config() to anon, authenticated;

-- ---------- who may do what ----------
-- Only "authenticated" (a signed-in person) gets anything, and only what the app needs; anon (not signed in) gets nothing here
-- except app_config() above. No TRUNCATE, TRIGGER or REFERENCES for anyone.
revoke all on public.quotas, public.global_limits, public.sync_usage from anon, authenticated;
grant select on public.quotas to authenticated;

insert into private.schema_log (file, version) values ('limits.sql', 2);

-- ---------- STATUS: look at this table after the script ran ----------
-- The SQL Editor shows only the last result, so this is it. Every line should say "ok" in the last column.
select * from (values
  (1, 'script finished (version 2)', 'yes', 'ok'),
  (2, 'media total kept by a trigger on storage.objects',
      case when exists (select 1 from pg_trigger tg where tg.tgrelid = 'storage.objects'::regclass and tg.tgname = 'media_total_track' and not tg.tgisinternal and tg.tgenabled <> 'D') then 'yes' else 'NO' end,
      case when exists (select 1 from pg_trigger tg where tg.tgrelid = 'storage.objects'::regclass and tg.tgname = 'media_total_track' and not tg.tgisinternal and tg.tgenabled <> 'D') then 'ok'
           else 'NO: uploads are checked against a live count instead; ask for help' end),
  (3, 'records checked as JSON objects (all stored rows too)',
      coalesce((select case when c.convalidated then 'yes' else 'NO' end from pg_constraint c where c.conname = 'sync_items_data_object' and c.conrelid = 'public.sync_items'::regclass), 'missing'),
      case when coalesce((select c.convalidated from pg_constraint c where c.conname = 'sync_items_data_object' and c.conrelid = 'public.sync_items'::regclass), false) then 'ok'
           else 'NO: new records are checked, some old ones are not; see the note above the constraint in limits.sql' end),
  (4, 'synced data total vs counted from the rows (bytes)',
      (select t.bytes from private.usage_totals t where t.name = 'sync')::text || ' vs ' || (select coalesce(sum(private.row_bytes(s.id, s.data)), 0) from public.sync_items s)::text,
      case when (select t.bytes from private.usage_totals t where t.name = 'sync') = (select coalesce(sum(private.row_bytes(s.id, s.data)), 0) from public.sync_items s) then 'ok'
           else 'NO: run select public.recount_sync_usage();' end),
  (5, 'pictures total vs counted from the files (bytes)',
      (select t.bytes from private.usage_totals t where t.name = 'media')::text || ' vs ' || (select coalesce(sum((o.metadata ->> 'size')::bigint), 0) from storage.objects o where o.bucket_id = 'media')::text,
      case when (select t.bytes from private.usage_totals t where t.name = 'media') = (select coalesce(sum((o.metadata ->> 'size')::bigint), 0) from storage.objects o where o.bucket_id = 'media') then 'ok'
           else 'NO: run select public.recount_media_usage();' end),
  (6, 'default pictures / data per person (MB)',
      round(public.default_media_limit() / 1048576.0)::text || ' / ' || round(public.default_data_limit() / 1048576.0)::text,
      case when public.default_media_limit() = 52428800 and public.default_data_limit() = 41943040 then 'ok' else 'custom (kept, as you set it)' end),
  (7, 'project ceiling: pictures (MB)', (select round(g.bytes / 1048576.0)::text from public.global_limits g where g.name = 'media'),
      case when (select g.bytes from public.global_limits g where g.name = 'media') = 943718400 then 'ok' else 'custom (kept)' end),
  (8, 'project ceiling: synced data (MB)', (select round(g.bytes / 1048576.0)::text from public.global_limits g where g.name = 'sync'),
      case (select g.bytes from public.global_limits g where g.name = 'sync')
        when 314572800 then 'ok'
        when 440401920 then 'NOT lowered to 300: stored data is ' || round((select t.bytes from private.usage_totals t where t.name = 'sync') / 1048576.0)::text
                            || ' MB. Free some space, or lower it yourself when under 300 MB: update public.global_limits set bytes = 314572800 where name = ''sync'';'
        else 'custom (kept)' end)
) as status(n, what, value, result) order by n;
