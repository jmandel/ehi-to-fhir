# New Resources — Communication + Billing/Insurance

Phase-2 build adding secure-messaging and the professional-billing / insurance financial
cluster to the EHI→FHIR R4 export. **None of these resource types has a `fhir-target/`
reference**, so correctness rests on the official HL7 FHIR R4 validator plus adversarial
review of the element→source mappings (not on a golden-file diff).

## Build summary

| Resource | Built? | Count | Validator (err / warn / info) |
|---|---|---|---|
| Communication | Built | 116 | 0 / 116 / 0 |
| Account | Built | 2 | 0 / 4 / 0 |
| ChargeItem | Built | 29 | 0 / 29 / 29 |
| Invoice | Built | 21 | 0 / 21 / 76 |
| Claim | Built | 21 | 0 / 21 / 89 |
| ExplanationOfBenefit | Built | 18 | 0 / 18 / 255 |
| PaymentReconciliation | Built | 24 | 0 / 24 / 64 |
| CoverageEligibilityResponse | Built | 21 | 0 / 419 / 238 |
| Binary | Built (opt-in, round 2b) | 78 | 0 / 0 / 78 |

**Total new resources: 252** + **78 Binary (opt-in).** All 8 financial/comms types built; none
skipped. **Zero validator errors across all of them** (Binary: 0 / 0 / 78).

Warning baseline: every resource carries the project-wide best-practice **dom-6** ("a
resource should have narrative") — no generator in this project emits narrative, so this is
the expected one-per-resource floor. The only warnings beyond dom-6 are: Account's
unsatisfiable `IdentifierType` preferred-binding (R4 value set has no account-number code,
+1/resource), and CoverageEligibilityResponse's unresolvable Epic-local service-type
CodeSystem (best-effort coding on benefit service-type items). No structural, reference, or
required-element warnings anywhere.

Full bundle (`bun build.ts`): **668 resources, no generator errors.** New types present in
the bundle at the counts above.

---

## Communication

- **Built.** 116 resources, one per `MYC_MESG` row (MyChart secure message). Validator: 0
  errors, 116 warnings (all dom-6), 0 info.
- **Source:** `MYC_MESG` spine; bodies from `MYC_MESG_RTF_TEXT` (90 RTF) / `MSG_TXT` (26
  plain); threading `MYC_MESG_CHILD`; `PAT_MYC_MESG`.

### Element → EHI mapping
- **id / identifier** — `MESSAGE_ID` (Epic MYC master OID).
- **status** = `completed` (all 116; `RECORD_STATUS_C_NAME` NULL throughout — completed
  historical events).
- **subject** = patientRef (derived display).
- **topic** = `{ text: SUBJECT }`.
- **sent** = `CREATED_TIME` (America/Chicago → ISO).
- **medium** = ParticipationMode `ELECTRONIC` constant.
- **category** = `{ text: "notification" }` only for the 12 system "MYCHART, GENERIC" sends.
- **sender / recipient** — direction-based: patient on one side; the care-team user as a
  **Practitioner reference only when its `_NAME` uniquely maps to a single
  `CLARITY_SER.PROV_ID`** that the Practitioner generator emits (72 messages); otherwise
  display-only (system sender + EMP-only staff).
- **inResponseTo** = `PARENT_MESSAGE_ID` (44 messages; all resolve to MYC_MESG rows).
- **encounter** = `PAT_ENC_CSN_ID`, gated to the Encounter generator's emitted set (32
  messages across 16 distinct CSNs; the other ~70 CSN-bearing messages omit it).
- **about** = renewal `REN_REQ_ORDER_ID` → MedicationRequest (3 messages; all resolve).
- **payload.contentString** — all 116 (90 RTF reassembled with inline RTF stripper that
  drops header groups incl. `{\*\revtbl{Unknown;}}`; 26 plain via `MSG_TXT`). Zero RTF
  control-word / "Unknown;" leakage verified.

### Gaps
- **[data]** received (no receipt-instant column; `DELIVERY_DTTM` NULL, `EOW_READ_STATUS`
  is a read flag not a timestamp), priority, statusReason, reasonCode/reasonReference,
  basedOn/partOf/instantiates* — no EHI source, omitted.
