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
-- (Data rows and bytes come from the sync_usage table that limits.sql keeps up to date; if a number ever looks wrong,
-- run select public.recount_sync_usage(); once to recount everybody.)
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
  round(100.0 * coalesce(m.bytes, 0) / nullif(public._media_limit(u.id), 0), 1)  as media_pct
from auth.users u
left join public.sync_usage d on d.user_id = u.id
left join (
  -- Each person's files sit in a folder named after their user id.
  select split_part(o.name, '/', 1) as folder, sum((o.metadata ->> 'size')::bigint) as bytes
  from storage.objects o
  where o.bucket_id = 'media'
  group by 1
) m on m.folder = u.id::text
order by coalesce(d.bytes, 0) + coalesce(m.bytes, 0) desc;
