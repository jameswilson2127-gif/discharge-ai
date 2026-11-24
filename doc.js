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

const GM = {
  id: "default",
  name: "General Medicine",
  title: "DISCHARGE SUMMARY",
  department: "Department of General Medicine",
  sections: [
    { heading: "Patient Details", kind: "patient_details", guidance: "",
      fields: ["Name", "Age/Sex", "UHID", "IPD No.", "Date of Admission", "Date of Discharge"] },
    { heading: "Final Diagnosis", kind: "diagnosis",
      guidance: "Primary diagnosis with associated comorbidities and complications, if any. Primary diagnosis first, then complications, then comorbidities/habits." },
    { heading: "Clinical Summary", kind: "narrative", guidance:
`One continuous story in date order, in these paragraphs:
1. Background, oldest first: "A [age]-year-old [male/female], known case of [comorbidities with duration], on [long-term medications]. [Earlier illnesses, previous hospitalisations, procedures and their outcomes, in date order.] [Investigations done before this admission, with dates and key findings.]" Omit sentences with nothing to say.
2. Presenting illness: "The patient presented to the [department] with complaints of [chief complaints with duration]. The patient was apparently well [duration] prior to admission, following which he/she developed [symptoms in the order they began, progression, associated symptoms, treatment taken before admission]. There was no history of [relevant negatives]."
3. "On admission, the patient was [general condition and sensorium]. His/her vitals were as follows: blood pressure ___ mmHg, pulse rate ___/min, respiratory rate ___/min, temperature ___°C and SpO2 ___% on [room air/oxygen]. General examination revealed [relevant findings]. On systemic examination, [important positive and negative findings under CVS, respiratory system, abdomen and CNS]." Include GCS if given.
4. "Initial investigations revealed [important haematological and biochemical parameters]. Renal function tests showed [findings], liver function tests revealed [findings], and serum electrolytes were [findings]. Relevant imaging, including [USG/CT/MRI/X-ray], demonstrated [findings]. Other investigations, including [ECG, echocardiography, cultures, serology, etc.], were suggestive of [findings]. Based on the clinical presentation, examination and investigation profile, a diagnosis of [final diagnosis] was made." Skip clauses for tests not done.
5. "The patient was managed with appropriate medical treatment in the form of [specific medications, doses where relevant, supportive treatment, oxygen, IV fluids, antibiotics, steroids, blood products, procedures]. During the hospital stay, the patient was closely monitored clinically and through serial laboratory investigations. [Chronological course: response to treatment, significant changes in investigations, complications, specialist consultations, additional interventions with dates.] The patient showed [clinical/biochemical] improvement following the instituted treatment." (Only claim improvement if documented. The chronological course must be DETAILED: cover every dated note in order with vitals, investigation trends, treatment changes by drug name, procedures, consults and complications — the length must match how much is documented: more detail in the notes means a longer course.)
6. End-of-stay paragraph per OUTCOME. For discharge: "At the time of discharge, the patient was [conscious and oriented/haemodynamically stable/afebrile], with blood pressure ___ mmHg, pulse rate ___/min, respiratory rate ___/min and SpO2 ___% on [room air/oxygen]. The patient was [tolerating oral feeds/ambulating independently/maintaining adequate urine output, as applicable]. In view of the clinical improvement and stable condition, the patient is being discharged with the following medications and advice."` },
    { heading: "Treatment Given", kind: "treatment_given", guidance: "", optional: true },
    { heading: "Discharge Medications", kind: "discharge_medications", guidance: "The patient is being discharged on the following medications:" },
    { heading: "Discharge Advice and Follow-up", kind: "advice", guidance:
`"The patient and attendants have been counselled regarding the disease and medication compliance. They have been advised to [specific documented instructions: complete/continue named drugs with duration, eye/wound care, drugs kept on hold, diet only if documented] and monitor [parameters only if documented]. The patient has been advised to follow up in the [department] OPD after [interval] with [relevant investigation reports]. They have also been advised to report to the nearest emergency department in case of fever, worsening symptoms, breathlessness, chest pain, altered sensorium, seizures, reduced urine output or any other concerning symptoms." Tailor the warning symptoms to this case. Mention every documented follow-up (each OPD, interval, reports to bring, pending results). Never add generic advice (diet, lifestyle, body weight) that the notes do not mention.` },
    { heading: "", kind: "signature", guidance: "", fields: ["Junior Resident", "Senior Resident", "Consultant"] },
  ],
};

