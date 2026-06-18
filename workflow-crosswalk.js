export const meta = {
  name: 'ehi-fhir-terminology-crosswalk',
  description: 'Reconstruct the Epic-local→standard terminology crosswalk by pairing EHI local codes with the standard codings in the reference FHIR',
  phases: [
    { title: 'Extract', detail: 'per area: pair target dual-codings, verify the local code in the EHI, write crosswalk/<area>.csv' },
    { title: 'Verify', detail: 'adversarial check: no fabricated mappings, ehi_verified is honest' },
    { title: 'Synthesize', detail: 'merge ALL.csv, coverage stats, consume-demo' },
  ],
}

const ROOT = '/home/jmandel/hobby/my-ehi/ehi-fhir'

const HEADER = 'area,fhir_path,concept_display,ehi_join_table,ehi_join_column,epic_local_system,epic_local_code,epic_local_display,target_system,target_code,target_display,anchor_method,ehi_verified,confidence,notes'

const AREAS = [
  { name: 'lab', file: 'lab.csv', area: 'lab',
    targets: 'fhir-target/Observation.json (category=laboratory) + fhir-target/DiagnosticReport.json',
    standards: 'LOINC (http://loinc.org)',
    join: 'The Epic-local lab component lives in ORDER_RESULTS.COMPONENT_ID (and the order in ORDER_PROC.PROC_ID/ORDER_PROC_ID). Target Observation.code.coding carries LOINC + several Epic-local oids; the .768282 system code (e.g. 1510194 "BUN/Creatinine Ratio") is the component-level key — confirm which Epic-local code actually matches an EHI column (COMPONENT_ID, COMMON_NAME, or the order PROC_ID).' },
  { name: 'vital', file: 'vital.csv', area: 'vital',
    targets: 'fhir-target/Observation.json (category=vital-signs)',
    standards: 'LOINC',
    join: 'Flowsheet measures: IP_FLWSHT_MEAS / IP_FLO_GP_DATA, key FLO_MEAS_ID. Target vital Observation.code.coding carries LOINC + the Epic flowsheet-id system (http://open.epic.com/FHIR/StructureDefinition/observation-flowsheet-id) and/or urn:oid:…707679 with the FLO_MEAS_ID as code. Pair flowsheet-id → LOINC.' },
  { name: 'problem', file: 'problem.csv', area: 'problem',
    targets: 'fhir-target/Condition.json (Condition.code)',
    standards: 'ICD-10-CM, ICD-9-CM, SNOMED CT',
    join: 'PROBLEM_LIST.DX_ID (→ CLARITY_EDG.DX_NAME). Target Condition.code.coding carries ICD-10 + SNOMED + ICD-9 + the Epic DX system urn:oid:2.16.840.1.113883.3.247.1.1 whose code IS the DX_ID (e.g. 8169). Verify DX_ID presence in PROBLEM_LIST (and PROBLEM_LIST_ALL / PAT_ENC_DX). One DX_ID → multiple rows (one per ICD-10/ICD-9/SNOMED).' },
  { name: 'medication', file: 'medication.csv', area: 'medication',
    targets: 'fhir-target/Medication.json (Medication.code) + fhir-target/MedicationRequest.json',
    standards: 'RxNorm (http://www.nlm.nih.gov/research/umls/rxnorm), NDC (http://hl7.org/fhir/sid/ndc)',
    join: 'ORDER_MED.MEDICATION_ID (Epic ERX/medication record id) + RXNORM/NDC if present. Target Medication.code.coding carries RxNorm/NDC + the Epic medication-id oid whose code is the MEDICATION_ID. Verify MEDICATION_ID in ORDER_MED.' },
  { name: 'immunization', file: 'immunization.csv', area: 'immunization',
    targets: 'fhir-target/Immunization.json (Immunization.vaccineCode)',
    standards: 'CVX (http://hl7.org/fhir/sid/cvx)',
    join: 'IMMUNE / IMM_ADMIN immunization record id (and the immunization name). Target Immunization.vaccineCode.coding carries CVX + an Epic-local immunization-id oid. Pair the Epic immunization id → CVX; verify the id in the EHI immunization tables.' },
  { name: 'allergy', file: 'allergy.csv', area: 'allergy',
    targets: 'fhir-target/AllergyIntolerance.json (AllergyIntolerance.code)',
    standards: 'RxNorm, SNOMED CT',
    join: 'ALLERGY.ALLERGEN_ID (+ ALLERGEN_ID_ALLERGEN_NAME). Target AllergyIntolerance.code.coding carries RxNorm/SNOMED + an Epic allergen-id oid whose code is the ALLERGEN_ID. Verify ALLERGEN_ID in ALLERGY.' },
  { name: 'observation-coded', file: 'observation-coded.csv', area: 'smartdata',
    targets: 'fhir-target/Observation.json (category in {smartdata, survey, social-history}) — both Observation.code AND Observation.valueCodeableConcept',
    standards: 'SNOMED CT, LOINC',
    join: 'smartdata: SmartData element ids (SMRTDTA_* store is NOT shipped → those rows get ehi_verified=no, but STILL record the dual-coding pair as a would-be mapping). survey/social: flowsheet (FLO_MEAS_ID) and SDD store; social-history smoking value maps SNOMED. Record both code and value codings. Mark ehi_verified honestly per row.' },
  { name: 'other-coded', file: 'other-coded.csv', area: 'other',
    targets: 'fhir-target/DocumentReference.json (type), Encounter.json (type/class — note class is derivable not stored), Coverage.json (type), Specimen.json (type), CarePlan.json (category), Practitioner.json (qualification if any)',
    standards: 'LOINC (document types), HL7 v3-ActCode (encounter class), and any standard system present',
    join: 'These are mostly _C_NAME categoricals or Epic masters. For each coded element, pair the Epic-local code/_C_NAME with whatever standard coding the target carries, name the EHI source column, and verify. Many will be value-set-literal or low-confidence — that is fine; record honestly.' },
]

