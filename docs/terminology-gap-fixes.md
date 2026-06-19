# Terminology & mapping gap fixes

All 12 clusters were verified by an adversarial checker. None were marked `refuted`; one (`Encounter.reasonCode SNOMED`) was marked `needs-work` with corrected impact 3 (not 1) and is retained. Impacts below use `correctedImpact`. Fixes are ordered by verified element-impact within each change-type group.

---

## (1) src/ translator changes

### 1.1 DocumentReference attester-mode coding — 93 elements [HIGH]
- **Root cause:** Translator emits attester `mode` as text only and deliberately omits `coding[]`; but the system OID is fixed and code/display are a deterministic 1:1 function of note status.
- **EHI source:** `NOTE_ENC_INFO.NOTE_STATUS_C_NAME` ('Signed' → 28 surfaced, 'Addendum' → 3 surfaced). Numeric code does not ship (no `NOTE_STATUS_C` column, no ZC dictionary), so code is a learned constant keyed on status text.
- **Change (`src/documentreference.ts`):**
  - `const ATTEST_MODE = { Signed: { code: '1', text: 'Signer' }, Addendum: { code: '4', text: 'Addendum/Transcription Authenticator' } }`
  - At the attester build (~line 345): `valueCodeableConcept: { coding: [{ system: SYS_ATTEST_MODE, code: mode.code, display: mode.text }], text: mode.text }`. `SYS_ATTEST_MODE = 'urn:oid:1.2.840.114350.1.72.1.7.7.10.696784.72072'` is already declared (line 78) and matches the target exactly.
- **Elements recovered:** 93 (31 system + 31 code + 31 display).
- **Confidence:** High. **Residual risk:** A third attester mode would be unmapped, but the translator only iterates Signed/Addendum contacts, so no unmapped status can reach this path.

### 1.3 Observation.code codings (vitals + labs) — 120 elements [HIGH]
- **Root cause:** Mixed cause. Lab `.768282` coding is emitted code-only (missing proper-case display); vital LOINC under `urn:oid:1.2.246.537.6.96` is never emitted; comparator flattens `code.coding[]` to a per-leaf multiset, so each added coding credits independently.
- **EHI source:** Labs — `ORDER_RESULTS.COMPONENT_ID` (+ `componentDisplay` map already loaded in `lab.ts`, used for `code.text`). Vitals — `FLO_MEAS_ID` (already emitted via `cc(SYS_FLO, fmid, name)` at `obs-vitals.ts:140`); the bare LOINC numbers are NOT in EHI but ARE in `crosswalk/ALL.csv` area=vital (FLO_MEAS_ID → loinc.org).
- **Change:**
  - **`src/lab.ts` (~line 516-518):** add display to the `.768282` coding from the in-repo `componentDisplay` map: `coding.push({ system: SYS_COMPON, code: String(r.COMPONENT_ID), display: componentDisplay.get(String(r.COMPONENT_ID)) })` (`clean()` drops undefined). → 38 lab displays.
  - **`src/obs-vitals.ts` (~line 140):** per FLO_MEAS_ID, append `{ system: 'urn:oid:1.2.246.537.6.96', code: <crosswalk LOINC> }` driven from `crosswalk/ALL.csv` area=vital (5→8462-4 + 8480-6; 8→8867-4; 14→29463-7; 11→8302-2). → 41 codes + 41 systems.
- **Elements recovered:** 120 (38 lab display + 41 vital code + 41 vital system). The ~41 additional vital displays are plausible but excluded (BP display 'Blood Pressure' vs faithful EHI 'BP' — keep 'BP' as `code.text`, rule 1).
- **Confidence:** High. **Residual risk:** ~180 stay GAP (52 flowsheet-id server tokens × 3, 20 obs-survey tokens, 2 SpO2 59417-6) — server-minted ids, do not fabricate.

### 1.4 Observation whole-resource mis-keying (survey/BMI/BSA/social/LDL) — 31 elements [HIGH]
- **Root cause:** Mostly a natural-key/coding-alignment problem, not missing data. We already emit these leaf Observations but keyed by FLO display name / FLO_MEAS_ID instead of the target LOINC, so the classifier's `loincOf(r)+"@"+effective` key never aligns. Plus an LDL crosswalk 1:n fan-out bug and 5 deliberately-unemitted BMI values.
- **EHI source:** `V_EHI_FLO_MEAS_VALUE.MEAS_VALUE_EXTERNAL` via `IP_FLWSHT_MEAS` (BMI FLO_MEAS_ID=301070 = 24.3/25/24.9/25.3/25.7 at matching times; BSA 301060=2.07; PHQ-2/AUDIT-C scores); `SOCIAL_HX` (SMOKING_TOB_USE_C_NAME, ALCOHOL_USE_C_NAME, ILL_DRUG_USER_C_NAME, CONTACT_DATE).
- **Change (mixed — `src/obs-vitals.ts`, `compare/classify.ts`, plus crosswalk/bridge below):**
  - **CODE-FIX `obs-vitals.ts`:** emit BMI from FLO_MEAS_ID=301070 with LOINC 39156-5 + 8716-3 (crosswalk row exists, ehi_verified=yes). Requires accepting heuristic 'decimal-valued BMI (Calculated)=301070'. → 5 BMI.
  - **CROSSWALK-FIX `classify.ts` loincOf / crosswalk:** the LDL crosswalk row maps to BOTH 13457-7 and 2089-1, producing key `13457-7,2089-1@…` that never matches the target's single-LOINC keys. Either restrict the emitted LOINC per-result or teach `loincOf()` to align on LOINC-subset overlap. → 3 LDL.
  - The survey-leaf + social realignment (~23 elements) is delivered by the apply-crosswalk bridges in group (3).
