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

/* ---------- Built-in department templates ----------
   Guidance is written the way residents actually write summaries in Indian
   teaching hospitals: short sentences, usual ward shorthand, stock phrases.
   [square brackets] = fill from the case; ___ = value not in the notes. */
const PT_FIELDS = ["Name", "Age/Sex", "UHID", "IPD No.", "Date of Admission", "Date of Discharge"];
const ptSec = (fields = PT_FIELDS) => ({ heading: "Patient Details", kind: "patient_details", guidance: "", fields: [...fields] });
const txSec = () => ({ heading: "Treatment Given", kind: "treatment_given", guidance: "", optional: true });
const medSec = (lead = "Discharged on the following medications:") => ({ heading: "Discharge Medications", kind: "discharge_medications", guidance: lead });
const signSec = () => ({ heading: "", kind: "signature", guidance: "", fields: ["Junior Resident", "Senior Resident", "Consultant"] });
const ADVICE_RULES = `Write one instruction per line (single line breaks), numbered, short, the way advice is written on a discharge card. Only what the notes document: never add diet, salt or fluid restriction, exercise, lifestyle or counselling lines on your own. Mention every drug kept on hold, every documented follow-up and every awaited report.`;
const COURSE_RULE = `Cover every dated note in order. Compare repeat reports with the earlier value ("creatinine came down from ___ to ___ mg/dL"). Name each drug added, stopped or changed and why, if written. Only write "improved" if the notes say so. Usually 3 to 6 short paragraphs; a long stay can be grouped into phases.`;

const GM = {
  id: "default",
  name: "General Medicine",
  title: "DISCHARGE SUMMARY",
  department: "Department of General Medicine",
  sections: [
    ptSec(),
    { heading: "Final Diagnosis", kind: "diagnosis", guidance:
`As written on the file: main diagnosis first (with cause and severity if documented), then complications, then comorbidities with duration (e.g. "[Type 2 DM] - [duration]").` },
    { heading: "Clinical Summary", kind: "narrative", guidance:
`Paragraphs in this order. Leave out any line that has nothing documented.

1. Background: "[Age] yr old [male/female], k/c/o [comorbidities with duration] on [regular medications]. [Old illnesses, earlier admissions and procedures, oldest first, with month/year.] [Reports done before this admission, with date and main finding.]"

2. Present illness: "Presented with c/o [complaints with duration]. Pt was apparently alright [duration] back, when he/she developed [first symptom], followed by [next symptoms in the order they came, how they progressed]. [Treatment taken outside / referred from, if written.] No h/o [relevant negatives that are documented]."

3. On admission: "On admission, pt was [conscious, oriented / drowsy], [afebrile / febrile]. BP ___ mmHg, PR ___/min, RR ___/min, temp ___, SpO2 ___% on [RA / O2 at ___ L/min]. GE: [pallor, icterus, cyanosis, clubbing, lymphadenopathy, oedema - as documented]. S/E: CVS - [ ]; RS - [ ]; P/A - [ ]; CNS - [ ]." Add GCS if charted.

4. Workup: "Investigations revealed [Hb, TLC, platelets], [RFT], [LFT], [electrolytes], [other bloods]. [Imaging] showed [findings]. [ECG / ECHO / cultures / serology] - [findings]. With the above clinical picture and reports, pt was diagnosed as a case of [final diagnosis]."

5. Hospital course: "Pt was started on [drugs with doses, IV fluids, O2, blood products]." Then day by day or phase by phase: how the pt was doing, vitals, repeat reports, drug changes, procedures, transfusions, referrals and what they advised, complications and how they were handled. ${COURSE_RULE}

6. End of stay as per OUTCOME. For discharge: "At the time of discharge, pt is [conscious, oriented, afebrile], hemodynamically stable. BP ___ mmHg, PR ___/min, SpO2 ___% on RA. [Taking orally / ambulatory / passing urine adequately - only if documented.] Pt is being discharged in stable condition with the following advice."` },
    txSec(),
    medSec(),
    { heading: "Advice on Discharge", kind: "advice", guidance:
`Like this:
1. Continue medications as advised. [Duration of named drugs if documented: "Tab ___ to be continued for ___ days".]
2. [Drug] on hold till [review / condition]. (one line for each held drug, with reason if written)
3. [Test] after [interval]. (only monitoring that is documented)
4. Follow up in [department] OPD after [interval / on date] with reports. ("[Test] report awaited - to be collected and shown in OPD" for each pending report.)
5. Review SOS in emergency in case of [4 to 6 warning symptoms that fit this case].
${ADVICE_RULES}` },
    signSec(),
  ],
};

