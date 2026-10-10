-- Study Sprint pictures: run this once in your Supabase project (SQL Editor → New query → paste → Run).
-- It's safe to run again.
--
-- Pictures on cards are files, so they live in Supabase Storage (not the sync_items table): a private
-- bucket called "media", with one folder per account named after its user id. These rules mean every
-- signed-in person can only see, add, change or delete the files in their own folder.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
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
