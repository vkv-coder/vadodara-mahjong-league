/**
 * Vadodara Mahjong League -- Telegram bot (score logging + confirmation)
 *
 * Same conversation shape and RPCs as gas/vml-whatsapp-bot.gs, ported to
 * Telegram. Telegram needs no business verification, no per-message
 * billing, and no approved message template -- so this is far simpler to
 * get live than the WhatsApp version. The one real difference: Telegram
 * bots can ONLY message a chat_id that has messaged the bot at least once
 * (no cold-push to a phone number like WhatsApp's template path). So every
 * player -- not just whoever logs a match -- must open the bot and send
 * /start once before they can be notified for a confirmation. finalizeMatch
 * below tells the creator by name if a teammate hasn't linked yet.
 *
 * ---- Deploy ----
 * script.google.com > New project > paste this file > Deploy > New
 * deployment > Web app > Execute as: Me > Who has access: Anyone.
 * Any future code change requires Deploy > Manage deployments > edit the
 * active deployment > "New version" > Deploy -- saving alone does NOT
 * update the live /exec URL.
 *
 * ---- Script Properties (Project Settings > Script Properties) ----
 *   SUPABASE_URL                  e.g. https://jqqnnkzozjskziaizajg.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY     service_role key (never expose client-side)
 *   TELEGRAM_BOT_TOKEN            from @BotFather
 *   ADMIN_CHAT_ID                 your own Telegram chat id -- bot-crash
 *                                 alerts only, not a club contact
 *
 * ---- Wiring (no Meta-style verification handshake needed) ----
 * After deploying, register the webhook by opening this URL once in any
 * browser (fill in your real token and the /exec URL from the deploy step):
 *   https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=<EXEC_URL>&drop_pending_updates=true
 * Verify it took: https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo
 *
 * ---- Supabase ----
 * Run supabase/vml_telegram_bot_schema.sql first -- adds vml_players.telegram_id
 * plus vml_bot_link_telegram / vml_bot_lookup_by_telegram / vml_bot_get_telegram_id.
 * Everything else (vml_bot_lookup_by_id, vml_bot_create_match,
 * vml_bot_confirm_match, vml_bot_reject_match) already exists from the
 * WhatsApp bot's schema and is reused here unchanged.
 */

var STATE_LINK = 'awaiting_mobile_link';
var STATE_CATEGORY = 'awaiting_category';
var STATE_SCORES = 'awaiting_scores';
var STATE_CONFIRM = 'awaiting_final_confirm';
var SESSION_EXPIRY_MINUTES = 30;

// ---------------------------------------------------------------------------
// Telegram webhook entry points
// ---------------------------------------------------------------------------

function doGet(e) {
  return ContentService.createTextOutput('VML Telegram bot is live.');
}

function doPost(e) {
  var chatIdForError = null;
  try {
    var update = JSON.parse(e.postData.contents);
    if (update.message) {
      chatIdForError = update.message.chat.id;
      handleMessage(update.message);
    } else if (update.callback_query) {
      chatIdForError = update.callback_query.message.chat.id;
      handleCallback(update.callback_query);
    }
  } catch (err) {
    Logger.log('doPost error: ' + err);
    try {
      var cfg = getConfig();
      var debugMsg = '⚠️ VML bot error:\n' + err;
      if (chatIdForError) directSend(cfg.TELEGRAM_BOT_TOKEN, chatIdForError, debugMsg);
      if (cfg.ADMIN_CHAT_ID) directSend(cfg.TELEGRAM_BOT_TOKEN, cfg.ADMIN_CHAT_ID, debugMsg);
    } catch (err2) {
      Logger.log('Failed to report error: ' + err2);
    }
  }
  // HtmlService, not ContentService -- ContentService responses can
  // 302-redirect, which some webhook senders follow and re-deliver the
  // same update a second time. See apps_script_redirect_bug memory.
  return HtmlService.createHtmlOutput('ok');
}

function getConfig() {
  var p = PropertiesService.getScriptProperties();
  return {
    SUPABASE_URL: p.getProperty('SUPABASE_URL'),
    SUPABASE_KEY: p.getProperty('SUPABASE_SERVICE_ROLE_KEY'),
    TELEGRAM_BOT_TOKEN: p.getProperty('TELEGRAM_BOT_TOKEN'),
    ADMIN_CHAT_ID: p.getProperty('ADMIN_CHAT_ID')
  };
}

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

