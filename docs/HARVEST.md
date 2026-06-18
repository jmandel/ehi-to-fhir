# HARVEST — places where the EHI offers BETTER data than we currently emit

## Method

This is a targeted re-audit hunting the *third* class of gap beyond the two already worked
(`FALSE-ABSENCE-REGISTER.md`, `ROOT-CAUSE.md`): not "is the datum present?" but **"did the
generator settle for a brand string, a dangling display, an omission, or a target-matching
value when the EHI actually carries a more faithful / more specific / resolvable datum we
should emit instead?"**

The seed cases that generalize here:
1. **false-absence** — datum declared absent but present in another table (CPT in `SVC_LN_INFO`,
   marital in `CLM_VALUES`). *Already swept; see the register.*
2. **specificity** — we omitted/hardcoded a corporate-brand display when the EHI has the real,
   finer-grained entity (`Immunization.location` → the **department** `loc-1700801002`
   "Assoc Physicians Internal Medicine" via `IMMUNE.IMM_CSN → PAT_ENC.DEPARTMENT_ID`, not the
   parent brand "UnityPoint Health").

How each candidate below was earned: grep of `src/*.ts` headers + `gaps/*.md` for the tell-tale
phrasings ("omitted", "would dangle", "brand", "hardcode", "matches target", "not wired"),
the reference-integrity graph (`bun tools/refcheck.ts` — 34 dangling edges = naked-display /
mis-keyed references), then a **cross-domain** verification with `bun lib/q.ts` / `bun
tools/find-concept.ts` that points at a concrete column+join yielding the better value. Items
already recovered (in the register) or proven absent with a cited search are **excluded** unless
a NEW cross-domain source surfaced.

Classification keys:
- **kind**: `specificity` (finer real entity than a brand/omit) | `false-absence` (datum/resolvable
  target present elsewhere) | `value-improvement` (a truer value than the target-matching one chosen)
