# ChargeItem — design (group: billing)

FHIR R4: https://hl7.org/fhir/R4/chargeitem.html
Source: Professional Billing (PB) ledger `ARPB_TRANSACTIONS` (ETR master), filtered to
`TX_TYPE_C_NAME = 'Charge'`. See clinical-areas/coverage-and-billing.md and general-patterns.md.

## Feasibility: BUILD

The PB charge ledger carries everything the required ChargeItem elements need plus a lot of
meaningful optional content, all traceable to exact columns/joins, with 100% resolve rates in
this specimen:

| check (TX_TYPE_C_NAME='Charge') | result |
|---|---|
| charge rows | 29 |
| PROC_ID resolves in CLARITY_EAP | 29/29 |
| transmitted CPT via 835 service line (`CL_RMT_SVCE_LN_INF.PROC_IDENTIFIER`) | 29/29 |
| PAT_ENC_CSN_ID resolves to PAT_ENC (built Encounter) | 29/29 |
| PROCEDURE_QUANTITY present | 29/29 |
| PRIMARY_DX_ID present | 29/29 |
| ACCOUNT_ID present | 29/29 |
| enterer USER_ID present | 29/29 |
| voided | 1/29 |

This is **not redundant** with any other resource we build: we do not emit Account, and no other
generator represents the billed charge line (CPT + amount + quantity + billing context). The
HB ledger (`HSP_TRANSACTIONS`, 3 charge rows) is a smaller second source; phase-2 may add it, but
the 29 PB charges alone clear the "non-trivial number of instances + required elements + meaningful
content" bar. Estimate: **~29 instances** (PB charges; one is voided → status entered-in-error).

## Required-element coverage

- **status** (1..1, required binding ChargeItemStatus): derived. `VOID_DATE` non-null → `entered-in-error`;
  otherwise `billable` (all non-void PB charges here were submitted on claims). No native Epic status
  column maps cleanly to the ChargeItemStatus value set, so this is a mapping decision, recorded as a
  [status] gap (we never read a "billed/billable" flag — we assert `billable` as the safe baseline).
- **code** (1..1, CodeableConcept): two codings —
  (1) transmitted **CPT/HCPCS** from `CL_RMT_SVCE_LN_INF.PROC_IDENTIFIER` ("HC:99213:95" → code `99213`,
      system `http://www.ama-assn.org/go/cpt`), modifiers split off (see modifiers below);
  (2) Epic internal proc as a secondary coding: `ARPB_TRANSACTIONS.PROC_ID` under the Epic EAP OID,
      `display` = `CLARITY_EAP.PROC_NAME`.
  `text` = PROC_NAME. CPT present for 29/29 via the 835 line; if ever absent, fall back to internal
  code + display only.
- **subject** (1..1, Reference(Patient)): `patientRef()` (display derived, never hardcoded).

## Element → EHI source mapping

