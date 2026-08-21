-- ============================================================================
-- Vadodara Mahjong League (VML) — schema, RLS, and RPCs
-- Runs in the existing shared Supabase project (jqqnnkzozjskziaizajg).
-- All vml_* tables have RLS enabled with NO policies — every read and write
-- goes through a SECURITY DEFINER RPC below. anon/authenticated get no direct
-- table access at all (matches the audit-driven pattern used across every
-- other app in this project — see postgres_rls_gotchas memory).
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

-- ----------------------------------------------------------------------------
-- Tables
-- ----------------------------------------------------------------------------

create table if not exists public.vml_players (
  id                  uuid primary key references auth.users(id) on delete cascade,
  member_id           text unique,
  name                text not null,
  mobile              text not null,
  email               text not null,
  status              text not null default 'pending_payment'
                        check (status in ('pending_payment','pending_approval','active','rejected')),
  is_admin            boolean not null default false,
  registered_at       timestamptz not null default now(),
  expires_at          timestamptz,
  razorpay_payment_id text,
  razorpay_order_ref  text,
  created_at          timestamptz not null default now()
);

create index if not exists vml_players_order_ref_idx on public.vml_players(razorpay_order_ref);

create sequence if not exists public.vml_member_seq start 1;

create table if not exists public.vml_matches (
  id               uuid primary key default extensions.gen_random_uuid(),
  created_by       uuid not null references public.vml_players(id),
  category         text not null check (category in ('traditional','taiwanese')),
  match_date       date not null default current_date,
  status           text not null default 'pending_confirm'
                     check (status in ('pending_confirm','confirmed','rejected')),
  rejected_reason  text,
  created_at       timestamptz not null default now()
);

create table if not exists public.vml_match_entries (
  id           uuid primary key default extensions.gen_random_uuid(),
  match_id     uuid not null references public.vml_matches(id) on delete cascade,
  player_id    uuid not null references public.vml_players(id),
  score        integer not null,
  rank_points  integer not null,
  unique(match_id, player_id)
);

create table if not exists public.vml_match_confirmations (
  id            uuid primary key default extensions.gen_random_uuid(),
  match_id      uuid not null references public.vml_matches(id) on delete cascade,
  player_id     uuid not null references public.vml_players(id),
  confirmed_at  timestamptz not null default now(),
  unique(match_id, player_id)
);

alter table public.vml_players enable row level security;
alter table public.vml_matches enable row level security;
alter table public.vml_match_entries enable row level security;
alter table public.vml_match_confirmations enable row level security;

-- ============================================================================
-- Registration / payment / approval RPCs
-- ============================================================================

-- Called right before Razorpay checkout opens. Caller must already have a
-- real auth.users row (sign up with email+password first).
create or replace function public.vml_register_player(
  p_name text, p_mobile text, p_email text, p_razorpay_order_ref text
) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_existing_status text;
begin
  if v_uid is null then
    raise exception 'Must be signed in to register';
  end if;

  select status into v_existing_status from vml_players where id = v_uid;

  if v_existing_status is not null and v_existing_status <> 'pending_payment' then
    raise exception 'Already registered (status: %)', v_existing_status;
  end if;

  insert into vml_players (id, name, mobile, email, status, razorpay_order_ref, registered_at)
  values (v_uid, p_name, p_mobile, p_email, 'pending_payment', p_razorpay_order_ref, now())
  on conflict (id) do update
    set name = excluded.name,
        mobile = excluded.mobile,
        email = excluded.email,
        razorpay_order_ref = excluded.razorpay_order_ref;
end;
$$;

revoke all on function public.vml_register_player(text,text,text,text) from public;
grant execute on function public.vml_register_player(text,text,text,text) to authenticated;

-- Called by an already-active member starting a renewal payment, so the
-- webhook has an order_ref to match against.
create or replace function public.vml_start_renewal(p_razorpay_order_ref text) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  update vml_players
    set razorpay_order_ref = p_razorpay_order_ref
    where id = auth.uid() and status = 'active';

  if not found then
    raise exception 'Not an active member';
  end if;
end;
$$;

revoke all on function public.vml_start_renewal(text) from public;
grant execute on function public.vml_start_renewal(text) to authenticated;

-- Called ONLY by the Apps Script Razorpay-webhook relay (service_role key).
-- Handles both a fresh registration payment (pending_payment -> pending_approval)
-- and a renewal payment (active -> expires_at pushed forward 1 year), branching
-- on the player's current status so one webhook handler covers both cases.
create or replace function public.vml_handle_payment(
  p_razorpay_order_ref text, p_razorpay_payment_id text
) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid;
  v_status text;
