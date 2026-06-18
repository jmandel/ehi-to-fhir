# Residual Deep-Dive — Answer-Key-Enabled Divergence Floor

This document characterizes the **residual** divergence between our generated FHIR
(`out-answerkey/`, the answer-key-enriched output) and the curated Epic answer-key
target (`fhir-target/`), after the answer-key terminology layer has been applied.
The residual is the set of element-level leaves where our output still differs from
the target. The goal here is to classify every residual leaf into one of four
verdicts and decide what (if anything) can still be closed.

- **truly-unrecoverable** — the datum is provably not in the EHI tabular export
  (and not derivable); matching it would require fabrication.
- **recoverable** — the datum *is* in the export and we simply miss it; a generator
  change reproduces the target exactly.
- **approximatable** — the datum is derivable/generatable (from terminology we
  already layer, a fixed FHIR constant, or our own emitted structured content) but
  will not be byte-identical to Epic's exact rendering.
- **tolerance-candidate** — same datum, cosmetically different representation
  (id-scheme, case-fold, name-render, sub-minute precision); should be blessed by a
  tolerance rule, not chased as a data fix.

SmartData handling: `EXCLUDE_SMARTDATA=1` drops Observations whose category coding
has `code=="smartdata"` from BOTH sides (`classify.ts` is dir-parameterizable via
`OUT_DIR` env or `--out=<dir>`, default `out/`).

---

## 1. Headline

> **Round-4 reconciliation (2026-06-17).** The per-area verdict analysis below was authored at an
> earlier residual size (ex-SmartData 4252). After rounds 3–4 closed the big recoverable/tolerance
> movers, the **current ex-SmartData answer-key residual is 2064 GAP leaves** (the classifier's GAP
> bucket; reconcile OK: 12442 EXACT + 1557 TOLERATED + 2064 GAP = 16063). The authoritative current
> floor breakdown is the regenerated **`compare/CODING-FLOOR-AUDIT.md`: FLOOR 1154 / MOVABLE 336 /
> UNSURE 574**. The narrative verdicts below remain valid as *characterizations of the residual
> families* (which datum is no-anchor vs cosmetic vs recoverable); only the absolute counts have
> shrunk. What moved out since this section was written: Condition encounter-dx codes (now FLOOR-
> closed via DX_ID inheritance), med dosage/route/form text+structure, Observation US-Core category,
> and the attachment url/contentType relax (now TOLERATED in the embedded answer-key view). The
> truly-unrecoverable spine (DiagnosticReport order-compendium OID fan-out, encrypted flowsheet
> ids/`.96` LOINC-alias, Encounter.type no-anchor, SmartData set-aside) is unchanged.

| Residual view | Element leaves |
|---|---|
| **WITH SmartData** | **4370** |
| **WITHOUT SmartData (ex-smartdata)** | **4252** |
| SmartData set-aside (the gap) | **118** (the physical-exam SmartData Observations; `SMRTDTA_ELEM_DATA` not shipped) |

### Four-verdict split of the ex-smartdata residual (4252)

| Verdict | Count | Share |
|---|---:|---:|
| **truly-unrecoverable** | **2091** | 49.2% |
| **tolerance-candidate** | **1238** | 29.1% |
| **approximatable** | **809** | 19.0% |
| **recoverable** | **114** | 2.7% |
| **Total** | **4252** | 100% |

Read-through: **~78% of the residual is either truly-unrecoverable (49%) or a
cosmetic tolerance-candidate (29%)** — i.e. not a generator bug. The genuinely
*addressable* residual is the **recoverable (114)** plus the **approximatable (809)**
= **923 leaves (~22%)**, and of those the single largest item (414) is a partially
recoverable coding system whose exact opaque token is itself unrecoverable. The
honest "we are leaving data on the table" floor is the 114 recoverable leaves.

A single dominant truly-unrecoverable item, `DiagnosticReport.code.coding[].system`
(1043, the Epic order-compendium OID fan-out), is half of the unrecoverable bucket
on its own.

---

## 2. Per-Area Findings

Each row: residual field, verdict, proof (search/join/generation method),
recommendation, effort.

### Area: meta (timestamp precision + the FHIR `meta` element)

| Field | Verdict | Proof | Recommendation / Effort |
|---|---|---|---|
| FHIR `meta` element (profile/versionId/lastUpdated/security/tag) | tolerance-candidate | Target emits `meta` on **0 of 621** resources; ours on 0. Nothing to match. "meta" is the partition's *area label* for the timestamp fields below, not the FHIR element. | Bless as "curated target omits resource.meta; both sides agree on absence." Do **NOT** start stamping `meta.profile`/`meta.lastUpdated` — that would *create* divergences against a target with none. Low. |
| `Observation.issued` (72: 52 vitals + 20 survey) | tolerance-candidate | Both feed `IP_FLWSHT_MEAS.ENTRY_TIME`; source is minute-truncated (305/305 rows end `:00`; distinct-seconds = []). `RECEIVED_INSTANT` empty, `RECORDED_TIME` 305/305 `:00`. Sub-second instant lives only on the server. | Precision-tolerance rule: equal after truncating target to whole minute. Low. |
| `DocumentReference.date` / `.context.period.start` / note & authenticator `valueDateTime` (92: 28+5+31+28) | tolerance-candidate / truly-unrecoverable | Sources `HNO_INFO.CREATE_INSTANT_DTTM`, `NOTE_ENC_INFO.NOTE_FILE_TIME_DTTM`/`SPEC_NOTE_TIME_DTTM` all minute-truncated (77/77 and 80/80 `:00`); all other HNO_INFO instant cols 0 nonzero seconds. | One whole-minute precision tolerance covers all four paths. Low. |
| `AllergyIntolerance.recordedDate` (4) | tolerance-candidate | `ALLERGY.ALRGY_ENTERED_DTTM` 4/4 minute-truncated; only other datetime cols are date-only. | Same whole-minute rule. Low. |
| `Encounter.period.start` (2, hospitalization admit) | truly-unrecoverable | `PAT_ENC_HSP.HOSP_ADMSN_TIME` 2/2 minute-truncated; target carries `:55` seconds absent from source. | Whole-minute tolerance. Low. |
| `Encounter.period.end` (17, appointment slots) | truly-unrecoverable | `buildPeriod()` emits start only; target end = start + booked slot length (5/45/15/10 min). `PAT_ENC_APPT` has no end/length col; `APPT_LENGTH`/`slot`/`duration` searches all empty/not-shipped. | Tolerate "slot end/length absent from export." Low. |
| `Encounter.participant[].period.end` (14) | truly-unrecoverable | Same root as above; we emit start (14/14 match), end on 0 (no slot length). | Same. Low. |
| `CarePlan.activity[].detail.scheduledPeriod.start` (1) | **recoverable** | `careplan.ts:226-229` does `.slice(0,10)` → date-only `2027-06-16`. Source `PAT_ENC_APPT.PROV_START_TIME='6/16/2027 2:30:00 PM'`; `chicagoToISO()` → `2027-06-16T19:30:00Z` = target **exactly**. The caution against asserting Central is inconsistent with the rest of the codebase. | Replace `.slice(0,10)` with `chicagoToISO(r.PROV_START_TIME)`. One line. Low. |
| `CarePlan.activity[].detail.scheduledPeriod.end` (1) | truly-unrecoverable | end = start + 30-min slot; slot length not exported. | Tolerate. Low. |
| `DiagnosticReport.issued` (7) | tolerance-candidate | Distinct mechanism — not truncation. We use `ORDER_PROC_6.LAST_FINAL_UTC_DTTM` (= all final/chart instants); target is ~7-11s *earlier* (server report-issue instant). `--grep '8:41:51'` over raw TSVs = 0 hits; no ORDER_PROC_6 col equals it. | Near-equal-instant tolerance (same minute / |delta| < small threshold). Medium. |

