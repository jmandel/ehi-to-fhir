# ROOT CAUSE — why "absent" gaps were wrong, and the systemic fix

This is not a per-field changelog (that is `FALSE-ABSENCE-REGISTER.md`). It is the
genre-level post-mortem: *why a careful, domain-by-domain audit still mislabeled 16 reachable
fields as unrecoverable*, and what process change stops the next batch from recurring.

## What happened

A first pass produced thorough per-domain gap notes (`gaps/*.md`) consolidated into `GAPS.md`
and `SHAPE-GAPS.md`. Each gap was argued in good faith ("no marital column anywhere", "no CPT
column anywhere", "`SPEC_TYPE_SNOMED` is NULL for all 9 orders", "form isn't shipped as a
column", "entire Patient resource not produced"). A re-test with an **exhaustive** search
falsified **16** of those claims across 9 domains: each datum *was* in the export, just not in
the table the auditor looked at. Patient went 6→0 missing paths, DiagnosticReport 4→0, total
missing paths 215→184. The validator stayed at **0 real structural defects** throughout.

The failures were not careless. They were *structural* — four recurring causes, each a property
of how a human (or model) reasons about a 600-table export under time pressure.

## The four systemic causes

1. **Decoy / blank-column-as-absence.** The single most common cause. A generator checks the
   *one obvious* column on the *one obvious* table, finds it blank, NULL, or stripped, and
   concludes "not in the export." But Epic's export routinely **strips the obvious column and
   leaves the value in a sibling table**:
   - CPT was "not in the professional ARPB charge column" (a stripped decoy) — but lived in the
     **claim service line** (`INV_CLM_LN_ADDL.PROC_OR_REV_CODE`).
   - panel LOINC was "absent because `LNC_DB_MAIN` is keyed on the *component*" — but
     `ORDER_PROC_4.PROC_LNC_ID` carries the **procedure-level** LOINC.
   - the specimen SNOMED was "NULL on all 9 resulted orders" — but was populated on the
     **parent draw order** (`ORDER_PARENT_INFO.PARENT_ORDER_ID`).
   - medication form/strength was "not a column" — it was the **free-text tail of `DESCRIPTION`**.
   A blank in the expected place is *evidence of nothing*. "A blank column is rarely a real
   no-data" was already a maxim in the skill notes; the audit applied it to values but not to
   *absence claims themselves*.

2. **Domain-siloed search.** The audit was organized per-domain, and so was the search. A datum
   that lives in another domain's tables is invisible to a within-domain look. The Patient
   `PayerMemberId` lives in `COVERAGE_MEMBER_LIST` (Coverage's tables). Marital status lives in
   `CLM_VALUES` (claims). The Encounter reason text lives in `HSP_ADMIT_DIAG`+`CLARITY_EDG`. Each
   was declared absent by a domain owner who never queried the neighbor's tables.

3. **No exhaustive-search gate.** There was no required, cheap, *whole-export* search step that an
   absence claim had to pass before being written down. Absence was asserted from local knowledge,
   so the quality of each claim depended on how many tables that particular auditor happened to
   recall. Nothing forced "did you scan **all** tables and the **raw values**, or just the one you
   thought of?"

4. **Unverified gap propagation.** Once "no marital column anywhere" was written into a per-domain
   note, it was consolidated up into `GAPS.md`, summarized into `SHAPE-GAPS.md`, and cited in the
   scorecard — each layer *trusting* the one below without re-deriving it. A single unverified
   claim hardened into "established fact" across four documents. The docs had no rule requiring an
   absence to carry its own proof, so stale claims could not be spot-checked.

The through-line: **absence was treated as a default conclusion ("I didn't find it") rather than a
positive claim that must be proven ("I searched everywhere and it is not there").** Presence is
self-proving (here is the value); absence is not, and was being asserted as if it were.

## The systemic fixes (process, not patches)

1. **An exhaustive-search GATE: `tools/find-concept.ts`.** Before any datum may be declared
   absent, it must survive a search that hits **every documented table** (schema: column names,
   column descriptions, table descriptions — populated *and* not) **and** the **raw TSV values**
   (`--grep` over `raw/EHITables/*.tsv`). It reports which populated tables could hold the datum
   and a sample matching line. This collapses cause #1 and #2 into one cheap command:
   ```
   bun tools/find-concept.ts "marital"                  # schema: every table, not the obvious one
   bun tools/find-concept.ts "CPT" --grep '\b\d{5}\b'   # + raw values: which TSVs actually contain it
   bun tools/find-concept.ts --grep '[CEID-REDACTED]'   # value-only: prove a specific token is/ isn't present
   ```
   It is deliberately domain-agnostic — it searches the *whole* export — so a Patient field that
   lives in Coverage's tables can no longer hide.

2. **Cross-domain search requirement.** A field's home domain no longer owns the absence verdict.
   Because the gate searches all tables, "this datum belongs to domain X so I only looked in X's
   tables" is no longer admissible. The recoveries prove the rule pays off: 3 of 16 (Patient
   PayerMemberId/maritalStatus, Encounter reason) were strictly cross-domain.

3. **The gaps-doc rule: absence must cite the search that proves it.** `GAPS.md` and `SHAPE-GAPS.md`
   now open with a gate banner, and **every remaining absence entry carries the `find-concept.ts`
   search (term and/or `--grep` pattern) that returned empty.** An absence claim with no cited
   search is now considered unverified and inadmissible. This directly kills cause #4: a stale claim
   can be re-run in one command, and a reviewer can see the proof inline instead of trusting a
   summary of a summary.

4. **Recovery, then re-classification.** The 16 falsified claims were wired into the generators
   (`src/patient.ts`, `encounter.ts`, `condition.ts`, `medication.ts`, `immunization.ts`, `lab.ts`,
   `documentreference.ts`, `coverage.ts`) and **moved out of the unrecoverable lists** into
   `[RECOVERED]` notes citing the real source. What remains in the gap lists is now a smaller,
   *search-proven* set: terminology codes with no crosswalk shipped, values in documented-but-not-
   shipped stores (SmartData, CareTeam roster, Patient-Instructions), FHIR-server decorations
   (narrative, resolved labels, computed cross-links), and Epic-instance-OID identifiers — each
   with its proving search.

## The lesson, stated once

> **"Not in the export" is a claim, not an observation.** It is only true after an exhaustive,
> cross-domain, schema-*and*-values search returns empty — and it must ship with that search as
> evidence. A blank in the obvious column proves nothing: Epic strips obvious columns and keeps the
> value in a sibling table, another domain's table, or a free-text tail. Presence is self-proving;
> absence must be *earned*. The cost of earning it is one `find-concept.ts` invocation; the cost of
> not earning it was 16 silently dropped fields that propagated as "established" loss across four
> documents.

## Status after the recovery

- **Total field-claims re-tested in the falsified set:** 16 (across 9 domains).
- **False absences found & recovered:** 16 / 16 — all now emitted, byte-faithful to target.
- **Missing distinct paths:** 215 → **184**. Patient 6→0, DiagnosticReport 4→0, Specimen 4→1,
  Medication 18→5, Encounter 18→16, Coverage 13→11.
- **Validator:** **0 real structural defects** (125 accepted errors: 83 Epic-proprietary
  extensions carrying real values + 42 offline-terminology can't-verify). No regressions.
- **Remaining absences:** each now carries the `find-concept.ts` search that proves it; they are
  genuine (no terminology crosswalk shipped, unshipped masters/stores, server-side decorations,
  Epic-instance OIDs) and are omitted rather than fabricated.
