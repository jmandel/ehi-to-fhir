# Report Design — "How much of Epic's FHIR can you rebuild from a raw patient download?"

This is the blueprint for `report/index.html`: an interactive, **approachable** report on the EHI→FHIR
reconstruction project. Written before any UI code, per the rule that the comparison widget is only
**one component** of a much larger report.

---

## 1. Who is reading this, and what do they NOT know

**Audience:** a developer from the FHIR DevDays community. We can assume they know FHIR cold —
resources, references, profiles, US Core, terminology systems (LOINC/SNOMED/RxNorm/CVX), Bundles.

**We must assume they do NOT know, and we must never assume otherwise:**
- **What an "EHI export" is.** They've never seen Epic's raw patient-download: ~590 near-raw database
  tables as TSVs, the `_C_NAME` "category-name-but-no-code" pattern, the opaque `_ID` keys, the fact
  that codes/terminology mostly live server-side and are *absent* from the dump.
- **Any term this project invented.** They do not know "the answer key," "EXACT / TOLERATED / GAP,"
  "tolerance," "floor," "isomorphic reference," "find-concept," "false-absence," "the specificity
  principle," "rounds," "the pipeline." These are our internal shorthand. **In the report they must
  either be (a) replaced with plain language, or (b) introduced explicitly the first time, with a
  one-line definition and a glossary entry.**

**The empathy bar (non-negotiable, from user feedback):** an internal string like
`iso-ref-allergyintolerance-patient-by-patid` or evidence like *"same Patient PAT_ID Z7004242"* is
**NOT an explanation** — it's a log line. The reader needs:
> *"Epic's resource IDs are opaque server tokens; ours are derived from the export's own keys, so the
> `subject` reference looks different. That's fine — FHIR IDs are arbitrary handles, and what matters
> is that references resolve consistently. Both bundles' reference graphs have the same shape and point
> to the same real patient; we machine-verify the two IDs denote the same person before accepting it."*

Every divergence category gets a written explanation at THAT level. Raw rule-ids / DB evidence are
demoted to optional "technical detail," never the headline.

---

## 2. The story the report tells (the spine)

1. **The premise.** A US patient has two ways to get their Epic record: a developer-friendly **FHIR
   API**, and a raw **"download everything" export** (their legal right-of-access dump). The export is
   the *source data* behind the API, but near-raw — hundreds of database tables, few codes, lots of
   internal keys. **Question: starting from only the raw export, how faithfully can you rebuild the
   clean FHIR the API would have given you?**

2. **Why anyone should care.** That question is the gap between *the data you're entitled to* and *the
   data that's actually usable*. If the export can be turned back into good FHIR, patient data is far
   more portable than it looks. Where it can't, that's a concrete, evidence-backed list of what
   right-of-access loses — useful to regulators, EHR vendors, and app developers.

3. **How we keep ourselves honest.** We rebuilt FHIR from the export with deterministic code, then
   compared every single field against Epic's *own* FHIR API output for the same patient (our "answer
   key"). Every field lands in one of three buckets, and the buckets are defined so that "we matched"
   can never be faked and "we couldn't" always carries proof.

4. **The result, resource by resource.** A scorecard, then a browsable side-by-side of real examples,
   then the patterns behind the differences.

5. **A twist:** the raw export actually contains *more* than the curated API in places — billing,
   claims, secure messages — so we built FHIR resources the API never offered.

6. **The honest residual + the lesson.** What's genuinely unrecoverable and why; what it means for
   data portability.

---

## 3. The three buckets — how they're named for readers

We keep the internal names available (glossary) but lead with plain ones:

| Internal term | Reader-facing name | One-line definition shown on first use |
|---|---|---|
| EXACT | **Identical** | Byte-for-byte the same value Epic's API returned. |
| TOLERATED | **Equivalent** | Looks different, but provably means the same thing — and we say exactly why. |
| GAP (accept/floor) | **Couldn't reproduce** | Genuinely not derivable from the raw export — with the evidence of what we searched. |

Headline framing: **"Identical + Equivalent = faithfully reconstructed."** For this specimen that's
**88%** (12,560 identical + 1,703 equivalent of 16,120 fields); **12%** couldn't be reproduced, every
instance with a documented reason.

Two discipline points we surface (they're the credibility of the whole thing):
- An **Equivalent** verdict is earned by a check that re-derives the equivalence from the data and would
  still flag a *real* error — it is not "ignore this field."
- A **Couldn't-reproduce** verdict is earned by an exhaustive search of the whole export (not just the
  obvious table) — and we show what was searched.