### Area: narrative (CarePlan only — the sole target type with `text.div`)

| Field | Verdict | Proof | Recommendation / Effort |
|---|---|---|---|
| `CarePlan.text.status` (longitudinal) | approximatable | Target = fixed token `"generated"`. We emit no text block. Correct by construction once we generate the div. | Emit `text:{status:"generated", ...}`. Low. |
| `CarePlan.text.div` (longitudinal "Plan for Patient Care") | approximatable | Target div is an Epic roll-up of EXACTLY our emitted structured content: `addresses[].display` (same 4 problems, same order), `goal[].display` (Blood Pressure), `activity[].detail` (the scheduled appt). No resource we emit has any narrative (`grep '"div"'` = 0). It's a pure omission, not absent source. | Add a narrative generator for the longitudinal plan (h1/h2 sections + appt table) as a per-type narrative-from-structured helper. Medium. |
| `CarePlan.text.div` — exact XHTML bytes | tolerance-candidate | Even a faithful div won't be byte-identical: goal renders `"below 140/90"` vs source `"< 140/90"`; appt table shows times we hold only as a date (no end/offset). | After the generator lands, bless a structural/cosmetic narrative tolerance scoped to `CarePlan.text.div`; keep the two underlying data gaps tracked on their own fields. Medium. |
| `CarePlan.text.(div,status)` on the 3 "Patient Instructions" plans | **recoverable-as-narrative** (was truly-unrecoverable) | (Not in this partition; characterized for completeness.) Their div is free-text patient instructions — and that free text **survives verbatim in the linked note corpus**, not in any TSV. The prior "unrecoverable" verdict came from scanning only `raw/EHITables/*.tsv` (`ORDER_MED_SIG.SIG_TEXT`=[]; `DISCRETE_PAT_INSTRUCTIONS` unshipped) — the NOTE-CORPUS blind spot. Each plan's Patient-Instructions note is in `raw/Rich Text/HNO_<NOTE_ID>_*.RTF`: `topiramate`/"For blood pressure" in `HNO_3820384431_*` (NOTE_ID 3820384431, CSN 948004323); "Start with 10 mg of nortriptylene at night…" in `HNO_4024965334_*` (CSN 974614965); "Nortriptyline taper… every other night" in `HNO_4216859306_*` (CSN 958148810). Verify: `bun tools/find-concept.ts --grep 'topiramate' --notes`. Narrative IS the resource AND the narrative is present → buildable from note text. | Build the 3 CarePlans with `text.div` from the rtf2txt-extracted note body (joined HNO_INFO→RTF by NOTE_ID); the patient-facing prose won't be byte-identical to Epic's XHTML render (approximatable div), but the content is no fabrication. Medium. |

### Area: reference-enrichment

