/**
 * Vadodara Mahjong League — Apps Script relay
 *
 * Handles two kinds of incoming webhook, both posted to the same /exec URL:
 *   1. Razorpay's `payment.captured` webhook — used only as a TRIGGER; the
 *      payment is then re-fetched from Razorpay's own API (Basic Auth with
 *      the Key Secret) before being trusted, since Apps Script web apps
 *      cannot read the X-Razorpay-Signature request header to verify it
 *      directly (a real Apps Script platform limitation, not an oversight).
 *      Same "verify after" shape as SEATBOOK's Edge Function.
 *   2. Supabase Database Webhooks (configured in the Supabase dashboard, not
 *      here) on vml_players/vml_match_entries/vml_matches — routed to plain
 *      safeEmail(to, subject, body) calls, same generic shape as
 *      Appointment-'s google-apps-script.gs.
 *
 * ---- Deploy ----
 * Extensions > Apps Script > paste this file > Deploy > New deployment >
 * Web app > Execute as: Me > Who has access: Anyone.
 *
 * Any future code change requires Deploy > Manage deployments > edit the
 * active deployment > "New version" > Deploy — saving the script alone does
 * NOT update the live /exec URL (like every other app in this project's
 * history).
 *
 * ---- Script Properties (Project Settings > Script Properties) ----
 *   SUPABASE_URL                e.g. https://jqqnnkzozjskziaizajg.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY   service_role key (never expose client-side)
 *   RAZORPAY_KEY_ID             same Key ID as vml-common.js
 *   RAZORPAY_KEY_SECRET         Key Secret — lives ONLY here, never in any
 *                               .html file
 *   ADMIN_EMAIL                 where new-registration notifications go
 *
 * ---- Wiring ----
 *   Razorpay dashboard > Settings > Webhooks > add this /exec URL, event
 *   `payment.captured` (the webhook "secret" field there doesn't need to
 *   match anything here, since we don't verify the signature — see above).
 *
 *   Supabase dashboard > Database > Webhooks > add this /exec URL for:
 *     vml_players        -> UPDATE
 *     vml_match_entries  -> INSERT
 *     vml_matches        -> UPDATE
 */

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);

    if (body.event) {
      handleRazorpayWebhook(body);
    } else if (body.table) {
      handleSupabaseWebhook(body);
    }
  } catch (err) {
    Logger.log('doPost error: ' + err);
  }
  // HtmlService, not ContentService — ContentService responses cause the
  // /exec endpoint to 302-redirect, which auto-following callers (including
  // Razorpay's and Supabase's own webhook senders) will follow and silently
  // re-execute the whole script a second time. See apps_script_redirect_bug memory.
  return HtmlService.createHtmlOutput('ok');
}

// ---------------------------------------------------------------------------
// Razorpay webhook
// ---------------------------------------------------------------------------

function handleRazorpayWebhook(body) {
  if (body.event !== 'payment.captured') return;

  var payment = body.payload && body.payload.payment && body.payload.payment.entity;
  if (!payment || !payment.id) return;

  var verified = fetchRazorpayPayment(payment.id);
  if (!verified || verified.status !== 'captured') {
    Logger.log('Payment ' + payment.id + ' not confirmed captured on re-fetch, ignoring');
    return;
  }

  var orderRef = verified.notes && verified.notes.order_ref;
  if (!orderRef) {
    Logger.log('Razorpay payment ' + payment.id + ' missing notes.order_ref');
    return;
  }

  callSupabaseRpc('vml_handle_payment', {
    p_razorpay_order_ref: orderRef,
    p_razorpay_payment_id: verified.id
  });
}

function fetchRazorpayPayment(paymentId) {
  var props = PropertiesService.getScriptProperties();
  var keyId = props.getProperty('RAZORPAY_KEY_ID');
  var keySecret = props.getProperty('RAZORPAY_KEY_SECRET');
  var res = UrlFetchApp.fetch('https://api.razorpay.com/v1/payments/' + paymentId, {
    method: 'get',
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(keyId + ':' + keySecret) },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    Logger.log('Razorpay payment fetch failed: ' + res.getContentText());
    return null;
  }
  return JSON.parse(res.getContentText());
}

// ---------------------------------------------------------------------------
// Supabase DB webhooks -> email relay
// ---------------------------------------------------------------------------

function handleSupabaseWebhook(body) {
  var table = body.table;
  var type = body.type; // INSERT / UPDATE
  var record = body.record;
  var oldRecord = body.old_record;

  if (table === 'vml_players' && type === 'UPDATE') {
    handlePlayerStatusChange(record, oldRecord);
  } else if (table === 'vml_match_entries' && type === 'INSERT') {
    handleMatchEntryInsert(record);
  } else if (table === 'vml_matches' && type === 'UPDATE') {
    handleMatchStatusChange(record, oldRecord);
  }
}

