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

/* ---------- Surgical department templates ----------
   Same formal resident style as the medical formats, laid out the way surgical units write them:
   procedure line, clinical summary, operative details, post-operative course, then advice. */
const SURG_FIELDS = ["Name", "Age/Sex", "UHID", "IPD No.", "Date of Admission", "Date of Surgery", "Date of Discharge"];
const POSTOP_RULES = `Go day by day using post-operative days (POD 1, POD 2…) or dates, as the notes do. For each day write what is documented: vitals and fever, pain, drain output with colour and the day each drain was removed, nasogastric output and when it was removed, bowel sounds, flatus and stools, when oral sips and then a soft or normal diet were started, urinary catheter removal and voiding, mobilisation, wound inspection and dressings (healthy / soakage / discharge / gaping), suture or staple removal, antibiotics with the day they were stopped or changed, transfusions, post-operative haemoglobin and other investigations, and any complication with how it was managed. Write "The post-operative period was uneventful" only if the notes say so or record no complication; otherwise describe what happened. The length must match how much is documented.`;
const SURG_ADVICE_TAIL = `The patient has been advised to follow up in the [department] OPD on [date / after ___ days] [for suture removal and wound check / with the histopathology report]. They have also been advised to report to the nearest emergency department in case of [warning symptoms]." Tailor the warning symptoms to this operation. Mention every documented instruction: wound and dressing care, date of suture or staple removal, drain or catheter care and the date of its removal, stent removal date, activity and weight-bearing limits, diet, histopathology report awaited, drugs on hold. Never add instructions that the notes do not mention.`;

function surg({ id, name, department, diagnosis, procedure, p1, p2, p3, p4, p5, op, post, p6, advice, fields = SURG_FIELDS, title = "DISCHARGE SUMMARY", opHeading = "Operative Details", postHeading = "Post-operative Course" }) {
  return {
    id, name, title, department, group: "surgical",
    sections: [
      ptSec(fields),
      { heading: "Final Diagnosis", kind: "diagnosis", guidance: diagnosis },
      { heading: "Procedure Done", kind: "narrative", guidance: procedure ||
`One line per operation or procedure in this admission, in date order, in the form: "[Name of the operation, with side] under [general / spinal / regional / local] anaesthesia on [date]." Nothing else. If no operation is documented, write: Managed conservatively.` },
      { heading: "Clinical Summary", kind: "narrative", guidance:
`One continuous story in date order, in these paragraphs:
1. Background, oldest first: ${p1} Omit sentences with nothing to say.
2. Presenting illness: ${p2}
3. ${p3}
4. ${p4} Skip clauses for tests not done.
5. ${p5}` },
      { heading: opHeading, kind: "narrative", guidance: op },
      { heading: postHeading, kind: "narrative", guidance:
`${post} ${POSTOP_RULES}
End with the end-of-stay paragraph per OUTCOME. For discharge: ${p6}` },
      txSec(),
      medSec(),
      { heading: "Discharge Advice and Follow-up", kind: "advice", guidance: `"The patient and attendants have been counselled regarding the surgery, wound care and medication compliance. ${advice} ${SURG_ADVICE_TAIL}` },
      signSec(),
    ],
  };
}

const PRE_OP = `"After pre-anaesthetic evaluation and fitness [and cross-matching of ___ units of blood, if written], the patient was taken up for [operation] under [anaesthesia] on [date], after informed written consent."`;
const DISCH_SURG = `"At the time of discharge, the patient was [conscious and oriented / haemodynamically stable / afebrile], with blood pressure ___ mmHg, pulse rate ___/min and SpO2 ___% on room air. The wound was [healthy / healing well / sutures removed], the patient was [tolerating a normal diet, passing urine and stools, ambulating, as documented]. In view of the satisfactory recovery, the patient is being discharged with the following medications and advice."`;

const GSURG = surg({
  id: "bi-gsurg", name: "General Surgery", department: "Department of General Surgery",
  diagnosis: "Primary surgical diagnosis as written, with side and site (e.g. acute calculous cholecystitis / right inguinal hernia, indirect, reducible / acute appendicitis with localised peritonitis / perforation peritonitis secondary to duodenal ulcer perforation / carcinoma ___), followed by \"s/p [operation] on [date]\". Then intra-operative or post-operative complications, then comorbidities with duration.",
  p1: `"A [age]-year-old [male/female], known case of [comorbidities with duration], on [long-term medications]. [Previous surgeries with year and hospital, earlier similar episodes and their treatment.] [Investigations done before this admission, with dates and key findings.]"`,
  p2: `"The patient presented to the [department / emergency] with complaints of [pain abdomen with site, onset, character and radiation / swelling at ___ / vomiting / fever / distension / constipation or obstipation / bleeding per rectum, with duration]. The patient was apparently well [duration] prior to admission, following which he/she developed [symptoms in the order they began, progression, aggravating and relieving factors, treatment taken before admission]. There was no history of [relevant negatives]."`,
  p3: `"On admission, the patient was [general condition]. His/her vitals were as follows: blood pressure ___ mmHg, pulse rate ___/min, respiratory rate ___/min, temperature ___ and SpO2 ___% on room air. General examination revealed [pallor, icterus, dehydration, lymphadenopathy]. On local examination, [inspection, palpation, percussion and auscultation findings of the abdomen or the swelling: site, size, tenderness, guarding, rigidity, cough impulse, reducibility, bowel sounds; per rectal examination, if done]. [Other systems.]"`,
  p4: `"Initial investigations revealed haemoglobin ___ g/dL, total leucocyte count ___ and platelet count ___, with [renal and liver function, electrolytes, coagulation profile, viral markers, blood group]. Ultrasound of the abdomen showed [findings]. [X-ray erect abdomen / chest, CECT abdomen, endoscopy, FNAC or biopsy, with findings.] Based on the clinical presentation and investigations, a diagnosis of [diagnosis] was made."`,
  p5: `"The patient was initially managed with [nil by mouth, IV fluids, nasogastric decompression, IV antibiotics, analgesics, proton pump inhibitor, as documented]." Then ${PRE_OP}`,
  op: `In formal sentences, only what the operation note says: "Under [anaesthesia], with the patient in the [supine] position, [approach / incision / port placement]. Intra-operatively, [findings: organ, size, adhesions, pus or fluid with volume, perforation site and size, hernia sac contents, mass with extent]. [Procedure done: steps, repair or anastomosis technique, mesh with size, lavage.] [Drain: type and site.] [The specimen was sent for histopathological examination.] [Estimated blood loss and transfusion, if written.] [The patient was shifted to the [ward / ICU] in stable condition.]" If no operation is documented, write: No operative procedure was performed during this admission.`,
  post: `"Post-operatively, the patient was managed with [IV antibiotics, analgesics, IV fluids, proton pump inhibitor, as documented]."`,
  p6: DISCH_SURG,
  advice: `They have been advised to [continue named drugs with duration], [keep the wound clean and dry / change the dressing on ___, as documented], [avoid lifting heavy weights for ___ weeks, only if documented] and [diet instructions, only if documented].`,
});

