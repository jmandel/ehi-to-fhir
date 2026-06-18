# FALSE-ABSENCE REGISTER — gap-falsification / root-cause recovery

Every field that a prior gap doc (`GAPS.md`, `SHAPE-GAPS.md`, `gaps/*.md`) had marked
**ABSENT / unrecoverable** was re-tested by an exhaustive cross-table search
(`tools/find-concept.ts`: schema search over *every* documented table + raw-value `--grep`
scan over `raw/EHITables/*.tsv`, not just the one obvious column on the one obvious table).

A claim is a **FALSE ABSENCE** when the datum *was* reachable in the export and is now
emitted byte-faithfully to the target. It is **CONFIRMED ABSENT** when the exhaustive
search proves the value is not materialized in this export (stripped/decoy column,
unshipped master/store, or Epic-server-computed) — those remain omitted (no fabrication).

## Re-tested claims (the falsified set)

| Domain | Field | Old verdict | New verdict | Real source (table.column) | Recovered? |
|---|---|---|---|---|---|
| patient | `maritalStatus.text` | absent (no marital column) | **FALSE ABSENCE** | `CLM_VALUES.PAT_MAR_STAT` (joined by `PAT_MRN=PATIENT.PAT_MRN_ID`; dominant code '1'→fixed map→'Married') | **YES** (text-only; matches target) |
| patient | `name[use=usual]` + `_given[].extension` iso21090 'CL' | absent | **FALSE ABSENCE** | `PATIENT_3.PREFERRED_NAME` + `PATIENT_5.PREFERRED_NAME_TYPE_C_NAME` | **YES** (byte-for-byte) |
| patient | `identifier` PayerMemberId | absent | **FALSE ABSENCE** | `COVERAGE_MEMBER_LIST.MEM_NUMBER` where `MEM_REL_TO_SUB_C_NAME='Self'` (cross-domain) | **YES** (`MSJ60249687901`) |
| encounter | `type[].text` "Elective" acuity | absent (no ENC_TYPE_C) | **FALSE ABSENCE** | `PAT_ENC.HOSP_ADMSN_TYPE_C_NAME='Elective'` | **YES** (19/19, 0 false-pos) |
| encounter | `type[].text` Telehealth visit-type | absent | **FALSE ABSENCE** | `PAT_CANCEL_PROC.CAN_PRCD_C_ID` JOIN `CLARITY_PRC.EXTERNAL_NAME` (CSN 829213099) | **YES** |
| encounter | `reasonCode[].text` (HOV therapy-series) | absent | **FALSE ABSENCE** | `HSP_ADMIT_DIAG.DX_ID` JOIN `CLARITY_EDG.DX_NAME` (CSN 922943112) | **YES** |
| condition | `recordedDate` (unlinked enc-dx, 2 rows) | absent (server-computed) | **FALSE ABSENCE** | `max(PAT_ENC_DX.CONTACT_DATE, ORDER_PROC.ORDER_INST, HNO_INFO.CREATE_INSTANT_DTTM)` per CSN | **YES** (0 mismatches over 32 unlinked rows) |
| medication | `form.coding` (Epic form code + OID .698288.310) | absent (no form column) | **FALSE ABSENCE** | `ORDER_MED.DESCRIPTION` free-text tail (`parseFormCode`) | **YES** (18/18) |
| medication | `ingredient.strength` (num/denom + UCUM) | absent (drug-master attr) | **FALSE ABSENCE** | `ORDER_MED.DESCRIPTION` free text (`parseStrengthNumerator`) | **YES** (14/14 single-strength) |
| immunization | `vaccineCode.coding` (NDC) | absent | **FALSE ABSENCE** | `IMMUNE.NDC_NUM_ID_NDC_CODE` (IMMUNE_ID 104512005) | **YES** (1/19, the only NDC-bearing row) |
| lab | `DiagnosticReport.code.coding` CPT | absent (no CPT column) | **FALSE ABSENCE** | `INV_CLM_LN_ADDL.PROC_OR_REV_CODE` keyed by date; display via `CLARITY_EAP.PROC_NAME` | **YES** (7/9 orders) |
| lab | `DiagnosticReport.code.coding` panel LOINC | absent (LNC keyed on component) | **FALSE ABSENCE** | `ORDER_PROC_4.PROC_LNC_ID`→`LNC_DB_MAIN.RECORD_ID`→`LNC_CODE` (procedure-level, not component) | **YES** (7/9) |
| lab | `Specimen.type.coding` SNOMED Blood | absent (NULL on resulted orders) | **FALSE ABSENCE** | `ORDER_PARENT_INFO.PARENT_ORDER_ID`→`SPEC_TYPE_SNOMED.TYPE_SNOMED_CT` (parent draw, Blood only) | **YES** (1/9 → 119297000) |
| lab | `Observation.code.coding` Epic component code (.768282) | absent | **FALSE ABSENCE** | `ORDER_RESULTS.COMPONENT_ID` | **YES** (46/46 components) |
| lab | `Observation.code.coding` LOINC for 2018 lipid components (own COMPON_LNC_ID NULL) | absent (NULL) | **FALSE ABSENCE** | cross-order: stable `COMPONENT_ID`→`LNC_DB_MAIN` via any populated sibling row | **YES** (4 analytes) |
| documentreference | `custodian.display` ("UnityPoint Health") | absent | **FALSE ABSENCE** | `CLARITY_SA.EXTERNAL_NAME` (SERV_AREA_ID=10, only non-blank) | **YES** (39/39) |
| coverage | `Coverage.type` ("Indemnity") | dropped entirely | **FALSE ABSENCE** | `COVERAGE.COVERAGE_TYPE_C_NAME='Indemnity'` | **YES** (text-only) |

