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

  // Shows an "Admin" link for these accounts. Display only — access is checked
  // on the server against the ADMIN_EMAILS secret.
  ADMIN_EMAILS: ["jameswilson2127@gmail.com"],
};
