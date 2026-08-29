/**
 * Vadodara Mahjong League — Apps Script relay
 *
 * Payment is fully manual (no gateway): the club owner shows her own UPI
 * ID/QR on the site, a player pays directly via any UPI app and clicks
 * "I've completed the payment" (which just flips a status/flag in
 * Supabase), and an admin manually verifies + approves from admin.html.
 *
 * This script's only job is routing Supabase Database Webhooks (configured
 * in the Supabase dashboard, not here) on vml_players/vml_match_entries/
 * vml_matches to plain safeEmail(to, subject, body) calls — same generic
 * shape as Appointment-'s google-apps-script.gs.
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
 *   ADMIN_EMAIL                 where registration/renewal notifications go
 *
 * ---- Wiring ----
 *   Supabase dashboard > Database > Webhooks > add this /exec URL for:
 *     vml_players        -> UPDATE
 *     vml_matches        -> UPDATE
 *
 * (Matches auto-confirm on creation now -- no per-player confirmation step --
 * so the old vml_match_entries -> INSERT webhook is no longer needed. Remove
 * that trigger from the Supabase dashboard if it's still configured.)
 */

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.table) {
      handleSupabaseWebhook(body);
    }
  } catch (err) {
    Logger.log('doPost error: ' + err);
  }
  // HtmlService, not ContentService — ContentService responses cause the
  // /exec endpoint to 302-redirect, which auto-following callers (including
  // Supabase's own webhook sender) will follow and silently re-execute the
  // whole script a second time. See apps_script_redirect_bug memory.
  return HtmlService.createHtmlOutput('ok');
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
  } else if (table === 'vml_matches' && type === 'UPDATE') {
    handleMatchStatusChange(record, oldRecord);
  }
}

function handlePlayerStatusChange(record, oldRecord) {
  var adminEmail = PropertiesService.getScriptProperties().getProperty('ADMIN_EMAIL');

  if (oldRecord.status === 'pending_payment' && record.status === 'pending_approval') {
    // Player clicked "I've completed the payment" on register.html.
    safeEmail(adminEmail,
      'VML: New registration awaiting approval — ' + record.name,
      'A new member reported their UPI payment and is awaiting approval:\n\n' +
      'Name: ' + record.name + '\nMobile: ' + record.mobile + '\nEmail: ' + record.email + '\n\n' +
      'Verify the payment yourself, then approve or reject at: https://vadodaramahjongleague.com/admin.html'
    );
    safeEmail(record.email,
      'Vadodara Mahjong League — payment received',
      'Hi ' + record.name + ',\n\n' +
      'We\'ve recorded your payment as submitted. The club admin will verify it and approve your ' +
      'membership shortly — you\'ll get another email with your member ID once that\'s done.\n\n' +
      'Questions? avanipatel0701@gmail.com'
    );
  } else if (oldRecord.status === 'pending_approval' && record.status === 'active') {
    // Admin clicked Approve.
    safeEmail(record.email,
      'Welcome to the Vadodara Mahjong League — your member ID is ' + record.member_id,
      'Hi ' + record.name + ',\n\n' +
      'Your membership is approved! Your member ID is ' + record.member_id + '.\n' +
      'You\'ve also been credited a 1000-point welcome bonus.\n' +
      'Share your member ID with teammates so they can add you when logging a match.\n\n' +
      'Log in any time at https://vadodaramahjongleague.com/login.html\n' +
      'Membership valid until: ' + record.expires_at
    );
  } else if (!oldRecord.renewal_pending && record.renewal_pending) {
    // Active member clicked "I've completed the renewal payment" on dashboard.html.
    safeEmail(adminEmail,
      'VML: Renewal payment submitted — ' + record.name + ' (' + record.member_id + ')',
      'A member reported their renewal payment:\n\n' +
      'Name: ' + record.name + '\nMobile: ' + record.mobile + '\nMember ID: ' + record.member_id + '\n\n' +
      'Verify the payment yourself, then approve at: https://vadodaramahjongleague.com/admin.html'
    );
  } else if (oldRecord.renewal_pending && !record.renewal_pending && record.status === 'active') {
    // Admin clicked Approve on a pending renewal.
    safeEmail(record.email,
      'Vadodara Mahjong League — membership renewed',
      'Hi ' + record.name + ',\n\n' +
      'Your renewal payment is confirmed. Your membership is now valid until ' + record.expires_at + '.\n\n' +
      'Log in any time at https://vadodaramahjongleague.com/login.html'
    );
  }
}

function handleMatchStatusChange(record, oldRecord) {
  if (oldRecord.status !== 'rejected' && record.status === 'rejected') {
    var creator = callSupabaseRest('vml_players?id=eq.' + record.created_by + '&select=name,email')[0];
    if (!creator) return;

    safeEmail(creator.email,
      'VML: A match you logged was disputed',
      'Hi ' + creator.name + ',\n\n' +
      'Your ' + record.category + ' match from ' + record.match_date + ' was disputed' +
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