/* ---------- Built-in department templates ----------
   Same structure and formal style as General Medicine (the format users liked),
   with each department's own details added. */
const PT_FIELDS = ["Name", "Age/Sex", "UHID", "IPD No.", "Date of Admission", "Date of Discharge"];
const ptSec = (fields = PT_FIELDS) => ({ heading: "Patient Details", kind: "patient_details", guidance: "", fields: [...fields] });
const txSec = () => ({ heading: "Treatment Given", kind: "treatment_given", guidance: "", optional: true });
const medSec = () => ({ heading: "Discharge Medications", kind: "discharge_medications", guidance: "The patient is being discharged on the following medications:" });
const signSec = () => ({ heading: "", kind: "signature", guidance: "", fields: ["Junior Resident", "Senior Resident", "Consultant"] });

// Shared paragraphs, worded exactly like the General Medicine format.
const COURSE_TAIL = `During the hospital stay, the patient was closely monitored clinically and through serial laboratory investigations. [Chronological course: response to treatment, significant changes in investigations, complications, specialist consultations, additional interventions with dates.] The patient showed [clinical/biochemical] improvement following the instituted treatment." (Only claim improvement if documented. The chronological course must be DETAILED: cover every dated note in order with vitals, investigation trends, treatment changes by drug name, procedures, consults and complications — the length must match how much is documented: more detail in the notes means a longer course.)`;
const ADVICE_TAIL = `The patient has been advised to follow up in the [department] OPD after [interval] with [relevant investigation reports]. They have also been advised to report to the nearest emergency department in case of [warning symptoms]." Tailor the warning symptoms to this case. Mention every documented follow-up (each OPD, interval, reports to bring, pending results) and every drug kept on hold with the reason. Never add generic advice (diet, fluid or salt restriction, lifestyle, body weight) that the notes do not mention.`;

function dept({ id, name, department, diagnosis, p1, p2, p3, p4, p5, p6, advice, extra = [] }) {
  return {
    id, name, title: "DISCHARGE SUMMARY", department,
    sections: [
      ptSec(),
      { heading: "Final Diagnosis", kind: "diagnosis", guidance: diagnosis },
      { heading: "Clinical Summary", kind: "narrative", guidance:
`One continuous story in date order, in these paragraphs:
1. Background, oldest first: ${p1} Omit sentences with nothing to say.
2. Presenting illness: ${p2}
3. ${p3}
4. ${p4} Skip clauses for tests not done.
5. ${p5} ${COURSE_TAIL}
6. End-of-stay paragraph per OUTCOME. For discharge: ${p6}` },
      ...extra,
      txSec(),
      medSec(),
      { heading: "Discharge Advice and Follow-up", kind: "advice", guidance: `"The patient and attendants have been counselled regarding the disease and medication compliance. ${advice} ${ADVICE_TAIL}` },
      signSec(),
    ],
  };
}