const ORTHO = surg({
  id: "bi-ortho", name: "Orthopaedics", department: "Department of Orthopaedics",
  diagnosis: "Primary diagnosis with side, bone and site, and classification as written (e.g. closed fracture shaft of right femur, AO 32-A3 / open fracture both bones left leg, Gustilo-Anderson type II / intertrochanteric fracture right femur, Boyd and Griffin type ___ / dislocation, ligament or tendon injury), with associated injuries, followed by \"s/p [operation with implant] on [date]\". Then complications, then comorbidities.",
  p1: `"A [age]-year-old [male/female], [right/left-hand dominant, if written], known case of [comorbidities with duration], on [long-term medications]. [Previous fractures, surgeries or implants with year.] [Pre-injury mobility status, if written.]"`,
  p2: `"The patient presented to the [emergency / department] with complaints of [pain, swelling and inability to bear weight / deformity of ___ / wound over ___, with duration] following [road traffic accident / fall from ___ / slip and fall at home / sports injury] on [date and time]. [Mechanism of injury, first aid, splintage or treatment received elsewhere.] There was no history of [loss of consciousness, vomiting, ENT bleed, other injuries]."`,
  p3: `"On admission, the patient was [conscious and oriented, haemodynamically stable]. His/her vitals were as follows: blood pressure ___ mmHg, pulse rate ___/min, respiratory rate ___/min and SpO2 ___% on room air. On local examination of the [limb], there was [swelling, deformity, tenderness, abnormal mobility, crepitus, wound with size and contamination, skin condition]. Distal neurovascular status was [intact / pulses, sensation and movements as documented]. [Other injuries and systemic findings.]"`,
  p4: `"X-ray of the [part, views] showed [fracture pattern, displacement, comminution, dislocation]. [CT scan with findings.] Pre-operative investigations revealed haemoglobin ___ g/dL, [renal function, blood sugar, coagulation profile, viral markers, ECG, chest X-ray]. Based on the clinical and radiological findings, a diagnosis of [diagnosis] was made."`,
  p5: `"The limb was immobilised in [above-knee slab / skin or skeletal traction with ___ kg / sling], with limb elevation, analgesics [and IV antibiotics, tetanus toxoid, wound wash and debridement for open injuries, as documented]." Then ${PRE_OP}`,
  op: `In formal sentences, only what the operation note says: "Under [anaesthesia], with the patient in the [supine / lateral] position [on a fracture table, with tourniquet], [approach and incision]. [Fracture reduction: open / closed, under C-arm guidance.] [Fixation: implant with type, size and number of screws, e.g. intramedullary interlocking nail ___ mm x ___ mm with ___ proximal and ___ distal locking screws / ___-hole locking compression plate / dynamic hip screw / K-wires / external fixator.] [Bone graft, repair, debridement.] [Position and fixation confirmed under C-arm.] [Drain, wound closure.] [Tourniquet time and blood loss, if written.] [The limb was supported in ___.]" If no operation is documented, write: Managed conservatively with [method].`,
  post: `"Post-operatively, the patient was managed with [IV antibiotics, analgesics, DVT prophylaxis, limb elevation, as documented]. A check X-ray on [date] showed [position of the fracture and implant]. Physiotherapy in the form of [static quadriceps / ankle pumps / range of motion exercises] was started on [POD / date], and the patient was mobilised [non-weight-bearing / partial weight-bearing / full weight-bearing] with [walker / crutches] on [date]."`,
  p6: `"At the time of discharge, the patient was haemodynamically stable and afebrile. The wound was [healthy / healing well], distal neurovascular status was intact, and the patient was [mobilising with walker, non-weight-bearing / as documented]. In view of the satisfactory recovery, the patient is being discharged with the following medications and advice."`,
  advice: `They have been advised to [continue named drugs with duration, including DVT prophylaxis and calcium/vitamin D, as documented], to keep the limb elevated, to remain [non / partial / full weight-bearing] on the operated limb until review, to continue [named physiotherapy exercises], and [care of the slab / external fixator pin sites, as documented].`,
});

