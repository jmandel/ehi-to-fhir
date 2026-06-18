export const meta = {
  name: 'ehi-fhir-consolidation-plan',
  description: 'Read-only DRY survey: find abstractable/duplicated core logic across the generators, propose a central lib API, map every call site, flag intentional-divergence do-not-merge cases, and sequence the refactor with the portability fixes. Produces CONSOLIDATION-PLAN.md (no edits).',
  phases: [
    { title: 'Survey', detail: '6 agents survey all src/ + lib/ by concern for duplication + abstraction candidates' },
    { title: 'Plan', detail: 'synthesize into a reviewed central-lib API + call-site map + sequencing; write CONSOLIDATION-PLAN.md' },
  ],
}
const ROOT = '/home/jmandel/hobby/my-ehi/ehi-fhir'

const FRAME = `GOAL: make the ${ROOT} generators DRY by pulling genuinely-shared logic into central lib modules — WHILE enabling the portability fixes (see AUDIT-PORTABILITY.md: derive PATIENT_PAT_ID, centralize the .283 instance OID, centralize timezone, add table guards). This is a READ-ONLY survey that produces a PLAN; make NO edits.

For your concern, across ALL src/*.ts (and lib/*), find:
- TRUE DUPLICATION: the same (or near-same) function/logic copy-pasted in 2+ files — the prime consolidation targets. Cite EVERY copy (file:line) and identify the CANONICAL/BEST variant to keep.
- ABSTRACTABLE INLINE PATTERNS: repeated inline idioms (not yet functions) that deserve a shared helper.
- INTENTIONAL DIVERGENCE (do-NOT-merge): logic that LOOKS duplicated but is meaningfully different on purpose — consolidating would lose correctness. Flag these explicitly with why-keep (e.g. lab.ts derives the UTC offset per-order from the local/UTC column pair — the BETTER approach — vs others' fixed Central offset; a naive merge would regress). When proposing a central API, it must ACCOMMODATE the best variant, not flatten to the weakest.

Propose a concrete central API: module name, exported function signatures, a one-line purpose each, and which existing implementation is the canonical seed. Estimate the number of call sites that would change and the risk (low = pure move; med = behavior-unifying; high = touches output values). Prefer extending existing lib files (db.ts/ids.ts/gen.ts) over new ones unless a new module is clearly warranted. Read the real code; cite real lines; don't guess.`

const SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    proposedModules: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          module: { type: "string", description: "e.g. lib/time.ts or 'extend lib/ids.ts'" },
          api: {
            type: "array",
            items: {
              type: "object", additionalProperties: false,
              properties: { name: { type: "string" }, signature: { type: "string" }, purpose: { type: "string" }, canonicalSeed: { type: "string", description: "file:line of the best existing impl to lift" } },
              required: ["name", "signature", "purpose", "canonicalSeed"],
            },
          },
          duplicates: { type: "array", items: { type: "object", additionalProperties: false, properties: { file: { type: "string" }, line: { type: "string" }, what: { type: "string" } }, required: ["file", "line", "what"] } },
          callSiteCount: { type: "string" },
          risk: { type: "string", enum: ["low", "med", "high"] },
        },
        required: ["module", "api", "duplicates", "callSiteCount", "risk"],
      },
    },
    doNotMerge: { type: "array", items: { type: "object", additionalProperties: false, properties: { file: { type: "string" }, line: { type: "string" }, whyKeep: { type: "string" } }, required: ["file", "line", "whyKeep"] } },
    areaSummary: { type: "string" },
  },
  required: ["proposedModules", "doNotMerge", "areaSummary"],
}

