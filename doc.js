// Templates + document builder. Pure functions (no DOM), so they can be unit-tested.

export const KINDS = {
  patient_details:       { label: "Patient details (from step 1)",       ai: false, fields: true,  fieldsHint: "Field labels, comma-separated" },
  diagnosis:             { label: "Diagnosis list (AI)",                 ai: true,  guidance: true },
  narrative:             { label: "Paragraphs written by AI",            ai: true,  guidance: true },
  investigations_table:  { label: "Investigations table (from review)",  ai: false },
  treatment_given:       { label: "Treatment given (from review)",       ai: false },
  discharge_medications: { label: "Discharge medications (from review)", ai: false, guidance: true, guidanceHint: "Lead-in sentence before the list" },
  advice:                { label: "Advice / follow-up (AI)",             ai: true,  guidance: true },
  static_text:           { label: "Fixed text (printed as written)",     ai: false, guidance: true, guidanceHint: "Exact text to print" },
  signature:             { label: "Signature line",                      ai: false, fields: true,  fieldsHint: "Signatories, comma-separated" },
};

export const DEFAULT_TEMPLATE = {
  id: "default",
  name: "General Medicine (built-in)",
  title: "DISCHARGE SUMMARY",
  department: "Department of General Medicine",
  sections: [
    { heading: "Patient Details", kind: "patient_details", guidance: "",
      fields: ["Name", "Age/Sex", "UHID", "IPD No.", "Date of Admission", "Date of Discharge"] },
    { heading: "Final Diagnosis", kind: "diagnosis",
      guidance: "Primary diagnosis with associated comorbidities and complications, if any. Primary diagnosis first, then complications, then comorbidities/habits." },
    { heading: "Clinical Summary", kind: "narrative", guidance:
`Five paragraphs in this order:
1. "A [age]-year-old [male/female], known case of [comorbidities, if any], presented to the Department of General Medicine with complaints of [chief complaints with duration]. The patient was apparently well [duration] prior to admission, following which he/she developed [detailed history of presenting illness, progression, associated symptoms]. There was no history of [relevant negatives]. The patient had a previous history of [relevant medical/surgical history], and was taking [medications, if any]." Omit "known case of" / past-history sentences if there is nothing to say.
2. "On admission, the patient was [general condition and sensorium]. His/her vitals were as follows: blood pressure ___ mmHg, pulse rate ___/min, respiratory rate ___/min, temperature ___°C and SpO2 ___% on [room air/oxygen]. General examination revealed [relevant findings]. On systemic examination, [important positive and negative findings under CVS, respiratory system, abdomen and CNS]." Include GCS if given.
3. "Initial investigations revealed [important haematological and biochemical parameters]. Renal function tests showed [findings], liver function tests revealed [findings], and serum electrolytes were [findings]. Relevant imaging, including [USG/CT/MRI/X-ray], demonstrated [findings]. Other investigations, including [ECG, echocardiography, cultures, serology, etc.], were suggestive of [findings]. Based on the clinical presentation, examination and investigation profile, a diagnosis of [final diagnosis] was made." Skip clauses for tests not done.
4. "The patient was managed with appropriate medical treatment in the form of [specific medications, doses where relevant, supportive treatment, oxygen, IV fluids, antibiotics, steroids, blood products, procedures]. During the hospital stay, the patient was closely monitored clinically and through serial laboratory investigations. [Chronological course: response to treatment, significant changes in investigations, complications, specialist consultations, additional interventions with dates.] The patient showed [clinical/biochemical] improvement following the instituted treatment." (Only claim improvement if documented. The chronological course must be DETAILED: cover every dated note in order with vitals, investigation trends, treatment changes by drug name, procedures, consults and complications — usually 3–6 paragraphs.)
5. End-of-stay paragraph per OUTCOME. For discharge: "At the time of discharge, the patient was [conscious and oriented/haemodynamically stable/afebrile], with blood pressure ___ mmHg, pulse rate ___/min, respiratory rate ___/min and SpO2 ___% on [room air/oxygen]. The patient was [tolerating oral feeds/ambulating independently/maintaining adequate urine output, as applicable]. In view of the clinical improvement and stable condition, the patient is being discharged with the following medications and advice."` },
    { heading: "Treatment Given", kind: "treatment_given", guidance: "", optional: true },
    { heading: "Discharge Medications", kind: "discharge_medications", guidance: "The patient is being discharged on the following medications:" },
    { heading: "Discharge Advice and Follow-up", kind: "advice", guidance:
`"The patient and attendants have been counselled regarding the disease, medication compliance, dietary modifications and appropriate lifestyle measures. They have been advised to continue the prescribed medications and monitor [BP/blood glucose/body weight/other relevant parameters]. The patient has been advised to follow up in the General Medicine OPD after [interval] with [relevant investigation reports]. They have also been advised to report to the nearest emergency department in case of fever, worsening symptoms, breathlessness, chest pain, altered sensorium, seizures, reduced urine output or any other concerning symptoms." Tailor the warning symptoms to this case.` },
    { heading: "", kind: "signature", guidance: "", fields: ["Junior Resident", "Senior Resident", "Consultant"] },
  ],
};

