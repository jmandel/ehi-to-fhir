# ExplanationOfBenefit — design (group: billing)

Domain `eob` → FHIR R4 `ExplanationOfBenefit`. No reference target exists in
`fhir-target/`; the spec is the FHIR R4 definition + the EHI data. QA is the HL7
validator (`bun tools/validate.ts ExplanationOfBenefit`) + adversarial review.

## Verdict: BUILD

The EHI carries a full payer-adjudication record: per-charge allowed / paid /
contractual-write-off / patient-responsibility splits (`PMT_EOB_INFO_I`), CARC
reason codes + ANSI group (`PMT_EOB_INFO_II`), the as-billed CPT/HCPCS
(`CL_RMT_SVCE_LN_INF.PROC_IDENTIFIER`), the charge ledger (`ARPB_TRANSACTIONS`),
the claim container (`INVOICE`/`INV_BASIC_INFO`), coverage, payer, provider,
encounter, and diagnoses. Every required element is populatable for a non-trivial
number of instances. This is **not** redundant with Coverage (plan identity) or
with any Claim resource (we do not emit Claim): EOB is the only place the
adjudication math lands.

## Grain & instance count

**One EOB per claim submission (L-number / `INVOICE_NUM`) that has adjudicated
EOB lines whose matched charge resolves in this patient's ledger.**

```sql
SELECT DISTINCT i.INVOICE_NUM
FROM PMT_EOB_INFO_I i
JOIN ARPB_TRANSACTIONS t ON t.TX_ID = i.PEOB_MTCH_CHG_TX_ID   -- in-export charge only
WHERE t.TX_TYPE_C_NAME = 'Charge';
```

- **18 instances** in this specimen (18 distinct in-export `INVOICE_NUM`s).
- Why filter to in-export charges: `PMT_EOB_INFO_I` references 74 distinct
  matched-charge TXs but only **29 resolve** to `ARPB_TRANSACTIONS` — the other 45
  belong to a different guarantor-account member, outside this patient's export
  (coverage-and-billing gotcha 4). An EOB whose items we cannot describe (no
  charge → no CPT, amount, service date, provider) is not worth emitting; we skip
  those L-numbers. (~32 distinct `INVOICE_NUM`s have EOB lines total; 18 survive
  the in-export filter.)
- Item grain: one `item[]` per distinct in-export `PEOB_MTCH_CHG_TX_ID` on that
  L-number. One L-number can carry 1–4 charges (verified 1..4 here).
- The reversal/rebill saga (e.g. `L1007233831`) has 2 payment TXs against one
  charge; both contribute adjudication lines and are summed per bucket.

`id` = `id.explanationOfBenefit(INVOICE_NUM)` → `eob-L1002834030` etc.

## Element → EHI source mapping

### Required elements (all populatable)

| FHIR element | card | EHI source / derivation |
|---|---|---|
| `status` | 1..1 | Derived from `INV_BASIC_INFO.INV_STATUS_C_NAME` for the L-number: `Voided`→`cancelled`; everything in our set (`Closed`/`Accepted`) →`active`. (The build set excludes `Rejected`, which never adjudicates.) |
| `type` | 1..1 | Constant `professional` (system `http://terminology.hl7.org/CodeSystem/claim-type`) — these are PB (`ARPB_TRANSACTIONS`) charges = professional billing. HB (`HSP_TRANSACTIONS`) would map `institutional`, but no HB charge resolves to an in-export EOB line here. FHIR structure/enum, not patient data. |
| `use` | 1..1 | Constant `claim` (system `Use` required value set). These are adjudicated post-service claims, not preauth/predetermination. FHIR enum. |
| `patient` | 1..1 | `patientRef()` (derives display from `PATIENT.PAT_NAME`). |
| `created` | 1..1 | `INV_BASIC_INFO.CLM_ACCEPT_DT` (e.g. `8/30/2018`) via `parseEpicDateTime`; fall back to `MIN(PMT_EOB_INFO_I.TX_MATCH_DATE)` (the remit-match date) when accept date is null. Both are real EHI columns. |
| `insurer` | 1..1 | `Organization/org-<PAYOR_ID>` via `id.organization(PAYOR_ID)`. `PAYOR_ID` from `ARPB_TRANSACTIONS.PAYOR_ID` (1302) / `COVERAGE.PAYOR_ID`; display = `CLARITY_EPM.PAYOR_NAME` ("BLUE CROSS OF WISCONSIN"). Same minter Coverage.payor uses. |
| `provider` | 1..1 | `Practitioner/prac-<SERV_PROVIDER_ID>` via `id.practitioner`, from the charge's `ARPB_TRANSACTIONS.SERV_PROVIDER_ID` (falls back to `BILLING_PROV_ID`); display `CLARITY_SER.PROV_NAME`. When the claim's charges span >1 provider, use the first charge's provider (claim-header level); per-item provider is not separately modeled. All `SERV_PROVIDER_ID`s resolve in `CLARITY_SER`. |
| `outcome` | 1..1 | Constant `complete` — every built instance has a posted 835 adjudication (`PMT_EOB_INFO_I` lines exist). Cross-checked against `CL_RMT_CLM_INFO.CLM_STAT_CD_C_NAME='Processed as Primary'`. FHIR enum. |
| `insurance` | 1..* | One entry: `focal=true`, `coverage` = `Coverage/cov-<COVERAGE_ID>` via `id.coverage`. `COVERAGE_ID` from `PMT_EOB_INFO_I.COVERAGE_ID` / `ARPB_TRANSACTIONS.COVERAGE_ID` / the single `COVERAGE` row (5934765). |

