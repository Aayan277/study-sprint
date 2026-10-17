-- Study Sprint limits and account deletion: run this in your Supabase project after setup.sql and media.sql
-- (SQL Editor → New query → paste → Run). It is safe to run again. If you ever run media.sql again, run this again after it.
--
-- What it does:
--   1. quotas          one row per person who should have a different amount of picture/sound space than the default.
--   2. Media space     a person's folder in the "media" bucket may not take new files once it is at or above their limit.
--                      The server can't see the size of the file being added, so a person can go over the limit by at
--                      most one file (3 MB). Files in total can't be refused halfway through.
--   3. File size       every file in the bucket is limited to 3 MB.
--   4. Record size     every synced record must be under 64 KB (real cards are under 1 KB).
--   5. my_usage()      what the app shows under Settings → Your data: bytes of data, bytes of media, and the limit.
--   6. delete_my_account()  lets a person delete their own account, their files and their data (Settings → Sync).
--
-- The numbers:  default limit 180 MB (188,743,680 bytes) = room for you and four friends on the free 1 GB of storage.
--               Pro plan: 2 GB (2,147,483,648 bytes). To change one person's limit, see docs/sync-setup.md.

-- ---------- 1. quotas ----------
create table if not exists public.quotas (
  user_id           uuid   primary key references auth.users (id) on delete cascade,
  media_bytes_limit bigint not null default 188743680 check (media_bytes_limit >= 0)
);
alter table public.quotas enable row level security;
drop policy if exists "quotas: read own" on public.quotas;
create policy "quotas: read own" on public.quotas for select to authenticated using (user_id = (select auth.uid()));
-- No insert/update/delete rule: only you (the project owner, in the SQL Editor or Table Editor) can change limits.

-- The default limit: 180 MB. Made only if it isn't there yet, so running this file again never undoes a change.
-- To move everyone's default (e.g. to 2 GB on the Pro plan), run in the SQL Editor:
--   create or replace function public.default_media_limit() returns bigint language sql immutable as $f$ select 2147483648::bigint $f$;
do $$
begin
  if to_regprocedure('public.default_media_limit()') is null then
    create function public.default_media_limit() returns bigint language sql immutable as 'select 188743680::bigint';
  end if;
end $$;

-- A person's limit: their row in quotas, or the default.
create or replace function public.media_limit(uid uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce((select q.media_bytes_limit from public.quotas q where q.user_id = uid), public.default_media_limit());
$$;

-- Bytes a person's folder in the media bucket takes now.
create or replace function public.media_used(uid uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum((o.metadata ->> 'size')::bigint), 0)::bigint
  from storage.objects o
  where o.bucket_id = 'media' and o.name like uid::text || '/%';
$$;

revoke all on function public.default_media_limit(), public.media_limit(uuid), public.media_used(uuid) from public, anon, authenticated;
grant execute on function public.default_media_limit(), public.media_limit(uuid), public.media_used(uuid) to authenticated;

-- ---------- 2 + 3. media space and file size ----------
update storage.buckets set file_size_limit = 3145728 where id = 'media';

drop policy if exists "media: add own" on storage.objects;
create policy "media: add own" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and public.media_used((select auth.uid())) < public.media_limit((select auth.uid()))
  );

-- ---------- 4. record size ----------
-- "not valid" means records already stored aren't checked, only new and changed ones.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sync_items_data_size' and conrelid = 'public.sync_items'::regclass) then
    alter table public.sync_items
      add constraint sync_items_data_size check (data is null or octet_length(data::text) < 65536) not valid;
  end if;
end $$;

-- ---------- 5. my_usage() ----------
-- { "data_bytes": …, "media_bytes": …, "media_limit": … } for whoever is signed in.
create or replace function public.my_usage() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'data_bytes',  coalesce((select sum(pg_column_size(s)) from public.sync_items s where s.user_id = (select auth.uid())), 0)::bigint,
    'media_bytes', public.media_used((select auth.uid())),
    'media_limit', public.media_limit((select auth.uid()))
  )
  where (select auth.uid()) is not null;
$$;

revoke all on function public.my_usage() from public, anon;
grant execute on function public.my_usage() to authenticated;

-- ---------- 6. delete_my_account() ----------
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
  delete from storage.objects where bucket_id = 'media' and name like uid::text || '/%';
  delete from public.sync_items where user_id = uid;
  delete from public.quotas where user_id = uid;
  delete from auth.users where id = uid;
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
