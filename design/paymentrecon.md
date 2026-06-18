# PaymentReconciliation — design (group: billing)

**Verdict: BUILD.** ~24 instances, one per 835 remittance image (`CL_REMIT.IMAGE_ID`).
All four required FHIR R4 elements (`status`, `created`, `paymentDate`, `paymentAmount`) are
populatable from the EHI, plus meaningful `paymentIssuer`, `outcome`, `disposition`,
`paymentIdentifier`, and a non-trivial `detail[]` from the 835 service lines.

There is **no reference target** in `fhir-target/` for this resource; the spec is the FHIR R4
definition (https://hl7.org/fhir/R4/paymentreconciliation.html) + the EHI data. QA = the HL7
validator (`bun tools/validate.ts PaymentReconciliation`, 0 errors) + adversarial review.

## What the resource models here

Epic stores each received **835 electronic remittance advice (ERA)** as a *remittance image*
(`CL_REMIT`, IMD master, `IMAGE_ID` = the key every `CL_RMT_*` child carries). In this specimen
each image carries **exactly one claim** (`CL_RMT_CLM_INFO` is 1:1 on `IMAGE_ID`: 24 images = 24
claim rows, zero images with >1 claim) and 1–3 service lines (`CL_RMT_SVCE_LN_INF`, 40 lines).

So **one PaymentReconciliation = one `CL_REMIT.IMAGE_ID`** (the payer's remittance for one claim).
This is the FHIR-canonical use of the resource: the payer-side report of how a claim adjudicated and
what was paid. `detail[]` carries the per-service-line payment breakdown.

> **Note on the 835 BPR total.** The true ERA financial-transaction total (835 BPR02) would live in
> `CL_RMT_PRV_SUM_INF.TOT_PROV_AMT` and the header amount in `CL_REMIT.PAYMENT_AMOUNT` — but **both
> ship 100% NULL** here (`CL_RMT_PRV_SUM_INF` is an all-NULL §46 companion-row placeholder;
> `CL_REMIT.PAYMENT_AMOUNT`/`ISSUE_DATE`/`CREDIT_DEBIT`/`INTER_CTRL_NUM`/`SENDER_IDN_NUM` are all
> NULL). The reliable paid figure is the **claim-level** `CL_RMT_CLM_INFO.CLAIM_PAID_AMT`, which
> reconciles **exactly** to the sum of service-line `PROV_PAYMENT_AMT` on all 24 images (verified to
> the penny). Because each image holds one claim, the claim paid amount *is* the remittance payment
> amount.

## Element → EHI source mapping

| FHIR element | Card | Source | Notes |
|---|---|---|---|
| `id` | — | `id.paymentReconciliation(IMAGE_ID)` → `pmtrec-<IMAGE_ID>` | minter exists |
| `identifier` (image) | 0..* | `CL_REMIT.IMAGE_ID` under the Epic remittance-image OID convention | the IMD record id |
| `identifier` (ICN) | | `CL_RMT_CLM_INFO.ICN_NO` (payer claim control number, X12 CLP07) | trace/payer key |
| **`status`** | **1..1 req** | constant `"active"` (FHIR FinancialResourceStatusCodes enum) | `CL_REMIT` has **no status column**; these are posted/historical ERAs → `active`. Mapping-logic constant, not patient data (gap: no source status). |
| `period` | 0..1 | `CL_RMT_CLM_DT_INFO` "Claim statement period start/end" where present | sparse; mostly "Received" qualifier only — emit only when start/end present |
| **`created`** | **1..1 req** | `CL_REMIT.CREATION_DATE` (image creation = posting date) | `parseEpicDateTime`, full dateTime |
| `paymentIssuer` | 0..1 | `CL_RMT_CLM_INFO.INV_NO` → `INV_BASIC_INFO.EPM_ID` → `Organization(id.organization(EPM_ID))` + display `CLARITY_EPM.PAYOR_NAME` | resolves 23/24 (the 1 HB claim `37668481002` is not in PB `INV_BASIC_INFO`). `org-1302` (BLUE CROSS OF WISCONSIN) **is already emitted** by the coverage/org generators → reference resolves. |
| `request` | 0..1 | Reference(Task) | no Task resource in this project → **omit (gap)** |
| `requestor` | 0..1 | Practitioner/Org | rendering provider is on `CL_RMT_CLM_ENTITY` as NPI+name only; **no SER PROV_ID** and `CLARITY_SER` has no NPI column → cannot mint a resolvable ref → **omit (gap)** |
| `outcome` | 0..1 | map `CL_RMT_CLM_INFO.CLM_STAT_CD_C_NAME` → RemittanceOutcome enum: `Processed as Primary`→`complete`; `Denied`→`error`; `Reversal of previous payment`→`complete` (it is a posted, fully-adjudicated reversal) | required-binding enum; mapping logic |
| `disposition` | 0..1 | `CL_RMT_CLM_INFO.CLM_STAT_CD_C_NAME` (the raw label as human text) | free-text string |
| **`paymentDate`** | **1..1 req** | `CL_REMIT.CREATION_DATE` (date part) | no separate BPR check/issue date (`ISSUE_DATE` NULL) → CREATION_DATE is the posting date |
| **`paymentAmount`** | **1..1 req** | `CL_RMT_CLM_INFO.CLAIM_PAID_AMT`, `Money{value, currency:"USD"}` | one claim per image; = Σ service-line `PROV_PAYMENT_AMT` (verified). 0.00 for denied/reversal/patient-resp-only images (valid). |
| `paymentIdentifier` | 0..1 | `CL_RMT_CLM_INFO.ICN_NO` as `Identifier{value}` | the payer's claim control number on the ERA |
| `formCode` | 0..1 | — | Epic-internal form classification not in export → **omit (gap)** |
| **`detail[]`** | 0..* | one per `CL_RMT_SVCE_LN_INF` row for the image (40 lines / 24 images) | |
| `detail.type` | **1..1 req** | constant `"payment"` (PaymentTypeCodes example binding) | every 835 SVC line is a payment line |
| `detail.identifier` | 0..1 | `ICN_NO` + `SERVICE_LINE` composite | line-level trace |
| `detail.amount` | 0..1 | `CL_RMT_SVCE_LN_INF.PROV_PAYMENT_AMT`, `Money USD` | populated 40/40 |
| `detail.date` | 0..1 | `CL_REMIT.CREATION_DATE` (date) | no per-line service date materialized on the remit line here |
| `detail.request` | 0..1 | Reference(ChargeItem) via `SVC_LINE_CHG_PB_ID` → `id.chargeItem(TX_ID)` | PB pointer resolves to `ARPB_TRANSACTIONS` 30/30, **but ChargeItem is not built** (no `src/chargeitem.ts`, not in `out/`). → **omit ref to honor "references must resolve to emitted ids" (principle 4); record as gap.** HB pointer `SVC_LINE_CHG_HB_ID` 100% NULL. |
| `detail.submitter`/`payee`/`responsible`/`predecessor`/`response` | 0..1 | — | no resolvable provider/org id at line level → **omit (gaps)** |
| `processNote[]` | 0..* | CARC adjustment reasons from `CL_RMT_SVC_LVL_ADJ` (`SVC_ADJ_REASON_CD`, `SVC_CAS_GRP_CODE_C_NAME`, `SVC_ADJ_AMT`) joined `(IMAGE_ID, CAS_SERVICE_LINE)` | optional enrichment: `processNote.type="display"`, `processNote.text` = e.g. "CO-45 $104.27 (Contractual obligation)". CARC code is a transmitted X12 code, traceable. Candidate add; not required. |

## Required-element coverage

All 4 required elements covered for **all 24** instances:
- `status` — constant `active` (no source status column; mapping-logic constant). ✔
- `created` — `CL_REMIT.CREATION_DATE`. ✔
- `paymentDate` — `CL_REMIT.CREATION_DATE`. ✔
- `paymentAmount` — `CL_RMT_CLM_INFO.CLAIM_PAID_AMT` (USD). ✔
- `detail.type` (required within each detail) — constant `payment`. ✔

## Populatable count

**24 PaymentReconciliation resources** (one per `CL_REMIT.IMAGE_ID`), carrying **40 `detail[]`**
entries total. 23/24 carry `paymentIssuer`; all 24 carry `paymentIdentifier` (ICN), `outcome`,
`disposition`.

## Sign / money conventions

`CLAIM_PAID_AMT` and `PROV_PAYMENT_AMT` are payer-to-provider payments → positive Money in USD.
The single "Reversal of previous payment" image (IMAGE_ID 195454936) has `CLAIM_CHRG_AMT` -315.00
but `CLAIM_PAID_AMT` 0.00 — paymentAmount is 0.00 (the reversal net-zeroed the prior payment; we
emit the paid figure, not the charge figure). Denied images pay 0.00. All values pass through
unchanged; no sign flip.

## Why not skip / overlap

Not redundant with any built resource. We do **not** build Claim, ExplanationOfBenefit, ChargeItem,
or PaymentNotice, so the payer-side remittance/payment view exists nowhere else in the output.
PaymentReconciliation is the natural FHIR home for the 835 and the data is coherent (clean 1:1
image↔claim, penny-exact paid reconciliation, resolvable payer org). BUILD.
