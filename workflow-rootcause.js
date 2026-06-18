export const meta = {
  name: 'ehi-fhir-gap-falsification',
  description: 'Root-cause fix for false-absence: exhaustively re-test every "not in export" claim, recover the data where it actually lives, correct the generators + docs',
  phases: [
    { title: 'Falsify', detail: 'per domain: re-test every absence claim with whole-export search; classify confirmed-absent vs false-absence' },
    { title: 'Recover', detail: 'wire each false-absence from its real source; regenerate + validate' },
    { title: 'Synthesize', detail: 'false-absence register, corrected GAPS/SHAPE-GAPS, ROOT-CAUSE.md' },
  ],
}

const ROOT = '/home/jmandel/hobby/my-ehi/ehi-fhir'

const DOMAINS = [
  { name: 'patient', file: 'patient.ts', types: ['Patient'], seed: 'maritalStatus is in CLM_VALUES.PAT_MAR_STAT (already confirmed) — wire it; also re-test name qualifier, communication, etc.' },
  { name: 'practitioner', file: 'practitioner.ts', types: ['Practitioner'], seed: 'active/gender/name.prefix were declared absent from CLARITY_SER — search EVERYWHERE (SER_RPT_GRP, CLARITY_SER_2, billing/claim rendering-provider rows LN_REND_*, NPI/taxonomy tables).' },
  { name: 'location-org', file: 'location-org.ts', types: ['Location', 'Organization'], seed: 'Org alias/telecom/address, the 5th org — search claim payer/facility tables (LN_SVC_FAC_*, EOB payer).' },
  { name: 'encounter', file: 'encounter.ts', types: ['Encounter'], seed: 'Encounter.type CPT is in SVC_LN_INFO.LN_PROC_CD (HC qual: 99213/99214/99395/99396) + LN_PROC_DESC/LN_PROC_MOD, date/RECORD_ID-anchored — wire it. Re-test visit-type, accident, admit/disch codes.' },
  { name: 'condition', file: 'condition.ts', types: ['Condition'], seed: 'Re-test any coding/onset/stage claims against claim DX tables and EDG.' },
  { name: 'medication', file: 'medication.ts', types: ['MedicationRequest', 'Medication'], seed: 'form/strength/dosageInstruction timing+method+route: HV_DISCR_FREQ_ID, MED_ROUTE_C_NAME, HV_DISCRETE_DOSE; NDC also in SVC_LN_INFO.LN_NDC. courseOfTherapyType. Re-test.' },
  { name: 'immunization', file: 'immunization.ts', types: ['Immunization'], seed: 'location, dose unit code, lot/site — search IMM_ADMIN siblings + claim admin lines (90471/90686 in SVC_LN_INFO).' },
  { name: 'allergy', file: 'allergy.ts', types: ['AllergyIntolerance'], seed: 'category (food/med/environment) + allergen class — search the allergen master/dictionary and any allergy supplement, not just ALLERGY.' },
  { name: 'lab', file: 'lab.ts', types: ['DiagnosticReport', 'Specimen', 'Observation'], seed: 'Re-test specimen/collection, ranges, performer, result codes — incl. claim lab lines (80048/80061/83036 CPT in SVC_LN_INFO).' },
  { name: 'obs-vitals', file: 'obs-vitals.ts', types: ['Observation'], seed: 'Re-test any "no LOINC / no component / no period" claims across flowsheet views (V_EHI_FLO_*).' },
  { name: 'obs-social', file: 'obs-social.ts', types: ['Observation'], seed: 'Re-test social-history value codings against SDD/SOCIAL_HX/flowsheet views.' },
  { name: 'obs-smartdata', file: 'obs-smartdata.ts', types: ['Observation'], seed: 'Re-confirm SMRTDTA_* truly unshipped via find-concept (search the EPIC# concept ids + any V_EHI_SMRTDTA view) — this one may genuinely stay absent, but PROVE it.' },
  { name: 'obs-survey', file: 'obs-survey.ts', types: ['Observation'], seed: 'Re-test the 75 missing group/panel survey rows + value codings across questionnaire views (V_EHI_HQA_*, CL_Q*).' },
  { name: 'documentreference', file: 'documentreference.ts', types: ['DocumentReference'], seed: 'custodian org, content body/attachment, context.period, the 12 missing notes — search HNO siblings + claim letter tables.' },
  { name: 'careplan', file: 'careplan.ts', types: ['CarePlan', 'CareTeam', 'Goal'], seed: 'CareTeam (PAT_PCP exists), care-plan notes, the other 3 careplans, encounter link — search episode/care-team tables broadly.' },
  { name: 'coverage', file: 'coverage.ts', types: ['Coverage'], seed: 'Coverage.type is in COVERAGE.COVERAGE_TYPE_C_NAME (confirmed) — wire it. Re-test class, subscriber, period, the contained payer org.' },
]

