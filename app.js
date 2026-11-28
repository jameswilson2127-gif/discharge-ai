import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { CONFIG } from "./config.js?v=43";
import { DEFAULT_TEMPLATE, BUILTIN_TEMPLATES, isBuiltin, builtinById, suggestBuiltin, KINDS, buildDoc, normaliseTemplate, esc, setFactSource } from "./doc.js?v=43";
import { buildChronology } from "./chrono.js?v=43";
import { labPanel, consistencyIssues } from "./checks.js?v=43";

/* ============================================================
   Setup & helpers
   ============================================================ */
const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2, 10);
const clone = (o) => JSON.parse(JSON.stringify(o));
const debounce = (fn, ms = 400) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

const store = {
  get(area, k, d = null) { try { const v = area.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(area, k, v) { try { area.setItem(k, JSON.stringify(v)); } catch { /* quota / private mode */ } },
  del(area, k) { try { area.removeItem(k); } catch { /* ignore */ } },
};
const SS = (() => { try { return window.sessionStorage; } catch { return null; } })();
const LS = (() => { try { return window.localStorage; } catch { return null; } })();
const CASE_KEY = "dai_case_v2";
// Referral link (?ref=CODE): remembered until the doctor signs in, then claimed once.
const REF_KEY = "dai_ref";
try {
  const rc = new URLSearchParams(location.search).get("ref");
  if (rc && /^[A-Za-z0-9]{6}$/.test(rc) && LS) store.set(LS, REF_KEY, { c: rc.toUpperCase(), t: Date.now() });
} catch { /* ignore */ }
// Where the doctor came from (?src=medbulletin or utm_source=…). First link wins, kept 30 days, saved once at signup.
const SRC_KEY = "dai_src";
try {
  const q = new URLSearchParams(location.search);
  const src = (q.get("src") || q.get("utm_source") || "").toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 40);
  const cur = LS && store.get(LS, SRC_KEY);
  if (src && LS && (!cur || Date.now() - cur.t > 30 * 86400e3)) store.set(LS, SRC_KEY, { s: src, t: Date.now() });
} catch { /* ignore */ }

// Client-side first pass at removing identifier-like numbers (the server does this again).
function scrubText(t) {
  return String(t || "")
    .replace(/\b\d{2}-\d{4}-\d{4}-\d{4}\b/g, "[ID removed]")
    .replace(/\b\d{4}[ -]\d{4}[ -]\d{4}\b/g, "[ID removed]")
    .replace(/(?:\+91[ -]?|\b0)?\b[6-9]\d{4}[ -]?\d{5}\b/g, "[phone removed]")
    .replace(/\b\d{10,}\b/g, "[number removed]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email removed]");
}

function toast(msg, err = false, ms = 3800) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast no-print" + (err ? " err" : "");
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

let busyTimer = null, stageTimer = null;
function busy(text) {
  const b = $("#busy");
  clearInterval(busyTimer); clearInterval(stageTimer);
  if (!text) { b.hidden = true; return; }
  const start = Date.now();
  $("#busyText").textContent = text;
  b.hidden = false;
  busyTimer = setInterval(() => {
    $("#busyText").textContent = `${text} (${Math.round((Date.now() - start) / 1000)} s)`;
  }, 1000);
}

/* ============================================================
   State
   ============================================================ */
// Only these are collected. Name and dates are optional, stay on this device and are never sent to any server.
const PATIENT_FIELDS = ["name", "doa", "dod", "outcome", "followup", "monitor", "extra", "dept"];
const LEGACY_ID_FIELDS = ["age", "sex", "uhid", "ipd", "fields"]; // removed in v2 — wiped from old saved cases
const KIND_LABEL = { progress: "Progress notes", investigation: "Investigations", treatment: "Treatment chart", admission: "Admission notes", other: "Other" };

let session = null;
let profile = null;
const state = {
  step: "patient",
  patient: { outcome: "discharged", dept: "", length: store.get(LS, "dai_length", "standard"), templateId: store.get(LS, "dai_last_tpl", "default") },
  photos: [],          // {id, kind, url} — memory only, never persisted
  data: null,          // extracted + reviewed case data
  draft: null,         // AI-written sections
  draftTemplate: null, // template snapshot the draft was written for
  docHtml: null,       // doctor-edited final document
  templates: [],       // user's saved templates (rows from Supabase)
};

// "My Activity" shows patient names from THIS phone only: case id -> name, never uploaded.
const NAMES_KEY = "dai_case_names";
function rememberName() {
  const n = (state.patient.name || "").trim();
  if (!LS || !state.caseId || !n) return;
  const m = store.get(LS, NAMES_KEY, {});
  if (m[state.caseId]?.n === n) return;
  m[state.caseId] = { n: n.slice(0, 60), t: Date.now() };
  const keep = Object.entries(m).filter(([, v]) => Date.now() - v.t < 400 * 86400e3).sort((a, b) => b[1].t - a[1].t).slice(0, 500);
  store.set(LS, NAMES_KEY, Object.fromEntries(keep));
}
const saveCase = debounce(() => {
  rememberName();
  if (!SS) return;
  store.set(SS, CASE_KEY, {
    savedAt: Date.now(),
    caseId: state.caseId,
    readLength: state.readLength, readAt: state.readAt, readSig: state.readSig,
    step: state.step === "templates" ? "patient" : state.step,
    patient: state.patient, data: state.data, draft: state.draft, draftTemplate: state.draftTemplate, docHtml: state.docHtml,
  });
}, 300);

function restoreCase() {
  const c = SS && store.get(SS, CASE_KEY);
  if (!c) return;
  const ttl = (CONFIG.CASE_TTL_MINUTES || 120) * 60e3;
  if (!c.savedAt || Date.now() - c.savedAt > ttl) { store.del(SS, CASE_KEY); return; } // stale case: wipe
  Object.assign(state.patient, c.patient || {});
  if (c.caseId) state.caseId = c.caseId;
  if (c.readLength) state.readLength = c.readLength;
  if (c.readAt) { state.readAt = c.readAt; state.readSig = c.readSig; }
  for (const k of LEGACY_ID_FIELDS) delete state.patient[k];
  state.data = c.data || null;
  state.draft = c.draft || null;
  state.draftTemplate = c.draftTemplate || null;
  state.docHtml = c.docHtml || null;
  state.step = c.step || "patient";
}

/* ============================================================
   Auth & account
   ============================================================ */
function monthIST() { return new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 7); }
function isPro() { return !!(profile?.pro_until && new Date(profile.pro_until) > new Date()); }
// Allowance period. Pro: 30-day windows from the payment (pack_start). Free: calendar month (IST).
// Must match public.usage_key() in setup/11-pack-period.sql.
const PACK_MS = 30 * 86400e3;
function packWindow() {
  if (!isPro()) return null;
  const until = Date.parse(profile.pro_until), now = Date.now();
  let a = profile.pack_start ? Math.floor(Date.parse(profile.pack_start) / 1000) * 1000
    : until - PACK_MS * Math.ceil((until - now) / PACK_MS);
  if (a > now) a = now;
  const idx = Math.floor((now - a) / PACK_MS);
  return { key: `P${Math.floor(a / 1000)}#${idx}`, end: Math.min(a + (idx + 1) * PACK_MS, until), until };
}
function usageKey() { return packWindow()?.key ?? monthIST(); }
function usedNow() { return profile && profile.usage_month === usageKey() ? profile.extract_count : 0; }

let limitsLoaded = false;
async function loadProfile() {
  if (!session) { profile = null; return; }
  if (!limitsLoaded) {
    limitsLoaded = true;
    const { data: lim } = await sb.rpc("public_limits");
    applyLimits(lim);
  }
  const { data, error } = await sb.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
  if (!error) profile = data;
  profileLoaded = true;
  await saveSource();
  claimReferral();
  renderAccount();
  renderGate();
  renderLength();
  if (state.step === "patient") renderHome();
}

function isAdmin() {
  return (CONFIG.ADMIN_EMAILS || []).map((x) => x.toLowerCase()).includes((session?.user?.email || "").toLowerCase());
}

function renderAccount() {
  const el = $("#account");
  if (!session) {
    el.innerHTML = `<button class="btn primary small-top" data-signin>Sign in</button>`;
    return;
  }
  const email = session.user.email || "";
  let plan;
  if (isPro()) {
    const kind = profile.plan === "yearly" ? "Pro yearly" : `Pro ${proLimit()}`;
    plan = `${kind} · till ${new Date(profile.pro_until).toLocaleDateString("en-IN")}`;
  } else {
    const used = usedNow();
    plan = `Free · ${Math.max(CONFIG.FREE_MONTHLY_LIMIT - used, 0)}/${CONFIG.FREE_MONTHLY_LIMIT} left`;
  }
  el.innerHTML = `
    <span class="plan-chip">${esc(plan)}</span>
    ${isPro() ? "" : `<button class="btn primary small-top" data-menu="upgrade">Upgrade</button>`}
    <div class="menu-wrap">
      <button class="avatar" id="menuBtn" aria-haspopup="true" aria-expanded="false" aria-label="Account menu">${esc((email[0] || "?").toUpperCase())}</button>
      <div class="menu" id="menu" hidden>
        <div class="menu-head">${esc(email)}<small>${esc(plan)}</small></div>
        ${isAdmin() ? `<a href="admin.html">Admin panel</a>` : ""}
        <button data-menu="activity">My Activity</button>
        <button data-menu="refer">Refer a colleague</button>
        <button data-menu="export">Download my data</button>
        <a href="terms.html">Terms of Use</a>
        <a href="privacy.html">Privacy Policy</a>
        ${waLink() ? `<a id="waMenu" href="${esc(waLink())}" target="_blank" rel="noopener">WhatsApp support</a>` : ""}
        <a href="mailto:${esc(CONFIG.CONTACT_EMAIL || "")}">Contact / grievance</a>
        <button data-menu="signout">Sign out</button>
        <button data-menu="delete" class="danger">Delete account</button>
      </div>
    </div>`;
}

async function saveSource() {
  const r = LS && store.get(LS, SRC_KEY);
  if (!r || !profile) return;
  if (profile.signup_source || Date.now() - r.t > 30 * 86400e3) { store.del(LS, SRC_KEY); return; }
  try {
    const { error } = await sb.rpc("set_signup_source", { p_src: r.s });
    if (!error) { store.del(LS, SRC_KEY); profile.signup_source = r.s; }
  } catch { /* try again next time */ }
}
async function claimReferral() {
  const r = LS && store.get(LS, REF_KEY);
  if (!r || !profile) return;
  if (profile.referred_by || Date.now() - r.t > 30 * 86400e3 || r.c === profile.ref_code) { store.del(LS, REF_KEY); return; }
  try {
    const { error } = await sb.rpc("claim_referral", { p_code: r.c });
    if (!error) store.del(LS, REF_KEY);
  } catch { /* try again next time */ }
}
const bonusLeft = () => (profile?.bonus_until && new Date(profile.bonus_until) > new Date() ? Number(profile.bonus_left) || 0 : 0);

/* ---------- Refer a colleague ---------- */
async function showReferral() {
  const box = document.createElement("div");
  box.className = "ask-wrap no-print";
  box.innerHTML = `<div class="ask activity refer" role="dialog" aria-modal="true"><div class="act-head"><b>Refer a colleague</b><button class="btn small" data-a="close" aria-label="Close">✕</button></div>
    <div class="act-body"><p class="muted">Loading…</p></div></div>`;
  document.body.appendChild(box);
  box.addEventListener("click", async (e) => {
    if (e.target === box || e.target.closest("[data-a=close]")) return box.remove();
    const c = e.target.closest("[data-a=copy]");
    if (c) { try { await navigator.clipboard.writeText(c.dataset.link); toast("Link copied."); } catch { toast("Couldn't copy. Press and hold the link to copy it.", true); } }
  });
  try {
    const { data: r, error } = await sb.rpc("my_referrals");
    if (error || !r) throw error;
    const link = `https://dischargeai.in/?ref=${r.code}`;
    const msg = `I've been using Discharge AI for my discharge summaries: click photos of the case file and get a ready draft in your department's format in about a minute. Try it free: ${link}`;
    const q = Number(r.qualified) || 0, waiting = Math.max((Number(r.joined) || 0) - q, 0);
    const goal = q < 5 ? 5 : Math.min(q + 1, 10);
    const pct = Math.min(100, Math.round(q < 5 ? (q / 5) * 100 : (Math.min(q, 10) / 10) * 100));
    const next = q < 5 ? `${5 - q} more for <b>50 free discharges</b>` : q < 10 ? `Each new referral adds <b>+10 discharges</b> (up to 10 referrals)` : `You've reached the maximum: <b>100 bonus discharges</b> earned. Thank you!`;
    const until = r.bonus_until ? new Date(r.bonus_until).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "";
    box.querySelector(".act-body").innerHTML = `
      <p class="ref-lead">Share your link. When a colleague signs up and completes <b>2 discharges</b>, it counts as a referral.</p>
      <table class="ref-table"><tr><td>5 referrals</td><td>50 free discharges</td></tr><tr><td>Each referral from 6 to 10</td><td>+10 discharges</td></tr><tr><td>10 referrals (maximum)</td><td>100 discharges in total</td></tr></table>
      <div class="ref-progress"><div class="act-row"><span><b>${q}</b> referral${q === 1 ? "" : "s"} counted</span><span>${q >= 10 ? "10 / 10" : `${q} / ${goal}`}</span></div>
        <div class="meter"><i style="width:${pct}%"></i></div><small>${next}</small>
        ${waiting ? `<small>Waiting: ${waiting} colleague${waiting > 1 ? "s have" : " has"} signed up but not yet finished 2 discharges.</small>` : ""}
        ${r.earned ? `<small>Earned: ${r.earned} bonus discharges · <b>${Number(r.bonus_left) || 0} left</b>${until ? `, valid till ${esc(until)}` : ""}. Bonus discharges are used after your ${isPro() ? "pack" : "monthly"} allowance runs out.</small>` : ""}</div>
      <div class="ref-link"><input readonly value="${esc(link)}" aria-label="Your referral link" /><button class="btn" data-a="copy" data-link="${esc(link)}">Copy</button></div>
      <a class="btn primary wa-share" href="https://wa.me/?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">Share on WhatsApp</a>
      <p class="act-foot">Your colleague gets the usual free plan. A referral counts only for a new account, once. See the Terms of Use.</p>`;
  } catch {
    box.querySelector(".act-body").innerHTML = `<p class="muted">Couldn't load your referral link. Check the connection and try again.</p>`;
  }
}

