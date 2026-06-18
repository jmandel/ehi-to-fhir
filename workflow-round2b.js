export const meta = {
  name: 'ehi-fhir-round2b-provider-overlay-attachments',
  description: 'Provider-demographics overlay via NPI+NPPES (#5) and DocumentReference Binary attachments (#1); reconcile',
  phases: [
    { title: 'Build', detail: '#5 NPI→NPPES provider overlay + #1 Binary attachments (parallel, disjoint files)' },
    { title: 'Reconcile', detail: 'full build ±answer-key ±embed-attachments; gates; validate; classify; docs/TODO' },
  ],
}

const ROOT = '/home/jmandel/hobby/my-ehi/ehi-fhir'
const RULES = `Project root (cd here): ${ROOT}. Rules: derive from the EHI; never fabricate; mint refs via ../lib/ids; keep the reference-integrity gate at 0 dangling / 0 type-violations. VERIFY with your OWN generator only (\`bun src/<your-file>\`) — do NOT run full \`bun build.ts\` during your phase (the reconcile phase does the single full build) so the two parallel agents don't race on out/.`

phase('Build')
const build = await parallel([
  // #5 — provider demographics via NPI + public NPPES registry
  () => agent(`${RULES}

TASK — TODO #5: recover provider demographics via NPI + the public NPPES registry (external authoritative overlay).
NPI IS in the EHI: SVC_LN_INFO.LN_REND_NPI (+ LN_ORD_NPI / LN_SUP_NPI / LN_PCP_REF_NPI; e.g. RAMMELKAMP ZOE → 1205323193), cross-domain in the claim lines.
1. Build tools/nppes-overlay.ts: given a set of NPIs, query the PUBLIC NPPES registry API (https://npiregistry.cms.hhs.gov/api/?version=2.1&number=<NPI>) — read-only, no auth, send ONLY the NPI (public provider data; NO patient/PHI). Cache results to a local JSON (e.g. tools/nppes-cache.json) so it's reproducible and offline-friendly. If the network is unavailable, SKIP gracefully (use cache if present; otherwise emit nothing and log) — never fail the build, never fabricate.
2. In src/practitioner.ts: recover each provider's NPI by mapping SVC_LN_INFO.LN_REND_NPI (+ siblings) → our prac-<SER_ID> (match on provider name / PROV_ID), emit it as Practitioner.identifier (system http://hl7.org/fhir/sid/us-npi). Then overlay NPPES fields: gender, name.prefix (from credential — MD/DO→"Dr."; respect NP/DNP/PA — do NOT over-map), qualification (taxonomy/credential), and the registry's official name where it adds nothing false. TAG NPPES-sourced fields' provenance (a comment/extension noting external-registry source) — they are authoritative public data, not EHI-derived and not fabricated.
3. Verify with \`bun src/practitioner.ts\` + \`bun tools/validate.ts Practitioner\` (0 errors). Edit ONLY tools/nppes-overlay.ts (new), tools/nppes-cache.json (new), src/practitioner.ts. Report: NPIs recovered, NPPES fields filled (gender/prefix/qualification counts), and whether the network was reachable (else cache/skip).`, { label: 'r2b:nppes', phase: 'Build' }),

  // #1 — DocumentReference Binary attachments (opt-in)
  () => agent(`${RULES}

TASK — TODO #1: populate DocumentReference attachments via Binary resources (opt-in). See TODO.md item 1 for the full spec.
1. New src/binary.ts: for each DocumentReference's note, read raw/Rich Text/HNO_<NOTE_ID>_*.RTF (and generalize to Media via DOC_INFORMATION.SCAN_FILE), mint Binary id = content hash (bin-<sha1(bytes)>; dedup identical bodies), emit { resourceType:"Binary", id, contentType:"text/rtf", data:<base64 exact bytes> } (+ optional text/plain via ../lib/rtf2txt as a derived second Binary).
2. In src/documentreference.ts: set content[].attachment = { contentType:"text/rtf", url:"Binary/<hashid>", size, hash:<base64 SHA-1>, title, creation } — OMIT inline data (it's in the Binary) and OMIT the unreproducible Epic Binary id.
3. build.ts: add opt-in \`--embed-attachments\` (env-gated) — when set, run the Binary generator and include out/Binary.json in the bundle with absolute fullUrl; plain build stays lean. KEEP the existing reference-integrity gate.
4. tools/refcheck.ts: resolve attachment.url "Binary/<id>" against emitted Binary resources (today it only checks .reference, so a url string is invisible → could silently dangle); add Binary to the resolvable set/bundle scheme.
5. Verify: \`bun src/binary.ts\`, \`bun src/documentreference.ts\`, \`bun build.ts --embed-attachments\` then \`bun tools/refcheck.ts\` (Binary urls resolve, 0 dangling) and \`bun tools/validate.ts Binary\` / \`DocumentReference\` (0 errors). Edit ONLY src/binary.ts (new), src/documentreference.ts, build.ts, tools/refcheck.ts. Report: Binary count, total embedded bytes, dangling/validator status.`, { label: 'r2b:attachments', phase: 'Build' }),
])

phase('Reconcile')
const reconcile = await agent(`${RULES}

TASK — RECONCILE round 2b (the single full build happens here).
1. \`bun build.ts\`, \`bun build.ts --answer-key\`, \`bun build.ts --embed-attachments\` (and confirm flags compose) — REFERENCE INTEGRITY 0 dangling / 0 type-violations (Binary urls now resolve).
2. \`bun compare/classify.ts\` baseline + against out-answerkey/ — report the new EXACT/TOLERATED/GAP ledgers and the delta (Practitioner gender/prefix/identifier now present; DocumentReference attachment populated). Confirm reconciliation.
3. \`bun tools/validate.ts\` Practitioner / Binary / DocumentReference — 0 errors.
4. Update docs: REFERENCE-INTEGRITY.md (Binary resolution), SHAPE-GAPS.md (provider demographics + attachment now recovered), NEW-RESOURCES.md if Binary is newly a type, and TODO.md — CHECK OFF #1 and #5 with what moved, update the Progress log, and list any remaining actionable items + the now-genuine unrecoverable floor.
Return: the new ledgers, provider-demographics + attachment coverage gained, dangling/validator status, and the remaining TODO backlog.`, { label: 'reconcile-2b', phase: 'Reconcile' })

return { build, reconcile }