| Field | Verdict | Proof | Recommendation / Effort |
|---|---|---|---|
| `Practitioner.name[].prefix[]` ("Dr.") + prefix in `*.display` | truly-unrecoverable | Only title source `PAT_ENC.VISIT_PROV_TITLE_NAME` is partial (visit provider only) and **non-predictive**: DNP→no "Dr." in target; untitled ordering providers→"Dr." Degree doesn't predict prefix. No CRED/DEGREE/PREFIX col on `CLARITY_SER`. | Leave prefix unset; do NOT map MD/DO→"Dr." (over- and under-emits). Tolerate as server-only enrichment. Low. |
| `Practitioner.name[].family/given[]/text` (de-id render "S"/"Z"/"Mary S") | tolerance-candidate | Full names present & emitted (`CLARITY_SER.PROV_NAME`/`EXTERNAL_NAME`). Target applies Epic synthetic-data de-id truncation driven by the unexported physician flag. Ours is strictly more complete. | Tolerate (cosmetic / de-id render). Low. |
| `Observation/Condition/MedicationRequest/Immunization.encounter.display` + `DocumentReference.context.encounter.display` ("Office Visit"/"Lab"/"Telephone") | truly-unrecoverable | These are the proprietary Epic encounter-type label (system `.698084.30`), no source column. Exact-value scan: "Office Visit" only in `CLARITY_PRC.PRC_NAME` (1 telehealth row) & `DOC_INFORMATION`; "Lab" only as `ORDER_PROC.ORDER_TYPE_C_NAME`. No `PAT_ENC.ENC_TYPE_C` column. | Leave display unset (reference + CSN identifier already resolve). Truly-unrecoverable export-config gap. Low. |
| `*.subject/patient/beneficiary/subscriber.display` ("Mandel, Josh C" vs "Mandel, Joshua C") | **approximatable** | Legal vs **preferred** first name. `PATIENT.PAT_FIRST_NAME="Joshua"` (what `ids.ts patientDisplay()` uses) vs `PATIENT_3.PREFERRED_NAME="Josh"` (already read by `patient.ts`). Target = `<last>, <PREFERRED> <middle>`. | Change `ids.ts patientDisplay()` to prefer `PREFERRED_NAME`. One central change fixes every subject/patient display. Low. |
| `Patient.name[].family/given[]` ("Mandel"/"Josh" vs "MANDEL"/"JOSH") | tolerance-candidate | Array-alignment artifact: our `name[official]` IS proper-case; the uppercase is our `name[old]` alias rows the positional comparator mis-aligns. | No data fix; match by `use=` or bless alias-case. Low. |
| `Condition.encounter.identifier.value/.system/.use` | tolerance-candidate | Array-alignment artifact: we DO emit `{use,system,value:<CSN>}` on all 45 conditions; all CSNs are valid. Positional comparison crosses same-name visits. | No data fix; key Conditions by stable id before diffing. Medium. |
| `DocumentReference.custodian.identifier.system/.value` (`urn:ihs:ce-prd`) | truly-unrecoverable | Care Everywhere home-community id injected from deployment config. `--grep "ce-prd"` = 0 real hits. `custodian.display` IS recovered ("UnityPoint Health"). | Leave identifier omitted. Low. |
| `DocumentReference.author/authenticator/extension.display` + `DiagnosticReport/Observation/Immunization.performer.display` + `MedicationRequest.requester/recorder.display` (de-id render) | tolerance-candidate | Same de-id root; we emit full `CLARITY_SER.PROV_NAME`. | Tolerate (cosmetic / de-id). Optionally render `EXTERNAL_NAME` form. Low. |
| `Encounter.location[].location.display` ("UnityPoint Health-MeriterTherapy-Central") | **recoverable** | `encounter.ts deptName()` uses `CLARITY_DEP.DEPARTMENT_NAME`; target uses `EXTERNAL_NAME`. Depts 101401044 / 1084600303 `EXTERNAL_NAME` = target **exactly**. The `our=null` rows are a second target location entry (service-area roll-up) — structural. | Prefer `EXTERNAL_NAME` over `DEPARTMENT_NAME` when non-blank. Low. |
| `Encounter.class.display` ("Support OP Encounter" vs "ambulatory") | tolerance-candidate | FHIR R4 binds class to v3-ActCode; target is non-conformant Epic-local `.13260`. Proprietary label not in export. Our AMB is spec-correct. | Bless (spec-required divergence). Low. |
| `MedicationRequest.medicationReference.display/priorPrescription.display` ("nortriptyline 10 MG capsule") | approximatable | RxNorm preferred name; present in `crosswalk/ALL.csv` `concept_display` keyed by `MEDICATION_ID`. Applier currently only sets `code.coding`. | In answer-key layer, set the display from the matched RxNorm `concept_display`. Medium. |
| `Immunization.location.display` ("UnityPoint Health" vs "MAC APL INTERNAL MEDICINE") | tolerance-candidate | Ours is MORE specific (administering dept via `IMM_CSN→DEPARTMENT_ID`); target is generic top-of-hierarchy. Same place, different granularity. | Tolerate (more-specific resolution). Low. |
| `Coverage.payor/Patient.managingOrganization/contact/generalPractitioner .display` (case-fold) | tolerance-candidate | Org/payor names exist ONLY uppercase (`COVERAGE_2.PAYOR_NAME`, `CLARITY_SA.SERV_AREA_NAME`); title-casing is lossy for "LLP". | Tolerate (cosmetic case-fold). Low. |
| `Practitioner.name[].text` + `Goal.expressedBy/Patient.generalPractitioner.display` (de-id) | tolerance-candidate | We emit complete `EXTERNAL_NAME` form; target truncates + adds "Dr." | Tolerate. Low. |
| `CarePlan.goal[].display` ("Blood Pressure below 140/90" vs "< 140/90") | tolerance-candidate | Same goal text, `<` vs the word "below". | Tolerate (cosmetic). Low. |
| `DiagnosticReport.encounter.display` ("Lab" vs "Microbiology") | truly-unrecoverable | Same encounter-type-label root; "Lab" not sourceable. | Leave / drop display. Low. |
| `Observation.performer.display` singleton ("Megan F") + `encounter.display` proxy | tolerance-candidate / suppress | (a) "Megan F" = de-id render of a SER provider (recoverable as full name). (b) "Office Visit" vs our `CLARITY_EAP` proc-name proxy is a false-presence to suppress. | (a) emit full SER name or tolerate; (b) suppress the proxy display. Low. |

### Area: observation-values (vitals / survey / social value & code text/codings)

