export const meta = {
  name: 'ehi-fhir-anticheat-audit',
  description: 'Audit every EHI→FHIR generator for hardcoded/fabricated values that should be derived from the EHI; fix them',
  phases: [
    { title: 'Audit+Fix', detail: 'find hardcoded/copied literals, derive from EHI or gap them' },
    { title: 'Verify', detail: 'independent skeptic confirms no cheats remain' },
    { title: 'Synthesize', detail: 'write AUDIT.md' },
  ],
}

const ROOT = '/home/jmandel/hobby/my-ehi/ehi-fhir'

const DOMAINS = [
  { name: 'patient', file: 'patient.ts', types: ['Patient'] },
  { name: 'practitioner', file: 'practitioner.ts', types: ['Practitioner'] },
  { name: 'location-org', file: 'location-org.ts', types: ['Location', 'Organization'] },
  { name: 'encounter', file: 'encounter.ts', types: ['Encounter'] },
  { name: 'condition', file: 'condition.ts', types: ['Condition'] },
  { name: 'medication', file: 'medication.ts', types: ['MedicationRequest', 'Medication'] },
  { name: 'immunization', file: 'immunization.ts', types: ['Immunization'] },
  { name: 'allergy', file: 'allergy.ts', types: ['AllergyIntolerance'] },
  { name: 'lab', file: 'lab.ts', types: ['DiagnosticReport', 'Specimen', 'Observation'] },
  { name: 'obs-vitals', file: 'obs-vitals.ts', types: ['Observation'] },
  { name: 'obs-social', file: 'obs-social.ts', types: ['Observation'] },
  { name: 'obs-smartdata', file: 'obs-smartdata.ts', types: ['Observation'] },
  { name: 'obs-survey', file: 'obs-survey.ts', types: ['Observation'] },
  { name: 'documentreference', file: 'documentreference.ts', types: ['DocumentReference'] },
  { name: 'careplan', file: 'careplan.ts', types: ['CarePlan', 'CareTeam', 'Goal'] },
  { name: 'coverage', file: 'coverage.ts', types: ['Coverage'] },
]

const TAXONOMY = `WHAT COUNTS AS "CHEATING" (must fix — derive from the EHI via a query, or omit + record a gap):
  - Any DISPLAY NAME of a real entity hardcoded as a string literal — patient/provider/org/location/medication/condition names. e.g. \`PATIENT_DISPLAY = "Mandel, Josh C"\`, \`"Dr. Z Rammelkamp"\`, \`"UnityPoint Health"\`. These MUST come from the EHI (PATIENT.PAT_NAME, CLARITY_SER/CLARITY_EMP, CLARITY_DEP, CLARITY_LOC, the med/dx master files, etc.). For the patient specifically: call patientRef() with NO argument — ../lib/ids now derives the display from PATIENT.PAT_NAME — and DELETE any local PATIENT_DISPLAY constant.
  - Any clinical VALUE, CODE, .display, .text, DATE, quantity, or unit copied from the target / fhir-target rather than read from the DB.
  - Per-record SPECIAL-CASING that forces a specific target match: \`if (csn === "948004323") ...\`, switch statements keyed on specific record ids, arrays of specific ids to include/exclude that were lifted from the answer.
  - Hardcoded COUNTS, or lookup tables whose KEYS are specific record ids and whose VALUES are answers copied from the target.
  - ANY string literal that was clearly copy-pasted out of fhir-target/*.json.

WHAT IS LEGITIMATE (leave alone — NOT cheating):
  - FHIR system URIs and structural constants: "http://loinc.org", "http://snomed.info/sct", "http://terminology.hl7.org/...", category/status CodeSystem URLs.
  - FHIR-defined enum values that encode FHIR semantics: status "final"/"completed", category codes "laboratory"/"vital-signs", etc. — these are the mapping target, not data.
  - TRANSLATION MAPS from EHI _C_NAME text → FHIR enums (e.g. {"Completed":"completed","Sent":"active"}). This is mapping LOGIC, the whole point of the translator — keep it.
  - Epic-instance OID identifier SYSTEMS (urn:oid:1.2.840.114350.1.13.283...). These name a coding system, are not in the EHI, and are infrastructure constants — acceptable. (But a hardcoded identifier VALUE that should be queried is a cheat.)
  - The single patient anchor key PATIENT_PAT_ID="Z7004242" in lib/ids.ts (the one rooting constant the whole graph hangs on).
  - Pure formatting/structure constants.

RULE OF THUMB: a constant that encodes how FHIR works (systems, enums, mapping rules) is fine; a constant that encodes WHAT THIS PATIENT'S DATA IS (names, values, codes, dates, which records) is a cheat — it must be read from the EHI at runtime.`

function preamble(d) {
  return `Project root (cd here, run everything from here): ${ROOT}
You are auditing ONE deterministic EHI→FHIR generator: src/${d.file} (produces ${d.types.join(', ')}).

Libs it uses: ../lib/db (q/q1/dateRealToISO/...), ../lib/ids (id.*, ref, patientRef — patientRef() now DERIVES the patient display from PATIENT.PAT_NAME; pass no arg), ../lib/gen (emit, clean).
Explore the EHI: bun lib/q.ts "SELECT ...". Score output vs target: bun compare.ts <Type>.

${TAXONOMY}

BOUNDARIES: modify ONLY src/${d.file} and gaps/${d.name}.md. Do NOT edit lib/*, compare.ts, build.ts, fhir-target/*, or other domains' files. Do NOT run \`bun build.ts\` — run only \`bun src/${d.file}\`.`
}

