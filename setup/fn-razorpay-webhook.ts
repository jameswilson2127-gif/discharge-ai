// razorpay-webhook — verifies Razorpay's signature and updates the user's Pro status.
// Deploy: supabase functions deploy razorpay-webhook --no-verify-jwt
// Razorpay dashboard → Webhooks → URL: https://<project>.supabase.co/functions/v1/razorpay-webhook
// Events: subscription.activated, subscription.charged, subscription.cancelled,
//         subscription.halted, subscription.completed

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const GRACE_SECONDS = 2 * 24 * 3600; // keep Pro 2 days past period end while renewal processes

function serviceHeaders() {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const h: Record<string, string> = { apikey: key, "content-type": "application/json", Prefer: "return=minimal" };
  if (key.startsWith("eyJ")) h.Authorization = `Bearer ${key}`;
  return h;
}

async function hmacHex(secret: string, body: string) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

async function updateProfile(userId: string, fields: Record<string, unknown>) {
  const r = await fetch(`${env("SUPABASE_URL")}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`, {
    method: "PATCH", headers: serviceHeaders(), body: JSON.stringify(fields),
  });
  if (!r.ok) throw new Error(`profile update ${r.status} ${await r.text()}`);
}

async function recordPayment(row: Record<string, unknown>) {
  const r = await fetch(`${env("SUPABASE_URL")}/rest/v1/payments?on_conflict=razorpay_payment_id`, {
    method: "POST",
    headers: { ...serviceHeaders(), Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`payment insert ${r.status} ${await r.text()}`);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });

  const raw = await req.text();
  const given = req.headers.get("x-razorpay-signature") ?? "";
  const expected = await hmacHex(env("RAZORPAY_WEBHOOK_SECRET"), raw);
  if (!given || !safeEqual(given, expected)) return new Response("bad signature", { status: 401 });

  let evt: any;
  try { evt = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }

  const sub = evt?.payload?.subscription?.entity;
  const userId = sub?.notes?.user_id;
  if (!sub || !userId) return new Response("ignored", { status: 200 });

  try {
    switch (evt.event) {
      case "subscription.activated":
      case "subscription.charged":
      case "subscription.resumed": {
        const end = Number(sub.current_end);
        const plan = sub.notes?.plan === "yearly" ? "yearly" : "monthly";
        if (end > 0) {
          await updateProfile(userId, {
            pro_until: new Date((end + GRACE_SECONDS) * 1000).toISOString(),
            razorpay_subscription_id: sub.id,
            plan,
          });
        }
        const pay = evt?.payload?.payment?.entity;
        if (evt.event === "subscription.charged" && pay?.id) {
          await recordPayment({
            user_id: userId, razorpay_payment_id: pay.id, subscription_id: sub.id,
            plan, amount_paise: Number(pay.amount) || 0,
          });
        }
        break;
      }
      case "subscription.cancelled":
      case "subscription.halted":
      case "subscription.completed":
        // Leave pro_until as is: user keeps access until the paid period ends.
        await updateProfile(userId, { razorpay_subscription_id: sub.id });
        break;
    }
  } catch (e) {
    console.error(e);
    return new Response("error", { status: 500 }); // Razorpay will retry
  }
  return new Response("ok", { status: 200 });
});
