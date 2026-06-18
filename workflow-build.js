export const meta = {
  name: 'ehi-fhir-comms-billing',
  description: 'Research FHIR R4 defs for secure-communications + billing/insurance, then build & validate EHI→FHIR generators',
  phases: [
    { title: 'Design', detail: 'study the R4 def, map to EHI, write design/<res>.md, decide feasibility' },
    { title: 'Build', detail: 'write src/<res>.ts for feasible resources' },
    { title: 'Validate', detail: 'HL7 validator + adversarial review, fix until clean (max 3)' },
    { title: 'Synthesize', detail: 'write NEW-RESOURCES.md + gap notes' },
  ],
}

const ROOT = '/home/jmandel/hobby/my-ehi/ehi-fhir'
const GUIDES = '../skills/reading-epic-ehi-export/reference/clinical-areas'
const PATTERNS = '../skills/reading-epic-ehi-export/reference/patterns/general-patterns.md'

// New resources. No target exists in fhir-target/ — QA is the FHIR validator + adversarial review + the design spec.
const RES = [
  { name: 'communication', file: 'communication.ts', type: 'Communication', idfn: 'communication', group: 'secure-communications',
    doc: 'https://hl7.org/fhir/R4/communication.html', guides: ['patient-provider-messaging.md'],
    ehi: 'MYC_MESG + MYC_MESG_RTF_TEXT (newer) and MSG_TXT (older) bodies; PAT_MYC_MESG, MSG_ROUTING_PAT_ENC (thread/encounter CSN), MYC_MESG_CHILD, MYC_MESG_CNCL_RSN. sender/recipient = patient vs provider (CLARITY_SER/EMP); sent/received instants; payload.contentString from the RTF/plain body (use ../lib/rtf2txt if needed); category (patient message vs staff); inResponseTo via thread.' },
  { name: 'eob', file: 'eob.ts', type: 'ExplanationOfBenefit', idfn: 'explanationOfBenefit', group: 'billing',
    doc: 'https://hl7.org/fhir/R4/explanationofbenefit.html', guides: ['coverage-and-billing.md', 'benefits-and-eligibility.md'],
    ehi: 'PMT_EOB_INFO_I/II (payer adjudication lines: allowed/paid/patient-responsibility/adjustment reasons), ARPB_TRANSACTIONS(+2/+3) charges & payments, ARPB_TX_MATCH_HX (charge↔payment matching), CL_REMIT, ARPB_TX_STMCLAIMHX, TX_DIAG/ARPB_CHG_ENTRY_DX. Link to Coverage (cov-*), Patient, provider, and the claim. item[] from charge lines with adjudication[] from EOB.' },
  { name: 'claim', file: 'claim.ts', type: 'Claim', idfn: 'claim', group: 'billing',
    doc: 'https://hl7.org/fhir/R4/claim.html', guides: ['coverage-and-billing.md'],
    ehi: 'ARPB_TRANSACTIONS charge lines grouped by visit/invoice (ARPB_VISITS, INVOICE), ARPB_CHG_ENTRY_DX/TX_DIAG (diagnoses), ARPB_TX_MODIFIERS, RECONCILE_CLAIM_STATUS / ARPB_TX_STMCLAIMHX (claim submission + status). provider, insurer→Coverage, billable period, item[] (CPT, modifiers, dx pointers, charge amounts), total.' },
  { name: 'account', file: 'account.ts', type: 'Account', idfn: 'account', group: 'billing',
    doc: 'https://hl7.org/fhir/R4/account.html', guides: ['coverage-and-billing.md'],
    ehi: 'HAR_ALL (hospital account record: type, status, service period), guarantor/coverage via HSP_ACCT_CVG_LIST, ARPB_VISITS for PB. subject=Patient, type (HB vs PB), status, coverage[]→Coverage, owner→Organization.' },
  { name: 'chargeitem', file: 'chargeitem.ts', type: 'ChargeItem', idfn: 'chargeItem', group: 'billing',
    doc: 'https://hl7.org/fhir/R4/chargeitem.html', guides: ['coverage-and-billing.md'],
    ehi: 'ARPB_TRANSACTIONS rows where TX_TYPE is a charge (CPT/proc code, quantity, amount, service date, performing/billing provider, department). code (CPT if present, else text), subject=Patient, occurrence, quantity/priceOverride, account→Account, context=Encounter.' },
  { name: 'invoice', file: 'invoice.ts', type: 'Invoice', idfn: 'invoice', group: 'billing',
    doc: 'https://hl7.org/fhir/R4/invoice.html', guides: ['coverage-and-billing.md'],
    ehi: 'INVOICE table + the charge lines it bundles (ARPB transactions / HSP_TX_LINE_INFO). subject=Patient, status, lineItem[] (→ChargeItem ref or inline chargeItemCodeableConcept + priceComponent), totalNet/totalGross, date. Only build if INVOICE rows carry real invoice semantics distinct from Account/Claim — otherwise mark skip in design.' },
  { name: 'paymentrecon', file: 'paymentrecon.ts', type: 'PaymentReconciliation', idfn: 'paymentReconciliation', group: 'billing',
    doc: 'https://hl7.org/fhir/R4/paymentreconciliation.html', guides: ['coverage-and-billing.md'],
    ehi: 'CL_REMIT (remittance advice) + PMT_EOB_INFO (payment EOB), ARPB payment transactions. paymentDate, paymentAmount, detail[] linking payments to claims/charges, paymentIssuer→Organization. Only build if remittance rows are coherent enough — else skip in design.' },
  { name: 'coverageeligibility', file: 'coverageeligibility.ts', type: 'CoverageEligibilityResponse', idfn: 'coverageEligibilityResponse', group: 'billing',
    doc: 'https://hl7.org/fhir/R4/coverageeligibilityresponse.html', guides: ['benefits-and-eligibility.md'],
    ehi: 'BENEFITS / COVERAGE_BENEFITS / SERVICE_BENEFITS / BENEFIT_SVC_TYPE (benefit snapshots: copay/coinsurance/deductible by service type), MED_CVG_* (RTPB pharmacy eligibility). insurance[].item[] (category=service type, benefit[] money/allowed), insurer→Organization, patient, status=active, outcome.' },
]

