# PaymentReconciliation — gaps

Source: `CL_REMIT` (835 remittance image, IMD master) + `CL_RMT_CLM_INFO` + `CL_RMT_SVCE_LN_INF`
(+ `CL_RMT_SVC_LVL_ADJ` for CARC). One resource per `IMAGE_ID`.

## Structural / required-element gaps (worked around)

- **`status` has no source.** `CL_REMIT` carries no status column; every value is NULL on the
  status-shaped header fields. We emit the FHIR enum constant `"active"` (these are posted,
  historical ERAs). Mapping-logic constant, not patient data — but the *source* status is a gap.
- **No 835 BPR header total.** `CL_REMIT.PAYMENT_AMOUNT` and the entire `CL_RMT_PRV_SUM_INF`
  provider-summary row (`TOT_PROV_AMT`, `TOT_CLAIM_AMT`, …) are **100% NULL** (§46 always-emit
  placeholder). `paymentAmount` is therefore taken from the claim-level
  `CL_RMT_CLM_INFO.CLAIM_PAID_AMT` (which reconciles to the penny against Σ service-line
  `PROV_PAYMENT_AMT` — see design). Valid because each image = one claim, but the genuine
  transaction-level remittance total is not in the export.
- **No separate payment/check/issue date.** `CL_REMIT.ISSUE_DATE` is NULL on all rows. Both
  `created` and `paymentDate` use `CL_REMIT.CREATION_DATE` (the image/posting date). The true 835
  check/EFT date (BPR16) is not exported.

## Reference gaps (omitted because the target resource is not built)

- **`detail.request` → ChargeItem omitted.** `CL_RMT_SVCE_LN_INF.SVC_LINE_CHG_PB_ID` resolves to
  `ARPB_TRANSACTIONS.TX_ID` 30/30, and `id.chargeItem(TX_ID)` exists — but **no ChargeItem
  resource is generated** in this project (`out/` has no ChargeItem.json). Per mapping principle 4
  (references must resolve to emitted ids) we omit the reference rather than dangle it. If a
  ChargeItem (or Claim/ExplanationOfBenefit) generator is added, wire `detail.request`/`response`
  to it then. HB pointer `SVC_LINE_CHG_HB_ID` is 100% NULL.
- **`requestor` / `detail.submitter` / `detail.payee` (rendering provider) omitted.** The
  provider appears only in `CL_RMT_CLM_ENTITY` as a name + NPI (`IDEN_CODE`). There is **no SER
  `PROV_ID`** on the remittance, and `CLARITY_SER` ships no NPI column to crosswalk back — so no
  resolvable `Practitioner`/`Organization` reference can be minted from the 835 entity. Omitted.
- **`request` (Task) omitted.** No Task resource in this project.
- **`responsible` / `predecessor` / `detail.response` omitted.** No resolvable
  PractitionerRole / prior-payment identifier / response resource available.

## Coding / classification gaps (best-effort)

- **`formCode` omitted.** No 835 form-type classification in the export usable as a CodeableConcept.
- **`outcome` mapping is best-effort.** Derived from `CLM_STAT_CD_C_NAME`
  (`Processed as Primary`→`complete`, `Denied`→`error`, `Reversal of previous payment`→`complete`).
  No native FHIR RemittanceOutcome code in the EHI; this is mapping logic over the Epic label.
- **`processNote` CARC text (if emitted) carries the raw X12 CARC code + CAS group label** from
  `CL_RMT_SVC_LVL_ADJ`; the CARC *display* is best-effort (the human description of e.g. CARC 45 is
  not in the export, only the code and the group name `Contractual obligation`/`Patient
  responsibility`). Emit code + group as text, no asserted code system display beyond what ships.

## Identifier / datatype gaps (found at build time)

- **ICN identifiers are value-only (no `system`).** `paymentIdentifier`, the secondary root
  `identifier`, and `detail.identifier` carry the payer claim control number
  (`CL_RMT_CLM_INFO.ICN_NO`, X12 CLP07) with **no `system`**. The ICN is payer-assigned and has no
  published HL7 system or derivable OID; asserting one (the validator also rejects an OID with a
  non-numeric suffix) would fabricate provenance. The remittance-image `identifier` does carry the
  Epic remittance-image master-file OID. `detail.identifier` is the `ICN-<SERVICE_LINE>` composite.
- **`created` emitted as a bare date.** Every `CL_REMIT.CREATION_DATE` is the date-only midnight
  sentinel (`… 12:00:00 AM`) with no real clock time and no timezone. `created` (a `dateTime`
  element) is emitted as `YYYY-MM-DD` — valid for `dateTime` — rather than emitting `T00:00:00`
  with a fabricated timezone offset (the validator requires a timezone when a time is present).

## Scope note

The single HB-claim remittance (`INV_NO 37668481002`, IMAGE_ID 163701585) has no
`paymentIssuer` (its invoice number is not in PB `INV_BASIC_INFO`); its service lines also carry
NULL PB/HB charge pointers. Still emitted (required elements all present); just lacks the payer ref.
