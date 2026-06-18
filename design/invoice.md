# Invoice — design (group: billing)

**Verdict: BUILD.** ~21 instances (one per `INVOICE` row), all required elements covered,
all carry real line items + amounts. Not redundant with anything we build: there is **no**
Account or Claim generator in `src/`, and `INVOICE` is the Epic PB **claim container** (INV
master) — a distinct billing artifact from Coverage/EOB. `INVOICE.PAT_ID` is fully populated
(21/21), giving a clean patient entry point.

## Source

The Epic Professional-Billing claim/invoice cluster (see `coverage-and-billing.md`):

- `INVOICE` (21 rows) — INV master, the invoice/claim container. `INVOICE_ID` is the key;
  `PAT_ID`, `ACCOUNT_ID` (guarantor), `PROV_ID` (billing provider), `INIT_INSURANCE_BAL` /
  `INIT_SELF_PAY_BAL` (original billed amounts), `INSURANCE_AMT` / `SELF_PAY_AMT` (current
  remaining balances), `SERV_AREA_ID` / `BILL_AREA_ID` (issuing org).
- `INV_BASIC_INFO` (22 rows, keyed `(INV_ID, LINE)`) — one row per claim **submission**:
  `INV_NUM` (the L-number), `INV_STATUS_C_NAME` (Closed/Rejected/Voided/Accepted),
  `INV_TYPE_C_NAME` ("Claim"), `FROM_SVC_DATE` / `TO_SVC_DATE`, `CLM_ACCEPT_DT`,
  `FILING_ORDER_C_NAME`, `CVG_ID`, `EPM_ID`/`EPP_ID` (payer/plan). 21 invoices → 22 submissions
  (one invoice, 58660400, has two submission lines).
- `INV_TX_PIECES` (34 rows) — maps invoice → its charge transactions: `(INV_ID, LINE) → TX_ID`.
  All 21 invoices have ≥1 line; all 34 TX resolve to `ARPB_TRANSACTIONS`; all 34 are `Charge`
  type (no payments/adjustments in the pieces). 29 distinct charge TX (resubmissions reuse TX).
- `ARPB_TRANSACTIONS` — the PB ledger. Charge line detail: `AMOUNT`, `PROC_ID` (Epic internal
  procedure id), `SERVICE_DATE`, `PAT_ENC_CSN_ID`.
