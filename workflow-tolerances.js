export const meta = {
  name: 'ehi-fhir-comparison-tolerances',
  description: 'Author + adversarially review a narrow tolerance registry so the target comparison classifies every delta as exact / tolerated / real-gap (no blind field ignores, no drift, full attribution)',
  phases: [
    { title: 'Survey', detail: 'run a tolerance-aware compare in propose-mode; cluster every non-exact delta by kind/path' },
    { title: 'Author', detail: 'draft candidate tolerance rules with narrow verifying predicates from the real deltas' },
    { title: 'Review', detail: 'adversarially try to break each predicate; approve only if it rejects same-shaped regressions' },
    { title: 'Integrate', detail: 'apply approved rules; reconciled 3-way ledger + TOLERANCES.md' },
  ],
}

const ROOT = '/home/jmandel/hobby/my-ehi/ehi-fhir'

const CONTEXT = `Project root (cd here): ${ROOT}. We deliberately diverge from Epic's reference FHIR (fhir-target/) in justified ways — SYNTHETIC ids (so refs are isomorphic, not identical), MORE-SPECIFIC real referents (department vs corporate brand), truthful display casing/nicknames (Joshua vs Josh), and valid structural variants. A naive "match the target exactly" comparison miscounts these as gaps. We need a TOLERANCE REGISTRY so compare classifies every target element as EXACT / TOLERATED / GAP — with NO blind field ignores (that causes drift + misattributed deltas).

INVARIANTS (non-negotiable):
- Reconciliation: exact + tolerated + gap = total target elements. Nothing silently dropped.
- Fail-safe: a delta is TOLERATED only if it matches an APPROVED rule whose predicate VERIFIES the divergence is the justified kind; otherwise it is a GAP.
- Predicates are NARROW + VERIFYING, never path-blanket ignores: they must still flag a real regression of the same shape (a ref to a DIFFERENT entity, a CHANGED value) as a GAP.
- Full attribution: every tolerated delta records its rule id + the evidence the predicate matched.
- coding-gap stays its OWN gap bucket (the [coding]/[data] register) — tolerated-as-known, never "match".

Tolerance kinds — TWO TIERS:
  MECHANICAL (a predicate verifies the divergence from data, auto-applies):
   · isomorphic-ref (same entity by natural key, id differs)
   · specificity-ref (our referent is the same-or-NARROWER real entity, VERIFIABLE in the EHI org/location tree via a parent/child join)
   · cosmetic-display (equal after normalize on a display field)
   · structural-variant (same datum, other valid FHIR shape)
  BLESSED (judgment, when NO mechanical check is possible — e.g. "Assoc Physicians Internal Medicine" vs corporate "UnityPoint Health" with no joinable parent column to climb):
   · blessed-value — an EXPLICIT per-case attestation that a specific divergence is acceptable, made by an LLM agent (with recorded reasoning) or escalated to a human. CRITICAL SAFETY: a blessing PINS BOTH the exact target value AND our exact value at a specific resourceType.path. It tolerates ONLY that exact (targetValue, ourValue) pair — so if OUR value later drifts to anything else, or the target changes, it no longer matches and resurfaces as a GAP (the pin is the anti-drift guarantee). Never a field-level ignore; always a value-pair allow-list entry with rationale + blessedBy + date, and a flag for the judgment-heavy ones recommending HUMAN sign-off.
  Rule of escalation: prefer MECHANICAL; only fall back to BLESSED when the tree/data cannot prove the equivalence. A blessing is still reviewed and recorded — it is an attested exception, not a blanket pass.

Existing tools: compare.ts (path/shape profiler), lib/profile.ts, tools/refcheck.ts, crosswalk/. The reference natural-key idea: our ids encode the EHI key (enc-<CSN>, prac-<SER>), target refs carry .identifier/.display.`

const SURVEY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['deltaClusters', 'totalDeltas'],
  properties: {
    totalDeltas: { type: 'integer' },
    deltaClusters: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'proposedKind', 'count', 'example'], properties: {
      path: { type: 'string' }, proposedKind: { type: 'string', enum: ['isomorphic-ref', 'specificity-ref', 'cosmetic-display', 'structural-variant', 'coding-gap', 'real-gap', 'unsure'] }, count: { type: 'integer' }, example: { type: 'string' } } } },
  },
}
const RULE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['rules'],
  properties: { rules: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'kind', 'scope', 'rationale', 'coversDeltas'], properties: {
    id: { type: 'string' },
    kind: { type: 'string', enum: ['isomorphic-ref', 'specificity-ref', 'cosmetic-display', 'structural-variant', 'blessed-value'] },
    scope: { type: 'string' },
    predicate: { type: 'string', description: 'MECHANICAL rules: the verifying test. blessed-value: leave empty (the pin below is the test).' },
    rationale: { type: 'string' }, coversDeltas: { type: 'integer' },
    // blessed-value only — pin BOTH exact values so any future drift resurfaces as a GAP:
    pinTargetValue: { type: 'string' }, pinOurValue: { type: 'string' },
    blessedBy: { type: 'string', description: 'e.g. "agent:<label>" or "human:<who>"' },
    recommendHumanSignoff: { type: 'boolean' },
  } } } },
}
const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['ruleId', 'verdict', 'reason'],
  properties: { ruleId: { type: 'string' }, verdict: { type: 'string', enum: ['approve', 'narrow', 'reject'] }, reason: { type: 'string' }, brokenBy: { type: 'string', description: 'a regression the predicate would wrongly tolerate, if any' }, narrowedPredicate: { type: 'string' } },
}

