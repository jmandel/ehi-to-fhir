# Observation (category = survey) — reconstruction gaps

Source: `IP_FLWSHT_MEAS` (FSD_ID, LINE) + `V_EHI_FLO_MEAS_VALUE` (the value; §47)
+ `IP_FLWSHT_REC` → `PAT_ENC` (encounter/CSN) + `CLARITY_EMP`/`CLARITY_SER`
(performer) + `ARPB_TRANSACTIONS`/`CLARITY_EAP` (encounter type label).
See clinical-area guides `vitals-and-flowsheets.md` (gotchas 8–10) and
`questionnaires-and-assessments.md` (gotcha 8: screening instruments double-file
into flowsheets, where the scored values live).

Target survey Observations = **132**. Generated = **57**. Validator: **0 errors**
(warnings are offline-terminology + dom-6 narrative + Epic-proprietary-system only).

> **Falsifiability note (audited 2026-06).** Every "absent" claim below is paired with
> the exact whole-export search that proves it — `bun tools/find-concept.ts "<term>"`
> (schema: column name/desc) and `... --grep '<regex>'` (value scan over every
> `raw/EHITables/*.tsv`), plus a confirming `bun lib/q.ts` probe. A re-auditor can re-run
> these verbatim. No field below was asserted absent on a single-column/single-table look.

## Scope / category-assignment assumption (mapping rule — EHI-underivable)
- **Which `FLO_MEAS_ID`s are `category=survey` is an irreducible mapping assumption,
  not a value read from the export.** No flowsheet column carries a template/category/
  "is-survey" signal: across the entire flowsheet family — `IP_FLWSHT_MEAS`
  (incl. `FLT_ID` flowsheet-template id and `FLO_MEAS_ID`), `IP_FLOWSHEET_ROWS`,
  `IP_FLO_GP_DATA` (just `FLO_MEAS_ID`→`DISP_NAME`), `IP_FLWSHT_REC`, `FLWSHT_SINGL_COL`,
  `V_EHI_FLO_MEAS_VALUE` — there is **no field that classifies a measure as survey vs.
  vital-sign vs. anything else.** That classification lives only in Epic's
  flowsheet→FHIR build. Consequently the membership of `SURVEY_MEAS`
  (`src/obs-survey.ts`) — i.e. the **set** of measure-type ids treated as survey —
  was necessarily determined by inspecting the target, and is target-informed rather
  than EHI-derived.
  - **Proof of absence (re-runnable):** `bun lib/q.ts "SELECT name FROM
    pragma_table_info('IP_FLWSHT_MEAS')"` exposes only `FLT_ID`/`FLO_MEAS_ID` —
    no category/profile/template-type column. `bun lib/q.ts "SELECT name FROM
    pragma_table_info('IP_FLOWSHEET_ROWS')"` = `INPATIENT_DATA_ID, LINE,
    FLO_MEAS_ID_DISP_NAME, FLO_MEAS_ID, FLOWSHT_ROW_NAME, IP_LDA_ID,
    ROW_VARIANCE_C_NAME` — no is-survey signal. `bun tools/find-concept.ts
    "survey category"` returns no flowsheet column.
- The selection is principled by **instrument**, not cherry-picked per record: the set
  is the recognized screening-instrument measure types — PHQ-2 items/totals (incl.
  retired variants), Depression Screening Adult, AUDIT-C items/score, and the
  survey-classed weight-change / BSA calcs — keyed on `FLO_MEAS_ID` (a measure TYPE),
  never on per-row `FSD_ID`/`LINE`. It functions like a category-mapping rule / a
  translation map keyed by measure type, not as copied patient data.
- **No clinical datum is lifted from the answer.** Every emitted value is read from the
  EHI at runtime: code = `FLO_MEAS_ID`, display = `FLO_MEAS_ID_DISP_NAME`, value =
  `MEAS_VALUE_EXTERNAL`, units = `UNITS`, time = `RECORDED_TIME`/`ENTRY_TIME`,
  performer = `TAKEN_USER_ID_NAME`→`CLARITY_SER`. The only target-informed element is
  the survey/non-survey partition itself, disclosed here.