phase('Survey')
const areas = [
  ["time", "Datetime/timezone logic. The ~6 hand-rolled Central/DST routines (encounter.ts chicagoToISO/chicagoOffsetHours, obs-vitals localToUtcInstant, obs-survey centralToUTC/isUSDST, obs-social centralMidnightToUtc/isCentralDST, communication chicagoToISO, allergy fixed -5) + lib/db.ts parseEpicDateTime + date-only emitters (careplan/coverageeligibility/chargeitem/paymentrecon). Propose lib/time.ts. CRITICAL do-not-merge: lab.ts derives the offset per-order from the local↔*_UTC_DTTM pair (the BEST approach) — the central API must support 'prefer explicit UTC sibling column, else configured EHI_TZ'. Note the allergy.ts Eastern-vs-Central inconsistency as a bug to fix on consolidation."],
  ["systems/OID", "Identifier/code SYSTEM construction. The .283 instance-OID literals (49) and the per-file SYS_*/OID_* constants — find every DUPLICATED system (SYS_CSN/SYS_ENC across encounter/condition/obs-survey/documentreference; SYS_PLACER across lab/servicerequest; the patient identifier OIDs; etc.). Propose centralizing into lib/ids.ts: EPIC_INSTANCE_OID + epicOid(suffix) + a named registry of the recurring systems (CSN, SER, ENC, PLACER, ...). Flag systems that must stay byte-identical across basedOn-linked resources (lab↔servicerequest, encounter↔condition). Distinguish Epic-instance OIDs from standard system URIs (LOINC/SNOMED/etc — leave those as shared standard constants)."],
  ["provider/party", "Provider/party resolution + reference minting. EMP↔SER and USER↔PROV name-match performer mapping copied across obs-survey/obs-vitals/immunization/careplan/practitioner (~5 copies); SENTINELS + CARE_PROV_COLUMNS duplicated in communication.ts & practitioner.ts; practitionerRef/orgRef patterns; the lab pseudo-provider suppression (3724611 / ' LAB '). Propose lib/providers.ts (resolvePractitionerBySerOrEmp, isNonHumanResource, sentinel predicate, etc.). Do-not-merge: note where a name-match is deliberately conservative (false-absence) vs a real id linkage."],
  ["query/table-safety", "DB access + table/column guarding. lib/db.ts q/q1/tableHasRows/columnsOf are central, but most generators read optional tables WITHOUT guarding (audit: meds/labs/obs-vitals/obs-survey/encounter/condition hard-crash on a missing table; obs-smartdata.ts is the model that guards). Propose a shared guarded-read helper (e.g. qIf(table, sql, ...args) → [] when table absent, or a columns-aware select). Inventory the unguarded optional-table reads. Also any repeated PRAGMA/schema-introspection idioms."],
  ["value/format/sql-shape", "Small value + row-shape helpers. nn()/clean()/money()/slug() and the *_C_NAME→standard-code MAP pattern (each domain hand-rolls a lookup map + never-guess fallthrough); single-row access idioms ([0] / .find with single-row Epic invariants); latest-non-null-per-column (obs-social) vs latest-whole-row; the 'coalesce EXTERNAL_NAME ?? DEPARTMENT_NAME' patterns. Find duplicated copies of nn/money/clean across files. Propose lib/fmt.ts (or extend gen.ts) + a tiny enumMap(value, map) helper. Do-not-merge: maps with domain-specific semantics stay per-domain (only the LOOKUP mechanism is shared)."],
  ["codeableconcept/emit", "CodeableConcept + emit shaping. The coding/category/text CodeableConcept builders repeated per domain (e.g. {coding:[{system,code,display}],text}); category[] construction; identifier[] assembly; the clean()/emit() usage. Propose lib/cc.ts (cc(system,code,display,text?), codeableConcept helpers, identifier(system,value,...) builder). Survey how each generator builds codings to find the common shape; flag where a domain needs a bespoke shape (do-not-merge)."],
]
const surveys = await parallel(areas.map(([label, scope]) =>
  () => agent(`Project root (cd here): ${ROOT}. READ-ONLY DRY survey — make NO edits.

${FRAME}

YOUR CONCERN: ${scope}

Return proposedModules (with concrete API signatures + canonicalSeed file:line), the duplicates inventory (every copy), doNotMerge flags, and a one-paragraph areaSummary.`,
    { label: `dry:${label}`, phase: 'Survey', schema: SCHEMA })
))

phase('Plan')
const modules = surveys.filter(Boolean).flatMap((s, i) => (s.proposedModules || []).map((m) => ({ area: areas[i][0], ...m })))
const doNotMerge = surveys.filter(Boolean).flatMap((s) => s.doNotMerge || [])
const summaries = surveys.filter(Boolean).map((s, i) => `**${areas[i][0]}**: ${s.areaSummary}`).join("\n\n")
const plan = await agent(`Project root (cd here): ${ROOT}. Refactor architect. Below: ${modules.length} proposed central-lib modules + ${doNotMerge.length} do-not-merge flags from 6 concern surveys (JSON) + summaries. Also read AUDIT-PORTABILITY.md (the portability fix order) so the consolidation plan SUBSUMES the centralization fixes there.

PROPOSED MODULES JSON:
${JSON.stringify(modules, null, 1)}

DO-NOT-MERGE JSON:
${JSON.stringify(doNotMerge, null, 1)}

SUMMARIES:
${summaries}

TASK — write ${ROOT}/CONSOLIDATION-PLAN.md, the reviewed blueprint:
1. **The target lib architecture**: the final set of central modules (merge/dedupe the proposals; prefer extending lib/db.ts, lib/ids.ts, lib/gen.ts; add new lib/*.ts only when clearly warranted), each with its exported API (name · signature · purpose · canonical seed file:line).
2. **Consolidation table**: for each helper — how many call sites change, the files touched, risk (low/med/high), and whether it ALSO closes a portability fix (cross-reference AUDIT-PORTABILITY.md items: PATIENT_PAT_ID, .283 OID, timezone, table guards).
3. **DO-NOT-MERGE register**: the intentional divergences to preserve (esp. lab.ts per-order UTC derivation; conservative name-match false-absence) — the API must accommodate the BEST variant; say how.
4. **Sequenced execution plan**: ordered steps, each a self-contained safe refactor with its verification (build still emits byte-identical output for the CURRENT patient — a pure-move refactor must not change output; behavior-unifying steps like timezone call out the intended diffs). Group steps that can land together; note which unblock portability levels (same-org vs different-org).
5. **Risk + regression strategy**: how we prove each step is safe (the existing classify/refcheck/validate/status tools as the regression harness; current-patient output should stay identical for pure moves).
Be concrete and cite real file:line. Do not fabricate; use the surveyed findings (Read files to confirm). Return the target-architecture summary text.`,
  { label: 'plan', phase: 'Plan' })

return { surveys, plan }