function preamble(a) {
  return `Project root (cd here, run from here): ${ROOT}
You are reconstructing an EXCERPT of Epic's internal terminology crosswalk for the "${a.area}" area, by pairing this export's Epic-LOCAL codes with the STANDARD codings in the reference FHIR. Read ${ROOT}/crosswalk/README.md FIRST — it defines the exact CSV format and the idea.

YOUR TARGETS: ${a.targets}
STANDARD SYSTEMS expected here: ${a.standards}
EHI JOIN: ${a.join}

THE METHOD (anchor every row in real data — NO fabrication):
1. For each coded element in the target, look at its code.coding[] array. Epic usually lists BOTH the standard coding(s) (LOINC/SNOMED/RxNorm/CVX/ICD/CPT) AND one or more Epic-local codings (urn:oid:1.2.840.114350… or open.epic.com systems). The standard+local pair in the SAME array is a "dual-coding" anchor → emit one crosswalk row per (local code → standard code).
2. Identify WHICH Epic-local code is the join key the EHI actually ships, and the exact EHI table.column it lives in. VERIFY it: run \`bun lib/q.ts "SELECT ... WHERE <col> = '<epic_local_code>'"\` and set ehi_verified=yes only if it returns a row. If the standard code exists in the target but you cannot find a matching Epic-local code in the EHI, still record the row with ehi_verified=no (this documents the residual gap).
3. Fallback anchors when there is no dual-coding (e.g. a value code): content-match the target resource to its EHI row by name+value+date and read the local code (anchor_method=content-match); or for fixed _C_NAME→code mappings use value-set-literal.
4. A concept with N standard systems (ICD-10 + SNOMED + ICD-9) → N rows.

OUTPUT: write ${ROOT}/crosswalk/${a.file}, RFC-4180 CSV, with EXACTLY this header line first:
${HEADER}
Quote any field containing a comma/quote/newline and escape embedded quotes by doubling them. BUILD THE FILE WITH A SMALL BUN SCRIPT (read fhir-target/*.json + query the DB via ../lib/db, assemble rows, write the CSV with correct escaping) so it is deterministic and correct — you may keep the script as crosswalk/build-${a.name}.ts. Do NOT hand-type rows.

STRICT: every epic_local_code and target_code must come from real data (the target FHIR and/or the EHI) — never invent a code. ehi_verified must be truthful. Modify ONLY crosswalk/${a.file} and optionally crosswalk/build-${a.name}.ts. Do NOT touch src/, lib/, other areas' files, or run bun build.ts.`
}