## Count / structure gap (DATA gap — Epic-synthesized, not in export)
- **75 of the 132 are GROUP / panel / header rows that do not exist as data in the
  EHI.** Breakdown of the missing 75: 39 panel observations (`hasMember`) — "Height
  and Weight" (18), the "PHQ-2:" / "PHQ:" / "PHQ-2 Teen:" / "PHQ Depression - START
  HERE" question-group headers (19), "Alcohol Use" (1), "AUDIT Alcohol Screening"
  (1); and 36 contentless group observations — "Vitals" (18), "Vital Signs" (9),
  "Completed Tasks" (9). Most of these display strings ("Vitals", "Vital Signs",
  "Height and Weight", "Completed Tasks", "PHQ:", "PHQ Depression - START HERE",
  "PHQ-2 Teen:") are **not** present in `IP_FLO_GP_DATA`, `IP_FLOWSHEET_ROWS`, nor as
  `IP_FLWSHT_MEAS` rows. **Correction (verified 2026-06):** the one panel header
  "PHQ-2: Over the last 2 weeks…" (`FLO_MEAS_ID = 16751`) *is* present in
  `IP_FLO_GP_DATA` AND in `IP_FLOWSHEET_ROWS` (the per-`INPATIENT_DATA_ID` row layout) —
  contradicting the earlier blanket "not in IP_FLO_GP_DATA" wording. It nonetheless has
  **no `IP_FLWSHT_MEAS` measurement row** (it is a container, carries no value), so it
  still cannot be emitted as a value-bearing leaf Observation. These remain flowsheet
  *layout containers* / FHIR-only grouping rows materialized by Epic's flowsheet→FHIR
  build, not measurements. Unreachable as data rows; we emit only the 57 value-bearing
  leaf measurements the EHI actually backs.
  - **Proof (re-runnable):** `bun lib/q.ts "SELECT FLO_MEAS_ID, FLO_MEAS_ID_DISP_NAME,
    COUNT(*) FROM IP_FLWSHT_MEAS WHERE FLO_MEAS_ID_DISP_NAME LIKE 'PHQ%' OR LIKE
    'Vital%' OR LIKE '%Height and Weight%' OR LIKE '%Completed Tasks%' GROUP BY
    FLO_MEAS_ID"` returns **only** the four value-bearing `PHQ-2 Total Score` leaves
    (16752, 28282, 5856, 7914) — **no** "Vitals"/"Vital Signs"/"Height and
    Weight"/"Completed Tasks"/"PHQ-2:" header has a measurement row. The 75 group rows
    have no `IP_FLWSHT_MEAS` spine row, so there is no time/CSN/value to land them on.
- Consequently **`hasMember`** (39 in target) and **`derivedFrom`** (21) — the
  panel↔member and item↔derived-row wiring — are unreproducible: that graph is
  defined in Epic's flowsheet config, not in any export key.
  - **Proof (re-runnable):** `bun lib/q.ts "SELECT name FROM
    pragma_table_info('IP_FLOWSHEET_ROWS')"` shows **no** parent/child/level/indent/
    row-type column — only an ordered `LINE` and `ROW_VARIANCE_C_NAME` (whose only
    value is `Add`). The nesting that would yield hasMember/derivedFrom is layout
    ordering, not an explicit key; and the target's references are opaque encrypted
    Epic FHIR ids (`Observation/eB1to19IO…`) that cannot be reconstructed from
    `FSD_ID`/`LINE`. We emit neither rather than fabricate a non-deterministic graph.

## Coding gaps (code/system lost; text/value preserved)
- **`code.coding.code` is the encrypted Epic FHIR flowsheet id** (e.g.
  `t6DwMLubUoxrEmB5L9QfG.A0`). The export carries only the numeric `FLO_MEAS_ID`
  (e.g. `2100100050`, `16752`). We emit the **real numeric FLO_MEAS_ID** under the
  same `observation-flowsheet-id` system — an honest export id, not Epic's encrypted
  rendering of it. System path matches; the code *value* differs by design.
