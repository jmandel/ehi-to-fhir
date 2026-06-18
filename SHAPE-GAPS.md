# Shape-gap audit — what the EHI can't reconstruct from Epic's live FHIR

A **shape gap** is a field path present in Epic's reference FHIR (`fhir-target/`) but absent
from what we generate (`out/`). Across the 18 target-matched resource types there are
**184 distinct missing paths** (down from 215 after the 2026-06 gap-falsification sweep
recovered 16 field-claims — Patient name/maritalStatus/PayerMemberId, Encounter type/reason
text, Condition recordedDate, Medication form/strength, Lab CPT/LOINC/component/Specimen-SNOMED,
DocumentReference custodian, Coverage type; see `FALSE-ABSENCE-REGISTER.md`). Counting raw
paths over-weights coded elements (each `coding` carries `.system`/`.code`/`.display`
children), so we also weight each path by its **prevalence** (fraction of target resources
that have it). Weighted, the gaps split:

| Trend | wt | share | recoverable from EHI? |
|---|---:|---:|---|
| **Terminology / codings lost** | 73.6 | ~51% | No (by design) |
| Other data fields | 45.1 | ~31% | **Mixed** (see below) |
| Reference `.display` labels | 7.3 | ~5% | No |
| Epic / US-Core extensions | 6.8 | ~5% | No |
| Epic-assigned identifiers | 5.5 | ~4% | No |
| Cross-resource links | 3.4 | ~2% | No (mostly) |
| Server narrative (`text.div`) | 3.0 | ~2% | No |

## The one-line answer

**What we lose is overwhelmingly *terminology*, not clinical *facts*.** ~half of all missing
field-presence is the coded form of values whose human-readable `text`/`display` we *do*
emit. The clinical content survives; the standardized codes do not — because this export
ships categorical values **pre-resolved as `_C_NAME` text with no `ZC_`/code columns and no
terminology crosswalks** (no LOINC↔flowsheet, no CVX, no RxNorm/NDC, no ICD/SNOMED maps).

## Unrecoverable trends (this is the real "lost from the original FHIR")

1. **Terminology codings (~51%).** LOINC on labs/vitals, SNOMED on problems/findings, RxNorm/NDC
   on meds, CVX on immunizations, the ICD/CPT lines on Encounters/Claims. Epic's terminology engine
   assigns these server-side; the export carries only the display text and Epic-internal ids. We emit
   `text`/`display` and omit the code rather than fabricate it. *Expected and accepted.*

2. **Server provenance & narrative (~4%).** `meta.profile` / `meta.versionId` / `meta.lastUpdated`
   and the generated `text.div` narrative. These are produced by the FHIR *server* at read time;
   they don't exist in the source database at all.

3. **Reference enrichment (~9% combined: `.display` + identifiers).** Epic resolves every reference
   target server-side and embeds a `display` name plus a business `identifier` (e.g. the encounter
   CSN identifier inside `CarePlan.encounter`). We emit bare typed references (`Encounter/enc-…`)
   that resolve correctly *within our bundle* but lack Epic's resolved labels/identifiers.

4. **Epic-curated cross-links (~2%).** `Observation.hasMember` / `derivedFrom` / `focus`
   — the panel↔member groupings and the SmartData→note `focus`. These relationships are computed
   in Epic's clinical data store; the export doesn't ship the joinable keys. **`basedOn`
   (order→result) is NO LONGER in this set** — the cleanup added a `ServiceRequest` generator
   (`src/servicerequest.ts`) keyed on `ORDER_PROC_ID`, so the order placer is now a real resource
   and `Observation.basedOn` / `DiagnosticReport.basedOn` carry a resolvable reference (preserving
   the order identifier + display). The link is recovered from the export's own order key.