const ONCO = {
  id: "bi-onco",
  name: "Medical Oncology / Hematology",
  title: "DISCHARGE SUMMARY",
  department: "Department of Medical Oncology and Hematology",
  sections: [
    ptSec(),
    { heading: "Diagnosis", kind: "diagnosis", guidance:
`Line 1, the way oncology files write it: [site / type], [histology], [grade], [stage - TNM / ISS / R-ISS / Ann Arbor / risk group, as documented], [key IHC, molecular or cytogenetic markers as documented], [status: newly diagnosed / on treatment / relapsed / refractory / in remission], [current regimen with "post C_ D_" if documented], [ECOG PS if documented].
Line 2: the reason for this admission (febrile neutropenia, tumour lysis, chemo toxicity, "for C_ of ___", etc.).
Then other complications, then comorbidities.` },
    { heading: "Oncology History", kind: "narrative", guidance:
`Date-wise list of the cancer before this admission, oldest first, one event per line (single line breaks), like an oncology file:
"[Month/Year] - [first symptoms / how it was picked up]
[Date] - [biopsy / BM / PET-CT / staging scan]: [result]
[Date] - Started on [regimen] ([intent if written]); received [n] cycles, last on [date]. Response: [CR / PR / SD / PD on which scan]
[Date] - [surgery / RT dose and fractions / transplant / relapse and change of line, with reason]"
Only events in the case data. Nothing from the current admission here. If there is no earlier history, write: Newly diagnosed during this admission.` },
    { heading: "Clinical Summary", kind: "narrative", guidance:
`1. "[Age] yr old [male/female], a known case of [cancer with stage], on [current regimen], last cycle (C_) on [date], k/c/o [other comorbidities]. Presented with c/o [complaints with duration] [on D_ post C_, if written]. No h/o [relevant negatives that are documented]."

2. "On admission, pt was [general condition], ECOG ___. BP ___ mmHg, PR ___/min, RR ___/min, temp ___, SpO2 ___% on [RA / O2]. GE: [pallor, icterus, lymphadenopathy, mucositis, oedema]. S/E: [findings, incl. liver / spleen size, mass, port / PICC site]."

3. "Investigations revealed Hb ___, TLC ___ (ANC ___), platelets ___. [RFT, LFT, electrolytes, uric acid, LDH, calcium as relevant.] [Cultures with organism and sensitivity.] [Imaging.] [Tumour markers / BM.]"` },
    { heading: "Hospital Course", kind: "narrative", guidance:
`"Pt was managed as a case of [febrile neutropenia / tumour lysis / ___] with [antibiotics with doses and start dates, G-CSF, IV fluids, allopurinol / rasburicase, transfusions with units]."
Then date-wise: fever spikes and when the fever settled, ANC and platelet counts as they changed ("ANC recovered to ___ on [date]"), culture reports and the escalation or de-escalation they led to, transfusions (product and units), toxicities with grade if written, procedures (BM, line insertion, LP / IT chemo), consultations and their advice.
Chemotherapy given in this admission: "Received C_ D_ of [regimen] on [date] (Ht ___ cm, Wt ___ kg, BSA ___ m²): [each drug with dose, as charted]." Then how it was tolerated, as written.
${COURSE_RULE}
End as per OUTCOME. For discharge: "At discharge, pt is afebrile [for ___ hrs if written], hemodynamically stable, [taking orally]. Counts: Hb ___, TLC ___, platelets ___. Being discharged in stable condition."` },
    txSec(),
    medSec(),
    { heading: "Advice on Discharge", kind: "advice", guidance:
`Like this:
1. Continue medications as advised. [Antibiotics to complete, steroid taper, antiemetics, prophylaxis (antiviral / antifungal / PCP), with duration, as documented.]
2. [Drug] on hold till [review].
3. CBC [and RFT / LFT] on [day / date]. (only if documented)
4. Next cycle (C_) of [regimen] due on [date] - to come to day care with CBC, RFT, LFT. Follow up in [department] OPD after [interval] with reports. "[Biopsy IHC / PET / BM] report awaited - to be collected" for each pending report.
5. Review SOS in emergency in case of fever, bleeding from any site, breathlessness, loose stools or vomiting not settling, reduced urine output [and other symptoms that fit this case].
${ADVICE_RULES}` },
    signSec(),
  ],
};