async function signOut() {
  if (LS) store.del(LS, NAMES_KEY); // on-device patient names for My Activity
  await sb.auth.signOut();
  try { SS?.clear(); } catch { /* ignore */ }
  location.reload();
}

async function exportMyData() {
  busy("Preparing your data");
  try {
    const [{ data: prof }, { data: tpls }, { data: acc }] = await Promise.all([
      sb.from("profiles").select("*").eq("id", session.user.id).maybeSingle(),
      sb.from("templates").select("name,data,is_default,created_at,updated_at").order("created_at"),
      sb.from("terms_acceptances").select("version,attestation,accepted_at").order("accepted_at"),
    ]);
    const out = { exported_at: new Date().toISOString(), account: { email: session.user.email, ...prof }, templates: tpls || [], terms_acceptances: acc || [],
      note: "This is everything Discharge AI stores about you. No patient data is stored." };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }));
    a.download = "discharge-ai-my-data.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch {
    toast("Could not export. Please try again.", true);
  } finally {
    busy(false);
  }
}

async function deleteAccount() {
  if (!confirm("Delete your account permanently? Your templates and settings will be erased and any Pro subscription cancelled without refund of the current period. This cannot be undone.")) return;
  const typed = prompt('Type DELETE to confirm.');
  if (typed !== "DELETE") return toast("Account not deleted.");
  busy("Deleting account");
  try {
    await api("account", { action: "delete", confirm: "DELETE" });
    try { SS?.clear(); LS?.clear(); } catch { /* ignore */ }
    await sb.auth.signOut().catch(() => {});
    alert("Your account has been deleted.");
    location.reload();
  } catch (e) {
    handleApiError(e);
  } finally {
    busy(false);
  }
}

function onAccountClick(e) {
  if (e.target.closest("#menuBtn")) {
    const m = $("#menu"); m.hidden = !m.hidden;
    $("#menuBtn").setAttribute("aria-expanded", String(!m.hidden));
    return;
  }
  const act = e.target.closest("[data-menu]")?.dataset.menu;
  if (!act) return;
  const m = $("#menu"); if (m) m.hidden = true;
  if (act === "upgrade") upgrade();
  if (act === "export") exportMyData();
  if (act === "activity") showActivity();
  if (act === "refer") showReferral();
  if (act === "signout") signOut();
  if (act === "delete") deleteAccount();
}

/* ---------- Terms gate ---------- */
const termsOk = () => Number(profile?.terms_version || 0) >= Number(CONFIG.TERMS_VERSION || 1);

function renderGate() {
  const signedIn = !!session;
  const needTerms = signedIn && profile !== undefined && profileLoaded && !termsOk();
  $("#landing").hidden = signedIn;
  $("#termsGate").hidden = !needTerms;
  $("#app").hidden = !signedIn || needTerms || !profileLoaded;
}

async function acceptTerms() {
  const attest = Object.fromEntries($$("[data-attest]").map((c) => [c.dataset.attest, c.checked]));
  if (!Object.values(attest).every(Boolean)) return;
  busy("Saving");
  try {
    const { error } = await sb.rpc("accept_terms", {
      p_version: Number(CONFIG.TERMS_VERSION || 1),
      p_attest: { ...attest, terms_updated: CONFIG.TERMS_UPDATED, ua: navigator.userAgent.slice(0, 200) },
    });
    if (error) throw error;
    await loadProfile();
    toast("Thank you. You're all set.");
  } catch (e) {
    toast(e.message || "Could not save. Please try again.", true);
  } finally {
    busy(false);
  }
}

let profileLoaded = false;
function renderAuth() {
  renderAccount();
  renderGate();
  if (session) { loadProfile(); loadTemplates(); }
}

async function signIn() {
  const { error } = await sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: location.origin + location.pathname },
  });
  if (error) toast(error.message, true);
}

/* ============================================================
   API
   ============================================================ */
// The server gives up after ~150 s, so never leave the doctor watching a spinner longer than that.
const API_TIMEOUT = { extract: 200000, template: 140000 };
const NET_MSG = "The upload didn't reach our server - the mobile network seems slow or dropped. Please check your connection and tap the button again. A failed read is not counted against your allowance. If it keeps happening, try Wi-Fi.";
// When Google sheds traffic ("high demand"), wait and try again by itself instead of failing.
// Every busy attempt is refunded on the server, so the doctor is never charged for it.
const BUSY_WAITS = [8, 15, 25, 40]; // seconds between automatic retries (~1.5 min in total)
async function api(fn, body, { quiet = false } = {}) {
  for (let i = 0; ; i++) {
    try {
      return await apiOnce(fn, body);
    } catch (e) {
      if (!e.busy || i >= BUSY_WAITS.length || (quiet && i >= 1)) {
        if (e.busy) e.message = "Server is experiencing high demand. Nothing was charged. Please try again in a few minutes.";
        throw e;
      }
      const wait = BUSY_WAITS[i];
      if (!quiet) toast(`Server is experiencing high demand - retrying automatically in ${wait} s (attempt ${i + 2} of ${BUSY_WAITS.length + 1}). Nothing is charged for busy attempts.`, false, wait * 1000);
      await new Promise((ok) => setTimeout(ok, wait * 1000));
    }
  }
}
async function apiOnce(fn, body) {
  const { data: s } = await sb.auth.getSession();
  if (!s.session) throw Object.assign(new Error("Please sign in again."), { status: 401 });
  const payload = JSON.stringify(body);
  const send = async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), API_TIMEOUT[fn] || 90000);
    try {
      return await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/${fn}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${s.session.access_token}`,
          apikey: CONFIG.SUPABASE_ANON_KEY,
        },
        body: payload,
        signal: ctl.signal,
      });
    } finally { clearTimeout(timer); }
  };
  let r;
  try {
    r = await send();
  } catch (e) {
    if (e.name === "AbortError") throw Object.assign(new Error(NET_MSG), { status: 0, network: true });
    // A dropped connection fails fast: try once more before giving up.
    try { await new Promise((ok) => setTimeout(ok, 1500)); r = await send(); }
    catch { throw Object.assign(new Error(NET_MSG), { status: 0, network: true }); }
  }
  let out = {};
  try { out = await r.json(); } catch { /* non-JSON */ }
  if (!r.ok) throw Object.assign(new Error(out.error || `Request failed (${r.status})`), { status: r.status, busy: out.code === "busy" });
  return out;
}

function handleApiError(e) {
  if (e.status === 428) {
    toast(e.message, true, 6000);
    if (profile) profile.terms_version = 0;
    renderGate();
  } else if (e.status === 402) {
    toast(e.message, true, 6000);
    if (!isPro()) setTimeout(upgrade, 600);
  } else {
    toast(e.message || "Something went wrong.", true, 6000);
  }
}

/* ============================================================
   Payments (Razorpay)
   ============================================================ */
function loadScript(src) {
  return new Promise((res, rej) => {
    if ([...document.scripts].some((s) => s.src === src)) return res();
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = () => rej(new Error("Could not load payment window."));
    document.head.appendChild(s);
  });
}

function upgrade() {
  clearTimeout(groupTimer); hideGroupInvite(); // never cover the payment sheet
  const feats = CONFIG.PRO_FEATURES || [];
  $("#planFeatures").innerHTML = feats.map((f) => `<li>${esc(f)}</li>`).join("");
  $("#plans").innerHTML = plansView().map((p) => `
    <button class="plan ${p.best && p.enabled ? "best" : ""} ${p.enabled ? "" : "soon"}" ${p.enabled ? `data-plan="${esc(p.id)}"` : "disabled"}>
      ${!p.enabled ? '<span class="tag soon-tag">Coming soon</span>' : p.best ? '<span class="tag">Most popular</span>' : ""}
      <span><span class="pn">${esc(p.name)}</span>${p.label ? ` <span class="offer">${esc(p.label)}</span>` : ""}<br><span class="pnote">${esc(p.note || "")}</span></span>
      <span class="pp">${p.priceHtml} <small>${esc(p.per || "")}</small></span>
    </button>`).join("");
  $("#planModal").hidden = false;
}

async function choosePlan(planId) {
  const plan = plansView().find((p) => p.id === planId);
  $("#planModal").hidden = true;
  busy("Opening payment");
  try {
    const r = await api("checkout", { action: "create", plan: planId });
    await loadScript("https://checkout.razorpay.com/v1/checkout.js");
    busy(false);
    const rz = new window.Razorpay({
      key: r.key_id,
      order_id: r.order_id,
      amount: r.amount,
      currency: r.currency || "INR",
      name: CONFIG.APP_NAME,
      description: plan ? `Pro ${plan.name.toLowerCase()}: ${r.days} days` : "Pro",
      prefill: { email: session?.user?.email || "" },
      theme: { color: "#0f4c4a" },
      // Show UPI first (most Indian users pay this way); other methods stay available.
      config: { display: { blocks: { upi: { name: "Pay with UPI", instruments: [{ method: "upi" }] } }, sequence: ["block.upi"], preferences: { show_default_blocks: true } } },
      handler: async (resp) => {
        busy("Activating Pro");
        try {
          await api("checkout", { action: "verify", order_id: resp.razorpay_order_id, payment_id: resp.razorpay_payment_id, signature: resp.razorpay_signature });
          await loadProfile();
          toast(isPro() ? "Pro is active. Thank you!" : "Payment received. Activating Pro…", false, 6000);
          if (!isPro()) pollPro();
        } catch (e) {
          toast("Payment received. Pro will activate within a few minutes.", false, 7000);
          pollPro();
        } finally { busy(false); }
      },
    });
    rz.open();
  } catch (e) {
    handleApiError(e);
  } finally {
    busy(false);
  }
}

async function pollPro(tries = 12) {
  await loadProfile();
  if (isPro()) return toast("Pro is active. Thank you!");
  if (tries > 0) setTimeout(() => pollPro(tries - 1), 3000);
  else toast("Payment is processing. Pro will show up shortly; refresh in a minute.", false, 7000);
}

/* ============================================================
   Templates — storage & selection
   ============================================================ */
async function loadTemplates() {
  const { data, error } = await sb.from("templates").select("id,name,data,is_default,updated_at").order("created_at");
  if (error) { console.warn(error); return; }
  state.templates = data || [];
  // First visit on this device: pick the user's default template if they have one.
  if (!store.get(LS, "dai_last_tpl")) {
    const def = state.templates.find((t) => t.is_default);
    if (def) setTemplate(def.id, { quiet: true });
  }
  if (!isBuiltin(state.patient.templateId) && !state.templates.some((t) => t.id === state.patient.templateId)) {
    setTemplate("default", { quiet: true });
  }
  renderTemplatePicker();
  $("#tplOnboard").hidden = !(state.templates.length === 0 && !store.get(LS, "dai_tpl_onboarded"));
  if (state.step === "templates") renderTemplateList();
}

function templateById(id) {
  if (isBuiltin(id)) return clone(builtinById(id));
  const row = state.templates.find((t) => t.id === id);
  return row ? { ...normaliseTemplate(row.data), id: row.id, name: row.name } : clone(DEFAULT_TEMPLATE);
}
const currentTemplate = () => templateById(state.patient.templateId);

function setTemplate(id, { quiet = false } = {}) {
  const changed = id !== state.patient.templateId;
  state.patient.templateId = id;
  store.set(LS, "dai_last_tpl", id);
  const tpl = currentTemplate();
  if (tpl.department) { state.patient.dept = tpl.department; const d = $("#p_dept"); if (d) d.value = tpl.department; }
  if (changed && state.draft && !quiet) {
    state.draft = null; state.draftTemplate = null; state.docHtml = null;
    toast("Template changed. Write the summary again to use it.");
  }
  renderTemplatePicker();
  saveCase();
}

function renderTemplatePicker() {
  const sel = $("#p_template");
  const mine = state.templates.map((t) => `<option value="${t.id}">${esc(t.name)}${t.is_default ? " ★" : ""}</option>`).join("");
  sel.innerHTML = (mine ? `<optgroup label="My templates">${mine}</optgroup>` : "") +
    [["Medical departments", (t) => t.group !== "surgical"], ["Surgical departments", (t) => t.group === "surgical"]].map(([label, f]) =>
      `<optgroup label="${label}">${BUILTIN_TEMPLATES.filter(f).map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</optgroup>`).join("") +
    `<option value="__manage">＋ New / manage templates…</option>`;
  const id = state.patient.templateId;
  sel.value = isBuiltin(id) || state.templates.some((t) => t.id === id) ? (id || "default") : "default";
}

/* ============================================================
   Templates — manager & editor
   ============================================================ */
const ed = { id: null, photos: [], tpl: null };

function renderTemplateList() {
  const items = [];
  for (const t of state.templates) {
    const n = (t.data?.sections || []).length;
    items.push(`<div class="tpl-item"><span class="nm">${esc(t.name)}${t.is_default ? '<span class="badge">Default</span>' : ""}
      <span class="meta">${n} sections · updated ${new Date(t.updated_at).toLocaleDateString("en-IN")}</span></span>
      <button class="btn small" data-use="${t.id}">${state.patient.templateId === t.id ? "In use ✓" : "Use"}</button>
      <button class="btn small" data-edit="${t.id}">Edit</button></div>`);
  }
  if (items.length) items.unshift(`<h3 class="sub">My templates</h3>`);
  let lastGroup = null;
  for (const t of BUILTIN_TEMPLATES) {
    const g = t.group === "surgical" ? "Built-in: surgical departments" : "Built-in: medical departments";
    if (g !== lastGroup) { items.push(`<h3 class="sub">${g}</h3>`); lastGroup = g; }
    items.push(`<div class="tpl-item"><span class="nm">${esc(t.name)}<span class="meta">Built-in · ${esc(t.department)}</span></span>
      <button class="btn small" data-use="${t.id}">${state.patient.templateId === t.id ? "In use ✓" : "Use"}</button>
      <button class="btn small" data-copy="${t.id}">Copy &amp; edit</button></div>`);
  }
  $("#tplList").innerHTML = items.join("");
  $("#tplListView").hidden = false;
  $("#tplEditor").hidden = true;
}

function openEditor({ id = null, tpl = null, name = "" } = {}) {
  ed.id = id; ed.photos = []; ed.tpl = tpl ? clone(tpl) : null;
  $("#tplClean").checked = false;
  $("#tplEdTitle").textContent = id ? "Edit template" : "New template";
  $("#tplName").value = name;
  $("#tplText").value = "";
  $("#tplIsDefault").checked = id ? !!state.templates.find((t) => t.id === id)?.is_default : state.templates.length === 0;
  $("#tplListView").hidden = true;
  $("#tplEditor").hidden = false;
  $("#tplDelete").hidden = !id;
  showEditorStage(ed.tpl ? "structure" : "source");
  renderTplPhotos();
  if (state.step !== "templates") showStep("templates", { keepEditor: true });
}

function showEditorStage(stage) {
  const structure = stage === "structure";
  $("#tplSource").hidden = structure;
  $("#tplStructure").hidden = !structure;
  $("#tplSave").hidden = !structure;
  $("#tplRedo").hidden = !structure;
  if (structure) renderTplStructure();
}

function renderTplPhotos() {
  $("#tplPhotos").innerHTML = ed.photos.map((p, i) => `
    <div class="photo ${idDone(p) ? "" : "needs-id"}" data-id="${p.id}">
      <img src="${p.url}" alt="Template photo ${i + 1}" />
      <div class="row"><button class="btn small danger" data-tact="del">✕ Remove</button></div>
      ${idRow(p, "tact")}
    </div>`).join("");
}

function renderTplStructure() {
  const t = ed.tpl;
  $("#tplTitle").value = t.title || "";
  $("#tplDept").value = t.department || "";
  const kindOpts = (k) => Object.entries(KINDS).map(([v, d]) => `<option value="${v}" ${v === k ? "selected" : ""}>${esc(d.label)}</option>`).join("");
  $("#tplSections").innerHTML = t.sections.map((s, i) => {
    const K = KINDS[s.kind] || KINDS.narrative;
    return `<div class="sec-card ${K.ai ? "ai" : ""}" data-i="${i}">
      <div class="sec-top">
        <span class="n">${i + 1}</span><input data-f="heading" value="${esc(s.heading)}" placeholder="Heading (leave empty for none)" />
        <select data-f="kind">${kindOpts(s.kind)}</select>
      </div>
      ${K.guidance ? `<label>${esc(K.guidanceHint || "How to write it: model sentences with [placeholders]")}<textarea data-f="guidance" rows="${s.kind === "narrative" ? 6 : 3}">${esc(s.guidance)}</textarea></label>` : ""}
      ${K.fields ? `<label>${esc(K.fieldsHint)}<input data-f="fields" value="${esc((s.fields || []).join(", "))}" /></label>` : ""}
      ${s.kind === "treatment_given" ? `<label class="inline"><input type="checkbox" data-f="optional" ${s.optional ? "checked" : ""} /> Optional (tick on the summary screen to include)</label>` : ""}
      <div class="sec-actions">
        <button class="btn small" data-sact="up" ${i === 0 ? "disabled" : ""}>▲</button>
        <button class="btn small" data-sact="down" ${i === t.sections.length - 1 ? "disabled" : ""}>▼</button>
        <button class="btn small danger" data-sact="del">Remove</button>
      </div>
    </div>`;
  }).join("");
}

function onTplSectionInput(e) {
  const card = e.target.closest(".sec-card");
  const f = e.target.dataset.f;
  if (!card || !f) return;
  const s = ed.tpl.sections[+card.dataset.i];
  if (f === "fields") s.fields = e.target.value.split(",").map((x) => x.trim()).filter(Boolean);
  else if (f === "optional") s.optional = e.target.checked;
  else s[f] = e.target.value;
  if (f === "kind" && e.type === "change") renderTplStructure();
}

function onTplSectionClick(e) {
  const act = e.target.dataset.sact;
  const card = e.target.closest(".sec-card");
  if (!act || !card) return;
  const i = +card.dataset.i, arr = ed.tpl.sections;
  if (act === "del") arr.splice(i, 1);
  if (act === "up" && i > 0) [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
  if (act === "down" && i < arr.length - 1) [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]];
  renderTplStructure();
}

async function analyseTemplate() {
  const text = $("#tplText").value.trim();
  if (!text && !ed.photos.length) return toast("Paste your template or add a photo first.", true);
  const pending = ed.photos.filter((p) => !idDone(p)).length;
  if (pending) return toast(`${pending} photo(s) still need "Mask IDs" or "No IDs".`, true, 6000);
  if (!$("#tplClean").checked) {
    $("#tplClean").closest("label").scrollIntoView({ behavior: "smooth", block: "center" });
    return toast("Please confirm you have removed patient identifiers.", true);
  }
  busy("Reading your format");
  try {
    const r = await api("template", { text: scrubText(text), images: ed.photos.map((p) => ({ mime: "image/jpeg", data: p.url.split(",")[1] })) });
    ed.tpl = normaliseTemplate(r.template);
    if (!$("#tplName").value.trim()) $("#tplName").value = (ed.tpl.department || "My format").slice(0, 80);
    showEditorStage("structure");
    toast("Format read. Check the sections, then save.");
  } catch (e) {
    handleApiError(e);
  } finally {
    busy(false);
  }
}

async function saveTemplate() {
  const name = $("#tplName").value.trim();
  if (!name) { $("#tplName").focus(); return toast("Give the template a name.", true); }
  ed.tpl.title = $("#tplTitle").value.trim() || "DISCHARGE SUMMARY";
  ed.tpl.department = $("#tplDept").value.trim();
  const data = normaliseTemplate(ed.tpl);
  if (!data.sections.some((s) => KINDS[s.kind].ai)) return toast("Add at least one section for the AI to write (paragraphs, diagnosis or advice).", true);
  const is_default = $("#tplIsDefault").checked;
  busy("Saving template");
  try {
    const q = ed.id
      ? sb.from("templates").update({ name, data, is_default }).eq("id", ed.id).select("id").single()
      : sb.from("templates").insert({ name, data, is_default }).select("id").single();
    const { data: row, error } = await q;
    if (error) throw new Error(error.message);
    await loadTemplates();
    setTemplate(row.id, { quiet: !ed.id });
    if (ed.id && state.draftTemplate) { state.draft = null; state.draftTemplate = null; state.docHtml = null; }
    store.set(LS, "dai_tpl_onboarded", true);
    $("#tplOnboard").hidden = true;
    toast("Template saved and selected.");
    renderTemplateList();
  } catch (e) {
    toast(e.message || "Could not save.", true);
  } finally {
    busy(false);
  }
}

async function deleteTemplate() {
  if (!ed.id || !confirm("Delete this template? Summaries already printed are not affected.")) return;
  const { error } = await sb.from("templates").delete().eq("id", ed.id);
  if (error) return toast(error.message, true);
  if (state.patient.templateId === ed.id) setTemplate("default", { quiet: true });
  await loadTemplates();
  renderTemplateList();
  toast("Template deleted.");
}

/* ============================================================
   Steps
   ============================================================ */
function showStep(step, { keepEditor = false } = {}) {
  if (step === "review" && !state.data) step = "photos";
  if (step === "final" && !state.draft) step = state.data ? "review" : "photos";
  state.step = step;
  for (const s of ["patient", "photos", "review", "final", "templates"]) $(`#step-${s}`).hidden = s !== step;
  $("#stepper").hidden = step === "patient" || step === "templates";
  if (step === "patient") renderHome();
  if ($("#groupCard") && step !== "final" && step !== "patient") { clearTimeout(groupTimer); hideGroupInvite(); }
  if (step === "final") renderAfterDoc();
  if (step === "photos") { renderOptsSummary(); $("#caseOptions").open = !!store.get(LS, "dai_opts_open", false); }
  $$("#stepper button").forEach((b) => {
    b.classList.toggle("on", b.dataset.step === step);
    b.disabled = (b.dataset.step === "review" && !state.data) || (b.dataset.step === "final" && !state.draft);
  });
  if (step === "templates" && !keepEditor) renderTemplateList();
  if (step === "review") { renderReview(); $("#tabInv").checked = !!state.patient.tabulate; }
  if (step === "final") { renderDocIfNeeded(); renderRxChecks(); }
  saveCase();
  window.scrollTo({ top: 0 });
}

/* ============================================================
   Step 1 — patient
   ============================================================ */
function fillPatientForm() {
  for (const f of PATIENT_FIELDS) {
    const el = $(`#p_${f}`);
    if (el) el.value = state.patient[f] ?? "";
  }
  renderLength();
  // Leave empty so the department read from the sheets can be used; show the template's as a hint.
  $("#p_dept").placeholder = `From the sheets, else "${currentTemplate().department || CONFIG.DEFAULT_DEPARTMENT || ""}"`;
  if (state.patient.dept === (currentTemplate().department || CONFIG.DEFAULT_DEPARTMENT)) { state.patient.dept = ""; $("#p_dept").value = ""; }
  renderTemplatePicker();
}
function bindPatientForm() {
  for (const f of PATIENT_FIELDS) {
    const el = $(`#p_${f}`);
    el?.addEventListener("input", () => { state.patient[f] = el.value; state.docHtml = null; saveCase(); });
  }
  $("#p_template").addEventListener("change", (e) => {
    setTimeout(renderOptsSummary, 0);
    if (e.target.value === "__manage") { renderTemplatePicker(); return showStep("templates"); }
    setTemplate(e.target.value);
  });
  $("#manageTplBtn").addEventListener("click", () => showStep("templates"));
  $("#obDefault").addEventListener("click", () => { store.set(LS, "dai_tpl_onboarded", true); $("#tplOnboard").hidden = true; });
  $("#obSetup").addEventListener("click", () => { store.set(LS, "dai_tpl_onboarded", true); $("#tplOnboard").hidden = true; openEditor(); });
}

/* ============================================================
   Step 2 — photos
   ============================================================ */
function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}

