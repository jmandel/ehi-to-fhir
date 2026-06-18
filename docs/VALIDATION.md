# FHIR validation report

The full generated bundle (`out/bundle.json`, **668 resources**) is validated with the
official **HL7 FHIR R4 validator** (`tools/validator_cli.jar`, v6.9.10) loaded with the
**US Core R4 IG** (so `us-core-race/ethnicity/birthsex` and US Core valuesets resolve;
no resource declares `meta.profile`, so this adds definitions only — it does not force
profile conformance) and `-tx n/a` (terminology server offline).

Reproduce:

```bash
bun build.ts                              # assemble out/bundle.json (with absolute fullUrls)
bun tools/validate.ts <ResourceType>      # validate one type
# whole bundle:
java -Xmx4g -jar tools/validator_cli.jar out/bundle.json -version 4.0.1 \
     -ig hl7.fhir.us.core.r4#8.0.1 -tx n/a -output report.json
```

## Result: 0 real structural defects

| | errors |
|---|---:|
| **Real structural defects** | **0** |
| Epic-proprietary-extension (accepted) | 93 |
| Offline-terminology can't-verify (accepted) | 50 |
| **Total reported** | **143** |

All 143 remaining errors fall into two accepted categories that are **not** defects in the
mapping:

### 1. Epic-proprietary extensions (93) — faithful data, no public StructureDefinition
DocumentReference ×88 (`clinical-note-author-provider-type`, `clinical-note-authentication-instant`;
round-7: 44 notes now surfaced × 2 extensions each, up from ×78 — same accepted class, count grew with
the additional faithfully-surfaced notes, NOT a new error type),
Coverage ×2 (`billing-organization`, `epic-id`), Encounter ×2 (`observation-datetime`), Patient ×1
(`legal-sex`). These `http://open.epic.com/...` extensions carry **real EHI-derived values** and are
valid FHIR (extensions are an open content model); the validator errors only because Epic does not
publish their definitions as a loadable package. Kept deliberately — removing them would discard
faithful data. (Standard US Core extensions DO resolve and are clean.)

### 2. Offline-terminology, code-not-verifiable (50)
Condition `clinicalStatus`/`verificationStatus` (×42) and AllergyIntolerance equivalents (×8) use the
correct standard THO codes (`active`, `confirmed`, …). With `-tx n/a` the validator cannot expand the
THO codesystem versions and so cannot confirm the required binding — an offline artifact, not a wrong
code. Running against a live terminology server clears these.

## How we got here

The new comms/billing resources were validator-clean from the start (built with the validator in the
loop). Running the validator across the **whole bundle** then surfaced genuine structural bugs in the
**original** generators (which had been QA'd only by shape-comparison against the target, never by the
FHIR validator). All were fixed:

- **Encounter** — date bug: `CONTACT_DATE` (`M/D/YYYY`) was emitted as `YYYY-DD-MM`, silently swapping
  month/day on every encounter (visible on `2020-15-07`-style dates). Fixed → correct ISO dates.
- **Encounter** — missing required `class` (1..1): now derived from `ADT_PAT_CLASS_C_NAME` → v3-ActCode
  (all AMB for this ambulatory specimen).
- **Observation (vitals)** — packed-BP `component`s lacked the required `component.code`: now carry the
  EHI flowsheet-measure coding + Systolic/Diastolic text.
- **Claim** — `referral` pointed a `Practitioner` at a slot typed `Reference(ServiceRequest)`: removed
  (the referring provider has no valid Claim slot; recorded as a `[reference]` gap).
- **CarePlan** — a timezone-less local `dateTime`: emitted date-only (no fabricated offset).

Per-type validator status for the 8 new resources (all **0 errors**): Communication 116, ChargeItem 29,
Invoice 21, Claim 21, PaymentReconciliation 24, CoverageEligibilityResponse 21, ExplanationOfBenefit 18,
Account 2. See `NEW-RESOURCES.md`.
