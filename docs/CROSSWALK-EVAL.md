# Crosswalk Evaluation — coding-gap closure WITH vs WITHOUT

**What this measures.** The EHI relational export does **not** carry standard
terminology codings (LOINC / SNOMED / ICD-9 / ICD-10 / RxNorm / CVX / CPT / NDF-RT);
the reference target FHIR (`fhir-target/`) does. The opt-in *crosswalk layer*
(`tools/apply-crosswalk.ts`) re-attaches the standard codings we reconstructed in
`crosswalk/ALL.csv`. This document scores how much of the target's standard-coding
content our generated FHIR carries **without** the layer (baseline `out/`) vs **with**
it (`out-crosswalk/`).

**How to reproduce.**

```
bun build.ts --apply-crosswalk # writes baseline out/ AND enriched out-crosswalk/
bun tools/coding-coverage.ts   # the table below   (add --json for machine output)
```

Plain `bun build.ts` stays baseline-only; the `--apply-crosswalk` flag adds the
non-destructive enrichment pass into a separate directory, so baseline and enriched
both exist for side-by-side comparison.

**Honest framing — recoverability, not an independent source.** The crosswalk was
*reconstructed by pairing the EHI export with the very reference target FHIR we score
against.* So this is a **recoverability ceiling**: it shows how much of the target's
coding we can re-derive from data already present in the export, not how well an
independent coding system would do. A 100% closure for a system means "every target
code of that system is reachable from an Epic-local key the export carries," not
"we coded it from scratch." Treat these as *upper bounds on what the crosswalk can
restore*, and the residuals (below) as the real, un-recovered gaps.

## Method

For each resource **type**, we collect the set of **distinct** `(system, code)` pairs
in the standard terminologies that appear *anywhere* in the target's resources, then
check whether each exact pair is emitted *anywhere* in our output for that type
(ids are Epic-opaque, so we match by coding **value**, not by resource). Counts are
deduplicated distinct pairs — a missing LOINC that recurs on 50 resources is **one**
gap, not 50. Epic-local `urn:oid:1.2.840.114350.*` category/flowsheet systems are
passthroughs the export already carries and are **excluded** from the denominator;
they are not the coding gap under study. (Script: `tools/coding-coverage.ts`.)

## Results — by terminology system

| System    | Target codings | Baseline covered | Crosswalk covered | Δ (added) | % of gap closed |
|-----------|---------------:|-----------------:|-------------------:|----------:|----------------:|
| NDF-RT*   |             76 |        0 (  0%)   |        76 (100%)   |     **+76** |        **100%** |
| SNOMED    |             71 |        2 (  3%)   |        26 ( 37%)   |     **+24** |          35%    |
| LOINC     |             67 |       25 ( 37%)   |        44 ( 66%)   |     **+19** |          45%    |
| ICD-10-CM |             24 |        0 (  0%)   |        21 ( 88%)   |     **+21** |          88%    |
| ICD-9-CM  |             22 |        0 (  0%)   |        19 ( 86%)   |     **+19** |          86%    |
| RxNorm    |             22 |        0 (  0%)   |        22 (100%)   |     **+22** |        **100%** |
| CVX       |             11 |        0 (  0%)   |        11 (100%)   |     **+11** |        **100%** |
| CPT       |             10 |        3 ( 30%)   |         5 ( 50%)   |      **+2** |          29%    |
| **OVERALL** |        **303** |   **30 (10%)**  |   **224 (74%)**    | **+194**  |       **71%**   |

\* NDF-RT = `urn:oid:2.16.840.1.113883.3.26.1.5`, the FDA/NCI allergen ontology used
on `AllergyIntolerance.code`.

**Headline:** standard-coding coverage rises from **10% (30/303) baseline → 74%
(224/303) with the crosswalk**, closing **71% of the overall coding gap** (+194 of
the 273 missing distinct codings). *(Round-2a widened the crosswalk's LOINC coverage —
additional lab/vitals observation LOINCs now land via the standard rows — lifting
LOINC 38→44 / 57%→66% and overall 218→224 / 72%→74%.)*

## Results — BY CLASS (standard vs epic-instance-oid)

Round-2a tagged every `crosswalk/ALL.csv` row with `system_class`
(`standard` | `epic-instance-oid`) and captured the Epic-instance-OID codings that
sit in the SAME `code.coding[]` arrays as the standard codes (DiagnosticReport OID
fan-out, Medication ATC `http://www.whocc.no/atc`, Encounter/DocumentReference type
arrays). Coverage measured directly against the crosswalk-asserted
`(target_system,target_code)` pairs — the honest denominator, since every pair is
anchored to a real EHI local code and tagged crosswalk-sourced:

| Class             | Crosswalk pairs | In target | Baseline | Crosswalk | XW % | Δ |
|-------------------|----------------:|----------:|---------:|-----------:|-----:|---:|
| standard          |             284 |       284 |       45 |        228 |  80% | **+183** |
| epic-instance-oid |             602 |       602 |        0 |        602 | 100% | **+602** |
| **OVERALL**       |         **886** |   **886** |   **45** |    **830** | **94%** | **+785** |

