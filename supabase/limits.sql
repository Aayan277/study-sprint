-- Study Sprint limits and account deletion: run this in your Supabase project after setup.sql and media.sql
-- (SQL Editor → New query → paste → Run). It is safe to run again. If you ever run media.sql again, run this again after it.
--
-- What it does:
--   1. quotas          one row per person who should have a different amount of space than the default.
--   2. Media space     a person's folder in the "media" bucket (pictures and sounds) stops taking new files when the next
--                      one wouldn't fit in their limit (default 180 MB). Uploads from the same person are checked one at a
--                      time, so two at once can't both squeeze in.
--   3. Data space      a person's synced data (cards, reviews, settings) is limited too (default 80 MB). Going over is refused;
--                      deleting is always allowed.
--   4. The whole project   the free plan stops working (read-only) at 500 MB of database and 1 GB of files, for everybody.
--                      So new pictures are refused when the whole bucket is over 900 MB and new data when everyone's data is over
--                      420 MB. The numbers are in the table global_limits, and the totals are re-counted at most once a minute.
--   5. File size       every file in the bucket is limited to 3 MB; every synced record to 64 KB (real cards are under 1 KB).
--   6. my_usage()      what the app shows under Settings → Your data.
--   7. delete_my_account()  lets a person delete their own account, their files and their data (Settings → Sync).
--
-- Defaults: media 180 MB (188,743,680 bytes), data 80 MB (83,886,080 bytes). With open sign-ups, think about lowering the
-- media default (one line, in docs/sync-setup.md) and raising it for people you know.

-- ---------- 1. quotas and the numbers behind them ----------
create table if not exists public.quotas (
  user_id           uuid   primary key references auth.users (id) on delete cascade,
  media_bytes_limit bigint not null default 188743680 check (media_bytes_limit >= 0)
);
alter table public.quotas add column if not exists data_bytes_limit bigint not null default 83886080 check (data_bytes_limit >= 0);
alter table public.quotas add column if not exists data_rows_limit bigint not null default 300000 check (data_rows_limit >= 0);
alter table public.quotas enable row level security;
drop policy if exists "quotas: read own" on public.quotas;
create policy "quotas: read own" on public.quotas for select to authenticated using (user_id = (select auth.uid()));
-- Nobody but you (the project owner, in the SQL Editor or Table Editor) can change limits.
revoke all on public.quotas from anon, authenticated;
grant select on public.quotas to authenticated;

-- The project-wide ceilings, in bytes (you can change them: for example when you move to the Pro plan).
create table if not exists public.global_limits (name text primary key, bytes bigint not null check (bytes >= 0));
insert into public.global_limits (name, bytes) values ('media', 943718400), ('sync', 440401920) on conflict (name) do nothing;
alter table public.global_limits enable row level security;
revoke all on public.global_limits from anon, authenticated;

-- How much synced data each person has (kept up to date by a trigger, so nothing has to add it all up), and a
-- one-minute cache of the project-wide totals.
create table if not exists public.sync_usage (
  user_id uuid   primary key references auth.users (id) on delete cascade,
  bytes   bigint not null default 0,
  rows    bigint not null default 0
);
alter table public.sync_usage enable row level security;
revoke all on public.sync_usage from anon, authenticated;

create table if not exists public.usage_cache (name text primary key, bytes bigint not null, at timestamptz not null);
alter table public.usage_cache enable row level security;
revoke all on public.usage_cache from anon, authenticated;

-- The default limits. Made only if they aren't there yet, so running this file again never undoes a change.
-- To change a default for everybody, run for example (in the SQL Editor):
--   create or replace function public.default_media_limit() returns bigint language sql immutable as 'select 52428800::bigint';
do $$
begin
  if to_regprocedure('public.default_media_limit()') is null then
    create function public.default_media_limit() returns bigint language sql immutable as 'select 188743680::bigint';
  end if;
  if to_regprocedure('public.default_data_limit()') is null then
    create function public.default_data_limit() returns bigint language sql immutable as 'select 83886080::bigint';
  end if;
end $$;

-- The old versions took a user id as an argument; the policies that used them go first, then they do.
drop policy if exists "media: add own" on storage.objects;
drop policy if exists "media: change own" on storage.objects;
drop function if exists public.media_limit(uuid);
drop function if exists public.media_used(uuid);

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

-- Project-wide totals, counted fresh at most once a minute.
create or replace function public._total_media_bytes() returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare b bigint; t timestamptz;
begin
  select c.bytes, c.at into b, t from public.usage_cache c where c.name = 'media';
  if found and t > now() - interval '60 seconds' then return b; end if;
  select coalesce(sum((o.metadata ->> 'size')::bigint), 0)::bigint into b from storage.objects o where o.bucket_id = 'media';
  insert into public.usage_cache (name, bytes, at) values ('media', b, now())
    on conflict (name) do update set bytes = excluded.bytes, at = excluded.at;
  return b;
end;
$$;

create or replace function public._total_sync_bytes() returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare b bigint; t timestamptz;
begin
  select c.bytes, c.at into b, t from public.usage_cache c where c.name = 'sync';
  if found and t > now() - interval '60 seconds' then return b; end if;
  select coalesce(sum(u.bytes), 0)::bigint into b from public.sync_usage u;
  insert into public.usage_cache (name, bytes, at) values ('sync', b, now())
    on conflict (name) do update set bytes = excluded.bytes, at = excluded.at;
  return b;
end;
$$;

-- ---------- 2 + 5. media space and file size ----------
update storage.buckets set file_size_limit = 3145728 where id = 'media';

