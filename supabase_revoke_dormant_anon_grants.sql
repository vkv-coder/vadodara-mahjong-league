-- ============================================================================
-- vadodara-mahjong-league — document removal of dormant anon grants
-- ============================================================================
-- Already applied directly against the live database. Committed here purely
-- as a record of what changed — safe to re-run, no-op if already revoked.
--
-- CONTEXT
--   A monthly Supabase RLS/RPC audit (2026-10) swept both Supabase projects
--   for tables where the `anon` role held a raw table GRANT (SELECT/INSERT/
--   UPDATE/DELETE) with no RLS policy actually covering that privilege for
--   anon. In Postgres, that combination is inert the moment it happens —
--   with RLS enabled and no matching policy, the role sees/affects zero
--   rows regardless of the grant. But it's a landmine: if a permissive
--   policy for anon/public is ever added later without someone checking
--   existing grants, the table becomes fully exposed with no further step
--   needed. Every instance below was confirmed dormant (live curl tests
--   with the anon key, before and after) before revoking.
--
--   Note: this app currently has zero RLS policies defined on any vml_
--   table at all (by design -- access goes through the bot/service-role
--   path, not anon/authenticated REST calls), so these grants were
--   100% unused in every case, not just unmatched by a specific policy.
--
--   Separate from this dormant-grant cleanup, the same audit found
--   vml_handle_payment (a Razorpay-webhook-shaped RPC with no caller
--   verification) EXECUTE-granted to anon/authenticated. Razorpay isn't
--   wired up live yet (register.html passes p_razorpay_order_ref: null),
--   so this wasn't exploitable yet, but was revoked preemptively before
--   payment goes live. Not duplicated here since it's an EXECUTE grant
--   on a function, not a table grant.
-- ============================================================================

REVOKE DELETE, INSERT, SELECT, UPDATE ON public.vml_attendance FROM anon;
REVOKE DELETE, INSERT, SELECT, UPDATE ON public.vml_bot_sessions FROM anon;
REVOKE DELETE, INSERT, SELECT, UPDATE ON public.vml_global_member_counter FROM anon;
REVOKE DELETE, INSERT, SELECT, UPDATE ON public.vml_match_confirmations FROM anon;
REVOKE DELETE, INSERT, SELECT, UPDATE ON public.vml_match_entries FROM anon;
REVOKE DELETE, INSERT, SELECT, UPDATE ON public.vml_matches FROM anon;
REVOKE DELETE, INSERT, SELECT, UPDATE ON public.vml_member_id_counters FROM anon;
REVOKE DELETE, INSERT, SELECT, UPDATE ON public.vml_players FROM anon;
