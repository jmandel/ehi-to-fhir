export const meta = {
  name: 'ehi-fhir-residual-cleanup',
  description: 'Close the top actionable residual opportunities (iso-ref tolerance, BP LOINC, ServiceRequest/basedOn, preferred-name display, lab code.text) + the note-corpus narrative re-verification, then reconcile',
  phases: [
    { title: 'Foundations', detail: 'lib/ids.ts: preferred-name display + serviceRequest minter (shared dep)' },
    { title: 'Build', detail: 'tolerances broadening (reviewed) · BP LOINC · note-corpus re-verify (parallel)' },
    { title: 'Generators', detail: 'ServiceRequest + basedOn wiring + lab code.text (depends on ids)' },
    { title: 'Reconcile', detail: 'build + gates + classify; update ledger/docs' },
  ],
}

const ROOT = '/home/jmandel/hobby/my-ehi/ehi-fhir'
const RULES = `Project rules: derive from the EHI, never fabricate, codes only if truly present, mint refs via ../lib/ids. After edits run \`bun build.ts\` (the reference-integrity gate must stay 0 dangling / 0 type-violations) and validate touched types with \`bun tools/validate.ts <Type>\`. Edit ONLY the files your task names.`

// ---------- Phase 1: foundations (shared lib/ids.ts) ----------
phase('Foundations')
const foundations = await agent(`${RULES}
Project root (cd here): ${ROOT}.
TASK — two edits to lib/ids.ts ONLY (it's the shared dependency for later steps):
1. PREFERRED-NAME DISPLAY: \`patientDisplay()\` currently derives "Mandel, Joshua C" from PATIENT.PAT_NAME. The target's subject.display is "Mandel, Josh C" — and that is ALSO truthful EHI data: PATIENT_3.PREFERRED_NAME (recovered earlier) holds the preferred first name "Josh". Change patientDisplay() to prefer the EHI PREFERRED name when present (format "Last, PreferredFirst MiddleInitial"), falling back to PAT_NAME. This makes the display both faithful AND exact vs target. Verify the derived value against PATIENT_3.PREFERRED_NAME.
2. SERVICEREQUEST MINTER: add \`id.serviceRequest: (orderProcId) => \`sr-\${slug(orderProcId)}\`\` (ORDER_PROC.ORDER_PROC_ID) so the next phase can emit ServiceRequest + reference it from Observation.basedOn.
Return what you changed + the new derived patient display string.`, { label: 'foundations:ids', phase: 'Foundations' })

// ---------- Phase 2: parallel build (disjoint files) ----------
phase('Build')
const build = await parallel([
  // (a) broaden the reference-isomorphism tolerance — author then adversarial review
  async () => {
    const author = await agent(`${RULES}
Project root (cd here): ${ROOT}.
TASK — broaden the REFERENCE-ISOMORPHISM tolerance in compare/tolerances.ts (+ compare/classify.ts if needed) to cover the reference paths the residual deep-dive found uncovered (~765 leaves now wrongly in GAP): Observation.performer / Observation.specimen / DiagnosticReport.result / Encounter.subject / DocumentReference.subject / DocumentReference.author / DocumentReference.authenticator / DocumentReference.context.encounter (and Observation.basedOn once ServiceRequest exists). These are SAME-ENTITY, different-id-scheme references (our synthetic id vs Epic's opaque id). Add a NARROW, type-indexed mechanical rule: tolerate ONLY when our ref resolves to a resource whose NATURAL KEY equals the target ref's natural key (from its identifier/display) for the SAME element/type; a ref to a DIFFERENT entity must still GAP. Reuse the existing iso-ref machinery/predicate style. Do NOT broaden into a blanket "ignore all reference diffs". Run \`bun compare/classify.ts\` and report the new EXACT/TOLERATED/GAP ledger + per-rule hits. Return the rule(s) added.`, { label: 'tol:author', phase: 'Build' })
    const review = await agent(`${RULES}
Project root (cd here): ${ROOT}.
TASK — ADVERSARIAL REVIEW the new reference-isomorphism tolerance just added to compare/tolerances.ts (author said: ${JSON.stringify(author).slice(0, 800)}). Try to BREAK it: construct a regression where a reference is silently re-pointed to a DIFFERENT real entity (wrong Practitioner, wrong Encounter, wrong Specimen) and show whether the predicate would WRONGLY tolerate it. It must still GAP. If it can be broken, TIGHTEN the predicate (require natural-key equality, not mere type match) and re-run \`bun compare/classify.ts\`. Confirm reconciliation still holds (exact+tolerated+gap=total) and report final numbers + whether any injection test slipped through.`, { label: 'tol:review', phase: 'Build' })
    return { author, review }
  },
  // (b) BP component LOINC via the answer key
  () => agent(`${RULES}
Project root (cd here): ${ROOT}.
TASK — add the BP component LOINC mappings (highest-yield data recovery, ~36 leaves). The target codes BP components with specific LOINCs: systolic 8480-6, diastolic 8462-4 (parent BP gets panel LOINCs already). These ARE standard, not in the export — so deliver them via the ANSWER KEY: add crosswalk rows to crosswalk/ (a per-component file or ALL.csv) keyed so the apply pass can attach 8480-6 to the systolic component coding and 8462-4 to the diastolic, and make tools/apply-answer-key.ts able to target Observation.component.code for BP (it is currently path-gated to top-level code/type/vaccineCode — extend it carefully so it ONLY adds the systolic LOINC to the systolic component and diastolic to the diastolic, never cross-contaminating). Keep additive/idempotent/no-fabrication. Verify: \`bun build.ts --answer-key\` then check out-answerkey/ BP components carry 8480-6 / 8462-4 on the correct halves. Edit ONLY crosswalk/* and tools/apply-answer-key.ts. Report counts.`, { label: 'build:bp-loinc', phase: 'Build' }),
  // (c) note-corpus re-verification (TODO #2) — fixes the narrative blind spot
  () => agent(`${RULES}
Project root (cd here): ${ROOT}.
TASK — close the NOTE-CORPUS blind spot (TODO #2) and correct the narrative findings.
1. Extend tools/find-concept.ts: its value scan currently covers raw/EHITables/*.tsv; add the UNSTRUCTURED note corpus — raw/Rich Text/*.RTF (strip RTF: lib/rtf2txt.ts fails on some files, so add a crude \\{...\\}/\\command stripper fallback) and raw/Media/. Report matching files → map RTF filename's NOTE_ID back to HNO_INFO (note type, CSN). Keep existing behavior as default; add a --notes (or include-in --grep) path.
2. RE-VERIFY the residual deep-dive's narrative + free-text "unrecoverable/ungeneratable" claims against the note corpus. Confirmed example to fix: the Patient Instructions content ("...topiramate for headaches... For blood pressure:...") IS in raw/Rich Text/HNO_3820384431_*.RTF — so it is recoverable-as-narrative, NOT ungeneratable. Find any other narrative/free-text claim the notes actually back.
3. Correct RESIDUAL-DEEPDIVE.md (reclassify the note-backed items ungeneratable→recoverable-as-narrative/approximatable; adjust the truly-unrecoverable count) and note in gaps/careplan.md that the Patient Instructions content survives in the linked notes. Edit ONLY tools/find-concept.ts, RESIDUAL-DEEPDIVE.md, gaps/careplan.md. Report what reclassified.`, { label: 'build:note-reverify', phase: 'Build' }),
])

