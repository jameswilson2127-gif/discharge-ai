import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { CONFIG } from "./config.js?v=27";
import { esc } from "./doc.js?v=27";

const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

let fx = 88; // USD → INR, replaced from settings
let settings = null;
const users = { q: "", offset: 0, rows: [], total: 0 };

/* ---------- formatting ---------- */
const n = (v) => Number(v || 0);
const int = (v) => n(v).toLocaleString("en-IN");
export function rupees(usd, rate = fx) {
  const r = n(usd) * rate;
  if (r === 0) return "₹0";
  if (r < 1) return `₹${r.toFixed(2)}`;
  if (r < 100) return `₹${r.toFixed(1)}`;
  return `₹${Math.round(r).toLocaleString("en-IN")}`;
}
const paise = (p) => `₹${Math.round(n(p) / 100).toLocaleString("en-IN")}`;
const date = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—");
const usd = (v) => `$${n(v).toFixed(n(v) < 1 ? 4 : 2)}`;

function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg; t.className = "toast" + (err ? " err" : ""); t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 3500);
}
const busy = (text) => { $("#busy").hidden = !text; if (text) $("#busyText").textContent = text; };

async function api(action, body = {}) {
  const { data: s } = await sb.auth.getSession();
  if (!s.session) throw Object.assign(new Error("Please sign in in the app first."), { status: 401 });
  const r = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/admin`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${s.session.access_token}`, apikey: CONFIG.SUPABASE_ANON_KEY },
    body: JSON.stringify({ action, ...body }),
  });
  let out = {};
  try { out = await r.json(); } catch { /* ignore */ }
  if (!r.ok) throw Object.assign(new Error(out.error || `Error ${r.status}`), { status: r.status });
  return out;
}

/* ---------- overview ---------- */
const card = (v, l, s = "", cls = "") => `<div class="card ${cls}"><div class="v">${v}</div><div class="l">${esc(l)}</div>${s ? `<div class="s">${s}</div>` : ""}</div>`;

async function loadOverview() {
  const o = await api("overview");
  settings = o.settings || settings;
  fx = n(settings?.usd_inr) || fx;

  const perDis = o.discharges_total ? n(o.cost_usd_total) / o.discharges_total : 0;
  const perDisMonth = o.discharges_month ? n(o.cost_usd_month) / o.discharges_month : 0;
  $("#costCards").innerHTML = [
    card(rupees(o.cost_usd_total), "Total AI cost, all time", `${usd(o.cost_usd_total)} · ${int(o.discharges_total)} discharges`, "hero"),
    card(rupees(o.cost_usd_month), "AI cost this month", `${usd(o.cost_usd_month)} · ${int(o.discharges_month)} discharges`),
    card(rupees(perDis), "Average cost per discharge", perDisMonth ? `This month: ${rupees(perDisMonth)}` : "All costs ÷ patients read"),
    card(int(o.discharges_month), "Discharges this month", `${int(o.summaries_month)} drafts written`),
    card(int(o.discharges_total), "Discharges, all time", `${int(o.summaries_total)} drafts written`),
    card(int(o.errors_7d), "Failed AI calls (7 days)", "See the Usage tab", n(o.errors_7d) ? "bad" : ""),
  ].join("");

  const km = o.cost_by_kind_month || {}, kt = o.cost_by_kind_total || {};
  const row = (label, k) => `<tr><td>${label}</td><td>${rupees(km[k])}</td><td>${rupees(kt[k])}</td></tr>`;
  $("#breakdown").innerHTML = `<table><tr><th>Cost breakdown</th><th>This month</th><th>All time</th></tr>
    ${row("Reading photos", "extract")}${row("Writing summaries", "generate")}${row("Reading templates", "template")}
    <tr><td>Total</td><td>${rupees(o.cost_usd_month)}</td><td>${rupees(o.cost_usd_total)}</td></tr></table>`;

  const revM = n(o.revenue_paise_month) / 100, costM = n(o.cost_usd_month) * fx;
  const profit = revM - costM;
  $("#moneyCards").innerHTML = [
    card(paise(o.revenue_paise_month), "Revenue this month", `All time: ${paise(o.revenue_paise_total)}`),
    card(rupees(o.cost_usd_month), "AI cost this month"),
    card(`${profit < 0 ? "−" : ""}₹${Math.abs(Math.round(profit)).toLocaleString("en-IN")}`, "Revenue minus AI cost", "Before Razorpay fees & hosting", profit >= 0 ? "good" : "bad"),
  ].join("");

  $("#userCards").innerHTML = [
    card(int(o.users_total), "Total users", `+${int(o.users_7d)} in the last 7 days`),
    card(int(o.pro_users), "Pro users", o.users_total ? `${Math.round((o.pro_users / o.users_total) * 100)}% of users` : ""),
    card(int(o.templates_total), "Custom templates"),
    card(int(o.blocked_users), "Blocked users"),
  ].join("");
  $("#ovNote").textContent = `Costs use Gemini's reported token counts for every call, converted at ₹${fx} per US$ (change in Settings).`;
}

