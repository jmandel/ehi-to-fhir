export const meta = {
  name: 'ehi-fhir-round2a-codings-identifiers-tolerances',
  description: 'Answer-key/tolerance round: capture all reference codings (tagged), add an identifier answer-key, and Class-4 tolerances; reconcile by class',
  phases: [
    { title: 'Codings', detail: '#3 crosswalk captures epic-instance-oid codings (tagged); apply-answer-key layers them' },
    { title: 'Identifiers', detail: '#4 identifier answer-key (entity→{system,value}); apply-answer-key layers identifier[]' },
    { title: 'Tolerances', detail: '#6 Class-4 tolerances (opaque ids, versionId, type-display) — reviewed' },
    { title: 'Reconcile', detail: 'build ±answer-key; classify; coding-coverage BY CLASS; update docs + TODO' },
  ],
}

const ROOT = '/home/jmandel/hobby/my-ehi/ehi-fhir'
const RULES = `Project root (cd here): ${ROOT}. Rules: derive from the EHI/reference, never fabricate beyond what the reference carries for an EHI-anchored concept/entity, mint refs via ../lib/ids. The answer key (crosswalk/) is reconstructed from the reference but every row stays ANCHORED to a real EHI local code/entity and TAGGED as answer-key-sourced. After edits run \`bun build.ts --answer-key\` and \`bun compare/classify.ts\` (reconciliation must hold: exact+tolerated+gap=total). These are SERIALIZED phases (they share crosswalk/, tools/apply-answer-key.ts, compare/) — do not parallel-edit those files.`

// ---- Phase 1: #3 capture ALL reference codings, tagged ----
phase('Codings')
const codings = await agent(`${RULES}

TASK — TODO #3: capture EVERY coding the reference carries for an EHI-anchored concept, not just standard systems.
Today the crosswalk holds standard systems (LOINC/SNOMED/RxNorm/CVX/ICD/CPT) and drops the Epic-instance OID codings — but those sit in the SAME code.coding[] array, anchored to the same EHI local code, so they're answer-key-coverable exactly like LOINC (they were mislabeled "truly-unrecoverable").
1. Extend the crosswalk authoring + crosswalk/ALL.csv (and per-area files) to ALSO capture the Epic-instance-OID codings the reference carries on EHI-anchored concepts — add a column/tag \`system_class\` = "standard" | "epic-instance-oid" so each row is labeled. Cover the big ones: DiagnosticReport.code.coding[] OID fan-out (~1043), Medication.code.coding ATC (http://www.whocc.no/atc, 69), Encounter.type[]/DocumentReference.type[] coding arrays. Only rows ANCHORED to a real EHI local code (the same anchor the standard coding uses).
2. Confirm tools/apply-answer-key.ts layers these onto the code.coding[] arrays (it matches by an existing Epic-local coding already in our output → should add the new OID codings on the same anchor; extend only if needed, additive/idempotent/path-aware).
3. Verify: \`bun build.ts --answer-key\` then check out-answerkey/ DiagnosticReport/Medication/Encounter/DocumentReference now carry the OID/ATC codings; \`bun compare/classify.ts\` against out-answerkey/ shows the coding-gap shrink. Edit ONLY crosswalk/* and tools/apply-answer-key.ts. Report rows added by system_class + the new answer-key coding-gap count.`, { label: 'codings', phase: 'Codings' })

