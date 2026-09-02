-- ============================================================================
-- Vadodara Mahjong League -- WhatsApp bot backend (additive)
-- ============================================================================
-- Nothing here touches the existing web app flow (vml_create_match still
-- auto-confirms, dashboard.html/index.html/leaderboard.html are unchanged).
-- This is a parallel input path: a player never opens the app, they message
-- a WhatsApp bot number instead. The bot's webhook (gas/vml-whatsapp-bot.gs)
-- calls these functions with the service_role key, never the anon key --
-- they trust a raw phone number as identity (WhatsApp's own platform already
-- verified the sender's number at delivery time), so they must NEVER be
-- reachable by anon/authenticated clients.
--
-- Safe to run this against the live DB any time -- it only adds new,
-- currently-unused objects. Nothing goes live until a real WhatsApp Business
-- number is wired to the webhook.
-- ============================================================================

-- One row per phone number mid-conversation with the bot (e.g. "waiting for
-- player 3's score"). RLS enabled, zero policies -- only the service_role
-- key (which bypasses RLS) ever touches this table, same pattern as every
-- other table in this project.
create table if not exists public.vml_bot_sessions (
  mobile     text primary key,
  state      text not null,
  draft      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.vml_bot_sessions enable row level security;

-- Resolve an inbound WhatsApp sender to an active member.
create or replace function public.vml_bot_lookup_by_mobile(p_mobile text)
returns table(id uuid, member_id text, name text, mobile text)
language sql
security definer
set search_path = public, extensions
stable
as $$
  select id, member_id, name, mobile from vml_players
  where mobile = p_mobile and status = 'active' and expires_at > now() and member_id is not null;
$$;
revoke all on function public.vml_bot_lookup_by_mobile(text) from public;
grant execute on function public.vml_bot_lookup_by_mobile(text) to service_role;

-- Resolve a member ID the creator typed (e.g. "A001") to a player, including
-- their mobile number -- needed so the bot knows where to send the
-- confirmation-request message.
create or replace function public.vml_bot_lookup_by_id(p_member_id text)
returns table(id uuid, member_id text, name text, mobile text)
language sql
security definer
set search_path = public, extensions
stable
as $$
  select id, member_id, name, mobile from vml_players
  where member_id = p_member_id and status = 'active' and expires_at > now();
$$;
revoke all on function public.vml_bot_lookup_by_id(text) from public;
grant execute on function public.vml_bot_lookup_by_id(text) to service_role;

-- Phone-identified equivalent of vml_create_match. Same validation (4
-- distinct active members, scores sum to the exact pool total), but the
-- creator is identified by their WhatsApp number instead of a Supabase Auth
-- session, and it always inserts as 'pending_confirm' -- the bot keeps the
-- 3-of-3 confirmation step players already know from IML, unlike the
-- trust-based web flow.
--
-- p_member_ids must be exactly the OTHER 3 players' member IDs, in the same
-- order as p_scores[2..4]; p_scores[1] is the creator's own score.
create or replace function public.vml_bot_create_match(
  p_creator_mobile text, p_member_ids text[], p_scores integer[],
  p_category text, p_match_date date default current_date
) returns table(match_id uuid, match_code text, player_id uuid, member_id text,
                 name text, mobile text, score integer, rank_points integer, is_creator boolean)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_creator_id uuid;
  v_p2_id uuid;
  v_p3_id uuid;
  v_p4_id uuid;
  v_all_ids uuid[];
  v_match_id uuid;
  v_match_code text;
  v_code_chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_pool_total integer;
  v_sum integer;
  v_match_date date := coalesce(p_match_date, current_date);
  i integer;
begin
  if p_category not in ('traditional','taiwanese') then
    raise exception 'Invalid category %', p_category;
  end if;
  if v_match_date > current_date then
    raise exception 'Match date cannot be in the future';
  end if;
  if array_length(p_member_ids,1) <> 3 or array_length(p_scores,1) <> 4 then
    raise exception 'Need the other 3 player IDs and all 4 scores';
  end if;

  select vp.id into v_creator_id from vml_players vp
  where vp.mobile = p_creator_mobile and vp.status = 'active' and vp.expires_at > now() and vp.member_id is not null;
  if v_creator_id is null then
    raise exception 'This WhatsApp number is not a recognized active member';
  end if;

  select vp.id into v_p2_id from vml_players vp
  where vp.member_id = p_member_ids[1] and vp.status = 'active' and vp.expires_at > now();
  if v_p2_id is null then raise exception 'Member ID % not found or not active', p_member_ids[1]; end if;

  select vp.id into v_p3_id from vml_players vp
  where vp.member_id = p_member_ids[2] and vp.status = 'active' and vp.expires_at > now();
  if v_p3_id is null then raise exception 'Member ID % not found or not active', p_member_ids[2]; end if;

  select vp.id into v_p4_id from vml_players vp
  where vp.member_id = p_member_ids[3] and vp.status = 'active' and vp.expires_at > now();
  if v_p4_id is null then raise exception 'Member ID % not found or not active', p_member_ids[3]; end if;

  -- Positional order matches p_scores: [creator, p2, p3, p4]. Deliberately
  -- NOT built via array_agg(... where member_id = any(...)) -- that doesn't
  -- preserve input order, which would silently mismatch scores to players.
  v_all_ids := array[v_creator_id, v_p2_id, v_p3_id, v_p4_id];

  if (select count(distinct x) from unnest(v_all_ids) x) <> 4 then
    raise exception 'Player IDs must be 4 distinct members (check you didn''t include your own ID)';
  end if;

  v_pool_total := case p_category when 'traditional' then 140000 else 2040 end;
  select sum(s) into v_sum from unnest(p_scores) s;
  if v_sum <> v_pool_total then
    raise exception 'Scores must sum to % for % matches (got %)', v_pool_total, p_category, v_sum;
  end if;

  v_match_id := extensions.gen_random_uuid();
  loop
    v_match_code := '';
    for i in 1..5 loop
      v_match_code := v_match_code || substr(v_code_chars, 1 + floor(random() * length(v_code_chars))::int, 1);
    end loop;
    exit when not exists (select 1 from vml_matches m where m.match_code = v_match_code);
  end loop;

  insert into vml_matches (id, match_code, created_by, category, match_date, status)
  values (v_match_id, v_match_code, v_creator_id, p_category, v_match_date, 'pending_confirm');

  insert into vml_match_entries (match_id, player_id, score, rank_points)
  select v_match_id, pid, sc,
    case dense_rank() over (order by sc desc)
      when 1 then 30 when 2 then 20 when 3 then 10 else 5
    end
  from unnest(v_all_ids, p_scores) as t(pid, sc);

  return query
  select v_match_id, v_match_code, vp.id, vp.member_id, vp.name, vp.mobile, e.score, e.rank_points,
         (vp.id = v_creator_id)
  from vml_match_entries e
  join vml_players vp on vp.id = e.player_id
  where e.match_id = v_match_id
  order by e.rank_points desc;
end;
$$;
revoke all on function public.vml_bot_create_match(text,text[],integer[],text,date) from public;
grant execute on function public.vml_bot_create_match(text,text[],integer[],text,date) to service_role;

-- Phone-identified equivalent of vml_confirm_match. Returns true if this
-- confirmation was the 3rd (i.e. the match just flipped to 'confirmed') so
-- the bot can send a nicer "match is now live!" reply.
create or replace function public.vml_bot_confirm_match(p_match_id uuid, p_mobile text) returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_player_id uuid;
  v_creator uuid;
  v_status text;
  v_is_participant boolean;
  v_confirm_count integer;
begin
  select vp.id into v_player_id from vml_players vp
  where vp.mobile = p_mobile and vp.status = 'active' and vp.expires_at > now();
  if v_player_id is null then
    raise exception 'This WhatsApp number is not a recognized active member';
  end if;

  select created_by, status into v_creator, v_status from vml_matches where id = p_match_id;
  if v_creator is null then raise exception 'Match not found'; end if;
  if v_status <> 'pending_confirm' then
    raise exception 'Match is not awaiting confirmation (status: %)', v_status;
  end if;
  if v_player_id = v_creator then
    raise exception 'The match creator does not confirm their own match';
  end if;

  select exists(select 1 from vml_match_entries where match_id = p_match_id and player_id = v_player_id)
    into v_is_participant;
  if not v_is_participant then
    raise exception 'You are not a participant in this match';
  end if;

  insert into vml_match_confirmations (match_id, player_id)
  values (p_match_id, v_player_id)
  on conflict (match_id, player_id) do nothing;

  select count(*) into v_confirm_count from vml_match_confirmations where match_id = p_match_id;

  if v_confirm_count >= 3 then
    update vml_matches set status = 'confirmed' where id = p_match_id;
    return true;
  end if;
  return false;
end;
$$;
revoke all on function public.vml_bot_confirm_match(uuid,text) from public;
grant execute on function public.vml_bot_confirm_match(uuid,text) to service_role;

-- Phone-identified equivalent of vml_reject_match.
create or replace function public.vml_bot_reject_match(p_match_id uuid, p_mobile text, p_reason text default null) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_player_id uuid;
  v_creator uuid;
  v_status text;
  v_is_participant boolean;
begin
  select vp.id into v_player_id from vml_players vp
  where vp.mobile = p_mobile and vp.status = 'active' and vp.expires_at > now();
  if v_player_id is null then
    raise exception 'This WhatsApp number is not a recognized active member';
  end if;

  select created_by, status into v_creator, v_status from vml_matches where id = p_match_id;
  if v_creator is null then raise exception 'Match not found'; end if;
  if v_status <> 'pending_confirm' then
    raise exception 'Match is not awaiting confirmation (status: %)', v_status;
  end if;

  select exists(select 1 from vml_match_entries where match_id = p_match_id and player_id = v_player_id)
    into v_is_participant;
  if not v_is_participant then
    raise exception 'You are not a participant in this match';
  end if;

  update vml_matches set status = 'rejected', rejected_reason = p_reason where id = p_match_id;
end;
$$;
revoke all on function public.vml_bot_reject_match(uuid,text,text) from public;
grant execute on function public.vml_bot_reject_match(uuid,text,text) to service_role;