const OBS = surg({
  id: "bi-obs", name: "Obstetrics (delivery)", department: "Department of Obstetrics and Gynaecology",
  fields: ["Name", "Age", "UHID", "IPD No.", "Date of Admission", "Date of Delivery", "Date of Discharge"],
  opHeading: "Delivery Details", postHeading: "Postnatal Course",
  diagnosis: "As obstetric units write it: \"G_P_L_A_ at ___ weeks ___ days of gestation (by LMP / early USG) with [indications and risk factors: previous LSCS, PIH / pre-eclampsia, GDM, anaemia, oligohydramnios, breech, PROM, post-dated, twins]\", followed by \"delivered by [normal vaginal delivery with / without episiotomy / assisted vaginal delivery / emergency or elective LSCS] on [date] — [live / still] born [male / female] baby, birth weight ___ kg\". Then complications (PPH, perineal tear with degree, wound infection), then medical disorders.",
  procedure: `One line per procedure, in date order: "[Normal vaginal delivery with right mediolateral episiotomy / Emergency LSCS / Elective LSCS with bilateral tubal ligation] under [spinal / general / local anaesthesia, or none] on [date]." Add other procedures (manual removal of placenta, repair of tear, B-Lynch suture, D&C) on their own lines.`,
  p1: `"A [age]-year-old G_P_L_A_ [booked / unbooked] case, with LMP on [date] and EDD on [date], married for ___ years. [Previous pregnancies: year, mode of delivery and indication for previous LSCS, sex, weight and outcome of each baby, abortions.] [Antenatal course: number of visits, TT/Td, iron and calcium, dating and anomaly scans, medical disorders and their treatment, if written.] [Menstrual, medical and surgical history, if relevant.]"`,
  p2: `"The patient presented to the labour room with complaints of [pain abdomen / leaking per vaginum since ___ / bleeding per vaginum / decreased fetal movements / headache, blurring of vision, with duration] at ___ weeks of gestation. [Sequence of symptoms and referral details.] There was no history of [relevant negatives]."`,
  p3: `"On admission, the patient was [conscious and oriented, general condition]. Her vitals were as follows: blood pressure ___ mmHg, pulse rate ___/min, temperature ___ and SpO2 ___% on room air. General examination revealed [pallor, pedal oedema]. On per abdominal examination, the uterus was [term size / ___ weeks], [relaxed / contractions ___ in 10 minutes], with a [cephalic / breech] presentation and fetal heart rate ___ bpm. On per vaginal examination, the cervix was [dilatation ___ cm, effacement ___%], membranes were [intact / ruptured, liquor colour], station ___ and the pelvis was [adequate]."`,
  p4: `"Investigations revealed haemoglobin ___ g/dL, blood group ___ [Rh], [platelet count, urine albumin, blood sugar / OGTT, renal and liver function in PIH, coagulation profile], and HIV, HBsAg and VDRL were [non-reactive / results]. Ultrasound on [date] showed [single live intrauterine fetus, gestational age ___ weeks, presentation, placenta position, AFI ___ cm, estimated fetal weight ___ g, Doppler findings]. [NST / CTG findings.]"`,
  p5: `"The patient was managed with [observation of labour on partograph / induction of labour with ___ on ___ / magnesium sulphate per Pritchard regimen / antihypertensives / antenatal corticosteroids / antibiotics for PROM, as documented]. [Progress of labour and the indication for LSCS, if any: non-progress of labour, fetal distress with CTG findings, failed induction.]"`,
  op: `In formal sentences, only what the delivery or operation note says. For vaginal delivery: "The patient delivered vaginally on [date] at [time] [with / without right mediolateral episiotomy / outlet forceps / vacuum], a [live / still] born [male / female] baby weighing ___ kg, with APGAR scores of ___ and ___ at 1 and 5 minutes, [cried immediately after birth]. The placenta and membranes were delivered [completely] by active management of the third stage of labour. [Episiotomy / tear of ___ degree repaired.] [Estimated blood loss.]" For LSCS: "Under [spinal] anaesthesia, a [Pfannenstiel] incision was made and the lower uterine segment opened [transversely]. A [live / still] born [male / female] baby weighing ___ kg was delivered [by vertex / breech] at [time], with APGAR scores of ___ and ___, and [cried immediately after birth]. [Liquor: colour and amount; cord around the neck; placenta position and complete delivery.] The uterus was closed in [two layers]. [Bilateral tubal ligation by Pomeroy's method.] [Estimated blood loss and other findings.]" [Baby shifted to mother's side / NICU for ___, if written.]`,
  post: `"In the postnatal period, the patient was managed with [IV / oral antibiotics, analgesics, uterotonics, iron and calcium, antihypertensives, blood transfusion, as documented]. [Day-wise: vitals, uterine involution, lochia, breastfeeding, catheter removal and voiding, wound or episiotomy status, post-delivery haemoglobin, blood pressure control, anti-D if Rh-negative, and the baby's condition and NICU course.]"`,
  p6: `"At the time of discharge, the mother was afebrile and haemodynamically stable, with blood pressure ___ mmHg and pulse rate ___/min. The uterus was [well contracted], lochia was [normal], the [suture line / episiotomy wound] was [healthy], and she was breastfeeding the baby [well]. The baby was [active and feeding well, as documented]. In view of the satisfactory recovery, the mother and baby are being discharged with the following medications and advice."`,
  advice: `They have been advised [exclusive breastfeeding for six months], to continue iron and calcium supplements [for ___ months, as documented], [perineal hygiene / care of the LSCS wound], [the baby's immunisation as per schedule], [contraception as counselled, only if documented] and [blood pressure / blood sugar monitoring, if documented]. Warning signs for the mother: fever, foul-smelling or excessive bleeding per vaginum, discharge or pain from the wound, breast pain or swelling, headache with blurring of vision or swelling of the body, as fits this case.`,
});