const ONCO = dept({
  id: "bi-onco", name: "Medical Oncology / Hematology", department: "Department of Medical Oncology and Hematology",
  diagnosis: "Primary diagnosis as written in oncology files: site/type, histology, grade, stage (TNM / ISS / R-ISS / Ann Arbor / risk group), key IHC, molecular or cytogenetic markers, disease status (newly diagnosed / on treatment / relapsed / refractory / in remission), current regimen and cycle, and ECOG PS, each only if documented. Then the reason for this admission (e.g. febrile neutropenia, tumour lysis syndrome, chemotherapy toxicity, for cycle ___ of ___), then other complications, then comorbidities.",
  p1: `"A [age]-year-old [male/female], a known case of [cancer with histology and stage], diagnosed in [month/year] when he/she presented with [initial symptoms]. [Biopsy / bone marrow / PET-CT / staging scans with dates and key findings and markers.] He/she was started on [regimen] ([curative/palliative] intent, if written) in [month/year] and has received [number] cycles, the last on [date]. [Response assessment with date and result.] [Surgery, radiotherapy with dose and fractions, transplant, relapse and change of line, in date order.] He/she is also a known case of [other comorbidities with duration]."`,
  p2: `"The patient presented to the [department] with complaints of [chief complaints with duration], [on day ___ after cycle ___, if written]. The patient was apparently well [duration] prior to admission, following which he/she developed [symptoms in the order they began, progression, associated symptoms, treatment taken before admission]. There was no history of [relevant negatives]."`,
  p3: `"On admission, the patient was [general condition and sensorium], with an ECOG performance status of ___. His/her vitals were as follows: blood pressure ___ mmHg, pulse rate ___/min, respiratory rate ___/min, temperature ___ and SpO2 ___% on [room air/oxygen]. General examination revealed [pallor, icterus, lymphadenopathy, mucositis, oedema]. On systemic examination, [liver and spleen size, masses, chest and abdominal findings, port/PICC site, CNS findings]."`,
  p4: `"Initial investigations revealed haemoglobin ___ g/dL, total leucocyte count ___ (absolute neutrophil count ___) and platelet count ___. Renal function tests showed [findings], liver function tests revealed [findings], and serum electrolytes, uric acid, LDH and calcium were [findings]. [Blood/urine cultures with organism and sensitivity.] [Imaging, tumour markers, bone marrow findings.] Based on the clinical presentation and investigation profile, a diagnosis of [final diagnosis] was made."`,
  p5: `"The patient was managed as a case of [febrile neutropenia / tumour lysis syndrome / ___] with [antibiotics with doses and start dates, antifungals, G-CSF, IV fluids, allopurinol/rasburicase, blood products with number of units, supportive care]. [Chemotherapy given this admission: cycle and day, date, height, weight, BSA, each drug with its dose, premedication, and tolerance as documented.] [Day-wise: fever spikes and when the fever settled, ANC and platelet recovery with dates, culture reports and antibiotic escalation or de-escalation, toxicities with grade, procedures such as bone marrow, line insertion or intrathecal chemotherapy.]`,
  p6: `"At the time of discharge, the patient was [afebrile for ___ hours / conscious and oriented / haemodynamically stable], with blood pressure ___ mmHg, pulse rate ___/min and SpO2 ___% on [room air]. His/her counts at discharge were haemoglobin ___ g/dL, total leucocyte count ___ and platelet count ___. The patient was [tolerating oral feeds, as applicable]. In view of the clinical improvement and stable condition, the patient is being discharged with the following medications and advice."`,
  advice: `They have been advised to [complete/continue named drugs with duration: antibiotics, steroid taper, antiemetics, antiviral/antifungal/PCP prophylaxis, as documented], [get CBC and other tests on ___, if documented] and to report for the next cycle (cycle ___ of [regimen]) on [date] with [CBC, RFT, LFT reports].`,
});

const DAYCARE = {
  id: "bi-daycare", name: "Chemotherapy Day Care (short)", title: "DAY CARE SUMMARY",
  department: "Department of Medical Oncology and Hematology",
  sections: [
    ptSec(["Name", "Age/Sex", "UHID", "Day Care No.", "Date of Admission", "Date of Discharge"]),
    { heading: "Final Diagnosis", kind: "diagnosis", guidance: "Cancer with histology, stage and key markers, disease status and current regimen (with intent if written), each only if documented. Then comorbidities." },
    { heading: "Chemotherapy Details", kind: "narrative", guidance:
`Three short paragraphs, no hospital course:
1. "A [age]-year-old [male/female], a known case of [diagnosis with stage], diagnosed in [month/year] and on [regimen] since [month/year], was admitted to the day care for cycle ___ (day ___) of [regimen]. [Previous cycles received and response, if written.]"
2. "Before chemotherapy, the patient was [asymptomatic / complaints], with an ECOG performance status of ___. His/her vitals were stable: blood pressure ___ mmHg, pulse rate ___/min and SpO2 ___% on room air. Weight was ___ kg, height ___ cm and body surface area ___ m². Pre-chemotherapy investigations showed haemoglobin ___ g/dL, total leucocyte count ___ (absolute neutrophil count ___), platelet count ___, [renal and liver function tests]."
3. "After premedication with [antiemetics, steroid, antihistamine as charted], the patient received [each drug with dose in mg (and mg/m²), route, diluent and duration of infusion as charted]. [The patient tolerated the chemotherapy well / infusion reaction or other event and its management] and is being discharged in stable condition." Write "tolerated well" only if documented.` },
    medSec(),
    { heading: "Discharge Advice and Follow-up", kind: "advice", guidance: `"The patient and attendants have been counselled regarding the chemotherapy and its side effects. They have been advised to [take named post-chemotherapy drugs with duration: antiemetics, G-CSF on dates, steroids, mouthwash, as documented] and to get [CBC on day ___, if documented]. The next cycle (cycle ___) is due on [date], for which the patient has been advised to come with [CBC, RFT, LFT reports]. They have also been advised to report to the nearest emergency department in case of fever, persistent vomiting, loose stools, bleeding from any site, breathlessness or any other concerning symptoms." Mention only documented drugs and dates. Never add generic advice that the notes do not mention.` },
    signSec(),
  ],
};

