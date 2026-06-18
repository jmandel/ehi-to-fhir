# Gaps — obs-vitals (Observation, category = vital-signs)

Spine: `V_EHI_FLO_MEAS_VALUE` (value) ⨝ `IP_FLWSHT_MEAS` (who/when) ⨝ `IP_FLWSHT_REC` (stay/patient)
⨝ `PAT_ENC` (encounter CSN). One Observation per `(FSD_ID, LINE)`.

**Vital-signs membership is DERIVED, not hand-listed.** A measure is a vital iff it is filed under
the `IP_FLWSHT_MEAS.FLT_ID_DISPLAY_NAME = 'Encounter Vitals'` flowsheet template (read from the DB).
That template carries exactly: 5 BP, 8 Pulse, 10 SpO2, 11 Height, 14 Weight, 210000000012 BP
Location, 210000000013 BP Position, 210000000014 BP Cuff Size. Every auto-calculated row (BMI, BSA,
IBW, tidal volumes, weight-change…) lives under `'Custom Formula Data'` and every screening row under
its own screening template, so the template filter excludes them.

Each gap below names the **exact query/scan run to prove the absence**, so the claim is falsifiable.
A falsification pass (2026-06) re-checked every claim across domains and found **0 false absences**:
every coding/label/code the target shows that we do not emit is genuinely unreachable from this
export, and the two "partial" datums (BMI variant choice, BP "Blood Pressure" display) are
ambiguous/different-column proxies that would require lifting the answer — see below.

---

## Membership: 61 generated vs 57 target (non-EHI-derivable curation, deliberately NOT special-cased)

- **BP Location (210000000012): generated, target drops it.** In the EHI, BP Location is identical in
  every column to BP Position / BP Cuff Size (same `'Encounter Vitals'` template, same
  `ISACCEPTED_YN='Y'`, same `VALUE_TYPE_C_NAME='Custom List'`, same 9 occurrences). The target omits
  it from every Observation (any category). No EHI column predicts the drop, so we emit it (+9).
  Excluding it would mean a measure-id exclude list copied from the target.

- **Calculated BMI: target surfaces it (FLO_MEAS_ID 301070), we do not (−5).** PARTIAL in the
  falsification pass: the value is *reachable* but the *variant choice is not EHI-derivable*. Proof:
  ```
  SELECT FLO_MEAS_ID, FLO_MEAS_ID_DISP_NAME, GROUP_CONCAT(MEAS_VALUE_EXTERNAL)
  FROM V_EHI_FLO_MEAS_VALUE
  WHERE FLO_MEAS_ID IN ('301070','5445','210000000020','210100200230','10245')
  GROUP BY FLO_MEAS_ID, FLO_MEAS_ID_DISP_NAME
  ```
  returns FIVE near-identical "Custom Formula Data" BMI variants for this patient:
  | FLO_MEAS_ID | DISP_NAME | values |
  |---|---|---|
  | 301070 | BMI (Calculated) | 25.7, 24.3, 25.3, 24.9, 25  ← **target uses this** |
  | 5445 | BMI (Calculated) | 26, 24, 25, 25, 25 (same name, integer-rounded) |
  | 210000000020 | BMI | 24.98, 25.8, 24.32, 25.1, 25.34 |
  | 210100200230 | BMI Frailty | 25.8, 24.3, 25.3, 25, 25.1 |
  | 10245 | `BMI >35="1" . BMI <=35="0"` | 0, 0, 0, 0, 0 (a threshold flag, not a BMI value) |

  Two of the five share the canonical name **"BMI (Calculated)"** (301070, 5445) and the value-view is
  column-for-column identical between them (verified: `SELECT * FROM V_EHI_FLO_MEAS_VALUE WHERE
  FLO_MEAS_ID IN ('301070','5445') AND FSD_ID='181864978'` differs only in FLO_MEAS_ID/LINE/value).
  They differ only in value precision — 301070 keeps the decimal, 5445 is integer-rounded. "Prefer the
  decimal one" reproduces the target's numbers but is a heuristic *lifted from the answer*, not a
  derivation from any EHI column. A separate encounter-level source exists —
  `SELECT PAT_ENC_CSN_ID, BMI FROM PAT_ENC WHERE BMI IS NOT NULL` → 24.27, 25.55, 25.04, 25.40,
  25.54, 24.93, 24.61, 25.29, 25.75 — but those are DIFFERENT numbers, so the target's BMI is the
  flowsheet 301070 row, not PAT_ENC.BMI. With no EHI flag marking which variant is "the vital", we
  omit BMI rather than copy a measure id (or a precision heuristic) out of the answer.

Apart from membership, every emitted value, unit conversion, effective instant, abnormal flag, and
amended status is derived from the EHI.

---

## Coding gaps — external code/system absent (datum present as text)