const GYNAE = surg({
  id: "bi-gynae", name: "Gynaecology (surgery)", department: "Department of Obstetrics and Gynaecology",
  fields: ["Name", "Age", "UHID", "IPD No.", "Date of Admission", "Date of Surgery", "Date of Discharge"],
  diagnosis: "Primary gynaecological diagnosis as written (e.g. AUB-L, fibroid uterus / adenomyosis / ovarian cyst with size and side / uterovaginal prolapse with degree / CIN or carcinoma with stage / ectopic pregnancy with site, ruptured or unruptured), with the parity as P_L_A_, followed by \"s/p [operation] on [date]\". Then complications, then comorbidities.",
  p1: `"A [age]-year-old P_L_A_ [all vaginal deliveries / previous LSCS], [postmenopausal for ___ years / with LMP on ___], known case of [comorbidities with duration]. [Menstrual history: cycles, flow, duration, dysmenorrhoea.] [Previous surgeries, contraception, earlier treatment for the present complaint, with dates.]"`,
  p2: `"The patient presented to the [department] with complaints of [heavy menstrual bleeding / irregular cycles / pain abdomen / mass per abdomen / something coming out per vaginum / white discharge / postmenopausal bleeding, with duration]. [Sequence and progression of symptoms, urinary or bowel symptoms, treatment taken.] There was no history of [relevant negatives]."`,
  p3: `"On admission, the patient was [general condition], with blood pressure ___ mmHg, pulse rate ___/min and SpO2 ___% on room air. General examination revealed [pallor and other findings]. On per abdominal examination, [mass with size in weeks, mobility, tenderness]. On per speculum examination, [cervix, discharge, prolapse]. On per vaginal examination, the uterus was [size, position, mobility], with [adnexal findings, fornices]."`,
  p4: `"Investigations revealed haemoglobin ___ g/dL, [blood group, urine pregnancy test, renal and liver function, blood sugar, thyroid profile, coagulation profile, viral markers, CA-125]. Ultrasound of the pelvis showed [uterus size, endometrial thickness, fibroid number, size and site, ovarian findings]. [Pap smear, endometrial biopsy or colposcopy with results.] Based on these findings, a diagnosis of [diagnosis] was made."`,
  p5: `"[Pre-operative optimisation: blood transfusion, iron, as documented.]" Then ${PRE_OP}`,
  op: `In formal sentences, only what the operation note says: "Under [anaesthesia], [abdominal approach with Pfannenstiel / midline incision / vaginal approach / laparoscopy with port placement]. Intra-operatively, [uterus size and findings, fibroids, adhesions, ovaries and tubes, haemoperitoneum with volume, mass characteristics]. [Procedure done: total abdominal hysterectomy with bilateral salpingo-oophorectomy / vaginal hysterectomy with pelvic floor repair / myomectomy / cystectomy / salpingectomy.] [Haemostasis, drain.] The specimen was sent for histopathological examination. [Estimated blood loss, transfusion.]" If no operation is documented, write: No operative procedure was performed during this admission.`,
  post: `"Post-operatively, the patient was managed with [IV antibiotics, analgesics, IV fluids, as documented]."`,
  p6: DISCH_SURG,
  advice: `They have been advised to [continue named drugs with duration], [care of the abdominal wound / perineal hygiene, as documented], [avoid lifting heavy weights and intercourse for ___ weeks, only if documented] and to collect the histopathology report.`,
});

const URO = surg({
  id: "bi-uro", name: "Urology", department: "Department of Urology",
  diagnosis: "Primary diagnosis as written with side, size and site (e.g. right renal pelvic calculus ___ mm / left upper ureteric calculus with moderate hydroureteronephrosis / BPH with prostate volume ___ cc, in retention / stricture urethra / renal mass), followed by \"s/p [operation] on [date]\", noting a DJ stent in situ. Then complications (UTI, haematuria, AKI), then comorbidities.",
  p1: `"A [age]-year-old [male/female], known case of [comorbidities with duration], on [long-term medications]. [Previous stone episodes, urological procedures, catheterisation or stents, with dates.] [Investigations done before this admission, with dates and key findings.]"`,
  p2: `"The patient presented to the [department] with complaints of [flank pain radiating to ___ / burning micturition / haematuria / frequency, urgency, nocturia, poor stream, straining / acute retention of urine / fever with chills, with duration]. [Sequence of symptoms and treatment taken, including per-urethral catheterisation.] There was no history of [relevant negatives]."`,
  p3: `"On admission, the patient was [general condition]. His/her vitals were as follows: blood pressure ___ mmHg, pulse rate ___/min, temperature ___ and SpO2 ___% on room air. On abdominal examination, [renal angle tenderness, palpable kidney or bladder]. [External genitalia and per rectal examination: prostate size, consistency, median sulcus.]"`,
  p4: `"Investigations revealed haemoglobin ___ g/dL, total leucocyte count ___, blood urea ___ mg/dL and serum creatinine ___ mg/dL, [serum electrolytes, PSA, blood sugar, coagulation profile, viral markers]. Urine routine examination showed [pus cells, RBCs], and urine culture grew [organism with sensitivity / no growth]. [Ultrasound KUB / NCCT KUB / IVU / uroflowmetry with PVR / RGU-MCU, with findings.] Based on these findings, a diagnosis of [diagnosis] was made."`,
  p5: `"The patient was initially managed with [antibiotics as per culture, analgesics, alpha-blocker, per-urethral catheterisation / PCN, as documented]." Then ${PRE_OP}`,
  op: `In formal sentences, only what the operation note says: "Under [anaesthesia], in the [lithotomy / prone] position, [cystoscopy findings]. [Procedure: PCNL through a [lower / middle] calyceal puncture / URSL with laser lithotripsy / TURP with resected weight ___ g / optical internal urethrotomy / open or laparoscopic procedure, with findings and complete or partial stone clearance.] [A ___ Fr DJ stent was placed on the ___ side.] [Nephrostomy tube / per-urethral catheter ___ Fr with continuous bladder irrigation.] [Specimen sent for histopathological examination / stone sent for analysis.]" If no operation is documented, write: No operative procedure was performed during this admission.`,
  post: `"Post-operatively, the patient was managed with [IV antibiotics, analgesics, continuous bladder irrigation, as documented]. [Urine colour and haematuria, removal of nephrostomy tube and catheter with dates, voiding after catheter removal, post-operative X-ray KUB showing stent position and residual fragments, serum creatinine.]"`,
  p6: `"At the time of discharge, the patient was afebrile and haemodynamically stable, passing urine [freely / clear / with the catheter in situ], with blood pressure ___ mmHg and pulse rate ___/min. In view of the satisfactory recovery, the patient is being discharged with the following medications and advice."`,
  advice: `They have been advised to [continue named drugs with duration], [drink plenty of oral fluids, only if documented], [care of the per-urethral catheter / nephrostomy, if in place] and to report for DJ stent removal on [date / after ___ weeks], [as written].`,
});