function preamble(r) {
  const guidePaths = r.guides.map((g) => `  - ${GUIDES}/${g}`).join('\n')
  return `You build a DETERMINISTIC Bun/TypeScript translator from an Epic EHI export (SQLite) to FHIR R4.
Project root (cd here, run everything from here): ${ROOT}
There is NO reference target for ${r.type} in fhir-target/ — your spec is the FHIR R4 definition + the EHI data + the design doc; QA is the official FHIR validator and adversarial review.

REQUIRED READING:
  - The FHIR R4 spec for this resource: ${r.doc} (use WebFetch — load it with ToolSearch "select:WebFetch" first if it isn't already callable — to confirm exact element names, cardinalities, required fields, and value-set bindings). If WebFetch is unavailable, rely on your knowledge of FHIR R4 ${r.type} but be conservative and only emit elements you are certain exist.
  - ${PATTERNS}  (EHI grammar: CSN, *_DATE_REAL, _C_NAME, base+supplement, everything-is-TEXT, sentinels, _NAME companions, soft-deletes)
${guidePaths}
  - Existing generators in src/ (e.g. src/coverage.ts, src/encounter.ts, src/medication.ts) for house style + how references are minted. READ THEM FOR INSPIRATION but do not copy data.

EHI SOURCE TABLES (starting points — verify columns with PRAGMA/_schema_column, follow the guide): ${r.ehi}

LIBS (import relative from src/, i.e. "../lib/..."):
  - ../lib/db  : q(sql,...params)->rows, q1, db, dateRealToISO(v), parseEpicDateTime(v), columnsOf(t), tableHasRows(t). EVERYTHING is TEXT — CAST before ORDER BY/MIN/MAX/ranges.
  - ../lib/ids : id.${r.idfn}(key) mints this resource's id; ref(Type,id,display?), patientRef() (DERIVES patient display — never hardcode it), PATIENT_ID. Reference existing resources via their minters (id.coverage, id.encounter, id.practitioner, id.organization, id.patient...).
  - ../lib/gen : emit("${r.type}", resources[]) writes out/${r.type}.json. clean(obj) strips empties — use it.
  - ../lib/rtf2txt (if needed for message bodies).

EXPLORE: bun lib/q.ts "SELECT ...". VALIDATE: bun tools/validate.ts ${r.type}  (HL7 FHIR R4 validator; 0 errors is the bar; warnings about unverified codes are acceptable for best-effort codings).

MAPPING PRINCIPLES (STRICT — same as the rest of the project):
  1. NEVER fabricate. Emit a value/code/display/date ONLY when it is traceable to an EHI column. No literal copied from anywhere as a stand-in. No hardcoded patient/provider/org names — derive them (patientRef(), CLARITY_SER/EMP/DEP joins). A constant is OK only if it encodes FHIR structure (system URIs, FHIR enums) or mapping logic (_C_NAME→enum maps), never this patient's data.
  2. Codings are best-effort: emit a code only if present in the EHI (CPT on charges, service-type codes, etc.); otherwise text/display only and record a [coding] gap.
  3. Money: emit amounts as FHIR Money {value, currency:"USD"} only from real amount columns; respect sign/credit conventions (charges vs payments vs adjustments) — get this right, it's a common bug.
  4. References must resolve to ids other generators mint (use ../lib/ids).
  5. clean() every resource. Match FHIR R4 cardinality/required elements so the validator passes (e.g. status, required code/subject).

BOUNDARIES: create/modify ONLY src/${r.file}, out/${r.type}.json (via emit), design/${r.name}.md, gaps/${r.name}.md. DO NOT edit lib/*, tools/*, compare.ts, build.ts, fhir-target/*, or other resources' files. Do NOT run \`bun build.ts\`.`
}

