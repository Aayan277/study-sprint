-- Study Sprint pictures and sounds: run this in your Supabase project (SQL Editor → New query → paste → Run).
-- It's safe to run again, and you need to run it again once if you ran an older copy (before sounds on cards):
-- the older list of allowed file types only had pictures. (SQL schema version 2.)
--
-- Pictures and sounds on cards are files, so they live in Supabase Storage (not the sync_items table): a private
-- bucket called "media", with one folder per account named after its user id. These rules mean every
-- signed-in person can only see, add, change or delete the files in their own folder.
-- The app keeps each sound to 1 MB or less and each picture to 1.5 MB (3 MB for image occlusion); the bucket's own
-- limit of 3 MB per file is the backstop. After this, run supabase/limits.sql: it adds the per-account space limit to
-- the "add" rule below (run limits.sql again if you ever run this file again).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', false, 3145728, array['image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm', 'audio/wav', 'audio/flac'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "media: read own" on storage.objects;
drop policy if exists "media: add own" on storage.objects;
drop policy if exists "media: change own" on storage.objects;
drop policy if exists "media: delete own" on storage.objects;

create policy "media: read own" on storage.objects for select to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "media: add own" on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "media: change own" on storage.objects for update to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "media: delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- A line in the private log of which SQL file ran (the log is made by setup.sql; this makes it too if it is missing).
create schema if not exists private;
revoke all on schema private from public, anon;
create table if not exists private.schema_log (
  id      bigint generated always as identity primary key,
  file    text    not null,
  version integer not null,
  ran_at  timestamptz not null default now()
);
alter table private.schema_log enable row level security;
revoke all on private.schema_log from public, anon, authenticated;
insert into private.schema_log (file, version) values ('media.sql', 2);

-- Status: every line should say ok. (Run limits.sql next: it adds the space limits to the add and change rules.)
select * from (values
  (1, 'media bucket is private', coalesce((select (not b.public)::text from storage.buckets b where b.id = 'media'), 'missing'),
      case when exists (select 1 from storage.buckets b where b.id = 'media' and not b.public) then 'ok' else 'NO' end),
  (2, 'rules on the media files', (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'media: %')::text,
      case when (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'media: %') = 4 then 'ok' else 'NO: expected 4' end)
) as status(n, what, value, result) order by n;
