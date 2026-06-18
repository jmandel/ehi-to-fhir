# Refactor Result — G0–G9 central-lib consolidation, final reconcile

**Date:** 2026-06-18  **Branch:** main  **Outcome:** ALL STEPS PASS.

This is the post-refactor verification ledger for the `CONSOLIDATION-PLAN.md` §4 sequence
(G0–G9). Two postures, both confirmed: every **pure-move** step is byte-identical to the
golden output, and the one **behavior-unifying** step (G8 timezone) is bounded to its
enumerated diff — which, for this patient's data, is realized as **zero** byte changes.

---

## Per-step verification summary

| Step | Command(s) | Result |
|---|---|---|
| **1. Both builds run** | `bun build.ts`; `bun build.ts --apply-crosswalk --embed-attachments` | **PASS** — both exit 0. Lean build: `bundle.json 692 resources`, `REFERENCE INTEGRITY: 0 dangling / 0 type-violations`. Crosswalk build: `CROSSWALK SUMMARY: 2256 codings / 270 resources / 32 files / 81 identifiers / 56 id-resources`. |
| **1. `diff -rq out out-golden`** | (after a final plain `bun build.ts` to restore the lean `out/`) | **PASS — byte-identical (empty).** Note: the `--embed-attachments` run leaves `out/` carrying `Binary.json`; a plain rebuild restores the lean tree, which then diffs empty. |
| **1. `diff -rq out-crosswalk out-answerkey-golden`** | — | **PASS — byte-identical (empty).** |
| **2. Reconciliation** | `EXCLUDE_SMARTDATA=1 bun compare/classify.ts --out=out-crosswalk` | **PASS.** `EXACT 12562 / TOLERATED 1703 (mechanical 1702 + blessed 1) / GAP 1855 {real-gap 939, coding-gap 725, unsure 191}`; reconciliation `12562 + 1703 + 1855 = 16120 OK ✓`; **No rules over hit-cap.** Identical to the pre-refactor 12562/1703/1855 — **zero delta** (see G8 explanation). |
| **3. refcheck** | `bun tools/refcheck.ts` | **PASS.** `SUMMARY: 0 dangling / 0 type-violations / 103 naked-display` (naked-display is the standing, accepted count — not a refactor regression). |
| **3. floor-audit** | `bun tools/floor-audit.ts` | **PASS.** `TOTAL: 1855 {FLOOR 1855, MOVABLE 0, UNSURE 0}` — every GAP is on the irreducible coding floor; none movable. |
| **3. triage** | `bun tools/triage.ts` | **PASS.** `GAP 1855 | OPEN 0 (FIX 0 + TOLERATE 0) | ACCEPT 1855` — **OPEN stays 0.** |
| **3. status** | `bun tools/status.ts` | **PASS.** `EXACT 12562 (77.9%) | TOLERATED 1703 | ACCEPT 1855 | faithful 88.5% of 16120`. |
| **4. Portability OID smoke** | `EHI_INSTANCE_OID=9.9.9 bun build.ts; grep -rIl "1.2.840.114350.1.13.283" out` | **PASS — empty.** No hardcoded `.283` literal survives in `out/`; `urn:oid:9.9.9` propagates to Coverage/DiagnosticReport/Account/etc. OID centralization (G5) works. Rebuilt unset afterward; `diff -rq out out-golden` empty (baseline restored). |

All five orchestration steps: **PASS.**

---

## The G8 diff enumeration (the one behavior-unifying step)

**Change.** G8 repointed `allergy.recordedDate` (and encounter / obs-vitals / obs-survey /
obs-social / communication instants) from hand-rolled offset logic onto `lib/time.ts`
`localToUtcInstant` / `localMidnightToUtcInstant`, which consult the configured `EHI_TZ`
(default `America/Chicago`). The allergy generator previously applied a **fixed +5h
(UTC−5), no-DST** offset (`src/allergy.ts:32 LOCAL_UTC_OFFSET_HOURS = 5` in the pre-refactor
code) — the latent summer-DST bug audit fix #4 targets.

