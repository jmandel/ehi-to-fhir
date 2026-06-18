# Condition — reconstruction gaps

Source: `PROBLEM_LIST` (+ `PROBLEM_LIST_HX`, `PAT_PROBLEM_LIST`) for problem-list-item
Conditions; `PAT_ENC_DX` for encounter-diagnosis Conditions. Names resolve through
`CLARITY_EDG.DX_ID -> DX_NAME`.

Counts match the target exactly: 53 total = 5 problem-list-item + 48 encounter-diagnosis.

## Coding gaps (the structured code is lost; `code.text` is preserved)

- **`code.coding[]` (ICD-10-CM, ICD-9-CM, SNOMED CT, and the Epic `urn:oid:...698084` codes) — NO DETERMINISTIC SOURCE; not spliced.**
  Every Condition in the target carries a `code.coding[]` array with ICD-10-CM, ICD-9-CM,
  SNOMED, and an Epic-internal code, each with a display. The diagnosis-name table this export
  ships, `CLARITY_EDG`, carries **only** `DX_ID, DX_NAME, PAT_FRIENDLY_TEXT` (verified:
  `PRAGMA table_info(CLARITY_EDG)` -> exactly those 3 columns; `PAT_FRIENDLY_TEXT` empty). We
  emit `code.text` = `DX_NAME` only and omit `code.coding[]`.

  **What was searched to prove no DX_ID -> code crosswalk exists (falsifiable):**
  - Concept gate: `bun tools/find-concept.ts "ICD"` and `"SNOMED"` — no populated table pairs a
    `DX_ID` with an ICD/SNOMED code. Every documented ICD mapping table
    (`EDG_CURRENT_ICD10`, `AP_CLAIM_ICD_PROC`, the `ICD10_COMORBIDITY_*` columns, etc.) is in
    the "documented but EMPTY/not-shipped" bucket.
  - The ICD codes *do* live in the **claims/X12** extract for THIS patient — value-scan finds
    e.g. `CLM_DX.CLM_DX` = `S06.9X9S`/`H53.9`/`S09.90XA` (RECORD_ID 127795413/92489134),
    `PAT_RSN_VISIT_DX.PAT_RSN_VISIT_DX`, `EXT_CAUSE_INJ_DX.EXT_CAUSE_INJ_DX` = `W22.8XXS`.
  - **But those tables are keyed by the X12 claim `RECORD_ID` and carry NO `DX_ID`.** The only
    `DX_ID`-bearing claim table, `INV_DX_INFO` (`INVOICE_ID, LINE, DX_ID, ...`), carries **no
    ICD code**, and `CLM_DX.RECORD_ID != INV_DX_INFO.INVOICE_ID` (joining on id+line returns 0
    rows). So no single populated row anywhere pairs a `DX_ID` with an ICD code: a deterministic
    `DX_ID -> ICD` crosswalk cannot be built.
  - Even a best-effort splice would (a) cover only the ~21 distinct *billed* dx codes, not the
    53 Conditions; (b) recover **neither** SNOMED nor the Epic-terminology code/displays at all;
    (c) introduce a coding system on some Conditions but not others (false-presence asymmetry).
  Reason: **coding gap / not-in-export — confirmed-absent for the structured codings.** We
  record the gap rather than partially fabricate. `code.text` matches the target verbatim.

## Data gaps (the datum itself is unreachable)

- **`encounter.display` (visit-type label, e.g. "Office Visit", "Lab", "Telemedicine",
  "Orders Only", "Clinical Support") — NOT REACHABLE; confirmed-absent.**
  The target uses exactly these 5 display values. We emit the full `encounter` reference
  (`reference`, plus `identifier.use`/`system`/`value` = the CSN) but omit `display`.

  **What was searched to prove absence (falsifiable):**
  - `PAT_ENC` carries no `ENC_TYPE_C`/`ENC_TYPE_C_NAME` column, and no appointment-PRC pointer,
    in this export (confirmed via `PRAGMA table_info` across `PAT_ENC` and all supplements
    `PAT_ENC_2..8`). The only enc-type-ish columns present are `WC_TPL_VISIT_C_NAME`,
    `VISIT_PROV_*`, `EXTERNAL_VISIT_ID` — none a class/type label.
  - Concept gate `bun tools/find-concept.ts "visit type"`: the candidate populated columns are
    `PAT_ENC_6.HUS_VISIT_TYPE_C_NAME` and `PAT_ENC_6.OUTPAT_VISIT_GRP_C_NAME` — **both entirely
    NULL** (`SELECT DISTINCT ... WHERE ... IS NOT NULL` -> 0 rows).
  - Literal value-scans of the 5 target strings: "Office Visit" appears only in
    `DOC_INFORMATION`/`MSG_TXT` free text (not an encounter attribute); "Orders Only",
    "Clinical Support", "Telemedicine" -> 0 tables; "Telehealth" only in `CLARITY_PRC`
    (1 row, `PRC_ID=570827036`) whose `PRC_ID` appears only in `PAT_CANCEL_PROC` (cancelled
    appts) — not linkable to any exported encounter.
  The visit-type label is the Encounter domain's concern (Encounter.class/type) and is not
  derivable here. Reason: **data gap / confirmed-absent.**