function handlePlayerStatusChange(record, oldRecord) {
  var adminEmail = PropertiesService.getScriptProperties().getProperty('ADMIN_EMAIL');
  var welcomeEmail = function () {
    safeEmail(record.email,
      'Welcome to the Vadodara Mahjong League — your member ID is ' + record.member_id,
      'Hi ' + record.name + ',\n\n' +
      'Payment received and your membership is now active! Your member ID is ' + record.member_id + '.\n' +
      'You\'ve also been credited a 1000-point welcome bonus.\n' +
      'Share your member ID with teammates so they can add you when logging a match.\n\n' +
      'Log in any time at https://vadodaramahjongleague.com/login.html\n' +
      'Membership valid until: ' + record.expires_at
    );
  };

  if (oldRecord.status === 'pending_payment' && record.status === 'active') {
    // Normal path: payment confirmed -> auto-activated immediately, no
    // manual admin review step. Admin gets an FYI, not an approval request.
    safeEmail(adminEmail,
      'VML: New member auto-approved — ' + record.name + ' (' + record.member_id + ')',
      'A new member paid and was automatically activated:\n\n' +
      'Name: ' + record.name + '\nMobile: ' + record.mobile + '\nEmail: ' + record.email + '\n' +
      'Member ID: ' + record.member_id + '\n\n' +
      'View members anytime at: https://vadodaramahjongleague.com/admin.html'
    );
    welcomeEmail();
  } else if (oldRecord.status === 'pending_payment' && record.status === 'pending_approval') {
    // Manual-fallback path only (vml_approve_player still exists for edge
    // cases) -- the automatic flow above skips this status entirely now.
    safeEmail(adminEmail,
      'VML: New registration awaiting approval — ' + record.name,
      'A new member has paid and is awaiting manual approval:\n\n' +
      'Name: ' + record.name + '\nMobile: ' + record.mobile + '\nEmail: ' + record.email + '\n\n' +
      'Approve or reject at: https://vadodaramahjongleague.com/admin.html'
    );
    safeEmail(record.email,
      'Vadodara Mahjong League — payment received',
      'Hi ' + record.name + ',\n\n' +
      'We\'ve received your membership payment. Your registration is awaiting admin approval — ' +
      'you\'ll get another email with your member ID as soon as that\'s done.\n\n' +
      'Questions? info.anyapps@gmail.com'
    );
  } else if (oldRecord.status === 'pending_approval' && record.status === 'active') {
    welcomeEmail();
  }
}

function handleMatchEntryInsert(record) {
  if (!record.match_id || !record.player_id) return;

  var match = callSupabaseRest('vml_matches?id=eq.' + record.match_id + '&select=created_by,category,match_date')[0];
  if (!match) return;
  if (record.player_id === match.created_by) return; // creator doesn't need to confirm their own match

  var player = callSupabaseRest('vml_players?id=eq.' + record.player_id + '&select=name,email')[0];
  var creator = callSupabaseRest('vml_players?id=eq.' + match.created_by + '&select=name')[0];
  if (!player) return;

  safeEmail(player.email,
    'VML: Confirm your match result',
    'Hi ' + player.name + ',\n\n' +
    (creator ? creator.name : 'A teammate') + ' logged a ' + match.category + ' match from ' + match.match_date +
    ' that includes your score.\n\n' +
    'Please log in and confirm (or dispute) it: https://vadodaramahjongleague.com/dashboard.html'
  );
}

function handleMatchStatusChange(record, oldRecord) {
  if (oldRecord.status === 'pending_confirm' && record.status === 'rejected') {
    var creator = callSupabaseRest('vml_players?id=eq.' + record.created_by + '&select=name,email')[0];
    if (!creator) return;

    safeEmail(creator.email,
      'VML: A match you logged was disputed',
      'Hi ' + creator.name + ',\n\n' +
      'Your ' + record.category + ' match from ' + record.match_date + ' was disputed by a player' +
      (record.rejected_reason ? (' with this note: "' + record.rejected_reason + '"') : '.') + '\n\n' +
      'You can log it again with corrected scores at https://vadodaramahjongleague.com/dashboard.html'
    );
  }
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function safeEmail(to, subject, body) {
  if (!to) return;
  try { MailApp.sendEmail(to, subject, body); } catch (e) { Logger.log('safeEmail failed: ' + e); }
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
  if (res.getResponseCode() >= 300) {
    Logger.log('RPC ' + fnName + ' failed: ' + res.getContentText());
  }
  return res;
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
