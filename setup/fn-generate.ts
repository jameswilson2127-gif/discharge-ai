// generate — writes the AI sections of the chosen template from the
// doctor-reviewed data. Text only (cheap). Patient name/UHID are never sent.
// Deploy: supabase functions deploy generate --no-verify-jwt

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
  "gemini-3.1-flash-lite": [0.25, 1.50],
  "gemini-3.8-flash": [0.75, 3.75], // intro rate; Google doubles it from 1 Jan 2027 (set PRICES_JSON then)
  "gemini-flash-lite-latest": [0.25, 1.50], // approx. (Flash-Lite family); set PRICES_JSON for exact
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
  const thinking_tokens = Number(usage?.thoughtsTokenCount ?? 0); // already included in output_tokens
  return { input_tokens, output_tokens, thinking_tokens, cost_usd: +((input_tokens * pin + output_tokens * pout) / 1e6).toFixed(6) };
}
async function logUsage(row: Record<string, unknown>) {
  const post = (r: Record<string, unknown>) => fetch(`${env("SUPABASE_URL")}/rest/v1/usage_events`, {
    method: "POST", headers: { ...serviceHeaders(), Prefer: "return=minimal" }, body: JSON.stringify(r),
  });
  try {
    const r = await post(row);
    // If a newer column isn't in the database yet (SQL file not run), still log the basics.
    if (r.status === 400) {
      const { thinking_tokens, length, case_id, photos, ...basic } = row;
      await post(basic);
    }
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

// Gemini 3.x models take a thinking *level*; older models take a token budget.
function thinkingCfg(model: string, budget: number, level: string) {
  return /^gemini-3/.test(model) ? (level ? { thinkingLevel: level } : undefined) : { thinkingBudget: budget };
}

async function callGemini(opts: {
  system: string; parts: unknown[]; schema: unknown; maxTokens: number; thinkingBudget: number; thinkingLevel: string;
}) {
  let model = env("GEMINI_TEXT_MODEL", env("GEMINI_MODEL", "gemini-3.1-flash-lite"));
  // If a model rejects the requested thinking setting (e.g. "minimal"), retry once with "low".
  let level = opts.thinkingLevel;
  const makeBody = () => JSON.stringify({
    systemInstruction: { parts: [{ text: opts.system }] },
    contents: [{ role: "user", parts: opts.parts }],
    generationConfig: {
      ...(/^gemini-3/.test(model) ? {} : { temperature: 0.3 }), // Gemini 3: keep default temperature (low values can loop)
      responseMimeType: "application/json",
      responseSchema: opts.schema,
      maxOutputTokens: opts.maxTokens,
      thinkingConfig: thinkingCfg(model, opts.thinkingBudget, level),
    },
  });
  // Gemini 3.1 Flash-Lite only. When it is busy (429/503): retry it twice (a backup model can be
  // set with the GEMINI_FALLBACK_MODEL secret; none by default). The app then retries by itself.
  const models = [model, env("GEMINI_FALLBACK_MODEL", "")].filter((m, i, a) => m && a.indexOf(m) === i);
  let last = "";
  for (const m of models) {
    model = m; level = opts.thinkingLevel;
    let body = makeBody();
    let busyTries = 0;
    let busy = false;
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
      if (r.status === 400 && /thinking/i.test(last) && level !== "low") { level = "low"; body = makeBody(); attempt--; continue; }
      if (r.status === 429 || r.status >= 500) {
        busy = true;
        if (++busyTries <= 2) { await new Promise((s) => setTimeout(s, 1500 * busyTries)); attempt--; continue; }
      }
      break; // other errors: don't retry
    }
    if (!busy) break; // only switch models when Google says the model is busy
  }
  throw Object.assign(new Error(last.startsWith("AI returned") || last.startsWith("Empty") ? last : `Gemini error: ${last.slice(0, 200)}`), { model });
}

const OUTCOMES: Record<string, string> = {
  discharged: "Discharged in stable condition",
  lama: "Left Against Medical Advice (LAMA)",
  dama: "Discharged Against Medical Advice (DAMA)",
  referred: "Referred to a higher centre / another department",
  expired: "Expired during the hospital stay",
};

const KINDS = new Set([
  "patient_details", "diagnosis", "narrative", "investigations_table",
  "treatment_given", "discharge_medications", "advice", "static_text", "signature",
]);
const AI_KINDS = new Set(["narrative", "advice"]);
const APP_FILLED: Record<string, string> = {
  patient_details: "patient details header",
  investigations_table: "investigations table",
  treatment_given: "list of drugs given during the stay",
  discharge_medications: "discharge medication list",
  static_text: "fixed hospital text",
  signature: "signature line",
};

type Section = { heading: string; kind: string; guidance: string };

function cleanTemplate(t: any): { title: string; sections: Section[] } | null {
  if (!t || !Array.isArray(t.sections) || !t.sections.length || t.sections.length > 25) return null;
  const sections = t.sections.map((s: any) => ({
    heading: String(s?.heading ?? "").slice(0, 120),
    kind: KINDS.has(s?.kind) ? s.kind : "narrative",
    guidance: String(s?.guidance ?? "").slice(0, 5000),
  }));
  return { title: String(t.title ?? "DISCHARGE SUMMARY").slice(0, 120), sections };
}

const LENGTHS: Record<string, string> = {
  concise: "CONCISE — a brief summary. The hospital course groups the stay into phases and keeps only the key findings, results and treatment changes; other narrative sections 1–3 sentences each.",
  standard: "STANDARD — the hospital course is as long as the documented content requires: go through every dated note in order with its findings, results and treatment changes. Little documented = short course; a lot documented = long course. Other narrative sections at the template's usual length.",
  detailed: "DETAILED — the fullest account the documented content allows: every dated note and event, with vitals, serial values, examination changes and each treatment change and its reason. Length scales with the amount documented.",
};

const SYSTEM = `You write discharge summaries for an Indian teaching hospital, following the department's own template exactly.
You are given (1) the TEMPLATE: the sections you must write, each with guidance showing the department's model phrasing with [placeholders], and (2) doctor-verified CASE DATA as JSON.

STYLE
- Formal clinical English, past tense, third person ("the patient", "he"/"she" per sex), flowing prose like a senior resident. No bullet points inside prose unless the guidance uses them.
- Reproduce each section's guidance closely: same order of ideas, same sentence patterns and stock phrases. Fill [placeholders] from the case data; drop clauses that don't apply to this patient.
- Separate paragraphs with a blank line.
- Quote key abnormal values with units, and serial trends where useful (e.g. creatinine fell from 9.67 to 6.12 mg/dL).

SOURCES AND ACCURACY (most important)
- case_story is the doctor-verified transcription of the whole case in date order. Use it as the main source for the history, the sequence of events and the hospital course; use the structured fields for exact values, drugs and doses. If they disagree, use the structured field and keep the case_story's order.
- Every date, number, dose, cycle count and drug you write must appear in the case data. Do not round, convert, recompute or "correct" anything. Do not change a drug's route or form (eye drops stay eye drops). Do not merge separate events into one or move an event to another date.
- If you are unsure of a fact, leave it out or write ___ — never guess. A shorter correct summary is always better than a fuller wrong one.

STORY ORDER (CHRONOLOGY)
- The case data includes CHRONOLOGY: a timeline built automatically from the written dates (background, reports before admission, then Day 1, Day 2…), plus SERIAL TRENDS of repeated tests. Treat it as the backbone of the narrative and keep its order. Never move a dated event or result to a different day.
- Narrative sections must read as one continuous clinical story from beginning to end:
  1) background — comorbidities with duration and treatment, earlier illnesses, previous hospitalisations and procedures (from past_events, oldest first);
  2) earlier investigations done before this admission, with their dates and findings, and how they relate to the current illness;
  3) the presenting illness in time order, leading up to admission;
  4) admission findings and the initial investigations;
  5) the diagnosis;
  6) the day-by-day hospital course, mentioning each investigation result on the day it came, with trends compared with earlier values (including pre-admission values);
  7) the end of the stay per OUTCOME.
- Link events with natural time phrases ("Eight years ago…", "In March 2026…", "Two days before admission…", "On day 3…", "Subsequently…").
- If the template splits these into separate sections, keep each section's content in chronological order. Undated items go where they fit best, without inventing a date.

HOSPITAL COURSE (most important part — must be DETAILED)
- Wherever the template describes the course in hospital (a "Hospital Course" section, or the course part of a "Clinical Summary"/"Case Summary"), write a full chronological account. Use the template's opening and closing phrases, but do NOT shorten the course to match the template's length.
- Cover EVERY dated progress note and event in date order, using dates ("On 12/11/2026…", "On day 3 of admission…") or clearly grouped phases for long stays. For each day or phase include, where documented: clinical status and symptoms; vitals with values and their trend; oxygen/ventilatory support; examination changes; investigations reported, with values and serial trends; treatment started, stopped or modified, naming the drugs (doses where clinically relevant: antibiotics, steroids, insulin, inotropes, anticoagulants, diuretics); fluids, transfusions and procedures; specialist consultations and their advice; complications and how they were managed.
- Give each dated note as many sentences as its content needs: what the patient's status was that day, what was found or reported, and what was done in response and why. Do not compress several days into one line when each day has documented findings or treatment changes; group days only when nothing changed between them.
- LENGTH FOLLOWS CONTENT: there is no fixed word count. The hospital course must be proportional to what the case data documents — a note with many findings, results and changes gets several sentences; a note with one line gets one sentence. Never cut documented detail to keep it short, and never stretch a sparsely documented stay with generic filler.
- Surgical and obstetric cases: take the operation or delivery details from "operations" (and case_story), and write sections such as "Procedure Done", "Operative Details" or "Delivery Details" only from what is documented. Count the post-operative course by post-operative day or date as the notes do.
- Then describe the state at the end of the stay as required by OUTCOME.
- Length follows SUMMARY LENGTH (given with the case). Whatever the length, never leave out the diagnosis, key results, a drug started/stopped/changed, a complication, a drug on hold or a discharge drug — a shorter summary only means a briefer narrative. Detail must come only from the case data — never pad with generic sentences.

OUTCOME
- Any part describing the end of the stay must match OUTCOME:
  * Discharged: condition and vitals at discharge, and that the patient is being discharged with medications and advice.
  * LAMA/DAMA: condition; that the condition, prognosis and need for further management were explained to the attendants in their own language; that they nevertheless wished to take the patient home; hence discharged against medical advice.
  * Referred: condition at referral, reason and destination if given.
  * Expired: the terminal event with date/time if given, resuscitation per ACLS if documented, time of declaration of death if given; cause of death only if documented.
- For advice-type sections, return an empty string when OUTCOME is Referred or Expired.

ABSOLUTE RULES
1. Use ONLY facts present in the case data. Never invent symptoms, values, doses, dates, consultations or improvements.
2. Where the template needs a value that is not in the data, write ___ (three underscores). Never guess vitals, and never write that something "was not recorded". Leave out template clauses about things that are not documented (e.g. oral feeds, urine output, ambulation) instead of assuming them.
3. Copy drug names, doses and lab values exactly as given. Do not change units.
4. Items marked [?] are unverified: keep the [?] marker if you use them.
5. Never write the patient's name, any relative's name, address, phone or any ID number. Use "the patient".
6. Do not write the sections that the app fills itself (listed under APP-FILLED), and do not reproduce those lists inside your prose.
7. You are a documentation aid, not a clinician: do not add any diagnosis, drug, dose, investigation, referral or treatment recommendation that is not in the case data or the doctor's instructions. Warning symptoms in advice sections must be generic return-to-hospital signs appropriate to the documented illness.
8. Department and follow-up: use DEPARTMENT (below) for the department name in prose and follow-up; never assume "General Medicine" unless that is the department. Advice/follow-up sections must mention drugs kept on hold (held_drugs), awaited reports (pending_investigations) and follow_up_plan when present, plus discharge drugs as listed.
9. Write units with values. Preserve the meaning of "suspected", "?" and negated history exactly.
10. final_diagnosis: primary diagnosis first, then complications, then comorbidities/habits, using the doctor's own diagnosis wording, expanded only with qualifiers present in the case data (suspected cause, stage, relapse, "status post" procedures and transplants with years, current therapy) — e.g. "Acute gastroenteritis (suspected infective vs drug-induced) in a case of relapsed Multiple Myeloma (ISS stage I), s/p autologous HSCT (2024), on Bortezomib". Follow the template's diagnosis guidance if it says otherwise.`;

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const user = await getUser(req);
  if (!user) return json({ error: "Please sign in again." }, 401);
  if (!(await termsAccepted(user.id))) return json({ error: "Please accept the Terms of Use to continue.", code: "terms" }, 428);

  let payload: { case?: Record<string, unknown>; options?: Record<string, string>; template?: unknown; case_id?: string; length?: string };
  try { payload = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const length = ["concise", "standard", "detailed"].includes(String(payload?.length)) ? String(payload.length) : "standard";
  // Random per-patient id that links this discharge's AI calls for cost reporting. Contains no patient data.
  const caseId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(payload?.case_id ?? "")) ? String(payload.case_id) : null;
  const c = payload.case;
  if (!c || typeof c !== "object") return json({ error: "No case data." }, 400);
  const caseText = JSON.stringify(scrub(c));
  if (caseText.length > 120_000) return json({ error: "Case data too long." }, 400);
  const tpl = cleanTemplate(payload.template);
  if (!tpl) return json({ error: "Invalid template." }, 400);

  // Build the per-template instructions and a JSON schema with one key per AI-written section.
  const S = { type: "STRING" };
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const write: string[] = [];
  const appFilled: string[] = [];
  tpl.sections.forEach((s, i) => {
    if (AI_KINDS.has(s.kind)) {
      properties[`s${i}`] = S;
      required.push(`s${i}`);
      write.push(`- key "s${i}" — section "${s.heading || "(no heading)"}" (${s.kind}).\n  Guidance: ${s.guidance || "Write this section appropriately for a discharge summary."}`);
    } else if (s.kind === "diagnosis") {
      if (!properties.final_diagnosis) {
        properties.final_diagnosis = { type: "ARRAY", items: S };
        required.push("final_diagnosis");
      }
      write.push(`- key "final_diagnosis" — section "${s.heading || "Diagnosis"}" (list of diagnoses).${s.guidance ? `\n  Guidance: ${s.guidance}` : ""}`);
    } else if (APP_FILLED[s.kind]) {
      appFilled.push(`${s.heading || s.kind} (${APP_FILLED[s.kind]})`);
    }
  });
  if (!required.length) return json({ error: "This template has no sections for the AI to write." }, 400);

  const o = payload.options ?? {};
  const ctx = [
    `DOCUMENT TITLE: ${tpl.title}`,
    `OUTCOME: ${OUTCOMES[o.outcome] ?? OUTCOMES.discharged}`,
    `SUMMARY LENGTH: ${LENGTHS[length]}`,
    `DEPARTMENT: ${String(o.dept || (c as Record<string, unknown>).department || (payload.template as Record<string, unknown> | undefined)?.department || "___").slice(0, 120)}`,
    o.followup ? `FOLLOW-UP INTERVAL: ${String(o.followup).slice(0, 60)}` : "FOLLOW-UP INTERVAL: not specified (use ___)",
    o.monitor ? `PARAMETERS TO MONITOR: ${String(o.monitor).slice(0, 200)}` : "",
    o.extra ? `ADDITIONAL INSTRUCTIONS FROM THE DOCTOR: ${scrub(String(o.extra).slice(0, 600))}` : "",
    "",
    "SECTIONS TO WRITE (return each under its JSON key):",
    ...write,
    "",
    `APP-FILLED (do not write): ${appFilled.join("; ") || "none"}`,
  ].filter((x) => x !== null).join("\n");

  const q = (await rpc("use_quota", {
    p_user: user.id, p_kind: "generate",
    p_free_limit: Number(env("FREE_MONTHLY_GENERATE_LIMIT", "20")),
    p_pro_limit: Number(env("PRO_MONTHLY_GENERATE_LIMIT", "1000")),
  }))?.[0];
  if (q?.blocked) return json({ error: "This account has been suspended. Please contact support." }, 403);
  if (!q?.allowed) return json({ error: "Monthly drafting limit reached.", quota: q }, 402);

  try {
    const { data, usage, model } = await callGemini({
      system: SYSTEM,
      parts: [{ text: `${ctx}\n\nVERIFIED CASE DATA (JSON):\n${caseText}` }],
      schema: { type: "OBJECT", properties, required },
      maxTokens: Number(env("GENERATE_MAX_TOKENS", "16000")),
      // Writing from already-checked data needs little reasoning: thinking off by default (cost).
      thinkingBudget: Number(env("GENERATE_THINKING_BUDGET", "0")),
      thinkingLevel: env("GENERATE_THINKING_LEVEL", "minimal"),
    });
    await logUsage({ user_id: user.id, kind: "generate", case_id: caseId, length, ok: true, model, ...costOf(usage, model) });
    const sections: Record<string, string> = {};
    for (const k of Object.keys(properties)) if (k !== "final_diagnosis") sections[k] = scrub(String(data?.[k] ?? "")) as string;
    return json({
      data: { final_diagnosis: Array.isArray(data?.final_diagnosis) ? data.final_diagnosis.map((x: unknown) => scrub(String(x)) as string) : [], sections },
      quota: q,
    });
  } catch (e) {
    await logUsage({ user_id: user.id, kind: "generate", case_id: caseId, length, ok: false, model: (e as any)?.model ?? null, ...costOf((e as any)?.usage, (e as any)?.model ?? ""), error: String((e as Error)?.message ?? e).slice(0, 200) });
    await rpc("refund_quota", { p_user: user.id, p_kind: "generate" }).catch(() => {});
    console.error(e);
    if (/^Gemini error: (429|5\d\d)/.test(String((e as Error)?.message ?? ""))) {
      return json({ error: "Server is experiencing high demand.", code: "busy" }, 503);
    }
    return json({ error: "Could not write the summary. Please try again." }, 502);
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
