/**
 * Vadodara Mahjong League -- WhatsApp bot (score logging + confirmation)
 *
 * Lets a player log a match and get it confirmed entirely inside WhatsApp,
 * without ever opening the app -- same shape as IML's bot, which the
 * players are already used to. This is a SEPARATE Apps Script project from
 * vml-relay.gs (different webhook contract: Meta's, not Supabase's).
 *
 * Does not go live until a real WhatsApp Business number + Meta app are set
 * up (see project notes) -- until then this script has nothing to receive
 * webhooks from, and the existing web app (auto-confirm) keeps operating
 * completely unaffected by any of this.
 *
 * ---- Deploy ----
 * Extensions > Apps Script > paste this file > Deploy > New deployment >
 * Web app > Execute as: Me > Who has access: Anyone.
 * Any future code change requires Deploy > Manage deployments > edit the
 * active deployment > "New version" > Deploy -- saving alone does NOT
 * update the live /exec URL (same as every other app in this project).
 *
 * ---- Script Properties (Project Settings > Script Properties) ----
 *   SUPABASE_URL                  e.g. https://jqqnnkzozjskziaizajg.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY     service_role key (never expose client-side)
 *   WHATSAPP_VERIFY_TOKEN         any string you choose -- also entered in
 *                                 Meta's webhook setup screen
 *   WHATSAPP_ACCESS_TOKEN         Meta permanent access token (System User)
 *   WHATSAPP_PHONE_NUMBER_ID      the Cloud API phone number ID (not the
 *                                 phone number itself)
 *   WHATSAPP_CONFIRM_TEMPLATE     name of the approved message template used
 *                                 to ping the other 3 players (business-
 *                                 initiated messages require an approved
 *                                 template) -- must be created + approved in
 *                                 Meta Business Manager first. The exact
 *                                 component structure below (one body
 *                                 variable, two quick-reply buttons) has to
 *                                 match whatever template gets approved --
 *                                 adjust sendConfirmRequest() if the
 *                                 approved template's shape differs.
 *
 * ---- Wiring (once the WhatsApp Business number exists) ----
 *   Meta App Dashboard > WhatsApp > Configuration > Webhook:
 *     Callback URL: this script's /exec URL
 *     Verify token: same value as WHATSAPP_VERIFY_TOKEN above
 *     Subscribe to: messages
 */

var STATE_CATEGORY = 'awaiting_category';
var STATE_MY_SCORE = 'awaiting_my_score';
var STATE_P2_ID = 'awaiting_p2_id';
var STATE_P2_SCORE = 'awaiting_p2_score';
var STATE_P3_ID = 'awaiting_p3_id';
var STATE_P3_SCORE = 'awaiting_p3_score';
var STATE_P4_ID = 'awaiting_p4_id';
var STATE_P4_SCORE = 'awaiting_p4_score';
var SESSION_EXPIRY_MINUTES = 30;

// ---------------------------------------------------------------------------
// Meta webhook entry points
// ---------------------------------------------------------------------------

function doGet(e) {
  var props = PropertiesService.getScriptProperties();
  var mode = e.parameter['hub.mode'];
  var token = e.parameter['hub.verify_token'];
  var challenge = e.parameter['hub.challenge'];

  if (mode === 'subscribe' && token === props.getProperty('WHATSAPP_VERIFY_TOKEN')) {
    return ContentService.createTextOutput(challenge);
  }
  return ContentService.createTextOutput('Forbidden');
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var value = body.entry && body.entry[0] && body.entry[0].changes && body.entry[0].changes[0] && body.entry[0].changes[0].value;
    var message = value && value.messages && value.messages[0];
    if (message) handleIncomingMessage(message);
  } catch (err) {
    Logger.log('doPost error: ' + err);
  }
  // HtmlService, not ContentService -- ContentService responses 302-redirect,
  // which Meta's webhook sender would follow and silently re-deliver the
  // same message a second time. See apps_script_redirect_bug memory.
  return HtmlService.createHtmlOutput('ok');
}

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

function handleIncomingMessage(message) {
  var from = normalizeIndianMobile(message.from);

  if (message.type === 'interactive' && message.interactive && message.interactive.type === 'button_reply') {
    handleButtonReply(from, message.interactive.button_reply.id);
    return;
  }
  if (message.type !== 'text' || !message.text) return;

  var text = message.text.body.trim();
  var session = getSession(from);

  if (!session || sessionExpired(session)) {
    if (text.toUpperCase() === 'CANCEL') {
      waSendText(from, 'Nothing in progress.');
      return;
    }
    startNewMatchFlow(from);
    return;
  }

  if (text.toUpperCase() === 'CANCEL') {
    deleteSession(from);
    waSendText(from, 'Cancelled. Send any message to start logging a new match.');
    return;
  }

  advanceMatchFlow(from, session, text);
}

// ---------------------------------------------------------------------------
// Match-logging conversation (creator side)
// ---------------------------------------------------------------------------

