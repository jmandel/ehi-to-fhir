# Claim — gaps

Domain `claim` → FHIR `Claim`. Source: `INVOICE` (21 records) + `INV_BASIC_INFO`
(submission runs), `INV_TX_PIECES` → `ARPB_TRANSACTIONS` (charge lines), the 837 claim
image (`CLM_VALUE_RECORD`/`CLM_VALUES`/`SVC_LN_INFO`/`CLM_DX`), `CLARITY_SER`/`CLARITY_EAP`/
`CLARITY_EDG`/`CLARITY_EPM` for names, `RECONCILE_CLM*` for status. No reference target
exists — QA is the FHIR R4 validator + adversarial review.

Generated count: 21 / 21 invoice records.

## Structural constants (FHIR-required, not patient data)

- **`Claim.use` = `claim`.** All `INV_TYPE_C_NAME='Claim'`, `PREDETERMINATION_YN`/
  `DEMAND_CLAIM_YN` not indicating predetermination/preauth. The literal `claim` encodes
  FHIR-required structure for a billed submission, not a copied datum.
- **`Claim.priority` = `normal`** (`http://terminology.hl7.org/CodeSystem/processpriority`).
  No urgency/priority column exists in the PB claim tables. Structural default for a
  required element. Reason: not-in-export.

## Derived (no native source column)

- **`Claim.status`.** FHIR financial-resource status is the workflow state of the *claim
  resource*, for which the export has no single column. Derived: `cancelled` when the
  latest run `INV_STATUS_C_NAME='Voided'`, else `active`. Adjudication outcomes
  (`Rejected`/`Closed`/`Accepted`) describe payer processing, **not** the FHIR resource
  status, so they are carried as run identifiers/context, not mapped to `status`.
- **`Claim.type` default.** From `CLM_VALUE_RECORD.CLM_TYP_C_NAME` (`CMS Claim`→
  `professional`, `UB Claim`→`institutional`). For the 2 invoice records with no claim
  image, defaults to `professional` (these are PB office charges). Reason: derived.

## Coding gaps (text/value preserved; coded form absent from export)

- **Image-less invoices' `item.productOrService` and `diagnosis` codes.** 3 of 21 invoice
  records (24584313, 24584314, 78432812 — all fully Rejected, never produced a stored 837
  image). For these, the CPT and ICD-10 codes do not exist anywhere in the export:
  `CLARITY_EAP` carries only `PROC_NAME` (no CPT column), `CLARITY_EDG` only `DX_NAME`
  (no ICD column) — the transmitted codes live only in the 837 image
  (`SVC_LN_INFO.LN_PROC_CD`, `CLM_DX.CLM_DX`). These items get `productOrService.text` =
  `CLARITY_EAP.PROC_NAME` and `diagnosis.diagnosisCodeableConcept.text` =
  `CLARITY_EDG.DX_NAME` only. Reason: code-not-in-export. (Value/text preserved.)
  (Design doc said "2"; the materialized count is 3 image-less invoices.)
- **Charge-ledger `item.modifier` (fallback path) emitted as TEXT, not coded.**
  `ARPB_TRANSACTIONS.MODIFIER_ONE..FOUR` mixes true CPT/HCPCS modifiers (e.g. "25", "95")
  with Epic-internal billing modifiers (notably "MCP", which is not a CPT modifier). The two
  cannot be told apart deterministically, so charge-path modifiers ship as
  `modifier.text` only — asserting the CPT modifier system would risk a false-presence
  coding (mapping principle 2). The image path (`SVC_LN_INFO.LN_PROC_MOD`) carries the
  transmitted 837 claim modifiers and IS coded under the CPT system. Reason: code-uncertain.

## Identifier-system gaps (value is real; the namespace OID is absent)

- **INV master-file OID not available.** `Claim.identifier` carries two real, traceable
  values — the invoice record id (`INVOICE.INVOICE_ID`) and one claim-run L-number per run
  (`INV_BASIC_INFO.INV_NUM`) — but the Epic OID for the INVOICE (INV) master file is **not
  derivable from this export**. The number previously asserted here (`...2.7.2.726666`) is in
  fact the **BEN** benefit-collection master file (used by `coverageeligibility.ts`); two
  distinct Epic master files cannot share one INI, so reusing it stamped these identifiers
  with the wrong namespace. We therefore assert honest project-local namespace URIs instead:
  - `urn:ehi:epic:invoice-id` for the `INVOICE_ID`,
  - `urn:ehi:epic:claim-run-number` for the `INV_NUM` L-numbers (also used in `related.claim`).
  Reason: identifier-system-not-in-export. If a correct INV master-file OID is later
  confirmed, substitute it for these URIs. (The VALUES are unchanged and correct.)

## Data gaps (the datum itself is absent)

- **`Claim.subType`** — no source.
- **`Claim.enterer`** — the user who entered the claim is not on `INVOICE`/`INV_BASIC_INFO`.
- **`Claim.payee`** — `ARPB_TRANSACTIONS.ASGN_YN` is assignment-of-benefits at charge level,
  not a payee party; no payee party is modeled. Omitted.
- **`Claim.accident`** — no accident block in the PB claim path (occurrence/related-cause
  codes exist only sparsely on the claim image and are not accident-typed).
- **`Claim.supportingInfo`** — no clean coded category to attach; omitted.
- **Claim-level `Claim.procedure`** — CPT/HCPCS are billed *line items* here, carried on
  `Claim.item.productOrService`; there is no claim-header procedure list to populate.
- **`insurance.claimResponse`** — emitted only when the ExplanationOfBenefit generator
  mints a resolvable id for the same claim run; otherwise omitted to keep references valid.