const DAYCARE = {
  id: "bi-daycare",
  name: "Chemotherapy Day Care (short)",
  title: "DAY CARE SUMMARY",
  department: "Department of Medical Oncology and Hematology",
  sections: [
    ptSec(["Name", "Age/Sex", "UHID", "Day Care No.", "Date of Admission", "Date of Discharge"]),
    { heading: "Diagnosis", kind: "diagnosis", guidance:
`One or two lines: [cancer, histology, stage, key markers as documented], [status], on [regimen] - [intent if written]. Then comorbidities.` },
    { heading: "Chemotherapy Details", kind: "narrative", guidance:
`Keep it short, the way day care summaries are written. No hospital course.

"[Age] yr old [male/female], a known case of [diagnosis with stage], on [regimen], admitted in day care for C_ [D_] of [regimen]."

"Pre-chemo: pt [asymptomatic / complaints], ECOG ___. Wt ___ kg, Ht ___ cm, BSA ___ m². BP ___ mmHg, PR ___/min. CBC: Hb ___, TLC ___, ANC ___, platelets ___. [RFT / LFT values.]"

"Received [drug] ___ mg [(___ mg/m²)] [IV over ___ in ___ mL NS], [next drug ...], after premedication with [antiemetics, steroid, antihistamine as charted]."

"[Tolerated well / infusion reaction or other event and how it was managed.] Discharged in stable condition." Write "tolerated well" only if the notes say so.` },
    medSec("Medications to take at home:"),
    { heading: "Advice", kind: "advice", guidance:
`Like this:
1. [Post-chemo drugs: antiemetics, G-CSF injection dates, steroids, mouthwash, with duration, as documented.]
2. CBC on D_ / [date]. (only if documented)
3. Next cycle (C_) due on [date] - to come with CBC, RFT, LFT [as documented].
4. Review SOS in emergency in case of fever, vomiting not settling, loose stools, bleeding, breathlessness [and others that fit].
${ADVICE_RULES}` },
    signSec(),
  ],
};