function startNewMatchFlow(from) {
  var member = callSupabaseRpc('vml_bot_lookup_by_mobile', { p_mobile: from })[0];
  if (!member) {
    waSendText(from, "This WhatsApp number isn't a recognized active VML member. Contact avanipatel0701@gmail.com if this seems wrong.");
    return;
  }
  upsertSession(from, STATE_CATEGORY, {});
  waSendButtons(from, 'Logging a new match. What category did you play?', [
    { id: 'cat_traditional', title: '🀄 Traditional' },
    { id: 'cat_taiwanese', title: '🏆 Taiwanese' }
  ]);
}

function advanceMatchFlow(from, session, text) {
  var draft = session.draft || {};
  var lower = text.toLowerCase();

  if (session.state === STATE_CATEGORY) {
    var category = (lower === '1' || lower.indexOf('trad') === 0) ? 'traditional'
                  : (lower === '2' || lower.indexOf('taiw') === 0) ? 'taiwanese' : null;
    if (!category) {
      waSendButtons(from, "Please choose a category.", [
        { id: 'cat_traditional', title: '🀄 Traditional' },
        { id: 'cat_taiwanese', title: '🏆 Taiwanese' }
      ]);
      return;
    }
    draft.category = category;
    upsertSession(from, STATE_MY_SCORE, draft);
    waSendText(from, 'What was YOUR score?');
    return;
  }

  if (session.state === STATE_MY_SCORE) {
    var myScore = parseInt(text, 10);
    if (isNaN(myScore)) { waSendText(from, 'Please send just a number for your score.'); return; }
    draft.my_score = myScore;
    upsertSession(from, STATE_P2_ID, draft);
    waSendText(from, "Player 2's Member ID? (e.g. A001)");
    return;
  }

  if (session.state === STATE_P2_ID) {
    draft.p2_id = text.toUpperCase();
    upsertSession(from, STATE_P2_SCORE, draft);
    waSendText(from, "Player 2's score?");
    return;
  }

  if (session.state === STATE_P2_SCORE) {
    var s2 = parseInt(text, 10);
    if (isNaN(s2)) { waSendText(from, 'Please send just a number for the score.'); return; }
    draft.p2_score = s2;
    upsertSession(from, STATE_P3_ID, draft);
    waSendText(from, "Player 3's Member ID?");
    return;
  }

  if (session.state === STATE_P3_ID) {
    draft.p3_id = text.toUpperCase();
    upsertSession(from, STATE_P3_SCORE, draft);
    waSendText(from, "Player 3's score?");
    return;
  }

  if (session.state === STATE_P3_SCORE) {
    var s3 = parseInt(text, 10);
    if (isNaN(s3)) { waSendText(from, 'Please send just a number for the score.'); return; }
    draft.p3_score = s3;
    upsertSession(from, STATE_P4_ID, draft);
    waSendText(from, "Player 4's Member ID?");
    return;
  }

  if (session.state === STATE_P4_ID) {
    draft.p4_id = text.toUpperCase();
    upsertSession(from, STATE_P4_SCORE, draft);
    waSendText(from, "Player 4's score?");
    return;
  }

  if (session.state === STATE_P4_SCORE) {
    var s4 = parseInt(text, 10);
    if (isNaN(s4)) { waSendText(from, 'Please send just a number for the score.'); return; }
    draft.p4_score = s4;
    finalizeMatch(from, draft);
    return;
  }
}

function finalizeMatch(from, draft) {
  var rows;
  try {
    rows = callSupabaseRpc('vml_bot_create_match', {
      p_creator_mobile: from,
      p_member_ids: [draft.p2_id, draft.p3_id, draft.p4_id],
      p_scores: [draft.my_score, draft.p2_score, draft.p3_score, draft.p4_score],
      p_category: draft.category
    });
  } catch (err) {
    deleteSession(from);
    waSendText(from, '⚠️ ' + err.message + '\n\nSend any message to start over.');
    return;
  }

  deleteSession(from);
  var matchCode = rows[0].match_code;
  var creatorRow = rows.filter(function (r) { return r.is_creator; })[0];
  var others = rows.filter(function (r) { return !r.is_creator; });

  waSendText(from, '✅ Match logged! Code ' + matchCode + ' -- you scored ' + creatorRow.score +
    ' (' + creatorRow.rank_points + ' pts). Waiting for ' + others.map(function (p) { return p.name; }).join(', ') + ' to confirm.');

  others.forEach(function (p) {
    sendConfirmRequest(p.mobile, p.match_id, matchCode, creatorRow.name, p.score, p.rank_points);
  });
}

// ---------------------------------------------------------------------------
// Confirm / dispute (the other 3 players)
// ---------------------------------------------------------------------------

function sendConfirmRequest(toMobile, matchId, matchCode, creatorName, score, rankPoints) {
  // Business-initiated (this player hasn't messaged the bot themselves right
  // now), so this MUST go through an approved template -- adjust the
  // component structure here to match whatever gets approved in Meta
  // Business Manager. Assumes: 1 body variable + 2 quick-reply buttons.
  var props = PropertiesService.getScriptProperties();
  var templateName = props.getProperty('WHATSAPP_CONFIRM_TEMPLATE');
  var bodyText = creatorName + ' logged a match (code ' + matchCode + '): you scored ' + score + ' (' + rankPoints + ' pts).';

  waSendTemplate(toMobile, templateName, bodyText, [
    { text: '✅ Confirm', payload: 'confirm:' + matchId },
    { text: '❌ Dispute', payload: 'reject:' + matchId }
  ]);
}

