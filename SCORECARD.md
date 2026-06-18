# SCORECARD — EHI → FHIR reconstruction

Build: `bun build.ts` runs all 16 generators clean (no generator errors) and assembles
**`out/bundle.json` = 411 resources**. Scoring is by *shape* (`bun compare.ts`): resource
counts plus the set of dotted field paths present in generated (`out/`) vs target
(`fhir-target/`). Resource ids are Epic-opaque and intentionally not compared.

Columns:
- **target / generated** — resource counts.
- **target-paths** — distinct field paths the target uses for this type.
- **produced-paths** — of those, how many we also produce (= target-paths − still-missing).
- **still-missing-paths** — target paths we do not produce (every one is itemized in `GAPS.md`).
- There are **0 EXTRA paths** in any type (no generator invents a field the target lacks;
  the only over-emission is value-level, e.g. eGFR `valueQuantity.system`, noted in GAPS.md).

| Resource type | target | generated | target-paths | produced-paths | still-missing-paths |
|---|---:|---:|---:|---:|---:|
| AllergyIntolerance | 4 | 4 | 38 | 29 | 9 |
| CarePlan | 4 | 1 | 42 | 26 | 16 |
| CareTeam | 1 | 0 | 23 | 0 | 23 |
| Condition | 53 | 53 | 45 | 40 | 5 |
| Coverage | 1 | 1 | 81 | 68 | 13 |
| DiagnosticReport | 9 | 9 | 44 | 40 | 4 |
| DocumentReference | 51 | 39 | 82 | 65 | 17 |
| Encounter | 34 | 35 | 74 | 52 | 22 |
| Goal | 1 | 1 | 19 | 15 | 4 |
| Immunization | 19 | 19 | 64 | 53 | 11 |
| Location | 6 | 6 | 4 | 4 | 0 |
| Medication | 18 | 18 | 29 | 11 | 18 |
| MedicationRequest | 18 | 18 | 103 | 78 | 25 |
| Organization | 5 | 4 | 29 | 16 | 13 |
| Patient | 1 | 0 | 112 | 0 | 112 |
| Practitioner | 29 | 30 | 16 | 13 | 3 |
| Specimen | 9 | 9 | 19 | 15 | 4 |
| **Observation (all shards)** | **358** | **164** | **104** | **85** | **19** |

### Observation sub-shards
`compare.ts` merges every `Observation*` file, so the row above aggregates all five shards
(merged path stats: 104 target-paths, 85 produced, 19 missing). Per-shard resource counts:

| Observation shard | target | generated | status |
|---|---:|---:|---|
| vital-signs | 57 | 57 | complete — every value/unit/flag matches |
| laboratory | 46 | 46 | complete |
| social-history | 4 | 4 | complete |
| survey | 132 | 57 | 57 value-bearing leaves produced; 75 Epic-synthesized group/panel/header rows not in export |
| smartdata | 118 | 0 | whole shard — backing store not shipped in this export |

## Overall summary

- **Resources:** target 622 / generated 411 (66%).
- **Resource types fully count-matched (generated == target):** Condition (53), Medication &
  MedicationRequest (18 each), Immunization (19), AllergyIntolerance (4), Coverage (1), Goal (1),
  Location (6), Specimen (9), DiagnosticReport (9), and Observation vital-signs (57), laboratory
  (46), social-history (4). Encounter (35 vs 34) and Practitioner (30 vs 29) are honest, fully
  derivable supersets (the +1 in each is an Epic-curation/duplication artifact, not reproducible).
- **Path coverage** on the types we do produce is high; nearly every still-missing path is a
  **[coding]** gap — a LOINC / SNOMED / RxNorm / CVX / ICD / CPT / NUCC / Epic-instance-OID code
  that this export does not ship (no `_C` columns, no `ZC_` tables, no terminology crosswalks).
  The human-readable `.text`/`.display`/value is preserved in every such case. These are expected
  and acceptable.
- The **remaining resource-count shortfall (211 resources) is concentrated in exactly three
  [data] gaps**: smartdata (118), survey group/panel rows (75), and DocumentReference Summary +
  imaging families (23) — every one a store or artifact Epic does not ship in the EHI export.
- **0 fabricated paths** across all types — the pipeline never invents a field absent from the target.

## Top remaining opportunities (ranked by reachable value)

1. **Patient (0/1, 112 paths)** — *highest-value, mostly reachable.* No Patient generator exists,
   yet the demographics/identifiers/contacts largely live in the export. Writing `src/patient.ts`
   would close 112 missing paths and add the one resource every other domain references.
2. **DocumentReference clinical-note selection (39 vs 28)** — tighten the release predicate so the
   11 extra shared signed notes are excluded (or accept the documented superset). The 23 Summary/
   imaging resources remain a true data gap, but the note count is the actionable part.
3. **Survey + smartdata leaf fidelity** — the 75 survey group rows and 118 smartdata resources are
   unreconstructable data gaps, but `src/obs-smartdata.ts` already auto-populates if a future export
   ships `SMRTDTA_ELEM_DATA`; documenting this as export-dependent (not a code defect) is the win.
4. **Medication drug-name source + lab `issued`/`note` defects** — switch `Medication.code.text` to
   `AMB_MED_DISP_NAME` (closer to target than UPPERCASE `DESCRIPTION`); fix lab `issued` to prefer
   LAST_FINAL over the correction date and strip the doubled trailing CRLF in 4 lab notes. Pure
   correctness, no new data needed.
5. **CarePlan dateTime validity + Encounter "Therapies Series" type** — emit
   `scheduledPeriod.start` as a date-only or offset-qualified value (the current offset-less
   time-bearing dateTime is invalid FHIR), and populate `type[].text` = "Therapies Series" for the 2
   HOV encounters from `ADT_PAT_CLASS_C_NAME` (a small reachable slice currently listed as unreachable).