const NEPHRO = {
  id: "bi-nephro",
  name: "Nephrology",
  title: "DISCHARGE SUMMARY",
  department: "Department of Nephrology",
  sections: [
    ptSec(),
    { heading: "Diagnosis", kind: "diagnosis", guidance:
`Main renal diagnosis as written: [AKI (KDIGO stage) / AKI on CKD / CKD stage ___ / ESRD on MHD via [access] since ___ / renal transplant recipient ([year], [donor]) with graft dysfunction], with [cause or biopsy diagnosis].
Then complications (hyperkalaemia, metabolic acidosis, uraemic encephalopathy, fluid overload, access infection), then comorbidities with duration.` },
    { heading: "Clinical Summary", kind: "narrative", guidance:
`1. "[Age] yr old [male/female], k/c/o [DM / HTN with duration]. [Renal history: CKD since ___, baseline creatinine ___ ([date]); on MHD ___ times/week via [AVF / catheter] since ___; transplant ___.] Presented with c/o [reduced urine output, swelling, breathlessness, vomiting, etc.] for ___. [h/o NSAID / contrast / native medicine intake - only if documented.] No h/o [relevant negatives]."

2. "On admission, BP ___ mmHg, PR ___/min, RR ___/min, SpO2 ___% on [RA / O2]. [Wt ___ kg.] GE: [pallor, pedal oedema, JVP]. S/E: [RS crepts, CVS, P/A, CNS - asterixis / sensorium]. [Urine output ___ mL/day.]"

3. "Urea ___, creatinine ___, Na ___, K ___, [HCO3 / ABG], Ca ___, PO4 ___, uric acid ___, Hb ___. Urine R/M: [protein, RBC, pus cells, casts]. [UPCR / 24-hr urine protein.] USG KUB: [kidney sizes, echotexture, CMD]. [ANA, ANCA, anti-GBM, C3 / C4, viral markers.] [Renal biopsy ([date]): findings.] Pt was diagnosed as a case of [diagnosis]."` },
    { heading: "Hospital Course", kind: "narrative", guidance:
`"Pt was managed with [IV fluids / diuretics, anti-hyperkalaemic measures, soda bicarbonate, antibiotics, antihypertensives, EPO / iron]."
Then date-wise: urine output and weight; dialysis - catheter insertion (site and date), each HD / SLED session or the number of sessions with dates and UF if written; urea, creatinine and K trend ("creatinine ___ -> ___ -> ___"); renal biopsy and immunosuppression (drug, dose, dates); transfusions; complications and consults.
${COURSE_RULE}
End as per OUTCOME. For discharge: "At discharge, pt is [conscious, oriented], BP ___ mmHg, urine output ___ mL/day, creatinine ___ mg/dL ([date]). [Dialysis independent / on MHD; dry weight ___ kg.] Being discharged in stable condition."` },
    txSec(),
    medSec(),
    { heading: "Advice on Discharge", kind: "advice", guidance:
`Like this:
1. Continue medications as advised. [Durations; immunosuppressant doses and level checks, as documented.]
2. [Drug] on hold till [review].
3. MHD ___ times/week via [access] at [centre] / next dialysis on [date]. (only if documented)
4. RFT and serum electrolytes after [interval]. (only if documented)
5. Follow up in Nephrology OPD after [interval] with reports. "[Biopsy / serology] report awaited" for each pending report.
6. Review SOS in emergency in case of reduced urine output, swelling, breathlessness, fever or chills (also at catheter site or during dialysis), vomiting, drowsiness, palpitations.
${ADVICE_RULES}` },
    signSec(),
  ],
};

const CARDIO = {
  id: "bi-cardio",
  name: "Cardiology",
  title: "DISCHARGE SUMMARY",
  department: "Department of Cardiology",
  sections: [
    ptSec(),
    { heading: "Diagnosis", kind: "diagnosis", guidance:
`As written: [ACS type - STEMI ([wall]) / NSTEMI / UA], [Killip class], [thrombolysed with ___ / primary PCI / late presentation], [CAG: SVD / DVD / TVD], [s/p PTCA to ___ with ___ stent(s) on [date]], [LVEF ___%], [heart failure / arrhythmia / valve lesion with severity].
Then complications, then risk factors (DM, HTN, dyslipidaemia, smoker).` },
    { heading: "Clinical Summary", kind: "narrative", guidance:
`1. "[Age] yr old [male/female], k/c/o [risk factors with duration], [smoker - ___ pack-yrs, if written], [old CAD: earlier MI / PCI / CABG with dates]. Presented with c/o [chest pain - site, type, radiation, duration, time of onset / breathlessness (NYHA ___) / palpitations / syncope], associated with [sweating, vomiting]. [Treatment received outside: loading dose / thrombolysis with time.]"

2. "On admission, BP ___ mmHg, PR ___/min [regular / irregular], RR ___/min, SpO2 ___% on [RA / O2]. [JVP, basal crepts, S3, murmurs.] Killip class ___."

3. "ECG: [rhythm, ST changes with leads]. Trop I / T ___ [serial values]. ECHO: [RWMA, LVEF ___%, MR grade, valves, clot, pericardial effusion]. [Lipid profile, HbA1c, RFT, electrolytes.] [CXR.] Pt was diagnosed as a case of [diagnosis]."` },
    { heading: "Procedure Details", kind: "narrative", guidance:
`Only what the procedure note says, in this form:
"CAG ([date], via [right radial / femoral]): [LMCA, LAD, LCx, RCA findings with % stenosis] - [SVD / DVD / TVD]."
"PTCA ([date]): [culprit vessel and segment], [predilatation], [stent name ___ x ___ mm], [post-dilatation], TIMI ___ flow achieved."
[Other procedures - TPI, IABP, pericardiocentesis, PPI / ICD - with date and details.]
If no procedure is documented in this admission, write: Nil.` },
    { heading: "Hospital Course", kind: "narrative", guidance:
`"Pt was started on [DAPT (loading doses), anticoagulant, statin, beta blocker, nitrates, diuretics, inotropes - with doses]."
Then date-wise: chest pain, BP and HR, rhythm events and how they were managed, inotrope weaning, repeat ECG / Trop / ECHO, access site, creatinine after contrast, complications and consults.
${COURSE_RULE}
End as per OUTCOME. For discharge: "At discharge, pt is chest pain free, hemodynamically stable, BP ___ mmHg, PR ___/min, [ambulating]. Being discharged in stable condition."` },
    txSec(),
    medSec(),
    { heading: "Advice on Discharge", kind: "advice", guidance:
`Like this:
1. Continue medications as advised. [DAPT duration and "not to stop antiplatelets without consulting cardiologist" - only if documented.]
2. [Drug] on hold till [review].
3. [Repeat ECHO / lipid profile / RFT after ___.] (only if documented)
4. Follow up in Cardiology OPD after [interval] with reports.
5. Review SOS in emergency in case of chest pain, breathlessness, palpitations, giddiness or fainting, [bleeding from any site if on antiplatelets / anticoagulants], [swelling or pain at puncture site if a procedure was done].
${ADVICE_RULES}` },
    signSec(),
  ],
};

