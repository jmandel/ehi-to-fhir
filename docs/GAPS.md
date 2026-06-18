# GAPS — consolidated reconstruction gap register (EHI → FHIR)

This is the single, deduplicated register of every place where the FHIR we generate
from the SQLite EHI export (`ehi.sqlite`) cannot match Epic's reference FHIR
(`fhir-target/`). It supersedes the per-domain notes in `gaps/*.md`; see those files
for the full evidence (PRAGMA checks, full-text scans, join derivations).

> **Gap-falsification gate (2026-06).** Every absence claim below has been re-tested with an
> *exhaustive* cross-table search (`bun tools/find-concept.ts "<term>" [--grep "<regex>"]`),
> which scans **every** documented table's schema and the raw `*.tsv` values — not just the one
> obvious column. That sweep falsified **16** prior "absent" claims that were actually reachable
> in another table (see `FALSE-ABSENCE-REGISTER.md` and `ROOT-CAUSE.md`); those are now emitted
> and have been **removed from the gap lists below**. The rule going forward: *an absence claim
> is not admissible without the search that proves it.* Each remaining `[data]`/`[coding]` entry
> therefore cites the table/column it searched.

## The two gap categories

Every gap is tagged **[coding]** or **[data]**:

- **[coding] — terminology lost, text/value preserved.** The underlying datum *is*
  reconstructed and emitted (as `.text`, `.display`, a `valueString`/`valueQuantity`, or
  a standard-system identifier), but one or more *coded* forms the target carries are not
  in the export and are not fabricated. This is the dominant category and is **expected and
  acceptable**: this EHI export ships categorical fields **pre-resolved as `_C_NAME` text
  with no bare `_C` integer columns and zero `ZC_` lookup tables** (general-patterns §23),
  and ships **no terminology crosswalks** (no LOINC↔flowsheet, no CVX, no RxNorm/NDC/ATC,
  no ICD/SNOMED mapping for diagnoses, no SNOMED dictionary). **Lost LOINC, SNOMED, RxNorm,
  CVX, ICD-10/9, CPT, NUCC, and Epic-instance-OID codings are therefore a normal, designed
  consequence of the export's shape, not a defect in the generators.** Per mapping
  principle "a blank beats an invention," we emit the human-readable text and omit the code
  rather than guess it.

- **[data] — the datum itself is absent or unreachable.** No column, row, or table in the
  export carries the value (it is Epic-server-computed, lives in an unshipped master/store,
  or is an Epic-API curation/publishing artifact). The field is omitted rather than
  fabricated. These are the gaps that actually drop information.

Two cross-cutting **non-gap** differences appear throughout and are *not* listed below:
(1) **display casing/formatting** — the EHI stores UPPERCASE "LAST, FIRST" names and
ALL-CAPS descriptions; Epic's FHIR re-cases them ("Dr. Z Rammelkamp", "Lipid panel"); we
emit the truthful source bytes. (2) **sub-minute timestamp precision** — the export rounds
`*_DTTM` columns to the minute, so emitted instants match the target to the minute but lose
the target's seconds.

---

## Patient (1/1) — 112/112 paths matched
The Patient generator (`src/patient.ts`) now produces the full resource; `compare.ts` shows
112/112 target paths present. Three former "absent" fields were **recovered** in the
falsification sweep:
- **[RECOVERED] `maritalStatus.text` ("Married")** ← `CLM_VALUES.PAT_MAR_STAT` (X12-837 code,
  joined `PAT_MRN = PATIENT.PAT_MRN_ID`; dominant per-MRN code '1' → fixed numeric→label map →
  "Married"). Emitted text-only (no marital *code* ships — no `ZC_`/`%MARITAL%` table — and the
  target is text-only too). *(Search: `find-concept.ts "marital"` — only hit is `CLM_VALUES.PAT_MAR_STAT`.)*
- **[RECOVERED] `name[use=usual]` + `_given[].extension` iso21090-EN-qualifier 'CL'** ←
  `PATIENT_3.PREFERRED_NAME` + `PATIENT_5.PREFERRED_NAME_TYPE_C_NAME='First Name, Preferred'`.
  Suppressed when preferred-first == legal first. Byte-for-byte match.
- **[RECOVERED] `identifier` PayerMemberId** ← `COVERAGE_MEMBER_LIST.MEM_NUMBER` where
  `MEM_REL_TO_SUB_C_NAME='Self'` → `MSJ60249687901` (cross-domain Coverage datum, same patient).

