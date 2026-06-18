# Allergy domain — reconstruction gaps

Domain: `allergy` → FHIR `AllergyIntolerance` (4).
Spine: `ALLERGY` (4 rows) joined from `PAT_ALLERGIES` (PAT→LPL bridge). The 4 active
allergies equal the 4 `PROBLEM_LIST_ALL` rows with `RECORD_TYPE_C_NAME='Allergy'` and
the target count of 4. **Count matches exactly (4/4).**

## Counts
- Target `AllergyIntolerance`: 4. Generated: 4. ✅
- The 5th `PAT_ALLERGIES` row (LINE 1, `ALLERGY_RECORD_ID=30689231`) is a hard-deleted
  allergy whose LPL detail is suppressed from the export — orphan stub, no `ALLERGY` or
  `PROBLEM_LIST_ALL` row (general-patterns §32, allergies-guide Gotcha 3). The target also
  omits it (4 resources), so the inner join is correct, not a data loss.

## Coding gaps (label/text preserved, code lost)
- **`code.coding`** — target carries SNOMED CT (`http://snomed.info/sct`) plus a long list
  of MED-RT/NDF-RT NUI codes (`urn:oid:2.16.840.1.113883.3.26.1.5`) for the *drug-class*
  allergens (SULFA ANTIBIOTICS, PENICILLINS). These are Epic-terminology mappings of the
  ELG allergen; the export's allergen master `CL_ELG` ships only `(ALLERGEN_ID, ALLERGEN_NAME)`
  and `ALLERGY` carries only `ALLERGEN_ID` + the denormalized name. No SNOMED/RxNorm/NUI
  column exists anywhere in the allergy tables. **Emitted `code.text` (= allergen name) only.**
  Affects 2 of 4 (TREE NUT and PEANUT (DIAGNOSTIC) have text-only `code` even in the target).

  **Searched to prove absence (whole-export gate):**
  - `find-concept "allergen"` → only `ALLERGY` (ALLERGEN_ID + name), `CL_ELG`
    (ALLERGEN_ID + ALLERGEN_NAME), `PAT_REVIEW_ALLERGI` (name) carry allergen data; none has
    a code column. `PRAGMA table_info(CL_ELG)` = exactly `ALLERGEN_ID, ALLERGEN_NAME`.
  - `find-concept "rxnorm"` → 0 populated columns. `find-concept "snomed"` → only
    `ORDER_RESULTS` / `SPEC_*` / `ORD_RSLT_COMPON_ID` (lab/specimen, not allergens).
  - `find-concept --grep '2\.16\.840\.1\.113883\.3\.26\.1\.5'` (MED-RT NUI OID) → 0 tables
    across all `raw/EHITables/*.tsv`.
  - `find-concept --grep 'SULFA ANTIBIOTICS|PENICILLINS'` → value lives ONLY in `ALLERGY`,
    `CL_ELG`, `PAT_REVIEW_ALLERGI` (all name-only). No code source exists in any other domain.
- **`reaction.manifestation.coding`** — target maps "Hives" to SNOMED `126485001`
  (Urticaria). `ALLERGY_REACTIONS.REACTION_C_NAME` is a pre-resolved label only; this export
  ships **zero `ZC_` tables** (general-patterns §23, Gotcha 2), so neither the integer ZC
  code nor a SNOMED mapping is recoverable. **Emitted `manifestation.text` + `description` only.**

  **Searched to prove absence:**
  - `find-concept "reaction"` → `ALLERGY_REACTIONS.REACTION_C_NAME` is the only populated coded-
    reaction source ("the type of allergy reaction"), shipped pre-resolved as a label with no
    `ZC_` table and no numeric code column. `PRAGMA table_info(ALLERGY_REACTIONS)` =
    `ALLERGY_ID, LINE, REACTION_C_NAME` only. `ALT_ALLERGY_REACT` is documented-but-not-shipped.
  - `find-concept --grep '126485001'` → 0 tables across all `raw/EHITables/*.tsv`.