// ---------- Phase 3: generators that depend on the ids minter ----------
phase('Generators')
const generators = await agent(`${RULES}
Project root (cd here): ${ROOT}. (lib/ids.ts now has id.serviceRequest and preferred-name display — done in phase 1.)
TASK — two generator changes:
1. SERVICEREQUEST + basedOn: create src/servicerequest.ts emitting ServiceRequest resources from the lab/order tables (ORDER_PROC — the orders that the target's Observation.basedOn / DiagnosticReport.basedOn point at), mint id via id.serviceRequest(ORDER_PROC_ID), with status/intent/code(text from PROC master)/subject=Patient/encounter/requester where derivable. Then wire \`basedOn: [ref("ServiceRequest", id.serviceRequest(orderId))]\` into the lab Observations (src/lab.ts) and DiagnosticReport where the order is known, so the links RESOLVE (this also removes the dangling-ref class for basedOn). Never fabricate — only emit a ServiceRequest for orders that exist; only add basedOn where the order id is real.
2. LAB code.text PROPER-CASE: in src/lab.ts, set Observation/DiagnosticReport code.text from crosswalk/lab.csv concept_display (the proper-cased label, e.g. "BUN/Creatinine Ratio") instead of the ALL-CAPS source where the crosswalk has it — only when the crosswalk row matches the component; keep the source text otherwise. This is data already in-repo.
After: \`bun build.ts\` (gate stays 0 dangling / 0 type-violations — ServiceRequest must be emitted so basedOn resolves) and \`bun tools/validate.ts ServiceRequest\` / \`Observation\` / \`DiagnosticReport\`. Edit ONLY src/servicerequest.ts, src/lab.ts (and obs-*.ts ONLY if they emit basedOn). Report counts + validator status.`, { label: 'generators:sr-lab', phase: 'Generators' })

// ---------- Phase 4: reconcile ----------
phase('Reconcile')
const reconcile = await agent(`${RULES}
Project root (cd here): ${ROOT}.
TASK — RECONCILE the whole project after the cleanup.
1. \`bun build.ts\` and \`bun build.ts --answer-key\`; confirm the reference-integrity gate is 0 dangling / 0 type-violations (ServiceRequest now backs basedOn).
2. \`bun compare/classify.ts\` (baseline) and against out-answerkey/ — report the NEW reconciled EXACT / TOLERATED / GAP{real-gap, unsure, coding-gap} ledger and the delta vs before (prev: 14330 = 6293 exact + 534 tolerated + 7503 gap). Confirm reconciliation holds.
3. Re-run \`bun tools/coding-coverage.ts\` (answer-key coverage with the new BP LOINC).
4. Update the docs to reflect the cleanup: SHAPE-GAPS.md, ANSWER-KEY-EVAL.md, REFERENCE-INTEGRITY.md (Binary/basedOn), compare/TOLERANCES.md (new iso-ref rule + the now-exact preferred-name display), and TODO.md (check off the done items).
Return: the new 3-way ledger, the coding-coverage number, the dangling/validator status, and a one-paragraph summary of how much residual moved from GAP → EXACT/TOLERATED.`, { label: 'reconcile', phase: 'Reconcile' })

return { foundations, build, generators, reconcile }
