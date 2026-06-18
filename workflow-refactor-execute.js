export const meta = {
  name: 'ehi-fhir-refactor-execute',
  description: 'Execute CONSOLIDATION-PLAN.md steps G0–G9 SEQUENTIALLY, each self-verified byte-identical against the golden snapshots (out-golden / out-answerkey-golden). Pure-move steps must diff EMPTY; G8 timezone is the one bounded-diff step. Final reconcile confirms the harness.',
  phases: [
    { title: 'G0 rename' }, { title: 'G1 fmt' }, { title: 'G2 cc' }, { title: 'G3 time-moves' },
    { title: 'G4 providers' }, { title: 'G5 oid' }, { title: 'G6 anchor' }, { title: 'G7 guards' },
    { title: 'G8 timezone' }, { title: 'G9 emp-ser' }, { title: 'Reconcile' },
  ],
}
const ROOT = '/home/jmandel/hobby/my-ehi/ehi-fhir'

// the regression oracle: pure-move steps MUST reproduce both goldens byte-for-byte.
const VERIFY_PURE = `VERIFY (this is a PURE MOVE — output MUST be byte-identical):
  cd ${ROOT}
  bun build.ts >/dev/null 2>&1 && diff -rq out out-golden && echo "PLAIN OK"
  bun build.ts --apply-crosswalk --embed-attachments >/dev/null 2>&1 && diff -rq out-crosswalk out-answerkey-golden && echo "ORACLE OK"
  bun tools/refcheck.ts 2>&1 | tail -1   (expect 0 dangling / 0 type-violations)
Both diffs MUST be empty. If ANY file differs, your refactor changed behavior — FIX IT until both diffs are empty (a pure move that changes a byte is a defect). Report the exact diff if you cannot get it clean. Do NOT touch out-golden/ or out-answerkey-golden/ (the frozen references) or the historical workflow-*.js scripts.`

const RULES = `Project root (cd here): ${ROOT}. Execute EXACTLY one step of CONSOLIDATION-PLAN.md. First READ CONSOLIDATION-PLAN.md (your step in §4, the module API in §1, and every DO-NOT-MERGE constraint in §3 that touches your files — honor them precisely; they encode correctness, e.g. lab.ts's per-order UTC path is the seed not a deletion target, child-node OIDs stay distinct, per-domain _C_NAME maps stay co-located). Edit ONLY the files your step names. Then run the verification below and report PASS/FAIL with the diff summary.`

// ---- Phase A: pure-move DRY ----
phase('G0 rename')
const g0 = await agent(`${RULES}

STEP [G0] — rename the terminology-crosswalk layer answer-key → apply-crosswalk (HARD rename, no alias):
- build.ts flag \`--answer-key\` → \`--apply-crosswalk\`; the env/dir \`out-answerkey\` → \`out-crosswalk\` everywhere in LIVE code (build.ts, compare/classify.ts, tools/apply-answer-key.ts→RENAME FILE to tools/apply-crosswalk.ts with applyAnswerKey→applyCrosswalk, tools/{build-report-data,build-viewer,coding-coverage,floor-audit,refcheck,status,triage}.ts, report/* if referenced). \`ANSWERKEY SUMMARY\` log → \`CROSSWALK SUMMARY\`. Rename doc ANSWER-KEY-EVAL.md → CROSSWALK-EVAL.md. sense-#2 prose ("answer key" meaning the fhir-target reference) → "reference target" in comments/docs you touch.
- LEAVE the historical workflow-round*.js / workflow-answerkey.js (not re-run) AND the golden dirs.
VERIFY (special — the dir RENAMES, so compare the new dir to the old golden):
  cd ${ROOT}
  bun build.ts >/dev/null 2>&1 && diff -rq out out-golden && echo "PLAIN OK"
  bun build.ts --apply-crosswalk --embed-attachments >/dev/null 2>&1 && diff -rq out-crosswalk out-answerkey-golden && echo "ORACLE OK (renamed dir == old golden)"
  grep -rIl "answer-key\\|answerkey\\|ANSWERKEY\\|apply-answer-key" build.ts compare/ tools/ report/ | grep -v workflow- || echo "NO STALE TOKENS"
  bun tools/refcheck.ts 2>&1 | tail -1
Both diffs MUST be empty; no stale answer-key tokens in live code. Report PASS/FAIL.`, { label: 'G0', phase: 'G0 rename' })

phase('G1 fmt')
const g1 = await agent(`${RULES}\n\nSTEP [G1] — create lib/fmt.ts (nn, money[opts.round], enumMap, coalesceName, titleCaseName) from the canonical seeds; replace the ~10 nn copies + patient ANY, the 6 money copies (wire opts.round so eob/claim use the round path — DNM #21), enum-lookup idioms, coalesce idioms, the tc closure. Per-domain _C_NAME map TABLES stay co-located (DNM #23). clean() stays in gen.ts.\n\n${VERIFY_PURE}`, { label: 'G1', phase: 'G1 fmt' })