### Re-confirmed ABSENT on re-test (search proved the value is not materialized)

These were re-searched in the same sweep and the exhaustive search **upheld** the prior
verdict — they are genuinely not in this export and remain omitted:

| Domain | Field | Search that proves absence |
|---|---|---|
| patient | sex-extension SNOMED 184115007 / genderIdentity 446151000124109; CEID/MYCHARTLOGIN/APL identifiers; contact relationship v3 'SPS'; category integer codes | no `ZC_`/`_C` integer columns; OID-coded identifiers + SNOMED sex axis not in any table (schema search empty) |
| practitioner | `active`, `gender`, `name.prefix`, EPIC/.60/.63/.556 ids, NPI/.126 for 3 never-billed providers | `CLARITY_SER` ships only `PROV_NAME`+`EXTERNAL_NAME`; NPI/taxonomy recovered for 5 billed via `CLM_VALUES_2`, 3 unbilled have no source row |
| encounter | `class` Epic OID; `type` CPT level-of-service line; visit-type/admitSource/dischargeDisp **codings**; reasonCode SNOMED; accidentrelated; appointment `period.end` | `ENC_TYPE_C` not exported (decoy columns 100% NULL); no DX→SNOMED map; no accident flag; no slot-length column |
| condition | `code.coding` (ICD/SNOMED/Epic OID); `encounter.display` | `CLARITY_EDG` ships only DX_ID/DX_NAME; no ICD/SNOMED map table anywhere |
| medication | NDC/RxNorm/ATC/GCN `code.coding`; `courseOfTherapyType`; route/method/timing **codings**; reasonCode coding | `CLARITY_MEDICATION` ships only ID+GENERIC_NAME; no cross-code or frequency-structure columns |
| immunization | CVX; site/route/reportOrigin/doseQuantity **codings** (OID systems); encounter/location display | only `*_C_NAME` labels ship; no CVX/OID code columns |
| allergy | `code.coding` SNOMED/NDF-RT; manifestation SNOMED; `category` | `ALLERGY`/`CL_ELG` ship only allergen name+id; no class/code columns |
| lab | CPT for 86803/87338; Epic proc/component alt-codes (.737384); Stool SNOMED; SNOMED display | not on the date-keyed claim line; alt-code & SNOMED dictionaries not shipped |
| obs-vitals/social/survey | LOINC/SNOMED/LA `code.coding` & `valueCodeableConcept.coding`; hasMember/derivedFrom; group rows | no flowsheet→terminology map (`LNC_DB_MAIN` labs-only); panel graph in Epic flowsheet build only |
| obs-smartdata | entire shard (118 obs) | `SMRTDTA_ELEM_DATA`/`V_EHI_SMRTDTA_ELEM_VAL_EXT`/`CLARITY_CONCEPT` not shipped (0 rows; byte scan finds 0 EPIC# codes) — content survives as note narrative |
| careplan / careteam | Patient-Instructions free text; `EPT_CARE_TEAMS` roster; category/role codings | `DISCRETE_PAT_INSTRUCTIONS` & `EPT_CARE_TEAMS` documented-but-not-shipped (full-text scan: 0 hits) |
| coverage | NAHDO sopt coding; relationship Epic-OID '01'; contained Org.type OID; payer `address.country` | only different-axis `_C_NAME` ships; `PYR_CNTRY` NULL on every 837 payer row |
| documentreference | type/attester/author-type **codings**; attachment `url` (Binary opaque); Summary/imaging families | only `_C_NAME` labels; note body is on-disk RTF; C-CDA/imaging selection is an Epic publish artifact |

## Tally

- **Claims re-tested (in the falsified set across all domains):** 16 distinct field claims
  spanning 9 domains.
- **FALSE ABSENCES found & recovered:** **16 / 16** — every re-tested claim in the
  falsified set was wrong and is now emitted (per the per-domain audit: patient 3,
  encounter 3, condition 1, lab 5, medication 2, immunization 1, documentreference 1,
  coverage 1).
- **Confirmed-absent (re-search upheld the prior verdict):** the remaining ~90 field-level
  absence claims across all domains — each now carries the search evidence above and in
  the updated gap docs. These stay omitted (no fabrication).
- **Validator:** 0 real structural defects (125 accepted: 83 Epic-proprietary extensions +
  42 offline-terminology).
