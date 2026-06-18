# Portability Audit — EHI→FHIR baseline pipeline

**Scenario:** a NEW patient at a DIFFERENT Epic healthcare org is loaded into a fresh
`ehi.sqlite` (same Epic product + EHI export schema; different ORG instance — different
instance OID, possibly different timezone, different SER/dept/coverage ids, org-custom
flowsheet measures, possibly a thinner shipped-table subset). Build runs the BASELINE
pipeline only: `bun build.ts` (no `--answer-key`, no crosswalk/apply-answer-key, no
`fhir-target/`).

**Question answered:** where do the generators emit WRONG data, silently-EMPTY data, or
BREAK — and how feasibly portable is each issue?

Two classification axes are used throughout:

- **SEVERITY:** CRITICAL-WRONG · CRITICAL-EMPTY · FRAGILE · LIMITATION · SAFE
- **PORTABILITY TIER (who it breaks for):** PATIENT-SPECIFIC (any new patient) ·
  ORG-INSTANCE (a different Epic org) · EPIC-PRODUCT-STABLE (all Epic orgs — acceptable) ·
  NON-EPIC (out of scope).

---

## 1. Executive summary

Two headline blockers dominate the entire audit.

**Blocker A — the PATIENT anchor (PATIENT-SPECIFIC; breaks EVERY new patient).**
`lib/ids.ts:12` hardcodes `PATIENT_PAT_ID = "Z7004242"`, the specimen patient's `PAT_ID`,
and derives `PATIENT_ID = "pat-Z7004242"` from it. This single constant is the project-wide
patient identity. It feeds `patientDisplay()` (the name on every `patientRef()`) and is
bound as the `WHERE PAT_ID = ?` parameter in ~36 query sites across 8+ generators
(patient, allergy, immunization, obs-vitals, coverage, coverageeligibility, account,
location-org). For a new patient this `PAT_ID` does not exist in the fresh DB, so:
`patient.ts:129` does `q1(...)!` (non-null assertion) and **throws**, breaking the build at
import; allergy/immunization/obs-vitals emit **empty** shards; account/coverage drop
subject/guarantor/member; and `location-org.ts` fails to derive the facility Organization
(`PAT_PRIM_LOC WHERE PAT_ID=...`), dangling `invoice.issuer` /
`chargeItem.performingOrganization` / `account.owner`. **Nothing about the value is
derived** — it is a baked literal. The fix is one change: derive it at runtime
(`SELECT PAT_ID FROM PATIENT` on the single-patient export, env-overridable). All ~36 call
sites already import the one symbol, so deriving it once makes the whole pipeline
patient-agnostic with no generator edits.