const PULM = {
  id: "bi-pulm",
  name: "Pulmonary Medicine / RICU",
  title: "DISCHARGE SUMMARY",
  department: "Department of Pulmonary Medicine",
  sections: [
    ptSec(),
    { heading: "Diagnosis", kind: "diagnosis", guidance:
`As written: [AECOPD / pneumonia (CURB-65 ___) / ILD / asthma exacerbation / TB (site, CBNAAT and rifampicin result) / pleural effusion (type, cause)], with [type 1 / type 2 respiratory failure], [organism if isolated].
Then complications (pneumothorax, VAP, cor pulmonale), then comorbidities; smoking status (pack-yrs) if written.` },
    { heading: "Clinical Summary", kind: "narrative", guidance:
`1. "[Age] yr old [male/female], [smoker - ___ pack-yrs / biomass exposure / occupational exposure, as written], k/c/o [COPD / asthma / ILD / old TB with duration and treatment, inhalers, home O2], [earlier admissions, NIV or intubation]. Presented with c/o [breathlessness (mMRC ___), cough with / without expectoration, fever, chest pain, haemoptysis] for ___."

2. "On admission, pt was [in respiratory distress / using accessory muscles / drowsy], RR ___/min, SpO2 ___% on [RA / O2 ___ L/min], BP ___ mmHg, PR ___/min, temp ___. RS: [air entry, breath sounds, wheeze, crepts - side and zone]."

3. "ABG at admission: pH ___, pCO2 ___, pO2 ___, HCO3 ___ [on FiO2 ___]. [CBC, RFT, LFT.] CXR: [findings]. [HRCT / CECT chest.] Sputum: [Gram stain, AFB, CBNAAT / TrueNat with rifampicin result, culture]. [BAL / pleural fluid with ADA, procalcitonin, ECHO (PAH, RVSP).] Pt was diagnosed as a case of [diagnosis]."` },
    { heading: "Hospital Course", kind: "narrative", guidance:
`"Pt was managed with [O2 / NIV (BiPAP, IPAP ___ / EPAP ___) / HFNC / intubation and MV from [date]], [nebulisation, steroids, antibiotics with doses]."
Then date-wise: work of breathing, O2 requirement, serial ABG ("pCO2 ___ -> ___"), NIV hours and weaning, ventilator days and extubation date, CXR changes, culture reports and antibiotic changes, procedures (ICD insertion / removal dates, thoracocentesis volume and colour, bronchoscopy), consults.
${COURSE_RULE}
End as per OUTCOME. For discharge: "At discharge, pt is maintaining SpO2 ___% on [RA / O2 ___ L/min], RR ___/min, afebrile, [ambulatory]. Being discharged in stable condition."` },
    txSec(),
    medSec(),
    { heading: "Advice on Discharge", kind: "advice", guidance:
`Like this:
1. Continue medications as advised. [Inhalers with device; ATT with phase and duration; steroid taper - as documented.]
2. [Drug] on hold till [review].
3. [Home O2 ___ L/min for ___ hrs/day / home NIV settings.] (only if documented)
4. [PFT / repeat CXR after ___.] (only if documented)
5. Follow up in Pulmonary Medicine OPD after [interval] with reports. "[Sputum culture / DST / biopsy] report awaited" for each pending report.
6. Review SOS in emergency in case of increased breathlessness, drowsiness, fever, blood in sputum, chest pain, bluish lips.
${ADVICE_RULES}` },
    signSec(),
  ],
};