phase('G2 cc')
const g2 = await agent(`${RULES}\n\nSTEP [G2] — create lib/cc.ts (cc, concept, category[variadic — DNM #26], ident); replace the ~70 inline CC/ident sites. coverageeligibility/lab keep their decision logic and CALL cc() (DNM #24/#25). Do NOT route patient telecom through ident (DNM #27).\n\n${VERIFY_PURE}`, { label: 'G2', phase: 'G2 cc' })

phase('G3 time-moves')
const g3 = await agent(`${RULES}\n\nSTEP [G3] — date-only + UTC-column MOVES only (NO tz/instant conversion change yet): add lib/db.ts naiveLocal; create lib/time.ts with isoDate + utcFromUtcColumn (seeds: servicerequest.ts isoDate, lab.ts utc()); obs-social imports dateRealToISO from db. Replace the 9 isoDate/dateOnly copies + ~6 inline date-only idioms + the 2 UTC-column readers (lab/medication route through utcFromUtcColumn — DNM #2, already-UTC, no offset). Do NOT change any Central/DST routine in this step.\n\n${VERIFY_PURE}`, { label: 'G3', phase: 'G3 time-moves' })

phase('G4 providers')
const g4 = await agent(`${RULES}\n\nSTEP [G4] — create lib/providers.ts (SENTINEL_SER_IDS, CARE_PROV_COLUMNS, referencedProviderIds, emittedPractitionerIds, provName, practitionerRef, orgRef, isNonHumanResource); communication consumes emittedPractitionerIds instead of re-deriving. Keep lab's 'LLB-' org-key prefix at the call site (DNM #20); keep encounter ' LAB ' semantics via isNonHumanResource (DNM #16); keep carePartyRef's emitted-set gate (DNM #15). EMP→SER bridge is NOT this step (that's G9).\n\n${VERIFY_PURE}`, { label: 'G4', phase: 'G4 providers' })

// ---- Phase B: OID centralization ----
phase('G5 oid')
const g5 = await agent(`${RULES}\n\nSTEP [G5] — extend lib/ids.ts: EPIC_INSTANCE_OID (env EHI_INSTANCE_OID ?? "1.2.840.114350.1.13.283"), epicOid(suffix), epicOidRaw(suffix), the SYS Epic-instance registry, and STD standard URIs. Rewrite the ~49 .283 literals across 18 files to compose from epicOid/SYS. Honor child-node + bare-OID distinctions (DNM #8 ETR .726582.1, #9 FORM .698288.310, #10 NOTE_OID_TAIL via epicOidRaw, #11 remit, #12 SDI vs FLO); fix the patient.ts:51 "org-independent" comment (DNM #13). STD URIs must NOT compose from EPIC_INSTANCE_OID. Per-file SYS_*/OID_* names may stay as local aliases = SYS.X.\nEXTRA VERIFY after the pure-move check: \`EHI_INSTANCE_OID=9.9.9 bun build.ts --apply-crosswalk >/dev/null 2>&1; grep -rIl "1.2.840.114350.1.13.283" out-crosswalk | head\` should be EMPTY (every Epic system flipped); then rebuild with the var unset and re-confirm the golden diff is empty.\n\n${VERIFY_PURE}`, { label: 'G5', phase: 'G5 oid' })

// ---- Phase C: patient anchor ----
phase('G6 anchor')
const g6 = await agent(`${RULES}\n\nSTEP [G6] — derive the patient anchors (the only same-org-reuse blocker): lib/ids.ts PATIENT_PAT_ID = process.env.EHI_PAT_ID ?? q1("SELECT PAT_ID FROM PATIENT LIMIT 1")?.PAT_ID (error clearly if 0 rows); defensively replace the patient.ts:129 non-null \`!\`. Derive COVERAGE_ID in coverageeligibility.ts (from the patient's COVERAGE/BENEFITS row) instead of the "5934765" literal. For THIS export the derived values MUST equal Z7004242 / 5934765, so output stays byte-identical.\n\n${VERIFY_PURE}`, { label: 'G6', phase: 'G6 anchor' })

// ---- Phase D: table guards ----
phase('G7 guards')
const g7 = await agent(`${RULES}\n\nSTEP [G7] — lib/db.ts: add qIf, tablesPresent, hasColumn, colSet. Refactor obs-smartdata.ts + location-org.ts onto them (DNM #29 — keep obs-smartdata's defensive intent). Add guards around each top-level optional-table SELECT in medication.ts, lab.ts, servicerequest.ts, obs-vitals.ts, obs-survey.ts, encounter.ts, condition.ts. On the FULL db the guards are no-ops, so output stays byte-identical.\n\n${VERIFY_PURE}`, { label: 'G7', phase: 'G7 guards' })