const NEPHRO = dept({
  id: "bi-nephro", name: "Nephrology", department: "Department of Nephrology",
  diagnosis: "Primary renal diagnosis as written: AKI (KDIGO stage) / AKI on CKD / CKD stage ___ / ESRD on maintenance haemodialysis via [access] since ___ / renal transplant recipient ([year], [donor]) with graft dysfunction, with the cause or biopsy diagnosis. Then complications (hyperkalaemia, metabolic acidosis, uraemic encephalopathy, fluid overload, access-related infection), then comorbidities with duration.",
  p1: `"A [age]-year-old [male/female], known case of [diabetes/hypertension/other comorbidities with duration], on [long-term medications]. [Renal history: CKD diagnosed in ___ with baseline serum creatinine ___ mg/dL on [date]; on maintenance haemodialysis ___ times a week via [AV fistula/catheter] since ___; renal transplant in ___.] [Earlier admissions, dialysis catheter insertions, renal biopsy and their results, in date order.] [Investigations done before this admission, with dates and key findings.]"`,
  p2: `"The patient presented to the [department] with complaints of [decreased urine output, swelling of the body, breathlessness, vomiting, altered sensorium, with duration]. The patient was apparently well [duration] prior to admission, following which he/she developed [symptoms in the order they began, progression, associated symptoms]. [History of NSAID, contrast or indigenous medicine intake, only if documented.] There was no history of [relevant negatives]."`,
  p3: `"On admission, the patient was [general condition and sensorium]. His/her vitals were as follows: blood pressure ___ mmHg, pulse rate ___/min, respiratory rate ___/min, temperature ___ and SpO2 ___% on [room air/oxygen]. [Weight ___ kg; urine output ___ mL/day.] General examination revealed [pallor, pedal oedema, facial puffiness, raised JVP]. On systemic examination, [chest findings including basal crepitations, CVS, abdomen, CNS including asterixis and sensorium]."`,
  p4: `"Initial investigations revealed blood urea ___ mg/dL and serum creatinine ___ mg/dL, with serum sodium ___, potassium ___, bicarbonate ___ [ABG findings], calcium ___, phosphorus ___ and uric acid ___. Haemoglobin was ___ g/dL. Urine routine examination showed [protein, RBCs, pus cells, casts], [urine protein-creatinine ratio / 24-hour urine protein ___]. Ultrasound of the kidneys showed [kidney sizes, echotexture, corticomedullary differentiation]. [Serology: ANA, ANCA, anti-GBM, complements, viral markers.] [Renal biopsy on [date]: findings.] Based on the clinical presentation, examination and investigation profile, a diagnosis of [final diagnosis] was made."`,
  p5: `"The patient was managed with [IV fluids or diuretics, anti-hyperkalaemic measures, sodium bicarbonate, antibiotics, antihypertensives, erythropoietin and iron, immunosuppression with doses]. [Dialysis: catheter insertion with site and date; each haemodialysis/SLED session or the number of sessions with dates and ultrafiltration, if written.] [Day-wise: urine output and weight, serial urea, creatinine and potassium with trend, transfusions, biopsy and its result.]`,
  p6: `"At the time of discharge, the patient was [conscious and oriented/haemodynamically stable], with blood pressure ___ mmHg, pulse rate ___/min and SpO2 ___% on [room air]. Urine output was ___ mL/day and serum creatinine was ___ mg/dL on [date]. [The patient is dialysis-independent / continues on maintenance haemodialysis; dry weight ___ kg.] In view of the clinical improvement and stable condition, the patient is being discharged with the following medications and advice."`,
  advice: `They have been advised to [continue named drugs with duration; immunosuppressant doses and drug levels, as documented], [continue maintenance haemodialysis ___ times a week via [access] / next dialysis on [date], if documented], [take care of the dialysis catheter/AV fistula, if documented] and to get [renal function tests and serum electrolytes after ___, if documented].`,
});