- **`code.coding` — LOINC, SNOMED, Epic FHIR flowsheet-id, and `urn:oid:…6.96` codes (NOT in export).**
  The target packs up to 7 codings per vital (e.g. BP: LOINC 55284-4/85354-9/8716-3, two `…6.96`
  codes, the flowsheet-id `tOmaSI-…`, plus the OID-707679 measure code).
  - **Schema search:** `bun tools/find-concept.ts "LOINC"` — the only LOINC-bearing tables are
    `ORDER_RESULTS` / `ORDER_PROC_4` / `LNC_DB_MAIN` (all lab-side); none links to `FLO_MEAS_ID`.
    `LNC_DB_MAIN` (`SELECT LNC_CODE, LNC_LONG_NAME`) is entirely lab LOINCs (cholesterol/glucose/…),
    no vital-sign codes, no flowsheet link.
  - **Value scan:** `bun tools/find-concept.ts --grep '\b(55284|85354|8716|8480|8462|8867|8302|29463|39156|59408)-[0-9]'`
    over `raw/EHITables/*.tsv` = **0 hits** (no raw table contains any vital-sign LOINC).
  - **Epic FHIR flowsheet-id:** `bun tools/find-concept.ts --grep 'tOmaSI'` = **0 hits**.
  - No flowsheet table (`IP_FLO_GP_DATA`, `IP_FLOWSHEET_ROWS`, `IP_FLWSHT_MEAS`, `V_EHI_FLO_MEAS_VALUE`)
    has any terminology/code column — they carry only `FLO_MEAS_ID` + `DISP_NAME`.
  → We emit ONLY the one coding truly in the export: `urn:oid:1.2.840.114350.1.13.283.2.7.2.707679`
  with `code = FLO_MEAS_ID` and the inline display, plus `code.text`. The rest are Epic-terminology-
  assigned and are not fabricated.