| ChargeItem element | Card | Source | Notes |
|---|---|---|---|
| id | — | `id.chargeItem(TX_ID)` | mints `chg-<TX_ID>` |
| identifier | 0..* | `TX_ID` under Epic ETR OID | the PB transaction id |
| status | 1..1 | derived from `VOID_DATE` | `entered-in-error` if voided else `billable` ([status] gap) |
| code | 1..1 | `PROC_IDENTIFIER` CPT (+ transmitted modifiers) + `PROC_ID`/`CLARITY_EAP.PROC_NAME` | see required-coverage + Modifiers below |
| subject | 1..1 | `patientRef()` | |
| context | 0..1 | `PAT_ENC_CSN_ID` → `id.encounter(CSN)` | Encounter is built; 29/29 resolve |
| occurrence[x] | 0..1 | `SERVICE_DATE` (occurrenceDateTime) | text `M/D/YYYY 12:00:00 AM`; effective date → date only via parseEpicDateTime |
| quantity | 0..1 | `PROCEDURE_QUANTITY` | `{ value: <num> }` (unitless count) |
| priceOverride | 0..1 | `AMOUNT` → Money{value, currency:"USD"} | charge amount; `DEBIT_CREDIT_FLAG_NAME='Debit'` for all charges (positive). NB: this is the *charged* amount, not a true list-price override; documented as best-fit (no separate list-price column ships) |
| performer.actor | 1..1 | `SERV_PROVIDER_ID` → `id.practitioner(PROV_ID)` | all serv providers are emitted Practitioners; function omitted ([coding] gap) |
| performingOrganization | 0..1 | `SERVICE_AREA_ID` (18) → `id.organization(18)` | org-18 is an emitted Organization |
| costCenter | 0..1 | `SERVICE_AREA_ID` → `id.organization(18)` | same emitted Org (service area = billing org) |
| enterer | 0..1 | `USER_ID` (+`USER_ID_NAME`) | EMP user, NOT a SER Practitioner — see gap; emit as display-only? No: Reference needs a resolvable target. Recorded as a gap; we omit the reference and keep no orphan ref |
| enteredDate | 0..1 | `POST_DATE` (post date) | the ledger post date; instant precision unavailable |
| reason | 0..* | `PRIMARY_DX_ID` → `CLARITY_EDG.DX_NAME` (text only) | Implemented as dx **text only** (29/29). The ICD-10 code is NOT traceable per-charge: `CLM_DX` keys on claim-image `RECORD_ID` with no `DX_ID`, `CLARITY_EDG` has no code column, and `INV_DX_INFO` links only to an unordered dx set. Emitting ICD-10 would need an unsound join → [coding] gap |
| account | 0..* | `ACCOUNT_ID` → `id.account(ACCOUNT_ID)` | **Account IS built** (`src/account.ts` → `out/Account.json`, `acct-1810018166`). Emitted; 29/29 resolve, zero dangling |
| note | 0..* | — | no free-text on the charge line |
| bodysite | 0..* | — | not in EHI |

### Modifiers
CPT modifiers are carried on the transmitted 835 identifier ("HC:99213:95" → modifier 95). FHIR R4
has no modifier slot on `Coding`/`ChargeItem`, so the base CPT code is kept clean (strip the `:mod`)
and the as-billed modifier list is recorded as a `code.text` suffix `[mod ...]` only when present.

**Source decision:** modifiers come ONLY from the transmitted identifier
(`CL_RMT_SVCE_LN_INF.PROC_IDENTIFIER`), NOT from `ARPB_TRANSACTIONS.MODIFIER_ONE..FOUR`. The ledger
columns are not a clean as-billed CPT-modifier source: across the 14 charges with a value they carry
`25` (2), `95` (1) — genuine CPT modifiers that are ALSO on the transmitted identifier — and `MCP`
(11), an Epic-internal posting/coverage flag that is not a CPT/HCPCS modifier and is never transmitted
(`SUBM_PROC_IDENT` null for every `MCP` row). Falling back to the ledger therefore only ever surfaced
the spurious `[mod MCP]`. Since every genuine CPT modifier is already on the transmitted identifier,
the transmitted list is both correct and complete and the ledger fallback was removed.

## Elements deliberately NOT populated (no traceable source)

definitionUri, definitionCanonical (no ChargeItemDefinition in EHI); partOf; requestingOrganization
(no requesting org distinct from performing); factorOverride; overrideReason; service (the charge
does not point at a built DiagnosticReport/Procedure/Immunization with a resolvable id — the lab
charges share a CSN with labs but there is no charge→ORDER_PROC link on ARPB_TRANSACTIONS);
product[x]; supportingInformation; bodysite; note.

## Gaps (see gaps/chargeitem.md)
- [status] no native Epic status maps to ChargeItemStatus; `billable`/`entered-in-error` derived.
- [coding] performer.function: no role code in EHI.
- account: ACCOUNT_ID present on 29/29; Account IS built (`out/Account.json`) → `account` emitted (no longer a gap).
- [reference] enterer: USER_ID is an EMP user with no Practitioner/PractitionerRole resource minted → omitted.
- [coding] code.priceOverride is the charged amount, not a list-price override (no list-price column ships).
- HB charges (`HSP_TRANSACTIONS`, 3 rows) not yet mapped (phase-2 candidate).