/* ---------- users ---------- */
function planPill(u) {
  if (u.blocked) return `<span class="pill blk">Blocked</span>`;
  const pro = u.pro_until && new Date(u.pro_until) > new Date();
  if (!pro) return `<span class="pill">Free</span>`;
  const label = u.plan === "yearly" ? "Pro yearly" : u.plan === "manual" ? "Pro (given)" : "Pro monthly";
  return `<span class="pill pro">${label} · till ${date(u.pro_until)}</span>`;
}

function userCard(u) {
  const month = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 7);
  const thisMonth = u.usage_month === month ? u.extract_count : 0;
  const pro = u.pro_until && new Date(u.pro_until) > new Date();
  return `<div class="u ${u.blocked ? "blocked" : ""}" data-id="${u.id}">
    <div class="top"><span class="em">${esc(u.email || "(no email)")}</span>${planPill(u)}</div>
    <div class="stats">
      <span>This month <b>${int(thisMonth)}</b> patients</span>
      <span>All time <b>${int(u.discharges_total)}</b> discharges</span>
      <span>AI cost <b>${rupees(u.cost_usd_total)}</b></span>
      <span>Paid <b>${paise(u.paid_paise_total)}</b></span>
      <span>Templates <b>${int(u.templates)}</b></span>
      <span>Joined <b>${date(u.created_at)}</b></span>
      <span>Last active <b>${date(u.last_active)}</b></span>
    </div>
    <div class="acts">
      <button class="btn small" data-act="pro">${pro ? "Extend Pro" : "Give Pro"}</button>
      ${pro ? `<button class="btn small" data-act="unpro">Remove Pro</button>` : ""}
      <button class="btn small" data-act="reset">Reset usage</button>
      <button class="btn small ${u.blocked ? "" : "danger"}" data-act="block">${u.blocked ? "Unblock" : "Block"}</button>
    </div>
  </div>`;
}

async function loadUsers(reset = true) {
  if (reset) { users.offset = 0; users.rows = []; }
  const r = await api("users", { q: users.q, limit: 25, offset: users.offset });
  users.rows.push(...(r.rows || []));
  users.total = r.total || 0;
  users.offset = users.rows.length;
  $("#userList").innerHTML = users.rows.length ? users.rows.map(userCard).join("") : `<div class="empty">No users found.</div>`;
  $("#userCount").textContent = `${int(users.total)} user${users.total === 1 ? "" : "s"}`;
  $("#moreUsers").hidden = users.rows.length >= users.total;
}

async function onUserAction(e) {
  const act = e.target.dataset.act;
  const el = e.target.closest(".u");
  if (!act || !el) return;
  const u = users.rows.find((x) => x.id === el.dataset.id);
  if (!u) return;
  let body, msg;
  if (act === "pro") {
    const d = prompt(`Give Pro to ${u.email} for how many days?\n(30 = one month, 365 = one year)`, "30");
    if (d === null) return;
    const days = parseInt(d, 10);
    if (!(days > 0)) return toast("Enter a number of days.", true);
    body = ["set_pro", { user_id: u.id, days }]; msg = `Pro given for ${days} days.`;
  } else if (act === "unpro") {
    if (!confirm(`Remove Pro from ${u.email} now? (Does not cancel their Razorpay subscription.)`)) return;
    body = ["set_pro", { user_id: u.id, days: 0 }]; msg = "Pro removed.";
  } else if (act === "reset") {
    if (!confirm(`Reset this month's usage for ${u.email}?`)) return;
    body = ["reset_usage", { user_id: u.id }]; msg = "Usage reset.";
  } else if (act === "block") {
    const to = !u.blocked;
    if (!confirm(to ? `Block ${u.email}? They will not be able to read photos or write summaries.` : `Unblock ${u.email}?`)) return;
    body = ["block", { user_id: u.id, blocked: to }]; msg = to ? "User blocked." : "User unblocked.";
  }
  busy("Saving");
  try {
    const r = await api(...body);
    Object.assign(u, r.row || {});
    el.outerHTML = userCard(u);
    toast(msg);
  } catch (err) { toast(err.message, true); } finally { busy(false); }
}