---

## 4. Section-by-section spec

> Layout: single-page scroll with a sticky top nav (anchor links) + a persistent "Terms" button that
> opens the glossary drawer. Each section is a React component. Color language is consistent
> everywhere: **Identical = green, Equivalent = amber, Couldn't-reproduce = orange/red, Extra/EHI-only
> = blue.**

### S0 — Hero
- One-sentence premise. The headline stacked bar (Identical/Equivalent/Couldn't) with the 88% callout.
- "What this is / how to read it" two-line orientation. Anchor nav.

### S1 — Two views of the same record
- Side-by-side concept visual: **raw export** (a stylized cluster of tables; call out `_C_NAME`
  label-without-code, opaque IDs, no terminology) vs **FHIR API** (clean coded resource). Arrow:
  "rebuild this from that." Defines *EHI export* and *answer key* in plain language. ~3 short paragraphs
  + the visual. No project jargon yet beyond the two just-defined terms.

### S2 — How we scored it (the three buckets)
- Introduce Identical / Equivalent / Couldn't-reproduce with the table above, each as a card with a
  tiny real example. Explain the two discipline points (verified-equivalence, proof-carrying-gap) in
  plain language. This section is what lets every later number be trusted.

### S3 — The scorecard (interactive)
- The per-resource table (data in `report/SCORECARD-DATA.md` / `data.json summary.perType`): for each
  resource type, a 3-segment bar + counts + %faithful. Sortable (by faithful%, by size, by gap count).
- Click a row → expands to that resource's **plain-language summary** (authored from
  `report/resources/<Type>.md`, de-jargoned) and a "see examples" button that deep-links into the
  comparison widget (S4) pre-filtered to that type.
- A small D3 chart variant: resources plotted by size (x) vs faithful% (y) so the reader sees "big and
  faithful" (DiagnosticReport, Condition) vs "where the misses concentrate" (Encounter).

### S4 — Compare real resources side by side  ← the widget (one component, done well)
- **Pickers:** resource type → subgroup (e.g. Observation: *Vital Signs / Laboratory / Social History*;
  Encounter: by class; DocumentReference: by note type) → instance. Default lands on a curated sample
  (`data.json samples`: a "most divergent" and a "cleanest" per subgroup) so the reader immediately
  sees both a clean match and an instructive mismatch.
- **Side-by-side panes:** target (Epic API) vs ours (rebuilt from export), rendered as readable
  FHIR (collapsible JSON tree, not a wall). Fields are **colored by bucket**; hovering/selecting a
  differing field reveals the **plain-language rationale inline** (from the translation layer in §5),
  with the internal rule/evidence tucked behind a "technical detail" disclosure.
- **Difference list:** a compact table beneath/beside the panes — one row per differing field:
  `field · what Epic had · what we have · [Equivalent/Couldn't] · plain why`. This is the
  "rationale next to the diff" the brief asks for. Filter by bucket.