-- May the signed-in person store this file (name, and its size when the server already knows it)?
-- Yes if the person exists, the file fits in their space (their other files + this one <= their limit; when the size
-- isn't known yet, they need to be under the limit), and the whole bucket stays under its ceiling. Runs under a
-- per-person lock, so parallel uploads are checked one after another.
create or replace function public.media_may_store(objname text, size_text text) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare uid uuid := auth.uid(); lim bigint; used bigint; sz bigint; cap bigint;
begin
  if uid is null then return false; end if;
  if not exists (select 1 from auth.users u where u.id = uid) then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text, 0));
  lim := public._media_limit(uid);
  used := public._media_used(uid, objname);
  sz := case when size_text ~ '^[0-9]{1,12}$' then size_text::bigint end;
  if sz is null then
    if used >= lim then return false; end if;
  elsif used + sz > lim then
    return false;
  end if;
  select g.bytes into cap from public.global_limits g where g.name = 'media';
  if public._total_media_bytes() + coalesce(sz, 0) > coalesce(cap, 943718400) then return false; end if;
  return true;
end;
$$;

revoke all on function public.default_media_limit(), public.default_data_limit(), public._media_limit(uuid), public._data_limit(uuid),
  public._rows_limit(uuid), public._media_used(uuid, text), public._total_media_bytes(), public._total_sync_bytes() from public, anon, authenticated;
revoke all on function public.media_may_store(text, text) from public, anon;
grant execute on function public.media_may_store(text, text) to authenticated;

create policy "media: add own" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and public.media_may_store(name, metadata ->> 'size')
  );

-- Replacing a file counts too (a small file can't be swapped for a 3 MB one to get round the limit).
create policy "media: change own" on storage.objects for update to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and public.media_may_store(name, metadata ->> 'size')
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

-- Keeps each person's byte and row counts, and refuses growth over their limit (or the project's). A row's size is
-- 120 bytes, twice its id (the primary key index holds it again) and its data as text. Every new row is checked, "deleted"
-- markers (a row with no data) included, and so is each person's number of rows (default 300,000). Only deleting and
-- changes that make a row smaller are always allowed. It runs after the row is stored (and only if it
-- was: an older change that setup.sql ignores never gets here), under a per-person lock.
create or replace function public.sync_items_quota() returns trigger
language plpgsql security definer set search_path = '' as $$
declare uid uuid; old_b bigint := 0; new_b bigint := 0; growth bigint; cur bigint; cur_rows bigint; cap bigint;
begin
  if tg_op = 'DELETE' then uid := old.user_id; else uid := new.user_id; end if;
  if tg_op <> 'INSERT' then old_b := 120 + 2 * octet_length(old.id) + coalesce(octet_length(old.data::text), 0); end if;
  if tg_op <> 'DELETE' then new_b := 120 + 2 * octet_length(new.id) + coalesce(octet_length(new.data::text), 0); end if;
  growth := new_b - old_b;
  perform pg_advisory_xact_lock(hashtextextended(uid::text, 1));
  -- (No new counter row on a delete: when an account is removed its rows go too, and its counter row with them.)
  if tg_op <> 'DELETE' then
    insert into public.sync_usage (user_id) values (uid) on conflict (user_id) do nothing;
  end if;
  if tg_op <> 'DELETE' and growth > 0 then
    select u.bytes, u.rows into cur, cur_rows from public.sync_usage u where u.user_id = uid;
    if tg_op = 'INSERT' and cur_rows + 1 > public._rows_limit(uid) then
      raise exception 'sync_data_full' using errcode = '54000';
    end if;
    if cur + growth > public._data_limit(uid) then
      raise exception 'sync_data_full' using errcode = '54000';
    end if;
    select g.bytes into cap from public.global_limits g where g.name = 'sync';
    if public._total_sync_bytes() + growth > coalesce(cap, 440401920) then
      raise exception 'sync_server_full' using errcode = '54000';
    end if;
  end if;
  update public.sync_usage u
    set bytes = greatest(0, u.bytes + growth),
        rows = greatest(0, u.rows + case tg_op when 'INSERT' then 1 when 'DELETE' then -1 else 0 end)
    where u.user_id = uid;
  return null;
end;
$$;

revoke all on function public.sync_items_quota() from public, anon, authenticated;

drop trigger if exists sync_items_quota on public.sync_items;
create trigger sync_items_quota
  after insert or update or delete on public.sync_items
  for each row execute function public.sync_items_quota();

-- Count everyone's synced data again from the rows themselves (run by hand if the numbers ever look wrong).
create or replace function public.recount_sync_usage() returns void
language sql security definer set search_path = '' as $$
  insert into public.sync_usage (user_id, bytes, rows)
    select s.user_id, sum(120 + 2 * octet_length(s.id) + coalesce(octet_length(s.data::text), 0))::bigint, count(*)
    from public.sync_items s group by s.user_id
  on conflict (user_id) do update set bytes = excluded.bytes, rows = excluded.rows;
  delete from public.usage_cache where name = 'sync';
$$;
revoke all on function public.recount_sync_usage() from public, anon, authenticated;
select public.recount_sync_usage();

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
-- Deletes the signed-in person's files, synced data and then the account itself. (The app also removes the files
-- through the Storage API first; this does it again as a safety net.)
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  -- Supabase blocks plain deletes from storage.objects unless this is switched on for the transaction.
  perform set_config('storage.allow_delete_query', 'true', true);
  delete from storage.objects where bucket_id = 'media' and name collate "C" like uid::text || '/%';
  delete from public.sync_items where user_id = uid;
  delete from public.quotas where user_id = uid;
  delete from auth.users where id = uid;
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