async function compress(file, max = 1600, quality = 0.75) {
  let src;
  try {
    src = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    const url = URL.createObjectURL(file);
    try { src = await loadImage(url); } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  const w = src.width, h = src.height;
  const s = Math.min(1, max / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * s); c.height = Math.round(h * s);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, 0, 0, c.width, c.height);
  src.close?.();
  return c.toDataURL("image/jpeg", quality);
}

let adding = false; // stops two quick picks from both seeing the same free space
/* ============================================================
   In-page camera (getUserMedia). The phone's camera app can make Android close Chrome's tab
   on low-memory phones ("Unable to complete previous operation due to low memory"), losing
   the photo. Shooting inside the page avoids that and lets doctors snap pages back to back.
   ============================================================ */
const canInPageCam = () => !!(navigator.mediaDevices?.getUserMedia) && window.isSecureContext;
const cam = { stream: null, files: [], room: 0, done: null, nativeSel: "", track: null, torch: false };
async function openCam(room, done, nativeSel) {
  if (room <= 0) return toast(`Maximum ${MAX_CASE_PHOTOS} photos. Remove one to add another.`, true);
  Object.assign(cam, { files: [], room, done, nativeSel, torch: false });
  $("#camStrip").innerHTML = ""; updateCamCount();
  $("#camModal").hidden = false;
  document.body.classList.add("cam-open");
  try {
    cam.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 } },
    });
    const v = $("#camVideo");
    v.srcObject = cam.stream;
    await v.play().catch(() => {});
    cam.track = cam.stream.getVideoTracks()[0];
    const caps = cam.track.getCapabilities?.() || {};
    $("#camTorch").hidden = !caps.torch;
    // Continuous autofocus where supported (sharper handwriting).
    if (caps.focusMode?.includes?.("continuous")) cam.track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
  } catch (e) {
    console.warn("camera", e);
    closeCam(false);
    toast(e?.name === "NotAllowedError" ? "Camera permission was blocked. Opening the phone camera instead." : "Opening the phone camera instead.", false, 4000);
    $(nativeSel)?.click();
  }
}
function updateCamCount() {
  const n = cam.files.length;
  $("#camCount").textContent = `${n} page${n === 1 ? "" : "s"}${n >= cam.room ? " · maximum reached" : ""}`;
  $("#camDone").disabled = !n;
  $("#camDone").textContent = n ? `Done (${n})` : "Done";
  $("#camShutter").disabled = n >= cam.room;
}
async function snapCam() {
  if (!cam.track || cam.files.length >= cam.room) return;
  $("#camShutter").disabled = true;
  const fl = $("#camFlash"); fl.classList.remove("go"); void fl.offsetWidth; fl.classList.add("go");
  try {
    let blob = null;
    // Full-resolution still where the browser supports it (Chrome on Android); else a video frame.
    if ("ImageCapture" in window) {
      try { blob = await Promise.race([new ImageCapture(cam.track).takePhoto(), new Promise((_, no) => setTimeout(() => no(new Error("slow")), 4000))]); } catch { blob = null; }
    }
    const src = blob ? await createImageBitmap(blob) : $("#camVideo");
    const w0 = blob ? src.width : src.videoWidth, h0 = blob ? src.height : src.videoHeight;
    const k = Math.min(1, 2600 / Math.max(w0, h0));
    const c = document.createElement("canvas");
    c.width = Math.round(w0 * k); c.height = Math.round(h0 * k);
    c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
    if (blob) src.close?.();
    const out = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.9));
    const file = new File([out], `page-${Date.now()}.jpg`, { type: "image/jpeg" });
    cam.files.push(file);
    const t = document.createElement("img");
    t.src = URL.createObjectURL(out);
    $("#camStrip").appendChild(t);
    $("#camStrip").scrollLeft = 1e6;
  } catch (e) {
    console.warn(e); toast("Could not take the photo. Try again.", true);
  } finally { updateCamCount(); }
}
function closeCam(deliver) {
  cam.stream?.getTracks().forEach((t) => t.stop());
  cam.stream = null; cam.track = null;
  $("#camVideo").srcObject = null;
  $$("#camStrip img").forEach((i) => URL.revokeObjectURL(i.src));
  $("#camModal").hidden = true;
  document.body.classList.remove("cam-open");
  const files = cam.files; cam.files = [];
  if (deliver && files.length) cam.done?.(files);
}

async function addFiles(files, target, limit, kind) {
  const list = [...files].filter((f) => f.type.startsWith("image/"));
  if (!list.length || adding) return false;
  const room = limit - target.length;
  if (room <= 0) { toast(`Maximum ${limit} photos. Remove one to add another.`, true); return false; }
  adding = true;
  busy(`Preparing ${Math.min(list.length, room)} photo(s)`);
  try {
    for (const f of list.slice(0, room)) target.push({ id: uid(), kind, url: await compress(f) });
  } catch {
    toast("Could not open one of the photos.", true);
  } finally {
    busy(false);
    adding = false;
  }
  if (list.length > room) toast(`You picked ${list.length}. Only ${room} added — the limit is ${limit} photos per patient.`, true, 6000);
  return true;
}

