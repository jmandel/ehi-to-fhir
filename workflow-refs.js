export const meta = {
  name: 'ehi-fhir-reference-integrity',
  description: 'Drive dangling references to zero via root-cause fixes (consistent minting + referential closure), gate it in build.ts, and write a residual gap analysis',
  phases: [
    { title: 'Triage', detail: 'run refcheck, root-cause each dangling edge, plan fixes per file' },
    { title: 'Fix', detail: 'apply per-file fixes (mint-consistency / emit referent / drop unbackable); loop until clean' },
    { title: 'Finalize', detail: 'confirm count, add refcheck gate to build.ts, write REFERENCE-INTEGRITY.md' },
  ],
}

const ROOT = '/home/jmandel/hobby/my-ehi/ehi-fhir'
const MAX_ROUNDS = 4

const CONTEXT = `Project root (cd here): ${ROOT}. We mint SYNTHETIC FHIR ids (Epic's opaque ids aren't recoverable), so the invariant is NOT id-equality with Epic — it is INTERNAL referential integrity: every reference must resolve to a resource we emit, and point at a type the element allows. Tool: \`bun tools/refcheck.ts [--graph]\` (lists DANGLING references + TYPE VIOLATIONS, exit!=0 if any). Ids are minted ONLY via ../lib/ids (e.g. id.practitioner(SER_ID), id.encounter(CSN)); a reference built with any other key will dangle. Resources are emitted by src/<domain>.ts via ../lib/gen emit(); regenerate with \`bun src/<file>\` or \`bun build.ts\`.

Four classes for a reference defect:
  A) MINT-MISMATCH — the referrer built the reference with the wrong id convention/key, but the referent IS emitted under the correct id. FIX the REFERRER to use the shared ../lib/ids minter with the correct natural key. (e.g. MedicationRequest.recorder used prac-<login> instead of id.practitioner(<SER_ID>).)
  B) REFERENT-OMITTED-RECOVERABLE — the referent (Encounter/Organization/etc.) exists in the EHI but its OWNER generator didn't emit it (curated subset). FIX the OWNER generator to also emit it so the link resolves — prefer a full resource; a MINIMAL but real EHI-derived resource (referential-closure stub: id + required fields from the actual EHI row) is acceptable. Never fabricate; the entity must be real in the EHI.
  C) UNBACKABLE — the referent cannot be derived from the EHI, or the link is spurious. FIX the referrer to drop/omit that reference. Record it as residual.
  D) SPECIFICITY (the principle below) — a reference element that we OMITTED, or emitted as a "naked display" (a {display} with no resolvable reference / a hardcoded corporate-brand string), where the EHI lets us derive a MORE SPECIFIC real entity that we emit (or can emit). FIX by wiring a resolvable reference to that real entity, with its real name as display.

THE SPECIFICITY PRINCIPLE (apply wherever relevant, not just the named cases):
  Prefer the most specific REAL entity the EHI supports, emitted as a RESOLVABLE reference, over (a) omitting because it doesn't match the target's string, or (b) hardcoding the target's value (especially a corporate-brand display). Faithful + specific + resolvable beats "matches Epic's display." Do NOT chase the answer key's exact display strings; emit the truer, finer-grained referent from the EHI.
  Named cases (examples, NOT the whole list — the census below finds the rest):
   - Immunization.location: target is a bare {display:"UnityPoint Health"} (brand). Derive the administering site via IMMUNE.IMM_CSN → PAT_ENC.DEPARTMENT_ID → ref(Location, id.location(<DEPARTMENT_ID>), <dept name>) — e.g. loc-1700801002 "Assoc Physicians Internal Medicine" (more specific & resolvable than the brand).
   - DiagnosticReport.performer: should reference the real performing lab entity (e.g. "Associated Physicians Laboratory", loc-1700801005) rather than a dangling/brand org.

Always verify with queries (does the referent's natural key exist in the EHI?) before choosing A/B/C/D. STRICT: no fabrication; mint only via ../lib/ids; prefer preserving/strengthening the semantic link (A/B/D) over dropping (C).`

function triagePrompt(round) {
  return `${CONTEXT}

TASK — TRIAGE (round ${round}). Two parts:

PART 1 — DANGLING / TYPE (classes A/B/C). Run \`bun build.ts\` (regenerate out/ for a consistent snapshot), then \`bun tools/refcheck.ts --graph\`. For every dangling edge and type violation, assign class A/B/C with an EHI query as evidence.

PART 2 — SPECIFICITY CENSUS (class D) — this is how we ensure the principle applies EVERYWHERE, not just named cases. Build the worklist FROM THE TARGET, don't hand-pick: for each resource type, enumerate every reference-bearing element in fhir-target/<Type>.json (any object with .reference and/or .display: subject, encounter, performer, location, serviceProvider, custodian, requester, recorder, author, etc.). For each such element, inspect OUR out/<Type>.json and classify:
   - resolvable-ref (good: .reference resolves to an emitted resource) — no action;
   - naked-display (a .display / brand string with NO resolvable .reference, or a hardcoded value) — CANDIDATE;
   - omitted (target has the element, we don't) — CANDIDATE.
For each CANDIDATE, check whether the EHI supports a MORE SPECIFIC real referent we emit or can emit (query the join, e.g. via the encounter's DEPARTMENT_ID, the order's performing lab, etc.). If yes → class D fix (wire a resolvable ref to that real entity). If the only available value is an un-derivable brand with no finer EHI entity → leave as-is and record it as residual (deliberate). Apply the named cases (Immunization.location, DiagnosticReport.performer) plus everything else the census surfaces.

Assign each fix (A/B/C/D) to the SINGLE file that must change (referrer for A/C/D, owner generator for B). Group by file. Return danglingCount, typeViolations, a specificityCandidates count, and a plan: one entry per file with concrete instructions (which elements/edges, which class, exact fix + the EHI join to use). If nothing actionable remains, return an empty plan.`
}

