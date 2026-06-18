# Crosswalk coverage — how much of our coded data is now bridgeable

Generated from `ALL.csv` (the merge of all per-area files). Numbers are computed
directly from the merged rows, not estimated. Regenerate with `bun run stats.ts`.

- **rows** — crosswalk rows for the area (one row per local-code → one standard-system mapping; a 1:n concept fans out to several rows).
- **ehi_verified rows** — rows whose `epic_local_code` was confirmed present in `ehi_join_table.ehi_join_column`, i.e. the JOIN actually fires against *this* export.
- **distinct concepts** — distinct local codes (`epic_local_code`, falling back to `concept_display`) the area touches.
- **target systems** — the standard terminologies attached.
- **unanchored (residual)** — rows we could derive a standard code for but could **not** confirm against the EHI (`ehi_verified=no`); these are the explicit residual gap.

> Note on areas vs files: the eight builder CSVs split into **ten** logical `area`
> values once merged. `observation-coded.csv` carries three areas — `survey`
> (LOINC questionnaire/ROS), `smartdata` (SmartData SDE elements), and `social`
> (social-history observations); `other-coded.csv` is the `other` area.

| area | rows | ehi_verified rows | distinct concepts | target systems | unanchored (residual) |
|---|---:|---:|---:|---|---:|
| allergy | 78 | 78 | 2 | SNOMED CT; Epic allergen OID | 0 |
| problem | 72 | 72 | 22 | ICD-10-CM; SNOMED CT; ICD-9-CM | 0 |
| smartdata | 37 | 0 | 37 | SNOMED CT | 37 |
| survey | 37 | 20 | 33 | LOINC | 17 |
| lab | 31 | 31 | 26 | LOINC; CPT (urn:oid 6.12) | 0 |
| medication | 22 | 22 | 5 | RxNorm | 0 |
| other | 21 | 14 | 19 | LOINC; SNOMED CT; CPT; SOPT; US-Core careplan-category | 7 |
| immunization | 20 | 20 | 19 | CVX; NDC | 0 |
| vital | 18 | 18 | 8 | LOINC | 0 |
| social | 10 | 3 | 7 | LOINC; SNOMED CT | 7 |
| **TOTAL** | **346** | **278** | **178** | — | **68** |

## What this means

**Closeable today (high `ehi_verified`).** Six areas anchor 100% of their rows
against this export and are effectively *closed* — a generator that LEFT JOINs the
crosswalk on the local code recovers every standard coding it would otherwise drop:

- **lab** — every `ORDER_RESULTS.COMPONENT_ID` resolves to LOINC (31/31).
- **vital** — every flowsheet `FLO_MEAS_ID` resolves to LOINC (18/18).
- **problem** — every `PROBLEM_LIST.DX_ID` resolves to ICD-10/SNOMED/ICD-9 (72/72); see `demo-consume.ts`.
- **medication** — every `MEDICATION_ID` resolves to RxNorm (22/22).
- **immunization** — every vaccine resolves to CVX (+NDC) (20/20).
- **allergy** — both allergen concepts resolve to SNOMED CT (78/78).

These six account for **241 of 278 verified rows (87%)** and are the terminology
areas you can stop treating as shape gaps.

**Partial — coded in the reference FHIR, partially anchorable here.**

- **survey** (LOINC, 20/37) and **other** (mixed, 14/21) anchor a majority of rows;
  the residual is concepts whose local key isn't carried (or isn't carried in a
  join-able column) in this particular export.
- **social** (3/10) is mostly unanchored — the social-history local codes are thin
  in this export.

**Still a gap — `ehi_verified=no` across the board.**

- **smartdata** (0/37). The SmartData/SDE local store that holds these element
  values **is not shipped** in this EHI export, so although we can name the SNOMED
  target for each element from the reference FHIR, there is no `ehi_join_column` to
  JOIN against. Every smartdata row is residual. This is the single biggest gap and
  is a *missing-table* problem, not a missing-mapping problem — it can only close if
  Epic ships the SDE store (or the crosswalk *and* its source rows).

## Headline

- **Rows bridgeable: 278 / 346 = 80.3%** of crosswalk rows fire against this export.
- **Concepts bridgeable: 114 / 178 = 64.0%** of distinct coded concepts can have
  standard codings re-attached today.
- **Biggest residual gaps (68 unanchored rows):** `smartdata` (37, SDE store
  unshipped) ≫ `survey` (17) > `other` (7) = `social` (7). Excluding smartdata, the
  rest of the export is **278 / 309 = 90%** bridgeable — i.e. the shape gap is
  overwhelmingly concentrated in the one table Epic doesn't export.
