# Coverage — gaps

Domain `coverage` → FHIR `Coverage`. Source: 1 `COVERAGE` row (COVERAGE_ID 5934765),
its `COVERAGE_MEMBER_LIST` member, `CLARITY_EPM`/`CLARITY_EPP` for payer/plan names, and
the 837 claim-image payer block (`CLM_VALUES.PYR_*`) for the billing address.

Generated count: 1 / target 1. Every target path the EHI can fill is reproduced and all
coding systems match the target. The residual differences below are honest gaps, each with
the exact whole-export search that proves the datum is not in the export (so the claim is
falsifiable, not merely asserted).

## Coding gaps (text/value preserved, the coded form is Epic-assigned terminology)

- **`Coverage.type` NAHDO sopt *coding* (code "6" / "BLUE CROSS/BLUE SHIELD", system `https://nahdo.org/sopt`).**
  The real coverage-type datum `COVERAGE.COVERAGE_TYPE_C_NAME = "Indemnity"` is now emitted as
  `Coverage.type.text`. Only the NAHDO sopt *coding* (code 6, system https://nahdo.org/sopt) and
  the target's "BLUE CROSS/BLUE SHIELD" display remain a gap — an Epic-assigned
  source-of-payment-typology classification on a *different* axis from "Indemnity", with no
  deterministic mapping. Searched:
  - `bun tools/find-concept.ts "source of payment"` → the only candidate columns are
    `HSP_ACCOUNT_2.ESOP_PAYOR_C_NAME` / `ESOP_PLAN_NAME_C_NAME` / `ESOP_PLAN_TYPE_C_NAME`
    (expected source-of-payment payer/plan/type). All three are NULL:
    `SELECT COUNT(ESOP_PAYOR_C_NAME), COUNT(ESOP_PLAN_NAME_C_NAME), COUNT(ESOP_PLAN_TYPE_C_NAME) FROM HSP_ACCOUNT_2`
    → `{0,0,0}` (n=4). `PAT_ENC_EXTERNAL_SOP_CODE.EXTERNAL_SOP_CODE_C_NAME` is the one
    documented-but-empty / not-shipped sopt column.
  - `bun tools/find-concept.ts "sopt"` and `"payment typology"` → 0 populated columns.
  - `bun tools/find-concept.ts --grep 'BLUE CROSS/BLUE SHIELD'` → no raw table contains the value.
  - The only sopt-axis datum is `COVERAGE.COVERAGE_TYPE_C_NAME = "Indemnity"`, a *different*
    axis with no deterministic mapping to sopt code 6 or to the target's "BLUE CROSS/BLUE SHIELD"
    text; `COVERAGE_2.FINANCIAL_CLASS_C_NAME` is NULL
    (`SELECT COUNT(FINANCIAL_CLASS_C_NAME) FROM COVERAGE_2` → 0).
  No sopt code, system, display, or text lives in the export → `Coverage.type` omitted entirely.
  Reason: Epic-assigned-terminology / not-in-export.

- **`Coverage.relationship` Epic-OID coding (code "01" "Self", system
  `urn:oid:1.2.840.114350.1.13.283.2.7.10.678671.305`).** The HL7 `subscriber-relationship`
  coding (`self`) and the text are emitted from `MEM_REL_TO_SUB_C_NAME = "Self"`. Searched:
  `COVERAGE_MEMBER_LIST` ships only the resolved category name `MEM_REL_TO_SUB_C_NAME = "Self"`
  (no bare numeric `_C` code) and `MEM_REL_TO_GUAR_C_NAME` = NULL;
  `V_EHI_COVERAGE_SUBS.SUBSCRIBER_REL_TO_GUAR_C_NAME` / `RQG_REL_TO_SUBSCRIBER_C_NAME` are both
  NULL and neither is a numeric Epic code. Per general-patterns §23 only `*_C_NAME` ships — no
  `ZC_` tables, no bare `_C` codes — so the parallel Epic-category numeric code ("01") is not in
  the export. Reason: Epic-assigned-terminology. (Text + HL7 code preserved.)

- **`contained[].Organization.type` (Epic OID code "3" "Insurance Plan", system
  `urn:oid:1.2.840.114350.1.72.1.7.7.10.678671.120`).** Epic's coded categorization of the
  payer organization. Searched:
  - `bun tools/find-concept.ts "insurance plan type"` / `"payor type"` → 0 populated columns.
  - `CLARITY_EPM` (the payer master file) carries only `PAYOR_ID` + `PAYOR_NAME` — no
    TYPE/CATEG/CLASS/SOP column at all (`SELECT * FROM CLARITY_EPM LIMIT 1` → two columns).
  - `COVERAGE_2.FINANCIAL_CLASS_C_NAME` is NULL.
  No Epic payer-categorization code ships → the contained Organization is emitted with name +
  billing address but no `type`. Reason: Epic-assigned-terminology / not-in-export.

## Data gaps (the datum itself is absent from the export)

- **`contained[].contact[].address.country` ("USA").** The billing address comes from the 837
  claim-image payer block. Searched:
  `SELECT DISTINCT PYR_ADDR_1, PYR_CITY, PYR_STATE, PYR_ZIP, PYR_CNTRY, PYR_CNTRY_SUB FROM CLM_VALUES WHERE PYR_ADDR_1 IS NOT NULL`
  → `{PYR_ADDR_1:"PO BOX 105187", PYR_CITY:"ATLANTA", PYR_STATE:"GA", PYR_ZIP:"30348-5187", PYR_CNTRY:null, PYR_CNTRY_SUB:null}`.
  Epic only fills `PYR_CNTRY` when the address is outside the US, so it is NULL for this US payer;
  `CLARITY_EPM` has no address/country column. Note: `V_EHI_COVERAGE_SUBS.SUBSCRIBER_COUNTRY_C_NAME =
  "United States of America"` exists but is the SUBSCRIBER/patient address (Madison WI), a
  semantically different address from the payer Org's billing address (PO Box, Atlanta GA) — not a
  usable source. The target's "USA" is Epic-inferred; not fabricated here. Reason: not-in-export.

## Notes on best-effort / cosmetic choices (not gaps)

- **`status` = "active"** is *derived*, not read: `COVERAGE.CVG_REG_STATUS_C_NAME` is NULL, so
  status comes from the open term date (`CVG_TERM_DT` / member `MEM_EFF_TO_DATE` both NULL) plus
  `MEM_COVERED_YN = "Y"`. A populated registration-status column would be preferred but is absent.
- **Payer display casing.** Target shows title case "Blue Cross of Wisconsin"; the export only has
  `CLARITY_EPM.PAYOR_NAME = "BLUE CROSS OF WISCONSIN"` (and the contained Org name likewise). We
  keep the export's uppercase verbatim rather than invent Epic's display casing. Same for the
  member/subscriber display, which uses the shared patient display "Mandel, Josh C".
- **Identifier / class / plan-extension OID systems** (`...678671` coverage record, `...698080`
  plan) follow the same Epic-instance master-file OID convention every other domain generator in
  this project uses; the *values* (COVERAGE_ID, PLAN_ID, MEM_NUMBER, PAYOR_ID) are all real EHI keys.

## Validator posture

`bun tools/validate.ts Coverage` → 2 error(s), 2 warning(s). Both "errors" are the offline
validator failing to resolve Epic-proprietary `open.epic.com` extensions
(`billing-organization`, `extension/epic-id`) — these are accepted per project posture and are
emitted the same way by other domains (patient, eob, encounter, …). Warnings are the
IdentifierType valueset (offline terminology) and dom-6 narrative best-practice. No
genuine-schema (structural) errors remain.