const NEURO = {
  id: "bi-neuro",
  name: "Neurology",
  title: "DISCHARGE SUMMARY",
  department: "Department of Neurology",
  sections: [
    ptSec(),
    { heading: "Diagnosis", kind: "diagnosis", guidance:
`As written: syndrome with localisation and cause (e.g. "[acute ischaemic stroke] - [territory]"), [thrombolysed with ___ / not thrombolysed (reason if written)], [NIHSS at admission ___ / discharge ___], then complications, then risk factors and comorbidities.` },
    { heading: "Clinical Summary", kind: "narrative", guidance:
`1. "[Age] yr old [right / left handed, if written] [male/female], k/c/o [risk factors with duration]. Presented with [sudden onset / gradually progressive] [weakness of ___ / slurring of speech / seizures (type, number, duration, post-ictal state) / headache / altered sensorium] since ___. [Last known normal time / onset to door time.] [Progression; preceding fever, diarrhoea or vaccination.] No h/o [trauma, similar episodes, other relevant negatives]."

2. "On admission, GCS ___ (E_V_M_), BP ___ mmHg, PR ___/min, RBS ___. Higher mental functions: [ ]. Speech: [ ]. Cranial nerves: [ ]. Motor: tone [ ], power [R UL ___/5, R LL ___/5, L UL ___/5, L LL ___/5], DTRs [ ], plantars [ ]. Sensory: [ ]. Cerebellar: [ ]. Meningeal signs: [ ]. [NIHSS ___.]"

3. "[NCCT / MRI brain] ([date]): [findings]. [MRA / CTA, carotid Doppler, ECHO, Holter.] [CSF: cells, protein, sugar, ADA, Gram / AFB, CBNAAT, culture.] [EEG.] [NCS / EMG.] [Lipid profile, HbA1c, B12, TSH, vasculitic / viral markers.] Pt was diagnosed as a case of [diagnosis]."` },
    { heading: "Hospital Course", kind: "narrative", guidance:
`"Pt was managed with [thrombolysis - drug, dose and time / antiplatelets / anticoagulation / AEDs with doses / IVIG or PLEX with dates and cycles / steroids / antibiotics, antivirals / anti-oedema measures]."
Then date-wise: GCS and power changes, further seizures, swallow assessment and feeding (RT / oral), airway (NIV / intubation; SBC, NIF in GBS), repeat imaging, physiotherapy, complications (aspiration, bedsores, DVT) and consults.
${COURSE_RULE}
End as per OUTCOME. For discharge: "At discharge, pt is conscious, [oriented], GCS ___, power [___], [mRS ___], [taking orally / on RT feeds], [walking with / without support]. Being discharged in stable condition."` },
    txSec(),
    medSec(),
    { heading: "Advice on Discharge", kind: "advice", guidance:
`Like this:
1. Continue medications as advised. [AEDs - "not to stop on own" if documented; antiplatelet / anticoagulant duration.]
2. [Drug] on hold till [review].
3. [RT feeding, position change every 2 hrs, physiotherapy, catheter care - only if documented.]
4. [Driving / swimming / working at heights restriction - only if documented.]
5. Follow up in Neurology OPD after [interval] with reports. "[Report] awaited" for each pending report.
6. Review SOS in emergency in case of new weakness, seizures, drowsiness or confusion, severe headache, vomiting, difficulty in swallowing or breathing.
${ADVICE_RULES}` },
    signSec(),
  ],
};

