# ExplanationOfBenefit — gaps

Generator: `src/eob.ts`. Resource: `out/ExplanationOfBenefit.json`. 18 instances
(one per in-export adjudicated claim submission / L-number).

## Instances not emitted (out of scope, not a defect)

- **EOB lines whose matched charge is not in this patient's ledger.** `PMT_EOB_INFO_I`
  references 74 distinct matched-charge TXs but only 29 resolve in `ARPB_TRANSACTIONS`
  for this patient; the rest belong to another guarantor-account member outside the
  export (coverage-and-billing gotcha 4). ~32 distinct `INVOICE_NUM`s carry EOB lines;
  18 survive the in-export filter. An EOB whose items cannot be described (no charge →
  no CPT, amount, service date, provider) is not emitted. **Reason: data outside export.**

## Elements not populated

- **`claim` (back-reference)** — omitted. No Claim resource is generated in this
  project, so the reference would not resolve. The L-number is still carried as
  `identifier`. **Reason: out-of-scope target resource.**

- **`item.diagnosisSequence`** — not emitted. The claim-level `diagnosis[]` codes come
  from `CLM_DX` (837-transmitted ICD-10). The per-charge diagnoses are keyed by Epic
  `DX_ID` (`ARPB_CHG_ENTRY_DX`), and the export carries no `DX_ID → ICD-10` crosswalk
  (`CLARITY_EDG` has only `DX_ID`/`DX_NAME`). So a charge's `DX_ID` cannot be reliably
  matched to a `CLM_DX` line to assign a diagnosis sequence. Linking by display name
  would be fragile and is not done. **Reason: missing crosswalk in source.**

- **`item.adjudication.reason` (per-line CARC)** — not attached at item level.
  `PMT_EOB_INFO_II.LINE` is not keyed to `PMT_EOB_INFO_I.LINE` when a payment settles
  more than one charge (II lines are per-CARC bucket, reconciled by amount, not by
  line). To avoid mis-attributing a reason to the wrong charge, CARC remit text is
  carried at claim level via `processNote` instead. The adjudication *amounts* are
  always from the unambiguous per-charge `PMT_EOB_INFO_I` columns. **Reason: source
  data-model ambiguity.**

- **`type` Epic claim-subtype** — only the HL7 `professional` `claim-type` code is
  asserted (these are PB / `ARPB_TRANSACTIONS` charges). Epic's own claim-type
  classification is not in the export. **Reason: Epic terminology not exported.**

- **`subType`, `priority`, `payee`, `precedence`, `accident`, `facility`,
  `supportingInfo`, `addItem`** — not reliably present / not relevant for this PB
  outpatient adjudication set. Omitted.

## Best-effort codings (validator may warn; acceptable per task rules)

- **`item.productOrService` system = CPT.** `CL_RMT_SVCE_LN_INF.PROC_IDENTIFIER` uses
  the `HC:` qualifier = HCPCS (Level I = CPT, Level II = HCPCS). All codes are asserted
  under the AMA CPT system. Some are HCPCS Level II (e.g. `G2211`) and would more
  precisely use the HCPCS system; we do not have a per-code level flag in the export,
  so CPT is asserted uniformly. **Reason: qualifier does not distinguish CPT vs HCPCS-II.**

- **`item.modifier` system = CPT.** Modifiers parsed from the `PROC_IDENTIFIER` tail
  (e.g. `HC:99213:25` → `25`) are the 837-transmitted modifiers and are asserted under
  the CPT system. (Epic's `ARPB_TRANSACTIONS.MODIFIER_*` columns also include internal
  non-CPT codes like `MCP`, which are deliberately NOT used as the modifier source.)

- **`adjudication.category` for coinsurance / noncovered = text only (no coding).**
  `eligible`, `submitted`, `benefit`, `deductible`, `copay` are real codes in the
  published HL7 `adjudication` CodeSystem and are emitted with a coding. `coinsurance`
  and `noncovered` are NOT in that CodeSystem (the validator rejects them as unknown
  codes), so those buckets are carried as `category.text` only ("Co-insurance Amount",
  "Noncovered Amount"). The binding is extensible, so text-only is valid. **Reason: no
  published code for these buckets in the bound CodeSystem.**

- **`careTeam.role` = `primary`.** All in-export charges carry a serving provider; the
  role is asserted as the primary provider (claimcareteamrole). The export does not
  distinguish rendering vs supervising at the EOB grain. **Reason: role not in source.**

## Notes on amounts (sign conventions)

- `item.net` / `unitPrice` and `total[submitted]` are charge amounts
  (`ARPB_TRANSACTIONS.AMOUNT`), emitted positive (charges).
- `eligible` (`CVD_AMT`), `benefit` (`PAID_AMT`), `deductible`, `copay`,
  `coinsurance`, `noncovered` come straight from `PMT_EOB_INFO_I`, summed across the
  charge's payment line(s). On a reversal/rebill saga (e.g. `L1007233831`) a charge has
  two payment lines; per-bucket summation can yield a net negative `noncovered`
  (`116.09 + (-315.00)`), which faithfully reflects the reversal net rather than
  fabricating a single value.
- `payment.amount` = Σ `PAID_AMT` for the claim (insurer payment posted by this 835).