// Every photo must be masked, or explicitly confirmed as showing no identifiers, before it is sent.
const idDone = (p) => p.masked || p.clean;
const idRow = (p, attr) => `<div class="row id-row">
  <button class="btn small ${p.masked ? "on" : ""}" data-${attr}="mask">${p.masked ? "Masked ✓" : "Mask IDs"}</button>
  <button class="btn small ${p.clean ? "on" : ""}" data-${attr}="clean" ${p.masked ? "disabled" : ""}>${p.clean ? "No IDs ✓" : "No IDs"}</button>
</div>`;

const MAX_CASE_PHOTOS = 30;
const LONG_FILE = 15; // 15+ pages are read as Detailed automatically
// Patients used by one read: 1–14 pages 1 (Detailed 2); exactly 15 pages 2; 16–30 pages 3. Must match fn-extract.ts.
function effLength(n = state.photos.length) { return n >= LONG_FILE ? "detailed" : state.patient.length || "standard"; }
function readUnits(n = state.photos.length) { return n > LONG_FILE ? 3 : effLength(n) === "detailed" ? 2 : 1; }
const unitsText = (u) => `${u} patient${u > 1 ? "s" : ""}`;
function renderPhotos() {
  if ($("#lenNote")) renderLength();
  const box = $("#photoList");
  const n = state.photos.length, full = n >= MAX_CASE_PHOTOS;
  $("#photoCount").textContent = `${n} / ${MAX_CASE_PHOTOS} photos${full ? " — limit reached" : n >= LONG_FILE ? ` · long file: read as Detailed, uses ${unitsText(readUnits(n))}` : ""}`;
  $("#photoCount").classList.toggle("full", full);
  for (const id of ["#camBtn", "#galBtn"]) $(id).classList.toggle("off", full);
  $("#camInput").disabled = full; $("#galInput").disabled = full;
  const pending = state.photos.filter((p) => !idDone(p)).length;
  $("#noIdsAll").hidden = pending < 2;
  $("#noIdsAll").textContent = `No IDs on ${pending} pages`;
  if (!state.photos.length) {
    box.innerHTML = `<div class="empty">No photos yet. Add progress notes, investigation reports and the treatment chart.</div>`;
    return;
  }
  box.innerHTML = state.photos.map((p, i) => `
    <div class="photo ${idDone(p) ? "" : "needs-id"}" data-id="${p.id}">
      <img src="${p.url}" alt="Photo ${i + 1}" data-act="view" />
      <div class="row">
        <span class="pg-no">Page ${i + 1}</span>
        <button class="btn small" data-act="rotate" aria-label="Rotate 90°" title="Rotate so the writing is upright">⟳</button>
        <button class="btn small" data-act="up" ${i === 0 ? "disabled" : ""} aria-label="Move earlier">◀</button>
        <button class="btn small" data-act="down" ${i === state.photos.length - 1 ? "disabled" : ""} aria-label="Move later">▶</button>
        <button class="btn small danger" data-act="del" aria-label="Remove">✕</button>
      </div>
      ${idRow(p, "act")}
    </div>`).join("");
}

function onPhotoAction(e) {
  const card = e.target.closest(".photo");
  const act = e.target.dataset.act;
  if (!card || !act) return;
  const i = state.photos.findIndex((p) => p.id === card.dataset.id);
  const p = state.photos[i];
  if (e.type === "change" && act === "kind") { p.kind = e.target.value; return; }
  if (e.type !== "click") return;
  if (act === "view") openLightbox(p, `Page ${i + 1}`);
  if (act === "mask") openMask(p, renderPhotos);
  if (act === "rotate") rotatePhoto(p).then(renderPhotos);
  if (act === "clean") { p.clean = !p.clean; renderPhotos(); }
  if (act === "del") { state.photos.splice(i, 1); renderPhotos(); }
  if (act === "up" && i > 0) { [state.photos[i - 1], state.photos[i]] = [state.photos[i], state.photos[i - 1]]; renderPhotos(); }
  if (act === "down" && i < state.photos.length - 1) { [state.photos[i + 1], state.photos[i]] = [state.photos[i], state.photos[i + 1]]; renderPhotos(); }
}

// Rotate a photo 90° clockwise so the AI reads the writing upright (sideways pages are read much worse).
async function rotatePhoto(p) {
  const img = await loadImage(p.url);
  const c = document.createElement("canvas");
  c.width = img.naturalHeight; c.height = img.naturalWidth;
  const ctx = c.getContext("2d");
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  p.url = c.toDataURL("image/jpeg", 0.8);
}

/* ---------- Masking tool ---------- */
const mask = { photo: null, img: null, rects: [], cur: null, onDone: null };

async function openMask(photo, onDone) {
  mask.photo = photo; mask.onDone = onDone;
  mask.img = await loadImage(photo.url);
  mask.rects = []; mask.cur = null;
  const c = $("#maskCanvas");
  c.width = mask.img.naturalWidth; c.height = mask.img.naturalHeight;
  $("#maskModal").hidden = false;
  requestAnimationFrame(() => {
    const wrap = $(".mask-wrap").getBoundingClientRect();
    const s = Math.min((wrap.width - 16) / c.width, (wrap.height - 16) / c.height, 1);
    c.style.width = `${c.width * s}px`; c.style.height = `${c.height * s}px`;
    drawMask();
  });
}

function drawMask(preview = true) {
  const c = $("#maskCanvas"), ctx = c.getContext("2d");
  ctx.drawImage(mask.img, 0, 0);
  ctx.fillStyle = "#000";
  for (const r of mask.rects) ctx.fillRect(r.x, r.y, r.w, r.h);
  if (preview && mask.cur) {
    ctx.fillStyle = "rgba(0,0,0,.6)";
    ctx.fillRect(mask.cur.x, mask.cur.y, mask.cur.w, mask.cur.h);
  }
}

function maskPoint(e) {
  const c = $("#maskCanvas"), b = c.getBoundingClientRect();
  return { x: (e.clientX - b.left) * (c.width / b.width), y: (e.clientY - b.top) * (c.height / b.height) };
}

function bindMask() {
  const c = $("#maskCanvas");
  let start = null;
  c.addEventListener("pointerdown", (e) => { start = maskPoint(e); c.setPointerCapture(e.pointerId); });
  c.addEventListener("pointermove", (e) => {
    if (!start) return;
    const p = maskPoint(e);
    mask.cur = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
    drawMask();
  });
  const end = () => {
    if (mask.cur && mask.cur.w > 4 && mask.cur.h > 4) mask.rects.push(mask.cur);
    mask.cur = null; start = null; drawMask();
  };
  c.addEventListener("pointerup", end);
  c.addEventListener("pointercancel", end);
  $("#maskUndo").addEventListener("click", () => { mask.rects.pop(); drawMask(); });
  $("#maskCancel").addEventListener("click", () => ($("#maskModal").hidden = true));
  $("#maskDone").addEventListener("click", () => {
    if (mask.rects.length) {
      drawMask(false);
      mask.photo.url = c.toDataURL("image/jpeg", 0.85);
      mask.photo.masked = true;
      mask.photo.clean = false;
      mask.onDone?.();
    }
    $("#maskModal").hidden = true;
  });
}

/* ---------- Lightbox ---------- */
function openLightbox(p, title) {
  if (!p) return;
  $("#lbImg").src = p.url;
  $("#lbTitle").textContent = title;
  $(".lb-wrap").classList.remove("zoom");
  $("#lightbox").hidden = false;
}

/* ---------- Extract ---------- */
const ARR_KEYS = ["allergies", "operations", "past_events", "held_drugs", "pending_investigations", "known_case_of", "chief_complaints", "diagnoses", "investigations", "imaging_and_other_tests", "events", "daily_progress", "medications", "unclear_items"];
function normalise(d) {
  d = d && typeof d === "object" ? d : {};
  for (const k of ARR_KEYS) if (!Array.isArray(d[k])) d[k] = [];
  d.admission_examination = d.admission_examination || {};
  d.condition_at_last_note = d.condition_at_last_note || {};
  d.medications.forEach((m) => { m.on_discharge = !!m.on_discharge; });
  return d;
}

// Cheap fingerprint of the current pages (count, order, rotation/masking change the data URL).
const photoSig = () => state.photos.map((p) => `${p.url.length}:${p.url.slice(-24)}`).join("|");
function minsAgo(t) {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "less than a minute ago" : m === 1 ? "1 minute ago" : m < 120 ? `${m} minutes ago` : "earlier";
}
/* Small in-page dialog (instead of confirm()) with a clear primary action. Resolves "primary" | "secondary" | null. */
function askChoice({ title, text, primary, secondary, danger = false }) {
  return new Promise((resolve) => {
    const box = document.createElement("div");
    box.className = "ask-wrap no-print";
    box.innerHTML = `<div class="ask" role="dialog" aria-modal="true"><b>${esc(title)}</b><p>${esc(text)}</p>
      <div class="ask-actions"><button class="btn primary" data-a="primary">${esc(primary)}</button>
      <button class="btn${danger ? " ask-danger" : ""}" data-a="secondary">${esc(secondary)}</button></div></div>`;
    const done = (v) => { box.remove(); resolve(v); };
    box.addEventListener("click", (e) => { const a = e.target.closest("[data-a]"); if (a) done(a.dataset.a); else if (e.target === box) done(null); });
    document.body.appendChild(box);
    box.querySelector("[data-a=primary]").focus();
  });
}

async function extract() {
  if (!state.photos.length) return toast("Add at least one photo first.", true);
  if (state.data) {
    // Re-reading is a full new (paid) AI read. Steer doctors back to Review unless pages really changed.
    const cost = `${readUnits()} more patient${readUnits() > 1 ? "s" : ""}`;
    const changed = state.readSig && photoSig() !== state.readSig;
    const ago = state.readAt ? minsAgo(state.readAt) : "";
    const choice = await askChoice(changed
      ? { title: "Pages changed: read again?",
          text: `You added, removed or rotated pages since they were read${ago ? ` (${ago})` : ""}. Reading again uses ${cost} from your allowance and replaces the data you reviewed.`,
          primary: "Read again", secondary: "← Go to Review" }
      : { title: "These pages are already read",
          text: `They were read${ago ? ` ${ago}` : " already"}. Reading the same pages again replaces the data you reviewed (free within an hour of the first read; after that it uses ${cost}). Corrections can be made on the Review screen instead.`,
          primary: "← Go to Review", secondary: "Read again anyway", danger: true });
    const readAgain = changed ? choice === "primary" : choice === "secondary";
    if (!readAgain) { if (choice) showStep("review"); return; }
  }
  const pending = state.photos.filter((p) => !idDone(p)).length;
  if (pending) {
    renderPhotos();
    $(".photo.needs-id")?.scrollIntoView({ behavior: "smooth", block: "center" });
    return toast(`${pending} photo(s) still need "Mask IDs" or "No IDs" before reading.`, true, 6000);
  }
  const n = state.photos.length;
  const length = effLength(n), units = readUnits(n);
  if (units > 1) {
    const left = patientsLeft();
    if (left !== null && left < units && !state.data) {
      return toast(`This read uses ${unitsText(units)}${n >= LONG_FILE ? ` (${n} pages)` : " (Detailed)"}, but only ${left} left. ${n >= LONG_FILE ? "Remove some pages or upgrade." : "Choose Concise or Standard."}`, true, 7000);
    }
    const why = n > LONG_FILE ? `${n} pages: a long file is read as Detailed and` : n === LONG_FILE ? "15 pages: read as Detailed and" : "Detailed";
    if (!confirm(`${why} uses ${unitsText(units)} from your allowance${left !== null ? ` (${left} left)` : ""}. Continue?`)) return;
  }
  busyStages([[`Uploading ${n} page${n > 1 ? "s" : ""}`, 3 + n * 0.4], ["Reading handwriting and reports", 8 + n * 1.6],
    ["Putting events in date order", 6 + n * 0.8], ["Checking drugs, doses and dates", 5 + n * 0.5], ["Almost done", 30]],
    "Keep this screen open until it finishes. Switching to another app can stop the read.");
  const lock = await wakeLock();
  try {
    const r = await api("extract", {
      case_id: state.caseId || newCaseId(),
      length,
      images: await uploadImages(),
    });
    if (r.free_reread) toast("Same pages read again within the hour, not counted against your allowance.", false, 5000);
    state.data = normalise(r.data);
    state.draft = null; state.draftTemplate = null; state.docHtml = null;
    state.readLength = length; // how carefully the photos were read
    if (length === "detailed" && state.patient.length !== "detailed") { state.patient.length = "detailed"; renderLength(); } // long file: write Detailed too
    state.readAt = Date.now(); state.readSig = photoSig();
    const P = state.patient;
    if (/^(male|female)$/i.test(state.data.sex || "")) state.data.sex = state.data.sex[0].toUpperCase() + state.data.sex.slice(1).toLowerCase();
    if (!P.doa && state.data.admission_date) P.doa = state.data.admission_date;
    if (!P.dod && state.data.discharge_date) P.dod = state.data.discharge_date;
    fillPatientForm();
    $("#medConfirm").checked = false;
    loadProfile();
    showStep("review");
    pre = null; preCount = 0;
    setTimeout(prefetchDraft, 300);
  } catch (e) {
    handleApiError(e);
  } finally {
    lock?.release?.().catch(() => {});
    busy(false);
  }
}

// Photos to send. Long files (16+ pages) are sent a little smaller so the upload stays about the
// same size as a 15-page file; handwriting stays readable at this resolution.
async function uploadImages() {
  const long = state.photos.length > LONG_FILE;
  const out = [];
  for (const p of state.photos) {
    let url = p.url;
    if (long) {
      try { url = await compress(await (await fetch(p.url)).blob(), 1400, 0.7); } catch { /* send as is */ }
    }
    out.push({ mime: "image/jpeg", data: url.split(",")[1], kind: p.kind });
  }
  return out;
}

// Keep the phone screen on while a read runs, so the answer isn't lost to a locked screen.
async function wakeLock() {
  try { return await navigator.wakeLock?.request("screen"); } catch { return null; }
}