const GASTRO = {
  id: "bi-gastro",
  name: "Gastroenterology / Hepatology",
  title: "DISCHARGE SUMMARY",
  department: "Department of Gastroenterology",
  sections: [
    ptSec(),
    { heading: "Diagnosis", kind: "diagnosis", guidance:
`As written: e.g. [decompensated CLD - [cause], CTP class ___ (___), MELD ___] with [ascites / variceal bleed / HE grade ___ / SBP / HRS-AKI / jaundice], [UGIE: varices grade, EVL with ___ bands on [date]]; or [acute pancreatitis (cause, severity)], [UGI / LGI bleed with source], [IBD - extent and severity], [obstructive jaundice - cause].
Then complications, then comorbidities.` },
    { heading: "Clinical Summary", kind: "narrative", guidance:
`1. "[Age] yr old [male/female], [alcohol intake ___ for ___ yrs, last drink ___ - if written], k/c/o [CLD since ___, earlier decompensations, earlier EVL / paracentesis, HBV / HCV treatment, other comorbidities]. Presented with c/o [haematemesis / melena (episodes) / abdominal distension / yellowish discolouration of eyes / altered sensorium / pain abdomen] for ___."

2. "On admission, pt was [conscious / drowsy, HE grade ___], BP ___ mmHg, PR ___/min. GE: [pallor, icterus, pedal oedema, flaps, stigmata of CLD]. P/A: [distension, shifting dullness, organomegaly, tenderness]. [Wt ___ kg, abdominal girth ___ cm.]"

3. "Hb ___, TLC ___, platelets ___. LFT: T. bil ___ (D ___), SGOT / SGPT ___ / ___, ALP ___, albumin ___; PT / INR ___. [RFT, Na, K.] [Amylase / lipase.] USG abdomen: [liver size, echotexture, PV diameter, spleen, ascites]. [Ascitic fluid: TLC, neutrophils, SAAG, protein, culture.] [Viral markers, AFP.] [UGIE ([date]): findings.] [CECT / MRCP.] Pt was diagnosed as a case of [diagnosis]."` },
    { heading: "Hospital Course", kind: "narrative", guidance:
`"Pt was managed with [terlipressin / octreotide, PPI, ceftriaxone, blood transfusion (units), lactulose, rifaximin, albumin, diuretics, antibiotics - with doses]."
Then date-wise: bleed control, Hb trend and transfusions, EVL / endoscopic therapy with date and number of bands, paracentesis with dates and volume (and albumin given), HE grade and stool frequency, bilirubin / INR / creatinine / Na trend, complications and consults.
${COURSE_RULE}
End as per OUTCOME. For discharge: "At discharge, pt is conscious, oriented, [no flaps], [no fresh bleed since ___], [passing ___ stools/day], [abdomen soft / ascites ___], [Wt ___ kg]. Being discharged in stable condition."` },
    txSec(),
    medSec(),
    { heading: "Advice on Discharge", kind: "advice", guidance:
`Like this:
1. Continue medications as advised. [Diuretics; beta blocker with target HR; lactulose to pass ___ stools/day - as documented.]
2. [Drug] on hold till [review].
3. [Complete abstinence from alcohol - only if documented.]
4. [Repeat EVL on ___ / LFT, RFT, Na after ___.] (only if documented)
5. Follow up in [department] OPD after [interval] with reports. "[Report] awaited" for each pending report.
6. Review SOS in emergency in case of blood vomiting, black stools, confusion or excess sleepiness, pain abdomen with fever, reduced urine output, increasing distension.
${ADVICE_RULES}` },
    signSec(),
  ],
};