// ---- Phase 2: #4 identifier answer-key ----
phase('Identifiers')
const identifiers = await agent(`${RULES}

TASK — TODO #4: an IDENTIFIER answer-key (parallel structure to the terminology crosswalk).
Epic/registry-assigned identifiers (Practitioner enterprise id 9005828432002 system …737384.60; Patient CEID/APL/FHIR-ids; DocumentReference.custodian.identifier urn:ihs:ce-prd) are in the reference but no EHI table — yet keyed to an EHI-present ENTITY (SER id, PAT_ID, org).
1. Build crosswalk/identifiers.csv: rows of \`entity_type, entity_natural_key (e.g. SER PROV_ID / PAT_ID / org key), target_system, target_value, provenance=answer-key\`, populated from the reference's identifier[] arrays keyed back to the entity's EHI natural key (SER↔Practitioner via name/PROV_ID; PAT_ID↔Patient; org). Include the custodian urn:ihs:ce-prd as a single org/config row. ONLY entities present in the EHI; TAG every row answer-key-sourced.
2. Extend tools/apply-answer-key.ts with an identifier-layering mode: for each resource, resolve its entity natural key (from its minted id) and APPEND the crosswalk identifiers to resource.identifier[] (additive, idempotent, never overwrite an EHI-derived identifier). HONESTY: this is allowed because anchored to a real EHI entity + tagged — NOT a verbatim no-anchor field copy.
3. Verify: \`bun build.ts --answer-key\` then check out-answerkey/ Practitioner/Patient/DocumentReference identifiers; \`bun compare/classify.ts\` shows the identifier residual shrink. Edit ONLY crosswalk/* and tools/apply-answer-key.ts. Report identifiers added.`, { label: 'identifiers', phase: 'Identifiers' })

// ---- Phase 3: #6 Class-4 tolerances ----
phase('Tolerances')
const tolerances = await agent(`${RULES}

TASK — TODO #6: reclassify Class-4 "server artifacts" as TOLERANCES (reviewed, not blind ignores) in compare/tolerances.ts (+ classify.ts if needed).
Add NARROW, verifying rules for:
- opaque FHIR resource ids inside references that aren't already covered → iso-ref where the natural key matches (extend existing iso-ref family only where safe).
- \`meta.versionId\` (target "1") and \`meta.lastUpdated\` → a structural/server-artifact tolerance (these are server-minted; if a faithful source exists per the deep-dive, prefer that, else tolerate as server-only).
- encounter-type \`.display\` ("Office Visit"/"Lab"/"Telephone") → cosmetic-display tolerance (same entity, label is the Epic enc-type master we don't ship) OR leave for an answer-key value if you judge it anchorable.
Each rule must still GAP a same-shaped regression (wrong entity / changed value). Do NOT add the Binary attachment tolerance yet (that depends on TODO #1 emitting Binary resources — note it as pending). Run \`bun compare/classify.ts\`; confirm reconciliation holds and report per-rule hits. ADVERSARIALLY self-check each rule against an injected regression before keeping it. Edit ONLY compare/*.`, { label: 'tolerances', phase: 'Tolerances' })

// ---- Phase 4: reconcile ----
phase('Reconcile')
const reconcile = await agent(`${RULES}

TASK — RECONCILE round 2a.
1. \`bun build.ts\` and \`bun build.ts --answer-key\`; confirm REFERENCE INTEGRITY 0 dangling / 0 type-violations.
2. \`bun compare/classify.ts\` baseline AND against out-answerkey/ — report the new reconciled EXACT/TOLERATED/GAP ledgers and the delta vs round-1 (baseline 14330 = 6567 EXACT + 582 TOLERATED + 7181 GAP{real 3186, unsure 675, coding 3320}).
3. \`bun tools/coding-coverage.ts\` — report coding coverage and ADD a BY-CLASS breakdown (standard vs epic-instance-oid) now that the crosswalk is tagged.
4. Update docs: ANSWER-KEY-EVAL.md (by-class coverage), SHAPE-GAPS.md, compare/TOLERANCES.md note, and TODO.md — CHECK OFF #3/#4/#6 with what moved, append any newly-surfaced items, and update the Progress log.
Return: the new baseline + answer-key ledgers, coding coverage (overall + by class), how many leaves moved GAP→EXACT/TOLERATED this round, and the remaining actionable TODO items.`, { label: 'reconcile-2a', phase: 'Reconcile' })

return { codings, identifiers, tolerances, reconcile }
