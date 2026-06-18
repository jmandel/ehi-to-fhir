# CoverageEligibilityResponse — design (group: billing)

FHIR R4: https://hl7.org/fhir/R4/coverageeligibilityresponse.html
Sources: `BENEFITS` (spine) + `COVERAGE_BENEFITS` + `SERVICE_BENEFITS` + `BENEFIT_SVC_TYPE`,
joined to the single `COVERAGE` (5934765) we already build. EHI grammar:
general-patterns.md; domain guide: benefits-and-eligibility.md.

There is **no reference target** in `fhir-target/` for this resource. The spec below is the
FHIR R4 definition + the EHI data + this doc.

## Verdict: BUILD

The export carries the **271 (eligibility-response) side** of medical benefit verification as
a per-service-type cost-share matrix — exactly what CoverageEligibilityResponse models
(`insurance[].item[].benefit[]`). 21 instances, all required elements coverable, 13 with rich
multi-item detail. This is real, non-redundant content: Coverage models *who is covered*; this
resource models *what the plan says it will pay, by service type and network tier*, which no
other resource we build carries.

## Instance grain & count

**One CoverageEligibilityResponse per `BENEFITS` record** (a "BEN" benefit-collection record).
- `BENEFITS` = 21 rows, all `PAT_ID = Z7004242` (this patient). → **21 instances.**
- Classification (benefits-and-eligibility.md gotcha 2):
  - 18 are **encounter snapshots** (pointed at by `PAT_ENC_3.BENEFIT_ID`) → gives `serviced` date.
  - 2 are **coverage plan-period** records (`BENEFIT_PERIOD_COVERAGE_ID` + `BENEFIT_PERIOD_START_DATE`)
    → gives `benefitPeriod`.
  - 1 is **unattached** (`67112620`) — still a valid BEN with whole-plan benefit lines; emitted
    without `serviced`/`benefitPeriod`.
- Content depth: **13 of 21** carry per-service-type `SERVICE_BENEFITS` amount lines (copay /
  coinsurance / deductible / OOP across 19 service types × In/Out/N/A tiers); **18 of 21** carry
  `COVERAGE_BENEFITS` whole-plan lines (deductible/OOP-max by Individual/Family tier). Every BEN
  record yields at least the required scaffold + one `insurance` block.

All `SERVICE_BENEFITS.CVG_FOR_SVC_TYPE_ID` and `COVERAGE_BENEFITS.CVG_ID` = `5934765`, the single
Coverage we mint → `insurance[].coverage` always resolves to `id.coverage("5934765")`.

## Element → EHI source mapping