`INTGT == XWALK` for both classes confirms every crosswalk row resolves to a real
pair in the reference target (no fabricated anchors). The epic-instance-oid class is
**100% recovered** because those codings are passthroughs the export already carries
on the same Epic-local anchor — they were previously mislabeled "truly-unrecoverable"
and dropped; capturing+tagging them (TODO #3) reattaches all 602. The `standard`
class (LOINC/SNOMED/ICD/RxNorm/CVX/CPT) reaches 80% — the residual is the same
SNOMED/LOINC observation-value tail noted below.

Reproduce: `bun tools/coding-coverage.ts` (BY-CLASS section at the bottom of the
table; `--json` emits a `byClass` array).

## Results — by resource type

| Type               | Target | Baseline | Crosswalk | Δ |
|--------------------|-------:|---------:|-----------:|---:|
| Observation        |     90 |       22 |         38 | +16 |
| AllergyIntolerance |     79 |        0 |         78 | +78 |
| Condition          |     59 |        0 |         59 | +59 |
| Medication         |     22 |        0 |         22 | +22 |
| MedicationRequest  |     12 |        0 |          0 |  +0 |
| Immunization       |     11 |        0 |         11 | +11 |
| DiagnosticReport   |      9 |        7 |          9 |  +2 |
| DocumentReference  |      8 |        0 |          0 |  +0 |
| Encounter          |      6 |        0 |          0 |  +0 |
| CarePlan           |      2 |        0 |          0 |  +0 |
| CareTeam           |      2 |        0 |          0 |  +0 |
| Specimen           |      2 |        1 |          1 |  +0 |
| Patient            |      1 |        0 |          0 |  +0 |

The layer's wins are concentrated in **AllergyIntolerance (+78)** and **Condition
(+59)**, with full closure of **Medication (+22, RxNorm)** and **Immunization (+11,
CVX)**, plus partial gains on **Observation (+16)** and **DiagnosticReport (+2)**.

## What the crosswalk fully closes vs leaves residual

**Fully / near-fully closed**

- **NDF-RT (allergens): 100%** — all 76 `AllergyIntolerance.code` allergen codes
  recovered via the Epic-local allergen coding the export carries.
- **RxNorm: 100%** and **CVX: 100%** — all 22 `Medication.code` RxNorm codes
  (bridged from `ORDER_MED.MEDICATION_ID`) and all 11 `Immunization.vaccineCode` CVX
  codes (bridged from `IMMUNE.IMMUNE_ID`), now landed via the two FALLBACK bridges
  added to the apply pass (see below).
- **ICD-10-CM: 88%** and **ICD-9-CM: 86%** — diagnosis codes on `Condition.code`,
  bridged from the export's `DX_ID` (problem-list + encounter-diagnosis). The small
  residual is a handful of target diagnoses with no verified crosswalk row.

**Partially closed (real residuals remain)**

- **SNOMED: 35% closed (26/71).** The residual is dominated by `Observation` (36
  target SNOMED, only 4 reachable) — SNOMED-coded observation *values/findings* the
  crosswalk does not cover — plus `MedicationRequest` (6), `CarePlan`/`CareTeam`,
  `Encounter`, and `Patient` codes outside the crosswalk's scope.
- **LOINC: 45% closed (19/67).** Recovered LOINCs are lab/vitals observation and
  report codes — including the blood-pressure panel + systolic/diastolic component
  LOINCs and the round-2a widening of lab/vitals observation LOINCs; the residual is
  `DocumentReference.type` (8, none reachable) and the remaining `Observation` LOINCs
  (mostly SmartData/survey items) absent from the crosswalk.
- **CPT: 29% closed (2/7 gap).** Procedure/charge codes; partial crosswalk coverage.

**Recovered by the FALLBACK-bridge fix (previously 0%)**

- **RxNorm: 22/22 (100%)** and **CVX: 11/11 (100%).** These were the single
  highest-value residual: the crosswalk already carried verified RxNorm rows
  (`Medication.code`, keyed on `ORDER_MED.MEDICATION_ID`) and verified CVX rows
  (`Immunization.vaccineCode`, keyed on `IMMUNE.IMMUNE_ID`), but they failed to land
  because of a **keying mismatch in the apply pass**: the baseline Medication /
  Immunization resources carry `MEDICATION_ID` / `IMMUNE_ID` only as an
  `identifier` (`identifier.system`/`identifier.value`), **not** as a `code.coding` /
  `vaccineCode.coding` that PRIMARY could key on, and there was no FALLBACK bridge for
  either element. **Fixed** by adding two FALLBACK bridges to
  `tools/apply-crosswalk.ts`: `Medication.code` (minted id `med-<ORDER_MED_ID>` →
  `ORDER_MED.MEDICATION_ID` → crosswalk → append RxNorm/NDC to `code.coding`) and
  `Immunization.vaccineCode` (minted id `imm-<IMMUNE_ID>` → `IMMUNE.IMMUNE_ID` →
  crosswalk → append CVX/NDC to `vaccineCode.coding`). Additive-only, idempotent,
  `ehi_verified` rows only, path-aware. This lifted overall coverage from 60% to
  **71% (216/303)** — recovering all 33 of these codings, exactly as projected. (The
  subsequent BP-LOINC cleanup then took it to **72% (218/303)**.)

## Bottom line

- **Overall standard coding coverage: 10% baseline → 74% with the crosswalk**
  (273-pair gap, 71% closed, +194 codings).
- **BY CLASS:** standard 80% (228/284, +183) · epic-instance-oid 100% (602/602, +602)
  · combined 94% (830/886, +785) of all crosswalk-asserted pairs.
- **Per-system deltas:** NDF-RT +76 (→100%), RxNorm +22 (→100%), ICD-10 +21 (→88%),
  ICD-9 +19 (→86%), SNOMED +24 (→37%), LOINC +19 (→66%), CVX +11 (→100%), CPT +2
  (→50%).
- The crosswalk **fully closes** allergens, RxNorm medications, and CVX
  immunizations, and **substantially closes** ICD diagnosis coding; it leaves real
  residuals in SNOMED/LOINC observation values and document types. (RxNorm/CVX were
  previously unrecovered due to an apply-pass keying gap; the two FALLBACK bridges
  added above closed it.)
- All figures are a **recoverability ceiling**, since the crosswalk was reconstructed
  from the same reference FHIR being scored.

**Round-2b note (no change to coding coverage).** Round 2b added provider demographics
(NPPES overlay) + DocumentReference Binary attachments — neither touches the standard-coding
crosswalk, so the table above is unchanged (overall still **74%**, 224/303). One provenance
shift worth recording: the Practitioner **NPI identifier** (`http://hl7.org/fhir/sid/us-npi`)
is now emitted in the **baseline** build (recovered from `SVC_LN_INFO.LN_REND_NPI` + the NPPES
registry), so it is no longer crosswalk-only. The identifier crosswalk layer is otherwise
unchanged (74 identifiers / 49 resources). The compare-ledger movement from round 2b lands in
the EXACT/GAP ledger (provider demographics → EXACT; attachment opaque-Binary-id → residual GAP),
not in the terminology-coverage figures — see TODO.md and SHAPE-GAPS.md.

**Round-4 note (coding coverage edges up; ledger movement is mostly shape/iso, not new systems).**
Re-scored after round 4: overall standard coverage **74%→75% (227/303 distinct pairs)**, the only
per-system mover being **SNOMED 37%→41% (29/71, +27)** as the Condition encounter-diagnosis bridge
now lets the enc-dx siblings inherit their problem-list twin's SNOMED/ICD-10/ICD-9 (Condition
distinct standard pairs **59/59**, fully closed). BY CLASS: standard **81% (231/286)** ·
epic-instance-oid **100% (808/808)** · combined **95% (1039/1094)**. The larger round-4 ledger
movement (crosswalk GAP 2709→2064, −645) is **not** new terminology systems — it is the
med dosage/route/form + course-of-therapy *text/structure* landing, the Observation US-Core
*category* derivation, and the **attachment relax finally scoring** (the
`tolerate-documentreference-content-attachment-binary` 56/56 + `-contenttype` 28/28 rules now FIRE
against the `--embed-attachments` crosswalk build — were inert in round 3). Coding-gap still falls
(crosswalk 1130→801) because the Condition SNOMED inheritance closes recurring coding leaves.
Residual coding floor is unchanged in character: SNOMED/LOINC **observation values** (no DX_ID→SNOMED
/ encrypted-flowsheet anchor) and a CPT/document-type tail. Re-score: `bun tools/coding-coverage.ts`.