const NSURG = surg({
  id: "bi-nsurg", name: "Neurosurgery", department: "Department of Neurosurgery",
  diagnosis: "Primary diagnosis as written with side and site (e.g. traumatic brain injury with right frontotemporal acute SDH with midline shift ___ mm / contusions / spontaneous ICH / brain tumour with location / hydrocephalus / lumbar canal stenosis or disc prolapse at level ___), with GCS at admission, followed by \"s/p [operation] on [date]\". Then complications, then comorbidities.",
  p1: `"A [age]-year-old [right/left-handed, if written] [male/female], known case of [comorbidities with duration], on [antiplatelets, anticoagulants and other long-term medications]. [Previous head injury, neurosurgical procedures or shunts with dates.]"`,
  p2: `"The patient presented to the [emergency / department] with complaints of [head injury following ___ on [date and time] with loss of consciousness for ___ / headache, vomiting, seizures / weakness of ___ limbs / low back pain radiating to ___ / altered sensorium, with duration]. [Sequence and progression, ENT bleed, treatment received elsewhere.] There was no history of [relevant negatives]."`,
  p3: `"On admission, the patient had a GCS of E_V_M_ (___/15), pupils were [size and reaction, right and left], and vitals were as follows: blood pressure ___ mmHg, pulse rate ___/min, respiratory rate ___/min and SpO2 ___% on [room air / oxygen]. Neurological examination revealed [motor power by limb, tone, reflexes, plantars, sensory level, cranial nerves, bladder and bowel]. [Scalp wounds, other injuries.]"`,
  p4: `"NCCT head on [date] showed [haematoma type, side, thickness or volume, midline shift ___ mm, contusions, fractures, effacement of cisterns]. [MRI brain / spine, CT angiography, with findings.] Investigations revealed haemoglobin ___ g/dL, [coagulation profile, renal function, electrolytes, blood sugar, viral markers]. Based on these findings, a diagnosis of [diagnosis] was made."`,
  p5: `"The patient was initially managed with [airway protection / intubation, head-end elevation, mannitol / hypertonic saline, anti-epileptics, analgesics, antibiotics, as documented]." Then ${PRE_OP}`,
  op: `In formal sentences, only what the operation note says: "Under general anaesthesia, with the patient in the [supine / prone] position, a [right frontotemporoparietal question-mark / ___] incision was made and [craniotomy / decompressive craniectomy / burr holes / laminectomy at ___]. Intra-operatively, [findings: haematoma type and volume, brain condition, tumour characteristics, disc or canal findings]. [Procedure: evacuation, excision, duraplasty, bone flap placed in the abdominal wall or replaced, EVD or VP shunt with side and type, fixation with screws and rods.] [Drain.] [Specimen sent for histopathological examination.] [The patient was shifted to the ICU on [ventilator / extubated].]" If no operation is documented, write: Managed conservatively.`,
  post: `"Post-operatively, the patient was managed in the [neurosurgical ICU] with [ventilation, anti-epileptics, antibiotics, anti-oedema measures, as documented]. [Day-wise: GCS and pupils, extubation date, post-operative NCCT findings, motor power, seizures, drain or EVD output and removal, tracheostomy, Ryle's tube feeding, wound status, physiotherapy.]"`,
  p6: `"At the time of discharge, the patient was [conscious, with GCS E_V_M_], haemodynamically stable, with blood pressure ___ mmHg and pulse rate ___/min, [motor power as documented]. The wound was [healthy / sutures removed]. In view of the satisfactory recovery, the patient is being discharged with the following medications and advice."`,
  advice: `They have been advised to [continue anti-epileptics and other named drugs with duration, as documented], [care of the bone-flap site, tracheostomy or Ryle's tube, if documented], [physiotherapy, if documented] and [avoid driving or heavy lifting, only if documented].`,
});