/* ============================================================
   Step 3 — review
   ============================================================ */
const SECTIONS = [
  { title: "Case story (read from the photos)", note: "The whole case in date order, as read from the photos. The summary is written mainly from this, so check dates, cycles, drugs and doses here.", fields: [
    { k: "case_story", label: "Case story", type: "text", span: 2, rows: 14 },
  ] },
  { title: "Patient (from photos)", fields: [
    { k: "age", label: "Age" }, { k: "sex", label: "Sex" },
    { k: "admission_date", label: "Admission date (orders the timeline)" }, { k: "discharge_date", label: "Discharge date" },
    { k: "department", label: "Treating department (from the sheets)", span: 2 },
  ] },
  { title: "Diagnosis", fields: [
    { k: "diagnoses", label: "Diagnoses (one per line, most important first)", type: "lines" },
    { k: "known_case_of", label: "Known case of / habits (one per line)", type: "lines" },
  ] },
  { title: "Presentation", fields: [
    { k: "chief_complaints", label: "Chief complaints with duration (one per line)", type: "lines" },
    { k: "history_of_present_illness", label: "History of present illness", type: "text", span: 2, rows: 4 },
    { k: "relevant_negative_history", label: "Relevant negative history", type: "text", span: 2 },
    { k: "past_history_and_medications", label: "Past history & medications", type: "text", span: 2 },
  ] },
  { title: "Past history (dated)", table: "past_events", note: "Earlier illnesses, admissions, procedures and long-term treatment. Write when it happened (e.g. 2019, 03/2026, 8 years back) so the story starts in the right order.", cols: [
    { k: "when", label: "When", w: 110 }, { k: "detail", label: "What happened", area: true },
  ] },
  { title: "On admission", obj: "admission_examination", fields: [
    { k: "general_condition_sensorium", label: "General condition / sensorium", type: "text", span: 2 },
    { k: "bp", label: "BP" }, { k: "pulse", label: "Pulse" }, { k: "rr", label: "RR" },
    { k: "temperature", label: "Temperature" }, { k: "spo2", label: "SpO₂" }, { k: "gcs", label: "GCS" },
    { k: "general_examination", label: "General examination", type: "text", span: 2 },
    { k: "cvs", label: "CVS", type: "text" }, { k: "rs", label: "RS", type: "text" },
    { k: "abdomen", label: "Abdomen", type: "text" }, { k: "cns", label: "CNS", type: "text" },
  ] },
  { title: "Investigations", table: "investigations", note: "Keep each report's own date. Reports dated before admission are told as earlier investigations in the story.", cols: [
    { k: "date", label: "Date", w: 90 }, { k: "test", label: "Test" }, { k: "value", label: "Value", w: 90 },
    { k: "unit", label: "Unit", w: 80 }, { k: "flag", label: "H/L", w: 46 },
  ] },
  { title: "Imaging & other tests", table: "imaging_and_other_tests", cols: [
    { k: "date", label: "Date", w: 90 }, { k: "test", label: "Test", w: 150 }, { k: "finding", label: "Finding", area: true },
  ] },
  { title: "Operations & deliveries", table: "operations", note: "One row per operation, delivery or bedside procedure in this admission. The operative / delivery section of the summary is written from this.", cols: [
    { k: "date", label: "Date", w: 90 }, { k: "procedure", label: "Operation / procedure", w: 170 }, { k: "anaesthesia", label: "Anaesthesia", w: 100 },
    { k: "details", label: "Findings, implants, drains, specimen, baby details", area: true },
  ] },
  { title: "Significant events & procedures", table: "events", cols: [
    { k: "date", label: "Date / time", w: 120 }, { k: "description", label: "Event", area: true },
  ] },
  { title: "Daily progress", table: "daily_progress", cols: [
    { k: "date", label: "Date", w: 90 }, { k: "note", label: "Note", area: true },
  ] },
  { title: "Medications", table: "medications", note: "Tick “On discharge” for drugs to continue at home. The printed lists are built from this table exactly as you leave it.", cols: [
    { k: "form", label: "Form", w: 64 }, { k: "drug", label: "Drug" }, { k: "dose", label: "Dose", w: 80 },
    { k: "route", label: "Route", w: 60 }, { k: "frequency", label: "Freq", w: 70 },
    { k: "dates", label: "Dates / duration", w: 120 }, { k: "on_discharge", label: "On discharge", bool: true, w: 70 },
  ] },
  { title: "Allergies & drugs to avoid (documented)", table: "allergies", note: "Only what is written in the file or what you add. Used to check the discharge list.", cols: [
    { k: "drug", label: "Drug / class", w: 160 }, { k: "reaction", label: "Reaction / reason", area: true },
  ] },
  { title: "Drugs on hold", table: "held_drugs", cols: [
    { k: "drug", label: "Drug", w: 160 }, { k: "reason", label: "Reason / until", area: true },
  ] },
  { title: "Discharge plan", fields: [
    { k: "pending_investigations", label: "Reports awaited (one per line)", type: "lines" },
    { k: "follow_up_plan", label: "Follow-up plan", type: "text", span: 2 },
  ] },
  { title: "Condition at last note", obj: "condition_at_last_note", fields: [
    { k: "status", label: "Status", type: "text", span: 2 },
    { k: "bp", label: "BP" }, { k: "pulse", label: "Pulse" }, { k: "rr", label: "RR" }, { k: "spo2", label: "SpO₂" },
    { k: "other", label: "Other (feeds, ambulation, urine output…)", type: "text", span: 2 },
  ] },
];

const unclearCls = (v) => (/\[\?\]/.test(String(v ?? "")) ? " unclear" : "");

function fieldHtml(f, val, attrs) {
  const v = f.type === "lines" ? (val || []).join("\n") : (val ?? "");
  const cls = unclearCls(v);
  const rows = f.type === "lines" ? Math.max(2, (val || []).length + 1) : f.type === "text" ? (f.rows || 2) : 1;
  const ctl = f.type ? `<textarea rows="${rows}" ${attrs} class="${cls}">${esc(v)}</textarea>` : `<input ${attrs} class="${cls}" value="${esc(v)}" />`;
  return `<label class="${f.span === 2 || f.type === "lines" ? "span2" : ""}">${esc(f.label)}${ctl}</label>`;
}

