export const meta = {
  name: 'ehi-to-fhir',
  description: 'Draft + adversarially refine per-domain EHI→FHIR translators to match the target FHIR',
  phases: [
    { title: 'Draft', detail: 'one agent per domain writes & runs its generator' },
    { title: 'Review', detail: 'adversarial reviewer hunts defects per domain' },
    { title: 'Fix', detail: 'apply findings; loop review→fix until dry (max 3 rounds)' },
    { title: 'Synthesize', detail: 'assemble bundle, score, write GAPS.md' },
  ],
}

const ROOT = '/home/jmandel/hobby/my-ehi/ehi-fhir'
const GUIDES = '../skills/reading-epic-ehi-export/reference/clinical-areas'
const PATTERNS = '../skills/reading-epic-ehi-export/reference/patterns/general-patterns.md'

const DOMAINS = [
  { name: 'patient', file: 'patient.ts', types: ['Patient'], guides: ['demographics.md', 'communication-preferences.md'] },
  { name: 'practitioner', file: 'practitioner.ts', types: ['Practitioner'], guides: ['providers-and-care-teams.md'] },
  { name: 'location-org', file: 'location-org.ts', types: ['Location', 'Organization'], guides: ['providers-and-care-teams.md', 'coverage-and-billing.md'] },
  { name: 'encounter', file: 'encounter.ts', types: ['Encounter'], guides: ['encounters-and-visits.md', 'appointments-and-scheduling.md'] },
  { name: 'condition', file: 'condition.ts', types: ['Condition'], guides: ['problems-and-diagnoses.md'] },
  { name: 'medication', file: 'medication.ts', types: ['MedicationRequest', 'Medication'], guides: ['medications-and-orders.md', 'order-lifecycle-details.md'] },
  { name: 'immunization', file: 'immunization.ts', types: ['Immunization'], guides: ['immunizations.md'] },
  { name: 'allergy', file: 'allergy.ts', types: ['AllergyIntolerance'], guides: ['allergies.md'] },
  { name: 'lab', file: 'lab.ts', types: ['DiagnosticReport', 'Specimen', 'Observation'], guides: ['lab-results.md', 'imaging-and-media.md'], obsPart: 'labs', obsCategory: 'laboratory', note: 'Owns lab Observations (category=laboratory) PLUS DiagnosticReport+Specimen. DiagnosticReport.result MUST reference the lab Observation ids you mint. Emit lab obs with emit("Observation", arr, "labs").' },
  { name: 'obs-vitals', file: 'obs-vitals.ts', types: ['Observation'], guides: ['vitals-and-flowsheets.md'], obsPart: 'vitals', obsCategory: 'vital-signs', note: 'Only the vital-signs Observations (BP packed, HR, temp, etc.). emit("Observation", arr, "vitals").' },
  { name: 'obs-social', file: 'obs-social.ts', types: ['Observation'], guides: ['histories-family-social-medical.md', 'social-determinants-and-smartdata.md'], obsPart: 'social', obsCategory: 'social-history', note: 'Only the social-history Observations (e.g. smoking/tobacco status). emit("Observation", arr, "social").' },
  { name: 'obs-smartdata', file: 'obs-smartdata.ts', types: ['Observation'], guides: ['social-determinants-and-smartdata.md'], obsPart: 'smartdata', obsCategory: 'smartdata', note: 'Only category=smartdata Observations (SmartData/SDD store; value in V_EHI_SDD_ENTRY_INTERPRETATION). emit("Observation", arr, "smartdata").' },
  { name: 'obs-survey', file: 'obs-survey.ts', types: ['Observation'], guides: ['questionnaires-and-assessments.md', 'vitals-and-flowsheets.md'], obsPart: 'survey', obsCategory: 'survey', note: 'Only category=survey Observations (questionnaires/assessments, PHQ, etc.). emit("Observation", arr, "survey").' },
  { name: 'documentreference', file: 'documentreference.ts', types: ['DocumentReference'], guides: ['clinical-notes-and-documents.md', 'imaging-and-media.md'] },
  { name: 'careplan', file: 'careplan.ts', types: ['CarePlan', 'CareTeam', 'Goal'], guides: ['episodes-care-plans-and-goals.md', 'providers-and-care-teams.md'] },
  { name: 'coverage', file: 'coverage.ts', types: ['Coverage'], guides: ['coverage-and-billing.md', 'benefits-and-eligibility.md'] },
]