const ENT = surg({
  id: "bi-ent", name: "ENT", department: "Department of Otorhinolaryngology",
  diagnosis: "Primary diagnosis as written with side (e.g. chronic otitis media, mucosal type, inactive, left ear / chronic tonsillitis / deviated nasal septum with chronic rhinosinusitis / sinonasal polyposis / laryngeal or oral lesion), followed by \"s/p [operation] on [date]\". Then complications, then comorbidities.",
  p1: `"A [age]-year-old [male/female], known case of [comorbidities with duration], on [long-term medications]. [Previous ENT surgeries or treatment with dates.]"`,
  p2: `"The patient presented to the [department] with complaints of [ear discharge / decreased hearing / recurrent sore throat ___ episodes per year / nasal obstruction, nasal discharge, headache / change in voice / swelling in the neck, with duration]. [Sequence and treatment taken.] There was no history of [relevant negatives]."`,
  p3: `"On admission, the patient was [general condition], with blood pressure ___ mmHg and pulse rate ___/min. On ENT examination, [otoscopy: tympanic membrane perforation size and site, discharge / anterior rhinoscopy and nasal endoscopy findings / oral cavity and oropharynx: tonsil grade / indirect laryngoscopy / neck examination]. [Tuning fork tests.]"`,
  p4: `"Investigations revealed haemoglobin ___ g/dL, [bleeding and clotting time, blood sugar, viral markers]. [Pure tone audiometry showing ___ dB [conductive / mixed] hearing loss / CT PNS / CT temporal bone / biopsy, with findings.] Based on these findings, a diagnosis of [diagnosis] was made."`,
  p5: PRE_OP,
  op: `In formal sentences, only what the operation note says: "Under [general / local] anaesthesia, [approach: postaural / endaural / endoscopic / transoral]. Intra-operatively, [findings: perforation, middle ear and ossicles, polyps, sinus disease, septal deviation, tonsil findings, lesion extent]. [Procedure: tympanoplasty with temporalis fascia graft / cortical mastoidectomy / FESS / septoplasty / tonsillectomy by dissection and snare / tracheostomy.] [Haemostasis; nasal packs or ear pack placed.] [Specimen sent for histopathological examination.]" If no operation is documented, write: No operative procedure was performed during this admission.`,
  post: `"Post-operatively, the patient was managed with [IV / oral antibiotics, analgesics, nasal decongestant, steroid, as documented]. [Post-operative bleeding, nasal pack removal with date, ear dressing, oral intake, tracheostomy care.]"`,
  p6: DISCH_SURG,
  advice: `They have been advised to [continue named drugs, nasal sprays, douching or ear drops with duration], [keep water out of the operated ear / avoid nose blowing and sneezing with the mouth closed / take a soft cold diet, as documented].`,
});

const OPHTH = surg({
  id: "bi-ophth", name: "Ophthalmology", department: "Department of Ophthalmology",
  diagnosis: "Primary diagnosis as written with the eye (e.g. immature senile cataract, right eye / mature cataract / primary open-angle glaucoma / rhegmatogenous retinal detachment / corneal ulcer / pterygium), followed by \"s/p [operation] with [IOL] under [anaesthesia] on [date]\". Then complications, then comorbidities.",
  procedure: `One line per procedure in the form: "[Right / left] eye [SICS / phacoemulsification] with [PCIOL ___ D] under [peribulbar / topical] anaesthesia on [date]." Add other procedures on their own lines. If none, write: Managed conservatively.`,
  p1: `"A [age]-year-old [male/female], known case of [diabetes / hypertension with duration], on [long-term medications]. [Previous eye surgeries, laser or injections with eye and year.]"`,
  p2: `"The patient presented to the [department] with complaints of [gradual painless diminution of vision / sudden loss of vision / pain, redness, watering, photophobia, in the right / left / both eyes, with duration]. There was no history of [relevant negatives]."`,
  p3: `"On examination, visual acuity was ___ in the right eye and ___ in the left eye [with pinhole]. Intraocular pressure was ___ mmHg in the right eye and ___ mmHg in the left eye. Slit-lamp examination showed [lids, conjunctiva, cornea, anterior chamber, pupil reaction, lens grading]. Fundus examination showed [findings / no view]. [Sac syringing, keratometry and A-scan biometry with IOL power.]"`,
  p4: `"Investigations revealed [blood sugar, blood pressure, ECG, viral markers, B-scan, OCT, as documented]. Based on these findings, a diagnosis of [diagnosis] was made."`,
  p5: PRE_OP,
  op: `In formal sentences, only what the operation note says: "Under [peribulbar / topical] anaesthesia, the [right / left] eye underwent [SICS through a superior / temporal scleral tunnel / phacoemulsification through a clear corneal incision], with [capsulorhexis, nucleus delivery or emulsification, cortical clean-up] and a [PCIOL ___ D] was placed in the bag. [Intra-operative events: posterior capsule rent, vitreous loss, anterior vitrectomy.] [Subconjunctival injection and pad and bandage.]" If no operation is documented, write: No operative procedure was performed during this admission.`,
  post: `"On the first post-operative day, visual acuity in the operated eye was ___, the cornea was [clear / ___ oedema], the anterior chamber was [quiet / cells ___], and the IOL was [in the bag / well centred]. [Intraocular pressure and further course.]"`,
  p6: `"At the time of discharge, the operated eye was [quiet], with visual acuity of ___ and a [clear cornea, well-centred IOL]. The patient is being discharged with the following medications and advice."`,
  advice: `They have been advised to instil the eye drops exactly as tapered [antibiotic-steroid drops ___ times a day, reducing every week, as documented], to wear protective glasses, to avoid rubbing the eye [and water entering the eye for ___ days, if documented], and to come for review on [day / date]. Warning signs: sudden pain, redness, decreased vision or discharge from the operated eye.`,
});

