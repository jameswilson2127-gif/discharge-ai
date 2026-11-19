// admin — data and actions for the admin panel. Only emails listed in the
// ADMIN_EMAILS secret (comma-separated) can use it; everyone else gets 403.
// Deploy: supabase functions deploy admin --no-verify-jwt

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

async function rpc(name: string, args: unknown = {}) {
  const r = await fetch(`${env("SUPABASE_URL")}/rest/v1/rpc/${name}`, {
    method: "POST", headers: serviceHeaders(), body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`rpc ${name} failed: ${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

async function patch(table: string, filter: string, fields: Record<string, unknown>) {
  const r = await fetch(`${env("SUPABASE_URL")}/rest/v1/${table}?${filter}`, {
    method: "PATCH", headers: serviceHeaders({ Prefer: "return=representation" }), body: JSON.stringify(fields),
  });
  if (!r.ok) throw new Error(`update ${table} failed: ${r.status} ${await r.text()}`);
  const rows = await r.json();
  if (!Array.isArray(rows) || !rows.length) throw new Error("Not found");
  return rows[0];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT_SETTINGS: Record<string, [number, number]> = {
  free_extract: [0, 10000], pro_extract: [0, 100000], free_generate: [0, 100000], pro_generate: [0, 1000000],
};

export function isAdmin(email: unknown) {
  const list = env("ADMIN_EMAILS").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return typeof email === "string" && list.includes(email.toLowerCase());
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const user = await getUser(req);
  if (!user) return json({ error: "Please sign in again." }, 401);
  if (!isAdmin(user.email)) return json({ error: "Not an admin." }, 403);

  let b: any = {};
  try { b = await req.json(); } catch { return json({ error: "Bad request" }, 400); }

  try {
    switch (b.action) {
      case "whoami":
        return json({ admin: true, email: user.email });

      case "overview":
        return json(await rpc("admin_overview"));

      case "users":
        return json(await rpc("admin_users", {
          p_q: String(b.q ?? "").slice(0, 100),
          p_limit: Math.min(Math.max(Number(b.limit) || 25, 1), 100),
          p_offset: Math.max(Number(b.offset) || 0, 0),
        }));

      case "daily":
        return json(await rpc("admin_daily", { p_days: Math.min(Math.max(Number(b.days) || 30, 1), 90) }));

      case "set_pro": {
        if (!UUID.test(b.user_id ?? "")) return json({ error: "Bad user id" }, 400);
        const days = Number(b.days);
        if (!Number.isFinite(days) || days < 0 || days > 3660) return json({ error: "Days must be 0–3660" }, 400);
        const pro_until = days === 0 ? null : new Date(Date.now() + days * 86400e3).toISOString();
        return json({ ok: true, row: await patch("profiles", `id=eq.${b.user_id}`, { pro_until, ...(days === 0 ? {} : { plan: "manual" }) }) });
      }

      case "reset_usage":
        if (!UUID.test(b.user_id ?? "")) return json({ error: "Bad user id" }, 400);
        return json({ ok: true, row: await patch("profiles", `id=eq.${b.user_id}`, { extract_count: 0, generate_count: 0 }) });

      case "block":
        if (!UUID.test(b.user_id ?? "")) return json({ error: "Bad user id" }, 400);
        if (b.user_id === user.id) return json({ error: "You cannot block yourself." }, 400);
        return json({ ok: true, row: await patch("profiles", `id=eq.${b.user_id}`, { blocked: !!b.blocked }) });

      case "save_settings": {
        const s = b.settings ?? {};
        const clean: Record<string, number> = {};
        for (const [k, [lo, hi]] of Object.entries(INT_SETTINGS)) {
          const v = Number(s[k]);
          if (!Number.isInteger(v) || v < lo || v > hi) return json({ error: `${k} must be a whole number ${lo}–${hi}` }, 400);
          clean[k] = v;
        }
        const fx = Number(s.usd_inr);
        if (!Number.isFinite(fx) || fx < 1 || fx > 1000) return json({ error: "usd_inr must be 1–1000" }, 400);
        clean.usd_inr = Math.round(fx * 100) / 100;
        const row = await patch("app_settings", "id=eq.1", { data: clean, updated_at: new Date().toISOString() });
        return json({ ok: true, settings: row.data });
      }

      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message === "Not found" ? "User not found." : "Admin request failed." }, 500);
  }
});