const CARDIO = dept({
  id: "bi-cardio", name: "Cardiology", department: "Department of Cardiology",
  diagnosis: "Primary diagnosis as written: type of ACS (STEMI with wall / NSTEMI / unstable angina) with Killip class, thrombolysis or primary PCI, coronary angiography result (SVD/DVD/TVD), status post PTCA with stent(s) to ___ on [date], LV function (LVEF ___%), heart failure, arrhythmia or valve lesion with severity, each only if documented. Then complications, then risk factors (diabetes, hypertension, dyslipidaemia, smoking).",
  extra: [{ heading: "Procedure Details", kind: "narrative", guidance:
`Only what the procedure notes say, in formal sentences:
"Coronary angiography was performed on [date] via the [right radial/femoral] route, which revealed [findings in LMCA, LAD, LCx and RCA with percentage stenosis], suggestive of [single/double/triple] vessel disease."
"PTCA to the [culprit vessel and segment] was performed on [date] with [predilatation], deployment of [stent name, ___ x ___ mm], [post-dilatation], and TIMI ___ flow was achieved."
[Other procedures such as temporary pacing, IABP, pericardiocentesis, permanent pacemaker or ICD implantation, with date and details.]
If no procedure is documented in this admission, write: No procedure was performed during this admission.` }],
  p1: `"A [age]-year-old [male/female], known case of [diabetes/hypertension/dyslipidaemia with duration], [smoker with ___ pack-years, if written], on [long-term medications]. [Earlier cardiac history: myocardial infarction, PCI or CABG with dates, earlier echocardiography findings.] [Investigations done before this admission, with dates and key findings.]"`,
  p2: `"The patient presented to the [department] with complaints of [chest pain with site, character, radiation, duration and time of onset / breathlessness with NYHA class / palpitations / syncope], associated with [sweating, vomiting, giddiness]. The patient was apparently well [duration] prior to admission, following which he/she developed [symptoms in the order they began and progression]. [Treatment received before arrival, such as loading doses or thrombolysis with time.] There was no history of [relevant negatives]."`,
  p3: `"On admission, the patient was [general condition and sensorium]. His/her vitals were as follows: blood pressure ___ mmHg, pulse rate ___/min [regular/irregular], respiratory rate ___/min, temperature ___ and SpO2 ___% on [room air/oxygen]. General examination revealed [JVP, pedal oedema, peripheral pulses]. On systemic examination, [heart sounds, S3, murmurs, basal crepitations, other findings]. The patient was in Killip class ___."`,
  p4: `"The ECG showed [rhythm, rate, ST-T changes with leads]. Cardiac troponin [I/T] was ___ [serial values]. Echocardiography revealed [regional wall motion abnormality, LVEF ___%, mitral regurgitation grade, valves, clot, pericardial effusion]. Renal function tests showed [findings], and [lipid profile, HbA1c, electrolytes, chest X-ray] were [findings]. Based on the clinical presentation, ECG, cardiac biomarkers and echocardiography, a diagnosis of [final diagnosis] was made."`,
  p5: `"The patient was managed with [dual antiplatelets with loading doses, anticoagulant, high-intensity statin, beta-blocker, nitrates, diuretics, ACE inhibitor/ARNI, inotropes, thrombolysis with drug and time, with doses]. [Day-wise: chest pain, blood pressure and heart rate, rhythm events and their management, inotrope weaning, serial ECG, troponin and echocardiography, access site, renal function after contrast, complications.]`,
  p6: `"At the time of discharge, the patient was free of chest pain and haemodynamically stable, with blood pressure ___ mmHg, pulse rate ___/min, respiratory rate ___/min and SpO2 ___% on [room air]. The patient was [ambulating independently, as applicable]. In view of the clinical improvement and stable condition, the patient is being discharged with the following medications and advice."`,
  advice: `They have been advised to [continue named drugs; duration of dual antiplatelet therapy and not to stop antiplatelets without consulting the cardiologist, only if documented], [get a repeat echocardiogram/lipid profile after ___, if documented] and [cardiac rehabilitation or activity instructions, only if documented].`,
});