begin
  select id, status into v_id, v_status
  from vml_players where razorpay_order_ref = p_razorpay_order_ref;

  if v_id is null then
    raise exception 'No player found for order_ref %', p_razorpay_order_ref;
  end if;

  if v_status = 'pending_payment' then
    update vml_players
      set status = 'pending_approval', razorpay_payment_id = p_razorpay_payment_id
      where id = v_id;
  elsif v_status = 'active' then
    update vml_players
      set expires_at = now() + interval '1 year', razorpay_payment_id = p_razorpay_payment_id
      where id = v_id;
  else
    raise exception 'Player % in unexpected status % for a payment webhook', v_id, v_status;
  end if;
end;
$$;

revoke all on function public.vml_handle_payment(text,text) from public;
grant execute on function public.vml_handle_payment(text,text) to service_role;

-- Admin-only: assigns the sequential member_id and activates the player.
create or replace function public.vml_approve_player(p_player_id uuid) returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_is_admin boolean;
  v_member_id text;
  v_status text;
begin
  select is_admin into v_is_admin from vml_players where id = auth.uid();
  if not coalesce(v_is_admin, false) then
    raise exception 'Admin access required';
  end if;

  select status into v_status from vml_players where id = p_player_id;
  if v_status is null then
    raise exception 'Player not found';
  end if;
  if v_status <> 'pending_approval' then
    raise exception 'Player is not pending approval (status: %)', v_status;
  end if;

  v_member_id := 'VML' || lpad(nextval('vml_member_seq')::text, 4, '0');

  update vml_players
    set status = 'active',
        member_id = v_member_id,
        expires_at = now() + interval '1 year'
    where id = p_player_id;

  return v_member_id;
end;
$$;

revoke all on function public.vml_approve_player(uuid) from public;
grant execute on function public.vml_approve_player(uuid) to authenticated;

-- Admin-only: rejects a pending registration.
create or replace function public.vml_reject_player(p_player_id uuid) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_is_admin boolean;
begin
  select is_admin into v_is_admin from vml_players where id = auth.uid();
  if not coalesce(v_is_admin, false) then
    raise exception 'Admin access required';
  end if;

  update vml_players set status = 'rejected'
  where id = p_player_id and status = 'pending_approval';

  if not found then
    raise exception 'Player not found or not pending approval';
  end if;
end;
$$;

revoke all on function public.vml_reject_player(uuid) from public;
grant execute on function public.vml_reject_player(uuid) to authenticated;

-- ============================================================================
-- Match logging / confirmation RPCs
-- ============================================================================

-- p_player_ids / p_scores are parallel 4-element arrays; auth.uid() must be
-- one of the 4 players (the creator plays in and reports their own match).
-- Raw scores must sum to the fixed pool total for the category (140000 for
-- traditional, 2040 for taiwanese); rank_points (30/20/10/5) are computed
-- server-side from the score order, never accepted as client input.
create or replace function public.vml_create_match(
  p_player_ids uuid[], p_scores integer[], p_category text, p_match_date date default current_date
) returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_match_id uuid;
  v_pool_total integer;
  v_sum integer;
  v_active_count integer;
  v_match_date date := coalesce(p_match_date, current_date);
begin
  if v_uid is null then
    raise exception 'Must be signed in';
  end if;

  if p_category not in ('traditional','taiwanese') then
    raise exception 'Invalid category %', p_category;
  end if;

  if v_match_date > current_date then
    raise exception 'Match date cannot be in the future';
  end if;

  if array_length(p_player_ids,1) <> 4 or array_length(p_scores,1) <> 4 then
    raise exception 'Exactly 4 players and 4 scores are required';
  end if;

  if (select count(distinct x) from unnest(p_player_ids) x) <> 4 then
    raise exception 'Player IDs must be 4 distinct members';
  end if;

  if not (v_uid = any(p_player_ids)) then
    raise exception 'You must be one of the 4 players in the match you log';
  end if;

  select count(*) into v_active_count
  from vml_players
  where id = any(p_player_ids) and status = 'active' and expires_at > now();

  if v_active_count <> 4 then
    raise exception 'All 4 players must be active, non-expired members';
  end if;

  v_pool_total := case p_category when 'traditional' then 140000 else 2040 end;
  select sum(s) into v_sum from unnest(p_scores) s;
  if v_sum <> v_pool_total then
    raise exception 'Scores must sum to % for % matches (got %)', v_pool_total, p_category, v_sum;
  end if;

  v_match_id := extensions.gen_random_uuid();

  insert into vml_matches (id, created_by, category, match_date, status)
  values (v_match_id, v_uid, p_category, v_match_date, 'pending_confirm');

  insert into vml_match_entries (match_id, player_id, score, rank_points)
  select v_match_id, pid, sc,
    case dense_rank() over (order by sc desc)
      when 1 then 30 when 2 then 20 when 3 then 10 else 5
    end
  from unnest(p_player_ids, p_scores) as t(pid, sc);

  return v_match_id;
