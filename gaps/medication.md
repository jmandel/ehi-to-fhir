# Medication domain — reconstruction gaps

Domain: `medication` → FHIR `MedicationRequest` (18) + `Medication` (18).
Spine: `ORDER_MED`. The export ships **20** `ORDER_MED` rows; the target excludes
the **2** `ORDER_CLASS_C_NAME = 'Historical Med'` rows (epinephrine 1165183056,
loratadine 1165183057 — documented meds, never prescribed; gotcha 6 in
`medications-and-orders.md`). Generated counts therefore match the target exactly
(18 / 18). One `Medication` is emitted per included order (the target mints a
distinct Medication per order even when the drug repeats), keyed by `ORDER_MED_ID`
for the FHIR id and carrying the drug master `MEDICATION_ID` as `identifier.value`.

## MedicationRequest — reconstructed fully
identifier, status (active iff no `END_DATE`, else stopped), intent, category
(Outpatient→community / Inpatient→inpatient), medicationReference, subject,
encounter (reference for outpatient orders + CSN identifier), authoredOn
(outpatient = `ORDERING_DATE` date; inpatient = `ORDER_MED_5.ORDER_INST_UTC_DTTM`
as a UTC instant), requester (`ORD_PROV_ID`→`CLARITY_SER`), recorder
(`ORD_CREATR_USER_ID`→`CLARITY_EMP`; the generic EPIC,USER id "1" gets display
only, no reference), reasonCode.text, dosageInstruction.text/patientInstruction
(`ORDER_MED_SIG.SIG_TEXT` + Starting/Until/class suffix), timing.boundsPeriod
(`START_DATE`/`END_DATE`), timing.code.text + asNeededBoolean
(`HV_DISCR_FREQ_ID_FREQ_NAME`, PRN detected by the word "PRN"),
doseAndRate (ordered dose from `HV_DISCRETE_DOSE`/`HV_DOSE_UNIT_C_NAME`),
route.text (`MED_ROUTE_C_NAME`), dispenseRequest.quantity (`QUANTITY`),
numberOfRepeatsAllowed (`REFILLS`), validityPeriod, expectedSupplyDuration
(`ORDER_MED_5.ORDERED_DAYS_SUPPLY_PER_FILL`, where present), priorPrescription
(`CHNG_ORDER_MED_ID` reorder chain).

## MedicationRequest — gaps (all confirmed-absent; search proof recorded)

Each gap below was re-tested with the whole-export search gate
(`bun tools/find-concept.ts "<term>"` for schema, `--grep '<regex>'` for values,
`bun lib/q.ts` to confirm). The search that proves absence is recorded so the
claim is falsifiable, not merely asserted.

- **courseOfTherapyType** (coding + text) — *confirmed absent*. All 18 target rows
  carry `acute` / "Short course (acute) therapy" (system
  `…/medicationrequest-course-of-therapy`), but this is Epic-computed.
  **Searched:** `find-concept "course of therapy"` → 0 populated columns;
  `find-concept "chronic"` → only diagnosis-chronicity flags
  (`PAT_ENC_DX.DX_CHRONIC_YN`, `ORDER_DX_MED.DX_CHRONIC_YN`,
  `PROBLEM_LIST.CHRONIC_YN`) that describe the *diagnosis*, not the medication
  therapy course. No acute/chronic/short-course classifier on
  `ORDER_MED`/`ORDER_MED_2..7`/`ORDER_MEDINFO`. Not emitted (a blank beats inventing
  a constant classification).
- **dosageInstruction.route.coding** — *confirmed absent* (route.text preserved).
  Target carries SNOMED (`738956005` Oral / `47625008` IV) **and** an Epic route
  OID. **Searched:** value scan `--grep '738956005|47625008|419652001'` → no raw
  table contains these. `ORDER_MED.MED_ROUTE_C_NAME` holds only resolved labels
  (Oral/Intravenous/Intramuscular); there is no numeric `MED_ROUTE_C` code column and
  no `ZC%ROUTE%` table shipped. `ORDER_MED_2.ORIG_ROUTE_C_NAME` is 0 rows;
  `ORDER_RPTD_SIG_HX.ROUTE_C_NAME` is also a text label. Only `route.text` is backed.