function handleMessage(msg) {
  var chatId = msg.chat.id;

  // Telegram's verified "share phone number" button -- the number comes
  // from Telegram's own platform, same trust model as WhatsApp's "from".
  if (msg.contact && msg.contact.phone_number) {
    linkViaMobile(chatId, msg.contact.phone_number, true);
    return;
  }

  var text = (msg.text || '').trim();
  if (!text) return;

  if (text.indexOf('/start') === 0) { handleStart(chatId); return; }

  var linked = getLinkedMember(chatId);
  if (!linked) { linkViaMobile(chatId, text, false); return; }

  var sessKey = tgKey(chatId);

  if (text.toUpperCase() === 'CANCEL' || text === '/cancel') {
    var existingSession = getSession(sessKey);
    if (existingSession) {
      deleteSession(sessKey);
      tgSendText(chatId, 'Cancelled.');
    } else {
      tgSendText(chatId, 'Nothing in progress.');
    }
    return;
  }

  var session = getSession(sessKey);
  if (!session || sessionExpired(session)) {
    startNewMatchFlow(chatId, linked);
    return;
  }

  advanceMatchFlow(chatId, linked, session, text);
}

// ---------------------------------------------------------------------------
// Account linking (Telegram chat_id -> vml_players.mobile)
// ---------------------------------------------------------------------------