end;
$$;

revoke all on function public.vml_create_match(uuid[],integer[],text,date) from public;
grant execute on function public.vml_create_match(uuid[],integer[],text,date) to authenticated;

-- A non-creator participant confirms. Once 3 of 3 have confirmed, the match
-- flips to 'confirmed' and is picked up by the public leaderboard.
create or replace function public.vml_confirm_match(p_match_id uuid) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_creator uuid;
  v_status text;
  v_is_participant boolean;
  v_confirm_count integer;
begin
  if v_uid is null then raise exception 'Must be signed in'; end if;

  select created_by, status into v_creator, v_status from vml_matches where id = p_match_id;
  if v_creator is null then raise exception 'Match not found'; end if;
  if v_status <> 'pending_confirm' then
    raise exception 'Match is not awaiting confirmation (status: %)', v_status;
  end if;
  if v_uid = v_creator then
    raise exception 'The match creator does not confirm their own match';
  end if;

  select exists(select 1 from vml_match_entries where match_id = p_match_id and player_id = v_uid)
    into v_is_participant;
  if not v_is_participant then
    raise exception 'You are not a participant in this match';
  end if;

  insert into vml_match_confirmations (match_id, player_id)
  values (p_match_id, v_uid)
  on conflict (match_id, player_id) do nothing;

  select count(*) into v_confirm_count from vml_match_confirmations where match_id = p_match_id;

  if v_confirm_count >= 3 then
    update vml_matches set status = 'confirmed' where id = p_match_id;
  end if;
end;
$$;

revoke all on function public.vml_confirm_match(uuid) from public;
grant execute on function public.vml_confirm_match(uuid) to authenticated;

-- Any participant (including the creator) can dispute instead of confirming.
create or replace function public.vml_reject_match(p_match_id uuid, p_reason text default null) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_creator uuid;
  v_status text;
  v_is_participant boolean;
begin
  if v_uid is null then raise exception 'Must be signed in'; end if;

  select created_by, status into v_creator, v_status from vml_matches where id = p_match_id;
  if v_creator is null then raise exception 'Match not found'; end if;
  if v_status <> 'pending_confirm' then
    raise exception 'Match is not awaiting confirmation (status: %)', v_status;
  end if;

  select exists(select 1 from vml_match_entries where match_id = p_match_id and player_id = v_uid)
    into v_is_participant;
  if not (v_is_participant or v_uid = v_creator) then
    raise exception 'You are not part of this match';
  end if;

  update vml_matches set status = 'rejected', rejected_reason = p_reason where id = p_match_id;
end;
$$;

revoke all on function public.vml_reject_match(uuid,text) from public;
grant execute on function public.vml_reject_match(uuid,text) to authenticated;

-- ============================================================================
-- Read RPCs
-- ============================================================================

-- Public, no auth required: the leaderboard itself. Only ever exposes
-- member_id/name/points/games — never email/mobile/payment fields.
create or replace function public.vml_public_leaderboard(p_category text)
returns table(member_id text, name text, points bigint, games bigint)
language sql
security definer
set search_path = public, extensions
stable
as $$
  select p.member_id, p.name,
         coalesce(sum(e.rank_points), 0)::bigint as points,
         count(e.id)::bigint as games
  from vml_players p
  join vml_match_entries e on e.player_id = p.id
  join vml_matches m on m.id = e.match_id and m.status = 'confirmed' and m.category = p_category
  where p.status = 'active' and p.expires_at > now()
  group by p.member_id, p.name
  order by points desc;
$$;

revoke all on function public.vml_public_leaderboard(text) from public;
grant execute on function public.vml_public_leaderboard(text) to anon, authenticated;

-- Looks up an active member by their member_id (used when adding the other
-- 3 players to a match by ID).
create or replace function public.vml_lookup_member(p_member_id text)
returns table(id uuid, name text)
language sql
security definer
set search_path = public, extensions
stable
as $$
  select id, name from vml_players
  where member_id = p_member_id and status = 'active' and expires_at > now();
$$;

revoke all on function public.vml_lookup_member(text) from public;
grant execute on function public.vml_lookup_member(text) to authenticated;

-- Caller's own profile.
create or replace function public.vml_my_profile()
returns table(id uuid, member_id text, name text, email text, mobile text,
              status text, is_admin boolean, expires_at timestamptz)