- **Empty-diff state:** when a sampled instance is byte-perfect, say so positively ("every field
  reproduced exactly") rather than showing a blank table.
- Powered entirely by `report/viewer/data.json` (already built deterministically from the trusted
  ledger; per-field bucket + rationale come from there, so the widget can't drift from the scorecard).

### S5 — Why things differ: the patterns
Two subsections, each a set of cards built from the **translation layer** (§5), every card = plain
title + what-differs + why + a real example + count + which resources it hits. NOT a rule dump.

- **5a. Equivalent-by-design** (the amber families): different IDs/same graph; reformatted display
  text; timestamps rounded to the minute; standard code systems vs Epic-proprietary ones; server
  version stamps on value sets. Each explains *why a FHIR consumer should treat these as the same*.
- **5b. Couldn't reproduce** (the orange families): Epic's internal dictionaries aren't in the export
  (visit-type names, flowsheet code maps, note-role labels); no local-code→standard-code crosswalk in
  the dump (so SNOMED/some LOINC are absent even though the *text* is preserved); server-side
  decorations (narrative, server-resolved display labels); deliberately redacted PHI; and data simply
  not exported. Each card carries the falsifiable proof ("we searched the whole export for X; the only
  candidate columns are 100% empty").
- A D3 treemap/bar of the ~12% by family so the reader sees the residual is concentrated in a few root
  causes (visit-type dictionary, flowsheet terminology, note-role extensions dominate).

### S6 — What the API never gave us (EHI-only resources)
- The raw export contains billing/claims/messaging the curated API omits. We built valid FHIR for it
  with no answer key (QA = HL7 validator + adversarial review). Show the types
  (Communication; ExplanationOfBenefit, Claim, ChargeItem, Invoice, Account, PaymentReconciliation,
  CoverageEligibilityResponse) with counts, the EHI tables each came from (plain language), and a
  browsable example each. Framed as upside, in blue, clearly separated from "gaps."

### S7 — Behind the scenes: how it was actually built (collapsible/optional)
- Short, honest version of the method for the curious: deterministic generators per domain; compare
  every field to the API; the "search the whole export before declaring something missing" rule (with
  the CPT-in-claims and marital-status-in-claims recoveries as war stories); the terminology answer-key
  that lifted code coverage from ~10% to ~71%; multi-agent workflows. De-jargoned; this is the "method
  is the deliverable" angle for DevDays, kept light and skippable.

### S8 — Honest residual & takeaways
- Plain statement of what's genuinely lost (terminology Epic assigns server-side with no home in the
  export; a few withheld dictionaries; server decorations; redacted PHI) and the portability lesson.

### S9 — Glossary / "terms we use" (always available)
- Drawer + inline tooltips. Every project term and every Epic-specific term (EHI export, `_C_NAME`,
  CSN, SER, answer key, identical/equivalent/couldn't, isomorphic graph, floor/proof-carrying, etc.)
  defined in one plain sentence. Inline `<Term>` component underlines a term and shows its definition
  on hover/tap, the first time it appears in each section.

---

## 5. The translation layer (the heart of the empathy requirement)

A single authored content module (`report/src/content.ts`) maps every machine category to
reader-facing prose. Two dictionaries:

**`EQUIVALENCE_FAMILIES`** — keyed by the tolerance `kind` already emitted in `data.json`
(`isomorphic-ref`, `cosmetic-display`, `minute-rounded-instant`, `structural-variant`,
`server-version-stamp`, `blessed-value`). Each entry:
```
{ plainTitle, whatDiffers, whyEquivalent, consumerImpact, // "should a FHIR client care? no, because…"
  techNote }  // the rule-id family + how the check still catches a real regression (disclosure only)
```
Example — `isomorphic-ref`:
- plainTitle: **"Different IDs, same connections"**
- whatDiffers: "Epic's resource IDs are opaque server tokens (`Patient/eVZ4…`); ours are minted from
  the export's own keys (`Patient/pat-Z7004242`). References therefore don't match string-for-string."
- whyEquivalent: "FHIR resource IDs are arbitrary handles — a bundle is correct as long as every
  reference resolves to the right resource *within it*. Both reference graphs have identical shape: this
  resource's subject is the one and only patient; that encounter's performer is the same physician.
  We confirm the two IDs denote the same real-world entity by a stable natural key (the patient's MRN,
  the provider's Epic ID) before calling them equivalent — so a reference pointing at the *wrong*
  resource would still be reported as a difference."
- consumerImpact: "None for a client that follows references instead of comparing ID strings."

**`COULDNT_FAMILIES`** — keyed by a small set of floor-family ids we derive from the gap rationale
(`withheld-dictionary`, `no-code-crosswalk`, `server-decoration`, `not-exported`, `redacted-phi`,
`not-byte-reproducible-instant`, `comparator-artifact`). Each entry:
```
{ plainTitle, whatsMissing, whyImpossible, whatWeDoInstead, // e.g. "we keep the text, drop the code"
  proofShape }  // what an exhaustive search showed (whole-export grep / 100%-null columns)
```
Example — `no-code-crosswalk`:
- plainTitle: **"The words survive, the codes don't"**
- whatsMissing: "Epic's API returns coded concepts (a SNOMED/ICD/LOINC code + a display); the export
  ships only the human-readable name, with no column linking it to a standard code."
- whyImpossible: "The translation from Epic's internal concept to a standard terminology lives in
  server-side master files that the export doesn't include. We searched the whole export for any table
  pairing the concept id with an ICD/SNOMED code — the candidate tables are present but empty."
- whatWeDoInstead: "We emit the concept as `text` (faithful) and omit the code rather than guess one."

Also a **`RESOURCE_SUMMARIES`** dictionary: one de-jargoned paragraph per resource type (authored from
`report/resources/<Type>.md`), shown in the scorecard drill-down. And **`GLOSSARY`** (term → plain def).

> Rule for authoring: read the technical narrative, then write what a FHIR developer who has never seen
> Epic's database needs to hear. Concrete real values are great; internal identifiers are not.

---

## 6. Data the report consumes (already built / to build)

- `report/viewer/data.json` — **built** by `tools/build-viewer.ts` (deterministic from
  `compare/LEDGER.json`). Sections: `summary` (headline + `perType` scorecard), `pairs[]` (full
  target+ours + per-field deltas with bucket, ruleId/kind, and rationale), `cantReproduce[]`,
  `ourOnly[]`, `newResources[]` (the EHI-only types), `samples` (curated per type/subgroup). Per-field
  bucket + rationale are read back from the trusted ledger so the widget reconciles with the scorecard.
- `report/SCORECARD-DATA.md` — **built**; the per-resource table (also in `data.json summary.perType`).
- `report/resources/<Type>.md` ×17 — **built** by the analysis workflow; source for `RESOURCE_SUMMARIES`.
- `report/CROSS-CUTTING.md` + `report/resources/_notarget*.md` — **pending** (analysis workflow's last
  phase); source for §5 family prose and §6. If the workflow doesn't finish them, author from
  `compare/CODING-FLOOR-AUDIT.md`, `compare/TRIAGE.md`, `NEW-RESOURCES.md`, `design/*.md`.
- `report/src/content.ts` — **to author** (the translation layer of §5; the real reader-facing words).

---

## 7. Technical architecture

- **`report/index.html`** — minimal: `<div id="root">` + `<script type="module" src="./app.js">`.
- **`report/src/app.tsx`** — React 18 entry. `import data from "../viewer/data.json"` and
  `import {content} from "./content"` so **bun inlines both into the bundle** → a single self-contained
  `app.js` that works over `file://` (no server, no fetch/CORS). data.json is ~a few MB; acceptable for
  a one-time load.
- **Build:** `report/build.ts` → `Bun.build({entrypoints:["report/src/app.tsx"], outfile:"report/app.js", minify:true})`.
  Document the one command in the report footer + README.
- **State: Zustand** — a single store: `{ section, scorecardSort, compare: {rt, subgroup, instanceId, bucketFilter}, glossaryOpen, expandedResource }`. Deep-linkable via URL hash so "see examples"
  buttons and nav anchors work.
- **Charts: D3** where it earns its place — the headline stacked bar, the scorecard size-vs-faithful
  scatter, and the residual treemap by family. Simple per-row 3-segment bars are plain CSS/flex (D3 is
  overkill there). React owns the DOM; D3 computes scales/layouts (treemap, scales) and we render with
  JSX, or use D3 in a ref'd `<svg>` for the treemap/scatter. No d3 transitions fighting React.
- **Components:** `Hero`, `ScoreBar`, `TwoViews`, `BucketsExplainer`, `Scorecard` (+ `ResourceRow`,
  `ResourceDrillIn`), `CompareWidget` (+ `Pickers`, `ResourcePane` w/ colored JSON tree, `DiffTable`),
  `FamiliesSection` (+ `FamilyCard`), `Treemap`, `NewResourcesSection`, `MethodStory`, `Residual`,
  `Glossary`, `Term` (inline tooltip). Keep each small; shared `BucketBadge`, `JsonTree`, `Bar`.
- **Styling:** one CSS file, light theme (a report, not a dev tool), generous whitespace, readable
  serif/large-sans for prose + monospace only for code/JSON. Consistent bucket colors as CSS vars.
- **Accessibility/print:** semantic headings, the report reads top-to-bottom even if JS-light; color
  never the only signal (badges carry text labels too).

---

## 8. Build sequence (after this design is accepted)

1. Let the analysis workflow finish `CROSS-CUTTING.md` + no-target docs (or backfill from existing docs).
2. Re-run `tools/build-viewer.ts` to refresh `report/viewer/data.json` (and sanity-check reconciliation).
3. Author `report/src/content.ts` — the translation layer + resource summaries + glossary (the
   highest-empathy-stakes work; do this carefully, grounded in the narratives, de-jargoned).
4. Scaffold `report/index.html` + `report/build.ts` + the Zustand store + shared components.
5. Build sections top-down: Hero/ScoreBar → BucketsExplainer → Scorecard → CompareWidget → Families →
   NewResources → Method/Residual → Glossary.
6. Build, open via file://, iterate on clarity with the "never assume EHI knowledge" lens.

## 9. Definition of done
- A FHIR developer who has never heard of Epic's EHI export can read top-to-bottom and understand: what
  was attempted, how faithful it is, *why* each kind of difference exists, and what's genuinely lost —
  **without ever needing to decode an internal rule-id or term.**
- Every divergence shown carries a plain-language reason; every internal term has a glossary entry and
  first-use definition. Numbers on every screen reconcile with the scorecard/ledger.