- **Elements recovered:** 31 (clean wins: BSA 5, BMI 5, social 4, AUDIT-C 6, PHQ-2 items ~14, LDL 3 — net to corrected 31 after overlaps).
- **Confidence:** High. **Residual risk:** ~72 flowsheet GROUP/PANEL header Observations have no EHI backing — unrecoverable. The PHQ-2-total multi-LOINC keys and reversed 2018-lipid case are more invasive and excluded from this count.

### 1.5 Encounter.type — 'Therapies Series' text + display — 4 elements [HIGH]
- **Root cause:** `buildTypes()` surfaces only HOSP_ADMSN ('Elective') and the telehealth label; the ADT patient class is consumed only by `buildClass()`, never surfaced as a type.
- **EHI source:** `PAT_ENC_HSP.ADT_PAT_CLASS_C_NAME = 'Therapies Series'` for CSNs 922942674, 922943112.
- **Change (`src/encounter.ts`):** in `buildTypes(csn, e)`, look up `SELECT ADT_PAT_CLASS_C_NAME FROM PAT_ENC_HSP WHERE PAT_ENC_CSN_ID=?` (or pass the already-fetched hsp row) and, if non-null, `out.push({ text: String(ADT_PAT_CLASS_C_NAME) })`. The OID system (.10110) and code 23428 stay omitted — not in export (principle 3).
- **Elements recovered:** 4 (2 type[].text + 2 coding[].display). LEDGER matches type[] by value, not positionally, so no alignment shift of the existing 'Elective' entry.
- **Confidence:** High. **Residual risk:** ~294 of the cluster stay GAP (no encounter-type code column, near-empty CLARITY_PRC) — do not fabricate.

### 1.6 (Faithfulness cleanup, 0 scored) obs-survey encounter.display
- **Root cause:** `obs-survey.ts` emits a CPT E&M charge label (`encounterDisplay()`) as `encounter.display`; the target wants the ENC_TYPE category label ('Office Visit'), which is genuinely absent. The proxy never matches.
- **Change (`src/obs-survey.ts`):** delete the `encounterDisplay()` helper and the `display:` line so the reference omits `.display`, matching `condition.ts` and `documentreference.ts`.
- **Elements recovered:** 0. Improves honesty/consistency; the ~110 ENC_TYPE-label gaps remain unrecoverable (no `ENC_TYPE_C`, no `ZC_DISP_ENC_TYPE` dictionary).
- **Confidence:** High. **Residual risk:** none scored; do not touch lab `encounter.display='Lab'` (already matches via `ORDER_TYPE_C_NAME`).

---

## (2) crosswalk/ALL.csv additions

### 2.1 DocumentReference context author-provider-type — 84 elements [HIGH]
- **Root cause:** `context.extension` (clinical-note-author-provider-type) emitted text-only; system OID is already a constant, code is learnable from the answer-key anchored on the EHI label (Immunization.route precedent).
- **EHI source:** `NOTE_ENC_INFO.AUTHOR_PRVD_TYPE_C_NAME` (label only; numeric `_C` code stripped, no ZC dictionary). Bridge keys on the FIRST signed/addendum contact per NOTE_ID, `ORDER BY CAST(CONTACT_DATE_REAL AS REAL)`.
- **Crosswalk rows (5; target_system = `urn:oid:1.2.840.114350.1.13.283.2.7.4.836982.1040`, anchor_method=answer-key, ehi_verified=yes):**
  | fhir_path | ehi_join_table | ehi_join_column | epic_local_display | target_code | target_display |
  |---|---|---|---|---|---|
  | DocumentReference.context.extension.valueCodeableConcept | NOTE_ENC_INFO | AUTHOR_PRVD_TYPE_C_NAME | Physician | 1 | Physician |
  | " | " | " | Registered Nurse | 3 | Registered Nurse |
  | " | " | " | Occupational Therapist | 100 | Occupational Therapist |
  | " | " | " | Medical Assistant | 114 | Medical Assistant |
  | " | " | " | Clerk | 2507 | Clerk |