**Round-6 note (reconcile + adjudication; coding-coverage table unchanged).** Round 6 added no new
crosswalk pairs and no new tolerance families, so the standard-coding coverage table above is
unchanged. The ledger moved on shape/label closure only: crosswalk+embed GAP **1940→1858 (−82)**,
EXACT **12442→12505 (+63)**, TOLERATED **1681→1700 (+19)**; coding-gap **759→734**, real-gap
**988→933**, unsure **215→191**. The floor audit re-buckets to **FLOOR 1730 / MOVABLE 100 /
UNSURE 28** (UNSURE down from 350); after manual adjudication the true split is **FLOOR 1788 /
irreducible-MOVABLE 50 / UNSURE 20** — the residual coding floor keeps its round-4 character
(SNOMED/LOINC observation values with no DX_ID→SNOMED / encrypted-flowsheet anchor, plus the
Encounter.type ENC_TYPE_C-dictionary and DocumentReference note-role-extension floors). The named
irreducible-movable coding tail is Specimen.type SNOMED (6 via `SPEC_TYPE_SNOMED`) — see TODO.md
for the full per-cluster table.

Toggle: `bun build.ts --apply-crosswalk` (baseline `out/` always; enriched `out-crosswalk/`
only with the flag). Re-score: `bun tools/coding-coverage.ts [--json]`.
