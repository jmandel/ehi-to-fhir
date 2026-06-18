export const meta = {
  name: 'ehi-fhir-residual-deepdive',
  description: 'With the FHIR answer key ENABLED (and SmartData excludable), deeply analyze every real-gap + unsure residual delta: truly-unrecoverable vs recoverable-not-tried vs approximatable vs tolerance-candidate',
  phases: [
    { title: 'Partition', detail: 'answer-key-enabled classify (+ smartdata-exclude flag); cluster the residual into a worklist' },
    { title: 'Investigate', detail: 'per cluster: exhaustively test recoverability/approximability against the EHI' },
    { title: 'Synthesize', detail: 'RESIDUAL-DEEPDIVE.md — per-category verdict with proof + prioritized opportunities' },
  ],
}

const ROOT = '/home/jmandel/hobby/my-ehi/ehi-fhir'

const CONTEXT = `Project root (cd here): ${ROOT}. We are doing a THOROUGH deep-dive on the RESIDUAL gap — but measured with the FHIR ANSWER KEY ENABLED (so terminology already layered on). Build it: \`bun build.ts --answer-key\` → out-answerkey/ (codings layered, baseline out/ untouched). Compare with the tolerance-aware classifier: compare/classify.ts (currently reads out/ vs fhir-target/; you may need to point it at out-answerkey/ — make it dir-parameterizable if so). The reconciled buckets are EXACT / TOLERATED / GAP{real-gap, unsure, coding-gap}. With the answer key on, coding-gap shrinks; we focus on real-gap + unsure.

SMARTDATA: the 118 physical-exam SmartData Observations are a KNOWN export-config gap (SMRTDTA_ELEM_DATA not shipped). Add/use a flag to EXCLUDE them from these analyses (e.g. EXCLUDE_SMARTDATA=1 dropping category=smartdata Observations from both sides) and report the residual BOTH with and without them, so smartdata doesn't dominate the picture.

THE CENTRAL QUESTION for every residual field: is it REALLY unrecoverable, or have we just not tried? Four verdicts:
  - TRULY-UNRECOVERABLE — exhaustive cross-table search (\`bun tools/find-concept.ts "<term>" [--grep]\`, every documented table) finds no source AND it can't be generated/approximated. Must cite the search.
  - RECOVERABLE — a concrete EHI column/join yields it (we missed it). Give the source.
  - APPROXIMATABLE / GENERATABLE — not stored verbatim but derivable: e.g. FHIR \`text.div\` narrative is SUPPOSED to be generated from the structured content we already emit; \`meta.lastUpdated\` may map to a record update *_DTTM/_INSTANT; a resolved \`.display\` may be reconstructable from a name/master we already join. Say HOW.
  - TOLERANCE-CANDIDATE — a justified divergence the registry should classify as tolerated (isomorphic/cosmetic/structural/blessed), not a gap.
Be skeptical and concrete: don't label something unrecoverable without the search that proves it; don't claim recoverable without a query that returns the value. Tools: bun lib/q.ts, tools/find-concept.ts, _schema_table/_schema_column.`

const AREAS = [
  { name: 'meta', focus: 'meta.profile / meta.versionId / meta.lastUpdated / meta.security / meta.tag. Is lastUpdated derivable from any record update timestamp (*_UPDATE_DATE, *_INSTANT_*_DTTM, audit V_EHI_*_AUDIT)? Is profile a fixed US-Core assignment we could stamp? Are versionId/security genuinely server-only?' },
  { name: 'narrative', focus: 'text / text.status / text.div. KEY: FHIR narrative is meant to be GENERATED from the structured resource — we have the structured fields. Assess generating a faithful text.div per resource type (and what fidelity vs Epic\'s exact XHTML is achievable). Distinguish "generatable narrative" from "Epic\'s exact bytes".' },
  { name: 'reference-enrichment', focus: '*.display and *.identifier on references (resolved labels + business ids Epic embeds). Which displays can we now reconstruct from the master/name we already join (we added the specificity work)? Which business identifiers (e.g. encounter CSN identifier inside a reference) are derivable from the EHI key? Which are truly server-only?' },
  { name: 'observation-values', focus: 'Observation residual after answer key: vitals/survey/social value codings (LOINC/SNOMED) NOT in the crosswalk, and the VITALS PAIRING FAILURE (our vitals reportedly lack LOINC and sit on different effective timestamps than target — is that a real data gap, a missing crosswalk entry, or a comparison-alignment artifact?). Check LNC_DB_MAIN / flowsheet LOINC / V_EHI_FLO_* for vitals LOINC.' },
  { name: 'cross-links', focus: 'Observation.basedOn/hasMember/derivedFrom/focus and the absent ServiceRequest. Are the panel↔member, order→result, derived-from links reconstructable from EHI order/result structure (ORDER_PROC→ORDER_RESULTS, parent/child orders)? Could we emit ServiceRequest from the order tables so basedOn resolves?' },
  { name: 'unshipped-masters', focus: 'CareTeam (EPT_CARE_TEAMS), DISCRETE_PAT_INSTRUCTIONS, and any other "documented but not shipped" master behind a residual. Re-confirm each is truly 0-rows/0-raw-hits (cite find-concept), and note SmartData here as the headline known gap (set aside by the flag, but quantify it).' },
  { name: 'unsure-linkage', focus: 'The "unsure" bucket: Condition.encounter linkage (we attach a condition to a different but valid encounter than Epic — is our choice defensible/improvable? what rule does Epic seem to use?), Encounter.class.display ("Support OP Encounter" vs "ambulatory"), Observation.code.text formatting, and any other unsure cluster. Classify each: real divergence, tolerance-candidate, or recoverable improvement.' },
]