phase('Survey')
const survey = await agent(`${CONTEXT}

TASK — SURVEY the real divergences. Build (or extend compare.ts into) a PROPOSE-MODE comparison that aligns our out/ resources to fhir-target/ by NATURAL KEY (not FHIR id) per type, then for every element that isn't byte-identical, records the delta and a FIRST-GUESS kind (isomorphic-ref / specificity-ref / cosmetic-display / structural-variant / coding-gap / real-gap / unsure). Cluster by resourceType.path with counts + one concrete example each. Write compare/DELTAS.md. Return the clusters + total. Do NOT permit anything yet — this is observation only.`, { label: 'survey', phase: 'Survey', schema: SURVEY_SCHEMA })

phase('Author')
const authored = await agent(`${CONTEXT}

TASK — AUTHOR candidate tolerance rules from the surveyed deltas (NOT from imagination — every rule must cite real clusters):
${JSON.stringify(survey, null, 2)}
For each justified divergence cluster, FIRST try a MECHANICAL rule (isomorphic-ref / specificity-ref / cosmetic-display / structural-variant): a NARROW VERIFYING predicate (exactly how to confirm THIS divergence is the justified kind from the data AND how a same-shaped regression would still fail it). Use specificity-ref ONLY when you can name the EHI parent/child join that proves same-or-narrower.
When NO mechanical check exists (e.g. department vs corporate brand with no joinable parent), fall back to a "blessed-value" attestation: pin the EXACT pinTargetValue and pinOurValue at that scope, give the rationale, set blessedBy:"agent:author", and set recommendHumanSignoff:true for any high-stakes judgment (a substitution a reasonable reviewer might dispute). A blessing tolerates ONLY that exact value pair — never the whole field.
Leave real-gap / coding-gap clusters as gaps (no rule). Write the candidates to compare/tolerances.proposed.json. Return the rules.`, { label: 'author', phase: 'Author', schema: RULE_SCHEMA })

phase('Review')
const rules = (authored && authored.rules) || []
const reviews = await parallel(rules.map((rule) => () =>
  agent(`${CONTEXT}

TASK — ADVERSARIAL REVIEW of ONE candidate tolerance rule. Rule:
${JSON.stringify(rule, null, 2)}
If kind is MECHANICAL (isomorphic-ref/specificity-ref/cosmetic-display/structural-variant): try to BREAK the predicate — construct a realistic regression (a ref silently re-pointed to a DIFFERENT entity, a value quietly changed, a wrong code) it would WRONGLY tolerate. If you can → "reject" (name the masked regression) or "narrow" (give a tighter predicate). For specificity-ref, confirm the parent/child join REALLY proves same-or-narrower (not a coincidental match). Approve only if it provably rejects every same-shaped regression.
If kind is blessed-value: there is no predicate — verify instead that (a) it PINS exact pinTargetValue AND pinOurValue (so any future drift to a third value resurfaces as a GAP — if it's not pinned to both, "narrow" it to pin them); (b) it's scoped to a specific path, not a whole field; (c) the rationale is sound and the substitution is genuinely acceptable/better (judge it). If the call is debatable or high-stakes, "approve" but ensure recommendHumanSignoff=true (a human must co-sign before it's trusted); if the rationale doesn't hold, "reject".
Verify against real data with bun lib/q.ts / compare where useful. Return the verdict.`, { label: `review:${rule.id}`, phase: 'Review', schema: REVIEW_SCHEMA })
))

phase('Integrate')
const integrate = await agent(`${CONTEXT}

TASK — INTEGRATE only the APPROVED rules.
Candidate rules: ${JSON.stringify(rules)}
Reviews: ${JSON.stringify(reviews.filter(Boolean))}
1. Build compare/tolerances.ts = the registry of APPROVED rules ONLY (apply any "narrow" verdict's tightened predicate/pin; drop "reject"). Each MECHANICAL entry: id, kind, scope, predicate, rationale, approval {status, reviewer-note, the regression it provably rejects}, hit-cap. Each BLESSED-VALUE entry: id, kind:"blessed-value", scope, pinTargetValue, pinOurValue, rationale, blessedBy, approval, and signoff:"agent" or "human-required" (carry recommendHumanSignoff through — these stay status:"provisional" until a human co-signs; provisional blessings ARE applied but clearly marked).
2. Make compare tolerance-aware: classify every target element as EXACT / TOLERATED(ruleId, evidence) / GAP(class) using ONLY approved rules. A blessed-value rule tolerates ONLY when BOTH the target value and OUR value equal its pinned pair (any other value → GAP). Assert reconciliation (exact+tolerated+gap = total); print the 3-way ledger + per-rule hit counts; FLAG any rule over its hit-cap, and list provisional (human-signoff-pending) blessings separately.
3. Write TOLERANCES.md: every approved MECHANICAL rule (kind, scope, predicate, regression rejected, hit count) and every BLESSED-VALUE entry (scope, pinned pair, rationale, blessedBy) — with a dedicated "⚠ HUMAN SIGN-OFF REQUIRED" section listing the provisional blessings a person must confirm. Headline: total target elements → exact / tolerated(by rule, split mechanical vs blessed) / real-gap, confirming the residual GAP set is now ONLY true gaps and that NOTHING was blindly ignored (every tolerated delta cites its rule + evidence; every blessing pins exact values).
Return: approved mechanical count, blessed count (+ how many need human signoff), the 3-way ledger totals, any over-cap rules, and confirmation reconciliation holds.`, { label: 'integrate', phase: 'Integrate' })

return { survey, authoredRules: rules.length, reviews: reviews.filter(Boolean), integration: integrate }