| FHIR element | Card | Source | Notes |
|---|---|---|---|
| `id` | — | `id.coverageEligibilityResponse(BENEFITS.RECORD_ID)` | minter `celig-<RECORD_ID>` already in lib/ids |
| `identifier` | 0..* | `BENEFITS.RECORD_ID` under Epic BEN master OID | business id (Epic master-file id convention, §5) |
| `status` **(req)** | 1..1 | constant `"active"` | FHIR financial-resource-status; the snapshot is a live benefit record (`RECORD_STATUS_C_NAME` is NULL throughout → not read from data; status is structural). |
| `purpose` **(req)** | 1..* | constant `["benefits"]` | EligibilityResponsePurpose (required binding). The record reports cost-share *benefits*. `validation` would also be defensible but the payload is benefit amounts → `benefits`. |
| `patient` **(req)** | 1..1 | `patientRef()` | `BENEFITS.PAT_ID` = patient; display derived, never hardcoded |
| `serviced[x]` | 0..1 | `servicedDate` ← `PAT_ENC_3.PAT_ENC_DATE_REAL` (via the encounter that points at this BEN) for the 18 encounter snapshots | `dateRealToISO`. Coverage-period & unattached records: omitted. |
| `created` **(req)** | 1..1 | `BENEFITS.RECORD_CREATION_DT` | `parseEpicDateTime`; effective day (midnight) — emit as dateTime |
| `requestor` | 0..1 | — | **gap**: no requesting provider/org column on BEN |
| `request` **(req)** | 1..1 | **contained** minimal `CoverageEligibilityRequest` (`#req`) | No CoverageEligibilityRequest record in the export, but R4 makes this 1..1. Emit a contained request carrying only FHIR structure populated from the same BEN columns (status `active`, purpose `benefits`, patient, created, insurer ref). This is mapping scaffolding, not fabricated patient data — recorded as a gap. |
| `outcome` **(req)** | 1..1 | constant `"complete"` | RemittanceOutcome (required). A populated benefit snapshot = a completed query. |
| `disposition` | 0..1 | derived text e.g. `"Eligibility verified via real-time eligibility query"` **only when** `CVG_UPDATE_SRC_C_NAME`/`BENEFITS_LAST_UPDATE_SRC_C_NAME = 'Eligibility Query'` | else omitted. Text reflects the source flag, not invented. |
| `insurer` **(req)** | 1..1 | `Organization/<id.organization(COVERAGE.PAYOR_ID)>` + display (CLARITY_EPM.PAYOR_NAME) | the payer behind coverage 5934765 (payor 1302). Same minter coverage.ts uses. |
| `insurance` | 0..* | one block per BEN record | see below |
| `insurance.coverage` **(req)** | 1..1 | `Coverage/<id.coverage("5934765")>` | from `CVG_ID`/`CVG_FOR_SVC_TYPE_ID` |
| `insurance.inforce` | 0..1 | `true` when `CVG_UPDATE_SRC_C_NAME='Eligibility Query'` (benefits actively returned) | else omit (don't assert false without evidence) |
| `insurance.benefitPeriod` | 0..1 | `BENEFITS.BENEFIT_PERIOD_START_DATE` → `period.start` (coverage-period records only, 2) | end date not in export |
| `insurance.item` | 0..* | one per non-empty `SERVICE_BENEFITS` cell, grouped by service type | see below |

### insurance.item (from SERVICE_BENEFITS; grouped per service type × network tier)

Per benefits-and-eligibility.md gotcha 3, `SERVICE_BENEFITS` is a **sparse matrix**: each LINE is one
cell keyed (`CVG_SVC_TYPE_ID`, `NET_LVL_SVC_C_NAME`, which-amount-is-non-NULL). Model one
`insurance.item` per (service type, network tier) and fold that tier's amount lines into `benefit[]`.

| FHIR element | Source | Notes |
|---|---|---|
| `item.category` | text-only CodeableConcept from `CVG_SVC_TYPE_ID_SERVICE_TYPE_NAME` (= `BENEFIT_SVC_TYPE.SERVICE_TYPE_NAME`: PRIMARY/ED/SPEC/HOSP IP…) | binding is **example** → text + Epic-coded code under an Epic service-type system is OK; no standard code in export → **[coding] gap**, emit `text` (and Epic `CVG_SVC_TYPE_ID` as a code with the Epic system). Constraint: item SHALL have category XOR billcode → we use category. |
| `item.network` | `NET_LVL_SVC_C_NAME` → map `In`→`in`, `Out`→`out` (network-type, example binding) + text; `N/A` → omit network, keep text? | emit coding only for In/Out; `N/A` lines (copay) carry no network → no `network` element. |
| `item.excluded` | — | `EVALUATION_STATUS_C_NAME` is NULL throughout → **gap** (covered/not-covered axis unobservable) |
| `item.benefit.type` **(req)** | constant codes (benefit-type, example binding) per amount column: `copay` ← COPAY_AMOUNT, `coinsurance` ← COINS_PERCENT, `deductible` ← DEDUCTIBLE_AMOUNT, `benefit`(OOP) ← OUT_OF_POCKET_MAX | each non-NULL amount on the line → one `benefit`. type is required on each benefit. |
| `benefit.allowedMoney` | COPAY_AMOUNT, DEDUCTIBLE_AMOUNT, OUT_OF_POCKET_MAX → `{value, currency:"USD"}` | money; CAST to number; positive amounts (plan-stated limits, not ledger) |
| `benefit.allowedString` | COINS_PERCENT → `"<n>%"` | coinsurance is a percent, not money → allowedString |
| `benefit.usedMoney` | DEDUCT_REMAIN_AMT / OUT_OF_PCKT_REMAIN where present (whole-plan, on COVERAGE_BENEFITS) → on the plan-level item | "remaining" is the complement of "used"; emit as a separate benefit on a whole-plan item, or omit if ambiguous. Conservative: emit `allowedMoney` for the max and skip used unless a true "met/used" column is non-null (`DEDUCTIBLE_MET_AMT`, `OUT_OF_PCKET_MET_YN`). |

### Whole-plan item (from COVERAGE_BENEFITS)

For records with COVERAGE_BENEFITS lines but no per-service detail, and to carry plan deductible/OOP,
emit one `insurance.item` **without category is illegal** (item SHALL have category or billcode). So
the whole-plan deductible/OOP is emitted as benefits on a synthetic category item only if a category
is available; otherwise carry plan-level deductible/OOP on the per-service items is not possible.
**Decision:** emit a whole-plan item with `category.text = "Plan"` (or per `FAMILY_TIER_C_NAME`
Individual/Family) carrying:
- `benefit.type=deductible`, `allowedMoney`=DEDUCTIBLE_AMOUNT, `usedMoney`=DEDUCTIBLE_MET_AMT (when non-null)
- `benefit.type=benefit`, `allowedMoney`=OUT_OF_POCKET_MAX, `usedMoney` derived from OUT_OF_PCKT_REMAIN only if a met value exists.
`category.text` "Plan" is mapping structure (a fixed bucket label), not patient data.
The `FAMILY_TIER_C_NAME` (Individual/Family) is recorded as item-level text where present.

| `error` | 0..* | — | not used; populated snapshots are successes (failed medical RTE leaves no BEN line; the failures live in the pharmacy MED_CVG side, out of scope below). |

## Required-element coverage (all 21 instances)

- `status` ✔ (constant `active`)
- `purpose` ✔ (constant `benefits`)
- `patient` ✔ (`patientRef()`)
- `created` ✔ (`BENEFITS.RECORD_CREATION_DT`, populated 21/21)
- `request` ✔ (contained `#req` — structural; gap noted)
- `outcome` ✔ (constant `complete`)
- `insurer` ✔ (`id.organization(1302)`)
- `insurance.coverage` ✔ (`id.coverage(5934765)`) — present on every block
- `insurance.item.benefit.type` ✔ — required *on each* benefit; only emitted alongside a real amount
- `error.code` — n/a (no error blocks)

**All required elements covered for all 21 instances.**

## Scope decision — pharmacy RTPB (MED_CVG_*) excluded from this resource

The RTPB pharmacy estimates (`MED_CVG_INFO`/`MED_CVG_DETAILS`, 5 estimates) are a per-drug
request/response/priced-result conversation with the PBM (patient-pay, plan-pay, deductible-applied,
PA-required, formulary). They are **not** a benefit-by-service-type eligibility response: they are
priced adjudications of a specific drug order, modeled far more naturally as a medication
cost-estimate / ClaimResponse-style record keyed to the `ORDER_MED`. Forcing them into
CoverageEligibilityResponse would mean inventing service-type categories they don't carry and losing
the drug/order linkage. **Decision: out of scope for this resource** (candidate for a future
medication-cost resource). Recorded in gaps.

## Gaps (see gaps/coverageeligibility.md)

1. **`request` (1..1)** — no CoverageEligibilityRequest in the export; emitted as a contained `#req`
   scaffold (FHIR structure only). The 270 request was a transient RTE transaction not persisted.
2. **`requestor`** — no requesting-provider/org column on BEN.
3. **`item.category` standard code** — only Epic org-configurable service-type names ship
   (`BENEFIT_SVC_TYPE`); no X12/standard service-type code → text + Epic code only.
4. **`item.excluded` / covered-vs-not** — `EVALUATION_STATUS_C_NAME` NULL throughout; the
   covered/not-covered axis is unobservable in this specimen.
5. **`item.unit` / `term`** — no Individual-vs-Family unit code or annual/lifetime term code that
   maps cleanly; `FAMILY_TIER_C_NAME` carried as text only (term-type binding is example, no source code).
6. **`benefit.used`** — `DEDUCTIBLE_MET_AMT`/`OUT_OF_PCKET_MET_YN` mostly NULL; "remaining" columns
   are not "used" — emitted as used only where a genuine met amount exists.
7. **Pharmacy RTPB (MED_CVG_*)** — deliberately out of scope (see above).
8. **`disposition`/`inforce`** — only derivable from `CVG_UPDATE_SRC_C_NAME='Eligibility Query'`;
   absent on records updated by sync/copy.

## House-style notes

- `clean()` every resource; emit Money only from real amount columns, `currency:"USD"`; coinsurance
  is a percent → `allowedString`, not money.
- All dates via `dateRealToISO` (PAT_ENC_DATE_REAL) / `parseEpicDateTime` (RECORD_CREATION_DT).
- References via `id.coverage`, `id.organization`, `patientRef()` — never hardcode names.
- CAST any *_DATE_REAL / id before ORDER BY (everything is TEXT, §17).
