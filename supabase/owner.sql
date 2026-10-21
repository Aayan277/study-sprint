-- Study Sprint, for the project owner only: who is using how much?
-- Run it in your Supabase project (SQL Editor → New query → paste → Run) whenever you want to look. Run limits.sql first.
--
-- It is a plain question, not something saved in the database, so there is nothing for the app or for signed-in people
-- to read: only you, in the SQL Editor, can run it. (That is on purpose. Please don't turn it into a view in the
-- "public" schema: anything there can be read from the app.)
--
-- One line per person, biggest users first:
--   email, joined, last_sign_in       from Authentication → Users
--   data_rows / data_rows_limit       how many synced records (cards, reviews, settings) they have, and their cap
--   data_mb / data_limit_mb           how much space those records take, and their limit
--   media_mb / media_limit_mb         how much their pictures and sounds take, and their limit
--   data_pct / media_pct              how full each of the two is, in percent
--   marker_rows / marker_mb           how many of their records are deleted ones (a deleted card leaves a small empty "marker" behind), and the space those take
--   dead_mdel_rows                    their picture-deletion marks ("mdel:" settings) that are no longer needed (value null or "gone")
--   marker_pct                        the larger of markers / row cap and marker space / data limit, in percent (about 15 or more: see docs/design/prune-plan.md)
-- (Data rows and bytes come from the sync_usage table that limits.sql keeps up to date; if a number ever looks wrong,
-- run select public.recount_sync_usage(); once to recount everybody, and select public.recount_media_usage(); for pictures.)
-- At the very bottom is a second small question: the two project-wide totals against their ceilings (the "fuses").
-- (This file only asks questions, so unlike the other scripts it doesn't add a line to the SQL log.)
-- The limits are the default unless you gave that person a row in the quotas table (docs/sync-setup.md).
select
  u.email,
  u.created_at::date                                       as joined,
  u.last_sign_in_at::date                                  as last_sign_in,
  coalesce(d.rows, 0)                                      as data_rows,
  public._rows_limit(u.id)                                 as data_rows_limit,
  round(coalesce(d.bytes, 0) / 1048576.0, 1)               as data_mb,
  round(public._data_limit(u.id) / 1048576.0, 1)           as data_limit_mb,
  round(100.0 * coalesce(d.bytes, 0) / nullif(public._data_limit(u.id), 0), 1)   as data_pct,
  round(coalesce(m.bytes, 0) / 1048576.0, 1)               as media_mb,
  round(public._media_limit(u.id) / 1048576.0, 1)          as media_limit_mb,
  round(100.0 * coalesce(m.bytes, 0) / nullif(public._media_limit(u.id), 0), 1)  as media_pct,
  coalesce(k.marker_rows, 0)                               as marker_rows,
  round(coalesce(k.marker_bytes, 0) / 1048576.0, 1)        as marker_mb,
  coalesce(k.dead_mdel_rows, 0)                            as dead_mdel_rows,
  round(greatest(100.0 * coalesce(k.marker_rows, 0) / nullif(public._rows_limit(u.id), 0),
                 100.0 * coalesce(k.marker_bytes, 0) / nullif(public._data_limit(u.id), 0)), 1) as marker_pct
from auth.users u
left join public.sync_usage d on d.user_id = u.id
left join (
  -- Same size as the data columns count (200 + twice the id + the data), written out so this also works before limits.sql.
  -- The app saves a setting as {"value": ...}; a picture mark is a time, or null (not marked) or "gone" (swept).
  select s.user_id,
         count(*) filter (where s.deleted)                                                      as marker_rows,
         sum(200 + 2 * octet_length(s.id) + greatest(coalesce(octet_length(s.data::text), 0), coalesce(pg_column_size((s.data::text)::jsonb), 0))) filter (where s.deleted) as marker_bytes,
         count(*) filter (where s.store = 'settings' and s.id like 'mdel:%' and s.data -> 'value' in ('null'::jsonb, '"gone"'::jsonb)) as dead_mdel_rows
  from public.sync_items s
  group by 1
) k on k.user_id = u.id
left join (
  -- Each person's files sit in a folder named after their user id.
  select split_part(o.name, '/', 1) as folder, sum((o.metadata ->> 'size')::bigint) as bytes
  from storage.objects o
  where o.bucket_id = 'media'
  group by 1
) m on m.folder = u.id::text
order by coalesce(d.bytes, 0) + coalesce(m.bytes, 0) desc;

-- The project-wide totals against their ceilings (change a ceiling in Table Editor → global_limits). It adds up the same tables
-- the totals are made from, so it also works on a project that still has the older scripts.
select g.name as fuse,
       round(case g.name when 'sync' then (select coalesce(sum(u.bytes), 0) from public.sync_usage u)
                         else (select coalesce(sum((o.metadata ->> 'size')::bigint), 0) from storage.objects o where o.bucket_id = 'media') end / 1048576.0, 1) as used_mb,
       round(g.bytes / 1048576.0, 1) as ceiling_mb,
       round(100.0 * case g.name when 'sync' then (select coalesce(sum(u.bytes), 0) from public.sync_usage u)
                         else (select coalesce(sum((o.metadata ->> 'size')::bigint), 0) from storage.objects o where o.bucket_id = 'media') end / nullif(g.bytes, 0), 1) as pct
from public.global_limits g
order by g.name;