const PULM = dept({
  id: "bi-pulm", name: "Pulmonary Medicine / RICU", department: "Department of Pulmonary Medicine",
  diagnosis: "Primary diagnosis as written: e.g. acute exacerbation of COPD / pneumonia (CURB-65 ___) / interstitial lung disease / acute severe asthma / pulmonary tuberculosis (site, CBNAAT and rifampicin result) / pleural effusion (type and cause), with type 1 or type 2 respiratory failure and organism isolated, each only if documented. Then complications (pneumothorax, ventilator-associated pneumonia, cor pulmonale), then comorbidities and smoking status.",
  p1: `"A [age]-year-old [male/female], [smoker with ___ pack-years / biomass or occupational exposure, if written], known case of [COPD/asthma/ILD/old tuberculosis/other comorbidities with duration and treatment], on [inhalers, home oxygen, long-term medications]. [Earlier admissions, NIV or intubation, anti-tubercular treatment with dates and outcome.] [Investigations done before this admission such as PFT, HRCT or sputum results, with dates and key findings.]"`,
  p2: `"The patient presented to the [department] with complaints of [breathlessness (mMRC grade ___), cough with or without expectoration, fever, chest pain, haemoptysis, with duration]. The patient was apparently well [duration] prior to admission, following which he/she developed [symptoms in the order they began, progression, associated symptoms, treatment taken before admission]. There was no history of [relevant negatives]."`,
  p3: `"On admission, the patient was [in respiratory distress, using accessory muscles of respiration / drowsy / conscious and oriented]. His/her vitals were as follows: blood pressure ___ mmHg, pulse rate ___/min, respiratory rate ___/min, temperature ___ and SpO2 ___% on [room air/oxygen at ___ L/min]. General examination revealed [cyanosis, clubbing, pedal oedema, raised JVP]. On respiratory system examination, [air entry, breath sounds, wheeze, crepitations with side and zone]; [other systems]."`,
  p4: `"Arterial blood gas analysis at admission showed pH ___, pCO2 ___ mmHg, pO2 ___ mmHg and bicarbonate ___ [on FiO2 ___]. Initial investigations revealed [haemogram, renal and liver function, electrolytes, procalcitonin]. Chest X-ray showed [findings], and [HRCT/CECT chest] revealed [findings]. Sputum examination showed [Gram stain, AFB, CBNAAT/TrueNat with rifampicin result, culture]. [Pleural fluid analysis with ADA, bronchoscopy/BAL findings, echocardiography with RVSP.] Based on the clinical presentation and investigation profile, a diagnosis of [final diagnosis] was made."`,
  p5: `"The patient was managed with [oxygen therapy / non-invasive ventilation (BiPAP with IPAP ___ and EPAP ___) / high-flow nasal oxygen / intubation and mechanical ventilation from [date]], [bronchodilator nebulisation, systemic steroids, antibiotics with doses, anti-tubercular treatment]. [Day-wise: work of breathing, oxygen requirement, serial ABG trend, NIV hours and weaning, ventilator days and extubation date, chest X-ray changes, culture reports and antibiotic changes, procedures such as intercostal drain insertion or removal, thoracocentesis with volume and colour, bronchoscopy.]`,
  p6: `"At the time of discharge, the patient was [conscious and oriented/haemodynamically stable], maintaining SpO2 ___% on [room air/oxygen at ___ L/min], with blood pressure ___ mmHg, pulse rate ___/min and respiratory rate ___/min. The patient was [afebrile, ambulating independently, as applicable]. In view of the clinical improvement and stable condition, the patient is being discharged with the following medications and advice."`,
  advice: `They have been advised to [continue named inhalers with device and correct technique, steroid taper, anti-tubercular treatment with phase and duration, as documented], [use home oxygen at ___ L/min for ___ hours a day / home NIV settings, if documented] and to get [PFT/chest X-ray after ___, if documented].`,
});

