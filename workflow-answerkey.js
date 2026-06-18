export const meta = {
  name: 'ehi-fhir-answer-key-layer',
  description: 'Add an opt-in flag that layers the FHIR-answer-key codings (crosswalk) onto generated output, and evaluate coding-gap closure with vs without it',
  phases: [
    { title: 'Build', detail: 'implement tools/apply-answer-key.ts (additive coding layer) + a build flag' },
    { title: 'Verify', detail: 'adversarial: additive-only, idempotent, no fabrication beyond the crosswalk' },
    { title: 'Evaluate', detail: 'compare baseline vs answer-key-enriched vs target; write ANSWER-KEY-EVAL.md' },
  ],
}

const ROOT = '/home/jmandel/hobby/my-ehi/ehi-fhir'

const CONTEXT = `Project root (cd here): ${ROOT}. The "FHIR answer key" is the reconstructed terminology crosswalk in crosswalk/ALL.csv — rows of (ehi_join_table, ehi_join_column, epic_local_system, epic_local_code, ... , target_system, target_code, target_display, fhir_path, ehi_verified, ...). These are the standard codings (LOINC/SNOMED/ICD/RxNorm/CVX...) that the EHI export does NOT carry but we recovered by pairing with the reference FHIR.

GOAL: an OPT-IN layer that, when enabled, attaches those answer-key codings onto our generated FHIR so we can measure output gaps WITH vs WITHOUT it. It must be a non-destructive, layered post-pass — baseline output stays available for comparison.

Generators write out/<Type>.json (and out/<Type>__part.json). build.ts runs them + assembles out/bundle.json. compare.ts scores out/ vs fhir-target/. clean()/emit() in ../lib/gen; ids in ../lib/ids; db in ../lib/db.`

const BUILD_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['toolPath', 'flag', 'codingsAdded', 'resourcesTouched'],
  properties: { toolPath: { type: 'string' }, flag: { type: 'string' }, codingsAdded: { type: 'integer' }, resourcesTouched: { type: 'integer' }, matchStrategy: { type: 'string' }, notes: { type: 'string' } },
}
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['additiveOnly', 'idempotent', 'noFabrication', 'issues'],
  properties: { additiveOnly: { type: 'boolean' }, idempotent: { type: 'boolean' }, noFabrication: { type: 'boolean' }, issues: { type: 'array', items: { type: 'string' } } },
}

phase('Build')
const build = await agent(`${CONTEXT}

TASK — implement the answer-key layer.
1. Write tools/apply-answer-key.ts: read resources from an input dir (default out/) and crosswalk/ALL.csv, and write ENRICHED resources to an output dir (default out-answerkey/), LAYERING the answer-key codings:
   - PRIMARY match: for every CodeableConcept in a resource (code, valueCodeableConcept, vaccineCode, type, etc.), if it contains a coding whose system+code equals a crosswalk row's epic_local_system+epic_local_code, APPEND that row's {system:target_system, code:target_code, display:target_display} to the same coding array (if not already present).
   - FALLBACK match (only where the resource carries no Epic-local coding to key on): match by the resource's natural key (decoded from its minted id, e.g. cond-<DX_ID>, and the row's ehi_join_column) + the row's fhir_path → append to that path's coding array.
   - ADDITIVE ONLY: never remove or modify existing codings/fields; only append codings not already present. Idempotent (running twice changes nothing). Use only ehi_verified rows by default (flag to include all). NEVER add a coding that isn't in crosswalk/ALL.csv — no fabrication.
   - Print a summary: codings added, resources touched, by target_system.
2. Add the OPT-IN flag to the pipeline WITHOUT breaking the existing build or the refcheck gate: \`bun build.ts --answer-key\` should, after producing baseline out/, run the pass to populate out-answerkey/ (a SEPARATE dir, so baseline and enriched both exist for comparison). Plain \`bun build.ts\` stays baseline-only. (Keep any existing refcheck gate intact.)
Verify it runs: \`bun build.ts --answer-key\` then confirm out-answerkey/ exists with codings added. Return the tool path, the flag, and counts. Edit only tools/apply-answer-key.ts and build.ts.`, { label: 'build-answerkey', phase: 'Build', schema: BUILD_SCHEMA })

phase('Verify')
let verify = await agent(`${CONTEXT}

TASK — ADVERSARIAL VERIFY tools/apply-answer-key.ts (built: ${JSON.stringify(build)}).
Run \`bun build.ts --answer-key\`. Then prove:
  - ADDITIVE-ONLY: diff out/ vs out-answerkey/ — the only changes are APPENDED codings; no field/coding removed or altered (pick several resources and confirm).
  - IDEMPOTENT: run the pass again on out-answerkey/ → no further changes.
  - NO FABRICATION: every coding that appears in out-answerkey/ but not out/ traces to a row in crosswalk/ALL.csv (sample and verify; flag any invented coding).
  - CORRECT TARGET: spot-check that an enriched coding landed on the right resource/element (e.g. a Condition's ICD-10 matches that condition's DX_ID per the crosswalk).
Return booleans + any issues. If you find a fixable defect, correct tools/apply-answer-key.ts and re-verify before returning.`, { label: 'verify-answerkey', phase: 'Verify', schema: VERIFY_SCHEMA })

phase('Evaluate')
const evalRes = await agent(`${CONTEXT}

TASK — EVALUATE coding-gap closure WITH vs WITHOUT the answer key, and document it.
1. Ensure both exist: \`bun build.ts --answer-key\` (baseline out/ + enriched out-answerkey/).
2. For each resource type, measure coding coverage against fhir-target/: how many of the target's code.coding entries (by system) are present in (a) baseline out/, (b) enriched out-answerkey/. Compute the delta the answer key closes, per terminology system (LOINC/SNOMED/ICD/RxNorm/CVX) and overall. You may extend/clone compare.ts logic or write a small one-off script (place any helper in tools/).
3. Write ANSWER-KEY-EVAL.md at the project root: a table of system | target codings | baseline-covered | answer-key-covered | delta, the overall % of the coding gap the answer key closes, which systems it fully closes vs leaves residual, and the honest framing (the answer key is reconstructed from the reference FHIR, so this measures recoverability, not an independent source). Note how to toggle it (\`bun build.ts --answer-key\`).
Return the headline numbers: overall coding coverage baseline vs with-answer-key, and the per-system deltas.`, { label: 'evaluate-answerkey', phase: 'Evaluate' })

return { build, verify, evaluation: evalRes }