## Data gaps (datum itself absent)
- **`category`** — target derives `[biologic|food|medication]` per allergy from the allergen's
  class. There is **no allergen-category/class column** in `ALLERGY` or `CL_ELG`, so this is
  Epic-derived from the allergen dictionary class and not in the export. Omitted entirely.

  **Searched to prove absence:**
  - `PRAGMA table_info(CL_ELG)` (the allergen master) = exactly `ALLERGEN_ID, ALLERGEN_NAME` —
    no class/category/type-of-allergen column.
  - `PRAGMA table_info(ALLERGY)` → no class/category/type-of-allergen column
    (`SEVERITY_C_NAME` holds allergy TYPE, not allergen class — Gotcha 1).
  - `find-concept "category"` → 60 populated `_C_NAME` columns, all unrelated Epic ZC enums
    (encounter/billing/note); none is an allergen class. `find-concept "class"/"agent"/"food"/
    "environment"` likewise surface no allergen-class column on any populated allergy table.
- **`recordedDate` — sub-minute precision and timezone are inferred, not exported.** Source
  `ALRGY_ENTERED_DTTM` is a **local wall-clock instant at minute granularity** with no zone
  (e.g. `8/9/2018 9:45:00 AM` — seconds are always `:00`). The target is full UTC with real
  seconds (`2018-08-09T14:45:23Z`). We apply a fixed **UTC−05:00** offset and lose the seconds.
  Generated values match the target **to the minute** but not the second (target `:23/:51/:07/:58`
  are unreachable). **Verdict: partial — minute precision recovered, seconds genuinely lost.**

  **Searched / corroborated:**
  - `SELECT ALRGY_ENTERED_DTTM FROM ALLERGY` → `8/9/2018 9:45:00 AM`, `8/9/2018 9:46:00 AM`,
    `7/14/2020 2:34:00 PM` — all seconds `:00`, no zone. Sub-minute precision is not in the export.
  - Offset corroborated by `V_EHI_REG_ITEM_AUDIT_EPT.AUDIT_INSTANT_UTC_DTTM` vs
    `AUDIT_INSTANT_LOCAL_DTTM` (UTC `3:16:48 PM` = local `10:16:48 AM` ⇒ UTC−5, year-round
    standard time), validating the fixed `-05:00`. But those audit rows cover registration
    items, NOT the allergy-entry instant, so true UTC seconds for `ALRGY_ENTERED_DTTM` remain
    unavailable — the −05:00 is a corroborated assumption, not a stored offset.

## Fields populated from Epic defaults, not an exported datum
- **`verificationStatus` = confirmed** — `ALLERGY_CERTAINTY_C_NAME` and `ALLERGY_SOURCE_C_NAME`
  are **NULL** for all 4 rows. "Confirmed" is Epic's standard verification for a non-rejected
  active allergy (and matches the target), but it is not read from a populated column. The HL7
  code system/code/display are standard, not exported.

  **Searched to prove absence:**
  - `SELECT ALLERGY_CERTAINTY_C_NAME, ALLERGY_SOURCE_C_NAME FROM ALLERGY` → NULL for all 4 rows.
  - `find-concept "certainty"` → `ALLERGY.ALLERGY_CERTAINTY_C_NAME` is the only allergy-relevant
    certainty column, and it is empty. No populated verification/certainty datum exists anywhere.
- **`clinicalStatus` / `verificationStatus` code systems** — value ("active" / "confirmed") is
  derived/defaulted as noted above, but the HL7 `allergyintolerance-clinical` and
  `allergyintolerance-verification` system URLs are FHIR constants, not in the export. They are
  emitted **versionless** (no `version` element): the code-system version is not exported data, and
  pinning the FHIR spec version "4.0.0" caused the validator to reject the systems
  (valid code-system versions are 0.5.0/1.0.0/1.0.1, resolved automatically when versionless).
  (All 4 are Active; resolved/inactive mapping is implemented but unobserved in this specimen.)

## Fully reconstructed (no gap)
- `id`, `resourceType`, `patient` (ref + display), `code.text`, `type` (from `SEVERITY_C_NAME`,
  the mislabeled allergy-TYPE field — Gotcha 1), `criticality` (from `ALLERGY_SEVERITY_C_NAME`
  "High"→"high"), `onsetDateTime` (from `DATE_NOTED`), `clinicalStatus` value, `reaction[].text`/
  `description`. Counts and structure match the target.

## Specimen-bound mappings (open value domains)
- `type`: only "Allergy"→`allergy` observed (also map "Intolerance"→`intolerance`); other ZC
  type values not in this 4-row, all-"Allergy" specimen.
- `criticality`: only "High"→`high` observed (also map Low→`low`, Unspecified→`unable-to-assess`);
  unconfirmed against data.