A second PATIENT-SPECIFIC blocker rides alongside it: `coverageeligibility.ts:67`
hardcodes `COVERAGE_ID = "5934765"` (this patient's only coverage). It is used to look up
the insurer payor AND as the `Coverage/cov-5934765` reference on **every** insurance block
of **all ~21** CoverageEligibilityResponses. For a new patient that coverage id never
exists: the insurer resolves `undefined`, and every reference dangles (coverage.ts emits
the new patient's `cov-<id>`, not `cov-5934765`). Must be derived from the export.

**Blocker B — the ORG-INSTANCE OID + timezone hardcodes (breaks at a DIFFERENT Epic org).**
The Epic instance OID prefix `urn:oid:1.2.840.114350.1.13.283.*` (where **`.283` is THIS
org's instance id**) is scattered as **~49+ raw literals across 18 src files** with **no
central constant**. Values stay real (they come from the DB), but every emitted
`identifier.system` / Epic-local `code.system` asserts the **wrong org's namespace** at a
different instance — CRITICAL-WRONG for the identifier/coding systems. **Derivability:**
confirmed NOT derivable — a brute-force scan of every table/column found no string
containing `1.2.840.114350.1.13.283` (IDENTITY_ID_TYPE carries only numeric type ids;
CLARITY_SA ships org names, not OIDs; the lone `1.2.840.114350.*` value is a DICOM study
UID with a different `.2.92` structure). So it must remain **external config**, but
**centralized + env-overridable**, turning a new org into ONE edit instead of 49.

The org **timezone (`America/Chicago`)** is hand-rolled — with US-DST logic — in **5
generators** (encounter, obs-vitals, obs-survey, obs-social, communication), and is
**inconsistent in-repo**: encounter.ts uses Central while allergy.ts bakes a fixed
US-Eastern `-5` (no DST) for the SAME specimen. At a different-tz org every converted
instant (`Encounter.period`, vital/survey/social `effectiveDateTime`/`issued`,
`Communication.sent`, `AllergyIntolerance.recordedDate`) is shifted by hours — CRITICAL-WRONG
values. The export carries paired `*_UTC_DTTM` columns for many events, so the right fix is
one shared time helper that prefers an explicit UTC sibling column (truly derived) and
otherwise applies a single configurable org offset.

### Bottom line

**(a) Would a fresh SAME-org patient build correctly?** Almost — but **not without one
fix**. The OID prefix and timezone are same-org-stable, but the patient-specific anchors
still break: `PATIENT_PAT_ID` and `COVERAGE_ID` are baked to THIS patient, not derived.
`patient.ts:129`'s non-null assertion throws on any non-matching `PAT_ID`. **MUST FIX for
same-org reuse:** derive `PATIENT_PAT_ID` (one line) + derive `COVERAGE_ID`. After that, a
same-org patient builds correctly.

**(b) Would a DIFFERENT-org patient build correctly?** No. On top of (a) you must:
(1) **centralize the `.283` instance OID** to one config constant (mechanical, ~49 sites);
(2) **centralize the timezone** to one configured zone + shared helper (prefer `*_UTC_DTTM`
columns); (3) **add `tableHasRows()`/`columnsOf()` guards** on optional-table reads
(meds/labs/obs-vitals/obs-survey have none → a thinner table subset hard-crashes
`bun build.ts` at query time); (4) re-derive a handful of baked org ids (`SERV_AREA_ID '18'`,
`MINTED_ORG_SERV_AREAS {"18"}`). The org-custom flowsheet measure ids and the vocab
crosswalk are accepted limitations (incomplete, not wrong — see §6).

---

## 2. Severity × Portability-tier matrix

Counts are of the de-duplicated, distinct findings below (the `PATIENT_PAT_ID` finding was
reported 5× by different auditors and is counted once).

| SEVERITY \ TIER     | PATIENT-SPECIFIC | ORG-INSTANCE | EPIC-PRODUCT-STABLE | NON-EPIC | Total |
|---------------------|:---:|:---:|:---:|:---:|:---:|
| **CRITICAL-WRONG**  | 2 | 9 | – | – | **11** |
| **CRITICAL-EMPTY**  | 4 | 1 | – | – | **5**  |
| **FRAGILE**         | 2 | 6 | 14 | – | **22** |
| **LIMITATION**      | – | 5 | 8 | 2 | **15** |
| **SAFE**            | – | 11 | 18 | 4 | **33** |
| **Total**           | **10** | **32** | **40** | **6** | **88** |

Reading the matrix:
- **All CRITICAL findings are either PATIENT-SPECIFIC (6) or ORG-INSTANCE (10).** None are
  EPIC-PRODUCT-STABLE — i.e. nothing CRITICAL breaks for all Epic orgs; everything CRITICAL
  is fixable by deriving the patient + centralizing org config.
- The **6 PATIENT-SPECIFIC criticals collapse to 2 root causes**: `PATIENT_PAT_ID` and
  `COVERAGE_ID`.
- The **10 ORG-INSTANCE criticals collapse to 2 root causes**: the `.283` OID prefix and
  the hardcoded timezone.
- **EPIC-PRODUCT-STABLE + SAFE (~58)** are the legitimate constants (FHIR system URIs,
  `*_C_NAME` enum→standard-code maps, Epic-released measure ids) and rule-driven selection —
  acceptable, listed only representatively.

---

## 3. CRITICAL — PATIENT-SPECIFIC (fix for ANY reuse, same-org or cross-org)

| file:line | severity | title | why it breaks | fix (kind) |
|---|---|---|---|---|
| `lib/ids.ts:12-13` | CRITICAL-WRONG | `PATIENT_PAT_ID="Z7004242"` is the whole-pipeline patient identity | Baked specimen `PAT_ID`; bound as `WHERE PAT_ID=?` in ~36 sites across 8 generators + drives `patientDisplay()`/`PATIENT_ID`. New patient → throws (patient.ts:129 `!`) or empty shards everywhere. Not derived. | **Derive-from-export:** `PATIENT_PAT_ID = process.env.EHI_PAT_ID ?? q1('SELECT PAT_ID FROM PATIENT LIMIT 1').PAT_ID`; guard 0/>1 rows. One change fixes all consumers. |
| `src/patient.ts:129` | CRITICAL-EMPTY | Non-null assertion on PATIENT row throws | `const p = q1(...WHERE PAT_ID=?, PATIENT_PAT_ID)!` — for a non-matching id `q1` returns undefined and property access throws, killing the build at import. | Resolves once PAT_ID is derived; defensively replace `!` with an explicit "no PATIENT row" error. (centralize via ids.ts) |
| `src/coverageeligibility.ts:67,115,270` | CRITICAL-WRONG | `COVERAGE_ID="5934765"` hardcoded | Used for insurer payor lookup AND as `Coverage/cov-5934765` ref on every insurance block of all ~21 resources. New patient → insurer `undefined` + dangling refs (coverage.ts emits the new patient's `cov-<id>`). | **Derive-from-export:** resolve `COVERAGE_ID` per BENEFITS record (CVG_ID/CVG_FOR_SVC_TYPE_ID) or the patient's single COVERAGE row. |
| `src/obs-vitals.ts:138,142-143` | CRITICAL-EMPTY | Vitals query filters `r.PAT_ID = PATIENT_PAT_ID` | Only obs shard that bakes the anchor (survey/social auto-follow the single-patient export). New patient → vital-signs shard silently empty. | Resolves once `PATIENT_PAT_ID` is derived. (centralize via ids.ts) |
| `src/account.ts:56,158-165` | CRITICAL-EMPTY | Account subject/guarantor gated to `PATIENT_PAT_ID` | `ACCT_GUAR_PAT_INFO ... AND PAT_ID=?` → empty for new patient → subject + guarantor dropped from every Account. | Resolves once PAT_ID derived. (centralize via ids.ts) |
| `src/location-org.ts:33,144,147` | CRITICAL-EMPTY | Facility Organization derivation hinges on `PATIENT_PAT_ID` via `PAT_PRIM_LOC` | New patient → `facSa` undefined → facility Organization NOT emitted → `invoice.issuer`, `chargeItem.performingOrganization`/`costCenter`, `account.owner` all dangle (`org-18` missing). High blast radius. | Resolves once PAT_ID derived; org-derivation logic itself is DB-derived and fine. (centralize via ids.ts) |
| `src/coverage.ts:51,89-97` | FRAGILE→empty | Covered-member row gated to `PATIENT_PAT_ID`, then `[0]` | `COVERAGE_MEMBER_LIST ... AND PAT_ID=?` → `mem` undefined → subscriberId/relationship/period silently drop (coverage row still emits). | Resolves once PAT_ID derived; `[0]` single-member assumption acceptable (document). |

> `patientDisplay()` (ids.ts:72,85) and the meds/labs/servicerequest `patientRef()` subjects
> are the same root cause — they inherit the anchor and become correct automatically once
> `PATIENT_PAT_ID` is derived. No separate fix.

---

## 4. CRITICAL / ORG-INSTANCE (fix for cross-org portability)

### 4a. The `.283` Epic instance OID prefix — the dominant cross-org issue

**What's hardcoded:** `urn:oid:1.2.840.114350.1.13.283.*` literals (the `.283` segment is
THIS org's Epic instance id) on `identifier.system` and Epic-local `code.system` values.
**Blast radius:** ~49+ literals across 18 src files. **Derivability:** NOT derivable from
the export (verified by brute-force scan; no OID-carrying column). **Fix (all the same):**
add one `EPIC_INSTANCE_OID` constant (env-overridable) + an `epicOid(suffix)` helper in
`lib/ids.ts`, rewrite every literal to compose from it → a new org becomes ONE edit. This is
**centralize-constant on top of needs-external-config**.

| file:line | what it stamps |
|---|---|
| `src/patient.ts:52-58,621` | EPI/EXTERNAL/WPRINTERNAL/IHSMRN/MRN identifier OIDs + legal-sex VS system (6+) — CRITICAL-WRONG |
| `src/encounter.ts:48-50` | SYS_CSN / SYS_REASON / SYS_HSP_ACCT — CRITICAL-WRONG |
| `src/condition.ts:31` | CSN_OID encounter-identifier system (must stay in sync with encounter.ts SYS_CSN) — CRITICAL-WRONG |
| `src/immunization.ts:39-40` | SYS_IMM / SYS_ENC — CRITICAL-WRONG |
| `src/obs-vitals.ts:47-48` | SYS_FLO (vitals code.system, every vital + both BP components) / SYS_ENC — CRITICAL-WRONG |
| `src/obs-survey.ts:43` | SYS_CSN encounter identifier — CRITICAL-WRONG |
| `src/obs-smartdata.ts:59` | SDI_OID concept code.system — latent (dormant unless table ships) — LIMITATION |
| `src/medication.ts:26-32` | SYS_ORDER/SYS_DRUG/SYS_ENC/SYS_FORM (4) — FRAGILE (namespace mislabel) |
| `src/lab.ts:48-60` | placer/filler/spec-id/enc/cat-epic/compon (7) — FRAGILE |
| `src/servicerequest.ts:28-29` | SYS_PLACER/SYS_ENC (2; must stay byte-identical to lab.ts) — FRAGILE |
| `src/practitioner.ts:48-54` | SER/EMP/CCPROVID/EMP_LOGIN/NPI-root/TAXONOMY-root (6, densest cluster) — SAFE-noted |
| `src/documentreference.ts:72-82` | SYS_NOTE/NOTE_OID_TAIL/SYS_CSN/SYS_PROV_TYPE/SYS_ORDER_PLACER (5) — SAFE-noted |
| `src/coverage.ts:64-65` | OID_COVERAGE / OID_PLAN (2) |
| `src/chargeitem.ts:59-60` | OID_ETR / OID_EAP (2) |
| `src/coverageeligibility.ts:63` | OID_BENEFITS (1) |
| `src/account.ts:75` | SYS_HSP_ACCT (1) |
| `src/eob.ts:64` | OID_INVOICE (1) — **reconcile:** claim.ts deliberately uses a project-local `urn:ehi:epic:*` URI for the same data; eob.ts should match it |
| `src/paymentrecon.ts:71` | OID_REMIT_IMAGE (1) |
| `src/communication.ts:58` | OID_MYC_MESG (1) |

> Several literals are **duplicated** across files (SYS_CSN/SYS_ENC in encounter/condition/
> obs/documentreference; SYS_PLACER in lab/servicerequest). Centralizing also removes the
> drift hazard between basedOn-linked resources.

### 4b. Hardcoded timezone (`America/Chicago`) — CRITICAL-WRONG values at a different-tz org

| file:line | what's wrong |
|---|---|
| `src/encounter.ts:62-93` | `chicagoToISO()`/`chicagoOffsetHours()` convert PROV_START/HOSP_ADMSN/HOSP_DISCH to UTC instants — wrong at non-Central org |
| `src/obs-vitals.ts:92-119` | `localToUtcInstant`/`chicagoOffsetHours` on RECORDED/ENTRY_TIME |
| `src/obs-survey.ts:131-162` | `centralToUTC`/`isUSDST` (2nd independent copy) |
| `src/obs-social.ts:52-78` | `centralMidnightToUtc`/`isCentralDST` (3rd copy; comment pins expected values to Central) |
| `src/communication.ts:71-102,368` | `chicagoToISO()` for `Communication.sent` — the clearest "wrong VALUE" case |
| `src/allergy.ts:28-47` | bakes fixed US-Eastern `-5` **no DST** for `recordedDate` — **inconsistent with encounter.ts**; wrong zone AND wrong by an hour in summer even within Eastern |

**Derivability:** the org tz is not in a per-row column; `lib/db.ts:55-70` `parseEpicDateTime`
intentionally returns a floating local datetime, pushing the assumption downstream. **Fix
(centralize + derive-where-possible):** one shared `lib/time.ts` helper that (1) prefers an
explicit `*_UTC_DTTM` sibling column when present (truly org-independent — the export carries
many: ORDER_MED_5, ORDER_PROC_5/6, PAT_ENC_HSP_2, ORDER_PROC_6 PRIORITIZED), and (2) else
applies `process.env.EHI_TZ ?? 'America/Chicago'` via a real tz library. Replaces 5–6
hand-rolled DST routines with one. (`lab.ts:105-119` is the model — it derives the offset
per-order from the local/UTC pair and prefers the genuine UTC column; only its naive+`Z`
fallback when the pair is absent is a minor risk.) Good counter-models: `careplan.ts` and
`coverageeligibility.ts` emit **date-only** and refuse to assert a tz.

### 4c. Baked org ids + other ORG-INSTANCE criticals

| file:line | severity | issue | fix |
|---|---|---|---|
| `src/patient.ts:591` | CRITICAL-EMPTY | `managingOrganization` hardcoded to `CLARITY_SA WHERE SERV_AREA_ID='18'` (= 'MAC ASSOCIATED PHYSICIANS LLP', this org). New org may lack 18 → omitted, or 18 → wrong org. | **Derive-from-export:** facility SA from the patient's dept/PCP or dominant DEPARTMENT_ID's SERV_AREA_ID; else one config constant. |
| `src/encounter.ts:62-93` | CRITICAL-WRONG | (timezone — see 4b) | see 4b |

---

## 5. FRAGILE and LIMITATION findings

### 5a. FRAGILE — structural assumptions that may not hold on different-but-valid data

| file:line | tier | issue | fix |
|---|---|---|---|
| `medication.ts:227-271`, `lab.ts` (all queries), `servicerequest.ts`, `obs-vitals.ts`, `obs-survey.ts` | EPIC-PRODUCT-STABLE | **No `tableHasRows()`/`columnsOf()` guards** — query a missing table → `bun build.ts` **hard-crashes** at module load on a thinner export subset (LEFT JOINs tolerate empty-but-present; absent tables are fatal). | Guard optional-table reads with `tableHasRows()`; treat absent as no-rows. obs-smartdata.ts is the model (gates on tableHasRows + columnsOf). High value. |
| `encounter.ts:111-128` | EPIC-PRODUCT-STABLE | `selectCsns` (good rule) joins PAT_ENC_HSP/DISP/RSN_VISIT, HNO_INFO unguarded | tableHasRows guards |
| `condition.ts:157-173,229-262` | EPIC-PRODUCT-STABLE | rule-driven (good) but PROBLEM_LIST_HX/PAT_PROBLEM_LIST/ORDER_PROC/HNO_INFO unguarded | tableHasRows guards |
| `obs-vitals.ts:80,137,141` | ORG-INSTANCE | vitals selected by display-string literal `FLT_ID_DISPLAY_NAME='Encounter Vitals'` — renamed/split template → **entire vital shard silently empty** | Select by FLT_ID or Epic-released core-vitals FLO_MEAS_IDs (5/8/10/11/14); make name configurable; warn on zero rows. |
| `lab.ts:83,290`, `servicerequest.ts:57`, `medication.ts:231,279` | EPIC-PRODUCT-STABLE | `*_C_NAME` WHERE filters: `'Lab Collect'`, `'Blood'`, `'Microbiology'`, `'Inpatient'`, `'Historical Med'`. Enum text is stable, but the single-value `'Lab Collect'` gate → send-out/POC labs produce **no** DR/Specimen/Obs/ServiceRequest | Broaden `'Lab Collect'` to the set of resulted lab classes (or gate on ORDER_RESULTS + lab ORDER_TYPE); keep lab.ts/servicerequest.ts identical. |
| `encounter.ts:423` | ORG-INSTANCE | lab-participant suppression keys on `PROV_NAME` substring `' LAB '` (this org's 'MAC LAB APL') | prefer a provider type/category column; else document as org-tuned |
| `encounter.ts:380` | EPIC-PRODUCT-STABLE | `buildClass` special-cases `'therapies series'` label; default AMB | acceptable for ambulatory; broaden if inpatient/ED may appear |
| `account.ts:72` | ORG-INSTANCE | `MINTED_ORG_SERV_AREAS={"18"}` — this org's facility SA id | derive the minted-org SA set from location-org.ts logic (export it) |
| `coverage.ts:230-234,261` | PATIENT-SPECIFIC | billing-org address from global `CLM_VALUES[0]` (not scoped to this coverage's payer); contained id `org1` | scope PYR_ADDR_* to THIS coverage's payer |
| `documentreference.ts:132-140,145-150` | ORG-INSTANCE | `custodianDisplay` = first CLARITY_SA EXTERNAL_NAME for every note; TARGET_NOTE_TYPES allow-list | pick the note's own SA EXTERNAL_NAME; note the allow-list is this-export |
| `communication.ts:227-259`, `practitioner.ts:58,116` | EPIC-PRODUCT-STABLE | duplicated SENTINELS + CARE_PROV_COLUMNS lists (drift risk); sentinel `3724611 'MAC LAB APL'` is org-flavored id | export one predicate from practitioner.ts; match `3724611` by NAME not id |
| `obs-social.ts:113-126` | EPIC-PRODUCT-STABLE | single whole-row latest SOCIAL_HX snapshot can drop a concept whose current value is on an earlier snapshot | compute latest-non-null PER concept column |
| `invoice.ts:151` | EPIC-PRODUCT-STABLE | `latest = submissions[len-1]` no empty guard (claim.ts guards) | add `if (!submissions.length) continue;` |
| `build.ts:57-64` | EPIC-PRODUCT-STABLE | bundle assembly `JSON.parse` with no try/catch; line 40 logs but continues on a crashed generator → one bad file crashes whole assembly | wrap per-file parse in try/catch (like refcheck.ts) |
| `obs-survey.ts:221-222`, `obs-vitals.ts:149-156`, `immunization.ts:66-78`, `careplan.ts:79-85`, `practitioner.ts:126-131` | EPIC-PRODUCT-STABLE | EMP↔SER/USER↔PROV performer mapping by exact name match, mints ref only on unique match → performer silently degrades at a larger org (conservative, false-absence) | use a direct id linkage where exported; else document |
| `obs-vitals.ts:214-240` | EPIC-PRODUCT-STABLE | BP packed `sys/dia` parse; separate-measure org emits no component | guard non-match (already falls through); component coding from centralized OID |
| `obs-survey.ts:170-184` | EPIC-PRODUCT-STABLE | `encounterDisplay` PROC_NAME LIKE `'PR %'`/keyword heuristic (cosmetic display) | best-effort; broaden/remove |
| `patient.ts:263,302,447,232` | EPIC-PRODUCT-STABLE | `*_C_NAME` literal gates (pref-name, phone-use, relationship 'Spouse'/'Self', marital, 'Alive'/'Deceased') — standard Epic enum text, never-guess fallthrough | acceptable; broaden maps as observed |
| `patient.ts:350,590-595,522-536` | EPIC-PRODUCT-STABLE | single-row `[0]`/`find` on address/serv-area/PATIENT_n (documented Epic 1:1 invariants) | acceptable |
| `medication.ts:231,83-95` | EPIC-PRODUCT-STABLE | DESCRIPTION-tail strength/form scraping (anti-fabrication, false-absence only) | widen token sets optionally |
| `find-concept.ts:55-73,100-103` | EPIC-PRODUCT-STABLE | dev tool assumes `_schema_*`/HNO_INFO exist (not in build path) | guard; low stakes |

### 5b. LIMITATION — coverage enumerated from THIS export (incomplete, never wrong)

| file:line | tier | issue |
|---|---|---|
| `obs-survey.ts:63-118` | ORG-INSTANCE | SURVEY_MEAS set + USCORE_BY_MEAS overlay: 4–6 digit ids are Epic-RELEASED (stable); 10-digit ids (PHQ 2100100050/51, AUDIT-C 1570400748+items, weight-change 304*/305*) are **org-CUSTOM** flowsheet measures that won't exist elsewhere → new org's instruments silently get no survey category / no us-core overlay. Fix: load the overlay from a JSON config keyed on template name; treat low-id Epic-released measures as stable core. (needs-external-config / derive-from-export) |
| `obs-vitals.ts:61-79` | EPIC-PRODUCT-STABLE | BMI deliberately NOT emitted (5 candidate variants, no EHI column to pick) — correct conservative choice |
| `lab.ts:63-65,198-252` | EPIC-PRODUCT-STABLE | CPT-on-DR only for enumerated LAB_PANEL_CPTS via single-candidate elimination; stalls on ties |
| `lab.ts:105-119` | ORG-INSTANCE | UTC offset derived per-order (good); naive+`Z` fallback mis-dates non-Central org when UTC columns absent |
| `medication.ts:39-57,111-114,182-214` | EPIC-PRODUCT-STABLE | FORM/DOSE/FREQUENCY maps cover only forms/units/frequencies seen here → code-only fallthrough |
| `patient.ts:119-124` | EPIC-PRODUCT-STABLE | STATE/COUNTRY/LANG/OMB maps enumerated from this export; falls through to verbatim text (truthful) |
| `coverageeligibility.ts:65,199` | ORG-INSTANCE | Epic service-type codes are org-local config values (text always emitted, so not wrong) |
| `location-org.ts:236,240` | EPIC-PRODUCT-STABLE | lab-org filter on ORDER_TYPE_C_NAME IN ('Lab','Microbiology'); columnsOf-guarded |
| `documentreference.ts:100-108,184-229`, `binary.ts:38-39,130-161` | NON-EPIC | note/media bodies require `raw/Rich Text`+`raw/Media` on disk; absent → no note/binary resources (existsSync-guarded, graceful) |
| `tools/nppes-overlay.ts:58-62` | ORG-INSTANCE | SER_NPI_OVERRIDES (3 curated this-org PROV_ID→NPI) — never matches a new org, harmless |
| `tools/coding-coverage.ts` | EPIC-PRODUCT-STABLE | requires `fhir-target/` — cannot run in baseline (not a build step) |
| `eob.ts:139-146` | EPIC-PRODUCT-STABLE | EOB grain skips claims whose matched charge is out-of-export (data-driven) |

### 5c. Representative SAFE / EPIC-PRODUCT-STABLE (acceptable — not exhaustive)

`lib/db.ts` (open path, q/q1, `tableHasRows`/`columnsOf`, `dateRealToISO` UTC-anchored),
`lib/gen.ts`, `lib/profile.ts`, `lib/q.ts`, `build.ts` orchestrator + non-fatal refcheck
gate, `tools/refcheck.ts`, `tools/find-concept.ts` core, NPPES fetch/cache machinery;
`claim.ts` (the portability MODEL: project-local URIs, enum-driven, guarded);
standard system URIs (us-npi, NUCC, LOINC, UCUM, CPT, ICD, SNOMED, HL7 code systems,
us-core category codes); `LAB_PANEL_CPTS` (AMA CPT filter), SENTINEL `9999999`, SNOMED
`419652001 'Take'` (value-driven); all `*_C_NAME` enum→standard-code maps with never-guess
fallthrough; `obs-smartdata.ts` (model defensive shard); `obs-social.ts` DB-derived labels.

---

## 6. VOCAB GAP (accepted, out of scope)

Quantified, then set aside per instructions. The baseline build emits **2,864** total
`code.coding`s; the answer-key path emits **5,120** (+2,256, ~79% more). On standard
recoverable terminologies the baseline covers **31/303 distinct standard (system,code)
pairs (10%)** vs answer-key **229/303 (76%)**. Baseline emits essentially **zero**
ICD-10/ICD-9/RxNorm/CVX/NDF-RT/SNOMED-condition codes and only partial LOINC (25/67) and
CPT (3/10, free from claim lines). A new patient at a new org LOSES, without a crosswalk:
all NDF-RT (allergy, +76), ICD-10-CM (+21), ICD-9-CM (+19), RxNorm (+22), CVX (+11), most
SNOMED (+28), remaining LOINC (+19) — these are answer-key-only because the EHI export ships
Epic-local codes, not standard ones. **The answer key itself is NOT org-portable:** of 1,163
crosswalk rows, 911 reference the `.283` instance OID and 657 are class `epic-instance-oid`
(810 of 1,042 AK-covered pairs) — all anchored to THIS org's local codes/OIDs, so it would
have to be rebuilt for a different org. **Takeaway:** a new-org patient gets baseline-only
coverage (~10% of standard codings) and the existing answer key cannot rescue them. Accepted
limitation; no fix in this audit.

---

## 7. Recommended fix order (smallest change → most portability unlocked)

| # | Fix | Kind | Unlocks | Effort |
|---|---|---|---|---|
| 1 | **Derive `PATIENT_PAT_ID`** in `lib/ids.ts` (`SELECT PAT_ID FROM PATIENT`, env-overridable, guard 0/>1) | **derive-from-export** | Unblocks the ENTIRE pipeline for any new patient: fixes ~36 `WHERE PAT_ID=?` sites, `patientDisplay()`, the patient.ts:129 throw, empty allergy/immunization/obs-vitals/account/coverage/location-org shards. The single highest-leverage change. | 1 line |
| 2 | **Derive `COVERAGE_ID`** in `coverageeligibility.ts` (per BENEFITS / the patient's COVERAGE row) | **derive-from-export** | Fixes insurer lookup + dangling Coverage refs on all ~21 CoverageEligibilityResponses. After #1–#2 a **same-org** new patient builds correctly. | small |
| 3 | **Centralize the `.283` instance OID** to one `EPIC_INSTANCE_OID` constant + `epicOid()` helper in `lib/ids.ts`; rewrite ~49 literals | **centralize-constant** (on needs-external-config; NOT derivable) | A different Epic org becomes ONE edit instead of 49; removes duplicate-literal drift between basedOn-linked resources. Largest cross-org correctness win. | mechanical, broad |
| 4 | **Centralize the timezone** into one `lib/time.ts` helper: prefer `*_UTC_DTTM` sibling columns (derived), else one configured `EHI_TZ` via a real tz lib; replace the 5–6 hand-rolled DST routines (encounter/obs-vitals/obs-survey/obs-social/communication/allergy) | **derive-from-export where UTC column exists; else centralize-constant** | Fixes every wrong instant at a different-tz org; eliminates the encounter-vs-allergy inconsistency and the allergy summer-DST bug. | medium |
| 5 | **Add `tableHasRows()`/`columnsOf()` guards** on optional-table reads in meds/labs/servicerequest/obs-vitals/obs-survey/encounter/condition (model: obs-smartdata.ts) | **centralize-pattern** | A thinner shipped-table subset degrades to false-absence instead of hard-crashing `bun build.ts`. | medium |
| 6 | **Re-derive baked org ids:** `patient.ts:591 SERV_AREA_ID '18'`, `account.ts:72 MINTED_ORG_SERV_AREAS {"18"}` (share location-org.ts's facility-SA derivation) | **derive-from-export** | Correct `managingOrganization` / `Account.owner` at a different org. | small |
| 7 | **Broaden the fragile single-value gates:** `obs-vitals` template name (FLT_ID/measure-id), `'Lab Collect'` class set (keep lab/servicerequest identical) | **centralize/config** | Prevents silently-empty vital and lab shards at a differently-configured org. | small–medium |
| 8 | **Robustness niceties:** `build.ts:57` try/catch per file; `invoice.ts:151` empty guard; reconcile `eob.ts:64` to claim.ts's project-local INVOICE URI; share SENTINELS/CARE_PROV_COLUMNS between communication.ts & practitioner.ts; obs-social per-concept latest-non-null | **centralize / local** | Hardening; partial-data and drift resilience. | small each |

> Steps **1–2** make a same-org patient build correctly. Steps **1–6** make a different-org
> patient build correctly. Steps **7–8** harden against differently-configured but valid
> org exports. The vocab gap (§6) is accepted and not addressed here.