function designPrompt(r) {
  return `${preamble(r)}

TASK — DESIGN (phase 1) for ${r.type} (group: ${r.group}).
1. Study the FHIR R4 ${r.type} definition (WebFetch ${r.doc}): list its elements with cardinality, the REQUIRED ones, and key bindings.
2. Explore the EHI source tables above. Determine, element by element, what can be populated and from which exact column/join, and what cannot (gap).
3. Decide FEASIBILITY: "build" if the EHI carries enough to produce at least the required elements + meaningful content for a non-trivial number of instances; "skip" if the data is absent/too thin or fully redundant with another resource we already build (say which).
4. Write design/${r.name}.md: the element→EHI-source mapping table, the populatable count estimate, the required-element coverage, and the gaps.
Return the structured design verdict.`
}

function buildPrompt(r, design) {
  return `${preamble(r)}

TASK — BUILD (phase 2) src/${r.file} for ${r.type}.
Your design doc design/${r.name}.md says it is feasible. Implement it:
1. Write src/${r.file}: query the EHI via ../lib/db, build ${r.type} resources honoring FHIR R4 cardinality/required elements, mint ids via id.${r.idfn} and reference other resources via ../lib/ids, clean() each, emit("${r.type}", arr).
2. Run \`bun src/${r.file}\` then \`bun tools/validate.ts ${r.type}\`. Drive errors to ZERO (fix structural issues: required fields, valid codes/enums, date formats, Money shape, reference format). Warnings about unverifiable external codes are OK.
3. Update gaps/${r.name}.md with anything you couldn't populate.
Return counts + the validator error/warning tally.`
}

function reviewPrompt(r, round) {
  return `${preamble(r)}

TASK — ADVERSARIAL REVIEW (round ${round}) of src/${r.file} → ${r.type}. Assume it is wrong until proven right.
Run: bun src/${r.file} ; bun tools/validate.ts ${r.type} ; bun lib/q.ts "SELECT ..." to verify claims ; eyeball out/${r.type}.json vs design/${r.name}.md and the R4 spec.
Hunt for:
  - Validator ERRORS still present (any error is a blocker).
  - FABRICATION: any value/code/display/date/amount not traceable to an EHI column; any hardcoded patient/provider/org name. PROVE with a query.
  - WRONG money signs/semantics (charge vs payment vs adjustment vs patient-responsibility), wrong currency, double-counting.
  - Missing REQUIRED-by-design elements the EHI can supply; dangling references; wrong reference targets/ids.
  - Wrong *_DATE_REAL conversion, lexical-sort bugs, status/category miscoding.
  - Dishonest gaps doc.
Return findings[] with severity (blocker/major/minor), concrete evidence (query+result or spec/excerpt), and a concrete fix. Empty findings only if genuinely clean.`
}