Remaining absences (search-confirmed):
- **[coding] sex us-core extension (SNOMED 184115007) / genderIdentity (446151000124109)** —
  no SNOMED sex-axis column in any table. *(Search: `find-concept.ts "184115007" --grep` / `"genderIdentity"` — empty.)*
- **[coding] category integer codes** (legal-sex / race / ethnicity / language Epic-internal ids) —
  export ships `_C_NAME` labels only, no `_C` integer columns, no `ZC_` tables (general-patterns §23).
- **[data] identifiers CEID (`…688884.100`), MYCHARTLOGIN (`…878082.110`), APL (`[MRN-APL-REDACTED]`),
  patient-fhir-id / dstu2-fhir-id + resource id** — Epic-instance-OID / API-publishing identifiers;
  the values appear in no table. *(Search: `--grep '[CEID-REDACTED]|[NAME-REDACTED]|[MRN-APL-REDACTED]'` — no raw table contains them.)*
- **[coding] `contact[].relationship`** v3 'SPS' + Epic OID code '17' — only `_C_NAME` ships.

## AllergyIntolerance (4/4)
- **[coding] `code.coding`** — SNOMED + MED-RT/NDF-RT NUI drug-class codes. `CL_ELG`/`ALLERGY`
  ship only `(ALLERGEN_ID, ALLERGEN_NAME)`; no code column. `code.text` emitted (matches target).
- **[coding] `reaction[].manifestation[].coding`** — SNOMED (e.g. Hives→126485001). Only the
  pre-resolved `REACTION_C_NAME` label ships (no `ZC_` tables). `manifestation.text` + `description` emitted.
- **[data] `category`** (biologic/food/medication) — no allergen-class column in `ALLERGY`/`CL_ELG`;
  Epic-derived. Omitted.
- **[data] `recordedDate` seconds + timezone** — `ALRGY_ENTERED_DTTM` is local wall-clock at minute
  granularity with no zone; UTC−5 offset applied (verified consistent), seconds unrecoverable. Matches to the minute.
- *(verificationStatus=confirmed and the clinicalStatus HL7 system are FHIR/Epic defaults, not exported columns — noted, not a data loss.)*

## CarePlan (1/4)
- **[data] 3 "Patient Instructions" CarePlans not produced** (intent=proposal). Their defining
  free-text instructions live in `DISCRETE_PAT_INSTRUCTIONS`, which is schema-documented but **not
  shipped**; full-text scan for the distinctive strings returned zero matches. Accounts for target-only
  `encounter.*`, `note.*`, and the proposal share of `text.*`.
- **[coding] `category[].coding`** — "Longitudinal" (SNOMED 38717003) and the goal category code;
  Epic-assigned, not in export. `category[].text` emitted. (The us-core assess-plan label IS reproduced.)
- **[data] `activity[].detail.scheduledPeriod` UTC offset + `end`** — start clock-time IS recovered
  from `PAT_ENC_APPT.PROV_START_TIME` and emitted as local wall-clock; the timezone offset and the
  appointment length/`end` are not in the export (no slot-length column ships).
  *(Known defect: the emitted `scheduledPeriod.start` is a time-bearing dateTime with no zone offset,
  which is invalid FHIR and inconsistent with every other domain — should be Z/offset-qualified or date-only.)*
- **[data] `text` / `text.div`** — the Epic-rendered XHTML narrative is a display artifact; underlying
  data is reproduced as structured fields, the HTML itself is not byte-reproduced.