function renderReview() {
  if (state.data) state.data = normalise(state.data); // older saved cases may lack newer fields
  const d = state.data;
  $("#thumbStrip").innerHTML = state.photos.length
    ? state.photos.map((p, i) => `<img src="${p.url}" data-i="${i}" alt="Photo ${i + 1}" />`).join("")
    : `<p class="hint">Photos are not kept after a page reload. Re-add them if you need to compare.</p>`;

  renderAttention();
  // Keep sections the doctor opened open when the form re-renders (e.g. after "+ Add row").
  const wasOpen = new Set($$("#reviewForm details[open]").map((x) => x.dataset.sec));
  let html = "";
  for (const s of SECTIONS) {
    // Collapsed by default; open the ones that most need a look.
    const val = s.table ? d[s.table] : s.obj ? d[s.obj] : Object.fromEntries(s.fields.map((f) => [f.k, d[f.k]]));
    const unclear = /\[\?\]/.test(JSON.stringify(val ?? ""));
    const count = s.table ? (d[s.table] || []).length : null;
    const key = s.table || s.obj || s.fields?.[0]?.k || "";
    const open = wasOpen.has(key) || unclear || s.table === "medications" || s.fields?.some((f) => f.k === "case_story");
    html += `<details class="rv-section" ${open ? "open" : ""} data-sec="${esc(s.table || s.obj || s.fields?.[0]?.k || "")}">
      <summary><h3>${esc(s.title)}</h3>${count !== null ? `<span class="sec-count">${count}</span>` : ""}${unclear ? `<span class="sec-flag">check [?]</span>` : ""}</summary>`;
    if (s.note) html += `<p class="hint">${esc(s.note)}</p>`;
    if (s.table) {
      const rows = d[s.table];
      html += `<div class="tbl-wrap"><table class="edit"><thead><tr>${s.cols.map((c) => `<th style="${c.w ? `width:${c.w}px` : ""}">${esc(c.label)}</th>`).join("")}<th style="width:32px"></th></tr></thead><tbody>`;
      rows.forEach((row, ri) => {
        html += "<tr>" + s.cols.map((c) => {
          const a = `data-table="${s.table}" data-row="${ri}" data-col="${c.k}"`;
          if (c.bool) return `<td class="chk"><input type="checkbox" ${a} ${row[c.k] ? "checked" : ""} /></td>`;
          const v = row[c.k] ?? "";
          return c.area
            ? `<td><textarea rows="${Math.min(10, Math.max(2, Math.ceil(String(v).length / 70)))}" ${a} class="${unclearCls(v)}">${esc(v)}</textarea></td>`
            : `<td><input ${a} class="${unclearCls(v)}" value="${esc(v)}" /></td>`;
        }).join("") + `<td><button class="x" data-del="${s.table}" data-row="${ri}" aria-label="Delete row">×</button></td></tr>`;
      });
      html += `</tbody></table></div><button class="btn small" data-add="${s.table}">+ Add row</button>`;
    } else {
      const src = s.obj ? d[s.obj] : d;
      html += `<div class="grid">${s.fields.map((f) => fieldHtml(f, src[f.k], `data-obj="${s.obj || ""}" data-k="${f.k}" data-type="${f.type || ""}"`)).join("")}</div>`;
    }
    html += `</details>`;
  }
  html += `<details class="rv-section" data-sec="timeline" ${wasOpen.has("timeline") ? "open" : ""}><summary><h3>Timeline (detected from dates)</h3></summary><p class="hint">This is the order the summary will follow. If something is in the wrong place, fix its date above.</p><div id="timeline" class="timeline"></div></details>`;
  $("#reviewForm").innerHTML = html;
  renderTimeline();
  renderRxChecks();
}
/* ---------- "Needs your attention" — what the doctor must look at before writing ---------- */
function renderAttention() {
  const d = state.data;
  const box = $("#attention");
  if (!d || !box) return;
  const items = [];
  if (d.unclear_items.length) items.push(`<div class="att-item warn"><b>${d.unclear_items.length} unclear reading${d.unclear_items.length > 1 ? "s" : ""}</b><ul>${
    d.unclear_items.map((u) => `<li><b>${esc(u.where)}</b>${u.reading ? `: “${esc(u.reading)}”` : ""} — ${esc(u.reason)}</li>`).join("")}</ul></div>`);
  const dis = d.medications.filter((m) => m.on_discharge && String(m.drug || "").trim());
  items.push(`<div class="att-item ${dis.length ? "" : "warn"}"><b>Discharge drugs (${dis.length})</b>${dis.length
    ? `<ol>${dis.map((m) => `<li>${esc([m.form, m.drug, m.dose, m.route, m.frequency, m.dates].filter(Boolean).join(" "))}</li>`).join("")}</ol>`
    : `<p>None ticked "On discharge" — the discharge list will be empty.</p>`}
    <button class="btn small" data-goto="medications">Edit medications</button></div>`);
  const held = d.held_drugs.filter((h) => h.drug);
  if (held.length) items.push(`<div class="att-item"><b>Drugs on hold</b><p>${held.map((h) => esc(h.drug + (h.reason ? ` (${h.reason})` : ""))).join("; ")}</p></div>`);
  const sug = suggestBuiltin(d.department);
  const cur = state.patient.templateId || "default";
  if (sug && isBuiltin(cur) && sug !== cur && !(sug === "bi-onco" && cur === "bi-daycare")) {
    const b = builtinById(sug);
    items.push(`<div class="att-item"><b>Department: ${esc(d.department)}</b><p>You are using the ${esc(builtinById(cur).name)} format.</p>
      <button class="btn small" data-usetpl="${b.id}">Use the ${esc(b.name)} format</button></div>`);
  }
  if (!d.admission_date) items.push(`<div class="att-item warn"><b>No admission date read</b><p>Add it under "Patient (from photos)" so the story is in the right order.</p></div>`);
  box.innerHTML = `<h3 class="att-head">Needs your attention</h3>${items.join("")}`;
}
function openSection(key) {
  const sec = $(`#reviewForm details[data-sec="${key}"]`);
  if (!sec) return;
  sec.open = true;
  setTimeout(() => sec.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
}

/* ---------- Prescribing aids: lab panel + consistency check (code only, no AI, no advice) ---------- */
function rxChecksHtml(where) {
  const d = state.data;
  if (!d) return "";
  const p = labPanel(d);
  const { issues, checked } = consistencyIssues(d);
  const dismissed = new Set(d._dismissed || []);
  const open = issues.filter((i) => !dismissed.has(i.id));
  const kept = issues.length - open.length;
  const chip = (x) => `<span class="lab ${x.flag ? "ab" : ""}"><b>${esc(x.label)}</b> ${esc(x.value)}${x.flag ? ` <i>${x.flag}</i>` : ""}${x.trend ? ` <small>${esc(x.trend)}</small>` : ""}${x.date ? ` <small>(${esc(x.date)})</small>` : ""}</span>`;

  let html = `<div class="rx-box">
    <div class="rx-head"><b>Before you finalise the discharge drugs</b><span class="rx-tag">Hints only — not a complete safety check</span></div>
    <div class="rx-sub">Latest results in this file</div>
    <div class="labs">${p.abnormal.length ? p.abnormal.map(chip).join("") : `<span class="hint" style="margin:0">No abnormal values among the prescribing-relevant tests found.</span>`}</div>`;
  if (p.normal.length) html += `<details class="rx-more"><summary>Within range (${p.normal.length})</summary><div class="labs">${p.normal.map(chip).join("")}</div></details>`;
  if (p.missing.length) html += `<p class="rx-missing">Not found in file: ${p.missing.map(esc).join(", ")}</p>`;
  if (p.allergies.length) html += `<p class="rx-allergy"><b>Documented allergies / avoid:</b> ${p.allergies.map(esc).join("; ")}</p>`;

  html += `<div class="rx-sub">Discharge list vs case file</div>`;
  if (!checked) html += `<p class="hint" style="margin:0">No drugs are ticked "On discharge" yet.</p>`;
  else if (!open.length) html += `<p class="rx-ok">No mismatches with the case file${kept ? ` (${kept} marked intentional)` : ""}. This does not check doses, interactions or suitability.</p>`;
  else html += open.map((i) => `<div class="rx-issue ${i.level}">
      <div>${esc(i.text)}</div>
      <div class="rx-act"><button class="btn small" data-rx="fix">${where === "final" ? "Edit in Review" : "Go to medications"}</button>
      <button class="btn small" data-rx="keep" data-id="${esc(i.id)}">Keep, intentional</button></div></div>`).join("");
  return html + `</div>`;
}
function renderRxChecks() {
  const r = $("#rxReview"), f = $("#rxFinal");
  if (r && state.step === "review") r.innerHTML = rxChecksHtml("review");
  if (f && state.step === "final") f.innerHTML = rxChecksHtml("final");
}
function onRxClick(e) {
  const b = e.target.closest("[data-rx]");
  if (!b || !state.data) return;
  if (b.dataset.rx === "keep") {
    state.data._dismissed = [...new Set([...(state.data._dismissed || []), b.dataset.id])];
    saveCase(); renderRxChecks();
  } else {
    if (state.step !== "review") showStep("review");
    openSection("medications");
  }
}

function renderTimeline() {
  const box = $("#timeline");
  if (!box || !state.data) return;
  const c = buildChronology(state.data);
  if (!c.entries.length && !c.undatedPast.length) { box.innerHTML = `<p class="hint">No dates found yet.</p>`; return; }
  let html = "", last = "";
  if (c.undatedPast.length) html += `<div class="tl-day"><b>Background (undated)</b><ul>${c.undatedPast.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>`;
  const groups = [];
  for (const e of c.entries) {
    if (e.label !== last) { groups.push({ label: e.label, phase: e.phase, items: [] }); last = e.label; }
    groups.at(-1).items.push(e.text);
  }
  html += groups.map((g) => `<div class="tl-day ${g.phase}"><b>${esc(g.label)}</b><ul>${g.items.map((t) => `<li>${esc(t.length > 220 ? t.slice(0, 220) + "…" : t)}</li>`).join("")}</ul></div>`).join("");
  if (c.undated.length) html += `<div class="tl-day"><b>Undated</b><ul>${c.undated.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>`;
  if (c.trends.length) html += `<div class="tl-day trend"><b>Serial trends</b><ul>${c.trends.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>`;
  box.innerHTML = html;
}
let tlTimer;

function onReviewInput(e) {
  const el = e.target, d = state.data;
  if (!d) return;
  if (el.dataset.table) {
    const row = d[el.dataset.table][+el.dataset.row];
    row[el.dataset.col] = el.type === "checkbox" ? el.checked : el.value;
  } else if (el.dataset.k) {
    const target = el.dataset.obj ? d[el.dataset.obj] : d;
    target[el.dataset.k] = el.dataset.type === "lines" ? el.value.split("\n").map((x) => x.trim()).filter(Boolean) : el.value;
  } else return;
  if (el.type !== "checkbox") el.classList.toggle("unclear", /\[\?\]/.test(el.value));
  state.docHtml = null; // data changed → document should be rebuilt
  saveCase();
  clearTimeout(tlTimer); tlTimer = setTimeout(() => { renderTimeline(); renderRxChecks(); renderAttention(); }, 400);
}

function onReviewClick(e) {
  const t = e.target;
  if (t.dataset.add) {
    const sec = SECTIONS.find((s) => s.table === t.dataset.add);
    const row = Object.fromEntries(sec.cols.map((c) => [c.k, c.bool ? false : ""]));
    if (t.dataset.add === "medications") row._manual = true; // typed by hand, not read from photos
    state.data[t.dataset.add].push(row);
    renderReview(); saveCase();
  } else if (t.dataset.del) {
    state.data[t.dataset.del].splice(+t.dataset.row, 1);
    renderReview(); saveCase();
  }
}

/* ---------- Generate ---------- */
/* Everything the writing step needs. Only the reviewed clinical data goes to the AI;
   name and the dates typed on step 1 never leave this device. */
function genPayload() {
  const d = state.data;
  const P = state.patient;
  const { unclear_items, _dismissed, ...rest } = d; // "_" fields are app-only, never sent to the AI
  rest.medications = (rest.medications || []).map(({ _manual, ...m }) => m);
  const caseData = { ...rest, age: d.age || "", sex: d.sex || "", admission_date: d.admission_date || "", discharge_date: d.discharge_date || "",
    chronology: buildChronology(d).text }; // date-ordered backbone for the story
  const tpl = currentTemplate();
  return {
    length: P.length || "standard",
    case: caseData,
    template: { title: tpl.title, department: tpl.department, sections: tpl.sections },
    options: { outcome: P.outcome || "discharged", followup: P.followup || "", monitor: P.monitor || "", extra: P.extra || "", dept: deptName() },
  };
}

/* Background draft: start writing while the doctor reviews. Used only if nothing was changed
   since; otherwise a fresh draft is written. At most 2 per patient to keep cost down. */
let pre = null;
let preCount = 0;
function prefetchDraft() {
  if (!state.data || preCount >= 2) return;
  let body;
  try { body = genPayload(); } catch { return; }
  const key = JSON.stringify(body);
  if (pre && pre.key === key) return;
  preCount++;
  const promise = api("generate", { case_id: state.caseId || newCaseId(), ...body }, { quiet: true });
  promise.catch(() => {}); // a failed background draft just means writing normally later
  pre = { key, promise };
}

async function generate() {
  const d = state.data;
  if (!d) return;
  if (d.medications.length && !$("#medConfirm").checked) {
    $("#medConfirm").closest("label").scrollIntoView({ behavior: "smooth", block: "center" });
    return toast("Please confirm you have checked the medications.", true);
  }
  if (state.docHtml && !confirm("Rewriting will replace your edits in the summary. Continue?")) return;
  const P = state.patient;
  if ((P.outcome || "discharged") === "discharged" && !d.medications.some((m) => m.on_discharge)
    && !confirm('No drugs are ticked "On discharge", so the discharge medication list will be empty. Write the summary anyway?')) return;
  const body = genPayload();
  const template = body.template;
  const key = JSON.stringify(body);
  busyStages([["Preparing the case story", 2], ["Writing history and course", 8], ["Writing advice and follow-up", 5],
    ["Checking facts against your data", 3], ["Almost done", 20]]);
  try {
    // If the draft written in the background was made from exactly this data, use it (instant).
    let r = null;
    if (pre && pre.key === key) r = await pre.promise.catch(() => null);
    pre = null;
    if (!r) r = await api("generate", { case_id: state.caseId || newCaseId(), ...body });
    state.draft = r.data;
    state.fbSent = false;
    state.draftTemplate = template;
    state.docHtml = null;
    $("#optTreatment").checked = (P.outcome || "discharged") !== "discharged";
    setVerified(false);
    showStep("final");
  } catch (e) {
    handleApiError(e);
  } finally {
    busy(false);
  }
}

/* ============================================================
   Step 4 — final document
   ============================================================ */
function updateDocWarn() {
  const doc = $("#doc");
  $$(".opt-inv", doc).forEach((el) => (el.hidden = !state.patient.tabulate));
  $("#invPdfBtn").hidden = !state.patient.tabulate || !$$(".opt-inv table", doc).length;
  const opt = $$(".opt-sec", doc);
  $("#optTreatmentLabel").hidden = !opt.length;
  opt.forEach((el) => (el.hidden = !$("#optTreatment").checked));
  const n = (doc.innerText.match(/_{3,}|\[\?\]/g) || []).length;
  const u = $$("mark.unv", doc).length;
  const w = $("#docWarn");
  w.hidden = !n && !u;
  w.textContent = [
    u ? `${u} date(s)/number(s) not found in your reviewed data are highlighted in orange — check each against the case file.` : "",
    n ? `${n} blank(s) or unclear item(s) still highlighted. Fill or remove them before printing.` : "",
  ].filter(Boolean).join(" ");
}

// Everything the AI was allowed to use: reviewed data, step-1 details and the template's own fixed wording.
function factSourceText() {
  const P = state.patient;
  const tpl = state.draftTemplate || currentTemplate();
  return [JSON.stringify(state.data || {}), P.doa, P.dod, P.followup, P.monitor, P.extra,
    (tpl.sections || []).map((s) => s.guidance).join(" ")].join(" ");
}

function renderDocIfNeeded(force = false) {
  const doc = $("#doc");
  if (!state.draft) return;
  setFactSource(factSourceText());
  doc.innerHTML = !force && state.docHtml
    ? state.docHtml
    : buildDoc({ ...state.patient, dept: deptName(), age: state.data?.age || "", sex: state.data?.sex || "" }, state.data, state.draft, state.draftTemplate || currentTemplate());
  updateDocWarn();
}

const onDocEdit = debounce(() => {
  state.docHtml = $("#doc").innerHTML;
  updateDocWarn();
  saveCase();
}, 500);

// Department for the header and prose: typed on step 1 > read from the sheets > template default.
function deptName() {
  if (state.patient.dept) return state.patient.dept;
  const d = String(state.data?.department || "").trim();
  if (d) return /^department/i.test(d) ? d : `Department of ${d}`;
  return currentTemplate().department || "";
}

/* ---------- Home, usage meter, WhatsApp ---------- */
function usageInfo() {
  if (!profile) return null;
  const pro = isPro();
  const limit = pro ? proLimit() : CONFIG.FREE_MONTHLY_LIMIT;
  const used = usedNow();
  return { pro, limit, used: Math.min(used, limit), left: Math.max(limit - used, 0) };
}
function meterHtml() {
  const u = usageInfo();
  if (!u) return "";
  const pct = u.limit ? Math.round((u.used / u.limit) * 100) : 0;
  const cls = pct >= 100 ? "full" : pct >= 80 ? "warn" : "";
  const plans = plansView().filter((p) => p.enabled).map((p) => `<button class="btn ${p.best ? "primary" : ""}" data-plan="${esc(p.id)}">${esc(p.name)} · ${p.priceHtml}</button>`).join("");
  const daysLeft = u.pro && profile?.pro_until ? Math.ceil((new Date(profile.pro_until) - Date.now()) / 86400e3) : null;
  const renew = daysLeft !== null && daysLeft <= 7;
  const w = packWindow();
  const day = (t) => new Date(t).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  const when = !w ? "resets on the 1st" : w.end >= w.until ? `valid till ${day(w.until)}` : `renews on ${day(w.end)}`;
  return `<div class="meter-top"><b>${u.used} of ${u.limit}</b> patients ${u.pro ? "in this pack" : "this month"}<span>${u.pro ? "Pro" : "Free"}</span></div>
    <div class="meter ${cls}"><i style="width:${Math.min(pct, 100)}%"></i></div>
    <p class="meter-note">${u.left} left${bonusLeft() ? ` + ${bonusLeft()} bonus` : ""} · ${when} <button class="info-btn" data-info="charges" aria-label="How patients are counted">i</button></p>
    ${u.pro && !renew ? "" : `<div class="meter-up"><span>${renew ? `Pro ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}. Renew (days are added on top)` : "Upgrade with UPI, cards or net banking"}</span><div class="plan-btns">${plans}</div></div>`}`;
}
/* "How patients are counted" card, opened from the ⓘ buttons. */
function showChargeInfo() {
  const w = packWindow();
  const day = (t) => new Date(t).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  const renew = !profile ? "" : !w ? "Your free patients reset on the 1st of every month."
    : w.end >= w.until ? `Your pack is valid till ${day(w.until)}. Unused patients don't carry over.`
    : `Your pack renews on ${day(w.end)}. Unused patients don't carry over.`;
  const box = document.createElement("div");
  box.className = "ask-wrap no-print";
  box.innerHTML = `<div class="ask charge-info" role="dialog" aria-modal="true"><b>How patients are counted</b>
    <table><thead><tr><th>Your file</th><th>Counts as</th></tr></thead><tbody>
      <tr><td>1–14 pages, Concise or Standard</td><td>1 patient</td></tr>
      <tr><td>1–14 pages, Detailed</td><td>2 patients</td></tr>
      <tr><td>15 pages (read as Detailed)</td><td>2 patients</td></tr>
      <tr><td>16–30 pages (read as Detailed)</td><td>3 patients</td></tr>
    </tbody></table>
    <ul><li>Rewriting a summary (changing length, template or instructions) is free.</li>
      <li>Reading the same pages again within an hour is free.</li>${renew ? `<li>${esc(renew)}</li>` : ""}</ul>
    <div class="ask-actions"><button class="btn primary" data-a="ok">Got it</button>${profile && !document.querySelector(".ask.activity") ? `<button class="btn" data-a="act">See my activity</button>` : ""}</div></div>`;
  box.addEventListener("click", (e) => {
    const a = e.target.closest("[data-a]");
    if (a || e.target === box) box.remove();
    if (a?.dataset.a === "act") showActivity();
  });
  document.body.appendChild(box);
  box.querySelector("[data-a=ok]").focus();
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-info=charges]");
  if (b) { e.preventDefault(); e.stopPropagation(); showChargeInfo(); }
}, true);

