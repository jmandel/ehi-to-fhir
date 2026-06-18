# Invoice — gaps

EHI source: `INVOICE` + `INV_BASIC_INFO` + `INV_TX_PIECES` → `ARPB_TRANSACTIONS`
(Epic Professional-Billing claim/invoice cluster). 21 instances.

Validator (`bun tools/validate.ts Invoice`): **0 errors, 21 warnings, 76 info**. Every warning
is the boilerplate `dom-6` "should have narrative" best-practice constraint shared by all
resources in this project; info messages are unverifiable external code displays (CPT / v2-0203).
0-error bar met.

## Identifier system OID not asserted
The L-numbers (`INV_BASIC_INFO.INV_NUM`, one per submission) and the master `INVOICE_ID` are
emitted as `identifier.value` with v2-0203 type codes (`FILL` for L-numbers, `PLAC` for the
master id) but **no `system`** — the Epic INV master-file OID suffix is not verifiable from the
export, so we do not fabricate one (same convention `account.ts` applies to EAR). [coding gap]

## Status mapping is lossy (derived, not native)
`INVOICE.RECORD_STATUS_C_NAME` is NULL for all 21 rows, so `Invoice.status` is derived from
`INV_BASIC_INFO.INV_STATUS_C_NAME` (per submission). Epic's vocabulary
(Closed / Accepted / Rejected / Voided) does not align 1:1 with the required FHIR ValueSet
(draft | issued | balanced | cancelled | entered-in-error):
- Closed / Accepted → `balanced` (claim adjudicated/settled)
- Voided → `cancelled`
- Rejected (when all submissions rejected) → `cancelled`
- otherwise → `issued`
There is no FHIR `draft`/`issued` distinction in the data and no `entered-in-error` signal.
Recorded as a mapping decision; the FHIR status is best-effort, not a verbatim column.

## `Invoice.type` — no standard code
`INV_BASIC_INFO.INV_TYPE_C_NAME` is the Epic text "Claim". Emitted as `type.text` only; no
standard CodeableConcept code exists in the export. [coding gap]

## `Invoice.account` — resolved (no longer a gap)
`INVOICE.ACCOUNT_ID` (the guarantor account) maps to `Account/acct-<ACCOUNT_ID>` via
`id.account(ACCOUNT_ID)`. An `account.ts` generator now exists and emits this patient's guarantor
account (1810018166), so the reference resolves. Emitted.

## `Invoice.date` — service date stands in
No distinct invoice-issue timestamp on the INV master; `INV_BASIC_INFO.FROM_SVC_DATE` (the
service date) is used. `CLM_ACCEPT_DT` exists per submission but is the payer-accept date, not an
issue date. Documented substitution.

## Line-item CPT depends on the 835 service line
The as-billed CPT/HCPCS comes from `CL_RMT_SVCE_LN_INF.PROC_IDENTIFIER` (`HC:<code>[:mod]`),
joined `SVC_LINE_CHG_PB_ID = TX_ID`. It resolves for 29/29 distinct invoice charge TX in this
specimen. If a future charge lacked a remittance service line, the line item would fall back to
`CLARITY_EAP.PROC_NAME` text only (no CPT coding). `ARPB_TRANSACTIONS.PROC_ID` is Epic's internal
numeric id with no CPT companion, so it cannot supply the CPT itself. [coding gap, contingent]

## Not populatable
- `Invoice.recipient` — payer-as-recipient not separable from issuer here.
- `Invoice.paymentTerms` — absent.
- `Invoice.note` — `CLM_NOTE` is claim-image (RECORD_ID)-scoped, not reliably per-INVOICE; omitted.
- `lineItem.priceComponent.factor`, surcharge/discount/tax components — no such breakdown exists;
  only the base charge `AMOUNT`. `totalGross` = `totalNet` for the same reason.

## Currency
`USD` is a constant (single US Epic instance; no currency column). This encodes FHIR structure,
not patient data.