function handleStart(chatId) {
  var linked = getLinkedMember(chatId);
  if (linked) {
    tgSendText(chatId, "You're already linked as " + linked.name + " (" + linked.member_id + ").\nSend any message to log a new match.");
    return;
  }
  tgSend(chatId, 'Welcome to the Vadodara Mahjong League score bot!\n\nTap below to link your account, or just type your registered mobile number.', {
    keyboard: [[{ text: '📱 Share my phone number', request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true
  });
}

function linkViaMobile(chatId, rawMobile, viaContactShare) {
  var mobile = normalizeIndianMobile(rawMobile.replace(/\D/g, ''));
  if (!mobile) {
    tgSendText(chatId, 'Please send your registered mobile number to link your account.');
    return;
  }
  try {
    var result = callSupabaseRpc('vml_bot_link_telegram', { p_mobile: mobile, p_telegram_id: String(chatId) })[0];
    tgSend(chatId, 'Linked successfully! Welcome ' + result.name + ' (' + result.member_id + ').\nSend any message to log a new match.', { remove_keyboard: true });
  } catch (err) {
    var hint = viaContactShare
      ? "That number isn't a recognized active VML member. If you registered with a different number, just type it here instead."
      : "That number isn't a recognized active VML member. Please check and re-send.";
    tgSendText(chatId, '⚠️ ' + hint + ' Contact avanipatel0701@gmail.com if this seems wrong.');
  }
}

function getLinkedMember(chatId) {
  var rows = callSupabaseRpc('vml_bot_lookup_by_telegram', { p_telegram_id: String(chatId) });
  return (rows && rows.length) ? rows[0] : null;
}

// ---------------------------------------------------------------------------
// Match-logging conversation (creator side)
// ---------------------------------------------------------------------------

var SCORES_PROMPT = "Now send all 4 players' Member ID and score, one per line, including your own -- e.g.:\nA001 1005\nA007 398\nA025 390\nA008 247";

function startNewMatchFlow(chatId, linked) {
  setState(tgKey(chatId), STATE_CATEGORY, { my_member_id: linked.member_id, my_name: linked.name });
  tgSend(chatId, 'Logging a new match. What category did you play?', inlineKeyboard([
    [{ text: '🀄 Traditional', callback_data: 'cat_traditional' }, { text: '🏆 Taiwanese', callback_data: 'cat_taiwanese' }]
  ]));
}

function advanceMatchFlow(chatId, linked, session, text) {
  var draft = session.draft || {};
  var lower = text.toLowerCase();

  if (session.state === STATE_CATEGORY) {
    var category = (lower === '1' || lower.indexOf('trad') === 0) ? 'traditional'
                  : (lower === '2' || lower.indexOf('taiw') === 0) ? 'taiwanese' : null;
    if (!category) {
      tgSend(chatId, 'Please choose a category using the buttons.', inlineKeyboard([
        [{ text: '🀄 Traditional', callback_data: 'cat_traditional' }, { text: '🏆 Taiwanese', callback_data: 'cat_taiwanese' }]
      ]));
      return;
    }
    draft.category = category;
    setState(tgKey(chatId), STATE_SCORES, draft);
    tgSendText(chatId, SCORES_PROMPT);
    return;
  }

  if (session.state === STATE_SCORES) {
    var pairs = parseScoreLines(text);
    if (!pairs) {
      tgSendText(chatId, "Couldn't read that. " + SCORES_PROMPT);
      return;
    }
    var mine = pairs.filter(function (p) { return p.id === draft.my_member_id; });
    if (mine.length !== 1) {
      tgSendText(chatId, 'Include your own ID (' + draft.my_member_id + ') exactly once, with your own score. ' + SCORES_PROMPT);
      return;
    }
    var others = pairs.filter(function (p) { return p.id !== draft.my_member_id; });
    previewMatch(chatId, draft, mine[0].score, others);
    return;
  }
}

// Looks up each typed ID's real name before anything is submitted, so a
// typo (wrong-but-valid ID) shows up as an unexpected name here instead of
// silently logging a match against the wrong person.
function previewMatch(chatId, draft, myScore, others) {
  var resolvedOthers = [];
  for (var i = 0; i < others.length; i++) {
    var member = callSupabaseRpc('vml_bot_lookup_by_id', { p_member_id: others[i].id })[0];
    if (!member) {
      tgSendText(chatId, 'Member ID ' + others[i].id + " isn't a recognized active member. " + SCORES_PROMPT);
      return;
    }
    resolvedOthers.push({ id: others[i].id, name: member.name, score: others[i].score });
  }

  setState(tgKey(chatId), STATE_CONFIRM, {
    category: draft.category,
    my_member_id: draft.my_member_id,
    my_name: draft.my_name,
    my_score: myScore,
    others: resolvedOthers
  });

  var lines = [draft.my_member_id + ' - ' + draft.my_name + ' - ' + myScore + ' (you)']
    .concat(resolvedOthers.map(function (p) { return p.id + ' - ' + p.name + ' - ' + p.score; }));

  tgSend(chatId, 'Please confirm this is correct:\n' + lines.join('\n'), inlineKeyboard([
    [{ text: '✅ Yes, submit', callback_data: 'submitmatch' }, { text: '✏️ Re-enter', callback_data: 'redoscores' }]
  ]));
}

function submitConfirmedMatch(chatId, linked) {
  var session = getSession(tgKey(chatId));
  if (!session || session.state !== STATE_CONFIRM || sessionExpired(session)) {
    tgSendText(chatId, 'That confirmation has expired -- send any message to start logging a match again.');
    return;
  }
  var draft = session.draft;
  finalizeMatch(chatId, linked, draft.category, draft.my_score, draft.others);
}

// Accepts one "ID score" pair per line, or comma-separated on one line.
function parseScoreLines(text) {
  var raw = text.replace(/\r/g, '');
  var chunks = raw.indexOf('\n') >= 0 ? raw.split('\n') : raw.split(',');
  var pairs = [];
  for (var i = 0; i < chunks.length; i++) {
    var chunk = chunks[i].trim();
    if (!chunk) continue;
    var m = chunk.match(/^([A-Za-z]\d{1,4})[\s,:-]+(\d+)$/);
    if (!m) return null;
    pairs.push({ id: m[1].toUpperCase(), score: parseInt(m[2], 10) });
  }
  return pairs.length === 4 ? pairs : null;
}

function finalizeMatch(chatId, linked, category, myScore, others) {
  var rows;
  try {
    rows = callSupabaseRpc('vml_bot_create_match', {
      p_creator_mobile: linked.mobile,
      p_member_ids: [others[0].id, others[1].id, others[2].id],
      p_scores: [myScore, others[0].score, others[1].score, others[2].score],
      p_category: category
    });
  } catch (err) {
    deleteSession(tgKey(chatId));
    tgSendText(chatId, '⚠️ ' + err.message + '\n\nSend any message to start over.');
    return;
  }

  deleteSession(tgKey(chatId));
  var matchCode = rows[0].match_code;
  var creatorRow = rows.filter(function (r) { return r.is_creator; })[0];
  var otherRows = rows.filter(function (r) { return !r.is_creator; });

  var notified = [];
  var notLinked = [];
  otherRows.forEach(function (p) {
    var theirChatId = callSupabaseRpc('vml_bot_get_telegram_id', { p_player_id: p.player_id });
    if (theirChatId) {
      sendConfirmRequest(theirChatId, matchCode, p.match_id, creatorRow.name, p.score, p.rank_points);
      notified.push(p.name);
    } else {
      notLinked.push(p.name);
    }
  });

  var summary = '✅ Match logged! Code ' + matchCode + ' -- you scored ' + creatorRow.score + ' (' + creatorRow.rank_points + ' pts).';
  if (notified.length) summary += '\nWaiting for ' + notified.join(', ') + ' to confirm.';
  if (notLinked.length) summary += '\n⚠️ ' + notLinked.join(', ') + " haven't connected this bot yet, so they weren't notified -- ask them to message the bot and send /start.";
  tgSendText(chatId, summary);
}

// ---------------------------------------------------------------------------
// Confirm / dispute (the other 3 players)
// ---------------------------------------------------------------------------

function sendConfirmRequest(toChatId, matchCode, matchId, creatorName, score, rankPoints) {
  tgSend(toChatId, creatorName + ' logged a match (code ' + matchCode + '): you scored ' + score + ' (' + rankPoints + ' pts).\n\nDo you confirm?', inlineKeyboard([
    [{ text: '✅ Confirm', callback_data: 'confirm:' + matchId }, { text: '❌ Dispute', callback_data: 'reject:' + matchId }]
  ]));
}

function handleCallback(cq) {
  var chatId = cq.message.chat.id;
  var linked = getLinkedMember(chatId);
  if (!linked) { answerCallback(cq.id, 'Please link your account first -- send /start.'); return; }

  var parts = cq.data.split(':');
  var action = parts[0];
  var matchId = parts[1];

  if (action === 'cat_traditional' || action === 'cat_taiwanese') {
    var catSession = getSession(tgKey(chatId));
    if (!catSession || sessionExpired(catSession)) { answerCallback(cq.id, 'Expired'); startNewMatchFlow(chatId, linked); return; }
    answerCallback(cq.id, 'Selected');
    advanceMatchFlow(chatId, linked, catSession, action === 'cat_traditional' ? 'traditional' : 'taiwanese');
    return;
  }

  if (action === 'submitmatch') {
    answerCallback(cq.id, '');
    submitConfirmedMatch(chatId, linked);
    return;
  }

  if (action === 'redoscores') {
    answerCallback(cq.id, '');
    var redoSession = getSession(tgKey(chatId));
    var redoDraft = (redoSession && redoSession.draft) || {};
    setState(tgKey(chatId), STATE_SCORES, { category: redoDraft.category, my_member_id: redoDraft.my_member_id, my_name: redoDraft.my_name });
    tgSendText(chatId, SCORES_PROMPT);
    return;
  }

  if (!matchId) { answerCallback(cq.id, ''); return; }

  if (action === 'confirm') {
    try {
      var justCompleted = callSupabaseRpc('vml_bot_confirm_match', { p_match_id: matchId, p_mobile: linked.mobile });
      answerCallback(cq.id, 'Confirmed');
      tgSendText(chatId, justCompleted
        ? '✅ Confirmed! All 3 players have now confirmed -- this match is live on the leaderboard.'
        : "✅ Thanks, you've confirmed this match. Waiting on the remaining player(s).");
    } catch (err) {
      answerCallback(cq.id, 'Error');
      tgSendText(chatId, '⚠️ ' + err.message);
    }
    return;
  }

  if (action === 'reject') {
    // Don't dispute on the first tap -- easy to hit by mistake, and it
    // can't be undone once submitted. Ask once more before it's final.
    answerCallback(cq.id, '');
    tgSend(chatId, "⚠️ Are you sure you want to dispute this match? This can't be undone.", inlineKeyboard([
      [{ text: '❌ Yes, dispute', callback_data: 'rejectyes:' + matchId }, { text: 'Cancel', callback_data: 'rejectno:' + matchId }]
    ]));
    return;
  }

  if (action === 'rejectyes') {
    try {
      callSupabaseRpc('vml_bot_reject_match', { p_match_id: matchId, p_mobile: linked.mobile, p_reason: null });
      answerCallback(cq.id, 'Disputed');
      tgSendText(chatId, "You've disputed this match. The player who logged it has been notified.");
      notifyCreatorOfDispute(matchId);
    } catch (err) {
      answerCallback(cq.id, 'Error');
      tgSendText(chatId, '⚠️ ' + err.message);
    }
    return;
  }

  if (action === 'rejectno') {
    answerCallback(cq.id, 'Cancelled');
    tgSendText(chatId, 'Okay, not disputed.');
    return;
  }
}

function notifyCreatorOfDispute(matchId) {
  var match = callSupabaseRest('vml_matches?id=eq.' + matchId + '&select=created_by,match_code')[0];
  if (!match) return;
  var creator = callSupabaseRest('vml_players?id=eq.' + match.created_by + '&select=telegram_id')[0];
  if (!creator || !creator.telegram_id) return;
  tgSendText(creator.telegram_id, 'Your match ' + match.match_code + ' was disputed by a player. You can log it again with corrected scores.');
}

// ---------------------------------------------------------------------------
// Session storage (Supabase table, via service role REST)
// ---------------------------------------------------------------------------
// Reuses vml_bot_sessions (built for the WhatsApp bot, keyed by "mobile").
// Telegram sessions use the key "tg:<chat_id>" instead of a real mobile
// number, so the two channels' in-progress conversations never collide.

function tgKey(chatId) { return 'tg:' + chatId; }

function getSession(key) {
  var rows = callSupabaseRest('vml_bot_sessions?mobile=eq.' + encodeURIComponent(key) + '&select=*');
  return rows && rows[0];
}

function sessionExpired(session) {
  var ageMs = Date.now() - new Date(session.updated_at).getTime();
  return ageMs > SESSION_EXPIRY_MINUTES * 60 * 1000;
}

function setState(key, state, draft) {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('SUPABASE_URL') + '/rest/v1/vml_bot_sessions?on_conflict=mobile';
  var apiKey = props.getProperty('SUPABASE_SERVICE_ROLE_KEY');
  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: apiKey, Authorization: 'Bearer ' + apiKey, Prefer: 'resolution=merge-duplicates' },
    payload: JSON.stringify({ mobile: key, state: state, draft: draft, updated_at: new Date().toISOString() }),
    muteHttpExceptions: true
  });
}