(No remaining data gap for `recordedDate` — see the RECOVERED note below.)

## Notes on fields that ARE reconstructed (no gap)

- **`recordedDate` for unlinked encounter dx — RECOVERED cross-domain (was wrongly logged as a gap).**
  Linked enc-dx inherit the linked problem's recorded date. For **unlinked** enc-dx the value is
  derived as **`max(CONTACT_DATE, earliest-clinical-activity-instant)`**, where the activity
  instant is the encounter's earliest `ORDER_PROC.ORDER_INST` if any order exists, else its
  earliest `HNO_INFO.CREATE_INSTANT_DTTM`, both keyed by `PAT_ENC_CSN_ID`. `CONTACT_DATE` is
  midnight-only (the calendar day); when documentation/orders slipped to a later day the
  diagnosis was recorded on that later day. This recovers the two visits the previous gap doc
  wrongly claimed had "no reachable target date":
  - CSN 829467718, "Traumatic injury of head": target 2020-07-21. `CONTACT_DATE`=7/16 but
    `HNO_INFO.CREATE_INSTANT_DTTM` on this CSN = 7/21/2020 (no orders on the CSN) -> **2020-07-21**.
  - CSN 1101967391, "Past history of nut allergy": target 2024-11-27. `CONTACT_DATE`=11/24 but
    `ORDER_PROC.ORDER_INST` on this CSN = 11/27/2024 9:59 AM -> **2024-11-27**. (Earliest note is
    11/26, which is why order-instant is preferred over note-instant.)
  Verified against the target on **all 28** unlinked enc-dx that have a matchable encounter
  (0 mismatches) plus the 4 no-encounter unlinked rows — the rule is a no-op for the common
  same-day case and only lifts the two drift visits.

- **`encounter` presence** — the target attaches an encounter only for the 19 (of 27) enc-dx
  CSNs that the Encounter domain actually exports as resources; 8 administrative-contact CSNs
  are in `PAT_ENC` but dropped from the Encounter export, and **no `PAT_ENC`-only predicate
  cleanly separates them** (e.g. CSN 829393933 is exported, 829467718 is not, yet they are
  identical on `APPT_STATUS`, `ENC_CLOSED_YN`, `CALCULATED_ENC_STAT`, create-user, etc.). We
  therefore gate the reference on the Encounter domain's own output (`out/Encounter.json`),
  giving an exact 19/27 = 75% match under the full pipeline. When `condition.ts` is run
  standalone (Encounter not yet built) it falls back to referencing every `PAT_ENC` CSN
  (48/48), so the `encounter.*` paths read as MISSING in a *standalone* `compare.ts`; they
  match once the pipeline builds Encounter. The reference id is internally consistent either
  way (both domains mint via `id.encounter(csn)`).
  - **Cross-domain dependency (encounter count):** the exact set of enc-dx that carry an
    `encounter` reference is dictated entirely by the Encounter domain's exported-CSN set.
    `condition.ts` produces 0 dangling references against `out/Encounter.json`; any residual
    `encounter` count drift vs the target therefore lives in the Encounter generator, not here.
    At time of writing the Encounter export's CSN membership differs from the target on exactly
    4 CSNs — it includes 988126821, 1043034397, 1113285509 (target does not) and omits
    829995922 (target does) — which flips the same 4 enc-dx in our output. When the Encounter
    domain aligns its CSN set to the target, `condition.ts`'s `encounter` references match
    automatically with no change here.
- **`clinicalStatus` / `verificationStatus`** — present on the 5 problems (from
  `PROBLEM_STATUS_C_NAME`: Active->active, Resolved->resolved; verification always "Confirmed")
  and on the 16 encounter-dx rows linked to a problem (`DX_LINK_PROB_ID`), which the target
  marks active/confirmed. 21 of 53 each — matches target prevalence.
- **`onsetDateTime`** = `PROBLEM_LIST.NOTED_DATE` for problems; copied from the linked problem
  for linked encounter dx. **`abatementDateTime`** = `RESOLVED_DATE` (1 row). **`recordedDate`**
  for problems = earliest `PROBLEM_LIST_HX` entry (LINE 1), not `DATE_OF_ENTRY` which is the
  last edit (guide Gotcha 5).
- **`evidence[].detail`** — the 16 linked encounter-dx rows reference their problem-list
  Condition (via `DX_LINK_PROB_ID -> id.condition(PROBLEM_LIST_ID)`), display = the problem's
  `DX_NAME`. Matches the target's 30% prevalence.