function handleButtonReply(from, buttonId) {
  var parts = buttonId.split(':');
  var action = parts[0];
  var matchId = parts[1];
  if (!matchId) return;

  if (action === 'confirm') {
    try {
      var justCompleted = callSupabaseRpc('vml_bot_confirm_match', { p_match_id: matchId, p_mobile: from })[0];
      waSendText(from, justCompleted
        ? '✅ Confirmed! All 3 players have now confirmed -- this match is live on the leaderboard.'
        : "✅ Thanks, you've confirmed this match. Waiting on the remaining player(s).");
    } catch (err) {
      waSendText(from, '⚠️ ' + err.message);
    }
    return;
  }

  if (action === 'reject') {
    try {
      callSupabaseRpc('vml_bot_reject_match', { p_match_id: matchId, p_mobile: from, p_reason: null });
      waSendText(from, "You've disputed this match. The player who logged it has been notified.");
      notifyCreatorOfDispute(matchId);
    } catch (err) {
      waSendText(from, '⚠️ ' + err.message);
    }
    return;
  }
}

function notifyCreatorOfDispute(matchId) {
  var match = callSupabaseRest('vml_matches?id=eq.' + matchId + '&select=created_by,match_code')[0];
  if (!match) return;
  var creator = callSupabaseRest('vml_players?id=eq.' + match.created_by + '&select=mobile')[0];
  if (!creator) return;
  waSendText(creator.mobile, 'Your match ' + match.match_code + ' was disputed by a player. You can log it again with corrected scores.');
}

// ---------------------------------------------------------------------------
// Session storage (Supabase table, via service role REST)
// ---------------------------------------------------------------------------

function getSession(mobile) {
  var rows = callSupabaseRest('vml_bot_sessions?mobile=eq.' + encodeURIComponent(mobile) + '&select=*');
  return rows && rows[0];
}

function sessionExpired(session) {
  var ageMs = Date.now() - new Date(session.updated_at).getTime();
  return ageMs > SESSION_EXPIRY_MINUTES * 60 * 1000;
}

function upsertSession(mobile, state, draft) {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('SUPABASE_URL') + '/rest/v1/vml_bot_sessions?on_conflict=mobile';
  var key = props.getProperty('SUPABASE_SERVICE_ROLE_KEY');
  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: key, Authorization: 'Bearer ' + key, Prefer: 'resolution=merge-duplicates' },
    payload: JSON.stringify({ mobile: mobile, state: state, draft: draft, updated_at: new Date().toISOString() }),
    muteHttpExceptions: true
  });
}

function deleteSession(mobile) {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('SUPABASE_URL') + '/rest/v1/vml_bot_sessions?mobile=eq.' + encodeURIComponent(mobile);
  var key = props.getProperty('SUPABASE_SERVICE_ROLE_KEY');
  UrlFetchApp.fetch(url, {
    method: 'delete',
    headers: { apikey: key, Authorization: 'Bearer ' + key },
    muteHttpExceptions: true
  });
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

// WhatsApp sends "from" as international format with no leading + (e.g.
// "919876543210"). The app stores plain 10-digit Indian numbers, so strip a
// leading country code before matching against vml_players.mobile.
function normalizeIndianMobile(waFrom) {
  if (waFrom.length === 12 && waFrom.indexOf('91') === 0) return waFrom.substring(2);
  return waFrom;
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
  var body = JSON.parse(res.getContentText());
  if (status >= 400) {
    throw new Error(body.message || 'Something went wrong, please try again.');
  }
  return body;
}

function waSendText(to, body) {
  waSend(to, { type: 'text', text: { body: body } });
}

function waSendButtons(to, bodyText, buttons) {
  waSend(to, {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.map(function (b) {
          return { type: 'reply', reply: { id: b.id, title: b.title } };
        })
      }
    }
  });
}

// Business-initiated message -- must use an approved template. Adjust the
// "components" shape here once the actual approved template is known.
function waSendTemplate(to, templateName, bodyText, quickReplyButtons) {
  waSend(to, {
    type: 'template',
    template: {
      name: templateName,
      language: { code: 'en' },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: bodyText }] }
      ].concat(quickReplyButtons.map(function (btn, i) {
        return {
          type: 'button',
          sub_type: 'quick_reply',
          index: String(i),
          parameters: [{ type: 'payload', payload: btn.payload }]
        };
      }))
    }
  });
}

function waSend(to, messageFields) {
  var props = PropertiesService.getScriptProperties();
  var url = 'https://graph.facebook.com/v20.0/' + props.getProperty('WHATSAPP_PHONE_NUMBER_ID') + '/messages';
  var token = props.getProperty('WHATSAPP_ACCESS_TOKEN');
  var payload = Object.assign({ messaging_product: 'whatsapp', to: to }, messageFields);
  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
}
