-- OPTIONAL. A login that can only READ, for the two GitHub jobs (nightly backup and the daily space check), so that
-- the GitHub secret SUPABASE_DB_URL doesn't have to hold the all-powerful "postgres" password. If that secret leaks, someone
-- with this login can read your data (the backup already contains it) but cannot change or delete anything.
-- Run it in your Supabase project (SQL Editor → New query → paste → Run), after setup.sql, media.sql and limits.sql.
-- It is safe to run again. (SQL schema version 2. How to use it: docs/sync-setup.md, "A read-only login for the GitHub jobs".)
--
-- BEFORE YOU RUN IT: replace PASTE-A-LONG-PASSWORD-HERE on the line below with a long password you make up (at least 20
-- characters, letters and digits only is easiest; keep it in your password manager). The script refuses to run with the
-- placeholder. Running it again does NOT change the password (to change it later: alter role study_sprint_ci password '...';).
--
-- What the login can read, and why:
--   backup.yml     pg_dump of every table and sequence in "public", plus auth.users and auth.identities.
--   fuse-watch.yml public.sync_usage, public.global_limits, storage.objects (only the bucket and size info) and the database size.
-- It bypasses row security (as the postgres login does; a dump and a total over everybody need that) but has no right to
-- write to anything, and is set to start every session read-only.
create schema if not exists private;

do $$
declare pw text := 'PASTE-A-LONG-PASSWORD-HERE';
begin
  if not exists (select 1 from pg_roles where rolname = 'study_sprint_ci') then
    if pw like 'PASTE-%' or length(pw) < 20 then
      raise exception 'Put your own long password (at least 20 characters) on the line starting "declare pw text" in ci-roles.sql, then run it again.';
    end if;
    execute format('create role study_sprint_ci login password %L bypassrls noinherit connection limit 5', pw);
  end if;
end $$;

alter role study_sprint_ci set default_transaction_read_only = on;
alter role study_sprint_ci set statement_timeout = '15min';

grant usage on schema public, auth, storage to study_sprint_ci;
-- Everything in "public" (the backup dumps it all), now and for tables made later by this account.
grant select on all tables in schema public to study_sprint_ci;
grant select on all sequences in schema public to study_sprint_ci;
alter default privileges in schema public grant select on tables to study_sprint_ci;
alter default privileges in schema public grant select on sequences to study_sprint_ci;
-- The sign-in accounts, for the backup.
grant select on auth.users, auth.identities to study_sprint_ci;
-- Only the columns the space check uses.
grant select (bucket_id, metadata) on storage.objects to study_sprint_ci;
-- Not the private schema: nothing the two jobs do needs it.
revoke all on schema private from study_sprint_ci;
create table if not exists private.schema_log (
  id      bigint generated always as identity primary key,
  file    text    not null,
  version integer not null,
  ran_at  timestamptz not null default now()
);
alter table private.schema_log enable row level security;
revoke all on private.schema_log from public, anon, authenticated;
insert into private.schema_log (file, version) values ('ci-roles.sql', 2);

-- Status: every line should say ok. A missing right shows as NO.
select * from (values
  (1, 'login exists and can log in', coalesce((select r.rolcanlogin::text from pg_roles r where r.rolname = 'study_sprint_ci'), 'missing'),
      case when exists (select 1 from pg_roles r where r.rolname = 'study_sprint_ci' and r.rolcanlogin) then 'ok' else 'NO' end),
  (2, 'bypasses row security (the backup needs it)', coalesce((select r.rolbypassrls::text from pg_roles r where r.rolname = 'study_sprint_ci'), 'missing'),
      case when exists (select 1 from pg_roles r where r.rolname = 'study_sprint_ci' and r.rolbypassrls) then 'ok' else 'NO: the jobs will fail; see docs/sync-setup.md step 8e' end),
  (3, 'can read auth.users', case when has_table_privilege('study_sprint_ci', 'auth.users', 'SELECT') then 'yes' else 'NO' end, case when has_table_privilege('study_sprint_ci', 'auth.users', 'SELECT') then 'ok' else 'NO' end),
  (4, 'can read auth.identities', case when has_table_privilege('study_sprint_ci', 'auth.identities', 'SELECT') then 'yes' else 'NO' end, case when has_table_privilege('study_sprint_ci', 'auth.identities', 'SELECT') then 'ok' else 'NO' end),
  (5, 'can read storage.objects metadata', case when has_column_privilege('study_sprint_ci', 'storage.objects', 'metadata', 'SELECT') then 'yes' else 'NO' end, case when has_column_privilege('study_sprint_ci', 'storage.objects', 'metadata', 'SELECT') then 'ok' else 'NO' end),
  (6, 'can read storage.objects bucket_id', case when has_column_privilege('study_sprint_ci', 'storage.objects', 'bucket_id', 'SELECT') then 'yes' else 'NO' end, case when has_column_privilege('study_sprint_ci', 'storage.objects', 'bucket_id', 'SELECT') then 'ok' else 'NO' end),
  (7, 'can read public.sync_items, sync_usage, global_limits',
      case when has_table_privilege('study_sprint_ci', 'public.sync_items', 'SELECT') and has_table_privilege('study_sprint_ci', 'public.sync_usage', 'SELECT') and has_table_privilege('study_sprint_ci', 'public.global_limits', 'SELECT') then 'yes' else 'NO' end,
      case when has_table_privilege('study_sprint_ci', 'public.sync_items', 'SELECT') and has_table_privilege('study_sprint_ci', 'public.sync_usage', 'SELECT') and has_table_privilege('study_sprint_ci', 'public.global_limits', 'SELECT') then 'ok' else 'NO' end),
  (8, 'can write nothing (insert on sync_items)', case when has_table_privilege('study_sprint_ci', 'public.sync_items', 'INSERT') then 'NO, it can' else 'yes' end,
      case when has_table_privilege('study_sprint_ci', 'public.sync_items', 'INSERT') then 'NO' else 'ok' end)
) as status(n, what, value, result) order by n;