const SONCO = surg({
  id: "bi-sonco", name: "Surgical Oncology", department: "Department of Surgical Oncology",
  diagnosis: "Primary diagnosis as written: site, side, histology and clinical stage (cTNM) at presentation, neoadjuvant therapy received, followed by \"s/p [operation] on [date]\", and pathological stage (ypTNM / pTNM) with margins and nodes from the final histopathology if available. Then complications, then comorbidities.",
  p1: `"A [age]-year-old [male/female], known case of [comorbidities with duration], [tobacco / alcohol use, if written]. [Diagnosis of the cancer: when, how it presented, biopsy with histology and receptor or marker status, staging scans with dates.] [Neoadjuvant chemotherapy or chemoradiation: regimen, cycles, dates and response.] [Tumour board decision, if written.]"`,
  p2: `"The patient was admitted for [planned surgery] for [diagnosis]. [Current symptoms, if any, with duration.]"`,
  p3: `"On admission, the patient was [general condition, ECOG ___], with blood pressure ___ mmHg and pulse rate ___/min. On local examination, [lump size, site, fixity, skin and nipple changes / abdominal findings / oral lesion], and the [axillary / cervical / inguinal] nodes were [findings]."`,
  p4: `"Pre-operative investigations revealed haemoglobin ___ g/dL, [renal and liver function, coagulation profile, viral markers, tumour markers, ECG, echocardiography, PFT]. [Pre-operative imaging: CECT / MRI / PET-CT with findings and date.]"`,
  p5: PRE_OP,
  op: `In formal sentences, only what the operation note says: "Under general anaesthesia, [incision / approach]. Intra-operatively, [tumour size, site, extent, fixity, nodes, peritoneal or liver findings]. [Procedure: e.g. modified radical mastectomy with level ___ axillary dissection / wide local excision / Whipple's pancreaticoduodenectomy / radical gastrectomy with D2 lymphadenectomy / composite resection with neck dissection, with reconstruction and anastomoses.] [Frozen section result, if done.] [Drains.] The specimen was sent for histopathological examination. [Blood loss and transfusion.]"`,
  post: `"Post-operatively, the patient was managed with [ICU care, IV antibiotics, analgesics, epidural, DVT prophylaxis, feeding jejunostomy or Ryle's tube feeds, as documented]." Include the final histopathology report if it is in the notes: tumour size, grade, margins, nodes positive / examined, and pathological stage.`,
  p6: DISCH_SURG,
  advice: `They have been advised to [continue named drugs with duration], [drain or wound care, arm or shoulder exercises, feeding instructions, as documented] and to follow up with the histopathology report for [tumour board discussion / adjuvant chemotherapy or radiotherapy, as documented].`,
});

const CTVS = surg({
  id: "bi-ctvs", name: "Cardiothoracic Surgery (CTVS)", department: "Department of Cardiothoracic and Vascular Surgery",
  diagnosis: "Primary diagnosis as written (e.g. coronary artery disease, triple vessel disease, LVEF ___% / rheumatic heart disease with severe mitral stenosis / ASD / empyema / lung mass), followed by \"s/p [CABG x ___ grafts / MVR with ___ valve / ASD closure / decortication / lobectomy] on [date]\". Then complications, then comorbidities.",
  p1: `"A [age]-year-old [male/female], known case of [diabetes, hypertension and other comorbidities with duration], [smoker, if written], on [long-term medications]. [Cardiac history: angina, myocardial infarction, PCI, rheumatic fever, balloon valvotomy, with dates.] [Coronary angiography and echocardiography before admission, with dates and findings.]"`,
  p2: `"The patient was admitted for [planned surgery / presented with ___] with complaints of [chest pain on exertion / breathlessness NYHA class ___ / palpitations / cough, fever, with duration]."`,
  p3: `"On admission, the patient was [general condition], with blood pressure ___ mmHg, pulse rate ___/min [regular / irregular], respiratory rate ___/min and SpO2 ___% on room air. On systemic examination, [heart sounds, murmurs, chest findings, peripheral pulses]."`,
  p4: `"Echocardiography showed [LVEF ___%, valve areas and gradients, regional wall motion abnormality, PASP]. Coronary angiography on [date] showed [vessel findings]. [Carotid Doppler, PFT, CECT chest, renal function, coagulation profile, viral markers.]"`,
  p5: PRE_OP,
  op: `In formal sentences, only what the operation note says: "Under general anaesthesia, through a [median sternotomy / thoracotomy], [on / off cardiopulmonary bypass, with CPB time ___ min and aortic cross-clamp time ___ min]. Intra-operatively, [findings]. [Procedure: grafts with conduits and targets (e.g. LIMA to LAD, SVG to OM and PDA) / valve replaced with ___ mm [mechanical / tissue] valve / repair / decortication / resection.] [Temporary pacing wires, mediastinal and pleural drains.] The patient was shifted to the ICU on [ventilator / inotropes]."`,
  post: `"Post-operatively, the patient was managed in the cardiothoracic ICU with [ventilation, inotropes, antibiotics, analgesics, diuretics, anticoagulation, as documented]. [Extubation date, inotrope weaning, drain output and removal dates, pacing wire removal, rhythm, chest X-ray, echocardiography, INR trend for valve patients, wound status, mobilisation and physiotherapy.]"`,
  p6: `"At the time of discharge, the patient was haemodynamically stable, with blood pressure ___ mmHg, pulse rate ___/min [rhythm] and SpO2 ___% on room air. The sternotomy wound was [healthy], and the patient was ambulating. In view of the satisfactory recovery, the patient is being discharged with the following medications and advice."`,
  advice: `They have been advised to [continue named drugs with duration], [keep INR between ___ and ___ with INR checks every ___, for valve patients, as documented], [sternal precautions: avoid lifting heavy weights and driving for ___ weeks, only if documented], [continue breathing exercises and walking, if documented] and [antibiotic prophylaxis before dental procedures, if documented].`,
});

export const SURGICAL_TEMPLATES = [GSURG, ORTHO, OBS, GYNAE, URO, NSURG, ENT, OPHTH, SONCO, CTVS];

export const DEFAULT_TEMPLATE = GM;
export const BUILTIN_TEMPLATES = [GM, ONCO, DAYCARE, NEPHRO, CARDIO, PULM, NEURO, GASTRO, ...SURGICAL_TEMPLATES];
export const isBuiltin = (id) => !id || BUILTIN_TEMPLATES.some((t) => t.id === id);
export const builtinById = (id) => BUILTIN_TEMPLATES.find((t) => t.id === id) || GM;

/** Suggest a built-in from the department read off the sheets. Order matters
 *  ("Medical Oncology", "Pulmonary Medicine" also contain "medic"). */
