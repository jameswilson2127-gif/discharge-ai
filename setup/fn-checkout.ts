// checkout — one-time Pro payments with Razorpay Orders. The price comes from admin settings
// (app_settings.data.pricing), so prices can change without touching Razorpay.
//   POST { action: "create", plan: "pro100" | "monthly" | "yearly" }  → { order_id, key_id, amount, plan, ... }
//   POST { action: "verify", order_id, payment_id, signature } → { ok, pro_until }
// Pro is granted only after Razorpay's signature is verified (here, or by the webhook).
// Deploy: supabase functions deploy checkout --no-verify-jwt

const env = (k: string, d = "") => Deno.env.get(k) ?? d;

const CORS = {
  "Access-Control-Allow-Origin": env("ALLOWED_ORIGIN", "*"),
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

function serviceHeaders(extra: Record<string, string> = {}) {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const h: Record<string, string> = { apikey: key, "content-type": "application/json", ...extra };
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

async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${env("SUPABASE_URL")}/rest/v1/${path}`, { ...init, headers: serviceHeaders(init.headers as Record<string, string>) });
  if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

async function hmacHex(secret: string, body: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

/** Current price for a plan in rupees: the offer price while the offer runs, else the regular price. */
export function priceFor(pricing: any, plan: string, today = new Date().toISOString().slice(0, 10)) {
  const p = pricing?.[plan];
  if (!p || p.enabled === false) return null; // switched off in admin (e.g. yearly "coming soon")
  const ends = typeof pricing?.offer_ends === "string" && pricing.offer_ends ? pricing.offer_ends : "";
  const offerOn = Number(p.price) > 0 && (!ends || today <= ends);
  const rupees = Math.round(offerOn ? Number(p.price) : Number(p.list || p.price));
  const days = Math.round(Number(p.days) || (plan === "yearly" ? 365 : 30));
  if (!(rupees >= 1 && rupees <= 100000) || !(days >= 1 && days <= 3660)) return null;
  return { rupees, days };
}

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const user = await getUser(req);
  if (!user) return json({ error: "Please sign in again." }, 401);

  let b: any = {};
  try { b = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const keyId = env("RAZORPAY_KEY_ID");
  const keySecret = env("RAZORPAY_KEY_SECRET");
  if (!keyId || !keySecret) return json({ error: "Payments are not set up yet." }, 503);

  try {
    if (b.action === "create") {
      const plan = ["pro100", "monthly", "yearly"].includes(b.plan) ? b.plan : "monthly";
      const rows = await rest("app_settings?id=eq.1&select=data");
      const price = priceFor(rows?.[0]?.data?.pricing, plan);
      if (!price) return json({ error: "This plan is not available right now." }, 400);
      const amount = price.rupees * 100;
      const r = await fetch("https://api.razorpay.com/v1/orders", {
        method: "POST",
        headers: { Authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}`, "content-type": "application/json" },
        body: JSON.stringify({
          amount, currency: "INR",
          receipt: `pro_${plan}_${Date.now()}`.slice(0, 40),
          notes: { user_id: user.id, email: user.email ?? "", plan, days: String(price.days) },
        }),
      });
      if (!r.ok) {
        console.error("razorpay order", r.status, await r.text());
        return json({ error: "Could not start payment. Please try again." }, 502);
      }
      const order = await r.json();
      await rest("orders", {
        method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ order_id: order.id, user_id: user.id, plan, amount_paise: amount, days: price.days }),
      });
      return json({ order_id: order.id, key_id: keyId, amount, currency: "INR", plan, days: price.days });
    }

    if (b.action === "verify") {
      const orderId = String(b.order_id ?? ""), paymentId = String(b.payment_id ?? ""), sig = String(b.signature ?? "");
      if (!/^order_\w+$/.test(orderId) || !/^pay_\w+$/.test(paymentId) || !sig) return json({ error: "Bad request" }, 400);
      const expected = await hmacHex(keySecret, `${orderId}|${paymentId}`);
      if (!safeEqual(sig, expected)) return json({ error: "Payment could not be verified." }, 400);
      const own = await rest(`orders?order_id=eq.${encodeURIComponent(orderId)}&user_id=eq.${user.id}&select=order_id`);
      if (!own?.length) return json({ error: "Order not found." }, 404);
      const until = await rest("rpc/grant_pro_for_order", { method: "POST", body: JSON.stringify({ p_order: orderId, p_payment: paymentId }) });
      return json({ ok: true, pro_until: until });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "Payment step failed. If money was debited, Pro will activate within a few minutes." }, 500);
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