function fixPrompt(planEntry, round) {
  return `${CONTEXT}

TASK — FIX (round ${round}) the file ${planEntry.file}. Apply ONLY these reference-integrity fixes (root-cause, not patches):
${JSON.stringify(planEntry, null, 2)}
Rules: mint via ../lib/ids only. Class A: switch to the correct shared minter/natural key. Class B: emit the referent from REAL EHI data (full or minimal-real stub) — never fabricate. Class C: drop the link, note as residual. Class D (specificity principle): wire a RESOLVABLE reference to the more-specific real EHI entity (with its real name as display), replacing the omission/naked-display/brand — derive via the join the triage named; never hardcode a brand. After editing, run \`bun src/${planEntry.file?.replace(/^src\//, '') ?? '<your file>'}\` (or \`bun build.ts\` if cross-cutting) then \`bun tools/refcheck.ts\` to confirm edges resolve and no new dangling. Edit ONLY ${planEntry.file}. Return the edges/elements you fixed (by class) and any dropped (class C) with reason.`
}

const TRIAGE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['round', 'danglingCount', 'typeViolations', 'plan'],
  properties: {
    round: { type: 'integer' }, danglingCount: { type: 'integer' }, typeViolations: { type: 'integer' },
    specificityCandidates: { type: 'integer' },
    plan: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['file', 'instructions'], properties: {
      file: { type: 'string' }, instructions: { type: 'string' },
      edges: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['edge', 'class'], properties: { edge: { type: 'string' }, class: { type: 'string', enum: ['A', 'B', 'C', 'D'] } } } },
    } } },
    residualNote: { type: 'string' },
  },
}
const FIX_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['file', 'fixed', 'dropped'],
  properties: {
    file: { type: 'string' },
    fixed: { type: 'array', items: { type: 'string' } },
    dropped: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['edge', 'reason'], properties: { edge: { type: 'string' }, reason: { type: 'string' } } } },
    danglingAfter: { type: 'integer' },
  },
}

let last = null
const history = []
for (let r = 1; r <= MAX_ROUNDS; r++) {
  const tri = await agent(triagePrompt(r), { label: `triage#${r}`, phase: 'Triage', schema: TRIAGE_SCHEMA })
  last = tri
  history.push({ round: r, dangling: tri?.danglingCount, typeViol: tri?.typeViolations, specificity: tri?.specificityCandidates })
  log(`round ${r}: dangling=${tri?.danglingCount} typeViolations=${tri?.typeViolations} specificityCandidates=${tri?.specificityCandidates}`)
  const plan = tri?.plan ?? []
  // "done" = nothing actionable left (covers dangling, type-violations, AND specificity class-D)
  if (!plan.length) { log(`✓ no actionable plan at round ${r} (dangling=${tri?.danglingCount}, typeViol=${tri?.typeViolations}, specificity=${tri?.specificityCandidates})`); break }
  if (r === MAX_ROUNDS) { log(`reached max rounds; residual will be documented`); break }
  await parallel(plan.map((p) => () => agent(fixPrompt(p, r), { label: `fix:${p.file}#${r}`, phase: 'Fix', schema: FIX_SCHEMA })))
}

phase('Finalize')
const fin = await agent(`${CONTEXT}

TASK — FINALIZE reference integrity + lock in the specificity principle so it can't regress.
1. Run \`bun build.ts\` then \`bun tools/refcheck.ts --graph\`; record final dangling + type-violation counts and the reference-graph histogram.
2. Extend tools/refcheck.ts with a NAKED-DISPLAY check: report every reference element that has a \`.display\` (or is a brand-looking string) but NO resolvable \`.reference\` — these are the candidates the specificity principle targets. Group by resourceType.path with counts. (This is what makes the principle ENFORCEABLE everywhere going forward, not just today.)
3. Add refcheck as a STANDING GATE in build.ts: after it assembles out/bundle.json, spawn \`bun tools/refcheck.ts\` and print a loud final line — "REFERENCE INTEGRITY: OK" or "… N dangling / M type-violations / K naked-display". Keep it non-fatal (don't change the exit code).
4. Write REFERENCE-INTEGRITY.md at the project root with:
   - the strategy (synthetic ids → internal-resolvability invariant, not id-equality);
   - the SPECIFICITY PRINCIPLE stated verbatim, and WHY the worklist is derived from the target's reference census (so it applies everywhere relevant, not just named cases);
   - before/after dangling counts and the per-class fixes applied (A mint-consistency, B referent-emission, C drops, D specificity);
   - a COVERAGE TABLE: every reference-bearing element (resourceType.path) seen in the target, classified as resolvable-ref / fixed-to-specific (class D) / deliberate-brand-residual / dropped — so a reader can SEE the principle was applied across the board;
   - a RESIDUAL section: every still-dangling, dropped, or deliberately-left-as-brand element, with the reason the EHI offers nothing finer.
Round history: ${JSON.stringify(history)}; last triage residual: ${JSON.stringify(last?.residualNote ?? '')}.
Return: final dangling count, type-violations, naked-display count, class-D fixes applied, residual count, and confirmation the build gate (incl. naked-display) is wired.`, { label: 'finalize-refs', phase: 'Finalize' })

return { history, final: fin }