const NEURO = dept({
  id: "bi-neuro", name: "Neurology", department: "Department of Neurology",
  diagnosis: "Primary diagnosis as written, with localisation and cause (e.g. acute ischaemic stroke in the ___ territory, with stroke subtype), whether thrombolysed (drug and time) or the documented reason for not thrombolysing, NIHSS at admission and discharge, each only if documented. Then complications, then risk factors and comorbidities.",
  p1: `"A [age]-year-old [right/left-handed, if written] [male/female], known case of [hypertension/diabetes/AF/other comorbidities with duration], on [long-term medications]. [Earlier neurological events such as stroke, seizures or TIA with dates and residual deficits.] [Investigations done before this admission, with dates and key findings.]"`,
  p2: `"The patient presented to the [department] with complaints of [sudden-onset / gradually progressive weakness of ___ / slurring of speech / seizures with type, number and duration / headache / altered sensorium, with duration]. [Time last known normal and onset-to-door time, if written.] The patient was apparently well [duration] prior to admission, following which he/she developed [symptoms in the order they began, progression, preceding fever, diarrhoea or vaccination, post-ictal state]. There was no history of [trauma, similar episodes, other relevant negatives]."`,
  p3: `"On admission, the patient's GCS was ___ (E_V_M_). His/her vitals were as follows: blood pressure ___ mmHg, pulse rate ___/min, respiratory rate ___/min, temperature ___, SpO2 ___% on [room air/oxygen] and random blood sugar ___ mg/dL. On neurological examination, higher mental functions were [findings] and speech was [findings]. Cranial nerve examination revealed [findings]. Motor examination showed [tone], power of [right upper limb ___/5, right lower limb ___/5, left upper limb ___/5, left lower limb ___/5], [deep tendon reflexes] and [plantar responses]. Sensory system [findings], cerebellar signs [findings] and meningeal signs [findings]. [NIHSS ___.]"`,
  p4: `"[NCCT/MRI brain] done on [date] showed [findings]. [MR/CT angiography, carotid Doppler, echocardiography, Holter monitoring.] [CSF analysis: cells, protein, sugar, ADA, Gram/AFB stain, CBNAAT, culture.] [EEG.] [Nerve conduction studies/EMG.] Blood investigations revealed [haemogram, renal and liver function, electrolytes, lipid profile, HbA1c, vitamin B12, TSH, vasculitic and viral markers]. Based on the clinical presentation, examination and investigation profile, a diagnosis of [final diagnosis] was made."`,
  p5: `"The patient was managed with [thrombolysis with drug, dose and time / antiplatelets / anticoagulation / antiepileptics with doses / IVIG or plasmapheresis with dates and cycles / steroids / antibiotics or antivirals / anti-oedema measures]. [Day-wise: GCS and power grading changes, further seizures, swallowing assessment and mode of feeding, airway support (NIV/intubation; single breath count and NIF in GBS), repeat imaging, physiotherapy, complications such as aspiration, bedsores or DVT.]`,
  p6: `"At the time of discharge, the patient was conscious [and oriented], with a GCS of ___, blood pressure ___ mmHg, pulse rate ___/min and SpO2 ___% on [room air]. Power was [grading by limb], [mRS ___]. The patient was [tolerating oral feeds / on Ryle's tube feeds] and [ambulating with/without support, as applicable]. In view of the clinical improvement and stable condition, the patient is being discharged with the following medications and advice."`,
  advice: `They have been advised to [continue named drugs; not to stop antiepileptics on their own, only if documented; antiplatelet/anticoagulant duration], [Ryle's tube feeding, position change, physiotherapy, catheter care, only if documented] and [driving, swimming or working-at-height restrictions, only if documented].`,
});

