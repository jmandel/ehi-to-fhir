# EHI → FHIR

Deterministic Bun/TypeScript translators that read an Epic **EHI export** (the near-raw
thousands-of-TSV-tables dump a patient receives) and emit **FHIR R4 resources** — reconstructing,
as faithfully as the source allows, the resources Epic's live FHIR API returns.

The reference target (`../health-records-fhir.json`, split per-type into `fhir-target/`) is used as
a **reference target for evaluation**, not a thing to copy. The goal is *faithful, valid, semantically
correct* FHIR derived from the EHI — not byte-identity with Epic's output.

```bash
bun build.ts                 # run all generators → out/<Type>.json + out/bundle.json (+ reference-integrity gate)
bun build.ts --apply-crosswalk # also emit out-crosswalk/ with recovered standard codings layered on
bun compare.ts               # shape scorecard vs fhir-target/ (counts, missing paths, coding systems)
bun compare/classify.ts      # tolerance-aware ledger: every target element EXACT / TOLERATED / GAP
bun tools/validate.ts <Type> # HL7 FHIR R4 validator (US Core IG, -tx n/a)
bun tools/refcheck.ts        # reference integrity: dangling / type-violations / naked-display
bun lib/q.ts "SELECT ..."    # explore the EHI (read-only); tools/find-concept.ts to search the whole export
```

---

## The interactive report

An approachable, jargon-free report explains the whole result for a FHIR audience that has never seen
an Epic EHI export. Build it and open `report/index.html` (works over `file://`, no server):

```bash
bun install                      # react / react-dom / zustand / d3 (self-contained; no parent deps)
bun tools/build-report-data.ts   # → report/viewer/data.json (bridge) + data-lean.json (raw-export-only)
bun report/build.ts              # bundle React/Zustand/D3 → report/app.js
bun tools/cdp-test.ts            # headless-chromium smoke test (optional)
```

It is auto-built and deployed to **GitHub Pages** by `.github/workflows/pages.yml` on every push to
`main` (it bundles the committed `report/viewer/data*.json`, so CI needs no raw source). Design notes:
`report-design.md`.

## Data & privacy

This repo deliberately **does not** contain the raw record. The Epic export (`ehi.sqlite`), the raw
files (`raw/`), the reference-FHIR target (`fhir-target/`), and the generated FHIR (`out/`,
`out-crosswalk/`) are all git-ignored. What ships is the deterministic translator code plus the
**derived, redaction-safe** report data (`report/viewer/data*.json`). The specimen is the author's own
real Epic record, published with consent; direct identifiers it chose to withhold (phone, email, street,
MRN) — and one family member's name/phone — are redacted on **both** sides of every comparison, derived
from the data at build time (`tools/build-viewer.ts`), so no redaction "preimage" is ever shown.
Regenerating `report/viewer/data*.json` requires the private source, which stays local.

---

## Results so far

- **676-resource bundle**, **0 reference-integrity defects** (0 dangling, 0 type-violations), **0 real
  FHIR-validation defects** (the 125 validator errors are all accepted: 83 Epic-proprietary extensions
  carrying real values + 42 offline-terminology "can't-verify" on valid standard codes).
- **Target-matched types** reconstructed from the EHI: Patient **112/112 paths**, Condition 53/53,
  DiagnosticReport 9/9, Specimen, Immunization, Medication(Request), AllergyIntolerance, Encounter,
  Coverage, Goal, Location, Practitioner, and Observations (vitals/labs/social). Missing target paths
  **215 → 184** after the false-absence sweep.