5. **Genuinely absent source fields** — confirmed not materialized in *this* export **by exhaustive
   `tools/find-concept.ts` search** (every absence below cites the search that proves it):
   - **Practitioner** `active` — `CLARITY_SER` here ships only `PROV_NAME` + `EXTERNAL_NAME`; no
     status column. *(`find-concept.ts "active"` → no populated provider-master column.)*
     (`gender` / `name.prefix` / NPI `identifier` were ALSO listed here but are **RECOVERED in
     round 2b** — see the correction note below.)
   - **AllergyIntolerance.category** (food/med/environment) — no allergen-class column; only the
     allergen name/id, whose class dictionary isn't shipped. *(`find-concept.ts "allergen class"`.)*
   - **Encounter.class / visit-type labels & their codes** — `ENC_TYPE_C` is not exported and the two
     type-named `PAT_ENC` columns are 100% NULL (decoys). *(`find-concept.ts "ENC_TYPE"`.)*

   **CORRECTION — formerly listed here, now RECOVERED (these were false absences):**
   - **Patient.maritalStatus** — *not* absent: `CLM_VALUES.PAT_MAR_STAT` (joined by `PAT_MRN`) → text
     "Married". Also recovered: `Patient.name[use=usual]` (`PATIENT_3.PREFERRED_NAME`) and the
     `PayerMemberId` identifier (`COVERAGE_MEMBER_LIST.MEM_NUMBER`). Patient is now 112/112 paths.
   - **Encounter.type CPT/E&M** — the level-of-service CPT lives on the **claim service line**
     (`INV_CLM_LN_ADDL.PROC_OR_REV_CODE` / `SVC_LN_INFO.LN_PROC_CD` qual `HC`), not the stripped ARPB
     decoy column. The lab `DiagnosticReport.code.coding` CPT (80061/80048/83036) is now recovered from
     it; the encounter-level E&M line remains a wiring TODO, not an EHI limit.
   - **Practitioner `gender` / `name.prefix` / `qualification` / NPI `identifier`** (round 2b) —
     **NPI IS in the EHI** (`SVC_LN_INFO.LN_REND_NPI` + sibling `LN_*_NPI` columns), and the public
     **NPPES NPI Registry** is the authoritative external source for the rest. `src/practitioner.ts`
     now overlays NPPES (`tools/nppes-overlay.ts` + `tools/nppes-cache.json`) to emit `gender`,
     `name.prefix`, `qualification` (NUCC taxonomy), and the NPI `identifier`
     (`http://hl7.org/fhir/sid/us-npi`). **5 providers (those whose recovered NPI is in NPPES)
     match**: gender×5, `name.prefix`×4 ("Dr." for the 4 MD/DO; correctly NOT for the 1 CRNP),
     NPI×5, qualification×5. Measured ledger gain from the overlay: **+5 EXACT** on Practitioner
     (gender — the one demographic that classifies byte-identical against the target;
     prefix/qualification/official-name differ in structure from Epic's and stay GAP/unsure).
     Baseline Practitioner: 556 EXACT / 193 GAP. Answer-key Practitioner: **646 EXACT / 103 GAP**
     (the +90 over baseline is the answer-key *identifier* layer — enterprise ids — NOT more
     demographics; gender stays ×5, prefix ×4 under the answer key too). NPPES-sourced fields are
     tagged external-registry provenance (authoritative, not EHI-derived, not fabricated). `active`
     (no status anywhere) and the demographics for providers absent from NPPES remain genuine
     absences.

## Recoverable trends — these are GENERATOR shortfalls, NOT EHI limits

Honesty matters here: some shape gaps are things we *haven't built yet*, not things the EHI lacks.
Flagging them so they aren't misread as unrecoverable losses:

- **CareTeam (0 / 1).** Not built at all, yet `PAT_PCP` (2 rows) carries care-team providers — a
  minimal CareTeam is recoverable.
- **Encounter.type E&M CPT line (100%).** Recoverable from the claim service line
  (`INV_CLM_LN_ADDL.PROC_OR_REV_CODE` / `SVC_LN_INFO.LN_PROC_CD` qual `HC`: 99213/99214/99395/99396…),
  joined to the encounter by date/claim — same source the lab DiagnosticReport CPT recovery already uses.
  Wiring TODO, not an EHI limit. *(`Coverage.type` ← `COVERAGE.COVERAGE_TYPE_C_NAME` and the
  `DiagnosticReport`/`Specimen`/`Medication`/`Patient` recoveries listed above are now BUILT.)*
- **MedicationRequest.dosageInstruction route / timing — BUILT (text), with one residual coding gap.**
  `route.text` (from `MED_ROUTE_C_NAME`, e.g. "Oral") and `timing.code.text` (from
  `HV_DISCR_FREQ_ID_FREQ_NAME`, e.g. "nightly"/"daily") ARE emitted, as is
  `timing.repeat.timeOfDay` (derived from the frequency name where it encodes a clock-time —
  "nightly" → 21:00:00, "daily" → 09:00:00). The genuine residual is the **SNOMED route *coding***
  (e.g. 738956005 "Oral route"): no Epic→SNOMED route crosswalk ships, so route carries text only —
  a `[coding]` terminology loss, not a missing field. (`method` is likewise text-only where present.)
- **Organization** `telecom` / `address.use` / `alias` (~20–60%) — partially present in the EHI.
- A few smaller ones (e.g. `Encounter.participant.period`, `DocumentReference.context.period`).

## Per-resource missing-path counts

```
25 MedicationRequest   16 Encounter        11 Coverage        5 Medication          1 Specimen
23 CareTeam            12 Organization     11 Immunization     4 Goal                0 DiagnosticReport
21 Observation         11 AllergyIntoler.   5 Condition        1 Practitioner        0 Location
20 DocumentReference   16 CarePlan                                                   0 Patient
```

(CareTeam's 23 = the whole resource is unbuilt. Patient/DiagnosticReport/Location now 0 = fully
shape-matched after the recovery sweep — Patient went 6→0, DiagnosticReport 4→0, Specimen 4→1,
Medication 18→5, Encounter 18→16, Coverage 13→11. **Round 2b: Practitioner 3→1** — `gender` and
`name.prefix` recovered via the NPPES overlay; only `active` remains.)

## Round-2a update — answer-key reclassification of two "unrecoverable" trends

Two trends above were labeled *"No — by design"* but are in fact **answer-key
recoverable** because the value is anchored to a real EHI local code/entity (it just
isn't in a *named EHI column*). Round-2a captured them, tagged provenance, and proved
recovery in `out-answerkey/`:

- **Terminology / codings — `epic-instance-oid` sub-class is 100% recoverable.** The
  Epic-instance-OID codings (`urn:oid:1.2.840.114350.1.13.283…`, ATC
  `http://www.whocc.no/atc`, and the HL7 OID forms of LOINC/SNOMED/CPT) sit in the
  **same `code.coding[]` arrays** as the standard codes, anchored to the same Epic-local
  code. They were mislabeled "truly-unrecoverable" and dropped. Capturing+tagging them
  (`crosswalk` `system_class=epic-instance-oid`, 602 distinct pairs) reattaches **all
  602 (100%)** under the answer key — the biggest single GAP mover this round
  (DiagnosticReport OID fan-out alone: −2094 GAP leaves). The *standard* sub-class is
  80% recovered (228/284); combined 94% (830/886).
- **Epic-assigned identifiers (~4%) are answer-key recoverable.** Practitioner
  enterprise id (`…737384.60`), Patient CEID/APL/FHIR-ids, and the DocumentReference
  custodian `urn:ihs:ce-prd` are in the reference but no EHI table — yet each is keyed
  to an EHI-present **entity** (SER id / PAT_ID / org). `crosswalk/identifiers.csv` (74
  identifiers across 49 resources) layers them additively; this also let **50 more
  target resources align** (336→286 whole-resource gaps), expanding the comparable
  scope.

Reframed honestly: "answer-key recoverable" ≠ "in a named EHI column" — it means
*anchored to a real EHI local code/entity and tagged answer-key-sourced*, not a
verbatim no-anchor field copy. The genuinely un-recoverable residual is now the
**`standard`-class observation-value tail** (SNOMED/LOINC findings with no Epic-local
anchor) plus server-only decorations.

## Class-4 server artifacts → reviewed TOLERANCES (round-2a, TODO #6)

Trends #2/#3 above (server provenance, resolved reference labels/identifiers) are no
longer counted as raw GAPs where a *narrow, verifying* tolerance applies: round-2a
added reviewed Class-4 tolerances (`meta.versionId`/`meta.lastUpdated` structural
server-artifacts; cosmetic encounter participant/location `.display`; iso-ref opaque
ids by natural key). Baseline TOLERATED rose 582→731 (+149) with GAP −149. Each rule
still GAPs a same-shaped regression (wrong entity / changed value). See
`compare/TOLERANCES.md`.

## Round-2b update — provider demographics + DocumentReference attachment recovered

- **Provider demographics (Practitioner `gender`/`name.prefix`/`qualification`/NPI).** Was on the
  "genuinely absent" list; round 2b recovered the recoverable part via NPI-in-EHI + the public
  NPPES overlay (see item 5 correction above). **Measured: +5 EXACT** on Practitioner (the 5
  `gender` values that match the target byte-for-byte; the 5 NPPES providers). `prefix`/
  `qualification`/the NPPES `official` name are emitted (faithful, provenance-tagged) but differ
  structurally from Epic's, so they stay GAP/unsure — this is NOT 0 Practitioner gaps. Baseline
  Practitioner 556→ with overlay (already counted in 556); without the overlay it would be 551.
  Answer-key Practitioner = 646 EXACT / 103 GAP (the lift over baseline is the *identifier* layer).
- **DocumentReference `content[].attachment` now populated.** Emitting the `content[]` block
  (contentType + size + hash + creation + the IHE `format` coding, multiset-aligned to the
  target's two attachment entries) is a **measured +196 EXACT** on DocumentReference (EXACT
  794→990, GAP 1047→851, vs the no-content build). The opt-in `--embed-attachments` pass also emits
  **78 `Binary` resources** and points `attachment.url` at `Binary/<our-hashid>`; refcheck resolves
  the link (0 dangling) and the note bytes are carried faithfully in-bundle. **The url itself stays
  GAP, by design and permanently:** the target's `attachment.url = Binary/<opaque-Epic-id>` is not
  byte-reproducible (Epic's opaque server id is not in the EHI), so `content[].attachment.url`
  (×56) + `content[].attachment.contentType` (×28, Epic's `text/html` we don't fabricate) are a
  **genuine unrecoverable GAP floor**. The candidate
  `tolerate-documentreference-content-attachment-binary` rule is **DROPPED/never-applied** — the
  two urls genuinely differ, so it is NOT reclassified GAP→TOLERATED (that would be a false
  equivalence). The Binary win is self-containedness + gate coverage, not a url ledger flip.

## Round-4 update — med dosage/route/form, enc-dx codes, obs category, attachment relax

Round 4 attacked the remaining **recoverable generator shortfalls** (the "GENERATOR TODO, not a
true loss" bucket) and re-proved the floor. Movements (ex-SmartData):

- **Condition.code on encounter diagnoses — recovered.** The PAT_ENC_DX → crosswalk bridge now keys
  on the **DX_ID master key** (regardless of whether the asserting table is PROBLEM_LIST or
  PAT_ENC_DX), so the encounter-diagnosis siblings inherit the same SNOMED/ICD-10/ICD-9 the
  problem-list Condition already carried. Condition distinct standard coding pairs → **59/59 closed**;
  this is the entire SNOMED 37%→41% coverage move. No longer a shortfall.
- **MedicationRequest dosage (route, doseQuantity) and Medication form + courseOfTherapyType —
  text/structure landed** from ORDER_MED/MEDICATION (route.text/method.text, dose value/unit/UCUM,
  form text, acute-vs-continuous order class). What **remains** is only the *coding* layer (Epic
  route/form → SNOMED), which the floor audit lists as **MOVABLE-with-action** (med form/ingredient 72,
  med dosage/route 72) pending a route/form crosswalk — not no-anchor floor.
- **Observation US-Core category** (disability-status / functional-status / sdoh) — derived from the
  survey/FLO group type; generator shortfall closed.
- **DocumentReference attachment url/contentType — TOLERATED, not GAP, in the embedded answer-key
  view.** The round-2b "genuine unrecoverable GAP floor" framing below applies to the *baseline*; the
  same-note iso relax (`tolerate-documentreference-content-attachment-binary` 56/56, `-contenttype`
  28/28) now fires against the `--embed-attachments` answer-key output, where both sides resolve a
  `Binary/...` under the same note anchor and contentType is in the text-note allow-set. The opaque
  Epic Binary *id* is still not byte-reproducible — this is a tolerated iso-equivalence, not a claim
  the urls are identical.

Result: ex-SmartData answer-key GAP **2709→2064**; the floor audit now reads **FLOOR 1154 / MOVABLE
336 / UNSURE 574** (MOVABLE −570). The residual MOVABLE is dominated by med coding-via-crosswalk
(144), iso-ref/cosmetic-display families, immunization route/site, and a Specimen.type SNOMED tail —
all with named next actions, none reclassified to floor without proof.

## Round-6 update — floor re-proof, UNSURE collapse, adjudicated movable tail

Round 6 was a reconcile + full adjudication round (no new tolerance families). Ledger
(answer-key + embed, ex-SmartData): GAP **1940→1858** (−82; EXACT 12442→12505). Floor audit
**FLOOR 1730 / MOVABLE 100 / UNSURE 28** (UNSURE collapsed from 350 — most prior-UNSURE clusters
proved FLOOR). Every remaining cluster was adjudicated MOVED or FLOOR-with-proof (full table in
`TODO.md`). True post-adjudication split: **FLOOR 1788 / irreducible-MOVABLE 50 / UNSURE 20.**

Key adjudications affecting this shape-gap picture:
- **Immunization route/site — fully recovered** (byte-match target Epic-OID coding); 0 route/site gaps.
- **Practitioner.name.text** the audit flagged UNSURE is **FLOOR**: target is privacy-masked
  ("Mary S", "Dr. J Everton" = first + last-initial); we emit the truthful full CLARITY_SER PROV_NAME
  and will not mask. Same root as the "privacy-masked initials" floor line.
- **specimen/evidence iso-refs (20 UNSURE)** are proven FLOOR by the fail-closed bijection design —
  they are exactly the non-bijective refs; tolerating them = fabricating a pairing the export lacks.
- **sig-verb→SNOMED 'Take' (15)** reclassified FLOOR: ORDER_MED carries no free-text SIG/admin-instruction
  column (only MED_ROUTE_C_NAME + HV_DISCRETE_DOSE + HV_DISCR_FREQ) — no verb to crosswalk.

The **irreducible-movable 50** is a tiny, explicitly-named tail across 4 generator files, none of which
this docs-only reconcile round may edit: Immunization vaccineCode full-name (6 — source
`IMMUNZATN_ID_NAME` carries the fuller string we currently truncate), Specimen.type SNOMED via
`SPEC_TYPE_SNOMED` (6 of 16 rows carry real codes, 10 are empty=floor), surface remaining
HNO_PLAIN_TEXT note bodies (23; 82 bodies exist, 44 emitted — a subset is Epic-API-only=floor),
lab earlier result-instant (7), and NPPES gender/prefix for the 3 NPI-bearing SERs (6; the 22 NPI-less
SERs are floor).

## Takeaway

If you ask *"what can't we get back from the EHI that Epic's FHIR API gives you?"* the answer, in
priority order: **(1) standard terminology codes** (half of everything, by design), **(2) the FHIR
server's own decorations** — provenance metadata, narrative, resolved reference labels/identifiers,
and computed cross-resource links — and **(3) a short list of genuinely un-exported source fields**
(allergen class, the Epic-internal category integer codes, and `Practitioner.active`). Everything
else that's "missing" is a generator TODO, not a true loss. *(Provider demographics —
`gender`/`prefix`/`qualification`/NPI — left this list in round 2b: NPI is in the EHI and NPPES
is the authoritative external source; see the round-2b update above.)*

**A standing caveat after the 2026-06 sweep:** several items previously on that "genuinely
un-exported" list (marital status, the lab CPT/LOINC codings, medication form/strength, the usual
name) turned out to be **false absences** — the value lived in a non-obvious table. So the honest
phrasing is *"confirmed un-exported by exhaustive `find-concept.ts` search,"* never *"not in the one
column I checked."* See `ROOT-CAUSE.md` for why that distinction is load-bearing.
