// account — lets a user permanently delete their account (DPDP right to erasure).
// Cancels any active Razorpay subscription, then deletes the auth user; their
// profile, templates and terms history are removed by ON DELETE CASCADE.
// Usage logs and payment records keep no link to the person (user_id → null);
// payment records themselves are retained because tax law requires it.
// Deploy: supabase functions deploy account --no-verify-jwt

const env = (k: string, d = "") => Deno.env.get(k) ?? d;

const CORS = {
  "Access-Control-Allow-Origin": env("ALLOWED_ORIGIN", "*"),
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

function serviceHeaders() {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const h: Record<string, string> = { apikey: key, "content-type": "application/json" };
  if (key.startsWith("eyJ")) h.Authorization = `Bearer ${key}`;
  return h;
}

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

async function cancelRazorpay(subId: string) {
  const basic = btoa(`${env("RAZORPAY_KEY_ID")}:${env("RAZORPAY_KEY_SECRET")}`);
  const r = await fetch(`https://api.razorpay.com/v1/subscriptions/${encodeURIComponent(subId)}/cancel`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "content-type": "application/json" },
    body: JSON.stringify({ cancel_at_cycle_end: 0 }),
  });
  // 400 usually means it is already cancelled/completed — fine to continue.
  if (!r.ok && r.status !== 400) throw new Error(`razorpay cancel ${r.status}`);
}

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const user = await getUser(req);
  if (!user) return json({ error: "Please sign in again." }, 401);

  let body: { action?: string; confirm?: string } = {};
  try { body = await req.json(); } catch { /* empty */ }
  if (body.action !== "delete" || body.confirm !== "DELETE") return json({ error: "Bad request" }, 400);

  const base = env("SUPABASE_URL");
  try {
    const pr = await fetch(`${base}/rest/v1/profiles?id=eq.${user.id}&select=razorpay_subscription_id`, { headers: serviceHeaders() });
    const sub = pr.ok ? (await pr.json())?.[0]?.razorpay_subscription_id : null;
    if (sub) await cancelRazorpay(sub);

    const d = await fetch(`${base}/auth/v1/admin/users/${user.id}`, { method: "DELETE", headers: serviceHeaders() });
    if (!d.ok) throw new Error(`delete user ${d.status}`);
    return json({ ok: true });
  } catch (e) {
    console.error("account delete", String((e as Error)?.message ?? e));
    return json({ error: "Could not delete the account. Please email support." }, 502);
  }
}

// Allow the site's own domains (and anything listed in the ALLOWED_ORIGIN secret, comma-separated).
const SITE_ORIGINS = ["https://dischargeai.in", "https://www.dischargeai.in"];
function allowOrigin(origin: string | null) {
  const cfg = env("ALLOWED_ORIGIN", "*").split(",").map((s) => s.trim()).filter(Boolean);
  if (cfg.includes("*")) return "*";
  const ok = [...SITE_ORIGINS, ...cfg];
  return origin && ok.includes(origin) ? origin : SITE_ORIGINS[0];
}

Deno.serve(async (req: Request) => {
  const res = await handle(req);
  res.headers.set("Access-Control-Allow-Origin", allowOrigin(req.headers.get("origin")));
  res.headers.set("Vary", "Origin");
  return res;
});
