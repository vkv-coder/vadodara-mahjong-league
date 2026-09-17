-- Dedicated, isolated fixtures + RPCs for the automated bot-confirm-match
-- smoke test (smoke-test-bot-confirm-flow.mjs). Mirrors the real
-- vml_bot_create_match / vml_bot_confirm_match flow (the Telegram/WhatsApp
-- bots' "one player logs it, other 3 each confirm via chat" sequence -
-- same shape as the RLS bug that broke sportbook's mahjong score
-- confirmations on 2026-09-17).
--
-- The real bot RPCs are granted only to service_role (the bots hold that
-- secret via Apps Script PropertiesService) - deliberately NOT reused here,
-- since that key must never be embedded in a public repo's smoke test
-- script. Instead this creates narrow, anon-safe wrapper RPCs that run the
-- exact same insert/confirm logic against 4 fixed, isolated test players,
-- so the smoke test can run with only the public anon key while still
-- exercising the real table/constraint/status-flip behavior.
--
-- vml_players.id has a FK to auth.users(id), so each fixture player needs
-- a matching (minimal, login-less) auth.users row too.

insert into auth.users (id)
values
  ('ffffffff-0000-0000-0000-000000000001'),
  ('ffffffff-0000-0000-0000-000000000002'),
  ('ffffffff-0000-0000-0000-000000000003'),
  ('ffffffff-0000-0000-0000-000000000004')
on conflict (id) do nothing;

insert into vml_players (id, name, mobile, email, status, expires_at, member_id)
values
  ('ffffffff-0000-0000-0000-000000000001', '__SmokeTest Player 1__', '8888800001', 'smoketest1@invalid.local', 'active', now() + interval '1 year', 'SMOKE001'),
  ('ffffffff-0000-0000-0000-000000000002', '__SmokeTest Player 2__', '8888800002', 'smoketest2@invalid.local', 'active', now() + interval '1 year', 'SMOKE002'),
  ('ffffffff-0000-0000-0000-000000000003', '__SmokeTest Player 3__', '8888800003', 'smoketest3@invalid.local', 'active', now() + interval '1 year', 'SMOKE003'),
  ('ffffffff-0000-0000-0000-000000000004', '__SmokeTest Player 4__', '8888800004', 'smoketest4@invalid.local', 'active', now() + interval '1 year', 'SMOKE004')
on conflict (id) do nothing;

create or replace function public.smoke_test_vml_create_match(p_scores integer[], p_category text default 'traditional')
returns table(id uuid, match_code text)
language plpgsql
security definer
set search_path = public, extensions
as $function$
declare
  v_ids uuid[] := array[
    'ffffffff-0000-0000-0000-000000000001'::uuid,
    'ffffffff-0000-0000-0000-000000000002'::uuid,
    'ffffffff-0000-0000-0000-000000000003'::uuid,
    'ffffffff-0000-0000-0000-000000000004'::uuid
  ];
  v_match_id uuid;
  v_match_code text;
begin
  if array_length(p_scores,1) <> 4 then
    raise exception 'Need exactly 4 scores';
  end if;

  v_match_id := extensions.gen_random_uuid();
  v_match_code := 'SMOKE' || to_char(now(), 'HH24MISS');

  insert into vml_matches (id, match_code, created_by, category, match_date, status)
  values (v_match_id, v_match_code, v_ids[1], p_category, current_date, 'pending_confirm');

  insert into vml_match_entries (match_id, player_id, score, rank_points)
  select v_match_id, pid, sc,
    case dense_rank() over (order by sc desc)
      when 1 then 30 when 2 then 20 when 3 then 10 else 5
    end
  from unnest(v_ids, p_scores) as t(pid, sc);

  return query select v_match_id, v_match_code;
end;
$function$;

create or replace function public.smoke_test_vml_confirm_match(p_match_id uuid, p_player_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $function$
declare
  v_test_ids uuid[] := array[
    'ffffffff-0000-0000-0000-000000000001'::uuid,
    'ffffffff-0000-0000-0000-000000000002'::uuid,
    'ffffffff-0000-0000-0000-000000000003'::uuid,
    'ffffffff-0000-0000-0000-000000000004'::uuid
  ];
  v_creator uuid;
  v_status text;
  v_is_participant boolean;
  v_confirm_count integer;
begin
  if p_player_id <> all(v_test_ids) then
    raise exception 'smoke_test_vml_confirm_match: not a smoke-test player id';
  end if;

  select created_by, status into v_creator, v_status from vml_matches where id = p_match_id;
  if v_creator is null then raise exception 'Match not found'; end if;
  if v_creator <> all(v_test_ids) then
    raise exception 'smoke_test_vml_confirm_match: refusing to act on a non-smoke-test match';
  end if;
  if v_status <> 'pending_confirm' then
    raise exception 'Match is not awaiting confirmation (status: %)', v_status;
  end if;
  if p_player_id = v_creator then
    raise exception 'The match creator does not confirm their own match';
  end if;

  select exists(select 1 from vml_match_entries where match_id = p_match_id and player_id = p_player_id)
    into v_is_participant;
  if not v_is_participant then
    raise exception 'You are not a participant in this match';
  end if;

  insert into vml_match_confirmations (match_id, player_id)
  values (p_match_id, p_player_id)
  on conflict (match_id, player_id) do nothing;

  select count(*) into v_confirm_count from vml_match_confirmations where match_id = p_match_id;

  if v_confirm_count >= 3 then
    update vml_matches set status = 'confirmed' where id = p_match_id;
    return true;
  end if;
  return false;
end;
$function$;

create or replace function public.smoke_test_vml_cleanup(p_match_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $function$
declare
  v_test_ids uuid[] := array[
    'ffffffff-0000-0000-0000-000000000001'::uuid,
    'ffffffff-0000-0000-0000-000000000002'::uuid,
    'ffffffff-0000-0000-0000-000000000003'::uuid,
    'ffffffff-0000-0000-0000-000000000004'::uuid
  ];
  v_bad_count integer;
begin
  select count(*) into v_bad_count
  from vml_match_entries
  where match_id = p_match_id and player_id <> all(v_test_ids);

  if v_bad_count > 0 or not exists (select 1 from vml_matches where id = p_match_id) then
    raise exception 'smoke_test_vml_cleanup: refusing to delete a non-smoke-test match';
  end if;

  delete from vml_match_confirmations where match_id = p_match_id;
  delete from vml_match_entries where match_id = p_match_id;
  delete from vml_matches where id = p_match_id;
end;
$function$;

create or replace function public.smoke_test_vml_get_status(p_match_id uuid)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $function$
declare
  v_test_ids uuid[] := array[
    'ffffffff-0000-0000-0000-000000000001'::uuid,
    'ffffffff-0000-0000-0000-000000000002'::uuid,
    'ffffffff-0000-0000-0000-000000000003'::uuid,
    'ffffffff-0000-0000-0000-000000000004'::uuid
  ];
  v_status text;
begin
  select status into v_status
  from vml_matches
  where id = p_match_id and created_by = any(v_test_ids);

  return v_status;
end;
$function$;

grant execute on function public.smoke_test_vml_create_match(integer[], text) to anon, authenticated;
grant execute on function public.smoke_test_vml_confirm_match(uuid, uuid) to anon, authenticated;
grant execute on function public.smoke_test_vml_cleanup(uuid) to anon, authenticated;
grant execute on function public.smoke_test_vml_get_status(uuid) to anon, authenticated;