const SUGGEST = [
  [/surg\w*\s*onco|onco\w*\s*-?\s*surg/i, "bi-sonco"],
  [/ctvs|cvts|cardio\s*-?\s*thorac|cardiac\s+surg|thoracic\s+surg/i, "bi-ctvs"],
  [/neuro\s*-?\s*surg|\bnsx\b/i, "bi-nsurg"],
  [/ortho/i, "bi-ortho"],
  [/\burolog/i, "bi-uro"],
  [/surg\w*\s+gastro|\bgi\s+surg/i, "bi-gsurg"],
  [/\bent\b|otorhino|otolaryng|\borl\b/i, "bi-ent"],
  [/ophthal|\beye\b/i, "bi-ophth"],
  [/obstet|maternity|labou?r\s+room|\bobg\b|\bobgy\b|o\s*&\s*g\b/i, "bi-obs"],
  [/gyn/i, "bi-gynae"],
  [/onco|hemat|haemat|\bbmt\b/i, "bi-onco"],
  [/nephro|renal|dialysis/i, "bi-nephro"],
  [/cardio|\bccu\b|cardiac|\bcath/i, "bi-cardio"],
  [/pulmo|chest|respirat|\bricu\b|tuberc/i, "bi-pulm"],
  [/neuro(?!.*surg)/i, "bi-neuro"],
  [/gastro|hepat|liver|\bgi\b/i, "bi-gastro"],
  [/surg/i, "bi-gsurg"],
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
/* ---------- Tabulated (date-wise) investigations ---------- */
// Parses DD/MM/YYYY, DD-MM-YY or DD/MM so dates sort in order.
function dateKey(d) {
  const m = String(d || "").match(/(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?/);
  if (!m) return 1e9; // undated values go last
  let y = Number(m[3] || 0); if (y && y < 100) y += 2000;
  return y * 10000 + Number(m[2]) * 100 + Number(m[1]);
}
export function invTableHtml(data, heading = "Investigations") {
  const inv = (data.investigations || []).filter((r) => r.test && r.value);
  const img = (data.imaging_and_other_tests || []).filter((r) => r.test || r.finding);
  if (!inv.length && !img.length) return "";
  let h = heading ? `<h2>${esc(heading)}</h2>` : "";
  if (inv.length) {
    const dates = [], tests = [], cell = new Map();
    for (const r of inv) {
      const d = String(r.date || "").trim();
      const t = String(r.test).trim(), tk = t.toLowerCase().replace(/\s+/g, " ");
      if (!dates.includes(d)) dates.push(d);
      let row = tests.find((x) => x.k === tk);
      if (!row) { row = { k: tk, name: t, unit: String(r.unit || "").trim() }; tests.push(row); }
      if (!row.unit && r.unit) row.unit = String(r.unit).trim();
      const key = `${tk}|${d}`;
      const v = `${hl(r.value)}${r.flag ? ` <b>${esc(r.flag)}</b>` : ""}`;
      cell.set(key, cell.has(key) ? `${cell.get(key)} / ${v}` : v);
    }
    dates.sort((a, b) => dateKey(a) - dateKey(b));
    for (let i = 0; i < dates.length; i += 6) {
      const cols = dates.slice(i, i + 6);
      h += `<div class="inv-scroll"><table class="inv inv-grid"><tr><th>Investigation</th>${cols.map((d) => `<th>${d ? hl(d) : "Date not written"}</th>`).join("")}</tr>${
        tests.filter((t) => cols.some((d) => cell.has(`${t.k}|${d}`))).map((t) =>
          `<tr><td>${hl(t.name)}${t.unit ? ` <small>(${hl(t.unit)})</small>` : ""}</td>${cols.map((d) => `<td>${cell.get(`${t.k}|${d}`) || "–"}</td>`).join("")}</tr>`).join("")
      }</table></div>`;
    }
  }
  if (img.length) {
    h += `<table class="inv"><tr><th>Date</th><th>Other investigations</th><th>Findings</th></tr>${
      img.map((r) => `<tr><td>${hl(r.date)}</td><td>${hl(r.test)}</td><td>${hl(r.finding)}</td></tr>`).join("")}</table>`;
  }
  return h;
}

export function buildDoc(P, data, draft, tpl = DEFAULT_TEMPLATE) {
  const outcome = P.outcome || "discharged";
  const meds = (data.medications || []).filter((m) => medLine(m));
  const sec = draft.sections || {};
  let title = tpl.title || "DISCHARGE SUMMARY";
  if (TITLES[outcome] && /discharge\s+summary/i.test(title)) title = title.replace(/discharge\s+summary/i, TITLES[outcome]);
  const dept = P.dept || tpl.department || "";

  let h = `<h1>${esc(title)}</h1>${dept ? `<div class="dept">${esc(dept)}</div>` : ""}`;
  const head = (s) => (s.heading ? `<h2>${esc(s.heading)}</h2>` : "");

  // Optional date-wise investigation table (chosen on the Review screen). It is always built and shown or
  // hidden by the app, so the doctor's edits to the summary are kept when the option is switched.
  const hasInvSec = tpl.sections.some((s) => s.kind === "investigations_table");
  const firstListIdx = tpl.sections.findIndex((s) => ["treatment_given", "discharge_medications", "advice", "signature"].includes(s.kind));
  const invBlock = hasInvSec ? "" : invTableHtml(data);
  let invDone = !invBlock;
  const addInv = () => { if (!invDone) { h += `<div class="opt-inv"${P.tabulate ? "" : " hidden"}>${invBlock}</div>`; invDone = true; } };

  tpl.sections.forEach((s, i) => {
    if (i === firstListIdx) addInv();
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
        if (P.tabulate) { h += invTableHtml(data, s.heading || "Investigations"); break; }
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
  addInv(); // templates without a medication/advice section: put the table at the end
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