| Field | Verdict | Proof | Recommendation / Effort |
|---|---|---|---|
| **Vitals pairing failure** (claim "vitals lack LOINC + wrong effective ts") | tolerance-candidate (STALE claim) | Answer key RESOLVES it: applier adds LOINC `55284-4/85354-9/8716-3` to BP parent (verified `Observation__vitals.json`). Timestamp claim is **false** — all 9 BP `effectiveDateTime` are byte-identical both sides. Residual is element-level diffs (which only exist for resources that DID align). | Reclassify RESOLVED-BY-ANSWER-KEY; score alignment against `out-answerkey` (`OUT_DIR`). Low. |
| `Observation.component[].code.coding` (BP systolic/diastolic LOINC 8480-6/8462-4) | approximatable | Not in EHI (`LNC_DB_MAIN` holds zero vital LOINCs; crosswalk has 0 component rows). But it's the fixed universal decomposition of the BP measure — provably derivable since the parent panel LOINC is confidently assigned from the same measure. | Add 2 component-level crosswalk rows (measure 5 → 8480-6/8462-4) keyed on the systolic/diastolic split we already perform. **Highest-yield, lowest-risk recovery** in this cluster (18 coding + 18 text). Medium. |
| `Observation.component[].code.text` ("Systolic blood pressure" vs "BP Systolic") | approximatable | EHI stores measure name only as "BP" everywhere; "Systolic blood pressure" appears 0× in sqlite. It's the LOINC display. | Set from the component LOINC display once the row above lands. Low. |
| `Observation.code.text` for vitals ("Blood Pressure" vs "BP") | tolerance-candidate | EHI display for `FLO_MEAS_ID=5` is literally "BP"; "Blood Pressure" only appears as a `VALUE_TYPE_C_NAME` discriminator. Pulse/Weight/Height/SpO2 already match. | Bless cosmetic, or pull display from answer-key LOINC `55284-4`. Low. |
| `Observation.code.text` for labs ("Creatinine" vs "CREATININE") | **recoverable** | Proper-case display ALREADY in our own `crosswalk/lab.csv concept_display` for the exact `COMPONENT_ID` rows; applier only sets `code.coding`, never `code.text`. | Have applier optionally set `code.text` from matched `concept_display`/LOINC display. ~37 lab leaves. Medium. |
| `Observation.valueCodeableConcept.text` BP Cuff Size ("Regular (Adult)" vs "Reg") | truly-unrecoverable | Source stores only raw "Reg"; "Regular (Adult)" 0× in sqlite; answer-list dictionary unshipped. | Real-gap, or bless a value-map if a human confirms. Tiny (9). Low. |
| `Observation.valueCodeableConcept.text/.coding` PHQ ("Not at all" vs "0") | approximatable | Code "0" matches; display is the expansion. `V_EHI_HQA_QUEST_ANSWER` has the text but on a different spine (no clean join). PHQ-2 answer list is a fixed standard. | Add a blessed PHQ-2 value-map (0..3 → standard displays) keyed on PHQ FLO_MEAS_IDs. ~11. Medium. |
| Observation (social) value SNOMED codings | recoverable (CLOSED) | Already closed by answer key: tobacco 266919005, alcohol 219006, drug-use 228367002 (verified `Observation__social.json`). | No action; regression check. Low. |
| Vitals mirror codes (Epic flowsheet-id token, `urn:oid:1.2.246.537.6.96`) | truly-unrecoverable | Encrypted one-way Epic FHIR id (not reversible to FLO_MEAS_ID); `.96` is an Epic-instance LOINC alias. No code column on any flowsheet table. | Bless coding-gap; equivalent `http://loinc.org` coding already supplied. Low. |
| `MedicationRequest.dosageInstruction.*` dose/route/supply (mislabeled into this area) | **recoverable** | NOT Observation values — area-name collision. `ORDER_MED.HV_DISCRETE_DOSE` is populated (20 rows) with `HV_DOSE_UNIT_C_NAME`, MIN/MAX, QUANTITY. doseQuantity + supply duration recoverable. | Route to medication-cluster work; recoverable from ORDER_MED. Medium. |

### Area: cross-links (references)

| Field | Verdict | Proof | Recommendation / Effort |
|---|---|---|---|
| `Observation.basedOn[].reference` → ServiceRequest (38 / 8 orders) | approximatable | We already emit basedOn as a *logical identifier* ref `{identifier:{...798268},display:DESCRIPTION}`; 8 target SR ids map 1:1 to `ORDER_PROC` by DESCRIPTION. ORDER_PROC carries every SR field. Epic itself ships **no** ServiceRequest.json (dangling ref). | Add `src/servicerequest.ts` (one per resulted ORDER_PROC), point basedOn at it; minted id won't byte-match → iso-ref tolerance on shared placer id. Medium. |
| `Observation.derivedFrom[].reference` (5, survey) | truly-unrecoverable | All point to panel-HEADER Observations ("PHQ-2: Over the last 2 weeks...", "START HERE") that don't exist in EHI (header rows absent from `IP_FLWSHT_MEAS`; `IP_FLOWSHEET_ROWS` is flat, no parent col). Referent unconstructable. | Leave documented; optionally a "unconstructable-referent" dropped tolerance. Low. |
| `Observation.hasMember[].reference` (39, survey) | truly-unrecoverable | Owners are the same missing panel headers; absorbed into whole-resource survey-panel gap. | No cross-link action. Low. |
| `Observation.focus[].reference` (118, smartdata) | truly-unrecoverable | All on smartdata+exam Observations whose `SMRTDTA_ELEM_DATA` is unshipped. Whole-resource gap, identical with/without EXCLUDE_SMARTDATA. | Out of scope (the smartdata set-aside). Low. |
| `Observation.performer[].reference` (2, "Megan F") | approximatable | Resolves to `TAKEN_USER MSF400 = "FARGEN, MEGAN"`; she has NO `CLARITY_SER` row (only "BOWER, MEGAN M"); no EMP→SER bridge. But her identity IS in `CLARITY_EMP` (USER_ID + NAME). | Mint a Practitioner from `CLARITY_EMP` for SER-less flowsheet recorders; iso-ref tolerance. Medium. |
| `Condition.encounter.reference` null (CSN 829995922) + display omissions + CSN misalignment | **recoverable** | CSN 829995922 is a real 'Complete' `PAT_ENC` but has hsp=0/disp=0/note=0/rsn=0 so `selectCsns()` drops it and closure never pulls it. CSN-value "mismatches" are an alignment artifact (same DX at different visits). | (1) Emit Complete PAT_ENC referenced by emitted Conditions via referential closure. (2) Type display from PAT_ENC. (3) Multiset-aware Condition alignment. Medium. |
| `Encounter.location[].location.reference/display` (4, therapy) | tolerance-candidate | We emit the dept-level location (`loc-101401044`); target emits a 3-deep stack (dept ×2 + facility "UnityPoint Health"). Facility exists (`CLARITY_LOC` LOC_ID 1) but is NOT tied to the encounter by any exported column (`PRIMARY_LOC_ID` resolves to a *different* location). | Structural-variant tolerance (location-hierarchy roll-up); don't fabricate from the wrong PRIMARY_LOC_ID. Low. |
| `Observation.performer[].reference` (70, id-scheme) | tolerance-candidate | Same entity: `prac-621755` = SER 621755 = "SMITH, MARY B" = target opaque id. No registry rule covers Observation.performer yet. | Add iso-ref + cosmetic-display rule pair keyed on resolved SER. Low. |
| `DiagnosticReport.result[].reference` (46, id-scheme) | tolerance-candidate | Our `obs-<ORDER_PROC_ID>-<LINE>` minted from same `ORDER_RESULTS` row Epic's opaque id encodes. No rule covers DiagnosticReport.result. | iso-ref rule keyed on (ORDER_PROC_ID,LINE). Low. |
| `Observation.specimen.reference` (38, id-scheme) | tolerance-candidate | Our `spec-<ORDER_PROC_ID>` = same specimen. A naive accession-keyed rule was DROPPED (accession is many-to-one). Correct key = per-specimen ORDER_PROC_ID. | iso-ref keyed on ORDER_PROC_ID specimen key, explicitly NOT accession. Medium. |
| `DocumentReference.author/authenticator/extension.valueReference/subject/context.encounter.reference` (~143, id-scheme) | tolerance-candidate | All same-entity our-scheme ids (SER / CSN / patient). Mirrors the existing subject-display rule. | Extend iso-ref/cosmetic family to these DocRef paths. **Largest single unsure reduction.** Low. |
| `MedicationRequest.medicationReference/subject/requester/recorder/encounter/priorPrescription.reference` (~78, id-scheme) | tolerance-candidate | All same-entity ids from ORDER_MED keys (`ids.medicationRequest=ORDER_MED_ID`); priorPrescription is the ORDER_MED reorder chain. | Add iso-ref rules for these paths. Low. |
| Other id-scheme refs (Immunization ~35, DiagnosticReport ~36, Condition.evidence 16, Specimen 9, AllergyIntolerance 4, singletons ~13) | tolerance-candidate | Every example is opaque target id vs our deterministic id for the SAME entity (PAT_ID / CSN / SER / Org / Condition key). | Generalize iso-ref to a **type-indexed rule** (any ref whose resolved natural key matches on both sides is tolerated). Absorbs the bulk of the 544 unsure ref leaves. Keep fail-closed equality. Medium. |

