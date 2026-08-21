// ==========================================================================
// Vadodara Mahjong League — shared config + helpers
// Loaded via <script src="/js/vml-common.js"> after the supabase-js CDN tag.
// ==========================================================================

var SB_URL = 'https://jqqnnkzozjskziaizajg.supabase.co';
var SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpxcW5ua3pvempza3ppYWl6YWpnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI5Mjk1ODAsImV4cCI6MjA4ODUwNTU4MH0.sEYeWnm0dvuw8bLSVnQhqmgV8LB-pELjpuVIa3Us1Gg';

// TODO Vijay: replace with your real Razorpay LIVE key id once tested in test mode.
// The Key ID is public/safe to expose client-side (unlike the Key Secret, which
// only ever lives in the Apps Script Script Properties for the webhook).
var RAZORPAY_KEY_ID = 'rzp_test_XXXXXXXXXXXX';

// TODO Vijay: set your real registration/renewal fee (in whole rupees).
var REGISTRATION_FEE_INR = 500;
var RENEWAL_FEE_INR = 500;

var vmlClient = window.supabase.createClient(SB_URL, SB_KEY);

function vmlNewOrderRef(prefix) {
  return prefix + '-' + (crypto.randomUUID ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(36).slice(2)));
}

// Opens Razorpay checkout for a given amount (INR, whole rupees) and calls
// onSuccess(orderRef, razorpayPaymentId) once the payment succeeds. Actual
// registration/renewal confirmation happens server-side via the Apps Script
// Razorpay webhook (vml_handle_payment RPC) — this handler just shows a
// "confirming..." state and lets the caller poll for the status flip, since
// there is no server-side order-creation step to synchronously confirm against.
function vmlOpenRazorpay(opts) {
  var rzp = new Razorpay({
    key: RAZORPAY_KEY_ID,
    amount: opts.amountInr * 100,
    currency: 'INR',
    name: 'Vadodara Mahjong League',
    description: opts.description,
    prefill: { name: opts.name, email: opts.email, contact: opts.mobile },
    notes: { order_ref: opts.orderRef },
    handler: function (response) {
      opts.onSuccess(opts.orderRef, response.razorpay_payment_id);
    },
    modal: {
      ondismiss: function () { if (opts.onDismiss) opts.onDismiss(); }
    }
  });
  rzp.open();
}

// Polls vml_my_profile until the given predicate matches, or times out.
async function vmlPollProfile(predicate, onMatch, onTimeout, maxTries) {
  maxTries = maxTries || 12; // ~36s at 3s intervals
  var tries = 0;
  var timer = setInterval(async function () {
    tries++;
    var { data } = await vmlClient.rpc('vml_my_profile');
    var profile = data && data[0];
    if (profile && predicate(profile)) {
      clearInterval(timer);
      onMatch(profile);
    } else if (tries >= maxTries) {
      clearInterval(timer);
      onTimeout();
    }
  }, 3000);
}
