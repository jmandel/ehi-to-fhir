# Anti-Cheat Audit — EHI → FHIR generators

Every deterministic `src/*.ts` generator was audited for **cheating**: hardcoded or
copied literals that encode *this patient's data* (names, codes, values, dates, or
record-id-keyed decisions) instead of being read from the EHI at runtime. Each cheat was
either **derived** from the real source column or **removed + recorded as a gap** (never
replaced with a fabricated value copied from the target).

After the audit, `bun build.ts` and `bun compare.ts` both run clean: **416 resources
emitted**, all per-type counts unchanged from before the audit (no regression). Remaining
`compare.ts` diffs are pre-existing terminology/coding gaps already documented in `gaps/*.md`
(e.g. Epic-assigned LOINC/SNOMED codes that simply do not exist in the export), not cheats.

## Results by domain

| Domain | Cheats fixed | Now clean? |
|---|---:|---|
| practitioner | 0 | yes |
| location-org | 1 | yes |
| encounter | 0 | yes |
| condition | 0 | yes |
| medication | 0 | yes |
| immunization | 1 | yes |
| allergy | 1 | yes |
| lab | 2 | yes |
| obs-vitals | 2 | yes (see note) |
| obs-social | 2 | yes |
| obs-smartdata | 0 | yes |
| obs-survey | 1 | yes |
| documentreference | 2 | yes |
| careplan | 1 | yes |
| coverage | 0 | yes |
| **Total** | **13** | **15 / 15** |

(`patient.ts`'s workflow audit agent died on a stream timeout, so it was audited
**manually** afterward: every patient-specific value — sex, gender identity, race rows,
identifiers (EPI/MRN/IHS values from `IDENTITY_ID`), telecom, address — is read from the
DB; the only literals are reusable terminology/format crosswalks (race label→OMB code,
"English"→"en", state name→abbrev) applied to DB-read values, plus FHIR/HL7 system URIs.
The single legitimate rooting constant is `PATIENT_PAT_ID="Z7004242"` in `lib/ids.ts`.
Verdict: clean. The prior hardcoded `PATIENT_DISPLAY="Mandel, Josh C"` is gone —
`patientRef()` now derives "Mandel, Joshua C" from `PATIENT.PAT_NAME`.)

## Most common cheat patterns and how they were resolved

1. **Hardcoded patient display name** — e.g. a local `PATIENT_DISPLAY = "Mandel, Josh C"`
   constant passed into `patientRef(...)`.
   *Resolution: derived.* `lib/ids` now derives the patient display from
   `PATIENT.PAT_NAME`; every generator calls `patientRef()` with no argument and the local
   constant is deleted. A repo-wide scan confirms **zero** `PATIENT_DISPLAY` references
   remain, and no `mandel/josh/rammelkamp/unitypoint`-style display literals survive in `src/`.

2. **Display name of a real entity hardcoded as a string** — provider, organization,
   location, medication, or condition display text copied rather than looked up.
   *Resolution: derived* from the owning master file at runtime (e.g.
   `CLARITY_SER.PROV_NAME`, `CLARITY_EMP`, `CLARITY_DEP`, `CLARITY_LOC`, the med/dx
   dictionaries) joined on the id the generator already holds.

3. **Clinical code / `.display` / unit copied from the target** when the export carries no
   such terminology link (the dominant pattern in the Observation domains).
   *Resolution: removed + gap.* The field is omitted and the loss recorded in `gaps/*.md`
   with a `[coding]` tag. The truthful datum is still surfaced (e.g. flowsheet measure-id
   coding + `text`), but Epic-terminology-assigned LOINC/SNOMED codes that are not in the
   export are never fabricated.

4. **Value / unit that should be read from a column** but was written as a literal.
   *Resolution: derived* — read from the actual EHI column (e.g. SpO2 unit from the
   `UNITS` column). The one surviving unit literal (Pulse `/min`, where `UNITS` is NULL) is
   a documented physiologic-standard derivation, not a copied answer, and is recorded in
   `gaps/obs-vitals.md`.

5. **Record-id special-casing / include-exclude lists lifted from the target.**
   *Resolution: derived or removed.* Membership is computed from the EHI (e.g. vital-signs
   membership is the `IP_FLWSHT_MEAS.FLT_ID_DISPLAY_NAME = 'Encounter Vitals'` template
   filter, read from the DB — not a hand-listed measure-id set). Where a target curation
   choice is genuinely unrecoverable (target drops BP Location, surfaces one of five
   near-identical BMI variants), the generator does the EHI-truthful thing and records the
   resulting count delta as a gap rather than copying an id list out of the answer.

## Domains still NOT clean

**None.** All 15 audited generators are clean: all carry an empty residual-cheat list, and
the whole project builds with counts intact.

**Note on obs-vitals.** The automated adversarial-verify pass returned `clean: false` for
this domain, but its residual-cheat list was **empty** — i.e. it flagged the domain without
naming any concrete remaining cheat (the cheats it originally found were resolved in the
corrective round). An independent line-by-line re-audit during finalization found **no
substantiable cheat**: every literal in `src/obs-vitals.ts` is either a FHIR/UCUM system
URI (legit), a documented unit/conversion derivation, a DB-read filter value, or read
directly from the EHI. The remaining `compare.ts` differences are the LOINC/SNOMED/Epic
flowsheet-id coding gaps already enumerated in `gaps/obs-vitals.md`. obs-vitals is therefore
treated as clean.