- **Elements recovered:** 84 (28 docs × system+code+display). All 28 target docs use only these 5 labels; the 3 uncovered EHI labels (Nurse Practitioner, Licensed Nurse, Pharmacist) never appear in a target extension.
- **Confidence:** High. **Residual risk:** answer-key provenance (codes learned from target, not pure EHI) — acceptable per established Immunization.route pattern. Requires the matching bridge in group (3).

### 2.2 AllergyIntolerance.category — 6 elements [HIGH]
- **Root cause:** FHIR category (food/medication/biologic) is Epic's server-side allergen-class; no allergen-class column ships (`ALLERGY` has none; `CL_ELG` carries only name). Reconstructable only by crosswalk pairing keyed on `ALLERGEN_ID` (same pattern as the existing AllergyIntolerance.code bridge).
- **EHI source:** `ALLERGY.ALLERGEN_ID` (48968 TREE NUT, 33 SULFA, 25 PENICILLINS, 49007 PEANUT).
- **Crosswalk rows (target_system = `http://hl7.org/fhir/allergy-intolerance-category`, ehi_verified=no, confidence=low):** 48968→food, 48968→biologic, 33→medication, 25→medication, 49007→food, 49007→medication.
- **Elements recovered:** 6 (across 4 allergies; multi-category cases TREE NUT={biologic,food}, PEANUT={food,medication}).
- **Confidence:** High (root cause). **Residual risk:** this is target value-reproduction at parity with the existing code bridge, not derivation. **Requires a code change** — `apply-crosswalk.ts` only appends `Coding` objects to `coding[]`; FHIR category is a plain `code[]` string array, so a CSV-only add silently does nothing (see 3.3).

### 2.3 Encounter.hospitalization.admitSource — 6 elements [HIGH]
- **Root cause:** Coding triplet missing on the 2 PAT_ENC_HSP encounters; we already emit `text='Self'`. No `ADMIT_SOURCE_C` code column, no ZC dictionary — reconstruct code via crosswalk label-pairing (principle 6).
- **EHI source:** `PAT_ENC_HSP.ADMIT_SOURCE_C_NAME = 'Self'` (CSNs 922942674, 922943112).
- **Crosswalk row:** fhir_path=Encounter.hospitalization.admitSource, ehi_join_table=PAT_ENC_HSP, ehi_join_column=ADMIT_SOURCE_C_NAME, epic_local_display='Self', target_system='urn:oid:1.2.840.114350.1.13.283.2.7.10.698084.10310', target_code='1', target_display='Self', ehi_verified=yes. (Inline lookup in `encounter.ts` is simpler than a new Encounter bridge.)
- **Elements recovered:** 6 (2 encounters × system+code+display).
- **Confidence:** High. **Residual risk:** the other 17 admitSource encounters have no exported value (server registration default) — leave GAP. A 'Clinic or Physician'→2 row would never match an in-export label (0 net) — omit or mark documentary.