/* ---------- helpers ---------- */
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const hl = (s) => esc(s).replace(/_{3,}|\[\?\]/g, (m) => `<mark>${m}</mark>`);
const paras = (t) => String(t || "").split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean)
  .map((x) => `<p>${hl(x).replace(/\n/g, "<br>")}</p>`).join("");
const blank = (v) => (v && String(v).trim() ? esc(v) : "<mark>___</mark>");
// Identifiers the app deliberately never collects (UHID, IPD, bed…) print as an
// empty line to be written by hand on the signed copy. Not flagged as "missing".
const writeIn = (v) => (v && String(v).trim() ? esc(v) : '<span class="writein"></span>');

export const medLine = (m) => [m.form, m.drug, m.dose, m.route, m.frequency]
  .map((x) => String(x ?? "").trim()).filter(Boolean).join(" ").toUpperCase();

/** Map a template field label to a standard patient key, or null for a custom field. */
export function fieldKey(label) {
  const l = String(label).toLowerCase();
  if (/ipd|\bi\.?p\.?\s*no|\bip\s*number|admission\s*no|in-?patient\s*no/.test(l)) return "ipd";
  if (/uhid|\bcr\.?\s*no|reg(istration)?\.?\s*no|\bmr\.?\s*no|\bmrd\b|hospital\s*no/.test(l)) return "uhid";
  if (/age|sex|gender/.test(l)) return "agesex";
  if (/\bname\b/.test(l) && !/consult|doctor|unit|ward|hospital|father|husband|guardian|attendant/.test(l)) return "name";
  if (/admission|\bdoa\b/.test(l)) return "doa";
  if (/discharge|\bdod\b|death|expir|referr|lama|dama/.test(l)) return "dod";
  return null;
}

/** Custom patient fields a template needs beyond the standard ones (shown in step 1). */
export function extraPatientFields(tpl) {
  const out = [];
  for (const s of tpl?.sections || []) {
    if (s.kind !== "patient_details") continue;
    for (const f of s.fields || []) if (!fieldKey(f) && f.trim() && !out.includes(f.trim())) out.push(f.trim());
  }
  return out;
}

/** Fields the app fills: name/dates (typed on this device, optional) and age/sex (from reviewed data).
 *  Everything else (UHID, IPD No., bed, unit…) is never collected and stays a write-in blank. */
export function patientValue(P, label) {
  const k = fieldKey(label);
  if (k === "agesex") return [P.age, P.sex].filter(Boolean).join(" / ");
  if (k === "name" || k === "doa" || k === "dod") return P[k] || "";
  return "";
}

const TITLES = { expired: "DEATH SUMMARY", referred: "REFERRAL SUMMARY" };
const NO_DISCHARGE_MEDS = new Set(["referred", "expired"]);