- **[reference]** Not all care-team actors resolve to a Practitioner: party ids
  (`FROM_USER_ID`/`TO_USER_ID`) are EMP/MyChart user ids, a different id space than the SER
  `PROV_ID` minter; the system sender "MYCHART, GENERIC" and several MA/coordinator/admin
  users are display-only. `PROV_ID` (in-basket pool owner) and `DEPARTMENT_ID` have no
  faithful slot and are dropped.
- **[coding]** topic (`{text}` only, no coded subject), category (only `notification` when
  unambiguous), medium (`ELECTRONIC` structural constant, not a per-row column).
- **Content notes:** Questionnaire-submission bodies are template stubs ("Your response has
  been received."); externalized answers (`MYC_MESG_QUESR_ANS` → HQA) are not in the export,
  so answer content is unrecoverable — the stub is emitted faithfully.

---

## Account

- **Built.** 2 resources — the 2 EAR guarantor accounts (`acct-4793998` SA10,
  `acct-1810018166` SA18; both this patient, "Personal/Family", active). Validator: 0
  errors, 4 warnings (2/resource: dom-6 + unsatisfiable IdentifierType binding), 0 info.
- **Source:** `ACCOUNT`, `ACCT_GUAR_PAT_INFO`, `ACCT_COVERAGE`.

### Element → EHI mapping
- **id** = `id.account(ACCOUNT_ID)`; **identifier** = `type.text "Account number"` +
  `ACCOUNT_ID` value (no fabricated OID system; no bound type code available).
- **status** = `ACCOUNT.IS_ACTIVE` (Y→active); **type.text** = `ACCOUNT_TYPE_C_NAME`;
  **name** = `ACCOUNT_NAME`.
- **subject + guarantor.party** = `ACCT_GUAR_PAT_INFO` restricted to this patient (Self).
- **coverage[]** = `ACCT_COVERAGE` → `Coverage/cov-5934765`, priority = `LINE`.
- **owner** = `Organization/org-18` on 1810018166 only (SA18 minted); omitted on 4793998
  (SA10 not minted) to avoid dangling.

### Gaps
- **[coding]** `type` (Personal/Family) text-only (no standard crosswalk);
  `identifier.type` + `system` — R4 IdentifierType value set has no account-number code, and
  the Epic EAR master-file OID is not verifiable from the export, so neither is asserted.
- **[data]** servicePeriod, guarantor.onHold (STMT_HOLD is statement-hold not credit-hold),
  guarantor.period, description, partOf — no source column.
- **Scope:** R4 Account has no balance element, so `TOTAL_BALANCE`/`INSURANCE_BALANCE`/etc.
  are not emitted. PB visits (`ARPB_VISITS`) and HB HARs (`HSP_ACCOUNT`) not modeled as
  Account. Father guarantor line (Z8599632) on 1810018166 excluded (out of export scope).

---

## ChargeItem

- **Built.** 29 resources from `ARPB_TRANSACTIONS` (PB charge ledger, `TX_TYPE_C_NAME='Charge'`).
  Validator: 0 errors, 29 warnings (all dom-6), 29 info.

### Element → EHI mapping
- **identifier** = `TX_ID` (Epic ETR OID).
- **status** = derived from `VOID_DATE`: non-null → `entered-in-error` (1/29: voided TX
  315026147); else `billable`. Its repost (317236398) is billable.
- **code** = transmitted CPT/HCPCS from `CL_RMT_SVCE_LN_INF.PROC_IDENTIFIER` (AMA CPT
  system) + Epic internal `PROC_ID` (EAP OID) + `CLARITY_EAP.PROC_NAME` text.
- **subject** = patientRef. **context** = Encounter (29/29 resolve).
- **occurrenceDateTime** = `SERVICE_DATE` (date-only). **enteredDate** = `POST_DATE`.
- **performer.actor** = `SERV_PROVIDER_ID` → Practitioner (6 distinct, 29/29).
- **performingOrganization + costCenter** = `SERVICE_AREA_ID` 18 → Organization.
- **quantity** = `PROCEDURE_QUANTITY`. **priceOverride** = `AMOUNT` (Money USD, all positive).
- **reason** = `PRIMARY_DX_ID` → `CLARITY_EDG.DX_NAME` (text only).
- **account** = `Account/acct-1810018166` (resolves; account.ts built).

### Gaps
- **[coding] reason ICD-10** — text only. No sound per-charge ICD-10 join: `CLM_DX` keys on
  claim-image `RECORD_ID` with no `DX_ID`; `CLARITY_EDG` has no code column; `INV_DX_INFO`
  links only to an unordered invoice dx set. (Corrected the design doc, which had assumed
  CLM_DX was joinable.)
- **[coding]** performer.function (no role code); internal proc code asserted under
  unverified Epic EAP OID; priceOverride (closest slot for "what it costs", not a true
  ChargeItemDefinition override); CPT system asserted for HCPCS codes (G2211/90471/90686 —
  the 835 `HC:` qualifier does not distinguish); modifiers surfaced as `code.text [mod ...]`
  (R4 Coding has no modifier slot; `ARPB_TRANSACTIONS.MODIFIER_*` deliberately not used as
  they mix true CPT modifiers with Epic-internal `MCP`).
- **[reference] enterer** omitted (`USER_ID` is an EMP user, no Practitioner minted).
- **Scope:** HB charges (`HSP_TRANSACTIONS`, 3 rows) not mapped (phase-2 ledger).

---

## Invoice

- **Built.** 21 resources, one per `INVOICE` row; 34 line items total. Validator: 0 errors,
  21 warnings (all dom-6), 76 info.
- **Source:** `INVOICE` + `INV_BASIC_INFO` + `INV_TX_PIECES` → `ARPB_TRANSACTIONS`.

### Element → EHI mapping
- **id** = `id.invoice(INVOICE_ID)`.
- **identifier[]** = `INV_BASIC_INFO.INV_NUM` (L-numbers, v2-0203 type FILL) + master
  `INVOICE_ID` (type PLAC). No system OID (INV master-file OID not verifiable).
- **status** = derived from latest `INV_STATUS_C_NAME`: Closed/Accepted→balanced,
  Rejected/Voided→cancelled, else issued (17 balanced, 4 cancelled). `cancelledReason`
  carries Epic text. (`RECORD_STATUS_C_NAME` NULL 21/21.)
- **type** = `INV_TYPE_C_NAME "Claim"` text only.
- **subject** = patientRef. **date** = `FROM_SVC_DATE` (date-only; service date stands in).
- **issuer** = `Organization/org-<SERV_AREA_ID>` + `CLARITY_SA` name.
- **account** = `Account/acct-<ACCOUNT_ID>` (resolves).
- **participant** = `Practitioner/prac-<PROV_ID>` (4 billing providers) + `CLARITY_SER`
  name, role text "Billing provider".
- **lineItem** — one per `INV_TX_PIECES` row; `chargeItemCodeableConcept` = CPT/HCPCS from
  `CL_RMT_SVCE_LN_INF.PROC_IDENTIFIER` + `CLARITY_EAP.PROC_NAME`; priceComponent type
  `base`, amount = `ARPB_TRANSACTIONS.AMOUNT` (Money USD, positive).
- **totalNet/totalGross** = sum of line AMOUNTs; verified = `INVOICE.INIT_INSURANCE_BAL`.

### Gaps
- **[coding]** identifier system OID (INV master-file OID not verifiable, no system
  asserted); `type` text-only (no standard code); line-item CPT contingent on the 835
  service line (falls back to PROC_NAME text if a charge lacked a remittance line).
- **[data]** status mapping lossy (Epic vocabulary doesn't align 1:1 with FHIR
  draft/issued/balanced/cancelled/entered-in-error; derived from `INV_STATUS_C_NAME`);
  date uses service date (no distinct issue timestamp); recipient (payer not separable from
  issuer), paymentTerms, note (CLM_NOTE is image-scoped), price factor/surcharge/discount/tax
  (only base AMOUNT exists; totalGross=totalNet). Currency `USD` constant.

---

## Claim

- **Built.** 21 resources, one per `INVOICE_ID`. Validator: 0 errors, 21 warnings (all
  dom-6), 89 info.
- **Grain:** one Claim per INVOICE_ID; submission runs (`INV_BASIC_INFO`) folded in as run
  identifiers + `related.claim` lineage (`REPLACED_INV`).

### Element → EHI mapping
- **Image path (18 claims)** — joined `CLM_VALUES.INV_NUM=INV_BASIC_INFO.INV_NUM`→`RECORD_ID`:
  real CPT (`SVC_LN_INFO.LN_PROC_CD`), CPT modifiers (`LN_PROC_MOD`, coded under CPT),
  ICD-10 (`CLM_DX.CLM_DX`) with ABK→principal dx type, `diagnosisSequence` from `LN_DX_PTR`.
- **Fallback path (3 image-less Rejected invoices: 24584313, 24584314, 78432812)** — charge
  ledger via `INV_TX_PIECES`→`ARPB_TRANSACTIONS`; text-only productOrService
  (`CLARITY_EAP.PROC_NAME`) + text-only diagnosis (`INV_DX_INFO`→`CLARITY_EDG.DX_NAME`);
  careTeamSequence + encounter links from charges.
- **status** = `cancelled` for Voided invoice 58319567, else `active` (derived; no native
  resource-status column — adjudication outcomes describe payer processing, not resource state).
- **type** = `CLM_TYP_C_NAME` (CMS Claim→professional, UB→institutional; default professional
  for image-less). **use** = `claim`, **priority** = `normal` (structural constants).
- **patient/provider/insurance** = patientRef / `id.practitioner` / `id.coverage`.
- **Money** = USD from Charge rows only (positive); **total** from `CLM_VALUES.TTL_CHG_AMT`
  else sum of item.net. All 21 carry every required element.

### Gaps
- **[coding]** image-less invoices' CPT + ICD-10 codes do not exist anywhere in the export
  (`CLARITY_EAP`/`CLARITY_EDG` have no code columns; codes live only in the 837 image) — text
  preserved, no code; charge-ledger modifiers emitted as `modifier.text` (mix true
  CPT/HCPCS modifiers with Epic-internal `MCP`); image-path `LN_PROC_MOD` IS CPT-coded.
- **[coding] identifier system** — INV master-file OID not derivable (the previously asserted
  OID was actually the BEN benefit-collection master). Honest project-local namespace URIs
  asserted: `urn:ehi:epic:invoice-id`, `urn:ehi:epic:claim-run-number`. Values are correct.
- **[data]** subType, enterer, payee (ASGN_YN is assignment-of-benefits, not a payee),
  accident, supportingInfo, claim-header procedure — no source. `insurance.claimResponse`
  only when EOB mints a resolvable id for the same run.
- Design-doc count correction: 3 image-less invoices, not 2.

---

## ExplanationOfBenefit

- **Built.** 18 resources (one per in-export adjudicated claim / L-number whose matched
  charge resolves in this patient's `ARPB_TRANSACTIONS` ledger). 17 active, 1 cancelled
  (Voided invoice L1007990080); 29 item[] lines. Validator: 0 errors, 18 warnings (all
  dom-6), 255 info.
- **Grain query:** `PMT_EOB_INFO_I.PEOB_MTCH_CHG_TX_ID` → `ARPB_TRANSACTIONS`
  (`TX_TYPE_C_NAME='Charge'`) to keep only in-export charges (74 EOB matched-charge TXs
  exist; 29 resolve — the rest belong to another guarantor-account member, out of export).

### Element → EHI mapping
- **status** = `INV_STATUS_C_NAME`; **type** = `professional` (PB charges); **use** =
  `claim`; **outcome** = `complete`.
- **patient** = patientRef. **created** = `CLM_ACCEPT_DT` (fallback MIN `TX_MATCH_DATE`).
- **insurer** = `Organization/org-1302` (BLUE CROSS OF WISCONSIN via EPM_ID/PAYOR_ID).
- **provider** = first charge `SERV_PROVIDER_ID` → Practitioner (`CLARITY_SER` name).
- **insurance** = focal=true, `cov-5934765`.
- **diagnosis[]** = 837 ICD-10 from `CLM_DX` (via `INV_BASIC_INFO.CLM_EXT_VAL_ID`) — all 18.
- **item.productOrService** = CPT/HCPCS from `CL_RMT_SVCE_LN_INF.PROC_IDENTIFIER`
  (`HC:99213:25`→code 99213, modifiers [25]); display `CLARITY_EAP.PROC_NAME` (29/29).
- **adjudication** (summed across each charge's `PMT_EOB_INFO_I` line(s)): submitted=AMOUNT,
  eligible=CVD_AMT, benefit=PAID_AMT, deductible=DED_AMT, copay=COPAY_AMT (all with published
  HL7 adjudication codes). Math reconciles per claim.
- **payment.amount / total[]** populated; **processNote** = CARC remit text.

### Gaps
- **[data] instances** — EOB lines whose matched charge is outside this patient's ledger are
  not emitted (no charge → no CPT/amount/date/provider to describe). 32 INVOICE_NUMs carry
  EOB lines; 18 survive the in-export filter.
- **[reference]** `claim` back-reference omitted (no Claim id wired here historically; carried
  as identifier L-number).
- **[coding]** coinsurance (`COINS_AMT`) and noncovered (`NONCVD_AMT`) are **not** in the HL7
  adjudication CodeSystem (validator rejects the codes) → emitted as `category.text` only
  (extensible binding, valid); `item.diagnosisSequence` omitted (no `DX_ID`→ICD-10 crosswalk
  to key charge dx to `CLM_DX`); per-item CARC reason carried at claim level via `processNote`
  (`II.LINE` not keyed to `I.LINE` on multi-charge claims); CPT system asserted uniformly
  though some codes are HCPCS Level II (e.g. G2211); modifiers from 837 PROC_IDENTIFIER tail
  (not Epic `MODIFIER_*` internal codes); careTeam.role = `primary` (role not in source).
- **Sign note:** reversal/rebill claim L1007233831 sums two payment lines per charge and can
  yield net-negative noncovered — faithful to the reversal.

---

## PaymentReconciliation

- **Built.** 24 resources (one per `CL_REMIT.IMAGE_ID` / 835 remittance image); 40 detail[]
  entries. Validator: 0 errors, 24 warnings (all dom-6), 64 info.
- **Source:** `CL_REMIT` + `CL_RMT_CLM_INFO` + `CL_RMT_SVCE_LN_INF` (+ `CL_RMT_SVC_LVL_ADJ`
  for CARC).

### Element → EHI mapping
- **id** = `id.paymentReconciliation(IMAGE_ID)`; **identifier[image]** = Epic
  remittance-image OID + IMAGE_ID; **identifier[ICN]** = `ICN_NO` (value-only).
- **status** = `active` (constant). **created / paymentDate** = `CL_REMIT.CREATION_DATE`
  (emitted as bare date).
- **paymentAmount** = `CL_RMT_CLM_INFO.CLAIM_PAID_AMT` (Money USD, penny-exact to Σ detail
  amounts).
- **paymentIdentifier** = ICN. **outcome** = `CLM_STAT_CD_C_NAME` mapped (Processed/Reversal
  →complete, Denied→error). **disposition** = raw `CLM_STAT_CD_C_NAME`.
- **paymentIssuer** = `INV_NO`→`INV_BASIC_INFO.EPM_ID`→`Organization/org-1302` (23/24).
- **detail[]** = per `CL_RMT_SVCE_LN_INF` row (type=`payment` constant, amount=
  `PROV_PAYMENT_AMT`, date, ICN-line identifier).
- **processNote** = `CL_RMT_SVC_LVL_ADJ` X12 CARC adjustments as display text (24/24).
- **period.start** = 17/24.

### Gaps
- **[data]** no source status column (active asserted); no 835 BPR header total
  (`CL_REMIT.PAYMENT_AMOUNT` and `CL_RMT_PRV_SUM_INF` 100% NULL → paymentAmount from
  claim-level CLAIM_PAID_AMT); no separate check/EFT date (`ISSUE_DATE` NULL → created &
  paymentDate both use CREATION_DATE, emitted as bare date to avoid a fabricated tz).
- **[reference]** detail.request→ChargeItem omitted historically (now a ChargeItem generator
  exists — could be wired); requestor/detail.submitter/payee omitted (provider appears only as
  name+NPI in `CL_RMT_CLM_ENTITY`, no SER PROV_ID, `CLARITY_SER` has no NPI to crosswalk);
  request(Task), responsible, predecessor, detail.response omitted (no resolvable target).
- **[coding]** formCode omitted; outcome best-effort from Epic label; CARC display best-effort
  (only code + CAS group label ship); ICN identifiers value-only (payer-assigned, no published
  system/OID).
- **Sign:** payer→provider payments pass through positive (no flip). Reversal image 195454936
  emits paymentAmount 0.00 (paid figure, not the -315.00 charge).
- **Scope:** the 1 HB-claim remittance (INV_NO 37668481002, IMAGE_ID 163701585) has no
  paymentIssuer (INV_NO not in PB INV_BASIC_INFO); still emitted with all required elements.

---

## CoverageEligibilityResponse

- **Built.** 21 resources, one per `BENEFITS` (BEN) record: 18 encounter snapshots, 2
  coverage plan-period records, 1 unattached bare scaffold (67112620, no child lines).
  Validator: 0 errors, 419 warnings, 238 info. Warnings are two benign kinds only: (1)
  Epic-local service-type CodeSystem unresolvable by the validator, (2) dom-6 narrative.
- **Source:** `BENEFITS`, `SERVICE_BENEFITS`, `COVERAGE_BENEFITS`, `COVERAGE`.

### Element → EHI mapping
- **status** = `active`, **purpose** = `[benefits]`, **outcome** = `complete` (structural
  constants; `RECORD_STATUS_C_NAME` NULL throughout).
- **patient** = patientRef. **insurer** = `Organization/org-1302` (`COVERAGE.PAYOR_ID` →
  `CLARITY_EPM` PAYOR_NAME).
- **request (1..1)** = a **contained** `#req` CoverageEligibilityRequest scaffold (no
  270/271 persisted in export) carrying only structural fields (status, purpose, patient,
  created, insurer).
- **created** = `RECORD_CREATION_DT` (date-only).
- **serviced** = encounter snapshots use `PAT_ENC_3.PAT_ENC_DATE_REAL`; plan-period records
  use `insurance.benefitPeriod.start` from `BENEFIT_PERIOD_START_DATE`.
- **insurance.coverage** = `Coverage/cov-5934765` (object Reference) on every block.
- **item** = `SERVICE_BENEFITS` grouped by (service type × network tier); metadata-only
  lines dropped. Whole-plan item (`category.text "Plan"`) from `COVERAGE_BENEFITS` with
  deductible/OOP-max `allowedMoney` and `usedMoney = max − remaining` when both present.
- **network** = `NET_LVL_SVC_C_NAME` → THO benefit-network in/out (validates clean).
- **disposition / insurance.inforce** = only when a source flag = "Eligibility Query".

### Gaps
- **[coding] item.category** — Epic ships only org-configurable service-type names
  (`BENEFIT_SVC_TYPE`); no X12 service-type code. Emitted as text + Epic `CVG_SVC_TYPE_ID`
  under the Epic-local URI `http://open.epic.com/FHIR/CodeSystem/benefit-service-type` (the
  validator cannot resolve it → the ~bulk of the 419 warnings; example binding, so valid).
- **[coding] benefit.type coinsurance** — no code in the THO benefit-type CodeSystem →
  text-only `type` ("Coinsurance") + `allowedString "<n>%"` (example binding, valid).
  copay/deductible/benefit(OOP-max) use THO codes.
- **[data]** item.excluded/covered axis (`EVALUATION_STATUS_C_NAME` NULL on all 510 rows);
  item.unit/term (no Individual/Family or annual/lifetime code; `FAMILY_TIER_C_NAME` text
  only); benefit.used on per-service items (no remaining/met columns); benefitPeriod.end (only
  start ships); requestor + contained request.provider (no requesting provider column — must
  not be aliased to the payer).
- **Unattached BEN 67112620** has zero child lines (attacher outside export) — emitted with
  required elements + a coverage-only insurance block.
- **Scope:** pharmacy RTPB (`MED_CVG_*`) and per-encounter pharmacy-eligibility log
  deliberately out of scope (ClaimResponse/medication-cost-shaped, not service-type
  eligibility).

---

## Binary (opt-in — round 2b)

- **Built, opt-in.** 78 resources (39 `text/rtf` + 39 derived `text/plain`), one pair per
  published clinical note. Emitted **only** under `bun build.ts --embed-attachments` (env
  `EMBED_ATTACHMENTS=1`); the default lean build emits no Binary. Validator: **0 errors,
  0 warnings, 78 info.** `Binary` has **no `fhir-target/` reference** — correctness rests on
  the validator + the byte-faithfulness rule below.
- **Source:** `src/binary.ts` reads each note body from `raw/Rich Text/HNO_<NOTE_ID>_*.RTF`.
- **Why:** lets `DocumentReference.content[].attachment.url` point at a `Binary/<id>` that
  actually **resolves within our bundle**, instead of the unreproducible Epic
  `Binary/<opaque-server-id>`. The bundle becomes self-contained.

### Element → EHI mapping
- **id** = content hash `bin-<sha1(bytes)>` — content-addressed, so identical bodies dedup and
  the id is reproducible (Epic's opaque Binary id is not derivable from the EHI).
- **contentType** = `text/rtf` for the exact source bytes; `text/plain` for the derived
  rendering.
- **data** = base64. For the RTF Binary this is the **exact source file bytes** (no
  transformation); for the plain Binary it is the `lib/rtf2txt` rendering, labeled derived.
- **securityContext** = `Patient/pat-Z7004242`.

### DocumentReference wiring (`src/documentreference.ts`)
Every build carries the attachment **metadata** — `contentType` + `size` + `hash` (base64
SHA-1) + `title` + `creation` + `format` — sourced from `binary.ts`'s `attachmentsForNote`
(single source of truth). The `url = Binary/<hashid>` is added **only under
`--embed-attachments`** (env `EMBED_ATTACHMENTS=1`), because that is the only build that
actually bundles the Binary resources; the lean build deliberately omits `url` so it never
points at a Binary it isn't carrying (which would dangle). `tools/refcheck.ts` resolves the
`Binary/` url as a real reference edge → 0 dangling in every build (see REFERENCE-INTEGRITY.md).
No inline `attachment.data` (it lives in the Binary). **Ledger impact:** the content[] block
(format codes + contentType + creation, multiset-aligned to the target's two attachment
entries) recovers **+196 EXACT** on DocumentReference vs no-content — independent of the url,
whose Epic opaque value stays a GAP either way.

### Gaps / faithfulness
- **[byte-fidelity]** RTF `data` = exact source bytes; `text/plain` = derived, labeled.
- **[scanned docs]** `DOC_INFORMATION.SCAN_FILE` (PDF/JPG/TIF) Media path is generalized in
  code, but this specimen ships no scan files (`raw/Media` holds only `_INDEX.HTML`) → none
  emitted; we never fabricate bytes we lack.
- **[unrecoverable]** the target's `attachment.url = Binary/<opaque-Epic-id>` is **not
  byte-reproducible**; our content-hash id intentionally differs. The candidate
  `tolerate-documentreference-content-attachment-binary` rule remains **DROPPED** (never
  applied — `compare/classify.ts` lists it under "Dropped (rejected) candidate rules"): the
  two urls genuinely differ, so blessing them as equal would be a false equivalence. The 56
  `attachment.url` + 28 `attachment.contentType` (text/html, which we don't fabricate) target
  elements stay a **genuine GAP floor** — the honest unrecoverable residual, not a tolerance.
