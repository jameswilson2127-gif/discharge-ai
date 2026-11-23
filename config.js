// Fill these in from Supabase → Project Settings → API.
// The anon/publishable key is safe to expose in the browser (RLS protects data).
export const CONFIG = {
  SUPABASE_URL: "https://nlsrmiesrtnzwuutyzxo.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_g57kXMF1fQp0Xn5gTjeVJw_j6B9Zq6o",

  APP_NAME: "Discharge AI",
  DEFAULT_DEPARTMENT: "Department of General Medicine",

  // Shown until the live limit loads from the database (Admin → Settings).
  FREE_MONTHLY_LIMIT: 5,

  // Display only — real prices are the Razorpay plans (RAZORPAY_PLAN_MONTHLY / _YEARLY secrets).
  PLANS: [
    { id: "monthly", name: "Monthly", price: "₹199", per: "/ month", note: "Cancel any time" },
    { id: "yearly",  name: "Yearly",  price: "₹1,499", per: "/ year", note: "≈ ₹125 / month · save 37%", best: true },
  ],
  PRO_FEATURES: ["Up to 300 patients a month", "Unlimited custom templates", "Priority support"],

  // ---- Legal (shown in the Terms of Use and Privacy Policy) ----
  // Your full legal name, or your company's name if you register one.
  OPERATOR_NAME: "",
  // Public support + grievance contact. DPDP requires a working contact for grievances.
  CONTACT_EMAIL: "jameswilson2127@gmail.com",
  // WhatsApp support number with country code, digits only, e.g. "919876543210". Empty = button hidden.
  WHATSAPP_NUMBER: "",
  // City whose courts handle disputes, e.g. "New Delhi". Leave empty for "courts in India".
  JURISDICTION_CITY: "",
  // Bump this (and the TERMS_VERSION secret on Supabase) whenever you change the Terms/Privacy text;
  // every user must then accept again before they can use the AI.
  TERMS_VERSION: 1,
  TERMS_UPDATED: "19 November 2026",
  // How long an unfinished case may stay in this browser tab before it is wiped automatically.
  CASE_TTL_MINUTES: 120,

  // Shows an "Admin" link for these accounts. Display only — access is checked
  // on the server against the ADMIN_EMAILS secret.
  ADMIN_EMAILS: ["jameswilson2127@gmail.com"],
};
