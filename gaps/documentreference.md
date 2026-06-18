# DocumentReference — gaps

Target `fhir-target/DocumentReference.json` has **51** resources in three families:

| family | count | source | status |
|---|---|---|---|
| Clinical Notes (HNO) — html+rtf | 28 | `HNO_INFO` / `NOTE_ENC_INFO` | **PRODUCED** |
| Diagnostic imaging study — html | 3 | imaging `ORDER_PROC` reports | **DATA GAP** (not produced) |
| Summary Document (C-CDA) — application/xml | 20 | export-time generated C-CDA | **DATA GAP** (not produced) |

Generated: **39** (the 28 target clinical notes + 11 extra — see "Selection" below). All 28
target clinical notes are reproduced with matching shape; every remaining `<< MISSING`
path in `compare.ts` is one of the gaps below.

## Whole-family data gaps (not produced)

- **Summary Document (Encounter Summary ×19, Patient Summary ×1) — 20 resources, DATA GAP
  (confirmed absent).** These are C-CDA documents Epic *generates on the fly at export
  time*. Their identifier (`urn:ietf:rfc:3986` / `…688883.<n>`), the `Binary/fxsSefehhsab…`
  content URL, the generation `date`, and `context.period.end` (= the C-CDA coverage date,
  an export-time artifact) exist **nowhere in the EHI export**. Searched:
  `find-concept --grep '688883'` → no raw table; `find-concept 'ccda'` /
  `find-concept 'summary document'` → zero populated columns (only the empty
  `PROBLEM_TREAT_SUMM_HNO_ID.TX_SUM_HNO_ID`). There is no source row to drive them →
  producing them would require fabrication. Omitted by design.
  - Note: `context.period.end` and `identifier[].use='usual'` in the target appear **only**
    on these B/C families (per-family inspection: family A clinical notes carry no `use`
    and only `period.start`). They are fixed FHIR literals / export-time artifacts on B/C,
    not data gaps for the produced family-A resources.

- **Diagnostic imaging study — 3 resources, DATA GAP.** These wrap imaging `ORDER_PROC`
  reports (identifier system `…798268`, value = `ORDER_PROC_ID`; e.g. `439060613`,
  `1025926289`). Not produced because:
  - **Selection is not derivable.** The export holds 9 imaging orders (5 with a non-blank
    `ORDER_NARRATIVE`); the target publishes only 2 distinct ones (with `1025926289`
    appearing twice). Which imaging orders Epic surfaced as DocumentReferences — and the
    duplicate — is an Epic-publishing artifact absent from the export.
  - **`date` is proxy-only, not clean.** Target dates (`2020-07-29T15:30:00Z`,
    `2024-07-02T15:33:25Z`) do not match any `ORDER_PROC` time column
    (`ORDER_INST`, `RESULT_TIME`, `PROC_START_TIME`, …) under any single offset rule:
    e.g. `RESULT_TIME='7/2/2024 10:35:00 AM'` (10:35 CDT = 15:35Z) is ~2 min off and the
    target's `:25` seconds exceed the export's minute-rounded columns. A lossy proxy only.
  - **`Binary` content URL** and the **encounter `display`** ("Abstract", "Clinical Support")
    are also Epic-opaque / Epic-terminology (see encounter-display gap below).
  The structured imaging read text *is* reachable — `SELECT SUBSTR(NARRATIVE,1,80) FROM
  ORDER_NARRATIVE WHERE ORDER_PROC_ID IN ('439060613','1025926289')` →
  `'**THIS IS A SIGNED REPORT**'…` — and the identifier value = `ORDER_PROC_ID` itself —
  but body+id are delivered by the DiagnosticReport domain, not here, and the
  selection+date+URL remain non-derivable, so the whole family is not produced here.

## Selection gap on the produced clinical notes (count: 39 vs 28)

