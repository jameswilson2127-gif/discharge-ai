// template — turns a pasted template / old summary (text or photos) into a reusable
// section structure. Patient-specific facts are stripped into [placeholders].
// Deploy: supabase functions deploy template --no-verify-jwt

const env = (k: string, d = "") => Deno.env.get(k) ?? d;

const CORS = {
  "Access-Control-Allow-Origin": env("ALLOWED_ORIGIN", "*"),
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

const OK_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_TEXT = 20_000;
const MAX_IMAGES = 4;
const MAX_IMAGE_B64 = 3_000_000;

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

async function rpc(name: string, args: unknown) {
  const r = await fetch(`${env("SUPABASE_URL")}/rest/v1/rpc/${name}`, {
    method: "POST", headers: serviceHeaders(), body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`rpc ${name} failed: ${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

// ---------- Usage & cost logging (token counts only, never patient data) ----------
const DEFAULT_PRICES: Record<string, [number, number]> = { // USD per 1M tokens [input, output]
  "gemini-2.5-flash": [0.30, 2.50],
  "gemini-2.5-flash-lite": [0.10, 0.40],
};
function priceFor(model: string): [number, number] {
  try {
    const custom = JSON.parse(env("PRICES_JSON", "{}"));
    if (Array.isArray(custom[model])) return [Number(custom[model][0]), Number(custom[model][1])];
  } catch { /* ignore bad JSON */ }
  return DEFAULT_PRICES[model] ?? DEFAULT_PRICES["gemini-2.5-flash"];
}
export function costOf(usage: any, model: string) {
  const input_tokens = Number(usage?.promptTokenCount ?? 0);
  const output_tokens = Number(usage?.candidatesTokenCount ?? 0) + Number(usage?.thoughtsTokenCount ?? 0);
  const [pin, pout] = priceFor(model);
  return { input_tokens, output_tokens, cost_usd: +((input_tokens * pin + output_tokens * pout) / 1e6).toFixed(6) };
}
async function logUsage(row: Record<string, unknown>) {
  try {
    await fetch(`${env("SUPABASE_URL")}/rest/v1/usage_events`, {
      method: "POST", headers: { ...serviceHeaders(), Prefer: "return=minimal" }, body: JSON.stringify(row),
    });
  } catch (e) { console.error("logUsage", e); }
}

// Parse without ever putting AI text into an error message (V8's JSON errors quote the input,
// which could carry patient details into logs).
function safeParse(text: string) {
  try { return JSON.parse(text); } catch { throw new Error("AI returned malformed JSON"); }
}

// Defence in depth: strip identifier-like numbers even if they slip past the photo mask / prompt.
const ID_PATTERNS: [RegExp, string][] = [
  [/\b\d{2}-\d{4}-\d{4}-\d{4}\b/g, "[ID removed]"],                 // ABHA number
  [/\b\d{4}[ -]\d{4}[ -]\d{4}\b/g, "[ID removed]"],                  // Aadhaar (spaced)
  [/(?:\+91[ -]?|\b0)?\b[6-9]\d{4}[ -]?\d{5}\b/g, "[phone removed]"],  // Indian mobile
  [/\b\d{10,}\b/g, "[number removed]"],                                // any long ID-like run
  [/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email removed]"],
];
export function scrub(v: unknown): unknown {
  if (typeof v === "string") return ID_PATTERNS.reduce((s, [re, r]) => s.replace(re, r), v);
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]));
  return v;
}

// Server-side check that the user has accepted the current Terms of Use.
async function termsAccepted(uid: string) {
  const need = Number(env("TERMS_VERSION", "1"));
  const r = await fetch(`${env("SUPABASE_URL")}/rest/v1/profiles?id=eq.${uid}&select=terms_version`, { headers: serviceHeaders() });
  if (!r.ok) return false;
  const rows = await r.json();
  return Number(rows?.[0]?.terms_version ?? 0) >= need;
}

async function callGemini(opts: {
  system: string; parts: unknown[]; schema: unknown; maxTokens: number; thinkingBudget: number;
}) {
  const model = env("GEMINI_MODEL", "gemini-2.5-flash");
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: opts.system }] },
    contents: [{ role: "user", parts: opts.parts }],
    generationConfig: {
      ...(/^gemini-3/.test(model) ? {} : { temperature: 0.2 }), // Gemini 3: keep default temperature (low values can loop)
      responseMimeType: "application/json",
      responseSchema: opts.schema,
      maxOutputTokens: opts.maxTokens,
      thinkingConfig: { thinkingBudget: opts.thinkingBudget },
    },
  });
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": env("GEMINI_API_KEY") }, body },
    );
    if (r.ok) {
      const data = await r.json();
      const cand = data?.candidates?.[0];
      const text = (cand?.content?.parts ?? [])
        .filter((p: { text?: string; thought?: boolean }) => p.text && !p.thought)
        .map((p: { text: string }) => p.text).join("");
      const finish = cand?.finishReason ?? "no candidate";
      const outTok = data?.usageMetadata?.candidatesTokenCount ?? "?";
      const thinkTok = data?.usageMetadata?.thoughtsTokenCount ?? 0;
      if (!text) {
        last = `Empty AI response (${finish})`;
      } else {
        try {
          return { data: JSON.parse(text), usage: data.usageMetadata ?? null, model };
        } catch {
          // Never log the text itself (it may contain patient details) — only why it failed.
          last = `AI returned malformed JSON (finish: ${finish}, output ${outTok} tok, thinking ${thinkTok} tok, model ${model})`;
        }
      }
      if (attempt === 0) continue; // one retry for truncated / looping output
      throw Object.assign(new Error(last), { model, usage: data.usageMetadata });
    }
    last = `${r.status} ${await r.text()}`;
    if (r.status !== 429 && r.status < 500) break;
    await new Promise((s) => setTimeout(s, 1500));
  }
  throw Object.assign(new Error(last.startsWith("AI returned") || last.startsWith("Empty") ? last : `Gemini error: ${last.slice(0, 200)}`), { model });
}

const KINDS = [
  "patient_details", "diagnosis", "narrative", "investigations_table",
  "treatment_given", "discharge_medications", "advice", "static_text", "signature",
];

const SYSTEM = `You convert a hospital's discharge-summary FORMAT into a reusable template structure.
The input is one of: a blank template with placeholders, a filled sample summary, or photos of either.

Return the document title, the department/hospital header line (if any), and the sections IN ORDER. Each section gets one kind:
- patient_details: the header block of patient fields. Put the field LABELS in "fields" (e.g. "Name", "Age/Sex", "UHID", "IPD No.", "Bed No.", "Unit", "Consultant", "Date of Admission", "Date of Discharge"). guidance "".
- diagnosis: the diagnosis list. guidance = how diagnoses are ordered/worded in this format.
- narrative: any prose section the doctor writes (history, examination, course in hospital, clinical summary, procedures, condition at discharge, etc.). If the format has separate headings, keep them as separate narrative sections.
- investigations_table: a table or list of lab values. guidance "".
- treatment_given: list of drugs given during the stay. guidance "".
- discharge_medications: list of drugs to continue at home. guidance = the lead-in sentence used before the list, if any.
- advice: discharge advice / follow-up / warning signs prose.
- static_text: fixed wording printed identically for every patient (e.g. "Kindly bring this summary at every visit", emergency numbers). guidance = that exact text.
- signature: signature/sign-off line. Put the signatory labels in "fields" (e.g. "Junior Resident", "Senior Resident", "Consultant").

For diagnosis, narrative and advice sections, "guidance" must let another doctor reproduce this department's style exactly:
- Keep the format's own model sentences and phrasing patterns, with [square-bracket placeholders] for anything case-specific, e.g. "A [age]-year-old [male/female], known case of [comorbidities], presented with complaints of [complaints with duration]."
- Add a short note on what the section must contain and its usual length/order if that is clear.

PRIVACY — CRITICAL: if the input is a filled summary of a real patient, NEVER copy patient-specific facts into any field: no names, ages, IDs, dates, places, lab values, drug names/doses, findings or events. Replace every such fact with a [placeholder] describing it. Fixed hospital wording is fine.
If the input is not a discharge-summary format at all, return the closest sensible structure with a single narrative section.`;

const S = { type: "STRING" };
const SCHEMA = {
  type: "OBJECT",
  properties: {
    title: S,
    department: S,
    sections: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          heading: S,
          kind: { type: "STRING", enum: KINDS },
          guidance: S,
          fields: { type: "ARRAY", items: S },
        },
        required: ["heading", "kind", "guidance"],
      },
    },
  },
  required: ["title", "sections"],
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const user = await getUser(req);
  if (!user) return json({ error: "Please sign in again." }, 401);
  if (!(await termsAccepted(user.id))) return json({ error: "Please accept the Terms of Use to continue.", code: "terms" }, 428);

  let payload: { text?: string; images?: { mime: string; data: string }[] };
  try { payload = await req.json(); } catch { return json({ error: "Bad request" }, 400); }

  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  const images = Array.isArray(payload.images) ? payload.images : [];
  if (!text && !images.length) return json({ error: "Paste the template text or add a photo of it." }, 400);
  if (text.length > MAX_TEXT) return json({ error: "Template text is too long." }, 400);
  if (images.length > MAX_IMAGES) return json({ error: `Maximum ${MAX_IMAGES} photos for a template.` }, 400);
  for (const im of images) {
    if (!im || typeof im.data !== "string" || !OK_MIME.has(im.mime) || im.data.length > MAX_IMAGE_B64) {
      return json({ error: "Unsupported or too-large photo." }, 400);
    }
  }

  const q = (await rpc("use_quota", {
    p_user: user.id, p_kind: "generate",
    p_free_limit: Number(env("FREE_MONTHLY_GENERATE_LIMIT", "20")),
    p_pro_limit: Number(env("PRO_MONTHLY_GENERATE_LIMIT", "1000")),
  }))?.[0];
  if (q?.blocked) return json({ error: "This account has been suspended. Please contact support." }, 403);
  if (!q?.allowed) return json({ error: "Monthly limit reached.", quota: q }, 402);

  const parts: unknown[] = [];
  if (text) parts.push({ text: `TEMPLATE / SAMPLE TEXT:\n"""\n${scrub(text)}\n"""` });
  images.forEach((im, i) => {
    parts.push({ text: `Template photo ${i + 1}:` });
    parts.push({ inlineData: { mimeType: im.mime, data: im.data } });
  });
  parts.push({ text: "Return the template structure as JSON." });

  try {
    const { data, usage, model } = await callGemini({
      system: SYSTEM, parts, schema: SCHEMA,
      maxTokens: 8000, thinkingBudget: Number(env("TEMPLATE_THINKING_BUDGET", "1024")),
    });
    await logUsage({ user_id: user.id, kind: "template", ok: true, model, ...costOf(usage, model) });
    // Normalise
    const sections = (Array.isArray(data.sections) ? data.sections : []).slice(0, 25).map((s: any) => ({
      heading: String(s.heading ?? "").slice(0, 120),
      kind: KINDS.includes(s.kind) ? s.kind : "narrative",
      guidance: scrub(String(s.guidance ?? "").slice(0, 5000)) as string,
      fields: Array.isArray(s.fields) ? s.fields.map((f: unknown) => String(f).slice(0, 60)).slice(0, 20) : [],
    }));
    if (!sections.length) throw new Error("no sections");
    return json({
      template: { title: String(data.title ?? "DISCHARGE SUMMARY").slice(0, 120), department: String(data.department ?? "").slice(0, 160), sections },
      quota: q,
    });
  } catch (e) {
    await logUsage({ user_id: user.id, kind: "template", ok: false, model: (e as any)?.model ?? null, ...costOf((e as any)?.usage, (e as any)?.model ?? ""), error: String((e as Error)?.message ?? e).slice(0, 200) });
    await rpc("refund_quota", { p_user: user.id, p_kind: "generate" }).catch(() => {});
    console.error(e);
    return json({ error: "Could not read the template. Try pasting it as text." }, 502);
  }
});