const GASTRO = dept({
  id: "bi-gastro", name: "Gastroenterology / Hepatology", department: "Department of Gastroenterology",
  diagnosis: "Primary diagnosis as written: e.g. decompensated chronic liver disease (cause, CTP class and score, MELD) with ascites / variceal bleed / hepatic encephalopathy grade ___ / SBP / HRS-AKI / jaundice, with endoscopy findings (varices grade, EVL with ___ bands on [date]); or acute pancreatitis (cause, severity), GI bleed with source, IBD with extent and severity, obstructive jaundice with cause, each only if documented. Then complications, then comorbidities.",
  p1: `"A [age]-year-old [male/female], [alcohol intake of ___ for ___ years, last drink ___, if written], known case of [chronic liver disease since ___ / other comorbidities with duration], on [long-term medications]. [Earlier decompensations, endoscopic variceal ligation, paracentesis, hepatitis B/C treatment, with dates.] [Investigations done before this admission, with dates and key findings.]"`,
  p2: `"The patient presented to the [department] with complaints of [haematemesis or melena with number of episodes / abdominal distension / yellowish discolouration of eyes and urine / altered sensorium / pain abdomen, with duration]. The patient was apparently well [duration] prior to admission, following which he/she developed [symptoms in the order they began, progression, associated symptoms, treatment taken before admission]. There was no history of [relevant negatives]."`,
  p3: `"On admission, the patient was [conscious and oriented / drowsy, with hepatic encephalopathy grade ___]. His/her vitals were as follows: blood pressure ___ mmHg, pulse rate ___/min, respiratory rate ___/min, temperature ___ and SpO2 ___% on [room air]. General examination revealed [pallor, icterus, pedal oedema, flapping tremors, stigmata of chronic liver disease]. On abdominal examination, [distension, shifting dullness, organomegaly, tenderness]. [Weight ___ kg; abdominal girth ___ cm.]"`,
  p4: `"Initial investigations revealed haemoglobin ___ g/dL, total leucocyte count ___ and platelet count ___. Liver function tests showed total bilirubin ___ mg/dL (direct ___), SGOT/SGPT ___/___ U/L, ALP ___ U/L and serum albumin ___ g/dL, with PT/INR ___. Renal function tests and serum electrolytes were [findings]. [Serum amylase/lipase.] Ultrasound of the abdomen showed [liver size and echotexture, portal vein diameter, spleen, ascites]. [Ascitic fluid analysis: cell count with neutrophils, SAAG, protein, culture.] [Viral markers, AFP.] [Upper GI endoscopy on [date]: findings.] [CECT/MRCP.] Based on the clinical presentation and investigation profile, a diagnosis of [final diagnosis] was made."`,
  p5: `"The patient was managed with [terlipressin/octreotide, proton pump inhibitor, ceftriaxone, blood transfusions with number of units, lactulose, rifaximin, albumin, diuretics, antibiotics, with doses]. [Day-wise: control of bleeding, haemoglobin trend, endoscopic variceal ligation with date and number of bands, therapeutic paracentesis with dates and volumes and albumin given, encephalopathy grade and stool frequency, serial bilirubin, INR, creatinine and sodium.]`,
  p6: `"At the time of discharge, the patient was conscious and oriented [with no flapping tremors], haemodynamically stable, with blood pressure ___ mmHg, pulse rate ___/min and SpO2 ___% on [room air]. [There was no further bleeding since ___; the patient was passing ___ stools a day; abdominal girth/weight ___.] The patient was [tolerating oral feeds, as applicable]. In view of the clinical improvement and stable condition, the patient is being discharged with the following medications and advice."`,
  advice: `They have been advised to [continue named drugs: diuretics, beta-blocker with target heart rate, lactulose to pass ___ stools a day, as documented], [abstain completely from alcohol, only if documented] and to get [repeat EVL on ___ / LFT, RFT and serum sodium after ___, if documented].`,
});

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
