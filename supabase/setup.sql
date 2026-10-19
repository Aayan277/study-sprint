-- Study Sprint sync: run this once in your Supabase project (SQL Editor → New query → paste → Run).
-- It's safe to run again: it only creates what's missing. (SQL schema version 2: see "SQL changes log" in docs/sync-setup.md.)
--
-- One table holds everything that syncs. Each row is one record from the app:
--   store       which kind: decks, cards, cardStates, reviewLog or settings
--   id          the record's id in the app (a review's uid, a setting's name)
--   data        the record itself, or null once it's deleted
--   updated_at  when the record last changed on a device (ms). The newest change wins.
--   seq         a counter the server bumps on every change, so a device can ask "what changed since I last looked?"
-- Row Level Security means every signed-in person can only ever see and change their own rows.

-- A small private log of which SQL file ran, and when (every file adds a line). Nothing in the app can read it.
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

create sequence if not exists public.sync_seq;

create table if not exists public.sync_items (
  user_id    uuid    not null default auth.uid() references auth.users (id) on delete cascade,
  store      text    not null check (store in ('decks', 'cards', 'cardStates', 'reviewLog', 'settings')),
  id         text    not null,
  data       jsonb,
  deleted    boolean not null default false,
  updated_at bigint  not null,
  seq        bigint  not null default nextval('public.sync_seq'),
  primary key (user_id, store, id)
);

create index if not exists sync_items_changes on public.sync_items (user_id, seq);

alter table public.sync_items enable row level security;

drop policy if exists "own rows: read" on public.sync_items;
drop policy if exists "own rows: add" on public.sync_items;
drop policy if exists "own rows: change" on public.sync_items;
drop policy if exists "own rows: delete" on public.sync_items;
-- (select auth.uid()) is worked out once per query, not once per row: much faster on big accounts.
create policy "own rows: read"   on public.sync_items for select using (user_id = (select auth.uid()));
create policy "own rows: add"    on public.sync_items for insert with check (user_id = (select auth.uid()));
create policy "own rows: change" on public.sync_items for update using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own rows: delete" on public.sync_items for delete using (user_id = (select auth.uid()));

-- On every change: keep the newer version if an older (or identical) one arrives, and bump seq so other devices
-- pick it up.
--   * An equal timestamp is ignored too (<=), so sending everything again after a sign-in doesn't make every
--     other device download everything again.
--   * updated_at is capped at the server's time plus one day, so a device whose clock is far in the future
--     can't win every conflict forever.
create or replace function public.sync_items_on_change() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := least(new.updated_at, (extract(epoch from now()) * 1000)::bigint + 86400000);
  if tg_op = 'UPDATE' and new.updated_at <= old.updated_at then
    return null;                       -- an older or identical change: ignore it
  end if;
  new.seq := nextval('public.sync_seq');
  return new;
end;
$$;

drop trigger if exists sync_items_on_change on public.sync_items;
create trigger sync_items_on_change
  before insert or update on public.sync_items
  for each row execute function public.sync_items_on_change();

-- Who may do what. The app only ever signs in, so only "authenticated" needs the table, and only to read, add, change
-- and delete rows (the rules above still limit that to its own rows). Everything else is taken away, including
-- TRUNCATE (which skips the row rules), TRIGGER and REFERENCES, and everything for anon (a visitor who isn't signed in).
revoke all on public.sync_items from anon, authenticated;
grant select, insert, update, delete on public.sync_items to authenticated;
revoke all on sequence public.sync_seq from anon, authenticated;
grant usage on sequence public.sync_seq to authenticated;       -- the default value of "seq" and the trigger use it
revoke all on function public.sync_items_on_change() from public, anon, authenticated;     -- (a trigger function: nobody calls it directly)

insert into private.schema_log (file, version) values ('setup.sql', 2);

-- Status: every line should say ok.
select * from (values
  (1, 'sync_items table with row rules', (select count(*) from pg_policies where schemaname = 'public' and tablename = 'sync_items')::text || ' rules',
      case when (select count(*) from pg_policies where schemaname = 'public' and tablename = 'sync_items') = 4 then 'ok' else 'NO: expected 4 rules' end),
  (2, 'visitors who are not signed in can read sync_items', case when has_table_privilege('anon', 'public.sync_items', 'SELECT') then 'yes' else 'no' end,
      case when has_table_privilege('anon', 'public.sync_items', 'SELECT') then 'NO: should be no' else 'ok' end)
) as status(n, what, value, result) order by n;