// ---- shared context every agent gets ----
function preamble(d) {
  const guidePaths = d.guides.map((g) => `  - ${GUIDES}/${g}`).join('\n')
  const obs = d.obsCategory
    ? `\nOBSERVATION SHARD: You own ONLY Observations with category "${d.obsCategory}". Emit with the part suffix: emit("Observation", arr, "${d.obsPart}") -> writes out/Observation__${d.obsPart}.json. NOTE: \`bun compare.ts Observation\` merges ALL Observation parts from every shard, so focus on your category subset within it. Filter fhir-target/Observation.json to category="${d.obsCategory}" to see YOUR targets.\n`
    : ''
  return `You write a DETERMINISTIC Bun/TypeScript translator from an Epic EHI export (SQLite) to FHIR.
Project root (cd here, run everything from here): ${ROOT}

REQUIRED READING before writing code:
  - ${PATTERNS}   (the EHI genre's grammar: CSN, *_DATE_REAL, _C_NAME, base+supplement, everything-is-TEXT, sentinels, _NAME companions, soft-deletes)
${guidePaths}
  - fhir-target/${d.types[0]}.json  (and the others you own) — the EXACT target shapes you must reproduce.

LIBS (import relative from src/, i.e. "../lib/..."):
  - ../lib/db   : q(sql,...params)->rows, q1, db, dateRealToISO(v), parseEpicDateTime(v), columnsOf(t), tableHasRows(t).
                  EVERYTHING in the DB is TEXT — CAST(x AS INTEGER/REAL) before ORDER BY / MIN / MAX / ranges, or it sorts lexically and lies.
  - ../lib/ids  : id.<entity>(key), ref(Type,id,display?), patientRef(), PATIENT_ID, PATIENT_PAT_ID. MINT IDS ONLY VIA THESE so your references line up with the other domains' resources.
  - ../lib/gen  : emit("<Type>", resources[], part?) writes out/. clean(obj) recursively strips undefined/null/""/empty.

EXPLORE with:  bun lib/q.ts "SELECT ..."   (add --table for aligned). Catalog: _tables, _schema_table, _schema_column (grep column meanings in SQL).
SCORE with:    bun compare.ts ${d.types.filter((t,i)=>d.types.indexOf(t)===i).join(' / bun compare.ts ')}   (counts, <<MISSING paths present in target but not your output, >>EXTRA paths you invented, and coding systems per path).
${obs}
MAPPING PRINCIPLES (STRICT):
  1. Match the target's SHAPE. Drive iteration off \`bun compare.ts <Type>\`: close every "<< MISSING" path the EHI can actually fill; remove ">> EXTRA" paths not in the target; align value types and coding systems.
  2. Reproduce the target COUNT where the source supports it (same number of Conditions, Encounters, etc.). If you can't reach it, explain why in gaps.
  3. CODINGS ARE BEST-EFFORT. Emit a Coding's \`code\`/\`system\` ONLY when that code truly lives in the EHI (e.g. ICD-10 via DX_ID->CLARITY_EDG/EDG_CURRENT_ICD10, CVX, NDC/RxNorm where present, LOINC only from LNC_DB_MAIN). When the target's code is Epic-terminology-assigned and NOT in the export, emit \`text\`/\`display\` only and RECORD THE GAP. NEVER fabricate a code, display, or value.
  4. NEVER fabricate data. A blank beats an invention; prefer false-absence to false-presence. BUT a blank EHI column is usually one join short — confirm a value is truly unreachable (check the code column + master file / V_EHI_* view the guide names) before declaring it absent.
  5. IDs need not equal Epic's opaque FHIR ids; mint via ../lib/ids. Cross-resource references MUST be internally consistent (use the shared id.* minters).
  6. Use clean() on every resource so empty fields don't ship.

BOUNDARIES: modify ONLY src/${d.file}, your out/ files (via emit), and gaps/${d.name}.md. DO NOT touch lib/*, compare.ts, build.ts, profile.ts, fhir-target/*, or any other domain's src file. Do NOT run \`bun build.ts\` (it runs every domain and races on out/) — run only \`bun src/${d.file}\`.`
}

