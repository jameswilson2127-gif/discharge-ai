// checks.js — prescribing aids that only compare the doctor's own reviewed data.
// No AI and no clinical advice:
//  • labPanel(): latest prescribing-relevant lab values (with trend), flagged against the
//    lab sheet's H/L or standard adult reference ranges, and which groups are missing.
//  • consistencyIssues(): mismatches between the discharge drug list and the case file
//    (drug on hold, documented allergy / "avoid", stopped during stay, dose change, added by hand).
import { parseDate } from "./chrono.js?v=18";

/* ---------------- Lab panel ---------------- */

// [key, label, group, matcher on test name, low, high, unit shown]
// Ranges: standard adult reference ranges; Hb uses sex-specific limits.
const LABS = [
  ["creat", "Creatinine", "Renal", /creat/i, 0.6, 1.2, "mg/dL"],
  ["urea", "Urea", "Renal", /\b(b\.?\s?)?urea\b|\bbun\b/i, 15, 45, "mg/dL"],
  ["egfr", "eGFR", "Renal", /e\s?gfr/i, 60, null, "mL/min"],
  ["na", "Sodium", "Electrolytes", /\bna\b|sodium/i, 135, 145, "mmol/L"],
  ["k", "Potassium", "Electrolytes", /\bk\b|\bk\+|potassium/i, 3.5, 5.1, "mmol/L"],
  ["mg", "Magnesium", "Electrolytes", /\bmg\b|magnes/i, 1.7, 2.4, "mg/dL"],
  ["ca", "Calcium", "Electrolytes", /\bca\b|calcium/i, 8.5, 10.5, "mg/dL"],
  ["tbil", "Bilirubin (T)", "Liver", /bili.*\(?t|t\.?\s?bil|total\s*bil|^bilirubin$/i, 0.2, 1.2, "mg/dL"],
  ["sgot", "SGOT/AST", "Liver", /sgot|\bast\b/i, null, 40, "U/L"],
  ["sgpt", "SGPT/ALT", "Liver", /sgpt|\balt\b/i, null, 40, "U/L"],
  ["inr", "INR", "Liver", /\binr\b/i, null, 1.2, ""],
  ["alb", "Albumin", "Liver", /albumin/i, 3.5, 5.0, "g/dL"],
  ["hb", "Hb", "Blood counts", /\bhb\b|haemoglobin|hemoglobin/i, 12, 17, "g/dL"],
  ["plt", "Platelets", "Blood counts", /platelet|\bplt\b/i, 150, 410, "×10³/µL"],
  ["tlc", "TLC", "Blood counts", /\btlc\b|\bwbc\b|total\s*leu/i, 4, 11, "×10³/µL"],
  ["anc", "ANC", "Blood counts", /\banc\b|absolute\s*neut/i, 1.5, null, "×10³/µL"],
  ["rbs", "Blood sugar", "Glucose", /\b(r|f|pp)bs\b|blood\s*sugar|glucose/i, 70, 180, "mg/dL"],
  ["hba1c", "HbA1c", "Glucose", /hba1c|a1c/i, null, 6.4, "%"],
  ["qtc", "QTc", "ECG", /qtc/i, null, 460, "ms"],
];
const ESSENTIAL_GROUPS = ["Renal", "Electrolytes", "Liver", "Blood counts"];

function num(v) {
  const m = String(v ?? "").replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

// Counts are written many ways: "174K", "1.74 lakh", "174000", "6.78K", "6780".
function countValue(raw) {
  const s = String(raw ?? "").toLowerCase().replace(/,/g, "");
  let v = num(s);
  if (v === null) return null;
  if (/lakh|lac/.test(s)) v *= 100;
  else if (v >= 1000) v /= 1000;
  return v;
}

function flagFor(def, value, sheetFlag, sex) {
  const f = String(sheetFlag || "").trim().toUpperCase();
  if (/^(H|HIGH|↑)/.test(f)) return "H";
  if (/^(L|LOW|↓)/.test(f)) return "L";
  let [lo, hi] = [def[4], def[5]];
  if (def[0] === "hb") [lo, hi] = /^f/i.test(sex || "") ? [12, 15.5] : /^m/i.test(sex || "") ? [13, 17] : [12, 17];
  if (value === null) return "";
  if (lo !== null && value < lo) return "L";
  if (hi !== null && value > hi) return "H";
  return "";
}

export function labPanel(d) {
  d = d || {};
  const adm = parseDate(d.admission_date)?.date || null;
  const byKey = new Map();
  (d.investigations || []).forEach((r, i) => {
    const name = String(r.test || "");
    const def = LABS.find((x) => x[3].test(name));
    if (!def) return;
    // Skip mismatched units we can't compare (e.g. creatinine in µmol/L).
    if (def[0] === "creat" && /mol/i.test(r.unit || "")) return;
    const p = parseDate(r.date, adm);
    const value = ["plt", "tlc", "anc"].includes(def[0]) ? countValue(r.value) : num(r.value);
    const row = { t: p?.date?.getTime() ?? -1, i, raw: `${r.value}${r.unit ? ` ${r.unit}` : ""}`.trim(), value, date: r.date || "", flag: flagFor(def, value, r.flag, d.sex) };
    if (!byKey.has(def[0])) byKey.set(def[0], { def, rows: [] });
    byKey.get(def[0]).rows.push(row);
  });

  const items = [];
  for (const { def, rows } of byKey.values()) {
    rows.sort((a, b) => a.t - b.t || a.i - b.i);
    const last = rows.at(-1), prev = rows.length > 1 ? rows.at(-2) : null;
    let trend = "";
    if (prev && last.value !== null && prev.value !== null && last.value !== prev.value) trend = `${last.value > prev.value ? "↑" : "↓"} from ${prev.raw}`;
    items.push({ key: def[0], label: def[1], group: def[2], value: last.raw, date: last.date, flag: last.flag, trend });
  }
  const order = LABS.map((x) => x[0]);
  items.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));

  const present = new Set(items.map((x) => x.group));
  const missing = ESSENTIAL_GROUPS.filter((g) => !present.has(g));
  const allergies = (d.allergies || []).map((a) => [a.drug, a.reaction].filter(Boolean).join(" — ")).filter(Boolean);
  return { abnormal: items.filter((x) => x.flag), normal: items.filter((x) => !x.flag), missing, allergies };
}