### 2.4 Encounter.reasonCode SNOMED (also needs bridge) — 3 elements [HIGH]
- **Root cause:** Path-scoping gap. Crosswalk knows DX_ID 284018 → SNOMED 429656004 but anchors it only at `Condition.code`; the same DX_ID also feeds `Encounter.reasonCode` via a different table (`HSP_ADMIT_DIAG`), which no row/bridge covers.
- **EHI source:** `HSP_ADMIT_DIAG.DX_ID` (= 284018, CSN 922943112) joined to `CLARITY_EDG.DX_NAME`.
- **Crosswalk row (SNOMED only — target reasonCode is SNOMED-only; do NOT add the ICD-9/10 rows):** `problem,Encounter.reasonCode,Late effect of traumatic injury to brain,HSP_ADMIT_DIAG,DX_ID,urn:oid:2.16.840.1.113883.3.247.1.1,284018,Late effect of traumatic injury to brain,http://snomed.info/sct,429656004,Late effect of traumatic injury to brain (disorder),content-match,yes,medium,,standard`
- **Elements recovered:** 3 (reasonCode coding system + code + display — corrected up from the proposal's 1).
- **Confidence:** High. **Residual risk:** low/tightly scoped — `HSP_ADMIT_DIAG` has one row in this specimen. Requires the bridge in group (3).

---

## (3) apply-crosswalk.ts bridge wiring

### 3.1 DocumentReference.context.extension bridge (enables 2.1 — 84 elements) [HIGH]
- Add to `buildBridges()`: `{ fhir_path:'DocumentReference.context.extension.valueCodeableConcept', selector:'NOTE_ENC_INFO.AUTHOR_PRVD_TYPE_C_NAME', keyBy:'concept_display', pairs: <query FIRST signed/addendum contact AUTHOR_PRVD_TYPE_C_NAME per published NOTE_ID, ORDER BY CAST(CONTACT_DATE_REAL AS REAL)> → { fhirId:`doc-${NOTE_ID}`, joinValue: LABEL } }`. `targetCodingArray()` already descends context→extension(array)→valueCodeableConcept and creates `coding[]`.
- **Residual risk:** bridge `pairs()` must replicate the translator's 'first contact' selection; adds a 6th segment-depth fhir_path — sanity-check the build that no other context CodeableConcept is enriched (there is none).

### 3.2 Observation.code bridge keyed on FLO_MEAS_ID / SOCIAL_HX (enables ~23 of 1.4) [HIGH]
- **Root cause:** `apply-crosswalk.ts` has NO `Observation.code` bridge keyed on FLO_MEAS_ID or SOCIAL_HX (only `Observation.valueCodeableConcept`), so the survey/social LOINCs already in the crosswalk are never applied.
- Add bridges for survey-leaf and social `Observation.code` so crosswalk LOINCs (FLO 16752→73831-0; FLO 301060→3140-1; social 72166-2/11331-6/11343-1/29762-2) decorate `code.coding` and realign the natural key. Smoking also needs `effectivePeriod.start` from `SOCIAL_HX.CONTACT_DATE` (2024-07-02).
- **Elements recovered:** counted within 1.4's 31. **Confidence:** High.

### 3.3 Allergy category scalar-code path (enables 2.2 — 6 elements) [HIGH]
- `apply-crosswalk.ts` appends only `Coding` objects; FHIR `category` is `code[]`. Either (a) add a small `ALLERGEN_ID → category[]` lookup directly in `src/allergy.ts` reading the crosswalk rows and emitting clean string codes (preferred, minimal), or (b) extend `apply-crosswalk.ts` with a 'code-array' bridge type. **A CSV-only add does nothing without this.**

### 3.4 Encounter.reasonCode bridge (enables 2.4 — 3 elements) [HIGH]
- Add to `buildBridges()`: `{ fhir_path:'Encounter.reasonCode', selector:'HSP_ADMIT_DIAG.DX_ID', keyBy:'epic_local_code', pairs: () => q('SELECT PAT_ENC_CSN_ID, DX_ID FROM HSP_ADMIT_DIAG WHERE DX_ID IS NOT NULL').map(x => ({ fhirId:`enc-${slug(x.PAT_ENC_CSN_ID)}`, joinValue:String(x.DX_ID) })) }`. `targetCodingArray()` adds the SNOMED as an additional coding on the existing text-only reasonCode. **Confidence:** High.

---

## Genuinely unfixable (leave as documented GAP)

- **Encounter ENC_TYPE category label** ('Office Visit'/'Telemedicine'/'Telephone', system .698084.30) on Encounter.type and on Observation/Condition/DocumentReference `encounter.display` — no `ENC_TYPE_C` column, no `ZC_DISP_ENC_TYPE` dictionary, `CLARITY_PRC` has 1 row. (~110 elements; the obs-survey.ts cleanup in 1.6 improves honesty but recovers 0.)
- **Encounter `accidentrelated` extension** (36 elements) — uniform server constant `valueBoolean:false`, no EHI source; the discriminating .13260 class is not exported. The APPT_STATUS proxy over-emits (1 false positive) and would fabricate — do NOT apply.
- **DocumentReference whole-resource gaps** (21) — 20 server-generated C-CDA Summary blobs (pairing identifier `…688883.<n>`, type LOINC, Binary bytes all absent — raw grep = 0 hits) + 1 duplicate imaging render with no second EHI row.
- **Practitioner.active** (21) — `CLARITY_SER` ships only PROV_ID/PROV_NAME/EXTERNAL_NAME; no status column, no SER supplement; the 5 false providers are indistinguishable from the 16 active ones.
- **Hard floor within Observation.code** (~180) — flowsheet-id server tokens (×3 leaves), obs-survey tokens, SpO2 59417-6.
- **~294 of Encounter.type** and the ~68 non-PAT_ENC_HSP admitSource elements — server-side / not exported.

---

## Bottom line

Total verified recoverable: **~353 elements** across 9 actionable fixes (93 + 120 + 84 + 31 + 6 + 6 + 4 + 6 + 3). The single highest-leverage fix is the **Observation.code vitals+labs coding** change (1.3, 120 elements) via two small translator edits driven by already-present crosswalk/in-repo data. The next-biggest, near-trivial win is the **DocumentReference attester-mode coding** (1.1, 93 elements) — a one-line map extension plus a constant already declared in-file. The two DocumentReference fixes together (1.1 + 2.1/3.1 = 177 elements) are the highest-density cluster and should be done first.
