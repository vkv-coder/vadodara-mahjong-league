-- ============================================================================
-- Vadodara Mahjong League -- Telegram bot backend (additive)
-- ============================================================================
-- Same match-logging/confirm/dispute logic as the WhatsApp bot
-- (vml_whatsapp_bot_schema.sql) -- this file does NOT duplicate any of
-- vml_bot_lookup_by_id / vml_bot_create_match / vml_bot_confirm_match /
-- vml_bot_reject_match. Telegram identifies a chat by a numeric chat_id
-- instead of a phone number, so the only new thing needed is a one-time
-- link from a Telegram chat_id to the player's existing mobile number --
-- after that, the Telegram bot calls the exact same *_mobile RPCs the
-- WhatsApp bot uses, passing the mobile it resolved from the link.
--
-- Safe to run against the live DB any time -- purely additive. Nothing
-- goes live until gas/vml-telegram-bot.gs is deployed and its webhook is
-- registered with Telegram.
-- ============================================================================

alter table public.vml_players add column if not exists telegram_id text;

-- A player could in theory link twice (e.g. re-links from a new Telegram
-- account) -- this partial unique index prevents two DIFFERENT active
-- players ending up mapped to the same chat_id, which would let one
-- Telegram account impersonate another member.
create unique index if not exists vml_players_telegram_id_key
  on public.vml_players (telegram_id) where telegram_id is not null;

-- One-time link: player sends their mobile number to the bot, bot calls
-- this with the Telegram chat_id. Re-linking (e.g. new phone) just
-- overwrites the old chat_id -- the unique index above still protects
-- against collisions with a DIFFERENT member's mobile.
create or replace function public.vml_bot_link_telegram(p_mobile text, p_telegram_id text)
returns table(member_id text, name text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid;
begin
  select id into v_id from vml_players
  where mobile = p_mobile and status = 'active' and expires_at > now() and member_id is not null;
  if v_id is null then
    raise exception 'No active VML member found with that mobile number';
  end if;

  update vml_players set telegram_id = p_telegram_id where id = v_id;

  return query select vp.member_id, vp.name from vml_players vp where vp.id = v_id;
end;
$$;
revoke all on function public.vml_bot_link_telegram(text,text) from public;
grant execute on function public.vml_bot_link_telegram(text,text) to service_role;

-- Resolve an inbound Telegram chat_id to the linked active member --
-- Telegram equivalent of vml_bot_lookup_by_mobile. Returns the player's
-- mobile too, since every existing vml_bot_* match RPC is mobile-identified
-- and the Telegram bot re-uses them unchanged.
create or replace function public.vml_bot_lookup_by_telegram(p_telegram_id text)
returns table(id uuid, member_id text, name text, mobile text)
language sql
security definer
set search_path = public, extensions
stable
as $$
  select id, member_id, name, mobile from vml_players
  where telegram_id = p_telegram_id and status = 'active' and expires_at > now() and member_id is not null;
$$;
revoke all on function public.vml_bot_lookup_by_telegram(text) from public;
grant execute on function public.vml_bot_lookup_by_telegram(text) to service_role;

-- Used by the Telegram bot to decide whether a match participant can be
-- pinged for confirmation (Telegram, unlike WhatsApp, can only message
-- chat_ids that have messaged the bot before -- there's no template/cold-push
-- path). Looked up by player id (uuid), which vml_bot_create_match already
-- returns per row.
create or replace function public.vml_bot_get_telegram_id(p_player_id uuid)
returns text
language sql
security definer
set search_path = public, extensions
stable
as $$
  select telegram_id from vml_players where id = p_player_id;
$$;
revoke all on function public.vml_bot_get_telegram_id(uuid) from public;
grant execute on function public.vml_bot_get_telegram_id(uuid) to service_role;
