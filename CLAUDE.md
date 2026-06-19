# CLAUDE.md — operating guide for agents in this repo

Auto-loaded into your context. Read this, then the two canonical references it points to, before substantive work.

## What this is
Deterministic Epic **EHI export → FHIR R4** translators, scored element-by-element against Epic's real FHIR API output, plus an interactive report and a derived skill bundle. Human overview: `README.md`. The **method** is itself the deliverable: README §"Methodology — how it was built, and how to extend it" and §"Approach & principles" are binding. This file is the operational checklist around them.

## Setup (every fresh clone)
- This repo uses a git **submodule** `my-ehi/` (public redacted raw export + the reading-EHI skill). Run `git submodule update --init --recursive` first; a missing submodule silently degrades the build.
- Raw data is at `my-ehi/raw/`; the EHI-reading skill at `my-ehi/skills/reading-epic-ehi-export/`. Translators/tools reach these via `../my-ehi/...` from `src/` and `tools/` — never `../../...` (that was the pre-submodule layout; if you see it, it's a bug).
- Build the SQLite once: `bun my-ehi/skills/reading-epic-ehi-export/scripts/load.ts my-ehi/raw ehi.sqlite`.

## Read before reasoning about the data
- **README §"Approach & principles"** — the cardinal rules. Most load-bearing: never fabricate (a blank beats an invention); **a blank EHI column is usually one join short**, so search the whole export with `bun tools/find-concept.ts "<term>"` before declaring anything absent; codings are best-effort (emit text, omit the code unless a real code ships); "faithful" means semantically faithful, not byte-identical.
- **The reading-EHI skill** `my-ehi/skills/reading-epic-ehi-export/`: `SKILL.md`, then `reference/patterns/general-patterns.md` (Epic conventions: CSN contacts, `*_DATE_REAL`, master files, base+supplement assembly, `_C_NAME` categories, `_NAME` denormalizations, history/sentinel encodings), then `reference/clinical-areas/<area>.md` for your domain. A value that looks absent is often in a companion table, a `_NAME` column, or an unjoined master file.

## The build + score loop
```
bun build.ts --apply-crosswalk --embed-attachments   # → out/ (lean) + out-crosswalk/ (enriched); prints REFERENCE INTEGRITY
bun tools/build-report-data.ts                        # → re-runs classify + report/viewer/data{,-lean}.json; prints "canonical ... faithful X%  OK"
```
`build.ts` runs each `src/*.ts` generator; failures are non-fatal (it prints `!!! <script> exited N`), so **scan the output for those lines** — a broken generator silently drops resources. Gates that must stay green: `REFERENCE INTEGRITY: 0 dangling / 0 type-violations`, `reconciles=OK`, `bun tools/refcheck.ts`, `bun tools/validate.ts <Type>` (offline-terminology errors are accepted). Every EXACT/TOLERATED/GAP element is in `compare/LEDGER.json`.

## Finding & fixing mapping / terminology gaps
Gaps live in `compare/LEDGER.json` (and the report data). Three fix surfaces:
1. **`src/<domain>.ts`** — emit a value/coding the EHI has but we don't output.
2. **`crosswalk/ALL.csv`** — reconstruct a local→standard code by pairing the EHI local code with a standard code seen elsewhere (principle 6).
3. **`tools/apply-crosswalk.ts` bridges** — a crosswalk row applies only at WIRED `fhir_path`s. A code can be known in the CSV yet never applied (a path-scoping gap). Check this first when a code is "in the crosswalk" but still GAP.

Never weaken `compare/classify.ts` (the scorer) to inflate numbers; only fix genuine key-alignment bugs there, and only to credit output we actually emit correctly.

**Use a workflow for any broad scan/fix** (README pattern: fan-out → adversarial verify → synthesize; default to `Workflow`, one investigator per gap-cluster, one skeptic per proposal). When you spawn sub-agents, **seed each** with: the README principles, the reading-EHI skill paths (plus the relevant `reference/clinical-areas/<area>.md`), and the investigation tools (`bun lib/q.ts`, `tools/find-concept.ts`). Have the skeptic re-run each EHI query to refute fabrication before any proposal is trusted. Worked example + current backlog: `docs/terminology-gap-fixes.md`; durable backlog/residual register: `docs/TODO.md`.

## After ANY change to what we emit — refresh the derived + hand-written artifacts
A mapping change silently invalidates downstream artifacts. Refresh ALL of them, in order:
1. **Data** — rerun the build + score loop above (regenerates `out*/`, `report/viewer/data*.json`).
2. **Report app & packaging** (what GitHub Pages ships — see `.github/workflows/pages.yml`): `bun report/build.ts` → `bun tools/build-skill-zip.ts` → stage `_site/` (copy `report/{index.html,styles.css,app.js}`, zip `report/health-record-assistant`) → `bun tools/cdp-test.ts` (headless smoke test; must PASS with 0 console errors).
3. **Hand-written narrative — AUDIT, it does NOT regenerate**: `report/src/summaries.json` (per-type blurbs: `howFaithful`/`whatsIdentical`/`whatDiffersAndWhy`/`whatsLost`/`mostInterestingTrick`) and `report/src/content.ts` (headline copy, faithfulness %, crosswalk-coverage line, bucket text). These assert concrete facts ("category is missing", "LOINC not reproduced") that go stale the instant you recover or lose something. Re-read each affected type against the new `compare/LEDGER.json` and rewrite.
4. **Prose with numbers** — README §"Results so far" and `docs/blog-ehi-to-fhir.md` (headline figures, and the inset gap examples: a now-fixed gap is no longer a valid "couldn't reproduce" example).

## Writing style for narrative / blog / docs
No em dashes. Avoid "X, not Y" and "not just X but Y" false-comparison constructions; state things directly. Favor brevity, clarity, euphony.