const TOOLING = `THE WHOLE-EXPORT SEARCH GATE (use this for EVERY absence claim — this is the root-cause fix):
  bun tools/find-concept.ts "<term>"                 # all tables whose column NAME or DESCRIPTION mentions the concept, populated ones flagged
  bun tools/find-concept.ts "<term>" --grep '<regex>'  # + value scan over raw/EHITables/*.tsv for the actual value pattern
  bun tools/find-concept.ts --grep '<regex>'           # value-only scan (e.g. a CPT/NDC/ICD pattern)
Then confirm with bun lib/q.ts "SELECT ... WHERE <col>=... ". The bug we are killing: a generator checked the ONE obvious column on the ONE obvious table, found it blank/stripped, and wrote "not in export" — while the value lived in another table (CPT in SVC_LN_INFO, marital status in CLM_VALUES, a dose in HV_DISCRETE_DOSE). DOMAIN SILO IS THE ENEMY: explicitly search ACROSS domains — billing/claim lines (SVC_LN_INFO, INV_CLM_*, HSP_*), order/result tables, and V_EHI_* export views — not just your clinical-area tables.`

function preamble(d) {
  return `Project root (cd here, run from here): ${ROOT}. Domain: "${d.name}" → src/${d.file} (${d.types.join(', ')}); gaps doc gaps/${d.name}.md.

${TOOLING}

Libs: ../lib/db (q/q1/dateRealToISO), ../lib/ids (mint/ref/patientRef — never hardcode patient data), ../lib/gen (emit/clean). Validate: bun tools/validate.ts <Type>. House anti-cheat rules still apply: derive from the EHI, never fabricate, codes only if truly present.
DOMAIN SEED (leads, not limits): ${d.seed}
BOUNDARIES: modify ONLY src/${d.file} and gaps/${d.name}.md. Do NOT edit lib/*, tools/*, other domains' files, or run bun build.ts (run bun src/${d.file}).`
}

function falsifyPrompt(d) {
  return `${preamble(d)}

TASK — FALSIFY every absence claim for "${d.name}" (phase 1).
1. Collect EVERY claim that some target field/value is unavailable: read gaps/${d.name}.md and the "not in export / unreachable / absent / stripped / omitted / NOT in" comments in src/${d.file}. Also pull the domain's missing paths via \`bun compare.ts ${d.types[0]}\`.
2. For EACH claim, run the whole-export search gate (find-concept by concept term AND by value pattern), and search CROSS-DOMAIN (claim/billing/order/view tables) — do NOT trust the original within-domain conclusion. Verify any hit with a query that returns THIS patient's actual value, and check it is semantically the same datum (not a coincidental column).
3. Classify each claim: "false-absence" (found a real, usable source → give exact table.column + a query + sample value), "confirmed-absent" (exhaustive search across ALL populated tables returns nothing — say what you searched), or "partial" (a proxy/lossy source exists).
Return the structured claim list. Be rigorous: a claim stays "confirmed-absent" ONLY after a genuinely exhaustive cross-domain search.`
}

function recoverPrompt(d, falsify) {
  return `${preamble(d)}

TASK — RECOVER (phase 2): wire the false-absences into src/${d.file} at the SOURCE (root-cause fix, not a patch).
Falsification result:
${JSON.stringify(falsify, null, 2)}

For each "false-absence" (and usable "partial"): add the join/derivation to src/${d.file} so the field is now populated from its real source; honor anti-cheat (derive, don't fabricate; codes only if present) and FHIR R4 shape. For genuinely "confirmed-absent" claims, KEEP them but rewrite gaps/${d.name}.md to record WHAT WAS SEARCHED to prove absence (so the claim is now falsifiable, not just asserted). Then: \`bun src/${d.file}\` and \`bun tools/validate.ts ${d.types[0]}\` (drive validator errors to 0; Epic-proprietary-extension + offline-terminology warnings are acceptable). Update gaps/${d.name}.md to reflect the new reality.
Return what you recovered (field ← source), what remains confirmed-absent (with the search that proves it), and the validator tally.`
}