/* ---------- usage ---------- */
async function loadUsage() {
  const r = await api("daily", { days: Number($("#days").value) });
  const days = r.days || [];
  const sum = (k) => days.reduce((a, d) => a + n(d[k]), 0);
  $("#dailyTable").innerHTML = `<thead><tr><th>Day</th><th>Discharges</th><th>Drafts</th><th>Templates</th><th>Errors</th><th>AI cost</th></tr></thead>
    <tbody>${days.length ? days.map((d) => `<tr><td>${date(d.day)}</td><td>${int(d.discharges)}</td><td>${int(d.summaries)}</td><td>${int(d.templates)}</td><td>${n(d.errors) ? `<b style="color:var(--danger)">${int(d.errors)}</b>` : "0"}</td><td>${rupees(d.cost_usd)}</td></tr>`).join("")
      : `<tr><td colspan="6" style="text-align:center;color:var(--muted)">No activity yet</td></tr>`}</tbody>
    <tfoot><tr><td>Total</td><td>${int(sum("discharges"))}</td><td>${int(sum("summaries"))}</td><td>${int(sum("templates"))}</td><td>${int(sum("errors"))}</td><td>${rupees(sum("cost_usd"))}</td></tr></tfoot>`;
  $("#errors").innerHTML = (r.recent_errors || []).length
    ? r.recent_errors.map((e) => `<div class="err"><b>${esc(e.kind)}</b> · ${new Date(e.at).toLocaleString("en-IN")} · ${esc(e.email || "")}<br><code>${esc(e.error || "")}</code></div>`).join("")
    : `<p class="hint">No errors. 🎉</p>`;
  loadFeedback();
}
async function loadFeedback() {
  try {
    const f = await api("feedback", { limit: 50 });
    const rows = f.rows || [];
    $("#feedback").innerHTML = `<p class="hint">👍 ${int(f.up)} · 👎 ${int(f.down)} in total. Latest 50:</p>` + (rows.length
      ? rows.map((x) => `<div class="err" style="border-left-color:${x.rating > 0 ? "var(--accent-2)" : "var(--danger)"}"><b>${x.rating > 0 ? "👍" : "👎"}</b> · ${new Date(x.at).toLocaleString("en-IN")} · ${esc(x.email || "")}${x.template ? ` · <small>${esc(x.template)}</small>` : ""}${x.comment ? `<br>${esc(x.comment)}` : ""}</div>`).join("")
      : `<p class="hint">No feedback yet.</p>`);
  } catch (e) { $("#feedback").innerHTML = `<p class="hint">Could not load feedback: ${esc(e.message)}</p>`; }
}

/* ---------- cost per discharge / per user ---------- */
const cases = { rows: [], total: 0 }, ucost = { rows: [], total: 0 };
const PAGE = 20;
const timeShort = (d) => new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const shortModel = (m) => String(m || "—").replace(/^gemini-/, "");

// Monthly income from a user's plan, in ₹ (from the display prices in config.js).
function planIncome(u) {
  if (!u.pro) return 0;
  const price = (id) => Number(String((CONFIG.PLANS || []).find((p) => p.id === id)?.price || "0").replace(/[^\d.]/g, "")) || 0;
  if (u.plan === "monthly") return price("monthly");
  if (u.plan === "yearly") return price("yearly") / 12;
  return 0; // gifted / manual Pro
}