function deleteSession(key) {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('SUPABASE_URL') + '/rest/v1/vml_bot_sessions?mobile=eq.' + encodeURIComponent(key);
  var apiKey = props.getProperty('SUPABASE_SERVICE_ROLE_KEY');
  UrlFetchApp.fetch(url, {
    method: 'delete',
    headers: { apikey: apiKey, Authorization: 'Bearer ' + apiKey },
    muteHttpExceptions: true
  });
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

// Telegram's shared-contact number often comes as "+919876543210" or
// "919876543210"; the app stores plain 10-digit Indian numbers.
function normalizeIndianMobile(digits) {
  if (digits.length === 12 && digits.indexOf('91') === 0) return digits.substring(2);
  return digits;
}

function callSupabaseRest(pathAndQuery) {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('SUPABASE_URL') + '/rest/v1/' + pathAndQuery;
  var key = props.getProperty('SUPABASE_SERVICE_ROLE_KEY');
  var res = UrlFetchApp.fetch(url, {
    method: 'get',
    contentType: 'application/json',
    headers: { apikey: key, Authorization: 'Bearer ' + key },
    muteHttpExceptions: true
  });
  try { return JSON.parse(res.getContentText()); } catch (e) { return []; }
}

// Handles all three PostgREST RPC response shapes: an array of rows (SETOF/
// TABLE functions), a raw scalar (boolean/text-returning functions), and an
// empty body (void-returning functions -- 204 No Content). Callers index
// [0] themselves for table-returning functions; scalar-returning functions
// are used directly.
function callSupabaseRpc(fnName, payload) {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('SUPABASE_URL') + '/rest/v1/rpc/' + fnName;
  var key = props.getProperty('SUPABASE_SERVICE_ROLE_KEY');
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: key, Authorization: 'Bearer ' + key },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var status = res.getResponseCode();
  var text = res.getContentText();
  var body = text ? JSON.parse(text) : null;
  if (status >= 400) {
    throw new Error((body && body.message) || 'Something went wrong, please try again.');
  }
  return body;
}