/** Build the printable HTML document. */
export function buildDoc(P, data, draft, tpl = DEFAULT_TEMPLATE) {
  const outcome = P.outcome || "discharged";
  const meds = (data.medications || []).filter((m) => medLine(m));
  const sec = draft.sections || {};
  let title = tpl.title || "DISCHARGE SUMMARY";
  if (TITLES[outcome] && /discharge\s+summary/i.test(title)) title = title.replace(/discharge\s+summary/i, TITLES[outcome]);
  const dept = P.dept || tpl.department || "";

  let h = `<h1>${esc(title)}</h1>${dept ? `<div class="dept">${esc(dept)}</div>` : ""}`;
  const head = (s) => (s.heading ? `<h2>${esc(s.heading)}</h2>` : "");

  tpl.sections.forEach((s, i) => {
    switch (s.kind) {
      case "patient_details": {
        const f = s.fields && s.fields.length ? s.fields : DEFAULT_TEMPLATE.sections[0].fields;
        const cells = f.map((label) => {
          const v = patientValue(P, label);
          return `<td><b>${esc(label)}:</b> ${fieldKey(label) === "agesex" ? blank(v) : writeIn(v)}</td>`;
        });
        const rows = [];
        for (let r = 0; r < cells.length; r += 3) rows.push(`<tr>${cells.slice(r, r + 3).join("")}</tr>`);
        h += `<table class="pt">${rows.join("")}</table>`;
        break;
      }
      case "diagnosis": {
        const dx = draft.final_diagnosis && draft.final_diagnosis.length ? draft.final_diagnosis : data.diagnoses || [];
        h += head(s) + (dx.length ? `<ol>${dx.map((x) => `<li>${hl(x)}</li>`).join("")}</ol>` : "<p><mark>___</mark></p>");
        break;
      }
      case "narrative": {
        const body = sec[`s${i}`];
        h += head(s) + (body && body.trim() ? paras(body) : "<p><mark>___</mark></p>");
        break;
      }
      case "advice": {
        const body = sec[`s${i}`];
        if (body && body.trim()) h += head(s) + paras(body);
        break;
      }
      case "investigations_table": {
        const inv = (data.investigations || []).filter((r) => r.test || r.value);
        const img = (data.imaging_and_other_tests || []).filter((r) => r.test || r.finding);
        if (!inv.length && !img.length) break;
        h += head(s) + `<table class="inv"><tr><th>Date</th><th>Investigation</th><th>Result</th></tr>${
          inv.map((r) => `<tr><td>${hl(r.date)}</td><td>${hl(r.test)}</td><td>${hl([r.value, r.unit].filter(Boolean).join(" "))}${r.flag ? ` (${esc(r.flag)})` : ""}</td></tr>`).join("")
        }${img.map((r) => `<tr><td>${hl(r.date)}</td><td>${hl(r.test)}</td><td>${hl(r.finding)}</td></tr>`).join("")}</table>`;
        break;
      }
      case "treatment_given": {
        const body = head(s) + (meds.length ? `<ol>${meds.map((m) => `<li>${hl(medLine(m))}</li>`).join("")}</ol>` : "<p><mark>___</mark></p>");
        h += s.optional ? `<div class="opt-sec">${body}</div>` : body;
        break;
      }
      case "discharge_medications": {
        if (NO_DISCHARGE_MEDS.has(outcome)) break;
        const d = meds.filter((m) => m.on_discharge);
        const intro = s.guidance && s.guidance.length < 300 ? `<p>${hl(s.guidance)}</p>` : "";
        h += head(s) + (d.length
          ? `${intro}<ol>${d.map((m) => `<li>${hl(medLine(m))}${m.dates ? ` — ${hl(m.dates)}` : ""}</li>`).join("")}</ol>`
          : "<p><mark>___</mark></p>");
        break;
      }
      case "static_text":
        if (s.guidance && s.guidance.trim()) h += head(s) + paras(s.guidance);
        break;
      case "signature": {
        const f = s.fields && s.fields.length ? s.fields : ["Signature"];
        h += `<div class="sign">${f.map((x) => `<div>${esc(x)}</div>`).join("")}</div>`;
        break;
      }
    }
  });
  return h;
}

/** Light validation/normalisation of a template coming from the AI or the editor. */
export function normaliseTemplate(t) {
  const sections = (Array.isArray(t?.sections) ? t.sections : []).slice(0, 25).map((s) => ({
    heading: String(s?.heading ?? "").slice(0, 120),
    kind: KINDS[s?.kind] ? s.kind : "narrative",
    guidance: String(s?.guidance ?? "").slice(0, 5000),
    fields: Array.isArray(s?.fields) ? s.fields.map((f) => String(f).trim()).filter(Boolean).slice(0, 20) : [],
    ...(s?.optional ? { optional: true } : {}),
  }));
  return { title: String(t?.title ?? "DISCHARGE SUMMARY").slice(0, 120), department: String(t?.department ?? "").slice(0, 160), sections };
}