### Area: unshipped-masters

| Field | Verdict | Proof | Recommendation / Effort |
|---|---|---|---|
| `DiagnosticReport.code.coding[].system` (+ paired code, **1043+**) | truly-unrecoverable | Target fans one lab across ~30 proprietary Epic order-compendium OIDs. `find-concept "compendium"/"order compendium"/"procedure catalog"` = 0 cols; `--grep "LIPIDP"` = no table. `CLARITY_EAP` stripped to PROC_ID+PROC_NAME (2 cols). We already emit correct CPT 80061 + LOINC 24331-1 + "Lipid panel". | Bless ("compendium OID fan-out not in export"); the variants add no clinical info. Low. |
| `Observation.code.coding[].system` = observation-flowsheet-id (**414**) | approximatable | Concept IS populated: `IP_FLOWSHEET_ROWS.FLO_MEAS_ID` (372 rows) + `FLO_MEAS_ID_DISP_NAME`. Target value is the ENCODED/encrypted token — byte-exact match impossible. | Emit a flowsheet-id coding with raw `FLO_MEAS_ID` + display; tolerance keyed on "same row, opaquely re-encoded." system+code recoverable; token not. Medium. |
| `Observation.(whole resource)` — 118 SmartData exam (subset of 130) | truly-unrecoverable | **Headline known gap.** Target has 118 smartdata Observations; we emit 0. `SMRTDTA_ELEM_DATA` not in `ehi.sqlite` ("no such table"). EXCLUDE_SMARTDATA drops exactly 118. | Export-config request, not a generator bug. (Remaining ~12 non-smartdata extras investigated separately.) High. |
| `Encounter.type[].coding[].system` + `.text` (72 + 62) | truly-unrecoverable (+text approximatable via heuristic) | Epic enc-type master. No populated enc-type col (`PAT_ENC` has none; only `REFERRAL_2.RFL_ENC_TYPE_C_NAME`). We currently MIS-emit `type.text='Elective'` (that's HOSP_ADMSN_TYPE — wrong concept). | OID coding unrecoverable; **fix the 'Elective' mis-mapping**; type.text approximatable via DocRef.type join (heuristic). Medium. |
| `Encounter.class.system` + `.code` (32 + 32, Epic-local "13") | tolerance-candidate | Target uses Epic-local class code; we emit standard v3-ActCode AMB. Epic-local code not in any shipped column. | Bless (we conform, target doesn't). Low. |
| `Medication.code.coding[].system` = `http://www.whocc.no/atc` (69) | truly-unrecoverable | `--grep "whocc"` = no table; ATC is an external WHO classification not stored. We emit correct RxNorm. | Bless ("ATC mapping not in export"). Low. |
| `DocumentReference.content[].attachment.url` = `Binary/...` (56) | truly-unrecoverable | `find-concept "Binary"` → only a flag col, not the blob. Binaries not in tabular export. | Unrecoverable as Binary URL; optionally inline `attachment.data` from HNO_INFO note text (different shape → structural divergence). Medium. |
| `DocumentReference.(whole resource)` 23 extra + type-coding/userSelected/custodian-id/date | approximatable (whole) / truly-unrecoverable (sub-fields) | `HNO_INFO` has 188 note rows; we surface fewer → more DocRefs generatable. type OID/userSelected/custodian-id are unshipped masters. | Audit DocRef generator vs full HNO_INFO (generate the 23); tolerate the proprietary sub-fields. High. |
| `Practitioner.identifier[]` EPIC enterprise id (31/30/27/21) | truly-unrecoverable | `--grep "9005828432002"` = no table; `CLARITY_SER` stripped to PROV_ID/PROV_NAME/EXTERNAL_NAME (no enterprise-id col). | Tolerate (extra EPIC id not in EHI). Low. |
| `Practitioner.(whole resource)` 8 extra referenced | approximatable | 8 referenced Practitioners we don't emit (dangling). Generatable if PROV_IDs exist in CLARITY_SER or as scattered `*_PROV_ID/_NAME` pairs. | refcheck the 8 dangling refs; back-fill stubs from PROV_ID/PROV_NAME at the reference site. Medium. |
| `CareTeam.(whole)` + participant role coding | approximatable | We emit 0 CareTeam; no generator. `EPT_CARE_TEAMS` not shipped, but `PAT_PCP` IS populated (2 rows: PCP_PROV_ID, SPECIALTY_C_NAME, RELATIONSHIP, EFF/TERM). Target participants partially overlap. role.text = SPECIALTY_C_NAME. | Build CareTeam from PAT_PCP + CLARITY_SER names; proprietary role OIDs tolerate; expect partial alignment. High. |
| `DISCRETE_PAT_INSTRUCTIONS` (as a *structured* field) | truly-unrecoverable (structured) — **but the instruction TEXT is recoverable-as-narrative** | `find-concept` = 0 populated cols; table not in sqlite. HOWEVER the discrete-instruction *content* is not gone: it survives as free text in the encounter Patient-Instructions notes (`raw/Rich Text/HNO_<NOTE_ID>_*.RTF`; see the CarePlan narrative row above). Structured/discrete form unrecoverable; the prose is recoverable. | No action for the structured field; for the instruction text, read it from the linked note (rtf2txt) rather than `ORDER_MED_SIG.SIG_TEXT`. Low. |
| `Immunization.route/site/reportOrigin.coding[].system` (16-19 each) | tolerance-candidate | `IMM_ADMIN.IMM_ROUTE_C_NAME`/`IMM_SITE_C_NAME` populated but carry only the NAME (code stripped). We emit display+text. | Tolerate ("proprietary OID+code stripped to _C_NAME; display/text emitted"). Applies to all `*_C_NAME`-backed codings. Low. |
| `MedicationRequest.courseOfTherapyType.system + text` (18, all "acute") | approximatable | Target always "acute"; we emit nothing. No chronic flag col, but every target value is the constant. | Emit the fixed `...course-of-therapy#acute` / "Short course (acute) therapy" default. Low. |
| `Medication.code.text/ingredient.text` (RxNorm name vs Epic label, 18 each) | approximatable | Target = RxNorm STR of the code we already emit. | In answer-key layer set text to RxNorm preferred name. Medium. |
| `Medication.form.text` = "Cap" (18) | approximatable | We emit form.coding (code "TABS") but no text; text is the form code's display. | Populate form.text from the form coding display. Low. |
| `Observation.issued` seconds (72) | tolerance-candidate | Matches to the minute; `ORDER_RESULTS.COMP_OBS_INST_TM` is minute-precision (seconds zeroed in export). | Timestamp-precision tolerance. Low. |
| Organization name/address case-fold + state expansion + alias (2 each) | tolerance-candidate (alias truly-unrecoverable) | Stored uppercase + 2-letter state; target title-cases & expands. alias (MHMLAB) likely unshipped Epic abbreviation. | Cosmetic tolerances (case-fold; state expansion). alias low-priority gap. Low. |
| `Organization.identifier[]` NPI (1861412785) + system/use/period | **recoverable** | `--grep "1861412785"` → matches in `CLM_VALUES.tsv` / `CLM_VALUES_3.tsv`. Org NPI present in claim-value tables. | Join billing Org to CLM_VALUES; emit NPI identifier. Small (2) but genuine miss. Medium. |
| `Patient.identifier/telecom` REDACTED (MRN, phone) (5 + 4) | tolerance-candidate | Intentional de-id redaction; recovering defeats de-id. | Bless de-id tolerance. Low. |
| `AllergyIntolerance.clinical/verificationStatus.coding[].version` = "4.0.0" (4 each) | approximatable | Constant FHIR-version stamp on fixed terminology. | Emit constant `version="4.0.0"`. Low. |
| Patient/Coverage/Goal US-Core extension urls / us-core-sex / us-core-category / v3-RoleCode (scattered) | approximatable | Fixed US-Core profile machinery over data we already emit (sex/category/relationship). | Add the fixed extension URLs/systems where we already emit the value. Coverage.type.text/Goal.description.text label divergences → tolerate cosmetic. Medium. |

### Area: unsure-linkage

| Field | Verdict | Proof | Recommendation / Effort |
|---|---|---|---|
| `Condition.encounter.identifier.value` (+ ref/use/system) (25+24) | tolerance-candidate | NOT a linkage bug. Per-DX CSN sets are identical except where the Encounter SET differs (we export 42, target 34). Where both export the encounter, our `PAT_ENC_DX` link matches. Classifier keys on code.text@effective → same-name visits cross. | Reconcile under Encounter-selection; better Condition aligner ((code.text, recordedDate, CSN)); tolerate iso-ref where both sides have the encounter. Medium. |
| `Encounter.class.display` (proprietary "Support OP Encounter") | tolerance-candidate | Proprietary `.13260` not shipped; FHIR-required class → we derive conformant AMB. | Bless structural. Low. |
| `Observation.code.text` case-fold (CREATININE→Creatinine) | approximatable | `ORDER_RESULTS.COMPONENT_ID_NAME` + `CLARITY_COMPONENT` both uppercase-only; target is LOINC long-common-name; answer-key resolves LOINC. | Cosmetic case-fold tolerance, OR overwrite from resolved LOINC display. Low. |
| `Observation.code/component.code.text` semantic relabels (BP→Blood Pressure; BUN BLOOD→BUN; HDL→HDL Cholesterol) | approximatable | Source labels verified (`FLO_MEAS_ID_DISP_NAME='BP'`, `COMPONENT_ID_NAME='BUN BLOOD'`). Target strings are LOINC common-names, derivable from the answer-key LOINC. | Supply LOINC display as code.text when a code resolves. Medium. |
| `*.reference` cluster (544 unsure leaves, all resource types) | tolerance-candidate | Pure id-scheme isomorphism, proven by resolving both sides (CSN/PAT_ID/SER/accession match). `tolerances.ts` already blesses this for some scopes. | Extend the reference-isomorphism predicate to remaining scopes — reclassifies ~544 unsure → TOLERATED. **Registry coverage gap, not data gap.** Medium. |
| `*.display` name scrambling ("Mary S"/"Dr. Z Rammelkamp"/"Josh") | tolerance-candidate | Resolve to same provider/patient; target is Epic synthetic-sandbox de-id scrambling; our SER/PAT names are the real values (more faithful). | Display-name tolerance keyed on same-resolved-entity (sibling ref isomorphic). Medium. |
| `Practitioner.active` (true vs null) | truly-unrecoverable | `CLARITY_SER` has exactly 3 cols (PROV_ID/PROV_NAME/EXTERNAL_NAME); `find-concept active` = no provider-status col. | Honest absence (optional blessed assume-active = fabrication). Low. |
| `Practitioner.gender` (female vs null) | truly-unrecoverable | `find-concept gender`/'provider sex' → only patient/family gender; CLARITY_SER has no sex col. | Honest absence. Low. |
| `AllergyIntolerance.category[]` (food/medication/biologic, 6 leaves / 4 allergens) | **approximatable** | No allergen-class col ships, but the 4 allergens (TREE NUT, PEANUT, SULFA, PENICILLINS) have unambiguous FHIR categories; answer key already codes the drug allergens. | Small allergen→category derivation (drug via NDF-RT/RxNorm; food→food). Deterministic. Low. |
| `DiagnosticReport.issued` seconds-drift (7) | tolerance-candidate | Every ORDER_PROC_6 instant col = our value; target is 7-9s earlier (server report-generation instant, in no shipped col). | Near-equal-timestamp tolerance (target ≤ ours, same minute). Low. |
| `Organization.name` case-fold | tolerance-candidate | Normalized strings identical; mixed-case not in export. | Case-insensitive-equal tolerance. Low. |
| `CarePlan.activity.scheduledPeriod.start` (date-only) | **recoverable** | `PROV_START_TIME='6/16/2027 2:30:00 PM'` + America/Chicago DST(-5) = target `19:30:00Z` exactly. | Emit full local dateTime with DST-aware Central offset. Low. (Same fix as meta-area item.) |
| `CarePlan.activity.scheduledPeriod.end` | truly-unrecoverable | end = start + 30-min length; `PAT_ENC_APPT` has no length col; `APPT_LENGTH` empty/unshipped. | Honest absence. Low. |
| `Practitioner/Patient.identifier[].type.text` ("EPIC"/"APL" alignment artifact) | tolerance-candidate | Alignment artifact: target carries an identifier type we don't, colliding at type.text. EPIC `.60` id not shipped; MRN-label cosmetic. | Pair identifiers by system/value before comparing; residual EPIC-type unrecoverable, MRN-label cosmetic. Low. |

---

## 3. OPPORTUNITIES (prioritized — residual we could still close)

Ranked by value (leaves closed × confidence × low risk). All are
recoverable/approximatable/tolerance-candidate.

### Tier 1 — high leverage, do these first

1. **Type-indexed reference-isomorphism tolerance (~544 + ~143 DocRef + ~78 MedReq leaves).**
   Generalize the existing iso-ref predicate (resolve both refs, require equal
   natural key: CSN / PAT_ID / SER / accession-by-ORDER_PROC_ID / Org / Condition-key)
   to ALL reference scopes instead of one hand-written rule per path. This single
   change reclassifies the **bulk of the ~544 unsure reference leaves** plus the
   DocumentReference (~143) and MedicationRequest (~78) families to TOLERATED.
   Keep the fail-closed equality so a re-point to a different entity still GAPs.
   *Effort: medium. The biggest residual reduction available.*

2. **Vitals BP component LOINC 8480-6 / 8462-4 (18 coding + 18 text = 36 leaves).**
   Add 2 component-level rows to the BP measure crosswalk, keyed on the
   systolic/diastolic split we already perform. Highest-yield, lowest-risk *data*
   recovery in the observation-values cluster. *Effort: medium.*

3. **`ServiceRequest` resource for `Observation.basedOn` (38 leaves).**
   Add `src/servicerequest.ts` (one per resulted ORDER_PROC), repoint basedOn to a
   literal reference, register an iso-ref tolerance on the placer id. Also removes
   Epic's own dangling SR reference. *Effort: medium.*

4. **Patient/provider display from PREFERRED name (one central change, many leaves).**
   `ids.ts patientDisplay()` → prefer `PATIENT_3.PREFERRED_NAME` ("Josh") for the
   first-name slot. Fixes every `*.subject/patient/beneficiary/subscriber.display`
   ("Mandel, Josh C") at once. *Effort: low.*

5. **Lab `code.text` proper-case from our own crosswalk (~37 leaves).**
   Have the answer-key applier set `code.text` from the matched `concept_display` /
   LOINC display (data already in `crosswalk/lab.csv`, currently unused for text).
   *Effort: medium.*

### Tier 2 — cheap, deterministic, exact

6. **`CarePlan.activity.scheduledPeriod.start` (1 leaf, EXACT).** Replace
   `.slice(0,10)` with `chicagoToISO(PROV_START_TIME)` → byte-matches target. One
   line. *Low.*
7. **`Encounter.location.display` from `CLARITY_DEP.EXTERNAL_NAME` (4 leaves, EXACT).**
   Prefer EXTERNAL_NAME over DEPARTMENT_NAME. *Low.*
8. **`MedicationRequest.courseOfTherapyType` = constant "acute" (18 leaves).** Emit
   the fixed coding+text default. *Low.*
9. **`AllergyIntolerance.category[]` derivation (6 leaves).** Map the 4 allergens to
   food/medication/biologic. *Low.*
10. **`Organization` NPI from `CLM_VALUES` (recoverable, 2 leaves).** Join billing
    Org → claim-value tables. *Medium.*
11. **`AllergyIntolerance` status `coding.version="4.0.0"` (8 leaves).** Constant
    stamp. *Low.*

### Tier 3 — generators (more effort, larger but partial)

12. **CarePlan narrative generator (`text.status`+`text.div`, longitudinal).**
    Generate from our own `addresses/goal/activity`; bless a div-byte tolerance.
    *Medium.*
13. **CareTeam generator from `PAT_PCP` (whole-resource + role.text).** *High.*
14. **DocRef back-fill from full `HNO_INFO` (23 whole-resource DocRefs).** *High.*
15. **`observation-flowsheet-id` coding from raw `FLO_MEAS_ID` (414 system leaves).**
    system+code recoverable (display too); the encoded token stays unrecoverable, so
    pair with a tolerance. High leaf count but only partial credit. *Medium.*
16. **MedicationRequest dose/route/supply from `ORDER_MED.HV_DISCRETE_DOSE` (~40 leaves).**
    Route to the medication cluster. *Medium.*
17. **Cosmetic-tolerance sweep** (de-id name renders, case-fold org/name,
    whole-minute timestamp precision, Epic-local class code, `*_C_NAME` stripped
    proprietary OID codings). Bulk of the remaining tolerance-candidate leaves;
    blessed by rule, not chased. *Low each.*

---

## 4. The TRULY-UNRECOVERABLE Floor

**Floor size: 2091 leaves (49.2% of the 4252 ex-smartdata residual)** are
provably not recoverable from this EHI export even with the answer key. These are
not generator bugs — the data physically is not in the extract (or recovering it
would defeat de-identification / violate the FHIR spec).

Largest unrecoverable components, with proof:

| Item | Leaves | Proof |
|---|---:|---|
| `DiagnosticReport.code.coding[].system` (order-compendium OID fan-out) | 1043 | `find-concept "compendium"/"order compendium"/"procedure catalog"` = 0 cols; `--grep "LIPIDP"` = no table; `CLARITY_EAP` shipped with 2 cols (PROC_ID, PROC_NAME). Standard CPT+LOINC already emitted. |
| `Observation.(whole resource)` SmartData exam | 130 (118 smartdata + 12) | `SMRTDTA_ELEM_DATA` absent from `ehi.sqlite` ("no such table"). |
| `Encounter.type[].coding[].system` + `.text` | 72 + 62 | No populated enc-type col in `PAT_ENC`; only `REFERRAL_2.RFL_ENC_TYPE_C_NAME`; value scan finds the labels only in note/proc tables. |
| `Medication.code.coding[].system` = ATC | 69 | `--grep "whocc"` = no table; external WHO classification not stored. |
| `DocumentReference.type.coding[].system`/`content.url`/`custodian.identifier`/`userSelected` | 56+56+56+28 | proprietary type OID & `urn:ihs:ce-prd` (Care Everywhere config) & Binary blobs all absent (`--grep "ce-prd"`=0; `find-concept "Binary"`=flag only). |
| `*.encounter.display` (Office Visit/Lab/Telephone naked labels) | 52+40+20+18+14 | proprietary enc-type label `.698084.30`; no source column. |
| `Practitioner.identifier[]` EPIC enterprise id (value/system/use/type) | 31+30+27+21 | `CLARITY_SER` has no enterprise-id col; `--grep "9005828432002"` = no table. |
| Appointment-slot end/length (`Encounter.period.end`, `participant.period.end`, `CarePlan.scheduledPeriod.end`) | 17+14+1 | `PAT_ENC_APPT` has only PROV_START_TIME; all `APPT_LENGTH`/`slot`/`duration` cols empty/not-shipped. |
| `Observation.valueCodeableConcept.text` "Regular (Adult)" + survey/exam value labels | 11 + scattered | answer-list display dictionary unshipped; "Regular (Adult)" 0× in sqlite. |
| `Practitioner.active` / `.gender` / `.name.prefix` | 21 + 7 + 7 | `CLARITY_SER` 3 cols only; `find-concept active`/`gender`/credential = no provider-status/sex/title col. |
| Hospitalization admit `period.start` seconds + other minute-truncated instants | scattered | every source instant col minute-truncated (proven per-table). |
| Remainder (proprietary `*_C_NAME` codes already-as-tolerances where code stripped, panel-header survey referents, ATC, etc.) | balance to 2091 | per per-area proofs above. |

> **NOTE-CORPUS correction.** An earlier draft of this floor listed *"CarePlan
> patient-instruction text"* among the unrecoverable remainder. That was a NOTE-CORPUS
> blind-spot error: the prior search scanned only `raw/EHITables/*.tsv`. The three
> "Patient Instructions" CarePlans' defining free text is present verbatim in the linked
> note RTFs (`raw/Rich Text/HNO_{3820384431,4024965334,4216859306}_*.RTF`; verify with
> `bun tools/find-concept.ts --grep 'topiramate' --notes`), so that content is
> **recoverable-as-narrative**, not unrecoverable. Those plans were characterized for
> completeness and are NOT in the 4252 ex-SmartData partition, so the floor *count*
> (2091) is unchanged — only the floor *narrative* is corrected (the structured/discrete
> `DISCRETE_PAT_INSTRUCTIONS` field, as distinct from the prose, remains unrecoverable).

**SmartData is the dominant *known set-aside***, but note it is deliberately
excluded from this 2091 floor (the floor is the ex-smartdata residual). The
SmartData set-aside is **118 leaves** = the difference between the
with-SmartData (4370) and ex-SmartData (4252) residuals. Its proof:
`SMRTDTA_ELEM_DATA` is not present in `ehi.sqlite` (querying it errors "no such
table"); the table was simply not selected for this EHI extract. It is an
export-config request, not a generator defect. Adding the 118 SmartData
whole-resource gaps to the 2091 ex-smartdata floor gives a **total
unrecoverable-from-this-export floor of 2209 leaves**.

---

## Summary (return values)

> **Round-4 current ledger (2026-06-17):** ex-SmartData answer-key residual is now **2064 GAP**
> (down from 4252 when the four-verdict split below was authored). Authoritative current floor split:
> **`compare/CODING-FLOOR-AUDIT.md` → FLOOR 1154 / MOVABLE 336 / UNSURE 574.** The four-verdict
> counts immediately below are the historical baseline; the families they describe still hold.

**Four-verdict counts (ex-SmartData, total 4252):**
- truly-unrecoverable: **2091**
- tolerance-candidate: **1238**
- approximatable: **809**
- recoverable: **114**

**Top 5 opportunities:**
1. Type-indexed reference-isomorphism tolerance (~544 unsure ref leaves + ~143 DocRef + ~78 MedReq → TOLERATED).
2. Vitals BP component LOINC 8480-6/8462-4 (36 leaves; highest-yield data recovery).
3. ServiceRequest resource for Observation.basedOn (38 leaves; removes dangling ref).
4. Patient/provider display from PREFERRED_NAME — one `ids.ts` change fixes every subject/patient display.
5. Lab `code.text` proper-case from our own `crosswalk/lab.csv concept_display` (~37 leaves).

**Truly-unrecoverable floor: 2091 leaves (ex-SmartData, 49.2% of residual);
2209 including the 118 SmartData whole-resource set-aside.** Dominated by the
1043-leaf DiagnosticReport order-compendium OID fan-out; SmartData
(`SMRTDTA_ELEM_DATA` not shipped) is the dominant known set-aside.
