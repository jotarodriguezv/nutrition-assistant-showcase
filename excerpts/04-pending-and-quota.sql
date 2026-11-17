-- EXCERPT 04 — Pending entries (atomic state machine) and the daily AI quota, in Postgres.
--
-- What this shows: the state transitions live in the database, not in the edge function, so they are
-- atomic and testable in a rolled-back transaction. The function only calls them.
--   · One pending entry per user (food OR water). A new estimate replaces the previous one: that is
--     what happens when the user corrects ("it was 3 eggs") or changes their mind.
--   · A pending entry expires after 3 hours (the original n8n workflow kept 1 hour of memory in
--     Redis and lost the context).
--   · A per-user advisory lock serializes concurrent messages, so two quick messages cannot create
--     two pending rows or confirm twice.
--   · The meal type (breakfast / lunch / dinner) is the user's word if they said it, otherwise it is
--     decided HERE from the user's local clock, never in application code or by the model.
--   · The daily quota is checked and consumed atomically BEFORE calling the model; the day is the
--     user's local day, computed in the database.
--   · Every function is `security definer` with a fixed search_path, execute revoked from public,
--     and granted only to the service role. Tables have RLS enabled and no policies.
-- Source: two migrations of the production database (trimmed; table and column names simplified and
-- translated). The real schema, the milestone logic (50/75/100% of the daily goal) and the photo-scan
-- quota are omitted. Not runnable as-is.

-- ── Pending entry ──────────────────────────────────────────────────────────────────
create function save_pending_entry(p_user uuid, p_estimate jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid; v_zone text; v_hour time;
begin
  perform pg_advisory_xact_lock(hashtextextended('pending:' || p_user::text, 0));

  -- Only one pending entry per user: the new one replaces the old one.
  delete from meals  where user_id = p_user and status = 'pending';
  delete from waters where user_id = p_user and status = 'pending';

  if p_estimate->>'type' = 'food' then
    select u.time_zone into v_zone from users u where u.id = p_user;
    if not found then raise exception 'Unknown user %', p_user; end if;
    v_hour := (now() at time zone coalesce(v_zone, 'UTC'))::time;

    insert into meals (user_id, description, calories, protein_g, carbs_g, fat_g, meal_type)
    values (
      p_user, p_estimate->>'description', (p_estimate->>'calories')::int,
      (p_estimate->>'protein_g')::int, (p_estimate->>'carbs_g')::int, (p_estimate->>'fat_g')::int,
      coalesce(nullif(p_estimate->>'meal_type', ''), case                  -- user's word first
        when v_hour >= time '04:00' and v_hour < time '09:00' then 'breakfast'
        when v_hour >= time '11:00' and v_hour < time '14:00' then 'lunch'
        when v_hour >= time '18:00' and v_hour < time '20:00' then 'dinner'
      end))                                                                -- otherwise left empty
    returning id into v_id;
  elsif p_estimate->>'type' = 'water' then
    insert into waters (user_id, description, amount_ml)
    values (p_user, p_estimate->>'description', (p_estimate->>'water_ml')::int)
    returning id into v_id;
  else
    raise exception 'Invalid type';
  end if;
  return v_id;
end $$;

-- Confirm or cancel the pending entry. Returns nothing if there was none (expired, or another
-- message resolved it an instant earlier), so the caller can answer "nothing pending".
create function resolve_pending_entry(p_user uuid, p_action text)
returns table (kind text, description text, calories integer, amount_ml integer)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_kind text; v_id uuid;
begin
  if p_action not in ('confirm', 'cancel') then raise exception 'Invalid action'; end if;
  perform pg_advisory_xact_lock(hashtextextended('pending:' || p_user::text, 0));

  select p.kind, p.id into v_kind, v_id from get_pending_entry(p_user) p;  -- also sweeps entries older than 3 h
  if v_id is null then return; end if;

  if v_kind = 'food' and p_action = 'confirm' then
    return query with x as (update meals set status = 'confirmed' where id = v_id returning description, calories)
                 select 'food'::text, x.description, x.calories, null::integer from x;
  elsif v_kind = 'food' then
    return query with x as (delete from meals where id = v_id returning description, calories)
                 select 'food'::text, x.description, x.calories, null::integer from x;
  -- … the same two branches for water (omitted)
  end if;
end $$;

-- ── Daily AI quota ─────────────────────────────────────────────────────────────────
create table ai_usage (
  user_id uuid not null references users(id) on delete cascade,
  day     date not null,
  kind    text not null check (kind in ('text', 'audio', 'photo')),
  count   integer not null default 0 check (count >= 0),
  primary key (user_id, day, kind)
);
alter table ai_usage enable row level security;                    -- RLS on, no policies
revoke all on table ai_usage from public, anon, authenticated;
grant select, insert, update on ai_usage to service_role;

create function reserve_estimate(p_user uuid, p_kind text)
returns table (allowed boolean, used integer, daily_limit integer)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_day date := (now() at time zone 'UTC')::date;                  -- the real one uses the user's zone
  v_limit integer; v_used integer;
begin
  if p_kind is null or p_kind not in ('text', 'audio', 'photo') then raise exception 'Invalid kind'; end if;
  perform pg_advisory_xact_lock(hashtextextended('quota:' || p_user::text, 0));
  select s.daily_limit into strict v_limit from settings s;
  select coalesce(sum(count), 0)::integer into v_used from ai_usage where user_id = p_user and day = v_day;
  if v_used >= v_limit then return query select false, v_used, v_limit; return; end if;
  insert into ai_usage as a (user_id, day, kind, count) values (p_user, v_day, p_kind, 1)
    on conflict (user_id, day, kind) do update set count = a.count + 1;
  return query select true, v_used + 1, v_limit;
end $$;

revoke all on function reserve_estimate(uuid, text) from public, anon, authenticated;
grant execute on function reserve_estimate(uuid, text) to service_role;
