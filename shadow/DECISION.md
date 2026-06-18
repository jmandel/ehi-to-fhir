# DECISION — shadow overlays vs. FHIR-answer CSV

**Question:** Are shadow overlay TSVs (back-populating recovered codings into shadowed EHI
tables) worth the machinery, or should every non-populated coding just be delivered via the
FHIR-answer CSV (`crosswalk/`)?

**Rule (user):** Keep it simple. Overlays earn their machinery **only** if there is a
**critical mass** of `documented-empty` homes — a whole high-value domain, or a large share of
the recovered codings. "Just a few" → not worth special treatment; use the FHIR CSV.

A coding's *home* (per `shadow/README.md`) is one of:
- **populated** — a shipped column already holds the code → already in the export, needs
  **neither** overlay nor CSV (recover by plain JOIN).
- **documented-empty** — a real but unshipped column/table is documented → the **only** thing an
  overlay can populate (overlay candidate).
- **none** — no documented column anywhere holds the code → must stay **FHIR-keyed** (CSV);
  fabricating a home would just be the FHIR answer key in a costume.

---

## Per-area home tallies

| area                | populated | documented-empty | none |
|---------------------|:---------:|:----------------:|:----:|
| lab                 | 2         | 0                | 1    |
| vital               | 0         | 0                | 1    |
| problem             | 0         | 0                | 6    |
| medication          | 0         | 0                | 1    |
| immunization        | — (not classified; master `CLARITY_IMMUNZATN` documented bare → no home) | 0 | — |
| allergy             | 0         | 0                | 2    |
| observation-coded   | 0         | 0                | 2    |
| other-coded         | 2         | 0                | 2    |
| **TOTAL**           | **4**     | **0**            | **15** |

(immunization has no classify file — `counts=null`. Its master `CLARITY_IMMUNZATN` is documented
with only `IMMUNZATN_ID / IMMUNZATN_ID_NAME / NAME`, so immunization→CVX has no documented home;
it contributes **zero** documented-empty homes and would classify `none` if formalized.)

## Documented-empty homes found (the only overlay candidates)

**NONE.** Zero documented-empty homes across every classified area. There is **nothing to
overlay** — the overlay-candidate list is empty.

## Verification (skepticism check)

A fabricated documented-empty home would wrongly inflate the overlay case, so each claimed home
was checked against `_schema_column` / `_schema_table`:

- **documented-empty homes claimed: 0** → nothing to verify, nothing to demote.
- **`shadow/manifest.d/` is empty** → no overlay was ever declared. Consistent with 0 candidates.
- **Populated homes are real** (columns present in `_schema_column`): `LNC_DB_MAIN.LNC_CODE`,
  `ORDER_RESULTS.COMPON_LNC_ID*` (documented as `COMPON_LNC_ID_LNC_LONG_NAME`),
  `ORDER_PROC_4.PROC_LNC_ID*` (documented as `PROC_LNC_ID_LNC_LONG_NAME`),
  `SPEC_TYPE_SNOMED.TYPE_SNOMED_CT`, `INV_CLM_LN_ADDL.PROC_OR_REV_CODE` — all verified shipped.
- **`none` is real, not lazy:** the master files are documented **bare** —
  `CLARITY_EDG` = `DX_ID / DX_NAME / PAT_FRIENDLY_TEXT` (3 cols),
  `CLARITY_MEDICATION` = `MEDICATION_ID / GENERIC_NAME` (2 cols),
  `CLARITY_IMMUNZATN` = `IMMUNZATN_ID / IMMUNZATN_ID_NAME / NAME` (3 cols).
  None carries an ICD/SNOMED/RxNorm/CVX column — not even an empty one — so diagnosis→ICD/SNOMED,
  med→RxNorm, immunization→CVX, allergen→SNOMED/NDF-RT, flowsheet→LOINC, social-hx→SNOMED all
  legitimately have **no documented home**.

## Critical-mass test

- Overlay candidates (documented-empty): **0 of 19** homes → **0%**.
- No high-value domain has even a single documented-empty home (problem, medication, allergy,
  vital, immunization — the codings we most wanted to overlay — are all `none`).
- Share of recovered codings deliverable by an overlay: **0**.

0 is the opposite of critical mass. "Just a few" would already fail the test; **zero** fails it
decisively.

## RECOMMENDATION

**SKIP overlays. Use the FHIR-answer CSV (`crosswalk/`) for every `home ≠ populated` coding.**

- The **15 `none`** codings stay FHIR-keyed in `crosswalk/*.csv`, keyed by the shipped local PK
  (`DX_ID`, `MEDICATION_ID`, `ALLERGEN_ID`, `FLO_MEAS_ID`, …). The CSV *is* their correct
  delivery format.
- The **4 `populated`** codings need neither overlay nor CSV — they already ship and recover by
  JOIN (lab→LOINC via `*_LNC_ID*`+`LNC_DB_MAIN`; specimen→SNOMED via `SPEC_TYPE_SNOMED`;
  claim-line→CPT via `INV_CLM_LN_ADDL.PROC_OR_REV_CODE`).
- The **0 `documented-empty`** codings give the overlay machinery nothing to do.

## Honest bottom line

The export's master files (`CLARITY_EDG`, `CLARITY_MEDICATION`, `CLARITY_IMMUNZATN`, and the
allergen/flowsheet/social-history tables) are documented **bare** — ID + NAME, no standard-code
column. There is therefore no documented-empty home to populate, so virtually every missing
coding is `home=none`, and the crosswalk CSV — keyed by the shipped local code — is their right
(and simplest) delivery format. Building shadow overlays would add a loader, manifest, and TSV
machinery to populate **zero** real homes. Overlays should be reconsidered **only** if a future
export documents (even empty) standard-code columns and `documented-empty` reaches critical mass.

**RECOMMENDATION: use-fhir-csv**

---

## Outcome (what's in the repo)

Adopted. The speculative overlay machinery was **removed** to keep things simple — deleted
`tools/load-shadow.ts` (the shadow-aware loader), `workflow-shadow.js`, `shadow/README.md`, the
per-area `classify-*.md`, and `shadow/manifest.d/`. This file is the kept record.

- **Canonical delivery for the 15 `home=none` codings:** `crosswalk/` (the FHIR-answer CSV,
  keyed by the shipped local code; consume via `crosswalk/demo-consume.ts`).
- **The 4 `populated` codings** need nothing — they're already in the export (recover by JOIN:
  `ORDER_RESULTS.COMPON_LNC_ID` LOINC, `SPEC_TYPE_SNOMED`, `INV_CLM_LN_ADDL` CPT, `LNC_DB_MAIN`).
- If a future export documents standard-code columns (so `documented-empty` > 0), the overlay
  approach can be rebuilt from git history.