const EXTRACT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['area', 'csv', 'rows', 'verifiedRows', 'distinctConcepts', 'unanchored'],
  properties: {
    area: { type: 'string' }, csv: { type: 'string' },
    rows: { type: 'integer' }, verifiedRows: { type: 'integer' }, distinctConcepts: { type: 'integer' },
    targetSystems: { type: 'array', items: { type: 'string' } },
    unanchored: { type: 'integer', description: 'standard codes in target with no EHI-verified local key' },
    notes: { type: 'string' },
  },
}
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['area', 'clean', 'issues'],
  properties: { area: { type: 'string' }, clean: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['row', 'problem', 'fix'], properties: { row: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } } } } },
}

const results = await pipeline(
  AREAS,
  (a) => agent(`${preamble(a)}\n\nTASK — EXTRACT the crosswalk for "${a.area}" now. Write crosswalk/${a.file}. Return the structured tally.`,
    { label: `extract:${a.name}`, phase: 'Extract', schema: EXTRACT_SCHEMA }),
  async (extract, a) => {
    const v = await agent(`${preamble(a)}

TASK — ADVERSARIAL VERIFY crosswalk/${a.file}. Re-read it and prove rows are honest:
- Pick a sample of rows and confirm BOTH target_code (in fhir-target) and epic_local_code (in the EHI via \`bun lib/q.ts\`) are real — flag any fabricated/guessed code.
- Confirm ehi_verified=yes rows truly join (the epic_local_code returns a row from ehi_join_table.ehi_join_column) and ehi_verified=no rows genuinely don't.
- Confirm the header matches the spec exactly and CSV escaping is valid (no row-count drift from unescaped commas).
- Flag dual-coding rows where the local↔standard pairing was actually from different concepts (mis-pair).
Return findings; empty if clean. If you find fixable issues, ALSO correct crosswalk/${a.file} (and its build script) before returning.`,
      { label: `verify:${a.name}`, phase: 'Verify', schema: VERIFY_SCHEMA })
    return { area: a.area, file: a.file, extract, verify: v }
  },
)

const clean = results.filter(Boolean)
phase('Synthesize')
const synth = await agent(`Finalize the terminology crosswalk at ${ROOT}/crosswalk (cd ${ROOT}).
Per-area results:
${JSON.stringify(clean.map((r) => ({ area: r.area, file: r.file, rows: r.extract && r.extract.rows, verified: r.extract && r.extract.verifiedRows, concepts: r.extract && r.extract.distinctConcepts, unanchored: r.extract && r.extract.unanchored, verifyClean: r.verify && r.verify.clean })), null, 2)}
1. Merge every crosswalk/<area>.csv into crosswalk/ALL.csv (one header, then all rows; keep the area column). Verify the merged row count equals the sum of the parts (CSV-parse, don't naive-concat if any file lacks a trailing newline).
2. Write crosswalk/COVERAGE.md: a table of area | rows | ehi_verified rows | distinct concepts | target systems | unanchored(residual). Add a short narrative: which terminology areas are now closeable from this export (high ehi_verified) vs which stay gaps (e.g. smartdata: local store unshipped → ehi_verified=no), and the overall "% of our coded concepts now bridgeable."
3. Write crosswalk/demo-consume.ts: a tiny runnable bun script proving the concept — load ALL.csv, pick one area (e.g. problem), and for a real EHI DX_ID show the recovered code.coding[] it would attach (JOIN ehi_join_column = local code). Print 3-5 examples.
Return a concise summary: total rows, total ehi_verified rows, distinct concepts bridged, the per-area coverage, and the headline "% bridgeable" with the biggest residual gaps.`, { label: 'synthesize', phase: 'Synthesize' })

return { areas: clean.map((r) => ({ area: r.area, rows: r.extract && r.extract.rows, verified: r.extract && r.extract.verifiedRows, unanchored: r.extract && r.extract.unanchored })), synthesis: synth }