const FALSIFY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['domain', 'claims', 'falseAbsenceCount'],
  properties: {
    domain: { type: 'string' },
    claims: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['field', 'verdict', 'evidence'], properties: {
      field: { type: 'string' }, fhirPath: { type: 'string' },
      verdict: { type: 'string', enum: ['false-absence', 'confirmed-absent', 'partial'] },
      foundAt: { type: 'string', description: 'table.column when false-absence/partial' },
      evidence: { type: 'string', description: 'query+value if found, or what was searched if absent' },
    } } },
    falseAbsenceCount: { type: 'integer' },
  },
}
const RECOVER_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['domain', 'recovered', 'stillAbsent', 'validatorErrors'],
  properties: {
    domain: { type: 'string' },
    recovered: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['field', 'source'], properties: { field: { type: 'string' }, source: { type: 'string' } } } },
    stillAbsent: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['field', 'searchedProof'], properties: { field: { type: 'string' }, searchedProof: { type: 'string' } } } },
    validatorErrors: { type: 'integer' },
    notes: { type: 'string' },
  },
}

const results = await pipeline(
  DOMAINS,
  (d) => agent(falsifyPrompt(d), { label: `falsify:${d.name}`, phase: 'Falsify', schema: FALSIFY_SCHEMA }),
  async (falsify, d) => {
    const fc = (falsify && falsify.falseAbsenceCount) || 0
    const hasPartial = (falsify && falsify.claims || []).some((c) => c.verdict === 'partial')
    if (fc === 0 && !hasPartial) {
      log(`${d.name}: 0 false-absences (all claims hold) — recording search proofs only`)
    } else {
      log(`${d.name}: ${fc} false-absence(s) → recovering at source`)
    }
    const recover = await agent(recoverPrompt(d, falsify), { label: `recover:${d.name}`, phase: 'Recover', schema: RECOVER_SCHEMA })
    return { domain: d.name, falsify, recover }
  },
)

const clean = results.filter(Boolean)
phase('Synthesize')
const synth = await agent(`Finalize the gap-falsification / root-cause recovery at ${ROOT} (cd there).
Per-domain results:
${JSON.stringify(clean.map((r) => ({ domain: r.domain, falseAbsences: r.falsify && r.falsify.falseAbsenceCount, recovered: (r.recover && r.recover.recovered || []).map((x) => x.field + ' <- ' + x.source), stillAbsent: (r.recover && r.recover.stillAbsent || []).map((x) => x.field), validatorErrors: r.recover && r.recover.validatorErrors })), null, 2)}
1. Run \`bun build.ts\`, then \`bun compare.ts\` and validate the bundle (java -Xmx4g -jar tools/validator_cli.jar out/bundle.json -version 4.0.1 -ig hl7.fhir.us.core.r4#8.0.1 -tx n/a -output /tmp/rc.json); report new resource/path counts and that real structural errors are still 0.
2. Write FALSE-ABSENCE-REGISTER.md: a table of every re-tested claim — domain | field | old verdict (absent) | new verdict | real source (table.column) | now recovered? Tally false-absences vs confirmed-absent.
3. CORRECT the docs: update GAPS.md and SHAPE-GAPS.md to move recovered fields out of the unrecoverable categories and cite the real source; every remaining absence claim must now carry the search that proves it.
4. Write ROOT-CAUSE.md: the systemic causes (decoy/blank-column-as-absence; domain-siloed search; no exhaustive-search gate; unverified gap propagation), and the systemic fixes applied (the tools/find-concept.ts gate; the cross-domain search requirement; the gaps-doc rule that absence must cite search evidence; the recoveries this produced). Frame it as the genre-level lesson, not a per-field patch.
Return a concise summary: total claims re-tested, false-absences found & recovered, fields still confirmed-absent (with proof), and final validator status.`, { label: 'synthesize', phase: 'Synthesize' })

return { domains: clean.map((r) => ({ domain: r.domain, falseAbsences: r.falsify && r.falsify.falseAbsenceCount, recovered: (r.recover && r.recover.recovered || []).length })), synthesis: synth }