**Realized diff for THIS export: NONE (0 byte changes).** All four allergy records carry
**summer** entry timestamps, and in summer Central is CDT = UTC−5 — exactly equal to the old
fixed −5. The fix is real but its effect is null on this patient's data:

| ALLERGY_ID | `ALRGY_ENTERED_DTTM` (local) | OLD (fixed −5) | NEW (`EHI_TZ`, DST-aware) | delta |
|---|---|---|---|---|
| 30689238 | 8/9/2018 9:45:00 AM | `2018-08-09T14:45:00Z` | `2018-08-09T14:45:00Z` | identical |
| 30689295 | 8/9/2018 9:45:00 AM | `2018-08-09T14:45:00Z` | `2018-08-09T14:45:00Z` | identical |
| 30689317 | 8/9/2018 9:46:00 AM | `2018-08-09T14:46:00Z` | `2018-08-09T14:46:00Z` | identical |
| 58599837 | 7/14/2020 2:34:00 PM | `2020-07-14T19:34:00Z` | `2020-07-14T19:34:00Z` | identical |

The divergence would only surface for a **winter** allergy entry (old fixed −5 EST vs new
CST −6 → 1-hour shift); this patient has none, so the diff set is empty. The non-allergy
instants (encounter/obs-vitals/obs-survey/obs-social/communication) were already correct via
the hand-rolled nth-Sunday DST routine and remain byte-identical under the real-tz routine, as
required (any change there would have been a regression).

**Why the ledger is unchanged (zero delta vs pre-refactor 12562/1703/1855).** Two independent
reasons, either sufficient: (a) the realized G8 value diff is empty, so there is nothing to
re-bucket; and (b) even a 1-hour shift would not move buckets — `allergy.recordedDate` is
absorbed by the `minute-rounded-allergyintolerance-recordeddate` tolerance rule (4/4 hits,
`structural-variant`), which TOLERATES the leaf regardless of the exact offset because the EHI
source carries no zone/seconds. The G8 fix changes a leaf's *byte value* (in the winter case)
but never its EXACT/TOLERATED/GAP classification. Hence **the handful of G8 allergy leaves did
not move** — the only enumerated possibility in the task, realized as zero movement.

---

## Portability posture now

**Same-org reuse (new patient on the same Epic instance):**
- `PATIENT_PAT_ID` derives from the export — `process.env.EHI_PAT_ID ?? q1("SELECT PAT_ID FROM
  PATIENT LIMIT 1")?.PAT_ID`, throwing on 0 rows (`lib/ids.ts`). Resolves to `Z7004242` here.
- `COVERAGE_ID` derives from the patient's coverage row — `SELECT COVERAGE_ID FROM
  COVERAGE_MEMBER_LIST WHERE PAT_ID = ? ORDER BY CAST(... AS INTEGER) LIMIT 1`
  (`src/coverageeligibility.ts`). No baked literal.
→ A fresh single-patient export from the same org builds with no code edit (G6).

**Cross-org (different Epic instance / timezone / thinner table set):**
- `EPIC_INSTANCE_OID` is the single org-instance node, `process.env.EHI_INSTANCE_OID ??
  "1.2.840.114350.1.13.283"`, composed everywhere via `epicOid`/`epicOidRaw`/`SYS`/`STD`
  (`lib/ids.ts`). Proven: `EHI_INSTANCE_OID=9.9.9` flips every Epic system and leaves no `.283`
  literal in `out/` (G5).
- `EHI_TZ` is the single configured org timezone, `process.env.EHI_TZ ?? "America/Chicago"`,
  the only input to the wall-clock→UTC conversions (`lib/time.ts`) (G8).
- **Table guards** (`qIf` / `tablesPresent` / `hasColumn` / `colSet`, `lib/db.ts`) wrap the
  optional-table reads so a thinner export degrades to false-absence instead of crashing (G7).
  No-op on the full DB (pure move), active only when a table is absent.

**Net:** after G5–G8 a different-org patient builds; after G6 a same-org new patient builds.
Audit §7 fixes #1–#5 and the #8 share are subsumed (see `CONSOLIDATION-PLAN.md` §5); audit
#6/#7 remain standalone derive/config items, explicitly out of this consolidation's scope.