function auditPrompt(d) {
  return `${preamble(d)}

TASK — AUDIT & FIX src/${d.file} for cheating.
1. Read src/${d.file} carefully. List EVERY string/number/array literal and judge each against the taxonomy: is it FHIR-structure (keep) or this-patient's-data (cheat)?
2. For each cheat: replace it with a value DERIVED from the EHI via a query (find the real source column — e.g. a provider display from CLARITY_SER.PROV_NAME joined on the id you already have). If the value is genuinely not derivable from the export, REMOVE the hardcoded literal (omit the field) and record it in gaps/${d.name}.md with a [data] or [coding] tag — do NOT keep a fabricated/copied value.
3. Specifically: delete any \`PATIENT_DISPLAY\` constant and change \`patientRef(PATIENT_DISPLAY)\` → \`patientRef()\`.
4. After fixing, run \`bun src/${d.file}\` then \`bun compare.ts <Type>\` for each type. Counts MUST stay the same. Field values may shift to the truthful EHI form (e.g. a name's casing/nickname) — that is EXPECTED and correct even if it now differs cosmetically from the target; do not re-introduce a copied literal to match the target.
Return your findings.`
}

function verifyPrompt(d) {
  return `${preamble(d)}

TASK — ADVERSARIAL VERIFY src/${d.file}: prove there is STILL cheating, or confirm it is clean.
Re-read src/${d.file} line by line. For every literal that represents this patient's data (a name, code, value, date, or a record-id-keyed decision), demonstrate with a query whether it is now read from the EHI or still hardcoded/copied. Run \`bun src/${d.file} && bun compare.ts <Type>\` to confirm it still works and counts are intact. Flag any remaining cheat per the taxonomy with the exact line and a concrete fix. If genuinely clean, say so explicitly. Be skeptical; do not rubber-stamp.`
}

const AUDIT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['domain', 'cheatsFound', 'cheatsFixed', 'remaining'],
  properties: {
    domain: { type: 'string' },
    cheatsFound: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['line', 'literal', 'verdict', 'action'], properties: {
      line: { type: 'string' }, literal: { type: 'string' }, verdict: { type: 'string', enum: ['cheat-derived', 'cheat-removed-gap', 'legit-kept'] }, action: { type: 'string' } } } },
    cheatsFixed: { type: 'integer' },
    remaining: { type: 'array', items: { type: 'string' } },
    countsStable: { type: 'boolean' },
    notes: { type: 'string' },
  },
}

const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['domain', 'clean', 'remainingCheats'],
  properties: {
    domain: { type: 'string' },
    clean: { type: 'boolean' },
    remainingCheats: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['line', 'issue', 'fix'], properties: { line: { type: 'string' }, issue: { type: 'string' }, fix: { type: 'string' } } } },
  },
}

const results = await pipeline(
  DOMAINS,
  (d) => agent(auditPrompt(d), { label: `audit:${d.name}`, phase: 'Audit+Fix', schema: AUDIT_SCHEMA }),
  async (audit, d) => {
    let verify = await agent(verifyPrompt(d), { label: `verify:${d.name}`, phase: 'Verify', schema: VERIFY_SCHEMA })
    // one corrective round if the skeptic still finds cheats
    if (verify && !verify.clean && (verify.remainingCheats || []).length) {
      log(`${d.name}: verify found ${verify.remainingCheats.length} residual cheats → corrective fix`)
      await agent(`${preamble(d)}\n\nTASK — fix these residual cheats found by review, then re-run \`bun src/${d.file} && bun compare.ts ${d.types[0]}\`:\n${JSON.stringify(verify.remainingCheats, null, 2)}`, { label: `refix:${d.name}`, phase: 'Verify' })
      verify = await agent(verifyPrompt(d), { label: `reverify:${d.name}`, phase: 'Verify', schema: VERIFY_SCHEMA })
    }
    return { domain: d.name, audit, verify }
  },
)

const clean = results.filter(Boolean)
phase('Synthesize')
const synth = await agent(`Finalize the anti-cheat audit at ${ROOT} (cd there).
Per-domain audit+verify results:
${JSON.stringify(clean.map((r) => ({ domain: r.domain, cheatsFixed: r.audit && r.audit.cheatsFixed, verifyClean: r.verify && r.verify.clean, remaining: (r.verify && r.verify.remainingCheats || []).map((c) => c.line + ': ' + c.issue) })), null, 2)}
1. Run \`bun build.ts\` and \`bun compare.ts\` to confirm the whole project still builds and counts are intact after the audit (report any regression).
2. Write AUDIT.md at the project root: a table of domain | cheats fixed | now-clean?, then a section listing the most common cheat patterns found (e.g. hardcoded patient display) and how they were resolved (derived-from / removed+gap), and finally any domains still NOT clean with the exact residual issue.
Return a concise summary: total cheats fixed, how many domains are fully clean, and any remaining cheats.`, { label: 'synthesize', phase: 'Synthesize' })

return { domains: clean.map((r) => ({ domain: r.domain, fixed: r.audit && r.audit.cheatsFixed, clean: r.verify && r.verify.clean })), synthesis: synth }
