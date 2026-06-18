# CoverageEligibilityResponse — gaps

Verdict: **BUILD** (21 instances, one per `BENEFITS` record; all required elements covered).

Generator `src/coverageeligibility.ts` → `out/CoverageEligibilityResponse.json` (21 resources).
HL7 FHIR R4 validator: **0 errors**, 419 warnings — all of two benign kinds (the Epic-local
service-type CodeSystem cannot be resolved by the validator, and the dom-6 "no narrative" best-practice
constraint). See the bottom of this file.

## Structural / cardinality gaps

- **`request` (R4 1..1)** — the export carries no CoverageEligibilityRequest (the 270 query was a
  transient RTE transaction, not persisted). Emitted as a **contained** minimal request (`#req`)
  populated only with FHIR-required structure (status `active`, purpose `benefits`, patient ref,
  `created` from `RECORD_CREATION_DT`, insurer ref) so the validator's 1..1 is satisfied without
  fabricating patient data. The contained request asserts no value not already in the response.
- **`requestor`** — no requesting provider/organization column on `BENEFITS`/`COVERAGE_BENEFITS`.
- **contained request `provider`** (CoverageEligibilityRequest 0..1) — "the provider which is
  responsible for the request". No requesting provider/organization is recorded in the export, so
  this optional element is **omitted**. (It must not be aliased to the insurer/payer — the payer did
  not request its own eligibility.) The contained `#req` carries only structural/traceable fields:
  status, purpose, patient, `created`, and the required 1..1 `insurer` (= `COVERAGE.PAYOR_ID`).

## Coding gaps (best-effort: text/display only)

- **`item.category`** — Epic ships only org-configurable service-type names (`BENEFIT_SVC_TYPE`:
  PRIMARY, ED, SPEC, HOSP IP/OP, PT/OT/ST, E-VISIT, PSYCH-IP/OP, …); no X12 service-type or other
  standard code is present. Emit `text` (the name) + the Epic `CVG_SVC_TYPE_ID` as a code under an
  Epic service-type system (`http://open.epic.com/FHIR/CodeSystem/benefit-service-type`, an
  Epic-local non-OID URI the validator cannot resolve → warning). Binding is *example*, so this passes.
- **`item.network`** — `NET_LVL_SVC_C_NAME` maps `In`→`in`, `Out`→`out` under the standard THO
  `benefit-network` CodeSystem (validates clean); `N/A` lines carry no network → element omitted.
- **`benefit.type`** — derived from which amount column is populated, mapped to THO `benefit-type`
  codes `copay` / `deductible` / `benefit` (for out-of-pocket-max). **Coinsurance has no code in the
  THO `benefit-type` CodeSystem**, so coinsurance benefits use a **text-only** `type` ("Coinsurance")
  — the binding is *example*, so a text-only CodeableConcept is valid. No source code; mapping logic only.
- **`status` / `purpose` / `outcome`** — constants encoding FHIR structure (the snapshot is an
  active, completed benefits response); `RECORD_STATUS_C_NAME` is NULL throughout so status is not
  read from data.

## Data-absent gaps (this specimen)

- **`item.excluded` / covered-vs-not** — `EVALUATION_STATUS_C_NAME` is NULL on all 510
  `SERVICE_BENEFITS` rows; the covered/not-covered axis cannot be observed.
- **`item.unit` / `item.term`** — no unit (Individual/Family) or term (annual/lifetime) *code*;
  `FAMILY_TIER_C_NAME` carried as text only.
- **`benefit.used`** — `DEDUCTIBLE_MET_AMT` / `OUT_OF_PCKET_MET_YN` mostly NULL. On the whole-plan
  COVERAGE_BENEFITS lines, `usedMoney` is computed as `max − remaining` only when both the max and a
  `*_REMAIN` value are present and `max ≥ remaining` (e.g. deductible 1750 − remaining 0 = used 1750;
  OOP 1000 − remaining 539.20 = used 460.80). Per-service SERVICE_BENEFITS lines carry no
  remaining/met columns → no `used` on service items.
- **Unattached BEN record (`67112620`)** — has zero `SERVICE_BENEFITS`/`COVERAGE_BENEFITS` child
  lines (its attacher is outside the export). Emitted with all required elements + one `insurance`
  block (coverage only, no items); no `serviced`/`benefitPeriod`/`disposition`/`inforce`. A BEN record
  legitimately can have no benefit lines (benefits-and-eligibility.md gotcha 1).
- **`benefitPeriod.end`** — only `BENEFIT_PERIOD_START_DATE` ships (plan-year start); no end date.
- **`disposition` / `insurance.inforce`** — only derivable when
  `CVG_UPDATE_SRC_C_NAME` / `BENEFITS_LAST_UPDATE_SRC_C_NAME = 'Eligibility Query'`; omitted on
  sync/copy-sourced records.

## Deliberately out of scope for this resource

- **Pharmacy RTPB / real-time prescription benefit** (`MED_CVG_INFO`, `MED_CVG_DETAILS`,
  `MED_CVG_RESPONSE_RSLT`, `MED_CVG_ESTIMATE_VALS`; 5 estimates) — per-drug priced adjudications
  (patient-pay, plan-pay, deductible-applied, PA-required, formulary) tied to a specific
  `ORDER_MED`. These are ClaimResponse/medication-cost-shaped, not benefit-by-service-type
  eligibility, and modeling them here would discard the drug/order linkage and force invented
  service-type categories. Candidate for a future medication-cost resource.
- **Per-encounter pharmacy-eligibility verification log** (`PAT_ENC_ELIG_HISTORY`,
  `EXT_PHARM_TYPE_COVERED`) — an audit trail of *who verified* pharmacy eligibility and *which
  pharmacy types* (Retail/Mail Order) are covered; an action log, not a benefits response. Out of
  scope.

## Validator warnings (acceptable; 0 errors)

- `CodeSystem 'http://open.epic.com/FHIR/CodeSystem/benefit-service-type' could not be found, so the
  code cannot be validated` — the Epic-local service-type categories (coding gap above). Best-effort
  coding; no standard service-type code ships in the export. (~22 distinct + per-item across records.)
- `dom-6: A resource should have narrative for robust management` (best-practice) — this project does
  not generate narrative text, consistent with the other generators.