function draftPrompt(d) {
  return `${preamble(d)}

TASK — DRAFT the generator for domain "${d.name}" producing FHIR: ${d.types.join(', ')}.
${d.note ? 'DOMAIN NOTE: ' + d.note + '\n' : ''}
Steps:
1． Read the pattern guide + your clinical-area guide(s) above. Read your fhir-target/*.json files end to end; catalog every field, value[x] type, coding system, reference target, and cardinality you must reproduce.
2． Explore the EHI to find the rows backing those target resources. Map each target field to a concrete EHI column (or to "unreachable" -> a gap).
3． Write src/${d.file}: query the EHI via ../lib/db, build the resources, clean() them, and emit() each type. Aim to match the target counts.
4． Run \`bun src/${d.file}\` then \`bun compare.ts <Type>\` for each type you own. Iterate until counts match and there are no MISSING paths the EHI can fill and no fabricated EXTRA paths.
5． Write gaps/${d.name}.md: a precise, honest bullet list of every target field/coding you could NOT reconstruct, each with the reason (not-in-export / Epic-assigned-terminology / ambiguous-join / different-granularity). Distinguish "coding gap" (lost LOINC/SNOMED/etc. but text preserved) from "data gap" (the datum itself is absent).

Return the structured report. Be truthful about generatedCount vs targetCount and residual MISSING paths.`
}

function reviewPrompt(d, round) {
  return `${preamble(d)}

TASK — ADVERSARIAL REVIEW (round ${round}) of src/${d.file} for domain "${d.name}" (FHIR: ${d.types.join(', ')}).
${d.note ? 'DOMAIN NOTE: ' + d.note + '\n' : ''}
You are a skeptic. Assume the generator is wrong until proven right. Run it and inspect REAL data:
  bun src/${d.file}        # regenerate
  bun compare.ts <Type>    # for each owned type
  bun lib/q.ts "SELECT ..."  # verify claims against the EHI
  cat out/<Type>.json | head ; cat fhir-target/<Type>.json   # eyeball actual vs target

Hunt specifically for:
  - COUNT mismatch vs target (missing resources, extras, duplicates, wrong filtering/soft-deletes included).
  - MISSING fields: paths in the target absent from output where the EHI DEMONSTRABLY has the data — PROVE it with a query that returns the value. (If the EHI lacks it, that's a legitimate gap, not a finding.)
  - FABRICATION (worst defect): any Coding code/display, value, date, or reference NOT traceable to an EHI column. Flag every invented code or guessed value.
  - WRONG references: dangling (target id never minted), wrong resource type, wrong id convention vs ../lib/ids.
  - WRONG values: value[x] type (Quantity vs String vs CodeableConcept), units, *_DATE_REAL conversion errors, lexical-sort bugs, status/category miscoding, packed-BP/component handling.
  - DISHONEST gaps doc: gaps/${d.name}.md claims something is unreachable that you just reached, or omits a real gap.

Return findings[]. Each finding MUST carry concrete evidence (a query + its result, or a target/output excerpt) and a concrete fix instruction. Severity blocker (fabrication/dangling/wrong-data) > major (missing recoverable field, count off) > minor (cosmetic). If after genuine effort nothing is actionable, return empty findings — do not invent nitpicks.`
}

function fixPrompt(d, findings) {
  return `${preamble(d)}

TASK — APPLY FIXES to src/${d.file} for domain "${d.name}".
A reviewer found these actionable defects (JSON):
${JSON.stringify(findings, null, 2)}

For each: apply the fix in src/${d.file} (honoring the mapping principles — no fabrication, codes only if in the EHI, update gaps/${d.name}.md for anything genuinely unreachable). Then run \`bun src/${d.file}\` and \`bun compare.ts <Type>\` to confirm. If a finding is wrong/infeasible, skip it and say precisely why. Return what you applied vs skipped and the new compare summary.`
}

const DRAFT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['domain', 'file', 'typeCounts', 'residualMissingPaths', 'gaps', 'selfQuality'],
  properties: {
    domain: { type: 'string' },
    file: { type: 'string' },
    typeCounts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['type', 'targetCount', 'generatedCount'], properties: { type: { type: 'string' }, targetCount: { type: 'integer' }, generatedCount: { type: 'integer' } } } },
    residualMissingPaths: { type: 'array', items: { type: 'string' }, description: 'target paths still not produced after drafting' },
    gaps: { type: 'array', items: { type: 'string' }, description: 'one line per gap, prefixed [coding] or [data]' },
    selfQuality: { type: 'integer', description: '0-100 self-assessed closeness to target' },
    notes: { type: 'string' },
  },
}