// ---- Phase E: timezone (INTENDED DIFF) ----
phase('G8 timezone')
const g8 = await agent(`${RULES}\n\nSTEP [G8] — lib/time.ts: add EHI_TZ + localToUtcInstant({utcSibling?, tz?}) + localMidnightToUtcInstant. Repoint encounter, communication, obs-vitals, obs-survey onto localToUtcInstant; obs-social onto localMidnightToUtcInstant; allergy onto localToUtcInstant. Lab keeps its per-order sibling path via localToUtcInstant(local,{utcSibling}) (DNM #1 — do NOT flatten). Medication stays on utcFromUtcColumn (DNM #2). communication date-only falls back to isoDate (DNM #5).\n\nTHIS STEP IS NOT BYTE-IDENTICAL — the diff is the deliverable. VERIFY (bounded surprise):\n  cd ${ROOT}\n  bun build.ts --apply-crosswalk --embed-attachments >/dev/null 2>&1\n  diff -r out-crosswalk out-answerkey-golden\nThe ONLY allowed diffs are AllergyIntolerance.recordedDate values (the fixed Eastern→correct-tz bug-fix), and ONLY on summer/DST rows. Every other resource/instant (encounter/obs/communication) MUST be byte-identical — if the real-tz routine matches the old nth-Sunday Central logic for America/Chicago (it should), those stay identical; ANY non-allergy diff is a REGRESSION to fix, not an accepted change. ENUMERATE every differing leaf, confirm each is an allergy recordedDate now equal to the correct America/Chicago instant, and report the full list. \`bun tools/refcheck.ts\` 0 dangling.`, { label: 'G8', phase: 'G8 timezone' })

// ---- Phase F: provider semantic unify + latent fix ----
phase('G9 emp-ser')
const g9 = await agent(`${RULES}\n\nSTEP [G9] — lib/providers.ts: add empLoginToSerId, empToSerMap, nameToSerId; replace the 5 inline EMP→SER reimplementations (careplan, immunization, medication, obs-vitals, obs-survey) — each CALLER keeps its own drop-vs-display policy (DNM #14/#15/#19). Switch obs-smartdata.ts:135-138 to empLoginToSerId (DNM #18 — a latent-bug fix; the table is dormant so output is unchanged today). For the 5 active call sites output MUST stay byte-identical (same matches, same policy).\n\n${VERIFY_PURE}\n(obs-smartdata is dormant in this export, so the diffs must still be empty.)`, { label: 'G9', phase: 'G9 emp-ser' })

phase('Reconcile')
const reconcile = await agent(`Project root (cd here): ${ROOT}. Final reconcile after the G0–G9 refactor.
1. \`bun build.ts\`; \`bun build.ts --apply-crosswalk --embed-attachments\` — confirm both run; \`diff -rq out out-golden\` and \`diff -rq out-crosswalk out-answerkey-golden\` — report (expect: ONLY AllergyIntolerance.recordedDate summer-DST diffs from G8; everything else empty).
2. \`EXCLUDE_SMARTDATA=1 bun compare/classify.ts --out=out-crosswalk\` — reconciliation must hold, no rule over cap; report EXACT/TOLERATED/GAP vs the pre-refactor 12562/1703/1855 (the only change should be the handful of G8 allergy recordedDate leaves moving, if any — explain any delta).
3. \`bun tools/refcheck.ts\` (0 dangling/0 type-violations); \`bun tools/floor-audit.ts\` + \`bun tools/triage.ts\` (OPEN should stay 0); \`bun tools/status.ts\`.
4. Portability smoke: \`EHI_INSTANCE_OID=9.9.9 bun build.ts >/dev/null 2>&1; grep -rIl "1.2.840.114350.1.13.283" out | head\` → empty (OID centralization works); then rebuild unset.
5. Update CONSOLIDATION-PLAN.md (mark steps done) + write a short REFACTOR-RESULT.md: per-step PASS/byte-identical status, the enumerated G8 diff, and the portability posture now (same-org reuse: PATIENT_PAT_ID/COVERAGE_ID derived; cross-org: EPIC_INSTANCE_OID + EHI_TZ + table guards in place). Edit docs only.
Return the per-step verification summary + the final ledger + the G8 diff enumeration.`, { label: 'reconcile', phase: 'Reconcile' })

return { g0, g1, g2, g3, g4, g5, g6, g7, g8, g9, reconcile }