/* ---------- My Activity: discharges and payments ---------- */
async function showActivity(tab = "cases") {
  const box = document.createElement("div");
  box.className = "ask-wrap no-print";
  box.innerHTML = `<div class="ask activity" role="dialog" aria-modal="true"><div class="act-head"><b>My Activity</b><button class="btn small" data-a="close" aria-label="Close">✕</button></div>
    <div class="act-tabs"><button data-tab="cases">Discharges</button><button data-tab="payments">Payments</button></div>
    <div class="act-body"><p class="muted">Loading…</p></div></div>`;
  document.body.appendChild(box);
  const close = () => box.remove();
  let data = null;
  const draw = () => {
    for (const b of box.querySelectorAll("[data-tab]")) b.classList.toggle("on", b.dataset.tab === tab);
    box.querySelector(".act-body").innerHTML = tab === "cases" ? activityCases(data) : activityPayments(data);
  };
  box.addEventListener("click", (e) => {
    if (e.target === box || e.target.closest("[data-a=close]")) return close();
    const t = e.target.closest("[data-tab]"); if (t) { tab = t.dataset.tab; if (data) draw(); }
    if (e.target.closest("[data-info=charges]")) return;
  });
  try {
    const { data: d, error } = await sb.rpc("my_activity", { p_days: 90 });
    if (error) throw error;
    data = d || { cases: [], payments: [] };
    draw();
  } catch {
    box.querySelector(".act-body").innerHTML = `<p class="muted">Couldn't load your activity. Check the connection and try again.</p>`;
  }
}
function activityCases(d) {
  const u = usageInfo(), w = packWindow();
  const day = (t) => new Date(t).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  const top = u ? `<p class="act-sum">${u.pro ? "This pack" : "This month"}: <b>${u.used} of ${u.limit}</b> used · ${!w ? "resets on the 1st" : w.end >= w.until ? `valid till ${day(w.until)}` : `renews ${day(w.end)}`} <button class="info-btn" data-info="charges" aria-label="How patients are counted">i</button></p>` : "";
  if (!d.cases.length) return `${top}<p class="muted">No discharges in the last 90 days.</p>`;
  const names = (LS && store.get(LS, NAMES_KEY, {})) || {};
  const when = (t) => new Date(t).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const rows = d.cases.map((c) => {
    const name = names[c.case_id]?.n;
    const notes = [
      c.paid_reads > 1 ? `read ${c.paid_reads} times` : "",
      c.free_reads ? `${c.free_reads} free re-read${c.free_reads > 1 ? "s" : ""}` : "",
      c.failed_reads ? `${c.failed_reads} failed read${c.failed_reads > 1 ? "s" : ""}, not counted` : "",
      c.writes > 1 ? `rewritten ${c.writes - 1}× (free)` : "",
    ].filter(Boolean).join(" · ");
    const used = Number(c.used) || 0;
    return `<li><div class="act-row"><span class="act-name">${name ? esc(name) : "Patient"}</span><span class="act-used ${used ? "" : "zero"}">${used ? `${used} patient${used > 1 ? "s" : ""}` : "Not counted"}</span></div>
      <small>${esc(when(c.at))} · ${c.photos ? `${c.photos} page${c.photos > 1 ? "s" : ""}` : "—"} · ${esc(LENGTH_NAMES[c.length] || "—")}${notes ? ` · ${esc(notes)}` : ""}</small></li>`;
  }).join("");
  return `${top}<ul class="act-list">${rows}</ul><p class="act-foot">Last 90 days. Patient names are shown only on the phone where you typed them; they are never stored on our server.</p>`;
}
function activityPayments(d) {
  if (!d.payments.length) return `<p class="muted">No payments yet.</p>`;
  const names = { pro100: "Pro 100", monthly: "Pro 300", yearly: "Pro yearly", manual: "Pro" };
  const rows = d.payments.map((p) => {
    const days = p.days || (p.plan === "yearly" ? 365 : 30);
    return `<li><div class="act-row"><span class="act-name">${esc(names[p.plan] || "Pro")}</span><span class="act-used">₹${(Number(p.amount_paise) / 100).toLocaleString("en-IN")}</span></div>
      <small>${esc(new Date(p.at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }))} · ${days} days · one-time payment</small></li>`;
  }).join("");
  return `<ul class="act-list">${rows}</ul>`;
}

function renderHome() {
  const has = state.photos.length || state.data || state.draft;
  $("#continueBtn").hidden = !has;
  $("#meterCard").innerHTML = meterHtml();
  $("#meterCard").hidden = !profile;
  maybeShowGroupInvite();
}
function waLink() {
  const n = String(CONFIG.WHATSAPP_NUMBER || "").replace(/\D/g, "");
  if (!n) return "";
  const msg = "Hi, I need help with Discharge AI. (Please don't send patient photos or details here.)";
  return `https://wa.me/${n}?text=${encodeURIComponent(msg)}`;
}
function renderWhatsApp() {
  const href = waLink();
  for (const id of ["#waHome", "#waFoot", "#waMenu"]) { const el = $(id); if (el) { el.hidden = !href; if (href) el.href = href; } }
  const g = CONFIG.WHATSAPP_GROUP_URL || "";
  for (const id of ["#waGroupHome", "#waGroupFoot", "#groupJoin"]) { const el = $(id); if (el) { el.hidden = !g; if (g) el.href = g; } }
}
/* After a summary: quick feedback + (until joined/dismissed) the WhatsApp group invite. */
let fbRating = 0;
function renderAfterDoc() {
  fbRating = 0;
  $("#fbMore").hidden = true; $("#fbThanks").hidden = true; $("#fbComment").value = "";
  $$("#fbBox .fb-btn").forEach((b) => { b.classList.remove("on"); b.disabled = false; });
  $("#fbBox").hidden = !!state.fbSent;
  maybeShowGroupInvite();
}
/* WhatsApp group invite (until the doctor taps Join):
   - after EVERY summary, ~2.5 s after it appears;
   - on the home screen (signed in), at most once a day. */
let groupTimer = null;
function maybeShowGroupInvite() {
  clearTimeout(groupTimer);
  if (!CONFIG.WHATSAPP_GROUP_URL || !profile || store.get(LS, "dai_grp2_joined", false)) return;
  const step = state.step;
  const today = new Date().toISOString().slice(0, 10);
  if (step === "patient" && store.get(LS, "dai_grp2_day", "") === today) return;
  groupTimer = setTimeout(() => {
    if (state.step !== step || !$("#busy").hidden || !$("#planModal").hidden || document.querySelector(".ask-wrap")) return;
    if (step === "patient") store.set(LS, "dai_grp2_day", today);
    const el = $("#groupCard");
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add("show"));
  }, 2500);
}
function hideGroupInvite() {
  const el = $("#groupCard");
  if (!el) return;
  el.classList.remove("show");
  setTimeout(() => { if (!el.classList.contains("show")) el.hidden = true; }, 300);
}
function laterGroupInvite() { hideGroupInvite(); } // asks again after the next summary
async function sendFeedback() {
  const comment = $("#fbComment").value.trim().slice(0, 600);
  try {
    const { error } = await sb.from("feedback").insert({ rating: fbRating, comment: comment || null, template: (currentTemplate().name || "").slice(0, 80) });
    if (error) throw error;
    state.fbSent = true;
    $("#fbMore").hidden = true; $("#fbThanks").hidden = false;
    $$("#fbBox .fb-btn").forEach((b) => (b.disabled = true));
  } catch (e) {
    console.warn(e); toast("Could not send feedback. Please try again.", true);
  }
}
function renderOptsSummary() {
  const tpl = currentTemplate();
  const out = { discharged: "Discharged", lama: "LAMA", dama: "DAMA", referred: "Referred", expired: "Expired" }[state.patient.outcome || "discharged"];
  $("#optsSummary").textContent = `${LENGTH_NAMES[state.patient.length || "standard"]} · ${out} · ${tpl.name || "Built-in format"}`;
}

// Live progress: honest stages based on typical timings (the AI call itself returns all at once).
function busyStages(stages, note = "") {
  const b = $("#busy");
  clearInterval(busyTimer); clearInterval(stageTimer);
  if (!stages) { b.hidden = true; return; }
  const start = Date.now();
  const total = stages.reduce((a, s) => a + s[1], 0);
  const draw = () => {
    const t = (Date.now() - start) / 1000;
    let acc = 0, cur = stages.length - 1;
    for (let i = 0; i < stages.length; i++) { acc += stages[i][1]; if (t < acc) { cur = i; break; } }
    const pct = Math.min(95, Math.round((t / total) * 100));
    $("#busyText").innerHTML = `<ol class="stages">${stages.map((s, i) =>
      `<li class="${i < cur ? "done" : i === cur ? "now" : ""}">${i < cur ? "✓" : i === cur ? "•" : "○"} ${esc(s[0])}</li>`).join("")}</ol>
      <div class="meter"><i style="width:${pct}%"></i></div><small>${Math.round(t)} s</small>${note ? `<p class="busy-note">${esc(note)}</p>` : ""}`;
  };
  draw();
  b.hidden = false;
  stageTimer = setInterval(draw, 500);
}

/* ---------- Summary length (Concise / Standard / Detailed) ---------- */
const LENGTH_NAMES = { concise: "Concise", standard: "Standard", detailed: "Detailed" };
function patientsLeft() {
  if (!profile) return null;
  const lim = isPro() ? proLimit() : CONFIG.FREE_MONTHLY_LIMIT;
  const used = usedNow();
  return Math.max(lim - used, 0) + bonusLeft();
}
function renderLength() {
  const len = state.patient.length || "standard";
  const left = patientsLeft();
  // Detailed needs 2 patients; once photos are read, changing length only affects rewrites (no allowance used).
  const blockDetailed = !state.data && left !== null && left < 2;
  const longFile = state.photos.length >= LONG_FILE && !state.data;
  for (const r of $$('input[name="len"]')) {
    r.checked = r.value === len;
    r.disabled = longFile ? r.value !== "detailed" : r.value === "detailed" && blockDetailed;
    if (longFile) r.checked = r.value === "detailed";
    r.closest(".len").classList.toggle("off", r.disabled);
  }
  if ($("#finalLen")) $("#finalLen").value = len;
  const base = "All lengths keep the diagnosis, key results, every drug change, complications and discharge drugs.";
  $("#lenNote").textContent = longFile ? `${state.photos.length} pages: long files are read as Detailed automatically and use ${unitsText(readUnits())}. ${base}`
    : left === null ? base
    : blockDetailed ? `Only ${left} patient${left === 1 ? "" : "s"} left this month, so Detailed (2 patients) isn't available. ${base}`
    : `${left} patients left this month. ${base}`;
}
function setLength(v) {
  if (!LENGTH_NAMES[v]) return;
  state.patient.length = v;
  store.set(LS, "dai_length", v);
  saveCase();
  renderLength();
  renderOptsSummary();
}

function setVerified(v) {
  $("#finalVerify").checked = v;
  $("#printBtn").disabled = !v;
  $("#copyBtn").disabled = !v;
}

// Random id per patient so the admin panel can add up the AI cost of each discharge. No patient data.
function newCaseId() {
  state.caseId = crypto.randomUUID ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));
  return state.caseId;
}

function clearCase() {
  const { dept, templateId } = state.patient;
  Object.assign(state, { patient: { outcome: "discharged", dept, templateId }, photos: [], data: null, draft: null, draftTemplate: null, docHtml: null });
  if (SS) store.del(SS, CASE_KEY);
  fillPatientForm(); renderPhotos(); $("#doc").innerHTML = "";
  setVerified(false);
  state.caseId = null; state.readLength = null; state.readAt = null; state.readSig = null;
  renderLength(); // next patient gets a fresh id
}

function newPatient() {
  if (!confirm("Clear this patient from this device and start a new one?")) return;
  clearCase();
  showStep("patient");
}

/* ============================================================
   Landing
   ============================================================ */
function renderLanding() {
  const free = CONFIG.FREE_MONTHLY_LIMIT;
  $("#freeLine").textContent = `Free for ${free} patients a month`;
  $("#yr").textContent = new Date().getFullYear();
  $("#contactLink").href = `mailto:${CONFIG.CONTACT_EMAIL || ""}`;
  const plans = plansView();
  const freeCard = `<div class="price-card">
      <h3>Free</h3><div class="price">₹0</div><p class="pnote">To try it out</p>
      <ul><li>${free} patients a month</li><li>Built-in General Medicine format</li><li>All privacy safeguards</li></ul>
      <button class="btn big" data-signin>Start free</button></div>`;
  const pro = plans.map((p) => `<div class="price-card ${p.best && p.enabled ? "best" : ""} ${p.enabled ? "" : "soon"}">
      ${!p.enabled ? '<span class="tag soon-tag">Coming soon</span>' : p.best ? '<span class="tag">Most popular</span>' : ""}
      <h3>${esc(p.name)}${p.label ? ` <span class="offer">${esc(p.label)}</span>` : ""}</h3><div class="price">${p.priceHtml} <small>${esc(p.per || "")}</small></div><p class="pnote">${esc(p.note || "")}</p>
      <ul>${p.limit ? `<li><b>${p.limit} patients a month</b></li>` : ""}${(CONFIG.PRO_FEATURES || []).map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
      ${p.enabled ? `<button class="btn big ${p.best ? "primary" : ""}" data-signin>Get started</button>` : `<button class="btn big" disabled>Coming soon</button>`}</div>`).join("");
  $("#priceGrid").innerHTML = freeCard + pro;
}

async function loadPublicLimits() {
  const { data: lim } = await sb.rpc("public_limits");
  if (lim) { applyLimits(lim); renderLanding(); renderAccount(); if (state.step === "patient") renderHome(); }
}
function applyLimits(lim) {
  if (lim?.free_extract >= 0) CONFIG.FREE_MONTHLY_LIMIT = lim.free_extract;
  if (lim?.pro_extract >= 0) CONFIG.PRO_MONTHLY_LIMIT = lim.pro_extract;
  if (lim?.pricing) CONFIG.PRICING = lim.pricing;
}

/* Plans as shown to doctors: prices and limits come from admin settings (CONFIG.PRICING), with the
   regular price crossed out while an offer runs. A plan switched off in admin shows as "Coming soon".
   Falls back to config.js if prices haven't loaded yet. */
const inr = (n) => "₹" + Math.round(n).toLocaleString("en-IN");
const PLAN_IDS = ["pro100", "monthly", "yearly"];
/** Monthly patient limit for the signed-in Pro user's plan. */
function proLimit() {
  const lim = Number(CONFIG.PRICING?.[profile?.plan]?.limit);
  return lim > 0 ? lim : (CONFIG.PRO_MONTHLY_LIMIT ?? 300);
}
function plansView() {
  const P = CONFIG.PRICING;
  if (!P) return (CONFIG.PLANS || []).map((p) => ({ ...p, priceHtml: esc(p.price), label: "", enabled: true }));
  const today = new Date().toISOString().slice(0, 10);
  const offerOn = !P.offer_ends || today <= P.offer_ends;
  const out = [];
  for (const id of PLAN_IDS) {
    const x = P[id];
    if (!x) continue;
    const price = offerOn && Number(x.price) > 0 ? Number(x.price) : Number(x.list || x.price || 0);
    if (!price) continue;
    const list = Number(x.list) || 0, struck = offerOn && list > price;
    const limit = Number(x.limit) || 300, yearly = id === "yearly";
    out.push({
      id, limit, enabled: x.enabled !== false, best: id === "monthly",
      name: yearly ? "Pro yearly" : `Pro ${limit}`,
      per: yearly ? "/ year" : "/ month",
      price: inr(price), list: struck ? inr(list) : "",
      priceHtml: `${struck ? `<s class="was">${inr(list)}</s> ` : ""}${inr(price)}`,
      label: x.enabled === false ? "" : struck && P.offer_label ? P.offer_label : "",
      note: yearly ? `${limit} patients a month · ≈ ${inr(price / 12)} / month` : `${limit} patients a month · 30 days, one-time payment`,
    });
  }
  return out;
}

