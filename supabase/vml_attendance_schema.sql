-- ============================================================================
-- Vadodara Mahjong League -- attendance / slot-package tracking (additive)
-- ============================================================================
-- Every member registers and pays through the exact same flow as before
-- (register.html -> admin approval) and shows up on the leaderboard the same
-- way. The only new thing: some members ALSO buy a slot package (e.g. 20
-- physical play sessions at the lounge for Rs.5000) on top of that -- for
-- them, admin marks attendance each time they show up to play, and their
-- remaining slot count ticks down. Members who never bought a package (their
-- slots_total stays null) are completely unaffected -- no attendance UI shows
-- for them.
--
-- Safe to run against the live DB any time -- purely additive.
-- ============================================================================

-- Null = no slot package purchased (a plain leaderboard-only member).
-- Non-null = the size of the package admin assigned (toppable up any time by
-- calling vml_admin_set_slots again with a higher number).
alter table public.vml_players add column if not exists slots_total integer;

-- One row per time admin marks a member present. Remaining slots are always
-- computed as slots_total - count(*) here, rather than a separately
-- maintained decrementing counter -- avoids the counter ever drifting out of
-- sync with reality, and doubles as a visit history/audit trail for free.
create table if not exists public.vml_attendance (
  id         uuid primary key default extensions.gen_random_uuid(),
  player_id  uuid not null references public.vml_players(id) on delete cascade,
  marked_at  timestamptz not null default now(),
  marked_by  uuid not null references public.vml_players(id)
);
alter table public.vml_attendance enable row level security;
create index if not exists vml_attendance_player_idx on public.vml_attendance(player_id);

-- Admin-only: assign or top up a member's slot package. Passing a higher
-- number than before (e.g. they bought another 20) just extends how many
-- more times they can be marked present -- past attendance history is
-- untouched. Passing null removes the package entirely (member goes back to
-- being leaderboard-only, no more attendance tracking for them).
create or replace function public.vml_admin_set_slots(p_player_id uuid, p_slots_total integer) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not coalesce((select vp.is_admin from vml_players vp where vp.id = auth.uid()), false) then
    raise exception 'Admin access required';
  end if;
  if p_slots_total is not null and p_slots_total < 0 then
    raise exception 'Slots cannot be negative';
  end if;

  update vml_players set slots_total = p_slots_total where id = p_player_id;
  if not found then
    raise exception 'Player not found';
  end if;
end;
$$;
revoke all on function public.vml_admin_set_slots(uuid,integer) from public;
grant execute on function public.vml_admin_set_slots(uuid,integer) to authenticated;

-- Admin-only: mark one member present for today, returns their updated
-- remaining count so the admin page can show it immediately and decide
-- whether to fire the low-slots Telegram alert (at remaining <= 2).
--
-- Table aliased and every column qualified below (vp.name, vp.slots_total,
-- ...) because RETURNS TABLE(... name text, slots_total integer ...)
-- implicitly declares those as PL/pgSQL variables in this function's scope --
-- an unqualified reference would collide with the variable, not the table
-- column. See postgres_rls_gotchas #10 (this has bitten this project on
-- vml_bot_link_telegram already -- not repeating it here).
create or replace function public.vml_admin_mark_attendance(p_player_id uuid)
returns table(player_id uuid, name text, mobile text, slots_total integer,
              slots_used integer, slots_remaining integer)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_admin uuid := auth.uid();
  v_slots_total integer;
  v_used integer;
begin
  if not coalesce((select vp.is_admin from vml_players vp where vp.id = v_admin), false) then
    raise exception 'Admin access required';
  end if;

  select vp.slots_total into v_slots_total from vml_players vp where vp.id = p_player_id;
  if v_slots_total is null then
    raise exception 'This member has no slot package assigned yet -- set one first';
  end if;

  insert into vml_attendance (player_id, marked_by) values (p_player_id, v_admin);

  select count(*) into v_used from vml_attendance va where va.player_id = p_player_id;

  return query
  select vp.id, vp.name, vp.mobile, vp.slots_total, v_used, (vp.slots_total - v_used)
  from vml_players vp where vp.id = p_player_id;
end;
$$;
revoke all on function public.vml_admin_mark_attendance(uuid) from public;
grant execute on function public.vml_admin_mark_attendance(uuid) to authenticated;

-- Extends the existing member list with slot info so admin.html's one
-- Members table can show it inline, no separate screen needed.
-- Return type changed -- CREATE OR REPLACE can't change a function's return
-- type, so the old signature must be dropped first (see postgres_rls_gotchas
-- #9, already the established pattern in vml_schema_migration.sql).
drop function if exists public.vml_admin_member_list(text);

create or replace function public.vml_admin_member_list(p_search text default null)
returns table(id uuid, member_id text, name text, mobile text, email text,
              status text, expires_at timestamptz, is_admin boolean,
              slots_total integer, slots_remaining integer)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not coalesce((select vp.is_admin from vml_players vp where vp.id = auth.uid()), false) then
    raise exception 'Admin access required';
  end if;

  return query
  select p.id, p.member_id, p.name, p.mobile, p.email, p.status, p.expires_at, p.is_admin,
         p.slots_total,
         case when p.slots_total is null then null else p.slots_total - coalesce(att.used, 0) end
  from vml_players p
  left join (
    select va.player_id, count(*) as used from vml_attendance va group by va.player_id
  ) att on att.player_id = p.id
  where p_search is null
     or p.name ilike '%'||p_search||'%'
     or p.member_id ilike '%'||p_search||'%'
     or p.mobile ilike '%'||p_search||'%'
  order by p.registered_at desc;
end;
$$;
revoke all on function public.vml_admin_member_list(text) from public;
grant execute on function public.vml_admin_member_list(text) to authenticated;