export const DEFAULT_TEMPLATE = GM;
export const BUILTIN_TEMPLATES = [GM, ONCO, DAYCARE, NEPHRO, CARDIO, PULM, NEURO, GASTRO];
export const isBuiltin = (id) => !id || BUILTIN_TEMPLATES.some((t) => t.id === id);
export const builtinById = (id) => BUILTIN_TEMPLATES.find((t) => t.id === id) || GM;

/** Suggest a built-in from the department read off the sheets. Order matters
 *  ("Medical Oncology", "Pulmonary Medicine" also contain "medic"). */
const SUGGEST = [
  [/onco|hemat|haemat|\bbmt\b/i, "bi-onco"],
  [/nephro|renal|dialysis/i, "bi-nephro"],
  [/cardio|\bccu\b|cardiac|\bcath/i, "bi-cardio"],
  [/pulmo|chest|respirat|\bricu\b|tuberc/i, "bi-pulm"],
  [/neuro(?!.*surg)/i, "bi-neuro"],
  [/gastro|hepat|liver|\bgi\b/i, "bi-gastro"],
  [/medicine|\bmicu\b|\bmmw\b|\bfmw\b/i, "default"],
];
export function suggestBuiltin(dept) {
  const s = String(dept || "");
  if (!s.trim()) return null;
  for (const [re, id] of SUGGEST) if (re.test(s)) return id;
  return null;
}

/* ---------- helpers ---------- */
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
/* ---------- Fact check ----------
 * Every date and number the AI wrote is compared with the doctor-reviewed data.
 * Anything not found there is highlighted so a wrong fact can't slip through unnoticed. */
let FACTS = null; // { nums:Set, dates:Set } built from the reviewed data, or null = off
const numKey = (x) => String(parseFloat(String(x).replace(/,/g, "")));
export function setFactSource(text) {
  if (text == null) { FACTS = null; return; }
  const t = String(text);
  const nums = new Set(), dates = new Set();
  for (const m of t.matchAll(/\b(\d{1,2})\s*[/.-]\s*(\d{1,2})(?:\s*[/.-]\s*(\d{2,4}))?(?!\d)/g)) {
    dates.add(`${+m[1]}-${+m[2]}`);
    nums.add(numKey(m[1])); nums.add(numKey(m[2])); if (m[3]) nums.add(numKey(m[3]));
  }
  for (const m of t.replace(/(\d),(\d)/g, "$1$2").matchAll(/\d+(?:\.\d+)?/g)) nums.add(numKey(m[0]));
  FACTS = { nums, dates };
}
const UNV = (m) => `<mark class="unv" title="Not found in the reviewed data — check this">${m}</mark>`;
function factCheck(html) {
  if (!FACTS) return html;
  // Work only on text outside tags.
  return html.replace(/(<[^>]+>)|([^<]+)/g, (all, tag, text) => {
    if (tag) return tag;
    return text.replace(/\b(\d{1,2})\s*[/.-]\s*(\d{1,2})(?:\s*[/.-]\s*(\d{2,4}))?(?!\d)|\b\d+(?:[.,]\d+)*\b/g, (m, d, mo) => {
      if (d !== undefined) return FACTS.dates.has(`${+d}-${+mo}`) ? m : UNV(m);
      const v = parseFloat(m.replace(/,/g, ""));
      if (Number.isInteger(v) && v < 10) return m; // small counts ("2 days", "day 3") are too noisy to check
      if (v >= 1950 && v <= 2100 && FACTS.nums.has(numKey(m))) return m;
      return FACTS.nums.has(numKey(m)) ? m : UNV(m);
    });
  });
}
const hl = (s) => factCheck(esc(s)).replace(/_{3,}|\[\?\]/g, (m) => `<mark>${m}</mark>`);
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
          const k = fieldKey(label);
          const val = k === "agesex" ? blank(v) : writeIn(v);
          // name/doa/dod can be filled later on the final screen without rebuilding the summary
          return `<td><b>${esc(label)}:</b> ${["name", "doa", "dod"].includes(k) ? `<span data-pf="${k}">${val}</span>` : val}</td>`;
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