- **`code.coding[].system = http://loinc.org`** (60 of 132 target codes carry a LOINC
  alongside the flowsheet id — e.g. PHQ items 44250-9 / 44255-8, AUDIT-C 75626-2,
  BSA 3140-1). The LOINC mapping of a flowsheet measure lives in Epic's flowsheet
  build; it is **not in the export** (`IP_FLO_GP_DATA` has no LOINC column, and the
  export ships no `LNC_DB_MAIN`-style flowsheet crosswalk). Omitted, not fabricated.
  - **Proof (re-runnable):** `bun tools/find-concept.ts "LOINC"` lists only
    lab-result LOINC tables — `LNC_DB_MAIN` (27 rows: cholesterol/electrolytes/HepC,
    no PHQ/AUDIT/BSA), `ORDER_RESULTS`, `ORDER_PROC_4` — **no** flowsheet table carries
    a LNC/LOINC column. Value scan `bun tools/find-concept.ts --grep
    '4425[0-9]-[0-9]|75626-2|3140-1'` = **0 tables** (none of PHQ 44250-9/44255-8,
    AUDIT-C 75626-2, BSA 3140-1 occurs in any raw TSV).
- **`valueCodeableConcept.coding[].system = http://loinc.org`** with LA answer codes
  (LA6568-5 "Not at all", LA6270-8 "Never", …). The export stores the answer as its
  bare value — `MEAS_VALUE_EXTERNAL` = `"0"`/`"1"` (PHQ Custom List) or `"NEVER"`
  (AUDIT Category Type) — with **no** LA code and **no** proper-case label. We emit
  `valueCodeableConcept.coding.code` = the raw value, `display`/`text` = the same raw
  value. The LOINC LA answer code and the human label ("Not at all", "Never") are
  Epic-build terminology, absent here. (Exception: `28385` "Depression Screening
  Adult" stores the label itself — `"PHQ-2 Brief Screen"` — and reproduces exactly.)
  - **Proxy note (verified 2026-06): the proper-case answer *labels* DO exist** in
    `V_EHI_HQA_QUEST_ANSWER.QUEST_ANSWER_EXTERNAL` — this patient's PHQ history
    answers are stored there verbatim as `"Not at all"`, `"Several days"`, etc.
    (alongside numeric `"0"`/`"1"` lines). HOWEVER this is a **separate questionnaire
    (HQA) response store keyed by `ANSWER_ID`/`LINE`**, and the export ships **no
    usable join** from those `ANSWER_ID`s to the flowsheet survey rows or their
    encounters: `PAT_ENC_QNRS_ANS` (the encounter↔answer bridge) ships only
    `PAT_ENC_CSN_ID`/`LINE`/`CONTACT_DATE` — its `ANSWER_ID` column is empty — and
    `CL_QANSWER` exposes no CSN/PAT/FLO key. So the HQA labels cannot be
    deterministically aligned to a given `(FSD_ID, LINE)` survey Observation; treating
    them as the answer text would be a guess. The LOINC **LA answer codes**
    (LA6568-5, …) remain absent everywhere (no `LA####-#` value occurs in any raw
    table). Left as the raw flowsheet value, not back-filled from HQA.
    - **Proof (re-runnable):** LA codes — `bun tools/find-concept.ts --grep
      'LA[0-9]{4}-[0-9]'` = **0 tables**. Broken join — `bun lib/q.ts "SELECT * FROM
      PAT_ENC_QNRS_ANS LIMIT 1"` returns only `PAT_ENC_CSN_ID, LINE, CONTACT_DATE`
      (the `ANSWER_ID` bridge column is stripped from this view), and `bun lib/q.ts
      "SELECT name FROM pragma_table_info('CL_QANSWER')"` exposes **no** CSN/PAT/
      FLO_MEAS/encounter key (only `ANSWER_ID` + audit cols + `PARENT_ANSWER_ID`).
      So `V_EHI_HQA_QUEST_ANSWER.QUEST_ANSWER_EXTERNAL` labels cannot be aligned to a
      `(FSD_ID,LINE)` flowsheet survey row. Wiring them in would be a guess → not done.

## us-core category gap (DATA gap — not in export)
- **The us-core sub-categories** `disability-status`, `functional-status`, `sdoh`
  (system `…/us-core/CodeSystem/us-core-category`) appear on most target survey
  obs in varying combinations. Which flowsheet measure maps to which us-core
  category is an Epic FHIR profiling decision with **no backing column** in the
  export. We emit only the base `survey` category and omit the unrecoverable
  sub-categories rather than guess them.
  - **Proof (re-runnable):** `bun tools/find-concept.ts "functional status"` = **0
    populated columns**. `bun tools/find-concept.ts "disability"` hits **only** claim/
    workers-comp tables (`CLM_VALUES_3.DISABILITY_QUAL`, `CLAIM_INFO.DISABILITY_*`) —
    unrelated to any flowsheet survey row. The genuine SDOH-domain Observation set
    (`SDD_DATA`/`SDD_ENTRIES`/`V_EHI_SDD_ENTRY_INTERPRETATION`: Internet Access,
    Educational Attainment, Utilities) is a **separate** Observation domain that does
    not overlap the 132 flowsheet survey rows (which are all PHQ/AUDIT/Vitals/
    Height-Weight/weight-change). No flowsheet column maps a measure to
    disability-status/functional-status/sdoh.

## Value-shape note (data preserved; differs from target only where Epic recoded)
- `valueQuantity` / `valueString` / `valueCodeableConcept` are selected from
  `VALUE_TYPE_C_NAME` (Numeric Type / String Type / Custom List | Category Type) and
  match the target 1:1 on every value path (counts identical). `valueQuantity.unit`
  is the verbatim `UNITS` column; UCUM `system`/`code` are emitted **only** for
  `UNITS = '%'` (the one case the target codes in UCUM) — never invented for the
  bare-string units ("sq meters", "KG", "Grams").

## Display-value gaps (path present, value approximate)
- **`encounter.display`** target = the Epic ENC_TYPE label ("Office Visit",
  "Telemedicine"). `ENC_TYPE_C` is not exported (confirmed: no encounter-type column
  in the `PAT_ENC` family). We substitute the real E&M / visit *charge* name from
  `ARPB_TRANSACTIONS`→`CLARITY_EAP` (e.g. "PR PREVENTIVE VISIT,EST,18-39") — a true
  EHI label, but not the same string.
  - **Proof (re-runnable):** `bun lib/q.ts "SELECT name FROM pragma_table_info('PAT_ENC')
    WHERE name LIKE '%TYPE%'"` = only `HOSP_ADMSN_TYPE_C_NAME, CONSENT_TYPE_C_NAME` —
    no visit/encounter-type label. `bun tools/find-concept.ts "encounter type"` finds
    `ENC_TYPE_C`-style columns **only** as empty/not-shipped (`PAS_TRIAGE_HX`,
    `PYR_FEEDBACK`, `SC_EPISODE_EXTERNAL_ENC`) or referral-scoped
    (`REFERRAL_2.RFL_ENC_TYPE_C_NAME`, inpatient/outpatient, not the visit label). The
    "Office Visit"/"Telemedicine" string is not exported for these encounters.
- **`performer.display`** target = an Epic de-identified scramble ("Tracy I"). We
  emit the real `TAKEN_USER_ID_NAME` ("IRELAND, TRACY C"). `performer.reference`
  resolves via `TAKEN_USER_ID` (EMP) → name → `CLARITY_SER.PROV_ID` (`prac-<id>`);
  patient-reported (`MYCHARTG`) and unmatched names get display-only, mirroring the
  target's reference/no-reference split.
- **`issued`** is from `ENTRY_TIME`, which has only minute resolution in the export;
  the target's sub-minute seconds (e.g. `…:49:11Z`) are not recoverable, so `issued`
  lands on `:00` seconds. `effectiveDateTime` (from `RECORDED_TIME`, also minute
  resolution, converted America/Chicago → UTC) matches the target exactly.
  - **Proof (re-runnable):** `bun lib/q.ts "SELECT COUNT(*) FROM IP_FLWSHT_MEAS WHERE
    RECORDED_TIME NOT LIKE '%:00 %'"` = **0**, and the same filter on `ENTRY_TIME`
    yields no non-`:00` rows — every flowsheet timestamp is minute-resolution
    (seconds always `00`). Sub-minute precision is not stored on the spine.
