// extract — reads photos of progress sheets / investigations / treatment charts
// with Gemini and returns structured, reviewable data. Nothing is stored:
// photos live only in this request's memory, and only token counts/cost are logged.
// Deploy: supabase functions deploy extract --no-verify-jwt

const env = (k: string, d = "") => Deno.env.get(k) ?? d;

const CORS = {
  "Access-Control-Allow-Origin": env("ALLOWED_ORIGIN", "*"),
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

const MAX_IMAGES = 10;
const MAX_IMAGE_B64 = 3_000_000; // ~2.2 MB per image after client compression
const MAX_TOTAL_B64 = 9_000_000;
const OK_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const LABELS: Record<string, string> = {
  progress: "Progress sheet / clinical notes",
  investigation: "Investigation report",
  treatment: "Treatment / medication chart",
  admission: "Admission notes / case sheet",
  other: "Other document",
};

// ---------- Supabase helpers (plain fetch, no SDK) ----------
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

// ---------- Gemini ----------
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
      temperature: 0.1,
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
      if (!text) throw Object.assign(new Error(`Empty AI response (${cand?.finishReason ?? "no candidate"})`), { model, usage: data.usageMetadata });
      return { data: safeParse(text), usage: data.usageMetadata ?? null, model };
    }
    last = `${r.status} ${await r.text()}`;
    if (r.status !== 429 && r.status < 500) break;
    await new Promise((s) => setTimeout(s, 1500));
  }
  throw Object.assign(new Error(`Gemini error: ${last.slice(0, 200)}`), { model });
}

// ---------- Prompt + schema ----------
const SYSTEM = `You are a meticulous medical records transcriber in an Indian government teaching hospital (Department of General Medicine).
You receive photos of a single in-patient's case file: handwritten progress notes, printed or handwritten investigation reports, and treatment/medication charts.
Your job is ONLY to transcribe and organise what is written. You are not diagnosing or advising.

STRICT RULES
1. Never invent, infer or "correct" values. If something is not written, leave the field empty.
2. If a word, number, drug name or dose is hard to read, write your best reading followed by " [?]" AND add an entry to "unclear_items". Doses, drug names, dates and lab values matter most.
3. Keep standard medical abbreviations as written (TDS, BD, OD, HS, SOS, STAT, IV, IM, PO, Inj, Tab, Neb, s/p, k/c/o, etc.). Indian brand names are fine (e.g. Levera, Pantop, Emset, Duolin, Budecort).
4. Dates as DD/MM/YYYY when the year is known, otherwise as written.
5. PRIVACY: Do NOT transcribe any identifier anywhere: the patient's name, relatives'/attendants' names, address, phone number, e-mail, UHID, IPD/CR/MRD/registration number, bed or ward number, Aadhaar, ABHA, PM-JAY/insurance ID, or photographs of faces. Ignore them even if clearly visible. Age and sex are allowed. Refer to the person only as "the patient".
6. Medications: one row per distinct drug order. If a dose was changed, make a separate row for each regimen with dates in "dates". Put the dosage form in "form" (INJ, TAB, CAP, SYP, NEB, INH, IVF, OINT, DROPS, SACHET, other). "on_discharge" is true only if the drug clearly appears in a discharge/advice-on-discharge list or the last day's orders of an improving patient explicitly marked for discharge; otherwise false.
7. Investigations: one row per test result with its date. Include reports from BEFORE this admission (outside/referral/previous reports, old discharge cards) with their own report dates — never re-date them to the admission. Put abnormal flag "H" or "L" only if printed or obvious from the printed reference range; otherwise "".
8. Daily progress: one row per dated note (if a day has several notes, e.g. morning/evening/night, keep them in that day's row in time order). Transcribe faithfully and in DETAIL, keeping every number. Cover whatever is written of: complaints/symptoms; vitals (BP, PR, RR, SpO2 with O2 support, temperature, GCS, RBS); intake/output and urine output; examination findings by system; investigations reported or reviewed that day with values; treatment changes (drugs started, stopped or dose changed, by name; fluids, oxygen, transfusions); procedures; specialist opinions and their advice; the plan. Usually 3–8 sentences per day. Do not shorten to a vague summary such as "patient stable".
9. Events: significant events (procedures, dialysis, intubation, transfusion, arrest/CPR, specialist consults, complications) with date and time if written.
10. Past history: fill "past_events" with every earlier illness, diagnosis, hospitalisation, procedure and long-term treatment, keeping when it happened as written. Durations such as "k/c/o T2DM x 8 yrs" go here too ("8 years back"). Convert relative times only if the note gives the reference date.
11. Dates matter: copy every date written on notes, reports and charts so events can be placed in order.
12. If a photo is unreadable or irrelevant, mention it in "unclear_items".`;