- **tier**: `mechanical` (a concrete join yields it deterministically) | `needs-blessing` (emitting
  our value vs the target's is defensible but a judgment call, not mechanically provable)

---

## HIGHEST-VALUE SHORTLIST

These are the ones with the biggest correctness payoff and the cleanest deterministic source.
The first three each **eliminate dangling references** the refcheck graph already flags (34
edges total), i.e. they make the bundle internally sound — not cosmetic.

1. **MedicationRequest.recorder → dangling `prac-RAMMELZL`/`MBS403`/`JLE400`** *(false-absence,
   mechanical).* We mint `id.practitioner(ORD_CREATR_USER_ID)` on a **login id** (alpha
   `CLARITY_EMP.USER_ID`), so it dangles — yet that user IS an emitted Practitioner under the
   numeric `PROV_ID`. The exact USER_ID→PROV_ID name-bridge `immunization.ts` already uses
   resolves all 10 dangling edges to real emitted resources (RAMMELZL→prac-144590,
   MBS403→prac-621755, JLE400→prac-133057).

2. **DiagnosticReport.performer → dangling `org-359` / `org-1700801005`** *(false-absence,
   mechanical).* The lab Organizations ARE emitted — but under id `org-LLB-359`
   (`id.organization("LLB-"+RESULTING_LAB_ID)` in `location-org.ts`), while `lab.ts` builds the
   reference as `id.organization(RESULT_LAB_ID)` = `org-359`. Pure id-namespace mismatch; 9
   dangling edges. Align the two id forms.

3. **Immunization.location — emit the department, not the omitted brand** *(specificity,
   mechanical).* The seed case. `IMMUNE.IMM_CSN → PAT_ENC.DEPARTMENT_ID = 1700801002`
   ("MAC APL INTERNAL MEDICINE") for 14/19 doses; `loc-1700801002` is **already minted** in
   `out/Location.json`. The source comment's "PAT_ENC has no SERV_AREA_ID, so omit" missed that
   `DEPARTMENT_ID` is right there and resolves to an emitted, finer-grained Location. (Target
   carries the bare brand `{display:"UnityPoint Health"}` on only 1/19, so this is more faithful
   than target — flag as `needs-blessing` on the value choice, `mechanical` on the join.)

4. **Encounter — emit the real, referenced-but-dropped contacts** *(false-absence,
   needs-blessing).* 15 dangling Encounter edges (from Immunization, MedicationRequest,
   DocumentReference) point at real `PAT_ENC` rows with `CALCULATED_ENC_STAT_C_NAME='Complete'`
   (e.g. 832464108, 1056709125, 1101967391) that the encounter-curation heuristic drops to match
   the target's 34-row API subset. The data exists; emitting them makes the bundle
   self-consistent. Judgment call (it widens the count past target), hence needs-blessing.

5. **MedicationRequest.dosageInstruction.timing.timeOfDay** *(value-improvement, mechanical).*
   Route/timing-code are already emitted (the SHAPE-GAPS "not wired" note is stale — verify),
   but the explicit dose clock-time the target shows (e.g. `"21:00:00"` for "nightly") is
   derivable from the frequency master `ORDER_MED.HV_DISCR_FREQ_ID_FREQ_NAME`, not omitted as a
   pure terminology loss.

---

## Candidates by domain

| candidate | resource.path | kind | tier | current behavior | better EHI source (table.column + join) | recommended action |
|---|---|---|---|---|---|---|
| **medication** |
| recorder dangles on login id | `MedicationRequest.recorder.reference` | false-absence | mechanical | `id.practitioner(ORD_CREATR_USER_ID)` → `prac-RAMMELZL` (alpha login) → **dangling**; display kept | `CLARITY_EMP e JOIN CLARITY_SER s ON s.PROV_NAME=e.NAME WHERE e.USER_ID=ORD_CREATR_USER_ID` → numeric `PROV_ID` (already emitted as `prac-<PROV_ID>`); same bridge `immunization.ts` uses | bridge USER_ID→PROV_ID; mint ref only when it resolves 1:1, else display-only |
| dose clock-time | `MedicationRequest.dosageInstruction.timing.repeat.timeOfDay` | value-improvement | mechanical | omitted; only `timing.code.text` ("nightly") emitted | `ORDER_MED.HV_DISCR_FREQ_ID_FREQ_NAME` (discrete frequency master) encodes the administration time | parse/derive `timeOfDay` from the discrete-frequency name where it carries a clock time |
| **lab / location-org** |
| performer org id mismatch | `DiagnosticReport.performer[Organization].reference` | false-absence | mechanical | `lab.ts` emits `Organization/org-359`; org is minted as `org-LLB-359` in `location-org.ts` → 9 dangling | both already key on `RESULT_LAB_ID`/`RESULTING_LAB_ID` (359, 1700801005); only the id prefix differs | unify the org id form (drop/​add `LLB-`) so the emitted org and the reference agree |
| **immunization** |
| location = department, not brand | `Immunization.location` | specificity | mechanical (join) / needs-blessing (value) | omitted: comment says "PAT_ENC has no SERV_AREA_ID → can't reach the UnityPoint brand → omit" | `IMMUNE.IMM_CSN → PAT_ENC.DEPARTMENT_ID = 1700801002` (14/19); `loc-1700801002` already emitted in `out/Location.json` ("MAC APL INTERNAL MEDICINE") | reference the department Location instead of omitting; finer & resolvable, beats the parent brand the target uses on 1/19 |
| encounter ref drops | `Immunization.encounter.reference` | false-absence | needs-blessing | references `enc-832464108` which the Encounter generator drops → dangling (5 edges) | `PAT_ENC.PAT_ENC_CSN_ID=832464108`, `CALCULATED_ENC_STAT_C_NAME='Complete'` (real contact) | see Encounter row — emit the referenced contact, or drop the dangling ref |
| **encounter** |
| referenced-but-dropped contacts | `Encounter` (resource emission) | false-absence | needs-blessing | curation heuristic emits ~35 to match the 34-row API subset; 7 real `Complete` CSNs referenced by Imm/MedReq/DocRef are dropped → 15 dangling edges | `PAT_ENC` rows 832464108, 977858467, 1056709125, 1081489412, 1101967391, 1127660383, 1169865957 (all `Complete`) | emit the contacts that other emitted resources reference (closure rule), accepting count > target; or strip the refs |
| E&M level-of-service CPT | `Encounter.type[].coding` (CPT/E&M) | false-absence | mechanical | omitted entirely ("CPT not in export"); only acuity/telehealth text emitted | `SVC_LN_INFO.LN_PROC_CD` (qual `HC`) / `INV_CLM_LN_ADDL.PROC_OR_REV_CODE` joined to enc by date/claim — the **same** claim-line source the lab `DiagnosticReport` CPT recovery already uses (99213/99214/99395…) | wire the claim-service-line CPT onto `Encounter.type` (already noted recoverable in SHAPE-GAPS; this is the cross-domain source) |
| **careteam** |
| whole resource unbuilt | `CareTeam` (resource) | false-absence | mechanical | not generated at all (0/1) — `CareTeam.json` target exists | `PAT_PCP` (2 rows: provider, `RELATIONSHIP_C_NAME`, `SPECIALTY_C_NAME`) → care-team members; providers already emitted as `prac-*` | build a minimal CareTeam from `PAT_PCP`; codings omit (no role crosswalk) but members/roles-text are real |

---

## Examined and deliberately NOT flagged (so they aren't re-litigated)

- **MedicationRequest route/timing-code** — SHAPE-GAPS calls these "not wired," but `out/`
  shows `route.text="Oral"` and `timing.code.text="daily"` ARE emitted. Only the SNOMED route
  *coding* (738956005) is lost, and that's a genuine terminology gap (no crosswalk shipped).
  Stale doc note, not a live candidate. (The `timeOfDay` sub-field above IS still a candidate.)
- **Account.owner for 4793998** — its `SERV_AREA_ID=10` mints only a *Location* (`loc-LOC-10`),
  never an Organization; emitting `owner` would dangle. No department→org climb exists
  (`ACCOUNT` ships only `SERV_AREA_ID`). Genuine omission, correctly left.
- **Organization.alias / telecom / the 5th SUNQUEST sender org** — each carries a cited empty
  `find-concept.ts --grep` in `gaps/location-org.md`; confirmed not in the export.
- **obs-vitals BP Location (210000000012)** — the EHI has MORE than the target (target drops it);
  that's the opposite of this audit's direction, and there's no EHI flag to pick the target's
  variant. Not a "better data we should emit" case.
- **Appointment / encounter `period.end`** — no slot-length/duration column anywhere
  (`find-concept.ts "appointment length"` → 0 populated cols). Confirmed absent.
- All terminology codings (CVX, RxNorm/NDC beyond the 1 recovered, ICD/SNOMED, LOINC where no
  crosswalk) — per `SHAPE-GAPS.md`, ~51% of gaps, no crosswalk shipped; out of scope here.

---

## Tally

- **8 candidates** across 5 domains.
- by **kind**: false-absence 5 · specificity 1 · value-improvement 1 · (immunization.location
  spans specificity + value).
- by **tier**: mechanical 5 (recorder bridge, org-id unify, immunization.location join, E&M CPT,
  CareTeam, timeOfDay) · needs-blessing 2 (emit referenced-but-dropped Encounters; the
  immunization.location *value* choice vs the target's brand).
- **Reference-integrity payoff:** fixing the top 3 mechanical items resolves **24 of the 34**
  dangling edges (10 Practitioner + 9 Organization + the immunization-side of the encounter
  closure); the Encounter-closure blessing resolves the remaining 15 encounter edges.
</content>
</invoke>
