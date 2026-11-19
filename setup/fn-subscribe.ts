// subscribe — creates a Razorpay subscription for the signed-in user and
// returns its id for Razorpay Checkout. Pro is granted only by the webhook.
// Deploy: supabase functions deploy subscribe --no-verify-jwt

const env = (k: string, d = "") => Deno.env.get(k) ?? d;

const CORS = {
  "Access-Control-Allow-Origin": env("ALLOWED_ORIGIN", "*"),
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

async function getUser(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  const r = await fetch(`${env("SUPABASE_URL")}/auth/v1/user`, {
    headers: { Authorization: auth, apikey: env("SUPABASE_ANON_KEY") },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u?.id ? u : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const user = await getUser(req);
  if (!user) return json({ error: "Please sign in again." }, 401);

  let body: { plan?: string } = {};
  try { body = await req.json(); } catch { /* empty body = monthly */ }
  const plan = body.plan === "yearly" ? "yearly" : "monthly";
  const planId = plan === "yearly" ? env("RAZORPAY_PLAN_YEARLY") : env("RAZORPAY_PLAN_MONTHLY", env("RAZORPAY_PLAN_ID"));
  if (!planId) return json({ error: "This plan is not available yet." }, 400);

  const keyId = env("RAZORPAY_KEY_ID");
  const basic = btoa(`${keyId}:${env("RAZORPAY_KEY_SECRET")}`);
  const r = await fetch("https://api.razorpay.com/v1/subscriptions", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "content-type": "application/json" },
    body: JSON.stringify({
      plan_id: planId,
      total_count: plan === "yearly" ? 10 : 60, // billing cycles (10 years / 5 years)
      customer_notify: 1,
      notes: { user_id: user.id, email: user.email ?? "", plan },
    }),
  });
  if (!r.ok) {
    console.error("razorpay", r.status, await r.text());
    return json({ error: "Could not start payment. Please try again." }, 502);
  }
  const sub = await r.json();
  return json({ subscription_id: sub.id, key_id: keyId, plan });
});