const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['domain', 'findings'],
  properties: {
    domain: { type: 'string' },
    findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['severity', 'kind', 'summary', 'evidence', 'fix'], properties: {
      severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
      kind: { type: 'string', enum: ['count', 'missing-field', 'fabrication', 'wrong-ref', 'wrong-value', 'gaps-doc', 'other'] },
      summary: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' },
    } } },
  },
}

const FIX_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['domain', 'applied', 'skipped'],
  properties: {
    domain: { type: 'string' },
    applied: { type: 'array', items: { type: 'string' } },
    skipped: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['finding', 'reason'], properties: { finding: { type: 'string' }, reason: { type: 'string' } } } },
    compareSummary: { type: 'string' },
  },
}

// ---- review→fix loop (cleanup until dry) ----
async function reviewFixLoop(d, draft) {
  const history = []
  let residual = []
  for (let r = 1; r <= 3; r++) {
    const review = await agent(reviewPrompt(d, r), { label: `review:${d.name}#${r}`, phase: 'Review', schema: REVIEW_SCHEMA })
    const findings = (review && review.findings) || []
    const actionable = findings.filter((f) => f.severity === 'blocker' || f.severity === 'major')
    history.push({ round: r, total: findings.length, actionable: actionable.length })
    residual = findings
    if (actionable.length === 0) { log(`✓ ${d.name}: dry at review round ${r} (${findings.length} non-actionable)`); break }
    log(`${d.name}: round ${r} → ${actionable.length} actionable findings, fixing`)
    const fix = await agent(fixPrompt(d, actionable), { label: `fix:${d.name}#${r}`, phase: 'Fix', schema: FIX_SCHEMA })
    history.push({ round: r, applied: (fix && fix.applied || []).length, skipped: (fix && fix.skipped || []).length })
  }
  return { domain: d.name, draft, history, residualFindings: residual }
}

// ---- run all domains as independent pipelines: draft, then review/fix loop ----
const results = await pipeline(
  DOMAINS,
  (d) => agent(draftPrompt(d), { label: `draft:${d.name}`, phase: 'Draft', schema: DRAFT_SCHEMA }),
  (draft, d) => reviewFixLoop(d, draft),
)

const clean = results.filter(Boolean)

// ---- synthesis: assemble bundle, score everything, write GAPS.md + SCORECARD.md ----
phase('Synthesize')
const synthPrompt = `You are finalizing the EHI→FHIR project at ${ROOT} (cd there).
All ${DOMAINS.length} domain generators are written in src/. Do this:
1. Run \`bun build.ts\` (runs every generator, assembles out/bundle.json). Report any generator that errors.
2. Run \`bun compare.ts\` (summary) and \`bun compare.ts <Type>\` for EVERY type. Capture counts and residual MISSING/EXTRA paths.
3. Read every gaps/*.md.
4. Write GAPS.md at the project root: a single consolidated, deduplicated gap register grouped by resource type, each gap tagged [coding] (terminology lost but text preserved) or [data] (datum absent/unreachable), with the EHI reason. Add a short preamble explaining the two categories and that lost LOINC/SNOMED/RxNorm/CVX codings are expected and acceptable.
5. Write SCORECARD.md at the project root: per-type table of targetCount | generatedCount | target-paths | produced-paths | still-missing-paths, plus an overall summary and the top remaining opportunities.
Here is the per-domain workflow result for reference:
${JSON.stringify(clean.map((r) => ({ domain: r.domain, typeCounts: r.draft && r.draft.typeCounts, residualFindings: (r.residualFindings || []).map((f) => f.severity + ':' + f.kind + ' ' + f.summary) })), null, 2)}
Return a concise final summary: total resources in bundle, per-type generated/target counts, count of [coding] vs [data] gaps, and the 5 biggest remaining opportunities.`

const synthesis = await agent(synthPrompt, { label: 'synthesize', phase: 'Synthesize' })

return { domains: clean.map((r) => ({ domain: r.domain, typeCounts: r.draft && r.draft.typeCounts, history: r.history, residual: (r.residualFindings || []).length })), synthesis }