const PARTITION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['residualWithSmartdata', 'residualExSmartdata', 'clusters'],
  properties: {
    residualWithSmartdata: { type: 'integer' }, residualExSmartdata: { type: 'integer' },
    smartdataExcludeFlag: { type: 'string' },
    clusters: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['area', 'path', 'category', 'count'], properties: {
      area: { type: 'string' }, path: { type: 'string' }, category: { type: 'string', enum: ['real-gap', 'unsure'] }, count: { type: 'integer' }, example: { type: 'string' } } } },
  },
}
const INVESTIGATE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['area', 'findings'],
  properties: { area: { type: 'string' }, findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['field', 'verdict', 'evidence'], properties: {
    field: { type: 'string' },
    verdict: { type: 'string', enum: ['truly-unrecoverable', 'recoverable', 'approximatable', 'tolerance-candidate'] },
    ehiSource: { type: 'string' }, evidence: { type: 'string' }, recommendation: { type: 'string' }, effort: { type: 'string', enum: ['low', 'medium', 'high'] } } } } },
}

phase('Partition')
const partition = await agent(`${CONTEXT}

TASK — PARTITION (phase 1). Run \`bun build.ts --answer-key\`. Make compare/classify.ts able to compare out-answerkey/ vs fhir-target/ AND to EXCLUDE smartdata (add a dir arg + an EXCLUDE_SMARTDATA flag; keep the existing behavior as default). Run it answer-key-enabled, once WITH and once WITHOUT smartdata. Report the residual (real-gap + unsure) totals both ways, and cluster the residual by (area, path, category) mapping each to one of these investigation areas: ${AREAS.map((a) => a.name).join(', ')}. Write compare/RESIDUAL-CLUSTERS.md. Return the structured partition.`, { label: 'partition', phase: 'Partition', schema: PARTITION_SCHEMA })

phase('Investigate')
const investigations = await parallel(AREAS.map((a) => () =>
  agent(`${CONTEXT}

TASK — INVESTIGATE the "${a.name}" residual cluster (answer-key-enabled). FOCUS: ${a.focus}
For EACH distinct residual field in this area, render a verdict (truly-unrecoverable / recoverable / approximatable / tolerance-candidate) with CONCRETE evidence: a find-concept/SQL search that proves absence, or a query/join that yields the value, or the generation method (for approximatable), or the tolerance kind (for tolerance-candidate). Give a recommendation + rough effort. Be exhaustive and skeptical — the whole point is to separate "really lost" from "we didn't try."
Partition context: ${JSON.stringify((partition && partition.clusters || []).filter((c) => c.area === a.name))}
Return findings.`, { label: `investigate:${a.name}`, phase: 'Investigate', schema: INVESTIGATE_SCHEMA })
))

const clean = investigations.filter(Boolean)
phase('Synthesize')
const synth = await agent(`Finalize the residual deep-dive at ${ROOT} (cd there).
Partition: ${JSON.stringify(partition)}
Per-area findings: ${JSON.stringify(clean)}
Write RESIDUAL-DEEPDIVE.md at the project root:
1. Headline: the answer-key-enabled residual size WITH vs WITHOUT smartdata, and the split of the (ex-smartdata) residual across the four verdicts — truly-unrecoverable / recoverable / approximatable / tolerance-candidate — with counts.
2. Per-area section: each residual field, its verdict, the proof (search or join or generation method), and recommendation+effort.
3. A prioritized "OPPORTUNITIES" list: the recoverable + approximatable + tolerance-candidate items, highest value first (e.g. generatable narrative, meta.lastUpdated from update timestamps, derivable reference displays/identifiers, vitals LOINC, ServiceRequest for basedOn) — these are residual we could still close.
4. The TRULY-UNRECOVERABLE floor: what genuinely cannot be recovered even with the answer key (with its proof), and confirm SmartData is the dominant known set-aside.
Return: the four-verdict counts (ex-smartdata), the top 5 opportunities, and the unrecoverable floor size.`, { label: 'synthesize-residual', phase: 'Synthesize' })

return { partition, areas: clean.map((r) => ({ area: r.area, findings: (r.findings || []).length })), synthesis: synth }
