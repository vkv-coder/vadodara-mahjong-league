// ==========================================================================
// Vadodara Mahjong League — shared config + helpers
// Loaded via <script src="/js/vml-common.js"> after the supabase-js CDN tag
// (and after the qrcode CDN tag, on pages that render a payment QR).
// ==========================================================================

var SB_URL = 'https://jqqnnkzozjskziaizajg.supabase.co';
var SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpxcW5ua3pvempza3ppYWl6YWpnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI5Mjk1ODAsImV4cCI6MjA4ODUwNTU4MH0.sEYeWnm0dvuw8bLSVnQhqmgV8LB-pELjpuVIa3Us1Gg';

var REGISTRATION_FEE_INR = 1000; // 1 year membership
var RENEWAL_FEE_INR = 1000; // 1 year renewal

// Manual UPI payment (no payment gateway) — the club owner's own UPI ID.
// Player pays directly via any UPI app, then self-reports via
// vml_mark_payment_submitted / vml_mark_renewal_submitted, and an admin
// manually verifies + approves from admin.html.
var VML_OWNER_UPI_ID = 'avanipatel0701@okhdfcbank';
var VML_OWNER_UPI_NAME = 'Vadodara Mahjong League';

var vmlClient = window.supabase.createClient(SB_URL, SB_KEY);

// Builds a standard UPI deep link (works with any UPI app's QR scanner or
// "pay via UPI ID" flow) for a fixed amount — the amount is baked into the
// link/QR itself, not editable by the payer.
function vmlUpiLink(amountInr, note) {
  var params = new URLSearchParams({
    pa: VML_OWNER_UPI_ID,
    pn: VML_OWNER_UPI_NAME,
    am: String(amountInr),
    cu: 'INR',
    tn: note || 'VML Membership'
  });
  return 'upi://pay?' + params.toString();
}

// Renders the UPI QR into a container element (requires the qrcodejs CDN
// script tag to already be loaded on the page). Clears any previous QR
// first so re-renders (e.g. re-showing the payment card) don't stack up.
function vmlRenderUpiQr(containerEl, amountInr, note) {
  containerEl.innerHTML = '';
  new QRCode(containerEl, { text: vmlUpiLink(amountInr, note), width: 220, height: 220 });
}