/* ---------------- Consistency check ---------------- */

const FORM_WORDS = /\b(tab|tabs|tablet|cap|caps|capsule|inj|injection|syp|syrup|susp|inf|infusion|neb|nebulisation|oint|cream|drops?|iv|po|sc|im|t|c|i)\b\.?/gi;
const STOP_WORDS = new Set(["and", "with", "the", "for", "from", "dose", "plus", "then", "once", "twice", "daily", "stat", "drug", "drugs", "all", "any", "nephrotoxic", "hepatotoxic"]);

/** Main word of a drug name: "Tab. Avas 20 mg" → "avas", "Inj Pip-Taz 4.5g" → "pip-taz". */
export function drugKey(name) {
  const words = String(name || "").toLowerCase().replace(FORM_WORDS, " ").replace(/[^a-z\- ]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  return words[0] || "";
}
const sameDrug = (a, b) => {
  const x = drugKey(a), y = drugKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return x.length >= 5 && y.length >= 5 && (x.startsWith(y) || y.startsWith(x));
};

// Drug classes doctors write in "avoid …" / "allergic to …" notes, matched to member drugs (generic names).
const CLASSES = [
  [/^nsaid|^nonsteroid/, /ibuprofen|diclofenac|naproxen|aceclofenac|etodolac|ketorolac|indometh|mefenamic|piroxicam|nimesulide|etoricoxib|celecoxib|ketoprofen|aspirin/],
  [/^sulf|^sulph/, /sulfa|sulpha|cotrimoxazole|co-trimoxazole|septran|sulfasalazine|dapsone/],
  [/^penicillin|^beta-?lactam/, /penicillin|amoxi|ampicillin|piperacillin|pip-taz|piptaz|cloxacillin|flucloxacillin|augmentin/],
  [/^cephalo/, /^cef|^ceph/],
  [/^fluoroquinolone|^quinolone/, /floxacin/],
  [/^macrolide/, /thromycin|azithro/],
  [/^aminoglycoside/, /gentamicin|amikacin|tobramycin|streptomycin/],
  [/^statin/, /statin$/],
  [/^ace|^acei/, /pril$/],
  [/^arb/, /sartan$/],
  [/^beta-?blocker/, /olol$/],
  [/^opioid|^opiate/, /morphine|tramadol|tapentadol|fentanyl|codeine|pethidine|buprenorphine/],
  [/^benzodiazep/, /azepam$|azolam$/],
  [/^steroid|^corticosteroid/, /prednis|methylpred|dexameth|hydrocort|deflazacort|budesonide/],
  [/^anticoag/, /heparin|enoxaparin|warfarin|acitrom|apixaban|rivaroxaban|dabigatran|fondaparinux/],
  [/^antiplatelet/, /aspirin|clopidogrel|ticagrelor|prasugrel/],
];
function matchesMention(mention, drug) {
  if (sameDrug(mention, drug)) return true;
  const m = drugKey(mention), d = drugKey(drug);
  return CLASSES.some(([cls, members]) => cls.test(m) && members.test(d));
}

// Free-text places in the file where doctors write "avoid…", "allergic to…", "stopped…".
function textSources(d) {
  const out = [];
  const push = (text, where, date = "") => { if (text) out.push({ text: String(text), where, date }); };
  push(d.past_history_and_medications, "Past history");
  push(d.history_of_present_illness, "History");
  for (const r of d.past_events || []) push(r.detail, "Past history", r.when);
  for (const r of d.daily_progress || []) push(r.note, "Progress note", r.date);
  for (const r of d.events || []) push(r.description, "Event", r.date);
  push(d.follow_up_plan, "Discharge plan");
  return out;
}

function findMentions(sources, before, after) {
  const hits = [];
  for (const s of sources) {
    for (const m of s.text.matchAll(before)) hits.push({ drug: m[m.length - 1], ...s, quote: m[0].trim() });
    if (after) for (const m of s.text.matchAll(after)) hits.push({ drug: m[1], ...s, quote: m[0].trim() });
  }
  return hits;
}

const DRUG_TOKEN = String.raw`(?:inj\.?|tab\.?|cap\.?|syp\.?)?\s*([a-z][a-z\-]{3,})`;

/** Returns [{ id, level: "high"|"check"|"info", drug, text, where }] — never claims anything is safe. */
export function consistencyIssues(d) {
  d = d || {};
  const meds = d.medications || [];
  const discharge = meds.filter((m) => m.on_discharge && String(m.drug || "").trim());
  const issues = [];
  const add = (level, drug, text, where) => issues.push({ id: `${level}|${drugKey(drug)}|${text}`.slice(0, 160), level, drug, text, where });
  if (!discharge.length) return { issues, checked: 0 };

  const sources = textSources(d);
  const adm = parseDate(d.admission_date)?.date || null;
  const t = (s) => parseDate(s, adm)?.date?.getTime() ?? 0;

  // 1. Drug on hold → in discharge list.
  for (const h of d.held_drugs || []) {
    for (const m of discharge) if (sameDrug(h.drug, m.drug))
      add("high", m.drug, `${h.drug} is listed under "Drugs on hold"${h.reason ? ` (${h.reason})` : ""}, but ${m.drug} is ticked for discharge.`, "Drugs on hold");
  }

  // 2. Documented allergy or "avoid" → in discharge list.
  const allergyHits = [
    ...(d.allergies || []).map((a) => ({ drug: a.drug, where: "Allergies", quote: [a.drug, a.reaction].filter(Boolean).join(" — ") })),
    ...findMentions(sources, new RegExp(String.raw`\b(?:allerg(?:y|ic)\s*(?:to|:|-)?|avoid(?:ed)?|contraindicated\s*:?)\s*${DRUG_TOKEN}`, "gi")),
  ];
  for (const a of allergyHits) for (const m of discharge) if (matchesMention(a.drug, m.drug))
    add("high", m.drug, `The file says "${a.quote}"${a.date ? ` (${a.date})` : ""}, but ${m.drug} is ticked for discharge.`, a.where);

  // 3. Stopped / withheld during the stay and not restarted later.
  const stops = findMentions(sources,
    new RegExp(String.raw`\b(?:stop(?:ped)?|w\/h|withh?eld|withhold|discontinu(?:e|ed)|omit(?:ted)?|hold)\s*${DRUG_TOKEN}`, "gi"),
    /\b([a-z][a-z\-]{3,})\s+(?:was\s+)?(?:stopped|w\/h|withh?eld|discontinued|on hold|omitted)\b/gi);
  const restarts = findMentions(sources,
    new RegExp(String.raw`\b(?:restart(?:ed)?|resum(?:e|ed)|re-?start(?:ed)?|c\/w|continue[d]?)\s*${DRUG_TOKEN}`, "gi"));
  for (const s of stops) for (const m of discharge) {
    if (!sameDrug(s.drug, m.drug)) continue;
    if ((d.held_drugs || []).some((h) => sameDrug(h.drug, m.drug))) continue; // already reported above
    const later = restarts.some((r) => sameDrug(r.drug, m.drug) && t(r.date) >= t(s.date));
    if (!later) add("check", m.drug, `${s.where}${s.date ? ` ${s.date}` : ""} says "${s.quote}". It is ticked for discharge with no later note restarting it.`, s.where);
  }

  // 4. Dose / frequency differs from the same drug during the stay.
  for (const m of discharge) {
    const during = meds.filter((x) => x !== m && !x.on_discharge && sameDrug(x.drug, m.drug));
    const last = during.at(-1);
    if (!last) continue;
    const norm = (v) => String(v || "").toLowerCase().replace(/\s+/g, "");
    if (last.dose && m.dose && norm(last.dose) !== norm(m.dose))
      add("check", m.drug, `Dose differs: ${last.dose} during the stay, ${m.dose} on discharge. Check this is intended.`, "Medications");
    else if (last.frequency && m.frequency && norm(last.frequency) !== norm(m.frequency))
      add("check", m.drug, `Frequency differs: ${last.frequency} during the stay, ${m.frequency} on discharge. Check this is intended.`, "Medications");
  }

  // 5. Rows typed by hand that were not read from the photos.
  for (const m of discharge) if (m._manual) add("info", m.drug, `${m.drug} was added by hand, not read from the photos. Check the spelling and dose.`, "Medications");

  // De-duplicate.
  const seen = new Set();
  return { issues: issues.filter((x) => !seen.has(x.id) && seen.add(x.id)), checked: discharge.length };
}