- `CLARITY_EAP` (`PROC_ID → PROC_NAME`) — procedure display (e.g. 23868 → "PR PREVENTIVE
  VISIT,EST,18-39"). No CPT column.
- `CL_RMT_SVCE_LN_INF.PROC_IDENTIFIER` — the **as-billed CPT/HCPCS** transmitted on the 837/835
  (`HC:99395`, `HC:99213:95` = code[:modifier]). Joined `SVC_LINE_CHG_PB_ID = TX_ID`; resolves
  for **29/29** distinct charge TX in the invoices.
- `CLARITY_SER` (`PROV_ID → PROV_NAME`) — billing-provider display.

## FHIR R4 Invoice elements → EHI mapping

| FHIR element | Card | Source | Notes |
|---|---|---|---|
| `id` | — | `id.invoice(INVOICE_ID)` | minted |
| `identifier` (L-number) | 0..* | `INV_BASIC_INFO.INV_NUM` per submission | one identifier per submission line (the claim-run L-numbers, e.g. L1002792520) |
| **`status`** (req) | 1..1 | derived from `INV_BASIC_INFO.INV_STATUS_C_NAME` of the **latest** submission | map: Closed/Accepted→`balanced`, Voided→`cancelled`, Rejected (all submissions)→`cancelled`; otherwise `issued`. (See gaps — no native draft/issued split.) `INVOICE.RECORD_STATUS_C_NAME` is NULL 21/21, so status comes from `INV_BASIC_INFO`, not the master. |
| `cancelledReason` | 0..1 | "Rejected" / "Voided" text when status=cancelled | from `INV_STATUS_C_NAME` |
| `type` | 0..1 | `INV_BASIC_INFO.INV_TYPE_C_NAME` ("Claim") | text only — Epic category, no standard code (gap) |
| **`subject`** | 0..1 | `Patient` via `patientRef()` (INVOICE.PAT_ID = PATIENT_ID) | display derived, never hardcoded |
| `recipient` | 0..1 | — | omit; payer-as-recipient not modeled distinctly from issuer here |
| `date` | 0..1 | `INV_BASIC_INFO.FROM_SVC_DATE` (service date) via `parseEpicDateTime` | invoice carries service date, not a separate issue date; documented in gaps |
| `issuer` | 0..1 | `Organization` `id.organization(SERV_AREA_ID)` (=18, "Associated Physicians…") | the patient's billing facility, already minted by location-org.ts |
| `account` | 0..1 | `Account` `id.account(ACCOUNT_ID)` | guarantor account. **NB: no Account generator exists — reference will dangle.** See gaps; emit only if we accept the dangling ref convention used elsewhere, else omit. |
| `participant.actor` (billing prov) | 0..* | `Practitioner` `id.practitioner(PROV_ID)` + display `CLARITY_SER.PROV_NAME` | role = text "billing provider" |
| `lineItem.sequence` | 0..1 | `INV_TX_PIECES.LINE` | positiveInt |
| **`lineItem.chargeItemCodeableConcept`** | 1..1 (choice) | CPT from `CL_RMT_SVCE_LN_INF.PROC_IDENTIFIER` (`HC:` → CPT system) **and/or** text `CLARITY_EAP.PROC_NAME` | inline CC, **not** a Reference — no ChargeItem resource is built. CPT coding when present (29/29), always a text from PROC_NAME. |
| `lineItem.priceComponent.type` (req) | 1..1 | constant `"base"` | the charge amount is the base price |
| `lineItem.priceComponent.amount` | 0..1 | `ARPB_TRANSACTIONS.AMOUNT` as Money USD | the charged amount (positive; all pieces are Charge type) |
| `totalNet` | 0..1 | Σ line `AMOUNT` (= `INVOICE.INIT_INSURANCE_BAL`, verified equal per invoice) | original billed total |
| `totalGross` | 0..1 | same as totalNet | no separate gross vs net (no surcharge/discount data) |
| `paymentTerms` | 0..1 | — | not in EHI (gap) |
| `note` | 0..* | — | `CLM_NOTE` is claim-image-scoped, not reliably per-INVOICE; omit (gap) |

### Currency
USD constant (FHIR structure; the export carries no currency column — single US Epic instance).
Amounts taken only from real columns (`AMOUNT`, `INIT_INSURANCE_BAL`); all charges are positive.

## Required-element coverage
- `status` ✅ derived from `INV_STATUS_C_NAME` (required ValueSet: draft|issued|balanced|cancelled|entered-in-error).
- `lineItem.chargeItem[x]` ✅ via `chargeItemCodeableConcept` (CPT + PROC_NAME), 1..1 satisfied for every line.
- `lineItem.priceComponent.type` ✅ constant `base` (required ValueSet InvoicePriceComponentType).
- `participant.actor` ✅ (when participant emitted) = billing Practitioner.

All required elements are populatable for **all 21** instances.

## Populatable count estimate
**21 Invoice resources** (one per `INVOICE` row). Every one has: status, ≥1 line item with
amount + CPT + proc name, subject, date, issuer, billing-provider participant, identifier(s),
totalNet/totalGross. Non-trivial, fully populated.

## Gaps (see gaps/invoice.md)
- `status` has no native FHIR-aligned column; derived by mapping `INV_STATUS_C_NAME` (lossy:
  Epic has Closed/Accepted/Rejected/Voided, FHIR has draft/issued/balanced/cancelled/eie).
- `type` (CodeableConcept): only Epic text "Claim", no standard code.
- `account`: `id.account(ACCOUNT_ID)` reference does not resolve to a built Account resource.
- `recipient`, `paymentTerms`, `note`: not populatable.
- `date`: service date stands in for issue date (no distinct invoice-issue timestamp on master).
- CPT line coding depends on the 835 service line; if a charge ever lacked one we fall back to
  PROC_NAME text only (currently 29/29 resolve, so no instance is text-only here).