function fixPrompt(r, findings) {
  return `${preamble(r)}

TASK — FIX src/${r.file} (${r.type}) per these review findings:
${JSON.stringify(findings, null, 2)}
Apply each (no fabrication; codes only if in EHI; update gaps/${r.name}.md for the unreachable). Then run \`bun src/${r.file}\` and \`bun tools/validate.ts ${r.type}\` to confirm 0 errors. Skip a finding only if wrong/infeasible, with a precise reason. Return applied vs skipped + validator tally.`
}

const DESIGN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['resource', 'feasibility', 'estPopulatableCount', 'requiredElementsCovered', 'gaps'],
  properties: {
    resource: { type: 'string' },
    feasibility: { type: 'string', enum: ['build', 'skip'] },
    skipReason: { type: 'string' },
    estPopulatableCount: { type: 'integer' },
    requiredElementsCovered: { type: 'boolean' },
    populatableElements: { type: 'array', items: { type: 'string' } },
    gaps: { type: 'array', items: { type: 'string' } },
  },
}
const BUILD_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['resource', 'generatedCount', 'validatorErrors', 'validatorWarnings'],
  properties: { resource: { type: 'string' }, generatedCount: { type: 'integer' }, validatorErrors: { type: 'integer' }, validatorWarnings: { type: 'integer' }, notes: { type: 'string' } },
}
const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['resource', 'findings'],
  properties: { resource: { type: 'string' }, findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['severity', 'kind', 'summary', 'evidence', 'fix'], properties: {
    severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, kind: { type: 'string' }, summary: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' } } } } },
}

const out = await pipeline(
  RES,
  (r) => agent(designPrompt(r), { label: `design:${r.name}`, phase: 'Design', schema: DESIGN_SCHEMA }),
  async (design, r) => {
    if (!design || design.feasibility !== 'build') {
      log(`skip ${r.type}: ${(design && design.skipReason) || 'design returned non-build'}`)
      return { resource: r.type, skipped: true, reason: design && design.skipReason }
    }
    const build = await agent(buildPrompt(r, design), { label: `build:${r.name}`, phase: 'Build', schema: BUILD_SCHEMA })
    // validate + adversarial review/fix loop, up to 3 rounds
    let residual = []
    for (let i = 1; i <= 3; i++) {
      const review = await agent(reviewPrompt(r, i), { label: `review:${r.name}#${i}`, phase: 'Validate', schema: REVIEW_SCHEMA })
      const findings = (review && review.findings) || []
      const actionable = findings.filter((f) => f.severity === 'blocker' || f.severity === 'major')
      residual = findings
      if (actionable.length === 0) { log(`✓ ${r.type}: clean at review round ${i}`); break }
      log(`${r.type}: round ${i} → ${actionable.length} actionable, fixing`)
      await agent(fixPrompt(r, actionable), { label: `fix:${r.name}#${i}`, phase: 'Validate', schema: BUILD_SCHEMA })
    }
    return { resource: r.type, build, residual: residual.length }
  },
)

const clean = out.filter(Boolean)
phase('Synthesize')
const synth = await agent(`Finalize the comms+billing FHIR build at ${ROOT} (cd there).
Per-resource results:
${JSON.stringify(clean, null, 2)}
1. For every built resource run \`bun tools/validate.ts <Type>\` and record the final error/warning counts.
2. Run \`bun build.ts\` so out/bundle.json includes the new resources; report total resource count and any generator that errors.
3. Read design/*.md and gaps/*.md for the new resources.
4. Write NEW-RESOURCES.md at the project root: a section per resource (Communication + each billing/insurance one) with: built-or-skipped (+reason), generated count, validator status (errors/warnings), the element→EHI mapping summary, and the gaps ([coding]/[data]). Note that these have no fhir-target reference, so correctness rests on the validator + adversarial review.
Return a concise summary: which resources were built vs skipped, total new resources, and validator status across them.`, { label: 'synthesize', phase: 'Synthesize' })

return { built: clean.filter((c) => !c.skipped).map((c) => ({ type: c.resource, count: c.build && c.build.generatedCount, errors: c.build && c.build.validatorErrors, residual: c.residual })), skipped: clean.filter((c) => c.skipped).map((c) => ({ type: c.resource, reason: c.reason })), synthesis: synth }