- **dosageInstruction.method** (coding + text "Take", SNOMED `419652001`) —
  *confirmed absent*. **Searched:** value scan for `419652001` → no raw table;
  `find-concept "administration method"` → only `CLAIM_INFO2.CMN_ADMIN_METH_C_NAME`
  (an unrelated infusion-pump CMN concept). "Take" appears only inside free-text sig
  sentences (`ORDER_MED_SIG.SIG_TEXT`), not as a discrete method field. Epic-assigned
  administration verb.
- **dosageInstruction.doseAndRate type codes `calculated` / `admin-amount`** —
  *confirmed absent*. The export supplies only **one** discrete dose
  (`ORDER_MED.HV_DISCRETE_DOSE` + `HV_DOSE_UNIT_C_NAME`), emitted as the `ordered`
  rate. **Searched/verified:** `ORDER_MED.DOSAGE` is NULL on every row; no per-rate
  calculated(mg)/admin-amount(tablet-count) columns exist — these are Epic
  dose-calculation outputs. (`http://epic.com/CodeSystem/dose-rate-type` is a
  structural classifier, not patient data; only the `ordered` value is backed.)
- **dosageInstruction.timing.repeat.timeOfDay** (e.g. 21:00:00 for "nightly") —
  **BUILT, derived from the frequency-name semantics.** There is no explicit clock-time
  *column* (`ORDER_MED.SPECIFIED_FIRST_TM` is NULL on all 18 orders; `find-concept
  "time of day"` → only empty/not-shipped columns), but the discrete-frequency name
  `ORDER_MED.HV_DISCR_FREQ_ID_FREQ_NAME` itself encodes the administration time the way
  Epic does: "NIGHTLY" → 21:00:00, "DAILY" → 09:00:00 (both confirmed against
  `fhir-target/MedicationRequest.json`). `timeOfDayForFreq()` in `src/medication.ts`
  emits `timing.repeat.timeOfDay` ONLY for names that encode a specific clock-time and
  NOT for PRN/as-needed names (the target's "nightly as needed" carries no timeOfDay).
  Names with no time-of-day signal still yield none — never fabricated.
- **dosageInstruction.timing.repeat.frequency / period / periodUnit** (1/1/d on the
  PRN order only) — *confirmed absent*. **Searched/verified:** `IP_FREQUENCY` master
  = `{FREQ_ID, FREQ_NAME}` only (NIGHTLY/DAILY/PRN); `ORDER_MED.HV_DISCR_FREQ_ID_FREQ_NAME`
  is the same display name; `ORDER_RPTD_SIG_HX.FREQUENCY_ID_FREQ_NAME` is name-only.
  No numeric frequency/period/periodUnit components are exported — derived by Epic
  from the name. Only the freq display name is emitted (timing.code.text + PRN flag).
- **reasonCode.coding** (SNOMED + ICD-9-CM + ICD-10-CM) — *confirmed absent*
  (reasonCode.text preserved). `ORDER_DX_MED.DX_ID` resolves to `CLARITY_EDG.DX_NAME`
  (text only). **Searched:** `CLARITY_EDG` = `{DX_ID, DX_NAME, PAT_FRIENDLY_TEXT}`
  (no code column); `HSP_ACCT_DX_LIST` has `DX_ID` but no code column. ICD-10 codes
  *do* exist in billing claim tables (`CLM_DX.CLM_DX` e.g. `I10`, `S06.9X9S`) but they
  are keyed by claim `RECORD_ID` with **no `DX_ID`**, so there is no join key linking
  the order's `DX_ID` to an ICD code — claim codes would be a lossy/coincidental
  proxy, not the same datum. Not emitted.
- **encounter.display** (visit type: "Office Visit"/"Refill"/"Telemedicine"/
  "Reconciled Outside Data") — *confirmed absent (cross-domain)*. **Searched:** value
  scan `--grep 'Telemedicine|Reconciled Outside Data'` → no raw table; `PAT_ENC` has
  **no** `ENC_TYPE_C_NAME` column (pragma confirms); `find-concept "encounter type"`
  → only `PAT_ENC_BILLING_ENC.BILLING_ENC_TYPE_C_NAME` (a billing concept) and
  `REFERRAL_2`. The visit-type display is the Encounter resource's concern and is not
  materialized in any med-reachable table.
- **dispenseRequest.expectedSupplyDuration** — *partial; gap is the missing spans*.
  Emitted for the 4 orders where `ORDER_MED_5.ORDERED_DAYS_SUPPLY_PER_FILL` is
  populated (90/90/90/20; target has 9). **Searched:** `ORDER_DISP_INFO.FILL_INT_SUP_DAYS`
  and the other `FILL_*` columns are empty (0 rows — no fills exported);
  `MED_CVG_DETAILS.DAYS_SUPPLY` / `MED_CVG_ESTIMATE_VALS.EST_DAYS_SUPPLY` exist
  (20, 90) but are pharmacy-benefit **coverage estimates** keyed by
  `MED_ESTIMATE_ID`/`EST_ERX_ID` and only duplicate the already-present values — they
  do **not** supply the missing 225 (Paxlovid) / 305 (nortriptyline reorder) /
  56·632 (CGM) spans, which remain Epic-computed and absent.

## Medication — reconstructed fully
id, identifier (`MEDICATION_ID`, system `…698288`), code.text and
ingredient.itemCodeableConcept.text (both = `ORDER_MED.DESCRIPTION`),
**form.coding** (Epic form code parsed from the `DESCRIPTION` tail, see below),
**ingredient.strength** (single product strength parsed from `DESCRIPTION`, see
below).

> Note: target `code.text` is the RxNorm-SCD style display ("nortriptyline 10 MG
> capsule"); the export's closest string is `ORDER_MED.DESCRIPTION`
> ("NORTRIPTYLINE HCL 10 MG PO CAPS"). The SCD display string itself is not in the
> export, so the text value differs (path is present; string content is the honest
> source value).

### form.coding — RECOVERED (was a false absence)
The Epic form **code** (`CAPS`/`TABS`/`SOLN`/`TBPK`/`MISC`/`DEVI`) is the last
whitespace-delimited token of `ORDER_MED.DESCRIPTION` ("…PO **CAPS**", "…IV
**SOLN**", "FREESTYLE LIBRE 3 SENSOR **MISC**"). This token IS the target
`form.coding.code` byte-for-byte; emitted with the Epic form-master OID system
`urn:oid:1.2.840.114350.1.13.283.2.7.4.698288.310`. All 18 Medications now carry
`form.coding.code`.

> The resolved `form.text` display ("Cap"/"Tab"/"Solution"/"Tablet Therapy
> Pack"/"Device") is a ZC form-master label that is **not shipped** (no `ZC_FORM`
> table; `SVC_LN_INFO_3.DOSAGE_FORM_DESC_CD` is empty). Anti-cheat: the abbrev→display
> mapping is Epic's, so we emit the code only and do not invent the display text.

### ingredient.strength — RECOVERED (was a false absence)
The single product strength is parsed out of the same `DESCRIPTION` free text:
`numerator.value`+`unit` from the "<n> MG" / "<n> %" token (lisinopril 10 MG,
nortriptyline 10 MG, cyclobenzaprine 5 MG, sodium chloride 0.9 %); `numerator.code`
is the UCUM normalization ("MG"→`mg`, "%"→`%`). `denominator` is `1 <form unit>`
derived from the form code (`CAPS`→capsule, `TABS`→tablet, `SOLN`→mL). The 4
single-strength meds now match the target strength exactly. Strength is deliberately
**omitted** for multi-component packs (Paxlovid "…150 MG & …100MG", `&`/`x` guard)
and device/misc lines (no number+unit) — matching the target, which also omits them.

> Searched-and-absent for a discrete strength column: `ORDER_MED_2.ORIG_STRENGTH`
> is NULL on all 18 rows; `HV_DISCRETE_DOSE` is the *prescribed dose*, not the
> product strength (so not used here). The DESCRIPTION text is the only strength
> source, hence it is parsed.

## Medication — gaps

- **code.coding** (ATC, NDC product-code OID `…6.68`, NDC `…6.162`, GCN `…6.253`,
  RxNorm) — *coding gap, confirmed absent* (code.text preserved). Searched:
  `find-concept` for RxNorm CUIs `198045|314076|205326` → 0 tables; ATC `N06AA|C09AA`
  → 0 tables. The only NDC anywhere in the export is `58160090952` (GSK vaccine, in
  `SVC_LN_INFO.LN_NDC`/`RX_NDC`/`IMMUNE.NDC_NUM_ID_NDC_CODE`) and it does **not** key
  to any of the 18 drugs. `CLARITY_MEDICATION` = `{MEDICATION_ID, GENERIC_NAME}`;
  `RX_MED_TWO` adds only `ORDER_DISPLAY_NAME`. No cross-codes ship for these drugs.
