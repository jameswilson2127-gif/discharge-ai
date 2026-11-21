import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { CONFIG } from "./config.js?v=7";
import { DEFAULT_TEMPLATE, KINDS, buildDoc, normaliseTemplate, esc } from "./doc.js?v=7";
import { buildChronology } from "./chrono.js?v=7";

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

let busyTimer = null;
function busy(text) {
  const b = $("#busy");
  clearInterval(busyTimer);
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
  patient: { outcome: "discharged", dept: "", templateId: store.get(LS, "dai_last_tpl", "default") },
  photos: [],          // {id, kind, url} — memory only, never persisted
  data: null,          // extracted + reviewed case data
  draft: null,         // AI-written sections
  draftTemplate: null, // template snapshot the draft was written for
  docHtml: null,       // doctor-edited final document
  templates: [],       // user's saved templates (rows from Supabase)
};

const saveCase = debounce(() => {
  if (!SS) return;
  store.set(SS, CASE_KEY, {
    savedAt: Date.now(),
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

let limitsLoaded = false;
async function loadProfile() {
  if (!session) { profile = null; return; }
  if (!limitsLoaded) {
    limitsLoaded = true;
    const { data: lim } = await sb.rpc("public_limits");
    if (lim?.free_extract >= 0) CONFIG.FREE_MONTHLY_LIMIT = lim.free_extract;
  }
  const { data, error } = await sb.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
  if (!error) profile = data;
  profileLoaded = true;
  renderAccount();
  renderGate();
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
    const kind = profile.plan === "yearly" ? "Pro yearly" : "Pro";
    plan = `${kind} · till ${new Date(profile.pro_until).toLocaleDateString("en-IN")}`;
  } else {
    const used = profile && profile.usage_month === monthIST() ? profile.extract_count : 0;
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
        <button data-menu="export">Download my data</button>
        <a href="terms.html">Terms of Use</a>
        <a href="privacy.html">Privacy Policy</a>
        <a href="mailto:${esc(CONFIG.CONTACT_EMAIL || "")}">Contact / grievance</a>
        <button data-menu="signout">Sign out</button>
        <button data-menu="delete" class="danger">Delete account</button>
      </div>
    </div>`;
}

async function signOut() {
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
async function api(fn, body) {
  const { data: s } = await sb.auth.getSession();
  if (!s.session) throw Object.assign(new Error("Please sign in again."), { status: 401 });
  const r = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/${fn}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${s.session.access_token}`,
      apikey: CONFIG.SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  });
  let out = {};
  try { out = await r.json(); } catch { /* non-JSON */ }
  if (!r.ok) throw Object.assign(new Error(out.error || `Request failed (${r.status})`), { status: r.status });
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
  const feats = CONFIG.PRO_FEATURES || [];
  $("#planFeatures").innerHTML = feats.map((f) => `<li>${esc(f)}</li>`).join("");
  $("#plans").innerHTML = (CONFIG.PLANS || []).map((p) => `
    <button class="plan ${p.best ? "best" : ""}" data-plan="${esc(p.id)}">
      ${p.best ? '<span class="tag">Best value</span>' : ""}
      <span><span class="pn">${esc(p.name)}</span><br><span class="pnote">${esc(p.note || "")}</span></span>
      <span class="pp">${esc(p.price)} <small>${esc(p.per || "")}</small></span>
    </button>`).join("");
  $("#planModal").hidden = false;
}

async function choosePlan(planId) {
  const plan = (CONFIG.PLANS || []).find((p) => p.id === planId);
  $("#planModal").hidden = true;
  busy("Opening payment");
  try {
    const r = await api("subscribe", { plan: planId });
    await loadScript("https://checkout.razorpay.com/v1/checkout.js");
    busy(false);
    const rz = new window.Razorpay({
      key: r.key_id,
      subscription_id: r.subscription_id,
      name: CONFIG.APP_NAME,
      description: plan ? `Pro ${plan.name} — ${plan.price} ${plan.per}` : "Pro",
      prefill: { email: session?.user?.email || "" },
      theme: { color: "#0f4c4a" },
      handler: () => { toast("Payment received. Activating Pro…", false, 6000); pollPro(); },
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
  if (state.patient.templateId !== "default" && !state.templates.some((t) => t.id === state.patient.templateId)) {
    setTemplate("default", { quiet: true });
  }
  renderTemplatePicker();
  $("#tplOnboard").hidden = !(state.templates.length === 0 && !store.get(LS, "dai_tpl_onboarded"));
  if (state.step === "templates") renderTemplateList();
}

function templateById(id) {
  if (!id || id === "default") return clone(DEFAULT_TEMPLATE);
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
  sel.innerHTML = `<option value="default">${esc(DEFAULT_TEMPLATE.name)}</option>` +
    state.templates.map((t) => `<option value="${t.id}">${esc(t.name)}${t.is_default ? " ★" : ""}</option>`).join("") +
    `<option value="__manage">＋ New / manage templates…</option>`;
  sel.value = state.templates.some((t) => t.id === state.patient.templateId) ? state.patient.templateId : "default";
}

/* ============================================================
   Templates — manager & editor
   ============================================================ */
const ed = { id: null, photos: [], tpl: null };

function renderTemplateList() {
  const items = [`<div class="tpl-item"><span class="nm">${esc(DEFAULT_TEMPLATE.name)}<span class="meta">Built-in · House format of the Department of General Medicine</span></span>
    <button class="btn small" data-use="default">${state.patient.templateId === "default" ? "In use ✓" : "Use"}</button></div>`];
  for (const t of state.templates) {
    const n = (t.data?.sections || []).length;
    items.push(`<div class="tpl-item"><span class="nm">${esc(t.name)}${t.is_default ? '<span class="badge">Default</span>' : ""}
      <span class="meta">${n} sections · updated ${new Date(t.updated_at).toLocaleDateString("en-IN")}</span></span>
      <button class="btn small" data-use="${t.id}">${state.patient.templateId === t.id ? "In use ✓" : "Use"}</button>
      <button class="btn small" data-edit="${t.id}">Edit</button></div>`);
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
  $$("#stepper button").forEach((b) => {
    b.classList.toggle("on", b.dataset.step === step);
    b.disabled = (b.dataset.step === "review" && !state.data) || (b.dataset.step === "final" && !state.draft);
  });
  if (step === "templates" && !keepEditor) renderTemplateList();
  if (step === "review") renderReview();
  if (step === "final") renderDocIfNeeded();
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

const MAX_CASE_PHOTOS = 15;
function renderPhotos() {
  const box = $("#photoList");
  const n = state.photos.length, full = n >= MAX_CASE_PHOTOS;
  $("#photoCount").textContent = `${n} / ${MAX_CASE_PHOTOS} photos${full ? " — limit reached" : ""}`;
  $("#photoCount").classList.toggle("full", full);
  for (const id of ["#camBtn", "#galBtn"]) $(id).classList.toggle("off", full);
  $("#camInput").disabled = full; $("#galInput").disabled = full;
  if (!state.photos.length) {
    box.innerHTML = `<div class="empty">No photos yet. Add progress notes, investigation reports and the treatment chart.</div>`;
    return;
  }
  box.innerHTML = state.photos.map((p, i) => `
    <div class="photo ${idDone(p) ? "" : "needs-id"}" data-id="${p.id}">
      <img src="${p.url}" alt="Photo ${i + 1}" data-act="view" />
      <div class="row">
        <select data-act="kind">${Object.entries(KIND_LABEL).map(([k, l]) => `<option value="${k}" ${k === p.kind ? "selected" : ""}>${i + 1}. ${l}</option>`).join("")}</select>
      </div>
      <div class="row">
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
  if (act === "view") openLightbox(p, `Photo ${i + 1} · ${KIND_LABEL[p.kind]}`);
  if (act === "mask") openMask(p, renderPhotos);
  if (act === "clean") { p.clean = !p.clean; renderPhotos(); }
  if (act === "del") { state.photos.splice(i, 1); renderPhotos(); }
  if (act === "up" && i > 0) { [state.photos[i - 1], state.photos[i]] = [state.photos[i], state.photos[i - 1]]; renderPhotos(); }
  if (act === "down" && i < state.photos.length - 1) { [state.photos[i + 1], state.photos[i]] = [state.photos[i], state.photos[i + 1]]; renderPhotos(); }
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
const ARR_KEYS = ["past_events", "held_drugs", "pending_investigations", "known_case_of", "chief_complaints", "diagnoses", "investigations", "imaging_and_other_tests", "events", "daily_progress", "medications", "unclear_items"];
function normalise(d) {
  d = d && typeof d === "object" ? d : {};
  for (const k of ARR_KEYS) if (!Array.isArray(d[k])) d[k] = [];
  d.admission_examination = d.admission_examination || {};
  d.condition_at_last_note = d.condition_at_last_note || {};
  d.medications.forEach((m) => { m.on_discharge = !!m.on_discharge; });
  return d;
}

async function extract() {
  if (!state.photos.length) return toast("Add at least one photo first.", true);
  if (state.data && !confirm("Reading the photos again will replace the data you reviewed. Continue?")) return;
  const pending = state.photos.filter((p) => !idDone(p)).length;
  if (pending) {
    renderPhotos();
    $(".photo.needs-id")?.scrollIntoView({ behavior: "smooth", block: "center" });
    return toast(`${pending} photo(s) still need "Mask IDs" or "No IDs" before reading.`, true, 6000);
  }
  busy(`Reading ${state.photos.length} photo(s), usually 20–60 seconds`);
  try {
    const r = await api("extract", {
      images: state.photos.map((p) => ({ mime: "image/jpeg", data: p.url.split(",")[1], kind: p.kind })),
    });
    state.data = normalise(r.data);
    state.draft = null; state.draftTemplate = null; state.docHtml = null;
    const P = state.patient;
    if (/^(male|female)$/i.test(state.data.sex || "")) state.data.sex = state.data.sex[0].toUpperCase() + state.data.sex.slice(1).toLowerCase();
    if (!P.doa && state.data.admission_date) P.doa = state.data.admission_date;
    if (!P.dod && state.data.discharge_date) P.dod = state.data.discharge_date;
    fillPatientForm();
    $("#medConfirm").checked = false;
    loadProfile();
    showStep("review");
  } catch (e) {
    handleApiError(e);
  } finally {
    busy(false);
  }
}

/* ============================================================
   Step 3 — review
   ============================================================ */
const SECTIONS = [
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

  let html = "";
  if (d.unclear_items.length) {
    html += `<div class="rv-warn"><b>⚠ ${d.unclear_items.length} unclear reading(s) to check</b><ul>${
      d.unclear_items.map((u) => `<li><b>${esc(u.where)}</b>${u.reading ? `: “${esc(u.reading)}”` : ""} — ${esc(u.reason)}</li>`).join("")
    }</ul></div>`;
  }
  for (const s of SECTIONS) {
    html += `<div class="rv-section"><h3>${esc(s.title)}</h3>`;
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
    html += `</div>`;
  }
  html += `<div class="rv-section"><h3>Timeline (detected from dates)</h3><p class="hint">This is the order the summary will follow. If something is in the wrong place, fix its date above.</p><div id="timeline" class="timeline"></div></div>`;
  $("#reviewForm").innerHTML = html;
  renderTimeline();
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
  clearTimeout(tlTimer); tlTimer = setTimeout(renderTimeline, 400);
}

function onReviewClick(e) {
  const t = e.target;
  if (t.dataset.add) {
    const sec = SECTIONS.find((s) => s.table === t.dataset.add);
    state.data[t.dataset.add].push(Object.fromEntries(sec.cols.map((c) => [c.k, c.bool ? false : ""])));
    renderReview(); saveCase();
  } else if (t.dataset.del) {
    state.data[t.dataset.del].splice(+t.dataset.row, 1);
    renderReview(); saveCase();
  }
}

/* ---------- Generate ---------- */
async function generate() {
  const d = state.data;
  if (!d) return;
  if (d.medications.length && !$("#medConfirm").checked) {
    $("#medConfirm").closest("label").scrollIntoView({ behavior: "smooth", block: "center" });
    return toast("Please confirm you have checked the medications.", true);
  }
  if (state.docHtml && !confirm("Rewriting will replace your edits in the summary. Continue?")) return;
  const P = state.patient;
  const { unclear_items, ...rest } = d;
  // Only the reviewed clinical data goes to the AI. Name and the dates typed on step 1 never leave this device.
  const caseData = { ...rest, age: d.age || "", sex: d.sex || "", admission_date: d.admission_date || "", discharge_date: d.discharge_date || "",
    chronology: buildChronology(d).text }; // date-ordered backbone for the story
  const tpl = currentTemplate();
  const template = { title: tpl.title, department: tpl.department, sections: tpl.sections };
  busy(`Writing the summary (${tpl.name})`);
  try {
    const r = await api("generate", {
      case: caseData,
      template,
      options: { outcome: P.outcome || "discharged", followup: P.followup || "", monitor: P.monitor || "", extra: P.extra || "", dept: deptName() },
    });
    state.draft = r.data;
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
  const opt = $$(".opt-sec", doc);
  $("#optTreatmentLabel").hidden = !opt.length;
  opt.forEach((el) => (el.hidden = !$("#optTreatment").checked));
  const n = (doc.innerText.match(/_{3,}|\[\?\]/g) || []).length;
  const w = $("#docWarn");
  w.hidden = !n;
  w.textContent = n ? `${n} blank(s) or unclear item(s) still highlighted. Fill or remove them before printing.` : "";
}

function renderDocIfNeeded(force = false) {
  const doc = $("#doc");
  if (!state.draft) return;
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

function setVerified(v) {
  $("#finalVerify").checked = v;
  $("#printBtn").disabled = !v;
  $("#copyBtn").disabled = !v;
}

function clearCase() {
  const { dept, templateId } = state.patient;
  Object.assign(state, { patient: { outcome: "discharged", dept, templateId }, photos: [], data: null, draft: null, draftTemplate: null, docHtml: null });
  if (SS) store.del(SS, CASE_KEY);
  fillPatientForm(); renderPhotos(); $("#doc").innerHTML = "";
  setVerified(false);
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
  const plans = CONFIG.PLANS || [];
  const freeCard = `<div class="price-card">
      <h3>Free</h3><div class="price">₹0</div><p class="pnote">To try it out</p>
      <ul><li>${free} patients a month</li><li>Built-in General Medicine format</li><li>All privacy safeguards</li></ul>
      <button class="btn big" data-signin>Start free</button></div>`;
  const pro = plans.map((p) => `<div class="price-card ${p.best ? "best" : ""}">
      ${p.best ? '<span class="tag">Best value</span>' : ""}
      <h3>Pro ${esc(p.name.toLowerCase())}</h3><div class="price">${esc(p.price)} <small>${esc(p.per || "")}</small></div><p class="pnote">${esc(p.note || "")}</p>
      <ul>${(CONFIG.PRO_FEATURES || []).map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
      <button class="btn big ${p.best ? "primary" : ""}" data-signin>Get started</button></div>`).join("");
  $("#priceGrid").innerHTML = freeCard + pro;
}

async function loadPublicLimits() {
  const { data: lim } = await sb.rpc("public_limits");
  if (lim?.free_extract >= 0) { CONFIG.FREE_MONTHLY_LIMIT = lim.free_extract; renderLanding(); renderAccount(); }
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
  const addCase = async (files) => { if (await addFiles(files, state.photos, MAX_CASE_PHOTOS, $("#defaultKind").value)) renderPhotos(); };
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
  $("#finalVerify").addEventListener("change", (e) => setVerified(e.target.checked));
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
  $("#newBtn").addEventListener("click", newPatient);

  // Plans
  $("#plans").addEventListener("click", (e) => { const b = e.target.closest("[data-plan]"); if (b) choosePlan(b.dataset.plan); });
  $("#planClose").addEventListener("click", () => ($("#planModal").hidden = true));
  $("#planModal").addEventListener("click", (e) => { if (e.target.id === "planModal") $("#planModal").hidden = true; });

  // Templates
  $("#tplList").addEventListener("click", (e) => {
    const u = e.target.dataset.use, ed_ = e.target.dataset.edit;
    if (u) { setTemplate(u); renderTemplateList(); toast("Template selected."); }
    if (ed_) {
      const row = state.templates.find((t) => t.id === ed_);
      if (row) openEditor({ id: row.id, tpl: normaliseTemplate(row.data), name: row.name });
    }
  });
  $("#tplNew").addEventListener("click", () => openEditor());
  $("#tplFromDefault").addEventListener("click", () => openEditor({ tpl: normaliseTemplate(DEFAULT_TEMPLATE), name: "My General Medicine format" }));
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