async function loadCases(reset = true) {
  if (reset) cases.rows = [];
  const r = await api("cases", { limit: PAGE, offset: cases.rows.length });
  cases.rows.push(...(r.rows || []));
  cases.total = n(r.total);
  if (reset) {
    const m = r.month || {};
    $("#caseCards").innerHTML = [
      card(rupees(m.avg_usd), "Average cost per discharge", `${int(m.cases)} discharges this month`, "hero"),
      card(rupees(m.max_usd), "Most expensive discharge"),
      card(rupees(n(m.avg_usd) * n(settings?.pro_extract || 0)), "If a Pro user hits the limit", `${int(settings?.pro_extract || 0)} patients × average`),
    ].join("");
    const bm = m.by_model || [], bl = m.by_length || [];
    const LEN = { concise: "Concise", standard: "Standard", detailed: "Detailed" };
    const tbl = (head, rows, label) => rows.length
      ? `<thead><tr><th>${head}</th><th>Discharges</th><th>Average cost</th></tr></thead><tbody>${rows.map((x) => `<tr><td>${esc(label(x))}</td><td>${int(x.cases)}</td><td>${rupees(x.avg_usd)}</td></tr>`).join("")}</tbody>` : "";
    $("#modelTable").innerHTML = tbl("Reading model", bm, (x) => shortModel(x.model));
    $("#lengthTable").innerHTML = bl.length
      ? `<thead><tr><th>Summary length</th><th>Discharges</th><th>Average cost</th><th>Reading</th><th>Writing</th><th>Per photo</th><th>15 photos ≈</th></tr></thead><tbody>${bl.map((x) =>
        `<tr><td>${esc(LEN[x.length] || x.length)}</td><td>${int(x.cases)}</td><td><b>${rupees(x.avg_usd)}</b></td><td>${rupees(x.avg_read_usd)}</td><td>${rupees(x.avg_write_usd)}</td><td>${rupees(x.avg_per_photo_usd)}</td><td>${x.avg_per_photo_usd ? rupees(n(x.avg_per_photo_usd) * 15) : "—"}</td></tr>`).join("")}</tbody>` : "";
  }
  $("#caseTable").innerHTML = `<thead><tr><th>When</th><th>User</th><th>Length</th><th>Photos</th><th>Reads</th><th>Drafts</th><th>Cost</th><th>Reading / writing</th><th>Thinking</th><th>Models</th></tr></thead>
    <tbody>${cases.rows.length ? cases.rows.map((c) => `<tr>
      <td>${timeShort(c.at)}</td><td class="em">${esc(c.email || "deleted user")}</td><td>${esc({ concise: "Concise", standard: "Standard", detailed: "Detailed" }[c.length] || "—")}</td><td>${c.photos ?? "—"}</td>
      <td>${int(c.reads)}</td><td>${int(c.drafts)}${n(c.errors) ? ` <b style="color:var(--danger)" title="failed calls">· ${int(c.errors)}✕</b>` : ""}</td>
      <td><b>${rupees(c.cost_usd)}</b></td><td class="mdl">${c.read_usd !== undefined ? `${rupees(c.read_usd)} / ${rupees(c.write_usd)}` : "—"}</td>
      <td class="mdl">${c.thinking ? `${int(c.thinking)} tok` : "—"}</td><td class="mdl">${esc(shortModel(c.read_model))}${c.write_model && c.write_model !== c.read_model ? ` / ${esc(shortModel(c.write_model))}` : ""}</td></tr>`).join("")
      : `<tr><td colspan="10" style="text-align:center;color:var(--muted)">No discharges tracked yet. New patients will appear here.</td></tr>`}</tbody>`;
  $("#moreCases").hidden = cases.rows.length >= cases.total;
}