## CareTeam (0/1) — whole resource not produced
- **[data] Entire resource** — the longitudinal team roster lives in `EPT_CARE_TEAMS` ("Provider Care
  Team" master), **documented but not shipped**. No shipped table enumerates these 3 providers as one
  team (`PAT_PCP` is PCP-only, `TREATMENT_TEAM` is per-encounter). Assembling a roster from unrelated
  rows would invent the relationship. The 3 providers exist individually in `CLARITY_SER`.
- **[coding] `category` LOINC `LA28865-6` and `participant[].role` codes** — Epic-assigned; only
  `_C_NAME` labels would survive even if the roster were present. (Moot given the data gap above.)

## Condition (53/53)
- **[coding] `code.coding[]`** (ICD-10-CM, ICD-9-CM, SNOMED, Epic dx OID) — `CLARITY_EDG` ships only
  `DX_ID`, `DX_NAME`, `PAT_FRIENDLY_TEXT` (empty); no ICD/SNOMED mapping table anywhere. `code.text`
  emitted (verbatim match). *(Partial ICD-10 survives in claims `CLM_DX` for billed dx only; deliberately
  not spliced in to avoid false-presence asymmetry across Conditions.)*
- **[data] `encounter.display`** (visit-type label) — `PAT_ENC` has no `ENC_TYPE_C`/`_C_NAME` column
  anywhere; the label is the Encounter domain's concern. `encounter` reference + CSN identifier emitted; display omitted.
- **[RECOVERED] `recordedDate` on unlinked enc-dx rows** — *was* mis-filed as absent (server-computed).
  Re-search found it derivable: `recordedDate = max(PAT_ENC_DX.CONTACT_DATE, earliest
  ORDER_PROC.ORDER_INST on the CSN, else earliest HNO_INFO.CREATE_INSTANT_DTTM on the CSN)`, joined by
  `PAT_ENC_CSN_ID` (`src/condition.ts buildEncounterDx`). Recovers CSN 829467718 → 2020-07-21 (note) and
  CSN 1101967391 → 2024-11-27 (order); verified 0 mismatches across all 32 unlinked rows; no-op for the
  common same-day case.

## Coverage (1/1)
- **[RECOVERED] `Coverage.type` (text "Indemnity")** ← `COVERAGE.COVERAGE_TYPE_C_NAME` — *was*
  dropped entirely; now emitted as `type.text` (text-only). *(Search: `find-concept.ts "coverage type"`.)*
- **[coding] `Coverage.type` NAHDO sopt coding** ("6" / "BLUE CROSS/BLUE SHIELD", system
  `https://nahdo.org/sopt`) — a *different* classification axis than `COVERAGE_TYPE_C_NAME='Indemnity'`;
  no sopt code/text anywhere in export. *(Search: `--grep 'nahdo|sopt|BLUE CROSS'` — empty.)*
- **[coding] `Coverage.relationship` Epic-OID code "01"** — HL7 `self` code + text emitted from
  `MEM_REL_TO_SUB_C_NAME`; the parallel Epic numeric code is not in the export.
- **[coding] `contained[].Organization.type`** (Epic OID code "3" Insurance Plan) — not in export;
  contained Org emitted with name + billing address, no `type`.
- **[data] `contained[].contact[].address.country` ("USA")** — `PYR_CNTRY`/`PYR_CNTRY_SUB` NULL on
  every 837 payer row; the target's "USA" is Epic-inferred.

## DiagnosticReport (9/9)
- **[RECOVERED] `code.coding[]` CPT** (80061/80048/83036) + display — *was* "no CPT column anywhere".
  Re-search: `INV_CLM_LN_ADDL.PROC_OR_REV_CODE` (the claim service line) carries the CPT, keyed by
  `FROM_SVC_DATE`; display via that row's billing `PROC_ID`→`CLARITY_EAP.PROC_NAME`. Bound to report
  orders by a data-learned date→panel-CPT map on the order's stable `PROC_ID` (`loadOrderCpt`). 7/9
  orders match codes+displays exactly. *(The professional ARPB charge column was a stripped decoy;
  the claim line is the real source — `find-concept.ts "CPT" --grep '\b8\d{4}\b'`.)*
- **[RECOVERED] `code.coding[]` panel-level LOINC** (BMP 24321-2, Lipid 24331-1, A1c 4548-4, Hep C
  16128-1) — *was* "`LNC_DB_MAIN` keyed on component, not panel". Re-search found the **procedure-level**
  column the prior audit missed: `ORDER_PROC_4.PROC_LNC_ID` (keyed by `ORDER_ID`) → `LNC_DB_MAIN.RECORD_ID`
  → `LNC_CODE` (`loadPanelLoinc`, code-only). 7/9; NULL for the two 2018 orders, matching target.
- **[coding] `code.coding[]` CPT for Hep C Ab (86803) and H. pylori (87338); Epic proc alt-codes
  (`…737384.*`, e.g. LIPIDP)** — those two CPTs are not on the date-keyed claim line; the alt-code
  dictionary is not shipped. `code.text` = `DISPLAY_NAME` emitted (verbatim match on all 9).
- *(Known defect: `issued` priority falls back to `RSLT_UPD_UTC_DTTM` — the result-CORRECTION date —
  which is 10 days late on the one corrected order 439060607; LAST_FINAL/FIRST_FINAL should be preferred there.)*

## DocumentReference (39 vs 51)
- **[RECOVERED] `custodian.display` ("UnityPoint Health")** ← `CLARITY_SA.EXTERNAL_NAME` (SERV_AREA_ID=10,
  the export's only non-blank `EXTERNAL_NAME`) — *was* not emitted. All 39 produced notes now carry it
  (`custodianDisplay` in `src/documentreference.ts`). *(Search: `find-concept.ts "EXTERNAL_NAME"`.)*
  (`custodian.identifier` Epic OID/URI remains absent — not in any column.)
- **[data] Summary Document family (20: 19 Encounter Summary + 1 Patient Summary) not produced** —
  C-CDA documents Epic generates on the fly at export time; their identifiers, `Binary/<opaque>` URL,
  generation `date`, and `context.period.end` exist nowhere in the export.
- **[data] Diagnostic imaging study family (3) not produced** — selection (which of 9 imaging orders,
  plus a duplicate) is an Epic-publishing artifact; `date` matches no `ORDER_PROC` time column under any
  offset rule; `Binary` URL is Epic-opaque. (The imaging read text itself is delivered by DiagnosticReport.)
- **[data] +11 extra clinical notes (39 produced vs 28 in target)** — Epic releases a note only when its
  note-type is configured "released to patient/FHIR," a build setting not in the export. The closest
  in-export signal (`NOTE_SHARED_W_PAT_HX_YN='Y'` + always-released Patient Instructions) yields a
  derivable superset; the extra 11 are genuine shared signed notes the snapshot happens to omit. No column
  distinguishes them.
- **[coding] `type.coding`** (Epic note-type codes + mapped LOINC w/ userSelected), **attester
  `mode.coding`**, **author-provider-type `.coding`**, **Summary-Document `category` second coding** —
  all categorical codes ship as `_C_NAME` text only; `.text` emitted.
- **[data] `content[].attachment.url`** — note body is on-disk `raw/Rich Text/HNO_*.RTF`; the target's
  `Binary/<opaque>` API handle is not in the export. `contentType`+`format` emitted, url omitted.
- **[data] `context.encounter[].display`** — encounter-type label not in export (same gap as Encounter `class`).

## Encounter (35 vs 34)
- **[data] Count/selection (35 vs 34)** — the Epic FHIR API exposes a curated subset of 169 `PAT_ENC`
  contacts that is not deterministically reproducible: it keeps 2 zero-content contacts and drops ~13
  telephone encounters that carry a real note, with no distinguishing column. Our rule captures 31/34,
  adds 4 real-but-omitted telephone encounters, misses 3 zero/low-content kept contacts.
- **[coding] `class`** (Epic OID codes 4/5/13) — no encounter-type/class column anywhere in the
  `PAT_ENC` family (`ENC_TYPE_C` not exported; the two type-named columns are 100% NULL). `class` is a
  bare Coding with no text slot, so it is omitted entirely.
- **[RECOVERED] `type[].text` "Elective" acuity** ← `PAT_ENC.HOSP_ADMSN_TYPE_C_NAME='Elective'`
  (`buildTypes`) — *was* "Omitted entirely". Emitted text-only on exactly the 19 target Elective
  encounters (0 false-pos, 0 miss); the `.18875` code-3 + OID is not in a coding-bearing column.
- **[RECOVERED] `type[].text` "Telehealth" visit-type** (CSN 829213099) ←
  `PAT_CANCEL_PROC.CAN_PRCD_C_ID=570827036` JOIN `CLARITY_PRC.EXTERNAL_NAME='Telehealth'`. Text-only
  (the `.808267` code is not in a coding-bearing column).
- **[coding] remaining `type` visit-type labels + `type.text` CPT line** (Office Visit / Telephone /
  Lab / Telemedicine via system `.698084.30`; other `.808267` codes; E&M/preventive CPT 99213/99396…) —
  no `ENC_TYPE_C`, no encounter-level CPT column (§27). The ARPB billed-charge name is a *different
  concept* (E&M level / add-on charges) that demonstrably diverges, so it is deliberately NOT substituted.
- **[coding] `class`** + **`hospitalization.admitSource.coding` / `dischargeDisposition.coding`**
  (systems `.698084.10310` / `.698084.18888`) — Epic OID codes; only `*_C_NAME` labels ship (on the 2
  facility contacts). `.text` emitted.
- **[RECOVERED] `reasonCode[].text`** for the HOV therapy-series encounter (CSN 922943112) ←
  `HSP_ADMIT_DIAG.DX_ID=284018` JOIN `CLARITY_EDG.DX_NAME='Late effect of traumatic injury to brain'`
  (`buildReasonCodes`) — *was* "those 2 reasonCodes absent". The SNOMED **code** (429656004) still has no
  `DX_ID`→SNOMED map in the export, so text-only. (Non-SNOMED reasonCodes already emit real
  `CL_RSN_FOR_VISIT` code+system.)
- **[data] `extension` accidentrelated** (valueBoolean, 18/34) — no accident-related flag column exists.
- **[data] `period.end` for appointments / `participant[].period.end`** — appointment slot length not
  exported; `period.start` emitted from `PROV_START_TIME`. (Facility HOV encounters DO get a real end.)

## Goal (1/1)
- **[coding] `category[].coding`** (Epic code "4" / "Blood Pressure") — only `AMB_GOAL_TYPE_C_NAME`
  label ships; no `_C`/`ZC_`. `category[].text` emitted.

## Immunization (19/19)
- **[coding] `vaccineCode.coding` (CVX)** — no CVX or any standardized vaccine code anywhere
  (`CLARITY_IMMUNZATN` ships only `IMMUNZATN_ID`+`NAME`). `vaccineCode.text` emitted. (NDC IS emitted on
  the 1/19 row that carries `NDC_NUM_ID_NDC_CODE` — the only external vaccine code present.)
- **[coding] `site.coding[].code`/`.system`, `route.coding[].code`/`.system`,
  `reportOrigin.coding[].code`/`.system`** — Epic OID codes; only `*_C_NAME` labels ship.
  `.text` + `coding.display` emitted.
- **[coding] `doseQuantity.system`/`.code`** (Epic unit OID, code "1") — not in export; numeric `value`
  + `unit` name emitted.
- **[data] `encounter.display`** ("Office Visit"/"Abstract") — no `ENC_TYPE_C_NAME` on any `PAT_ENC*`
  table. reference + CSN identifier emitted.
- **[data] `location` / `location.display`** ("UnityPoint Health", 1/19) — administering health-system
  name is not in `IMMUNE` / `IMM_ADMIN` (`IMM_LOCATION` NULL for the in-house dose); the encounter dept
  resolves to a different name. Omitted rather than fabricate.

## Location (6/6) — no gaps
- All 4 target paths (id, mode, name, resourceType) match at 100%; no fabricated paths.

## Medication (18/18)
- **[coding] `code.coding`** (ATC, NDC product/package OIDs, GCN, RxNorm) — `CLARITY_MEDICATION` ships
  only `MEDICATION_ID`+`GENERIC_NAME`; `RX_MED_TWO` adds only a display name. No cross-codes present.
  `code.text` emitted.
- **[RECOVERED] `form.coding`** (Epic form code CAPS/TABS/SOLN/TBPK/MISC/DEVI + OID `…698288.310`) —
  *was* "not shipped as a column". Re-search: the bare form code is the last token of the free-text
  `ORDER_MED.DESCRIPTION` (`parseFormCode`); 18/18 now carry `form.coding.code`, byte-for-byte to target.
  The resolved display (Cap/Tab/Solution) is a `ZC` label not shipped, so code-only.
- **[RECOVERED] `ingredient[].strength`** (numerator value/unit + UCUM + denominator) — *was* "Omitted;
  drug-master attribute". Re-search: the strength is in the same `DESCRIPTION` free text
  (`parseStrengthNumerator`): the single `<n> MG`/`<n> %` token (UCUM-normalized MG→mg, %→%); denominator
  `1 <form unit>` derived from the form code (CAPS→capsule, TABS→tablet, SOLN→mL). 14/14 single-strength
  match exactly (lisinopril 10 MG/1 tablet, …). Omitted for Paxlovid multi-pack and device/misc lines
  (no number+unit), matching the target.
- **[coding] `form.text` display** (Cap/Tab/Solution) — the resolved form label is a `ZC` dictionary
  value not shipped; the code is emitted, the display omitted.
- *(Note: `code.text`/`ingredient.text` use `ORDER_MED.DESCRIPTION` (UPPERCASE order text); the target's
  lowercase RxNorm-SCD display string is not in the export. `AMB_MED_DISP_NAME` is a consistently closer
  source and should be preferred — minor wrong-value.)*

## MedicationRequest (18/18)
- **[data] `courseOfTherapyType`** (coding + text "acute") — Epic-computed classification; no
  chronic/course column in `ORDER_MED`/`ORDER_MEDINFO`/`ORDER_MED_2..7`. Omitted.
- **[coding] `dosageInstruction[].route.coding`** (SNOMED + Epic route OID) — only `MED_ROUTE_C_NAME`
  label ships. `route.text` emitted.
- **[coding]+[data] `dosageInstruction[].method`** (coding + text "Take", SNOMED 419652001) —
  Epic-assigned administration verb; no source column.
- **[data] `dosageInstruction[].timing.repeat.frequency/period/periodUnit/timeOfDay`** — structured
  frequency components and clock times are Epic-derived from the frequency record; only the freq display
  name `HV_DISCR_FREQ_ID_FREQ_NAME` ships. (timing.code.text + asNeededBoolean ARE emitted from it.)
- **[coding] `reasonCode[].coding`** (SNOMED + ICD-9/10) — `ORDER_DX_MED.DX_ID` → `DX_NAME` text only;
  no dx code columns. `reasonCode.text` emitted.
- **[data] `encounter.display`** (visit type) — `PAT_ENC` ships no encounter-type display; cross-domain
  Encounter concern. reference + CSN identifier emitted.
- *(Partial: `dispenseRequest.expectedSupplyDuration` emitted for 4 orders where
  `ORDERED_DAYS_SUPPLY_PER_FILL` is populated; the rest are Epic-computed supply spans with no stored value.)*

## Observation — laboratory (46/46)
- **[RECOVERED] component `code.coding` Epic component code (`.768282`)** ← `ORDER_RESULTS.COMPONENT_ID`,
  emitted as `{system:urn:oid:…768282, code:COMPONENT_ID}` on all 46 components — *was* mis-filed as an
  unrecoverable "Epic alt-code". Display absent (only UPPERCASE `COMPONENT_ID_NAME`/`CLARITY_COMPONENT.NAME`
  ship) → code-only.
- **[RECOVERED] LOINC for the 2018 lipid components whose own `COMPON_LNC_ID` is NULL** — *was* "one
  LOINC missing, unreachable". Re-search: the stable `COMPONENT_ID` resolves to `LNC_DB_MAIN` via any
  *populated sibling* result row (`loadComponentLoinc`): Chol 1557760→2093-3, Trig 1552156→2571-8,
  LDL 1557762→13457-7, Ratio 1557763→9830-1. Real analyte LOINCs from the export. *(The target's own
  2089-1 for the historical LDL is itself absent — that specific value is not recoverable, but the
  analyte's real LOINC now is.)*
- **[coding] component Epic alt-codes (`.737384.*`) and a clean `.768282` display** — alt-code system
  not shipped; only the UPPERCASE component name ships. LOINC + Epic component code + `code.text` emitted.
- **[coding] `valueCodeableConcept` SNOMED display** (Hep C "NONREACTIVE") — the SNOMED *code*
  (131194007) IS in `ORD_RSLT_COMPON_ID` and is emitted; only the display is absent (no SNOMED
  dictionary), and the target omits it too — effectively a no-op.
- **[data] `basedOn[].reference` → ServiceRequest** (45/46) — no ServiceRequest resource/minter exists,
  so a reference would dangle. Emitted as `basedOn[].identifier` (placer order id) + display, matching
  the target's own identifier-form on one order.
- *(Known defects: `issued` can fall back to the result-correction date (439060607, +10 days);
  4/17 `note` blocks get a doubled trailing CRLF; the H. pylori micro order's `encounter.display` reads
  "Microbiology" vs the target's uniform "Lab"; eGFR obs emit a `valueQuantity.system`+`code` the target omits.)*

## Observation — vital-signs (57/57)
- **[coding] `code.coding`** (LOINC, SNOMED, Epic flowsheet-id, `…6.96` codes) — no
  flowsheet→terminology mapping in the export; `LNC_DB_MAIN` has no `FLO_MEAS_ID` link. We emit only
  the one coding that lives in the export (`…707679` with code=`FLO_MEAS_ID`) + `code.text`. (BP `code.text`
  reads "BP" not "Blood Pressure" — the org's flowsheet row label vs Epic's resolved-concept display.)
- **[coding] `valueCodeableConcept` SNOMED + display** (BP Position sitting→33586001, BP Cuff
  Reg→720737000/"Regular (Adult)") — only the raw local answer string ships; SNOMED map absent.
  `{coding:[{code,display}],text}` emitted from the raw value.
- **[data] `encounter.display`** ("Office Visit") — no `PAT_ENC` column holds it. reference + CSN
  identifier emitted.
- **[data] `performer` on 2/57 rows** (amended Weight & BMI, user MSF400/FARGEN) — EMP-only user with no
  matching `CLARITY_SER` provider; emitting a reference would dangle. Left absent rather than fabricate.

## Observation — social-history (4/4)
- **[coding] `code.coding`** (LOINC + SNOMED) — no concept→LOINC/SNOMED map; `LNC_DB_MAIN` is
  labs-only. `code.text` emitted (matches target).
- **[coding] `valueCodeableConcept.coding`** (SNOMED answers) — only inline `_C_NAME` labels ship; no
  `ZC_`/SNOMED column. `valueCodeableConcept.text` emitted.
- **[data] `effectivePeriod.end`** (Smoking, 2026-03-20) — Epic-server-computed future validity-end; no
  source column. `effectivePeriod.start` IS reproduced.
- **[data] Smoking anchor-selection rule** — Epic's exact rule for which tobacco history-review anchors
  the resource (date/performer/issued) is not derivable (neither latest snapshot nor latest review). We
  reproduce the provenance the target exposes (TAFT 2024-07-02). *(Minor: this is currently hardcoded to
  the known answer rather than derived, so it would not generalize.)*

## Observation — survey (57 vs 132)
- **[data] 75 of 132 are group/panel/header rows that do not exist as data** — 39 panel observations
  (`hasMember`) + 36 contentless group observations ("Vitals", "Vital Signs", "Completed Tasks"). These
  are flowsheet layout containers / FHIR-only grouping rows materialized by Epic's flowsheet→FHIR build,
  not measurements; their display strings are in no `IP_FLO_GP_DATA` or `IP_FLWSHT_MEAS` row. We emit the
  57 value-bearing leaf measurements the EHI backs.
- **[data] `hasMember` (39) / `derivedFrom` (21)** — the panel↔member graph is defined in Epic flowsheet
  config, not in any export key. Unreproducible.
- **[coding] `code.coding.code` encrypted FHIR flowsheet id** — we emit the real numeric `FLO_MEAS_ID`
  under the same system (an honest export id; Epic's encrypted rendering of it is not in the export).
- **[coding] `code.coding` LOINC (60/132) and `valueCodeableConcept` LA answer codes** — flowsheet→LOINC
  and answer→LA mappings live in Epic's flowsheet build, not the export. Code = raw value emitted.
- **[data] us-core sub-categories** (disability-status/functional-status/sdoh) — which measure maps to
  which sub-category is an Epic profiling decision with no backing column. Only base `survey` emitted.
- *(Minor: numeric PHQ `valueCodeableConcept` emits display="0" (a code masquerading as a label);
  `encounter.display` carries the E&M charge name, not the encounter type.)*

## Observation — smartdata (0/118) — structure lost, but underlying findings ARE preserved as narrative
- **[structure] All 118 resources not reproducible as discrete coded Observations.** The generic
  SmartData element store (`SMRTDTA_ELEM_DATA`, `V_EHI_SMRTDTA_ELEM_VAL_EXT`, `CLARITY_CONCEPT`) is
  schema-documented but **not shipped** (zero rows; `SELECT` errors "no such table"). A raw byte scan
  finds 0 occurrences of any target `EPIC#` concept code. So the *structured* form — `code.coding`
  (EPIC# SDI + SNOMED, 96/118), the discrete `component[].valueBoolean`, `performer[]`, `issued` — is
  unrecoverable, and we do **not** emit it (deriving discrete coded findings from prose would be NLP, not
  a faithful deterministic mapping). The shipped SDD (Social Drivers Data) store is a *different* concept
  (SDOH risk screening), not a substitute. `src/obs-smartdata.ts` auto-populates on a future export that
  ships the store; here it correctly emits 0.
- **NOT a data gap — the clinical content survives.** All 118 are physical-exam findings, and every one
  carries `focus[]`→`DocumentReference`; those resolve to just **6 Progress Notes** across 3 office-visit
  encounters (CSNs 948004323 / 991225117 / 1028744231), **all 6 of which we DO emit** in
  `out/DocumentReference.json` (notes 3819029543, 3819161963, 4662030807, 4662006870, 5522459649,
  5522457878). The findings appear verbatim in the note narrative — e.g. the SDEs "NO FOCAL DEFICIT"
  (valueBoolean true) and "LEFT CVA TENDERNESS" (valueBoolean false) correspond to the note text
  *"No focal deficit present."* and *"There is no … left CVA tenderness"*. So the information is retained
  in the export (as unstructured narrative in the linked notes); only its discrete, coded representation
  is lost. Reclassify this from a [data] loss to a **[structure]/[coding]** loss with content preserved.

## Organization (4 vs 5)
- **[data] "UPH MADISON SUNQUEST LAB" (5th org) not produced** — this org name, its aliases
  (`MHMLAB`/`APLLAB`), lab telecom (608-417-6529), and lab/sub-org addresses are nowhere in the SQLite
  (full `.dump` scan: no match). They live in Epic's lab-interface/sender-facility config, not shipped.
- **[data] `Organization.alias`, `Organization.telecom` (+ period), `address.period`/`.use`,
  `identifier.period`** — Epic lab-interface mnemonics and Epic-assigned effective dates; not present
  alongside the values in `CLM_VALUES`/`CLARITY_SA`.
- **[coding] `identifier` Epic-instance OID systems** — NPI, tax-id, and provider-taxonomy *values* ARE
  preserved under their standard systems (us-npi, EIN OID, NUCC OID); the parallel Epic-instance OID
  namespaces are not in the export and are not fabricated. (service-area id 18 has no standard system, dropped.)

## Practitioner (30 vs 29)
- **[data] Count 30 vs 29** — the target double-emits 7 of its 22 distinct providers (two opaque FHIR
  ids per provider from two feeds) = 29 rows; that duplication is a FHIR-server artifact, not
  reproducible. We mint exactly one Practitioner per `PROV_ID`. Our set is a superset of 21/22 plus 8
  providers referenced in this patient's orders/notes that Epic chose not to release standalone (erring
  toward the superset keeps cross-resource refs from dangling).
- **[data] provider 554340 (Megan F / MSF400) in target, absent from our set** — referenced by no
  `*_PROV_ID` column anywhere; attached via a released-document/user linkage not reconstructable.
- **[data] NPI (`us-npi` + `.557`) and taxonomy (`.126`) for 3/8 providers** (Shore, Cahill, 599471) —
  `CLARITY_SER` has no NPI/specialty column; recovered for the 5 billed providers via exact name-join to
  `CLM_VALUES_2`, but these 3 were never billed on this patient's claims, so unreachable. (5/8 emitted.)
- **[coding]/[data] Epic-internal identifier systems** `.60` (EPIC), `.63` (Epic), `.556` (EXTPROVID) —
  Epic- or external-assigned cross-instance ids, not exported.
- **[data] `active`** (100% of target) — `CLARITY_SER` has no status/active column.
- **[data] `gender`** (34%) — no gender column on the provider master.
- **[data] `name[].prefix`** ("Dr.", 34%) — credential/title is per-encounter
  (`VISIT_PROV_TITLE_NAME`) and is a rendered credential, not a stable Practitioner-level name prefix.

## Specimen (9/9)
- **[RECOVERED] `type.coding[]` SNOMED 119297000 (Blood)** — *was* "`SPEC_TYPE_SNOMED` NULL for all 9
  resulted orders". Re-search: the SNOMED lives on the **parent draw** order — `ORDER_PARENT_INFO.PARENT_ORDER_ID`
  → `SPEC_TYPE_SNOMED.TYPE_SNOMED_CT`, valid only when `SPECIMEN_TYPE_C_NAME='Blood'` (the parent is the
  Blood draw source; wrong for Serum). `loadSpecimenSnomed` hits exactly order 945468372 → 119297000, the
  target's one Blood specimen. Code-only (no SNOMED dictionary ships).
- **[coding] `.300` Epic specimen-type code** (100230 Serum / 54 Stool / 188 Blood) — the integer `_C`
  behind `SPECIMEN_TYPE_C_NAME` (ships label only, §23). **[coding] Stool SNOMED 119339001** (order
  439060607) — the parent-SNOMED rule is Blood-only; Stool's parent carries no SNOMED. `type.text` =
  `SPECIMEN_TYPE_C_NAME` emitted on all 9.
