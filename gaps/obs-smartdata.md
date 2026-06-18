# Gaps — obs-smartdata (Observation, category = smartdata)

## Summary

**Target count: 118. Generated count: 0.** The entire shard is unreconstructable in this
specimen. This is a **whole-domain data gap**, not a per-field coding gap: the source store
that backs every one of the 118 target resources is **not shipped** in this EHI export.

This document records the **exact searches** that prove absence, so every claim below is
falsifiable: re-run the listed command and a non-empty result would overturn it.

## What the targets are

All 118 category=smartdata Observations are **generic SmartData element** values
(SmartForm / SmartTool findings — physical-exam findings such as
"FINDINGS - PHYSICAL EXAM - NEUROLOGICAL - FOCAL DEFICIT - NO FOCAL DEFICIT"). Each carries:

- `code.coding[]` = `{ system: urn:oid:1.2.840.114350.1.13.283.2.7.2.727688, code: "EPIC#<SDI>", display }`
  (plus a `http://snomed.info/sct` coding on 96 of 118)
- `code.text` = the full element path
- `category` = [smartdata (open.epic), exam (hl7 observation-category)]
- `status` = "unknown"
- `focus[]` -> DocumentReference (the note the element was filed on)
- `issued` = the element's filed instant
- `performer[]` -> Practitioner
- `component[]` = `{ code.text: "Line <n>", valueBoolean | valueString }`

## The whole-export search gate (run, on 2026-06-17)

### Step 1 — schema search: which tables even mention the concept?

```
bun tools/find-concept.ts "smartdata"
bun tools/find-concept.ts "SMRTDTA"
bun tools/find-concept.ts "physical exam"
```

- `"smartdata"` and `"SMRTDTA"` return tables ONLY under the
  **"documented but EMPTY/not-shipped"** heading — `CLARITY_CONCEPT`,
  `SMRTDTA_ELEM_DATA`, `SMRTDTA_ELEM_AUTH`, `ELEM_VAL_PREV`, `LAB_CASE_SNOMED`,
  `ORDER_CONCEPT_INDEX`, `V_EHI_SMRTDTA_ELEM_VAL_EXT`, `V_EHI_ELEM_VAL_PREV_EXT`.
  **Zero** tables under "POPULATED tables — THESE are where the datum could actually be".
- `"physical exam"` returns **zero** populated tables.

### Step 2 — confirm each candidate table is truly unshipped (errors, not blank)

```
bun lib/q.ts "SELECT COUNT(*) FROM SMRTDTA_ELEM_DATA"            -> SQLiteError: no such table
bun lib/q.ts "SELECT COUNT(*) FROM V_EHI_SMRTDTA_ELEM_VAL_EXT"   -> SQLiteError: no such table
bun lib/q.ts "SELECT COUNT(*) FROM CLARITY_CONCEPT"              -> SQLiteError: no such table
bun lib/q.ts "SELECT COUNT(*) FROM SMRTDTA_ELEM_AUTH"            -> SQLiteError: no such table
bun lib/q.ts "SELECT COUNT(*) FROM ELEM_VAL_PREV"                -> SQLiteError: no such table
bun lib/q.ts "SELECT COUNT(*) FROM LAB_CASE_SNOMED"             -> SQLiteError: no such table
bun lib/q.ts "SELECT COUNT(*) FROM V_EHI_ELEM_VAL_PREV_EXT"     -> SQLiteError: no such table
```

All seven error "no such table": the rows are not present (not merely stripped to blank).

### Step 3 — value-pattern scan across ALL raw tables (cross-domain, not just our silo)

```
bun tools/find-concept.ts --grep 'EPIC#'                                   -> 0 tables
bun tools/find-concept.ts --grep '31000134232|PEAB0102|PENE0001'          -> 0 tables  (target SDI codes)
bun tools/find-concept.ts --grep '162718006|102599008|246875002|163600007' -> 0 tables  (target SNOMED codes)
bun tools/find-concept.ts --grep 'NO FOCAL DEFICIT|CVA TENDERNESS'         -> 0 tables  (target element-path text)
```

Every value-only scan covers `raw/EHITables/*.tsv` for **all** domains (billing/claim
lines, order/result tables, V_EHI_* views — not just the SmartData tables). No EPIC# SDI
code, no target SNOMED code, and no element-path display text appears anywhere in the
export. The 118 resources have no backing bytes in any populated table.