- **New resource types we built** (no reference target; QA'd by validator + adversarial review), all
  validator-clean: **Communication** (secure messaging) and the billing/insurance set —
  **ExplanationOfBenefit, Claim, ChargeItem, Invoice, Account, PaymentReconciliation,
  CoverageEligibilityResponse**.
- **Standard-coding coverage** vs the target: **10% baseline → 71% with the crosswalk** (RxNorm, CVX,
  ICD-10/9, and allergen NDF-RT near-fully closed).
- **Tolerance-aware ledger** (every target element accounted for, reconciled):
  **14,330 = EXACT 6,293 + TOLERATED 534 + GAP 7,503** (GAP = real-gap 3,226 / unsure 957 / coding-gap 3,320).

---

## Approach & principles

1. **Faithfulness over mimicry.** We emit the truthful EHI value even when it differs from Epic's
   (e.g. the real name "Mandel, *Joshua* C", not the nickname "Josh"; the specific clinic
   "Assoc Physicians Internal Medicine", not the corporate brand "UnityPoint Health").

2. **Never fabricate; a blank beats an invention.** But a blank EHI column is usually *one join short* —
   so before declaring a datum absent, search the **whole** export (`tools/find-concept.ts`), across
   domains (billing/claim/order/`V_EHI_*` tables), not just the obvious column. This gate recovered
   **16 fields** previously mislabeled "not in export" (CPT in `SVC_LN_INFO`, marital status in
   `CLM_VALUES`, …). See `ROOT-CAUSE.md` + `FALSE-ABSENCE-REGISTER.md`.

3. **Codings are best-effort and tracked.** The EHI ships categorical values as `_C_NAME` text with no
   code columns and no terminology crosswalks, so LOINC/SNOMED/RxNorm/CVX/ICD are *normally absent*. We
   emit `text`/`display` and omit the code rather than guess. Where a code **is** in the export
   (LOINC on lab results, NDC, CPT on claim lines) we emit it.

4. **Synthetic ids → referential isomorphism, not id-equality.** Epic's FHIR ids are opaque and
   unrecoverable, so we mint deterministic ids from EHI keys (`enc-<CSN>`, `prac-<SER_ID>`). The
   invariant is that every reference **resolves within our bundle** and points at an allowed type
   (`tools/refcheck.ts`, wired as a build gate), and that our reference graph is **isomorphic** to
   Epic's by *natural key*. See `REFERENCE-INTEGRITY.md`.

5. **The specificity principle.** Prefer the most specific *real* EHI entity as a *resolvable* reference
   over omitting or hardcoding a brand. Applied everywhere via a target-derived census; a "naked-display"
   check (a `.display` with no `.reference`) gates regressions.

6. **The terminology crosswalk.** `crosswalk/ALL.csv` reconstructs Epic's local-code → standard-code
   map (346 mappings, 278 EHI-verified) by pairing the EHI's local codes with the standard codings in the
   reference target FHIR. `bun build.ts --apply-crosswalk` layers these on (additive, idempotent, no fabrication) →
   `out-crosswalk/`, lifting coding coverage 10% → 71%. We verified the missing codes have **no EHI home**
   (the master files ship bare), so the CSV sidecar — not a shadow overlay — is the right delivery
   (`shadow/DECISION.md`, `crosswalk/SOURCE-FEASIBILITY.md`).

7. **Honest comparison via reviewed tolerances.** Because we deliberately diverge (isomorphic refs,
   specific-over-brand, truthful displays), a naive "match the target" comparison would miscount. The
   tolerance registry (`compare/tolerances.ts`) classifies each delta **EXACT / TOLERATED / GAP** with
   full attribution and reconciliation — **never a blind field-ignore**. Two tiers: **mechanical**
   (a narrow predicate verifies the divergence from data and still GAPs a same-shaped regression) and
   **blessed-value** (a judgment call that *pins both exact values* so any drift resurfaces as a GAP;
   high-stakes ones require human sign-off). See `compare/TOLERANCES.md`.

---

## Layout

```
ehi.sqlite               the EHI specimen (load via ../skills/reading-epic-ehi-export/scripts/load.ts)
fhir-target/             reference FHIR per resourceType (the evaluation reference target)
lib/                     db.ts (read-only query + date helpers), ids.ts (deterministic id minting + ref),
                         gen.ts (emit + clean), profile.ts, q.ts
src/                     one generator per domain (writes out/<Type>.json; Observation sharded by category)
out/                     generated FHIR + bundle.json   ·   out-crosswalk/  enriched variant
tools/                   refcheck.ts · find-concept.ts · apply-crosswalk.ts · validate.ts (+ validator_cli.jar)
crosswalk/               the terminology crosswalk (ALL.csv + per-area) + COVERAGE/README/SOURCE-FEASIBILITY
compare/                 classify.ts (tolerance-aware) · tolerances.ts (registry) · LEDGER.json · TOLERANCES.md
build.ts                 run generators, assemble bundle, run the reference-integrity gate
compare.ts               shape scorecard vs fhir-target/
```

## Methodology — how it was built, and how to extend it

This project was produced almost entirely by **coordinated multi-agent workflows**, not solo edits. The
method is reproducible and is itself the most important deliverable.

### The unit of work is a workflow, not a single agent

A large export defeats solo reading, and a single agent's judgment is easy to fool. So every substantive
step is a **workflow** that fans many sub-agents across the surface and synthesizes what they bring back.
The recurring shapes (compose them per task):

- **Fan-out** — split the surface (resource types, domains, terminology areas) across agents that each
  return a structured finding. Used for the domain generators, the crosswalk, the residual deep-dive.
- **Adversarial verification** — for every load-bearing claim, spawn an independent skeptic *prompted to
  refute it* against real rows; keep the claim only if refutation fails. Used before any join, recovery,
  or tolerance is trusted. (The tolerance reviewers literally try to construct a regression each predicate
  would wrongly accept.)
- **Loop-until-dry** — for unknown-size discovery (gaps, dangling refs, false-absences), keep spawning
  finders/fixers until N rounds surface nothing new. Simple "top-K" passes miss the tail.
- **Triage → fix → re-verify** — a convergence loop that re-runs the gate each round (refs: dangling
  34→0 over rounds; false-absence: re-test → recover → re-test).
- **File output + schema response** — large artifacts go to files (docs, CSVs, the bundle); judgements
  come back as validated structured objects the coordinator reconciles. Nothing evaporates.

### Forcing-function gates (discipline made mechanical)

Principles decay; tools don't. Each rule is backed by a runnable gate so an agent *cannot* skip it:

- `tools/find-concept.ts` — search the **whole** export before declaring any datum absent (killed the
  "blank column = no data" failure mode; recovered 16 fields).
- `tools/refcheck.ts` — reference resolvability + type + naked-display, wired into `build.ts`.
- `tools/validate.ts` — the official HL7 FHIR R4 validator.
- `compare/classify.ts` + `compare/tolerances.ts` — a **reconciled** EXACT/TOLERATED/GAP ledger where
  every delta is attributed and no field is blindly ignored.

### The coordinator loop: a TODO-driven `/goal` cycle to a *justified* residual

The intended way to run or extend this is a **coordinator agent under a persistent `/goal`** that does
**not** stop at "looks done." Its backbone is a **durable TODO log** (`TODO.md`): every iteration reads
the log, batches what's ready into workflow round(s), executes, checks items off, and appends whatever the
round newly surfaced. The log is simultaneously the **backlog**, the **progress ledger** (checked-off items
with what moved), and the **residual register** (each remaining gap with the proof that it's irreducible).

```
LOOP (until TODO.md has no actionable item AND every residual carries its proof):
  1. MEASURE  — build (± --apply-crosswalk); run the gates (refcheck, validate, compare/classify).
  2. PARTITION & TRIAGE — bucket every delta: EXACT / TOLERATED / GAP{recoverable | approximatable |
                tolerance-candidate | truly-unrecoverable}. Turn each actionable bucket into a TODO
                entry: {what, verdict, EHI/crosswalk/external source or proof-path, effort, FILES it
                touches, dependencies}.
  3. PLAN THE ROUND — select a set of TODO items to do now and pack them into ONE workflow, or SEVERAL
                COMPATIBLE PARALLEL workflows. "Compatible" = no shared-resource races:
                  • file-disjoint — no two agents edit the same src/lib/tool/doc;
                  • serialize shared deps — edits to lib/ids.ts, build.ts, or anything every generator
                    runs go in a FOUNDATIONS phase first; dependents (a generator using a new id minter)
                    run after;
                  • avoid out/ + build.ts races — don't run two workflows that both rebuild out/ at once;
                  • a doc only one agent owns at a time (e.g. RESIDUAL-DEEPDIVE.md, TODO.md).
                Order within the round by dependency; fan the independent items in parallel.
  4. EXECUTE  — run the round; every fix adversarially reviewed; re-run the gates after.
  5. JUSTIFY  — for anything still in GAP, demand the PROOF before it may be called residual:
                  • the exhaustive search (tables AND the note corpus) showing it is truly absent, OR
                  • that it isn't crosswalk-coverable (no EHI-anchored concept/entity to key to) and
                    isn't recoverable via a cross-domain source or an external authority, OR
                  • the generation method shown infeasible/lossy, OR
                  • a reviewed tolerance with its anti-drift pin.
  6. RECORD   — CHECK OFF completed TODO items (note what moved GAP→EXACT/TOLERATED and the new ledger),
                APPEND any new items the round surfaced (e.g. "search missed the note corpus",
                "NPI is in the claim lines → NPPES overlay"), and write each justified residual with its
                proof into the gap docs. The TODO log now reflects true progress.
  REPEAT.
ONLY declare "residual cannot be reduced further" when the log is drained AND every residual carries its
justification — never because effort ran out.
```

Two rules make this safe and honest. **Compatibility (step 3)** is purely about avoiding races, so a round
can be one workflow or a fan of parallel ones — group by file-ownership, serialize shared libs/build, and
parallelize the rest. **The stop bar (step 5)** is evidence: a residual is admissible only with its proof
(searched-and-absent, not-anchorable, infeasible, or a reviewed tolerance). "We didn't try" is never a
valid residual — and in practice the floor keeps shrinking, because each "it can't be done" that gets
pushed on (crosswalk coverage, a cross-domain column, an external registry like NPPES) usually turns out
to be doable. That's why the log, not a vibe, decides when the loop ends.

### Reproduce / extend with a new agent

1. Load the EHI: `bun ../skills/reading-epic-ehi-export/scripts/load.ts <rawDir> ehi.sqlite`.
2. Start a coordinator under `/goal` describing the target (e.g. "add resource X" or "reduce the residual
   for domain Y until justified").
3. For each phase, author a small workflow script (see `workflow-*.js` for templates) that fans agents,
   adversarially verifies, and writes a doc + structured result; the coordinator reads each result and
   decides the next phase — running the loop above.
4. Keep every new generator behind the gates (`build.ts` runs refcheck; validate new types; classify the
   deltas) and add any new justified tolerance to `compare/tolerances.ts` via review, never by ignoring a
   field.

The actual sequence that built this: domain generators → anti-cheat audit → false-absence recovery →
reference-integrity (dangling→0 + specificity) → terminology crosswalk → crosswalk layer → tolerance
registry → residual deep-dive. Each was one fan-out + adversarial-review workflow; the coordinator chained
them, reading each result before launching the next.

### What was actually hard — the story behind the tidy pipeline

That sequence is the *result*, not the path. The path was a series of being wrong, getting caught, and
turning each lesson into a gate. The honest version:

- **We kept declaring data "absent" when it was sitting in another table — four times.** The first
  generators trusted the obvious column: a blank meant "not in the export." It wasn't. The lead even
  *repeated* a generator's claim that "CPT is stripped" — until the user pushed back ("no CPT anywhere?")
  and a real search found it in `SVC_LN_INFO` (claim service lines). Marital status: "no marital column
  anywhere" — wrong, it's in `CLM_VALUES` (a *claims* table). SmartData: first called a 33% data loss —
  until the user asked "did you read the RTF docs the `focus` points to?" and the findings were right
  there in the note narrative. Patient-instructions: the *thorough residual deep-dive* still called them
  ungeneratable — until the user asked "but was this in the note?" and the word "topiramate" was, verbatim,
  in the Patient Instructions RTF. Each time the fix was the same shape (search the whole export, across
  domains, before asserting absence) — but it took four reruns to internalize, and we discovered our own
  `find-concept` gate *still* had a blind spot (it never searched the unstructured note corpus). The
  "search-before-absence" rule is in this README because we violated it repeatedly.

- **We got caught cheating.** Early generators hardcoded `PATIENT_DISPLAY = "Mandel, Josh C"` — a value
  *copied from the reference target*, not derived from the EHI. The user named it ("this kind of thing is
  cheating"). That triggered the anti-cheat audit and the rule "derive, never copy" — and the truthful
  derivation gives "Mandel, **Joshua** C" (the real name), not the target's nickname. The whole "we don't
  chase the target's strings" stance is a reaction to having done exactly that.

- **The comparison turned out to be the subtle part.** Once we *deliberately* diverged — truthful names,
  specific clinics instead of the corporate brand, synthetic ids — a naive "match the target" score
  punished our *best* output as if it were a gap. The user saw the trap coming ("we need tolerances… but
  we don't want to blindly ignore fields — that causes drift and misattribution"). Designing tolerances
  that *don't* become blind ignores took two rounds: first the mechanical predicates (verify the
  divergence from data, still fail a same-shaped regression), then — on the user's prompt that "an LLM or
  human might still explicitly bless a tolerance for values" — the blessed-value tier that **pins both
  values** and escalates the high-stakes ones to human sign-off. The reconciled three-way ledger exists so
  "tolerated" can never quietly mean "ignored."

- **We built a whole subsystem and then deleted it.** To close the terminology gap we designed and built
  shadow-overlay TSVs + a shadow-aware loader to back-populate codes into EHI-shaped tables. Then the user
  pressed on whether there was a *natural home* for those codes — and the investigation showed the master
  files ship bare (no code columns, even aspirationally), so there were **zero** real homes to fill. On
  the user's "keep it simple unless there's critical mass" call, we retired the entire mechanism and kept
  the plain crosswalk CSV. Not everything we built survived contact with the evidence; `shadow/DECISION.md`
  is the tombstone.

- **Validating the whole caught bugs every per-piece check missed.** Shape-comparison and per-type checks
  were green while a real defect hid: `Encounter` dates were emitted `YYYY-DD-MM` — *every* encounter date
  silently month/day-swapped, visible only when the day exceeded 12. Only validating the assembled bundle
  surfaced it, alongside a missing required `Encounter.class`, components without `code`, and a `Claim`
  reference pointed at the wrong resource type. "Validate the whole, not just the parts" is here because
  the parts looked fine.

- **The tooling fought back.** The HL7 validator download failed twice (truncated) before a clean 186 MB
  pull; concurrent agent runs corrupted the shared `~/.fhir` terminology cache and the validator crashed
  until it was purged; and the first validate wrapper emitted a wall of *false* errors (collection-Bundle
  entries lacking absolute `fullUrl` made every relative reference look broken) — the gate itself needed
  two iterations before its output could be trusted. Agents died mid-run on socket timeouts (`draft:patient`
  died, so Patient was missing and had to be built solo afterward; `audit:patient`, `recover:location-org`,
  `classify:immunization` all dropped) — the coordinator's job included noticing the holes and patching
  them, not just reading happy-path results.

- **References didn't line up across domains.** Different generators minted the *same* provider two ways
  (`prac-RAMMELZL` from a login vs `prac-<SER_ID>`), and the curation heuristic dropped encounters that
  other resources referenced — so the graph had 34 dangling edges that took several triage→fix→re-check
  rounds, plus a judgment call (emit the real but curated-out encounters, accepting a count above the
  target's 34, rather than drop live links).

The throughline: **almost every principle in this README was learned by being wrong first — usually caught
by a pointed user question — and then made mechanical** (a gate, a census, a reconciled ledger, a pinned
tolerance) so the same mistake couldn't recur silently. The residual we report is small not because the
first pass was good, but because each wrong "it can't be done" was forced to prove itself and most didn't
survive.

## Honest residual (what's genuinely lost)

With the crosswalk on, the remaining GAP is, in priority order: **(1) terminology** Epic assigns
server-side that has no EHI home (closed by the crosswalk where verified); **(2) FHIR-server
decorations** — narrative, `meta.*`, Epic-resolved reference labels — and **un-shipped stores** (the
physical-exam **SmartData** store is the dominant known set-aside; its clinical content survives as
narrative in the linked notes); **(3) computed cross-links** (panel↔member, order→result). The
`unsure` bucket (semantic-linkage choices) and a full recoverable-vs-unrecoverable breakdown of the
crosswalk-enabled residual are analyzed in `RESIDUAL-DEEPDIVE.md`.

## Document map

`GAPS.md` (gap register) · `SHAPE-GAPS.md` (missing-path trends) · `VALIDATION.md` (FHIR validator) ·
`REFERENCE-INTEGRITY.md` · `CROSSWALK-EVAL.md` (coding coverage with/without) · `NEW-RESOURCES.md`
(comms+billing) · `FALSE-ABSENCE-REGISTER.md` + `ROOT-CAUSE.md` (the recovery sweep) · `AUDIT.md`
(anti-cheat) · `HARVEST.md` (better-data candidates) · `crosswalk/*` · `compare/TOLERANCES.md` ·
`shadow/DECISION.md` (overlay evaluated, not adopted) · `design/*` (per-resource element→EHI mapping) ·
`RESIDUAL-DEEPDIVE.md` (the crosswalk-enabled residual analysis).