/* ============================================================
   Wire up
   ============================================================ */
function bind() {
  $("#appName").textContent = CONFIG.APP_NAME;
  document.addEventListener("click", (e) => { if (e.target.closest("[data-signin]")) signIn(); });
  $("#account").addEventListener("click", onAccountClick);
  document.addEventListener("click", (e) => {
    const m = $("#menu");
    if (m && !m.hidden && !e.target.closest(".menu-wrap")) m.hidden = true;
  });
  $("#termsGate").addEventListener("change", () => {
    $("#termsAccept").disabled = !$$("[data-attest]").every((c) => c.checked);
  });
  $("#termsAccept").addEventListener("click", acceptTerms);
  $("#termsDecline").addEventListener("click", signOut);
  renderLanding();
  $("#stepper").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b && !b.disabled) showStep(b.dataset.step); });
  document.addEventListener("click", (e) => { const g = e.target.closest("[data-go]"); if (g) showStep(g.dataset.go); });

  bindPatientForm();

  // Case photos
  const addCase = async (files) => { if (await addFiles(files, state.photos, MAX_CASE_PHOTOS, "other")) renderPhotos(); };
  // Home: one big button opens the camera; a new case starts from the first photo.
  const startCase = async (files, confirmed = false) => {
    if (!files?.length) return;
    if (!confirmed && (state.photos.length || state.data || state.draft) && !confirm("Start a new patient? The current one will be cleared from this device.")) return;
    if (state.photos.length || state.data || state.draft) clearCase();
    if (await addFiles(files, state.photos, MAX_CASE_PHOTOS, "other")) { renderPhotos(); showStep("photos"); }
  };
  $("#homeCam").addEventListener("change", (e) => { startCase(e.target.files); e.target.value = ""; });
  // Prefer the in-page camera (page stays alive); the phone's camera app is the fallback.
  $("#newPatientBtn").addEventListener("click", (e) => {
    if (e.target.id === "homeCam" || !canInPageCam()) return;
    e.preventDefault();
    if ((state.photos.length || state.data || state.draft) && !confirm("Start a new patient? The current one will be cleared from this device.")) return;
    openCam(MAX_CASE_PHOTOS, (files) => startCase(files, true), "#homeCam");
  });
  $("#camBtn").addEventListener("click", (e) => {
    if (e.target.id === "camInput" || !canInPageCam() || $("#camInput").disabled) return;
    e.preventDefault();
    openCam(MAX_CASE_PHOTOS - state.photos.length, addCase, "#camInput");
  });
  $("#homeGal").addEventListener("change", (e) => { startCase(e.target.files); e.target.value = ""; });
  $("#continueBtn").addEventListener("click", () => showStep(state.draft ? "final" : state.data ? "review" : "photos"));
  $("#noIdsAll").addEventListener("click", () => {
    const pending = state.photos.filter((p) => !idDone(p));
    if (!pending.length) return;
    if (!confirm(`Confirm that none of these ${pending.length} pages shows a name, CR/UHID number, phone, address or other identifier? Pages that do must be masked instead.`)) return;
    pending.forEach((p) => (p.clean = true));
    renderPhotos();
  });
  $("#caseOptions").addEventListener("toggle", () => store.set(LS, "dai_opts_open", $("#caseOptions").open));
  $("#printDetails").addEventListener("input", (e) => {
    const k = e.target.id?.replace(/^p_/, "");
    if (!["name", "doa", "dod"].includes(k)) return;
    state.patient[k] = e.target.value;
    // Update the printed header in place so manual edits in the summary are kept.
    $$(`#doc [data-pf="${k}"]`).forEach((el) => {
      el.innerHTML = e.target.value.trim() ? esc(e.target.value) : '<span class="writein"></span>';
    });
    if (state.docHtml) state.docHtml = $("#doc").innerHTML;
    saveCase();
  });
  $("#camInput").addEventListener("change", (e) => { addCase(e.target.files); e.target.value = ""; });
  $("#galInput").addEventListener("change", (e) => { addCase(e.target.files); e.target.value = ""; });
  $("#photoList").addEventListener("click", onPhotoAction);
  $("#photoList").addEventListener("change", onPhotoAction);
  $("#extractBtn").addEventListener("click", extract);
  bindMask();

  $("#thumbStrip").addEventListener("click", (e) => {
    const i = e.target.dataset.i;
    if (i !== undefined) openLightbox(state.photos[+i], `Photo ${+i + 1} · ${KIND_LABEL[state.photos[+i]?.kind] || ""}`);
  });
  $("#lbClose").addEventListener("click", () => ($("#lightbox").hidden = true));
  $("#lbZoom").addEventListener("click", () => $(".lb-wrap").classList.toggle("zoom"));

  // Review
  $("#reviewForm").addEventListener("input", onReviewInput);
  $("#reviewForm").addEventListener("change", onReviewInput);
  $("#reviewForm").addEventListener("click", onReviewClick);
  $("#generateBtn").addEventListener("click", generate);

  // Final
  $("#doc").addEventListener("input", onDocEdit);
  $("#optTreatment").addEventListener("change", () => { updateDocWarn(); onDocEdit(); });
  $("#regenBtn").addEventListener("click", generate);
  $("#referHome")?.addEventListener("click", showReferral);
  $("#lenPick").addEventListener("change", (e) => { if (e.target.name === "len") setLength(e.target.value); });
  $("#finalLen").addEventListener("change", (e) => {
    setLength(e.target.value);
    if (e.target.value === "detailed" && state.readLength && state.readLength !== "detailed")
      toast(`The photos were read at ${LENGTH_NAMES[state.readLength]} detail. Rewrite works from that; for every value, read the photos again as Detailed.`, false, 7000);
    else toast(`Tap Rewrite to redo the summary as ${LENGTH_NAMES[e.target.value]}. No extra patient is used.`);
  });
  $("#finalVerify").addEventListener("change", (e) => setVerified(e.target.checked));
  $("#rxReview").addEventListener("click", onRxClick);
  $("#fbBox").addEventListener("click", (e) => {
    const b = e.target.closest("[data-rate]");
    if (!b || b.disabled) return;
    fbRating = Number(b.dataset.rate);
    $$("#fbBox .fb-btn").forEach((x) => x.classList.toggle("on", x === b));
    $("#fbMore").hidden = false;
    $("#fbComment").placeholder = fbRating > 0
      ? "Anything you liked or would change? (optional) Please don't type patient names or details."
      : "What should be better? (optional) Please don't type patient names or details.";
    if (fbRating > 0 && !$("#fbComment").value) $("#fbComment").focus();
  });
  $("#fbSend").addEventListener("click", sendFeedback);
  $("#camShutter").addEventListener("click", snapCam);
  $("#camDone").addEventListener("click", () => closeCam(true));
  $("#camClose").addEventListener("click", () => {
    if (cam.files.length && !confirm(`Discard the ${cam.files.length} page(s) you just took?`)) return;
    closeCam(false);
  });
  $("#camNative").addEventListener("click", () => {
    // Pages already taken are kept; the phone camera then only adds more.
    const sel = cam.files.length ? "#camInput" : cam.nativeSel;
    closeCam(true); $(sel)?.click();
  });
  $("#camTorch").addEventListener("click", () => {
    cam.torch = !cam.torch;
    cam.track?.applyConstraints({ advanced: [{ torch: cam.torch }] }).catch(() => {});
    $("#camTorch").classList.toggle("on", cam.torch);
  });
  $("#groupClose").addEventListener("click", laterGroupInvite);
  $("#groupLater").addEventListener("click", laterGroupInvite);
  $("#groupJoin").addEventListener("click", () => { store.set(LS, "dai_grp2_joined", true); setTimeout(hideGroupInvite, 400); });
  // Ticking "I have checked the medications" means review is nearly done: refresh the background draft.
  $("#medConfirm").addEventListener("change", (e) => { if (e.target.checked) prefetchDraft(); });
  // Date-wise investigation table: shown/hidden in the summary without rewriting it (keeps the doctor's edits).
  $("#tabInv").addEventListener("change", (e) => {
    state.patient.tabulate = e.target.checked;
    const doc = $("#doc");
    if (state.docHtml && !$$(".opt-inv", doc).length && doc.innerHTML) state.docHtml = null; // older summary: rebuild once
    saveCase();
  });
  $("#attention").addEventListener("click", (e) => {
    const t = e.target.closest("[data-usetpl]");
    if (t) { setTemplate(t.dataset.usetpl); renderAttention(); renderOptsSummary(); toast(`Using the ${builtinById(t.dataset.usetpl).name} format.`); return; }
    const b = e.target.closest("[data-goto]"); if (b) openSection(b.dataset.goto);
  });
  $("#rxFinal").addEventListener("click", onRxClick);
  $("#copyBtn").addEventListener("click", async () => {
    if (!$("#finalVerify").checked) return;
    try { await navigator.clipboard.writeText($("#doc").innerText); toast("Copied."); }
    catch { toast("Copy failed. Select the text and copy manually.", true); }
  });
  $("#printBtn").addEventListener("click", () => {
    if (!$("#finalVerify").checked) return;
    const left = ($("#doc").innerText.match(/_{3,}|\[\?\]/g) || []).length;
    if (left && !confirm(`${left} blank(s) or unclear item(s) are still in the summary. Print anyway?`)) return;
    const old = document.title;
    document.title = `Discharge summary ${state.patient.dod || ""}`.trim();
    window.print();
    setTimeout(() => {
      document.title = old;
      if (confirm("Done printing? Clear this patient from this device now?")) { clearCase(); showStep("patient"); }
    }, 800);
  });
  // Investigations only, as a separate print / PDF (patient header + the table as edited in the summary).
  $("#invPdfBtn").addEventListener("click", () => {
    const doc = $("#doc"), inv = $(".opt-inv", doc);
    if (!inv) return;
    const out = $("#invPrint");
    const pt = $("table.pt", doc), dept = $(".dept", doc);
    out.innerHTML = `<h1>INVESTIGATIONS</h1>${dept ? dept.outerHTML : ""}${pt ? pt.outerHTML : ""}${inv.innerHTML.replace(/<h2>[^<]*<\/h2>/, "")}`;
    out.hidden = false;
    document.body.classList.add("print-inv");
    const old = document.title;
    document.title = `Investigations ${state.patient.dod || ""}`.trim();
    const done = () => { document.body.classList.remove("print-inv"); out.hidden = true; out.innerHTML = ""; document.title = old; window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done);
    window.print();
    setTimeout(() => { if (document.body.classList.contains("print-inv")) done(); }, 1500);
  });
  $("#newBtn").addEventListener("click", newPatient);

  // Plans
  $("#plans").addEventListener("click", (e) => { const b = e.target.closest("[data-plan]"); if (b) choosePlan(b.dataset.plan); });
  $("#meterCard").addEventListener("click", (e) => { const b = e.target.closest("[data-plan]"); if (b) choosePlan(b.dataset.plan); });
  $("#p_outcome").addEventListener("change", renderOptsSummary);
  renderWhatsApp();
  $("#planClose").addEventListener("click", () => ($("#planModal").hidden = true));
  $("#planModal").addEventListener("click", (e) => { if (e.target.id === "planModal") $("#planModal").hidden = true; });

  // Templates
  $("#tplList").addEventListener("click", (e) => {
    const u = e.target.dataset.use, ed_ = e.target.dataset.edit, cp = e.target.dataset.copy;
    if (cp) { const b = builtinById(cp); openEditor({ tpl: normaliseTemplate(b), name: `My ${b.name} format` }); return; }
    if (u) { setTemplate(u); renderTemplateList(); toast("Template selected."); }
    if (ed_) {
      const row = state.templates.find((t) => t.id === ed_);
      if (row) openEditor({ id: row.id, tpl: normaliseTemplate(row.data), name: row.name });
    }
  });
  $("#tplNew").addEventListener("click", () => openEditor());
  $("#tplFromDefault")?.addEventListener("click", () => {
    const b = builtinById(isBuiltin(state.patient.templateId) ? state.patient.templateId : "default");
    openEditor({ tpl: normaliseTemplate(b), name: `My ${b.name} format` });
  });
  $("#tplCancel").addEventListener("click", renderTemplateList);
  $("#tplRedo").addEventListener("click", () => showEditorStage("source"));
  $("#tplAnalyze").addEventListener("click", analyseTemplate);
  $("#tplSave").addEventListener("click", saveTemplate);
  $("#tplDelete").addEventListener("click", deleteTemplate);
  $("#tplAddSec").addEventListener("click", () => {
    ed.tpl.sections.push({ heading: "New section", kind: "narrative", guidance: "", fields: [] });
    renderTplStructure();
  });
  $("#tplSections").addEventListener("input", onTplSectionInput);
  $("#tplSections").addEventListener("change", onTplSectionInput);
  $("#tplSections").addEventListener("click", onTplSectionClick);
  const addTpl = async (files) => { if (await addFiles(files, ed.photos, 4, "template")) renderTplPhotos(); };
  $("#tplCam").addEventListener("change", (e) => { addTpl(e.target.files); e.target.value = ""; });
  $("#tplGal").addEventListener("change", (e) => { addTpl(e.target.files); e.target.value = ""; });
  $("#tplPhotos").addEventListener("click", (e) => {
    const card = e.target.closest(".photo"), act = e.target.dataset.tact;
    if (!card || !act) return;
    const i = ed.photos.findIndex((p) => p.id === card.dataset.id);
    if (act === "del") { ed.photos.splice(i, 1); renderTplPhotos(); }
    if (act === "mask") openMask(ed.photos[i], renderTplPhotos);
    if (act === "clean") { ed.photos[i].clean = !ed.photos[i].clean; renderTplPhotos(); }
  });

  window.addEventListener("beforeunload", (e) => {
    if (state.photos.length && state.step !== "final") { e.preventDefault(); e.returnValue = ""; }
  });
}

async function init() {
  bind();
  restoreCase();
  fillPatientForm();
  renderPhotos();
  sb.auth.onAuthStateChange((_evt, s) => {
    const changed = !!s !== !!session;
    session = s;
    if (changed) renderAuth();
  });
  const { data } = await sb.auth.getSession();
  session = data.session;
  renderAuth();
  if (!session) loadPublicLimits().catch(() => {});
  showStep(state.step);
}

if (typeof window !== "undefined" && document.getElementById("app")) init();