## Per-field absence (each line is the search that proves it)

- **`code.coding` (EPIC# SDI + urn:oid system + display)** — DATA GAP. Master is
  `CLARITY_CONCEPT` (`CONCEPT_ID` -> `NAME`), which errors "no such table" (Step 2).
  `--grep 'EPIC#'` and `--grep '31000134232|PEAB0102|PENE0001'` both return 0 tables
  (Step 3). No alternate concept master exists: `find-concept "concept"` populated hits
  are COMMUNICATION_PREFERENCES / mammography only — semantically unrelated.
- **`code.coding` (SNOMED, on 96 of 118)** — DATA GAP. The SNOMED mapping rides the same
  unshipped concept master (`CLARITY_CONCEPT` / `LAB_CASE_SNOMED`, both "no such table").
  `--grep '162718006|102599008|246875002|163600007'` returns 0 tables (Step 3).
- **`code.text` (element path)** — DATA GAP. Source is `CLARITY_CONCEPT.NAME` (unshipped).
  `--grep 'NO FOCAL DEFICIT|CVA TENDERNESS'` returns 0 tables; `find-concept "physical exam"`
  returns 0 populated tables (Steps 1, 3).
- **`component[].valueBoolean` / `valueString` / `valueQuantity` and `component[].code`**
  — DATA GAP. Values live only in
  `V_EHI_SMRTDTA_ELEM_VAL_EXT.SMRTDTA_ELEM_VALUE_EXTERNAL`; the view errors
  "no such table" (Step 2). No per-line boolean component carrier is populated anywhere.
- **`focus[]` -> DocumentReference** — DATA GAP. The element's attach key
  (`CONTACT_SERIAL_NUM` / `RECORD_ID_VARCHAR` on `SMRTDTA_ELEM_DATA`) is unshipped
  (Step 2). With zero element rows there is no element-to-document linkage to derive.
- **`performer[]` -> Practitioner** — DATA GAP. `CUR_VALUE_USER_ID` on the unshipped
  `SMRTDTA_ELEM_DATA` (Step 2). No per-element performer is recoverable.
- **`issued`** — DATA GAP. `CUR_VALUE_DATETIME` on the unshipped `SMRTDTA_ELEM_DATA`
  (Step 2). No filed-instant source for any of the 118 elements.

## Why the shipped SDD store is NOT a substitute

The only SmartData-adjacent store that *did* ship is **SDD (Social Drivers Data)**, verified
populated on 2026-06-17:

```
bun lib/q.ts "SELECT COUNT(*) FROM SDD_DATA"                       -> 22
bun lib/q.ts "SELECT COUNT(*) FROM SDD_ENTRIES"                    -> 21
bun lib/q.ts "SELECT COUNT(*) FROM V_EHI_SDD_ENTRY_INTERPRETATION" -> 19
bun lib/q.ts "SELECT COUNT(*) FROM SDOH_DOM_CONFIG_INFO"           -> 3
```

SDD is the **SDOH risk-screening** store — a different concept: domain-level concern levels
and instrument interpretations, with no EPIC# SDI, no `urn:oid` concept code, no
DocumentReference focus, and no per-line boolean component. **None of the 118
category=smartdata targets correspond to an SDD row** (none of the target EPIC#/SNOMED/path
values appears in the SDD tables per the Step 3 cross-domain scan). Mapping SDD into these
resources would be fabrication (mapping principle 4), so it is deliberately excluded. If SDD
is ever surfaced as FHIR, it belongs to a social-history Observation shard, not this
SmartData shard.

## Forward-compatibility

`src/obs-smartdata.ts` builds defensively from the real source (`SMRTDTA_ELEM_DATA` +
`V_EHI_SMRTDTA_ELEM_VAL_EXT` + `CLARITY_CONCEPT`), guarded by `tableHasRows`/`columnsOf`.
On an export that ships the generic store it will auto-populate (emitting `code`/value/
`issued`/`performer` only from real rows); on this specimen it correctly emits 0 and
fabricates nothing.

## Validator

`bun src/obs-smartdata.ts` -> `emit Observation [smartdata]: 0`.
`bun tools/validate.ts Observation` -> **0 errors**, 612 warnings (all offline-terminology /
Epic-proprietary-OID / dom-6 best-practice; none from this shard, which contributes 0
resources).
</content>
</invoke>
