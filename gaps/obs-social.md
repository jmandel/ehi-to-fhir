# Gaps — obs-social (Observation, category=social-history)

Domain owns the 4 social-history Observations: Smoking History, Alcohol Use History,
Drug Use History, Social Documentation. Source = latest `SOCIAL_HX` snapshot (current
view, §35) + latest `PAT_SOCIAL_HX_DOC` narrative. Count: 4 generated == 4 target.

## Coding gaps (concept/answer code lost; text preserved)

- **`code.coding` (LOINC + SNOMED) — Epic-assigned terminology, NOT in export.**
  Target carries LOINC (72166-2 Tobacco smoking status, 11331-6 Alcohol Use History,
  11343-1 Drug Use History, 29762-2 Social Documentation) and SNOMED concept codes
  (365980008 / 228273003 / 228366006).
  The EHI ships **no `ZC_` tables** (§23) and no concept→LOINC/SNOMED map for these;
  `LNC_DB_MAIN` is the LOINC dictionary for **labs only**, with no social-history rows.
  We emit `code.text` only.

  **Searched to prove absence (whole-export gate — re-run to falsify):**
  - `bun lib/q.ts "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ZC%'"`
    → `[]` (no concept-mapping/answer-mapping tables exist at all).
  - `bun lib/q.ts "SELECT * FROM LNC_DB_MAIN WHERE RECORD_ID IN ('72166-2','11331-6','11343-1','29762-2')"`
    → `[]` (the 27-row LOINC dictionary holds only labs/imaging; none of the four
    social-history LOINCs are present).
  - `bun tools/find-concept.ts --grep '72166-2|11331-6|11343-1|29762-2|365980008|228273003|228366006'`
    → 0 hits across every `raw/EHITables/*.tsv` (no concept code appears as a value anywhere).
  - `bun tools/find-concept.ts "smoking"` / `"tobacco"` → only `SOCIAL_HX.*_C_NAME`
    label-text columns and `CLAIM_INFO2` tobacco Y/N flags surface; **no concept-code
    column** exists on any table. `SDD_DATA`/`SDD_ENTRIES` (SDOH sibling shard) carry only
    `*_EXTERNAL` text interpretations, no LOINC/SNOMED.

- **`code.text` display — EHI label used, NOT the target's LOINC display.**
  The target's `code.text` ("Smoking History" / "Alcohol Use History" / "Drug Use
  History") are the LOINC concept **display strings**, which a full-DB exact-match scan
  shows appear **nowhere** in the EHI data (only in `_schema_*` metadata descriptions).
  The EHI's own label for each concept is the history-review type name
  `PAT_HX_REV_TYPE.HX_REVIEWED_TYPE_C_NAME`: **"Tobacco"**, **"Alcohol"**, **"Drug Use"**,
  **"Social Documentation"**. We read those labels at runtime (`hxReviewLabel()`) rather
  than copy the target's LOINC display. As a result `code.text` for the three status
  observations differs from the target ("Tobacco" vs "Smoking History", "Alcohol" vs
  "Alcohol Use History", "Drug Use" vs "Drug Use History") — the LOINC display is the
  unreachable coding gap above; the EHI text IS the faithful captured label. "Social
  Documentation" matches the target because the EHI uses the same word there.

- **`valueCodeableConcept.coding` (SNOMED answer) — Epic-assigned, NOT in export.**
  Target maps the answer to SNOMED (266919005 Never smoked, 219006 Current drinker,
  228367002 Does not misuse drugs). The EHI stores only the inline `_C_NAME` label
  (`SMOKING_TOB_USE_C_NAME='Never'`, `ALCOHOL_USE_C_NAME='Yes'`,
  `ILL_DRUG_USER_C_NAME='No'`) — no `ZC_` table, no SNOMED column. We emit
  `valueCodeableConcept.text` (the captured label); coding is unreachable.

  **Searched to prove absence (re-run to falsify):**
  - `bun tools/find-concept.ts --grep '266919005|219006|228367002'` → 0 hits across all TSVs.
  - `bun lib/q.ts "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ZC%'"`
    → `[]` (no answer-mapping table exists to carry a SNOMED answer code).
  - `bun lib/q.ts "SELECT SMOKING_TOB_USE_C_NAME, ALCOHOL_USE_C_NAME, ILL_DRUG_USER_C_NAME FROM SOCIAL_HX"`
    → only the inline label text (`'Never'`/`'Yes'`/`'No'`); the SNOMED answer coding is
    Epic-assigned and absent from the export.

## Data gaps (datum itself absent)