async function loadUserCosts(reset = true) {
  if (reset) ucost.rows = [];
  const r = await api("user_costs", { limit: PAGE, offset: ucost.rows.length });
  ucost.rows.push(...(r.rows || []));
  ucost.total = n(r.total);
  $("#userCostTable").innerHTML = `<thead><tr><th>User</th><th>Plan</th><th>Discharges</th><th>AI cost</th><th>Per discharge</th><th>Income</th><th>Margin</th></tr></thead>
    <tbody>${ucost.rows.length ? ucost.rows.map((u) => {
      const cost = n(u.cost_usd) * fx, inc = planIncome(u), margin = inc - cost;
      const plan = u.pro ? (u.plan === "yearly" ? "Pro yearly" : u.plan === "monthly" ? "Pro monthly" : "Pro (gifted)") : "Free";
      return `<tr><td class="em">${esc(u.email || "deleted user")}</td><td>${plan}</td><td>${int(u.discharges)}</td>
        <td>${rupees(u.cost_usd)}</td><td>${n(u.discharges) ? rupees(n(u.cost_usd) / n(u.discharges)) : "—"}</td>
        <td>₹${Math.round(inc).toLocaleString("en-IN")}</td>
        <td><b style="color:${margin < 0 ? "var(--danger)" : "#1b7a43"}">${margin < 0 ? "−" : ""}₹${Math.abs(margin) < 10 ? Math.abs(margin).toFixed(1) : Math.round(Math.abs(margin)).toLocaleString("en-IN")}</b></td></tr>`;
    }).join("") : `<tr><td colspan="7" style="text-align:center;color:var(--muted)">No usage this month</td></tr>`}</tbody>`;
  $("#moreUserCosts").hidden = ucost.rows.length >= ucost.total;
}

/* ---------- settings ---------- */
const SKEYS = ["free_extract", "pro_extract", "free_generate", "pro_generate", "usd_inr"];
function fillSettings() {
  for (const k of SKEYS) $(`#s_${k}`).value = settings?.[k] ?? "";
  const P = settings?.pricing || {};
  $("#p_m_list").value = P.monthly?.list ?? ""; $("#p_m_price").value = P.monthly?.price ?? "";
  $("#p_y_list").value = P.yearly?.list ?? "";  $("#p_y_price").value = P.yearly?.price ?? "";
  $("#p_label").value = P.offer_label ?? ""; $("#p_ends").value = P.offer_ends ?? "";
  previewPrices();
}
function readPricing() {
  const num = (id) => ($(id).value === "" ? 0 : Math.round(Number($(id).value)));
  return {
    offer_label: $("#p_label").value.trim().slice(0, 30), offer_ends: $("#p_ends").value || null,
    monthly: { list: num("#p_m_list"), price: num("#p_m_price"), days: 30 },
    yearly:  { list: num("#p_y_list"), price: num("#p_y_price"), days: 365 },
  };
}
function previewPrices() {
  const P = readPricing();
  const on = !P.offer_ends || new Date().toISOString().slice(0, 10) <= P.offer_ends;
  const show = (x, per) => { const pay = on && x.price > 0 ? x.price : x.list; return `<b>₹${int(pay)}</b>${on && x.price > 0 && x.list > x.price ? ` <s>₹${int(x.list)}</s>` : ""} ${per}`; };
  $("#pricePreview").innerHTML = `Doctors see now: Monthly ${show(P.monthly, "/ month")} · Yearly ${show(P.yearly, "/ year")}${on && P.offer_label ? ` · “${esc(P.offer_label)}”` : ""}`;
}
async function saveSettings() {
  const s = Object.fromEntries(SKEYS.map((k) => [k, Number($(`#s_${k}`).value)]));
  s.pricing = readPricing();
  busy("Saving settings");
  try {
    const r = await api("save_settings", { settings: s });
    settings = r.settings; fx = n(settings.usd_inr) || fx;
    fillSettings();
    toast("Settings saved.");
  } catch (e) { toast(e.message, true); } finally { busy(false); }
}

/* ---------- tabs & init ---------- */
const loaded = {};
async function showTab(t) {
  $$("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
  for (const x of ["overview", "users", "usage", "settings"]) $(`#tab-${x}`).hidden = x !== t;
  if (t === "settings") return fillSettings();
  if (loaded[t] && t !== "overview") return;
  busy("Loading");
  try {
    if (t === "overview") await loadOverview();
    if (t === "users") await loadUsers();
    if (t === "usage") await Promise.all([loadUsage(), loadCases(), loadUserCosts()]);
    loaded[t] = true;
  } catch (e) { toast(e.message, true); } finally { busy(false); }
}

function gate(html) { $("#gate").innerHTML = html; $("#gate").hidden = false; $("#panel").hidden = true; }

async function init() {
  const { data } = await sb.auth.getSession();
  if (!data.session) return gate(`<p>Sign in to the app with your admin Google account first.</p><a class="btn primary" href="./">Open the app</a>`);
  $("#who").textContent = data.session.user.email || "";
  try {
    await api("whoami");
  } catch (e) {
    return gate(e.status === 403 ? `<p>This Google account is not an admin.</p><a class="btn" href="./">Back to the app</a>` : `<p>${esc(e.message)}</p>`);
  }
  $("#panel").hidden = false;
  $("#tabs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) showTab(b.dataset.tab); });
  let t;
  $("#userSearch").addEventListener("input", (e) => {
    clearTimeout(t);
    t = setTimeout(async () => { users.q = e.target.value.trim(); try { await loadUsers(); } catch (err) { toast(err.message, true); } }, 350);
  });
  $("#moreUsers").addEventListener("click", () => loadUsers(false).catch((e) => toast(e.message, true)));
  $("#userList").addEventListener("click", onUserAction);
  $("#days").addEventListener("change", () => loadUsage().catch((e) => toast(e.message, true)));
  $("#saveSettings").addEventListener("click", saveSettings);
  for (const id of ["#p_m_list", "#p_m_price", "#p_y_list", "#p_y_price", "#p_label", "#p_ends"]) $(id).addEventListener("input", previewPrices);
  $("#moreCases").addEventListener("click", () => loadCases(false).catch((e) => toast(e.message, true)));
  $("#moreUserCosts").addEventListener("click", () => loadUserCosts(false).catch((e) => toast(e.message, true)));
  showTab("overview");
}

if (typeof window !== "undefined" && document.getElementById("panel")) init();