// ---------- TELEGRAM HELPERS ----------
function tgApiCall(method, payload) {
  var cfg = getConfig();
  var url = 'https://api.telegram.org/bot' + cfg.TELEGRAM_BOT_TOKEN + '/' + method;
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  return JSON.parse(res.getContentText());
}

function tgSendText(chatId, text) { return tgSend(chatId, text, null); }

function tgSend(chatId, text, replyMarkup) {
  var payload = { chat_id: chatId, text: text };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return tgApiCall('sendMessage', payload);
}

function inlineKeyboard(rows) { return { inline_keyboard: rows }; }

function answerCallback(callbackQueryId, text) {
  tgApiCall('answerCallbackQuery', { callback_query_id: callbackQueryId, text: text || '' });
}

function directSend(token, chatId, text) {
  var url = 'https://api.telegram.org/bot' + token + '/sendMessage';
  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ chat_id: chatId, text: text }),
    muteHttpExceptions: true
  });
}

// ---------- MANUAL TEST FUNCTION ----------
function testSend() {
  var cfg = getConfig();
  Logger.log('TELEGRAM_BOT_TOKEN set: ' + !!cfg.TELEGRAM_BOT_TOKEN);
  Logger.log('SUPABASE_URL: ' + cfg.SUPABASE_URL);
  Logger.log('ADMIN_CHAT_ID: ' + cfg.ADMIN_CHAT_ID);
  var res = tgSendText(cfg.ADMIN_CHAT_ID, 'Test message from Apps Script (VML Telegram bot)');
  Logger.log('Telegram response: ' + JSON.stringify(res));
}