- **`code.coding[].display` / `code.text` for BP reads "BP", target reads "Blood Pressure".** PARTIAL:
  the literal "Blood Pressure" DOES exist in the export but in a different column with different
  semantics. Proof:
  ```
  SELECT DISTINCT FLO_MEAS_ID, FLO_MEAS_ID_DISP_NAME, VALUE_TYPE_C_NAME
  FROM V_EHI_FLO_MEAS_VALUE WHERE FLO_MEAS_ID=5
  ```
  → `FLO_MEAS_ID_DISP_NAME='BP'`, `VALUE_TYPE_C_NAME='Blood Pressure'`. The measure's *display label*
  is "BP"; "Blood Pressure" is only the value-type CLASSIFIER (the same column that reads "Patient
  Weight"/"Numeric Type" on other rows), not a measure display. Using it as the BP display would be a
  cross-column proxy with different meaning, so we keep the truthful `FLO_MEAS_ID_DISP_NAME` = "BP".
  (All other measure names — Pulse, Weight, Height, SpO2, BP Position, BP Cuff Size — match the target.)

- **`component[].code` for the BP children (systolic / diastolic) — no per-half measure exists.** FHIR
  R4 makes `Observation.component.code` REQUIRED (1..1). The export packs BP as a single `"142/74"`
  string under ONE flowsheet measure (`FLO_MEAS_ID=5`, `DISP_NAME='BP'`,
  `VALUE_TYPE_C_NAME='Blood Pressure'`).
  - **No distinct systolic/diastolic measure:** verified across `IP_FLO_GP_DATA`, `IP_FLOWSHEET_ROWS`,
    and `V_EHI_FLO_MEAS_VALUE` — only the packed `"BP"` row exists (the only other BP-related ids are
    `…012/013/014` Location/Position/Cuff, not pressure values).
  - **Child LOINC absent:** value scan `--grep '…8480…8462…'` (in the combined LOINC scan above) =
    **0 hits**; `LNC_DB_MAIN` contains neither `8480-6` nor `8462-4`.
  → We derive each `component.code` ONLY from EHI data: the parent BP measure coding (`urn:oid:…707679`
  + `code=5` + display `'BP'`), identical on both components (the EHI gives them one identity), plus
  `text = "BP Systolic"` / `"BP Diastolic"` — the name is from the EHI, the half is the structural
  split we record. The child LOINC codes (`8480-6`/`8462-4`) remain a coding gap, not fabricated.
  (Before this code: components had `valueQuantity` but no `code` → 18 validator errors
  `component.code: minimum required = 1, but only found 0`; now 0.)

- **`valueCodeableConcept` SNOMED for BP Position (sitting) / BP Cuff Size (adult) — NOT in export.**
  Target carries SNOMED `33586001` (sitting) / `720737000` (adult cuff) alongside the raw answer.
  - **Value scan:** `bun tools/find-concept.ts --grep '\b(33586001|720737000)\b'` over
    `raw/EHITables/*.tsv` = **0 hits**. No SNOMED map table exists in the export.
  → `V_EHI_FLO_MEAS_VALUE` ships only the raw local answer; we emit `{coding:[{code, display}], text}`
  from the raw value, no system.

- **`valueCodeableConcept` display for BP Cuff Size is "Reg", target "Regular (Adult)".**
  - **Value scan:** `grep 'Regular (Adult)'` over `raw/EHITables/*.tsv` = **0 hits**.
  - `SELECT MEAS_VALUE_EXTERNAL, COUNT(*) FROM V_EHI_FLO_MEAS_VALUE WHERE FLO_MEAS_ID=210000000014
    GROUP BY 1` → only `'Reg'` (×9). No answer-expansion / list table maps `Reg`→`Regular (Adult)`.
  → We emit the stored short code `Reg`; the expanded label is Epic-assigned and absent.

---

## Data gaps — the datum itself is unreachable

- **`encounter.display` ("Office Visit") — Epic encounter-type label, not in PAT_ENC.**
  - **Value scan:** `bun tools/find-concept.ts --grep 'Office Visit'` hits ONLY `DOC_INFORMATION`
    (an External-Questionnaire doc description) and `MSG_TXT` (an in-basket message body
    "Visit Type: Office Visit") — neither joinable to the 9 vitals CSNs.
  - **No type column on PAT_ENC:** `SELECT name FROM pragma_table_info('PAT_ENC') WHERE name LIKE
    '%TYPE%' OR name LIKE '%VISIT%'` → only `VISIT_PROV_ID`, `VISIT_PROV_TITLE_NAME` (provider title),
    `HOSP_ADMSN_TYPE_C_NAME`, `WC_TPL_VISIT_C_NAME`, `CONSENT_TYPE_C_NAME` — none is an encounter/
    visit *type* label, and PAT_ENC has no `PRC_ID` link to the visit-type dictionary.
  → Encounter-type resolution belongs to the Encounter shard, not flowsheet rows. We emit the
  encounter **reference** + the export's real CSN **identifier** (`use/system/value`), no display.

- **`performer` on the 2 amended 9/28/2023 rows (Weight & BMI) — taker has no Practitioner.**
  Their `TAKEN_USER_ID = MSF400`.
  - `SELECT USER_ID, NAME FROM CLARITY_EMP WHERE USER_ID='MSF400'` → `FARGEN, MEGAN` (EMP login).
  - `SELECT PROV_ID, PROV_NAME FROM CLARITY_SER WHERE PROV_NAME LIKE '%FARGEN%'` → **0 rows**
    (no SER provider "FARGEN, MEGAN"; the `%MEGAN%` hit "BOWER, MEGAN M" is a different person).
  - The Practitioner shard mints ids from `CLARITY_SER.PROV_ID` only, so emitting a reference here
    would dangle. → We leave performer absent rather than fabricate a non-resolving reference. The
    other 55 rows resolve EMP→SER by unambiguous name and reference a real Practitioner. (Performer
    display form also differs: export "IRELAND, TRACY C" vs target's scrambled "Tracy I" — we keep
    the truthful export name.)

---

## Precision differences (not gaps, but noted)

- **`issued` is minute-precise; target has real seconds (e.g. …21:09:37Z).**
  - `SELECT DISTINCT ENTRY_TIME, RECORDED_TIME, INSTANT_PENDED_DTTM FROM IP_FLWSHT_MEAS WHERE
    FLT_ID_DISPLAY_NAME='Encounter Vitals'` → every `ENTRY_TIME`/`RECORDED_TIME` ends in `:00` seconds
    and `INSTANT_PENDED_DTTM` is NULL. No exported column carries sub-minute filing seconds.
  - `issued` is `ENTRY_TIME` → local (America/Chicago, DST-aware) → UTC; date/hour/minute and offset
    match the target. `effectiveDateTime` is `RECORDED_TIME` the same way; matches to the minute.

---

## Verified correct (no gap)

- Counts per measure (BP 9, Pulse 9, SpO2 2, Height 5, Weight 9, BP Position 9, BP Cuff 9).
- Weight oz→kg (`/16 × 0.45359237`) and Height in→cm (`× 2.54`) match every target value.
- BP split into systolic/diastolic `component[]` with `mm[Hg]`, each carrying the required
  `component.code` derived from the packed-BP measure (id 5 / "BP") + a Systolic/Diastolic text label
  (child LOINC not in export — see coding gaps). Validator `component.code minimum required` errors: 18→0.
- `status = "amended"` exactly on the two `EDITED_LINE`-populated rows; `final` elsewhere.
- `interpretation` "A" (Abnormal) on the single `ABNORMAL_C_NAME='Yes'` BP (142/74), matching the target.
- `category`, `code.text`, `subject`, `encounter.identifier`, `effectiveDateTime`, `issued`.

**Validator: 0 errors.** Remaining warnings are all acceptable: Epic OID terminology not loadable
(`urn:oid:…707679`), offline UCUM (`mm[Hg]`/`/min`/`cm`/`kg`), and the dom-6 narrative best-practice.