### Optional elements we populate

| FHIR element | card | EHI source / derivation |
|---|---|---|
| `identifier` | 0..* | The claim L-number `INVOICE_NUM` (system = an Epic invoice/claim OID, the project's master-file-id convention); plus the payer ICN `PMT_EOB_INFO_I.ICN` (system = Epic ICN OID or a claim-control-number system). Both are real EHI values. |
| `billablePeriod` | 0..1 | `start`/`end` = MIN/MAX of `ARPB_TRANSACTIONS.SERVICE_DATE` across the claim's in-export charges (CAST before MIN/MAX — text dates, general-patterns §17; parse `M/D/YYYY`). |
| `claim` | 0..1 | `Claim/clm-<INVOICE_NUM>` via `id.claim` **only if** a Claim generator exists — it does not in `src/`. → omit (no resolvable target). Recorded as a structural note, not a data gap. |
| `careTeam` | 0..* | One member: `provider` = the serving Practitioner ref (sequence 1), referenced from `item.careTeamSequence`. Derived from the same `SERV_PROVIDER_ID`. |
| `diagnosis` | 0..* | Per claim, from the charges' diagnoses: `ARPB_CHG_ENTRY_DX(TX_ID,LINE)→DX_ID` (or `TX_DIAG`), deduped, `sequence` assigned 1..n; `diagnosis` = CodeableConcept. **Code**: ICD-10 literal via `CLM_DX.CLM_DX` matched by the claim's `RECORD_ID` (the 837-transmitted code, with `CLM_DX_QUAL` ABK=principal/ABF=other) — the export's only DX_ID→ICD-10 crosswalk; else `display` only from `CLARITY_EDG.DX_NAME`. `diagnosisCodeableConcept` required per `diagnosis` entry. |
| `item` | 0..* | One per in-export matched charge `PEOB_MTCH_CHG_TX_ID` on the L-number. Sub-elements below. |
| `item.sequence` | 1..1 | Assigned 1..n per claim (deterministic order by `CAST(charge TX_ID AS INT)`). |
| `item.productOrService` | 1..1 | **CPT/HCPCS** from `CL_RMT_SVCE_LN_INF.PROC_IDENTIFIER` (`HC:99395` → code `99395`, system `http://www.ama-assn.org/go/cpt`; the `HC` qualifier = HCPCS/CPT). All 29 in-export charges carry it. `display` = `CLARITY_EAP.PROC_NAME` (via `ARPB_TRANSACTIONS.PROC_ID`). |
| `item.modifier` | 0..* | CPT modifiers from `PROC_IDENTIFIER` tail (`HC:99213:25`→`25`) and/or `ARPB_TRANSACTIONS.MODIFIER_ONE..FOUR` (e.g. `25`, `MCP`), system CPT-modifier. |
| `item.servicedDate` | 0..1 | `ARPB_TRANSACTIONS.SERVICE_DATE` (parsed to date). |
| `item.quantity` | 0..1 | `ARPB_TRANSACTIONS.PROCEDURE_QUANTITY` (e.g. 1). |
| `item.unitPrice` / `item.net` | 0..1 | `net` = charge `ARPB_TRANSACTIONS.AMOUNT` as Money{value,USD} (positive — it's a charge). `unitPrice` = net/quantity when quantity present. |
| `item.encounter` | 0..* | `Encounter/enc-<PAT_ENC_CSN_ID>` via `id.encounter` (charge's CSN; all 16 resolve in `PAT_ENC`). |
| `item.diagnosisSequence` / `item.careTeamSequence` | 0..* | Link to the claim-level `diagnosis[]` / `careTeam[]` sequences for this charge. |
| `item.adjudication` | 0..* | Per charge, from `PMT_EOB_INFO_I` (the per-charge split — reliably keyed by `PEOB_MTCH_CHG_TX_ID`), summed across the charge's payment line(s): `eligible`=`CVD_AMT` (allowed/covered), `benefit`=`PAID_AMT` (plan paid), `deductible`=`DED_AMT`, `copay`=`COPAY_AMT`, `noncovered`=`NONCVD_AMT`. Category system = `http://terminology.hl7.org/CodeSystem/adjudication` (codes: `eligible`, `benefit`, `deductible`, `submitted`, `copay`; `noncovered` is an example-VS code). Each as Money USD; emit only non-null buckets. |
| `total` | 0..* | Claim-level rollups = sum of the item adjudications by category: `submitted` (Σ charge AMOUNT), `eligible` (Σ CVD_AMT), `benefit` (Σ PAID_AMT). category binding example. |
| `payment.amount` | 0..1 | `Σ PMT_EOB_INFO_I.PAID_AMT` for the claim, Money USD (the insurer payment posted by this 835). |

### CARC reason codes (item.adjudication.reason / processNote)

`PMT_EOB_INFO_II` carries CARC (`EOB_CODES`, e.g. `45`,`2`), the human text
(`WINNINGRMC_ID_REMIT_CODE_NAME`), the ANSI group (`PEOB_EOB_GRPCODE_C_NAME`:
Contractual Obligation / Patient Responsibility), and a bucket `AMOUNT`.
**Caveat (verified):** `PMT_EOB_INFO_II.LINE` is **not** keyed to
`PMT_EOB_INFO_I.LINE` when a payment settles >1 charge — II lines are per-CARC-
bucket and reconcile to the charge by *amount* (CO amount = that charge's
`NONCVD_AMT`, PR amount = `COINS_AMT`), not by LINE. So we attach CARC reasons
where unambiguous (single-charge claims: `adjudication.reason` =
CARC code, system `https://x12.org/codes/claim-adjustment-reason-codes`), and
otherwise carry them at claim level via `processNote` (text from
`WINNINGRMC_ID_REMIT_CODE_NAME`). This avoids mis-attributing a reason to the
wrong line. The adjudication *amounts* themselves always come from the per-charge
`PMT_EOB_INFO_I` columns, which are unambiguous.

## Required-element coverage

All 9 required elements (`status`, `type`, `use`, `patient`, `created`,
`insurer`, `provider`, `outcome`, `insurance`) are populated for every one of the
18 instances. `insurance[0].focal`=true and `insurance[0].coverage` resolve to
`cov-5934765`. Validator target: 0 errors.

## Estimated populatable count

**18 EOB resources** (one per in-export adjudicated claim submission), carrying
**~26 items** total (Σ in-export charges per L-number), each with allowed/paid/
write-off/patient-responsibility adjudication, CPT, service date, provider,
encounter, and linked diagnoses.

## Gaps (detail in gaps/eob.md)

- **`item.adjudication.reason` on multi-charge claims**: CARC↔charge line linkage
  is amount-based, not key-based (II.LINE ≠ I.LINE); reasons carried at claim
  level via `processNote` rather than risk mis-attribution. Reason: data-model
  ambiguity in source.
- **`claim` reference**: no Claim resource is generated in this project, so the
  `claim` back-reference is omitted (no resolvable target). The L-number is still
  emitted as `identifier`. Reason: out-of-scope target resource.
- **`type` Epic-coded subtype** (e.g. Epic claim-type category): Epic terminology,
  not in export; only the HL7 `professional` code is asserted. Reason: Epic-terminology.
- **CPT code system assertion**: `PROC_IDENTIFIER` `HC:` qualifier is HCPCS Level
  I/II (CPT); we assert CPT system. Some codes may be HCPCS Level II — best-effort
  coding (validator may warn; acceptable per task rules).
- **`item.productOrService` for any charge lacking a 835 `PROC_IDENTIFIER`**: none
  in the build set (all 29 in-export charges have it), but if absent we would fall
  back to `display` only from `CLARITY_EAP.PROC_NAME` and record a coding gap.
- **`payee` / `precedence` / `accident` / `facility`**: not reliably present /
  not relevant for this PB outpatient set; omitted.
</content>
</invoke>