const S = { type: "STRING" };
const SCHEMA = {
  type: "OBJECT",
  properties: {
    age: S, sex: { type: "STRING", description: "Male, Female or empty" },
    admission_date: S, discharge_date: S,
    known_case_of: { type: "ARRAY", items: S, description: "Pre-existing comorbidities / habits (e.g. T2DM, HTN, alcohol use, smoker)" },
    chief_complaints: { type: "ARRAY", items: S, description: "Each with duration, e.g. 'Fever x 4 days'" },
    history_of_present_illness: { type: "STRING", description: "Detailed, in time order, with durations and sequence of symptoms exactly as written" },
    relevant_negative_history: S,
    past_history_and_medications: S,
    past_events: {
      type: "ARRAY",
      items: { type: "OBJECT", properties: { when: S, detail: S }, required: ["detail"] },
      description: "Past illnesses, earlier diagnoses, previous hospitalisations, surgeries/procedures and long-term treatment, each with when it happened as written (date, month/year, year, or 'x years back')",
    },
    admission_examination: {
      type: "OBJECT",
      properties: {
        general_condition_sensorium: S,
        bp: S, pulse: S, rr: S, temperature: S, spo2: S, gcs: S,
        general_examination: S, cvs: S, rs: S, abdomen: S, cns: S,
      },
    },
    diagnoses: { type: "ARRAY", items: S, description: "Working/final diagnoses exactly as written by doctors, most important first" },
    investigations: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { date: S, test: S, value: S, unit: S, flag: S },
        required: ["test", "value"],
      },
    },
    imaging_and_other_tests: {
      type: "ARRAY",
      items: { type: "OBJECT", properties: { date: S, test: S, finding: S }, required: ["test", "finding"] },
      description: "USG, CT, MRI, X-ray, ECG, Echo, cultures, serology, CSF, etc.",
    },
    events: {
      type: "ARRAY",
      items: { type: "OBJECT", properties: { date: S, description: S }, required: ["description"] },
    },
    daily_progress: {
      type: "ARRAY",
      items: { type: "OBJECT", properties: { date: S, note: S }, required: ["note"] },
    },
    medications: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          form: S, drug: S, dose: S, route: S, frequency: S, dates: S,
          on_discharge: { type: "BOOLEAN" },
        },
        required: ["drug"],
      },
    },
    condition_at_last_note: {
      type: "OBJECT",
      properties: { status: S, bp: S, pulse: S, rr: S, spo2: S, other: S },
    },
    unclear_items: {
      type: "ARRAY",
      items: { type: "OBJECT", properties: { where: S, reading: S, reason: S }, required: ["where", "reason"] },
    },
  },
  required: ["diagnoses", "medications", "investigations", "daily_progress", "unclear_items"],
};

// ---------- Handler ----------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const user = await getUser(req);
  if (!user) return json({ error: "Please sign in again." }, 401);
  if (!(await termsAccepted(user.id))) return json({ error: "Please accept the Terms of Use to continue.", code: "terms" }, 428);

  let payload: { images?: { mime: string; data: string; kind: string }[] };
  try { payload = await req.json(); } catch { return json({ error: "Bad request" }, 400); }

  const images = Array.isArray(payload.images) ? payload.images : [];
  if (!images.length) return json({ error: "Add at least one photo." }, 400);
  if (images.length > MAX_IMAGES) return json({ error: `Maximum ${MAX_IMAGES} photos per patient.` }, 400);
  let total = 0;
  for (const im of images) {
    if (!im || typeof im.data !== "string" || !OK_MIME.has(im.mime)) return json({ error: "Unsupported image." }, 400);
    if (im.data.length > MAX_IMAGE_B64) return json({ error: "A photo is too large." }, 400);
    total += im.data.length;
  }
  if (total > MAX_TOTAL_B64) return json({ error: "Photos are too large in total. Remove a few." }, 400);

  const q = (await rpc("use_quota", {
    p_user: user.id, p_kind: "extract",
    p_free_limit: Number(env("FREE_MONTHLY_LIMIT", "5")),
    p_pro_limit: Number(env("PRO_MONTHLY_LIMIT", "300")),
  }))?.[0];
  if (q?.blocked) return json({ error: "This account has been suspended. Please contact support." }, 403);
  if (!q?.allowed) {
    return json({
      error: q?.is_pro
        ? "You have reached this month's fair-use limit."
        : "Free limit reached for this month. Upgrade to Pro to continue.",
      quota: q,
    }, 402);
  }

  const parts: unknown[] = [{ text: `There are ${images.length} photos from ONE patient's file, in order.` }];
  images.forEach((im, i) => {
    parts.push({ text: `Photo ${i + 1} — ${LABELS[im.kind] ?? LABELS.other}:` });
    parts.push({ inlineData: { mimeType: im.mime, data: im.data } });
  });
  parts.push({ text: "Transcribe and organise these into the JSON schema, following every rule." });

  try {
    const { data, usage, model } = await callGemini({
      system: SYSTEM, parts, schema: SCHEMA,
      maxTokens: Number(env("EXTRACT_MAX_TOKENS", "12000")),
      thinkingBudget: Number(env("EXTRACT_THINKING_BUDGET", "1024")),
    });
    await logUsage({ user_id: user.id, kind: "extract", ok: true, model, ...costOf(usage, model) });
    return json({ data: scrub(data), quota: q });
  } catch (e) {
    await logUsage({ user_id: user.id, kind: "extract", ok: false, model: (e as any)?.model ?? null, ...costOf((e as any)?.usage, (e as any)?.model ?? ""), error: String((e as Error)?.message ?? e).slice(0, 200) });
    await rpc("refund_quota", { p_user: user.id, p_kind: "extract" }).catch(() => {});
    console.error(e);
    return json({ error: "Could not read the photos. Please try again." }, 502);
  }
});
