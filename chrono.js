// chrono.js — builds a date-ordered timeline of the case from the reviewed data,
// so the summary can be written as one story: background → earlier reports →
// presenting illness → admission → day-by-day course. Pure functions, no network.

const DAY = 86400000;

/** Parse a written date relative to a reference (usually the admission date).
 *  Handles DD/MM/YYYY, DD-MM-YY, DD.MM, "12/11 8pm", and bare years like 2019. */
export function parseDate(s, ref) {
  const t = String(s || "");
  // 1) Full day/month date, optionally with a year.
  let m = t.match(/\b(\d{1,2})\s*[/\-.]\s*(\d{1,2})(?:\s*[/\-.]\s*(\d{4}|\d{2}))?(?!\d)/);
  if (m) {
    const dd = +m[1], mm = +m[2];
    if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12) {
      let yy = m[3] ? +m[3] : null;
      if (yy !== null && yy < 100) yy += 2000;
      if (yy === null) {
        // No year written: assume the admission year, unless that puts it well after admission.
        const base = ref || new Date();
        yy = base.getFullYear();
        if (new Date(yy, mm - 1, dd) - base > 60 * DAY) yy -= 1;
      }
      const d = new Date(yy, mm - 1, dd);
      if (d.getMonth() === mm - 1) return { date: d, approx: false };
    }
  }
  // 2) Month/year only, e.g. 03/2026.
  m = t.match(/(?<![\d/.\-])(\d{1,2})\s*[/\-.]\s*((?:19|20)\d{2})\b/);
  if (m && +m[1] >= 1 && +m[1] <= 12) return { date: new Date(+m[2], +m[1] - 1, 1), approx: "month" };
  // 3) Relative to admission: "8 years back", "6 months ago", "x 2 yrs".
  m = t.match(/(\d+(?:\.\d+)?)\s*(years?|yrs?|months?|mths?|mo)\b\s*(?:back|ago|before|prior)?/i);
  if (m && ref && /back|ago|before|prior|since|k\/c\/o|known|x\s*\d/i.test(t)) {
    const n = +m[1], isYear = /^y/i.test(m[2]);
    const d = new Date(ref);
    if (isYear) { d.setFullYear(d.getFullYear() - Math.round(n)); return { date: new Date(d.getFullYear(), 0, 1), approx: "year" }; }
    d.setMonth(d.getMonth() - Math.round(n)); return { date: new Date(d.getFullYear(), d.getMonth(), 1), approx: "month" };
  }
  // 4) Year only.
  m = t.match(/\b(19[5-9]\d|20\d{2})\b/);
  if (m) return { date: new Date(+m[1], 0, 1), approx: "year" };
  return null;
}

const fmt = (d) => `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
const fmtA = (d, approx) => approx === "year" ? String(d.getFullYear()) : approx === "month" ? `${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}` : fmt(d);
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const ORDER = { past: 0, admission: 1, progress: 2, event: 3, labs: 4, imaging: 5 };

/** Returns { admission, entries:[{when,label,phase,text}], undatedPast:[…], trends:[…], text } */
export function buildChronology(d) {
  d = d || {};
  const progress = d.daily_progress || [], inv = d.investigations || [], img = d.imaging_and_other_tests || [];
  const events = d.events || [], past = d.past_events || [];

  // Reference date: written admission date, else the earliest progress note, else the earliest date found.
  let adm = parseDate(d.admission_date)?.date || null;
  if (!adm) {
    const ds = progress.map((r) => parseDate(r.date)).filter((x) => x && !x.approx).map((x) => x.date);
    if (ds.length) adm = new Date(Math.min(...ds));
  }
  if (!adm) {
    const ds = [...inv, ...img, ...events].map((r) => parseDate(r.date)).filter((x) => x && !x.approx).map((x) => x.date);
    if (ds.length) adm = new Date(Math.min(...ds));
  }

  const items = [];
  const undatedPast = [];
  const undated = [];
  const add = (p, kind, text) => {
    if (!text) return;
    if (!p) { (kind === "past" ? undatedPast : undated).push(text); return; }
    items.push({ date: p.date, approx: p.approx, kind, text });
  };

  for (const r of past) add(parseDate(r.when, adm), "past", [r.when, r.detail].filter(Boolean).join(": "));
  if (adm) add({ date: adm, approx: false }, "admission",
    `Admitted${(d.chief_complaints || []).length ? ` with ${d.chief_complaints.join(", ")}` : ""}`);
  for (const r of progress) add(parseDate(r.date, adm), "progress", r.note);
  for (const r of events) add(parseDate(r.date, adm), "event", r.description);
  for (const r of img) add(parseDate(r.date, adm), "imaging", [r.test, r.finding].filter(Boolean).join(": "));

  // Labs: one line per date.
  const labsByDay = new Map();
  for (const r of inv) {
    const p = parseDate(r.date, adm);
    const val = `${r.test} ${r.value}${r.unit ? ` ${r.unit}` : ""}${r.flag ? ` (${r.flag})` : ""}`.trim();
    if (!p) { undated.push(`Lab: ${val}`); continue; }
    const k = p.date.getTime();
    if (!labsByDay.has(k)) labsByDay.set(k, { p, vals: [] });
    labsByDay.get(k).vals.push(val);
  }
  for (const { p, vals } of labsByDay.values()) items.push({ date: p.date, approx: p.approx, kind: "labs", text: vals.join("; ") });

  items.sort((a, b) => a.date - b.date || ORDER[a.kind] - ORDER[b.kind]);

  const entries = items.map((it) => {
    let phase, label;
    if (adm && it.date < adm) { phase = "before"; label = `Before admission — ${fmtA(it.date, it.approx)}`; }
    else if (adm) { phase = "stay"; label = `Day ${Math.floor((it.date - adm) / DAY) + 1} — ${fmt(it.date)}`; }
    else { phase = "stay"; label = fmtA(it.date, it.approx); }
    const tag = { past: "Past history", admission: "Admission", progress: "Progress", event: "Event", labs: "Investigations", imaging: "Imaging / tests" }[it.kind];
    return { when: it.date.getTime(), label, phase, kind: it.kind, text: `${tag}: ${it.text}` };
  });

  // Serial lab trends (two or more dated values of the same test).
  const series = new Map();
  for (const r of inv) {
    const p = parseDate(r.date, adm);
    if (!p || !r.test || !r.value) continue;
    const k = norm(r.test);
    if (!series.has(k)) series.set(k, { name: r.test, pts: [] });
    series.get(k).pts.push({ t: p.date, v: `${r.value}${r.unit ? ` ${r.unit}` : ""}` });
  }
  const trends = [...series.values()].filter((s) => s.pts.length > 1).map((s) =>
    `${s.name}: ${s.pts.sort((a, b) => a.t - b.t).map((x) => `${x.v} (${fmt(x.t)})`).join(" → ")}`);

  const lines = [];
  if (undatedPast.length) lines.push("BACKGROUND (undated): " + undatedPast.join(" | "));
  let last = "";
  for (const e of entries) {
    if (e.label !== last) { lines.push(`\n[${e.label}]`); last = e.label; }
    lines.push(`- ${e.text}`);
  }
  if (undated.length) lines.push("\n[Undated]\n- " + undated.join("\n- "));
  if (trends.length) lines.push("\nSERIAL TRENDS:\n- " + trends.join("\n- "));

  return { admission: adm ? fmt(adm) : "", entries, undatedPast, undated, trends, text: lines.join("\n").trim() };
}
