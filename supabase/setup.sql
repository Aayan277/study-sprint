-- Study Sprint sync: run this once in your Supabase project (SQL Editor → New query → paste → Run).
-- It's safe to run again: it only creates what's missing.
--
-- One table holds everything that syncs. Each row is one record from the app:
--   store       which kind: decks, cards, cardStates, reviewLog or settings
--   id          the record's id in the app (a review's uid, a setting's name)
--   data        the record itself, or null once it's deleted
--   updated_at  when the record last changed on a device (ms). The newest change wins.
--   seq         a counter the server bumps on every change, so a device can ask "what changed since I last looked?"
-- Row Level Security means every signed-in person can only ever see and change their own rows.

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
create policy "own rows: read"   on public.sync_items for select using (user_id = auth.uid());
create policy "own rows: add"    on public.sync_items for insert with check (user_id = auth.uid());
create policy "own rows: change" on public.sync_items for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own rows: delete" on public.sync_items for delete using (user_id = auth.uid());

-- On every change: keep the newer version if an older one arrives late, and bump seq so other devices pick it up.
create or replace function public.sync_items_on_change() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.updated_at < old.updated_at then
    return null;                       -- an older change: ignore it
  end if;
  new.seq := nextval('public.sync_seq');
  return new;
end;
$$;

drop trigger if exists sync_items_on_change on public.sync_items;
create trigger sync_items_on_change
  before insert or update on public.sync_items
  for each row execute function public.sync_items_on_change();