language sql
security definer
set search_path = public, extensions
stable
as $$
  select id, member_id, name, email, mobile, status, is_admin, expires_at
  from vml_players where id = auth.uid();
$$;

revoke all on function public.vml_my_profile() from public;
grant execute on function public.vml_my_profile() to authenticated;

-- Matches awaiting the caller's own confirmation.
create or replace function public.vml_my_pending_confirmations()
returns table(match_id uuid, category text, match_date date, creator_name text, created_at timestamptz)
language sql
security definer
set search_path = public, extensions
stable
as $$
  select m.id, m.category, m.match_date, cr.name, m.created_at
  from vml_matches m
  join vml_match_entries e on e.match_id = m.id and e.player_id = auth.uid()
  join vml_players cr on cr.id = m.created_by
  where m.status = 'pending_confirm'
    and m.created_by <> auth.uid()
    and not exists (
      select 1 from vml_match_confirmations c
      where c.match_id = m.id and c.player_id = auth.uid()
    )
  order by m.created_at desc;
$$;

revoke all on function public.vml_my_pending_confirmations() from public;
grant execute on function public.vml_my_pending_confirmations() to authenticated;

-- Full entry list + per-player confirmation status for one match; only
-- visible to the match's own 4 participants.
create or replace function public.vml_match_detail(p_match_id uuid)
returns table(player_id uuid, member_id text, name text, score integer,
              rank_points integer, confirmed boolean)
language sql
security definer
set search_path = public, extensions
stable
as $$
  select e.player_id, p.member_id, p.name, e.score, e.rank_points,
         exists(select 1 from vml_match_confirmations c
                where c.match_id = p_match_id and c.player_id = e.player_id) as confirmed
  from vml_match_entries e
  join vml_players p on p.id = e.player_id
  where e.match_id = p_match_id
    and exists (
      select 1 from vml_match_entries e2
      where e2.match_id = p_match_id and e2.player_id = auth.uid()
    );
$$;

revoke all on function public.vml_match_detail(uuid) from public;
grant execute on function public.vml_match_detail(uuid) to authenticated;

-- Admin-only: pending registrations queue.
create or replace function public.vml_admin_pending_registrations()
returns table(id uuid, name text, mobile text, email text,
              registered_at timestamptz, razorpay_payment_id text)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not coalesce((select is_admin from vml_players where id = auth.uid()), false) then
    raise exception 'Admin access required';
  end if;

  return query
  select p.id, p.name, p.mobile, p.email, p.registered_at, p.razorpay_payment_id
  from vml_players p
  where p.status = 'pending_approval'
  order by p.registered_at asc;
end;
$$;

revoke all on function public.vml_admin_pending_registrations() from public;
grant execute on function public.vml_admin_pending_registrations() to authenticated;

-- Admin-only: member list/search.
create or replace function public.vml_admin_member_list(p_search text default null)
returns table(id uuid, member_id text, name text, mobile text, email text,
              status text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not coalesce((select is_admin from vml_players where id = auth.uid()), false) then
    raise exception 'Admin access required';
  end if;

  return query
  select p.id, p.member_id, p.name, p.mobile, p.email, p.status, p.expires_at
  from vml_players p
  where p_search is null
     or p.name ilike '%'||p_search||'%'
     or p.member_id ilike '%'||p_search||'%'
     or p.mobile ilike '%'||p_search||'%'
  order by p.registered_at desc;
end;
$$;

revoke all on function public.vml_admin_member_list(text) from public;
grant execute on function public.vml_admin_member_list(text) to authenticated;

-- Admin-only: matches under dispute, for visibility.
create or replace function public.vml_admin_rejected_matches()
returns table(match_id uuid, category text, match_date date, creator_name text,
              rejected_reason text, created_at timestamptz)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not coalesce((select is_admin from vml_players where id = auth.uid()), false) then
    raise exception 'Admin access required';
  end if;

  return query
  select m.id, m.category, m.match_date, p.name, m.rejected_reason, m.created_at
  from vml_matches m
  join vml_players p on p.id = m.created_by
  where m.status = 'rejected'
  order by m.created_at desc;
end;
$$;

revoke all on function public.vml_admin_rejected_matches() from public;
grant execute on function public.vml_admin_rejected_matches() to authenticated;

-- ============================================================================
-- One-time setup: promote the first admin manually after this migration runs,
-- e.g.:
--   update public.vml_players set is_admin = true where email = 'vijay@...';
-- (there is deliberately no RPC for this — the very first admin has to be
-- set directly in the SQL editor; vml_approve_player etc. can only be called
-- by someone who is *already* is_admin = true)
-- ============================================================================