Epic emits a DocumentReference for a note only when its **note type is configured
"released to patient/FHIR"** — a build setting that is **not in the EHI export**. The
closest in-export signal is `NOTE_ENC_INFO.NOTE_SHARED_W_PAT_HX_YN = 'Y'` ("shared with
patient"), plus the always-released `Patient Instructions` note type. We therefore select
Signed/Addendum notes that have an exported body (RTF file, §14) **and** are either
shared-with-patient or `Patient Instructions`.

- This yields **39**, a superset of the 28 in the target snapshot. The **11 extra** notes
  (`2004599240, 4072496920, 4849833203, 5004998610, 5120148041, 5287990959, 5566703155,
  5568414328, 5570189143, 5706879826, 5908167612`) are *genuine* shared-with-patient signed
  notes (mostly Telephone Encounters) — they are not fabrications; the target snapshot simply
  omits them. No EHI column distinguishes the included 28 from these 11 (they interleave in
  date, type, status, author, encounter-in-scope). Reproducing exactly 28 would require the
  missing release-config, so we keep the honest, fully-derivable superset.

## Per-field coding gaps (datum text preserved; code lost)

All categorical codes in this export ship pre-resolved as `_C_NAME` text with **no `_C`
integer columns and zero `ZC_` tables** (general-patterns §23), so every Epic-terminology
*code* is unrecoverable. Text/display is preserved.

> **Searched (proof of code absence):**
> - Zero `ZC_` lookup tables: `SELECT name FROM sqlite_master WHERE name LIKE 'ZC[_]%'` → `[]`.
> - Zero bare `_C` integer code columns: iterate `pragma_table_info` across all tables for
>   any column whose name ends in `_C` (not `_C_NAME`) → `[]`. Only `*_C_NAME` text exists.
> - Note-type LOINC mapping: `find-concept --grep '34748-4|11506-3|34109-9'` → no raw table;
>   `SELECT LNC_CODE FROM LNC_DB_MAIN WHERE LNC_CODE IN ('34748-4','11506-3','34109-9')` → `[]`
>   (`LNC_DB_MAIN` holds only 27 lab LOINCs). Note-type LOINCs are not in the export.

- **`type.coding` (CODING GAP).** Target carries Epic note-type codes (systems
  `…737880.5010` and `…727879.69848980`, e.g. code `36`/`1`) **and** mapped LOINC
  (`34748-4`, `11506-3`, `34109-9`, with `userSelected`). The export has only the note-type
  **text** (`IP_NOTE_TYPE_C_NAME` / `NOTE_TYPE_NOADD_C_NAME`). We emit `type.text` only.
- **attester `mode.coding` (CODING GAP).** Target uses system `…696784.72072` code `1`
  (Signer) / `4` (Addendum/Transcription Authenticator). Derived from
  `NOTE_STATUS_C_NAME` text; the code is not in the export → `mode.text` only.
- **`context.extension` author-provider-type `.coding` (CODING GAP).** Target uses system
  `…836982.1040` (e.g. `1` Physician, `114` Medical Assistant, `2507` Clerk,
  `100` Occupational Therapist). Source is `AUTHOR_PRVD_TYPE_C_NAME` text only → text emitted.
- **`category` second coding (CODING GAP, families B/C only).** Target's Summary-Document
  rows add an `open.epic.com/...document-reference-category` coding; not applicable to the
  clinical notes we emit (those carry only the us-core `clinical-note` coding, which we
  reproduce exactly).

## Per-field data gaps on produced clinical notes

- **`content[].attachment.url` (DATA GAP — confirmed absent).** The actual note body is
  reached by the on-disk `raw/Rich Text/HNO_<NOTE_ID>_*.RTF` file (§14, the join key the
  generator already uses); the target's `Binary/<opaque-fhir-id>` reference is Epic's API
  resource handle. Searched: those opaque FHIR resource ids (notes family, plus B-imaging
  `Binary/ecFIzBdo…` and C-CDA `Binary/fxsSefehhsab…`) appear **nowhere** in the export
  (grep over `raw/EHITables` and raw files → no hit). Body content IS available; the URL
  is an API artifact → we emit `contentType` + `format` (html and rtf) and omit `url`.
- **`custodian.display` — RECOVERED.** The target custodian is `{identifier
  urn:ietf:rfc:3986 / "urn:ihs:ce-prd", display "UnityPoint Health"}`. The **display**
  `"UnityPoint Health"` IS in the export: `CLARITY_SA.EXTERNAL_NAME` (the institutional
  service-area customer-facing name). `SELECT SERV_AREA_ID, SERV_AREA_NAME, EXTERNAL_NAME
  FROM CLARITY_SA` → `SERV_AREA_ID=10, SERV_AREA_NAME='UNITYPOINT HEALTH SERVICE AREA',
  EXTERNAL_NAME='UnityPoint Health'`; it is the **only** non-blank `EXTERNAL_NAME` in the
  export (so unambiguously the single org display). We now emit
  `custodian = {display: "UnityPoint Health"}` sourced from `CLARITY_SA.EXTERNAL_NAME`.
- **`custodian.identifier` (DATA GAP — confirmed absent).** The paired
  `{system urn:ietf:rfc:3986, value "urn:ihs:ce-prd"}` is a Care-Everywhere/HIE
  publishing identifier that exists **nowhere** in the export. Searched:
  `find-concept --grep 'ce-prd|ce_prd|ce:prd|urn:ihs|:ihs:'` and direct
  `grep -riE 'ce-prd|urn:ihs' raw/EHITables/` → **zero hits**;
  `find-concept 'care everywhere'` yields only `DOC_INFORMATION` CE dates and
  `REFERRAL_2` CE flags, no org identifier. Omitted (display-only custodian) rather
  than fabricated.
- **`context.encounter[].display` (DATA GAP — confirmed absent).** The encounter-type
  label ("Office Visit", "Telephone", "Telemedicine", "Results Follow-Up", …) is an
  Epic-assigned encounter-type display present **nowhere** in the export (same gap the
  Encounter domain documents for `class`). Searched: iterated all 1858 `*_C_NAME` columns —
  **none** equals `'Office Visit'`; `PAT_ENC` has no `ENC_TYPE` column; value-scan
  `grep -E 'Office Visit|Telemedicine|Results Follow-Up|Hospital Outpatient Visit'` hits
  only `DOC_INFORMATION.DOC_DESCR` (free-text scanned-doc descr, no join to note CSNs),
  `PAT_ENC_HSP.ADT_PATIENT_STAT_C_NAME` (patient status, coincidental), and `MSG_TXT`
  (narrative) — no encounter-type label keyed by these notes' CSNs. We emit the encounter
  `reference` + CSN `identifier`; display omitted.

## Precision (not a data gap, but values differ)

- **Sub-minute timestamps lost.** `date`, attester `time`, `authenticator` instant, and
  `context.period.start` come from the export's `*_DTTM` columns (UTC), which the EHI
  **rounds to the minute** (e.g. `8:12:00 PM`). The target FHIR carries seconds
  (`…20:12:38Z` vs our `…20:12:00Z`). The path is present and the minute is correct; only
  the seconds differ.
- **Practitioner display name.** We use the export's `AUTHOR_USER_ID_NAME`
  (e.g. `"YOUNG, JESS"`); the target shows Epic's de-identified scrambled form
  (`"Jess Y"`). Same de-identification difference the Practitioner domain notes.
