# Claim — design

Domain `claim` (group: billing). Owns: **Claim**. Source of truth: FHIR R4
`Claim` definition (https://hl7.org/fhir/R4/claim.html) + the EHI export +
`coverage-and-billing.md`. There is **no** reference target for Claim — QA is the
official FHIR validator + adversarial review.

## Feasibility: BUILD

The PB (Professional Billing) claim machinery is fully present and well-structured.
Every required FHIR element resolves deterministically from the export, and the
optional content (item lines with as-billed CPT/modifiers, ICD-10 diagnoses, money,
careTeam, encounter links, claim-status) is rich. This is a first-class resource, not
a thin one, and it is **not redundant** with anything we already build: Coverage is the
insurance, Encounter is the visit; the Claim is the billed submission itself, which has
no other home.

## Grain: one Claim per INVOICE record (`INVOICE.INVOICE_ID`)

`INVOICE` is the INV-master claim container; `INV_BASIC_INFO(INV_ID, LINE)` holds one
or more **submission runs** per invoice (each with its own L-number `INV_NUM` and status
— rejection → resubmission, gotcha 7). The charge-line bridge `INV_TX_PIECES` is keyed by
`INV_ID` (invoice record), **not** by `INV_NUM` (run) — so the invoice record is the level
at which items, provider, coverage, and service dates resolve consistently. We therefore
mint **one Claim per `INVOICE_ID`** (21 in this specimen) and fold the run-level status
history into the Claim. Claim `id` = `id.claim(INVOICE_ID)`.

(Alternative grains considered and rejected: per-run `INV_NUM` would split charges that
`INV_TX_PIECES` can only attribute at `INV_ID` level; per-charge `TX_ID` is the wrong
granularity — a Claim is a submitted bundle of charges. Per-`INVOICE_ID` is the one grain
where every line and every reference resolves without guessing.)

## Element → EHI source mapping

| FHIR element (card) | Source | Notes |
|---|---|---|
| `id` | `id.claim(INVOICE_ID)` | minted |
| `identifier` (0..*) | `INV_BASIC_INFO.INV_NUM` per run; `INVOICE_ID` under Epic INV OID | L-number(s) are the claim-run business ids; one identifier per submission run + the invoice-record id |
| **`status`** (1..1) | derived | `active` for live runs; `cancelled` when the latest run status is `Voided`. (FHIR financial status is workflow state of the *resource*, not adjudication — Rejected/Closed/Accepted runs are still `active` claims.) Gap: no native fin-status column. |
| **`type`** (1..1) | `CLM_VALUE_RECORD.CLM_TYP_C_NAME` (`CMS Claim`→`professional`, `UB Claim`→`institutional`) | HL7 `claim-type` system. Default `professional` (PB) when no image — recorded as derivation. |
| `subType` (0..1) | — | gap (no source) |
| **`use`** (1..1) | constant `claim` | `INV_TYPE_C_NAME='Claim'` for all rows; `predetermination`/`preauthorization` not present (`PREDETERMINATION_YN` all N) |
| **`patient`** (1..1) | `patientRef()` (INVOICE.PAT_ID = this patient) | display derived |
| `billablePeriod` (0..1) | `INV_BASIC_INFO.FROM_SVC_DATE` / `TO_SVC_DATE` (parseEpicDateTime) | per-invoice service span |
| **`created`** (1..1) | `INV_BASIC_INFO.CLM_ACCEPT_DT` (earliest run); fallback `FROM_SVC_DATE` | required — always derivable |
| `enterer` (0..1) | — | gap |
| `insurer` (0..1) | `Organization/<id.organization(EPM_ID)>` + display `CLARITY_EPM.PAYOR_NAME` | `INV_BASIC_INFO.EPM_ID` (=payor 1302) |
| **`provider`** (1..1) | `Practitioner/<id.practitioner(INVOICE.PROV_ID)>` + display `CLARITY_SER.PROV_NAME` | billing provider; required, always present |
| **`priority`** (1..1) | constant `normal` (process-priority) | structural default; no urgency column (gap) |
| `related` (0..*) | run lineage: `INV_BASIC_INFO.SRC_INV_NUM`/`REPLACED_INV`/`CANCELED_INV` | resubmission chain when populated |
| `payee` (0..1) | — | gap (assignment `ASGN_YN` is on the charge, not a payee party) |
| `referral` (0..1) | `INV_BASIC_INFO.REF_ID` → `Practitioner` + display `REF_ID_REFERRING_PROV_NAM` | referring provider |
| `facility` (0..1) | `Location/<id.location(INVOICE.DEPARTMENT_ID)>` | service department/location |
| `careTeam` (0..*) | distinct charge providers: `ARPB_TRANSACTIONS.SERV_PROVIDER_ID` (and billing prov) → `Practitioner` | `sequence`+`provider` required; item lines point back via `careTeamSequence` |
| `supportingInfo` (0..1+) | — | candidate but no clean coded category; omit (gap) |
| `diagnosis` (0..*) | **image path** `CLM_DX(RECORD_ID, LINE)` → ICD-10 `CLM_DX` literal + `CLM_DX_QUAL` (ABK=principal/ABF=other); **fallback** `INV_DX_INFO`/charge `TX_DIAG.DX_ID` → `CLARITY_EDG.DX_NAME` (text only) | `sequence`+`diagnosis[x]` required. Image path gives real ICD-10 codes (system ICD-10-CM); fallback gives text-only `diagnosisCodeableConcept.text`. |
| `procedure` (0..*) | — | not modeled as claim-level procedures here (CPT lives on items) |
| **`insurance`** (1..*) | `sequence`=1, `focal`=true, `coverage`=`Coverage/<id.coverage(INV_BASIC_INFO.CVG_ID)>` | required; single coverage, primary (`FILING_ORDER_C_NAME='Primary'`) |
| `insurance.preAuthRef` (0..*) | `ARPB_AUTH_INFO` / `REFERRAL_ID` if present | best-effort |
| `insurance.claimResponse` (0..1) | `ExplanationOfBenefit/<id.explanationOfBenefit(...)>` | only if the EOB generator mints a matching id; otherwise omit |
| `accident` (0..1) | — | gap |
| **`item`** (0..*, each `sequence`+`productOrService` required) | see below | the core line detail |
| `item.sequence` | line ordinal | minted |
| `item.careTeamSequence` | index into careTeam (charge `SERV_PROVIDER_ID`) | |
| `item.diagnosisSequence` | image `LN_DX_PTR` ("1,2,3") → diagnosis sequences | only on image path |
| `item.productOrService` | **image** `SVC_LN_INFO.LN_PROC_CD` (real CPT/HCPCS, system CPT) + `LN_PROC_DESC`; **fallback** `ARPB_TRANSACTIONS.PROC_ID` (Epic internal) + `CLARITY_EAP.PROC_NAME` (text only) | required — always derivable (text at minimum) |
| `item.modifier` | **image** `SVC_LN_INFO.LN_PROC_MOD`; **fallback** `ARPB_TRANSACTIONS.MODIFIER_ONE..FOUR` + `ARPB_TX_MODIFIERS.EXT_MODIFIER` | CPT modifiers (system CPT-mod) |
| `item.serviced[x]` | `SVC_LN_INFO.LN_FROM_DT`/`LN_TO_DT` or charge `SERVICE_DATE` | servicedDate/Period |
| `item.location[x]` | `Location/<id.location(DEPARTMENT_ID)>` or `LN_POS_CD` | locationReference |
| `item.quantity` | `SVC_LN_INFO.LN_QTY` or `ARPB_TRANSACTIONS.PROCEDURE_QUANTITY` | SimpleQuantity |
| `item.unitPrice` / `net` | `SVC_LN_INFO.LN_AMT` or `ARPB_TRANSACTIONS.AMOUNT` | Money USD; charge `AMOUNT` is positive (verified) |
| `item.encounter` (0..*) | `Encounter/<id.encounter(ARPB_TRANSACTIONS.PAT_ENC_CSN_ID)>` | charge → CSN → encounter |
| `total` (0..1) | `CLM_VALUES.TTL_CHG_AMT`, else Σ item.net | Money USD |

## Money conventions

Only **charge** rows (`TX_TYPE_C_NAME='Charge'`) feed item.net/unitPrice and total —
payments/adjustments are out of scope for Claim (they belong to ExplanationOfBenefit).
Charges are positive in the ledger (verified min 33, max 358); the image `LN_AMT`/
`TTL_CHG_AMT` are positive too. All Money emitted as `{value, currency:"USD"}`.

## Required-element coverage (all satisfied for 21/21)

`status` (derived active/cancelled), `type` (image or PB default professional), `use`
(constant `claim`), `patient` (patientRef), `created` (CLM_ACCEPT_DT / FROM_SVC_DATE),
`provider` (INVOICE.PROV_ID → Practitioner), `priority` (constant normal),
`insurance` (CVG_ID → Coverage, focal=true), and each `item` has `sequence` +
`productOrService`, each `diagnosis` has `sequence` + `diagnosis[x]`, each `careTeam`
has `sequence` + `provider`.

## Populatable count

**21 Claim resources** (one per `INVOICE_ID`). 19 of 21 invoice records carry an 837
claim image (real CPT + ICD-10 + modifiers); the 2 image-less records (both fully
Rejected, never transmitted with a stored image) still produce complete Claims from the
charge ledger (Epic `PROC_ID`+`PROC_NAME` text, `TX_DIAG`/`INV_DX_INFO` dx, amounts).

## Gaps (see gaps/claim.md)

- `status` has no native financial-status column → derived from run status (active vs
  Voided→cancelled). Adjudication outcome (Rejected/Closed/Accepted) is **not** the FHIR
  resource status and is carried instead as identifier-run context, not status.
- `priority` (`normal`) and `use` (`claim`) are structural constants, not Epic data.
- `type` defaults to `professional` when no claim image exists.
- For the 2 image-less Rejected invoices: `item.productOrService` and `diagnosis` are
  **text-only** (Epic PROC_NAME / DX_NAME) — no CPT/ICD-10 code, since `CLARITY_EAP` has
  no CPT column and `CLARITY_EDG` no ICD column; the code lives only in the 837 image.
- `subType`, `enterer`, `payee`, `accident`, `supportingInfo`, claim-level `procedure`:
  no clean deterministic source → omitted.
- `insurance.claimResponse`: emitted only if the EOB generator mints a resolvable id.