- **`effectivePeriod.end` (Smoking, 2026-03-20) — Epic-server-computed, NOT in export.**
  No `SOCIAL_HX`/`PAT_HX_REVIEW` column carries this future expiry/validity-end; it is
  computed by Epic's FHIR layer. End omitted rather than fabricated.
  **Searched to prove absence (re-run to falsify):**
  - `bun tools/find-concept.ts --grep '2026-03-20|3/20/2026'` → 0 hits across all TSVs
    (the value itself appears nowhere in the export).
  - `bun tools/find-concept.ts "social"` / scan of `SOCIAL_HX` + `PAT_HX_REVIEW` date
    columns → no validity/expiry/end-date column exists for any social-history concept.
  (Note: `effectivePeriod.start` is NOT independently reproduced either — see the
  anchor-selection gap below; the start the target carries is the chosen tobacco-review
  date, and the review-selection rule is itself un-derivable.)

- **Smoking `effectivePeriod.start` / `issued` / `performer` — OMITTED; anchor-selection
  rule is Epic-internal and NOT derivable.**
  The target anchors the Smoking observation to **one** tobacco history-review event
  (`PAT_HX_REVIEW` ⋈ `PAT_HX_REV_TYPE` type='Tobacco'): performer "Ashley T" =
  TAFT, ASHLEY M, review date 2024-07-02. Epic's exact rule for *which* tobacco review
  anchors the resource is not derivable — it is **neither** the latest snapshot
  (2025-12-04) **nor** the latest tobacco review (RAMMELKAMP 2025-12-04), and the
  chosen 2024-07-02 review shares its date with a **second** SER-resolvable tobacco
  reviewer (EVERTON, JENNIFER L) with no field distinguishing them. No EHI signal
  selects TAFT/2024-07-02 over the alternatives, so we **omit** the smoking
  observation's `performer`, `effectivePeriod`, and `issued` entirely rather than pin to
  the provider name the target happens to carry. (Previously the generator filtered the
  tobacco reviews by the literal name `/^TAFT,/` lifted from the target — a per-record
  special-case; removed.) The smoking value (`valueCodeableConcept.text`) is still
  derived from the latest snapshot.

  **Searched to prove the anchor rule is un-derivable (re-run to falsify):**
  - `bun lib/q.ts "SELECT DISTINCT t.PAT_ENC_CSN_ID, r.HX_REVIEWED_DATE, r.HX_REVIEWED_USER_ID, r.HX_REVIEWED_USER_ID_NAME FROM PAT_HX_REV_TYPE t JOIN PAT_HX_REVIEW r ON t.PAT_ENC_CSN_ID=r.PAT_ENC_CSN_ID WHERE t.HX_REVIEWED_TYPE_C_NAME='Tobacco' AND r.HX_REVIEWED_DATE LIKE '7/2/2024%'"`
    → **two** reviewers on CSN 1076667823 / 2024-07-02: `EVERTON, JENNIFER L` (JLE400)
    **and** `TAFT, ASHLEY M` (TAFTAM). No EHI column ranks/selects one over the other.
  - Latest snapshot is CSN 1169841954 (`PAT_ENC_DATE_REAL` 67543.01) and the latest
    tobacco review is 2025-12-04 (RAMMELKAMP) — so the target's chosen 2024-07-02 review
    is **neither** "latest snapshot" **nor** "latest review"; no monotonic rule reaches it.
  - Target `performer` display "Ashley T" and ref `e9b60AolyK2yTgurIP.sXOQ3` are
    Epic-internal; the EHI's equivalent is `'Ashley M Taft'` / `CLARITY_SER.PROV_ID 656419`
    (mintable `prac-656419`). The proxy ref exists, but with no rule to select TAFT over
    EVERTON, attaching it would be a fabricated anchor — omitted by design.

## Reference / display notes (consistent, not gaps)

- **`issued` (Alcohol / Drug only)** = latest-snapshot calendar date at America/Chicago
  local midnight in UTC (CDT→05:00Z, CST→06:00Z, via the US DST rule). Matches the
  target on the two snapshot-anchored observations. Smoking `issued` is omitted (see the
  anchor-selection data gap above).

- **`valueString` (Social Documentation)** content matches the latest filed narrative
  (`PAT_SOCIAL_HX_DOC`, CSN 1169841954). The target ends with `"... 2017. \r\n"` where
  the EHI stores `"... 2017.   "` (trailing spaces) — a pure trailing-whitespace
  normalization difference in Epic's export; we preserve the EHI's actual stored bytes
  rather than fabricate `\r\n`. The substantive text is identical.

- **Alcohol/Drug** carry no performer/effective in the target (the form captures them
  without a per-field reviewer attribution); we likewise omit them. `issued` = latest
  snapshot date.

## Not applicable to this shard

- `component`, `referenceRange`, `interpretation`, `encounter`, `basedOn`, `hasMember`,
  `derivedFrom`, `focus`, `effectiveDateTime` MISSING paths in `bun compare.ts
  Observation` belong to OTHER Observation categories (vitals/labs/survey/sdoh/
  smartdata) owned by sibling shards — not social-history. Within the social-history
  subset there are **zero EXTRA paths** and the only MISSING paths are the coding/end
  gaps above.
