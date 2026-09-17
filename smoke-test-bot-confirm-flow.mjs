// Smoke test for the Telegram/WhatsApp bot match-confirmation flow.
//
// The real flow (gas/vml-telegram-bot.gs, gas/vml-whatsapp-bot.gs) has one
// player log a match via chat, then each of the other 3 independently
// confirms via their own chat session, using vml_bot_create_match /
// vml_bot_confirm_match - both granted only to service_role (the bots hold
// that secret in Apps Script PropertiesService, never in this repo). This
// is the exact "one actor seeds it, others independently confirm" shape
// that broke sportbook's mahjong score confirmations on 2026-09-17 via a
// too-narrow RLS policy.
//
// To test that shape without ever needing the service_role secret in a
// public repo, this calls anon-safe wrapper RPCs (smoke_test_vml_create_match /
// smoke_test_vml_confirm_match / smoke_test_vml_cleanup - see
// smoke-test-infra.sql) that run the identical insert/confirm/status-flip
// logic against 4 fixed, isolated __SmokeTest Player N__ accounts. Never
// touches real players or real matches.
//
// Run: node smoke-test-bot-confirm-flow.mjs
// Exit code 0 = pass, 1 = fail (Telegram alert already sent).

const SB_URL = 'https://jqqnnkzozjskziaizajg.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpxcW5ua3pvempza3ppYWl6YWpnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI5Mjk1ODAsImV4cCI6MjA4ODUwNTU4MH0.sEYeWnm0dvuw8bLSVnQhqmgV8LB-pELjpuVIa3Us1Gg';
const TELEGRAM_RELAY = 'https://telegram-notify.unigoods2026.workers.dev/';
const PLAYER_IDS = [
  'ffffffff-0000-0000-0000-000000000001',
  'ffffffff-0000-0000-0000-000000000002',
  'ffffffff-0000-0000-0000-000000000003',
  'ffffffff-0000-0000-0000-000000000004',
];

let createdMatchId = null;

function fail(step, detail) {
  throw Object.assign(new Error(`[${step}] ${detail}`), { step, detail });
}

async function rpc(name, body) {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + SB_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  return { ok: res.ok, status: res.status, data };
}

async function alertTelegram(msg) {
  try {
    await fetch(TELEGRAM_RELAY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg }),
    });
  } catch (e) {
    console.error('Telegram alert itself failed to send:', e.message);
  }
}

async function cleanup() {
  if (!createdMatchId) return;
  try {
    await rpc('smoke_test_vml_cleanup', { p_match_id: createdMatchId });
  } catch (e) {
    console.error('Cleanup failed (non-fatal):', e.message);
  }
}

async function main() {
  console.log('Creating match as smoke-test player 1 (the "creator"), scores summing to 140000...');
  const createRes = await rpc('smoke_test_vml_create_match', {
    p_scores: [40000, 35000, 35000, 30000],
    p_category: 'traditional',
  });
  if (!createRes.ok || !createRes.data || !createRes.data[0]) {
    fail('create-match', `HTTP ${createRes.status} ${JSON.stringify(createRes.data)}`);
  }
  createdMatchId = createRes.data[0].id;
  console.log('  match id:', createdMatchId, 'code:', createRes.data[0].match_code);

  console.log('Confirming as players 2, 3, 4 (each independently, matching the real bot flow)...');
  for (let i = 1; i < 4; i++) {
    const r = await rpc('smoke_test_vml_confirm_match', {
      p_match_id: createdMatchId,
      p_player_id: PLAYER_IDS[i],
    });
    if (!r.ok) fail('confirm', `player ${i + 1}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
    console.log(`  player ${i + 1} confirmed, flipped-to-confirmed=${r.data}`);
  }

  console.log('Verifying the match actually flipped to confirmed after the 3rd confirmation...');
  const checkRes = await rpc('smoke_test_vml_get_status', { p_match_id: createdMatchId });
  if (!checkRes.ok || checkRes.data !== 'confirmed') {
    fail('verify', `expected status=confirmed, got HTTP ${checkRes.status} ${JSON.stringify(checkRes.data)}`);
  }

  console.log('PASS: full bot create-match -> 3x independent-confirm -> status-flip flow works end to end.');
}

main()
  .then(async () => {
    await cleanup();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('SMOKE TEST FAILED:', err.message);
    await alertTelegram(
      `🚨 <b>Vadodara Mahjong League smoke test FAILED</b>\n\nStep: ${err.step || 'unknown'}\nDetail: ${err.detail || err.message}\n\nThe real Telegram/WhatsApp bot match-confirmation flow is likely broken for real players right now.`
    );
    await cleanup();
    process.exit(1);
  });
