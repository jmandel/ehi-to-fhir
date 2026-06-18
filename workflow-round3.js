export const meta = {
  name: 'ehi-fhir-round3-movables-and-floor-proof',
  description: 'Do the still-movable gap items (DocRefs, cosmetic-display + minute-precision + Encounter.class tolerances) AND prove the no-anchor coding floor; reconcile honestly',
  phases: [
    { title: 'Generate', detail: 'emit the ~23 DocumentReferences we under-surface from HNO_INFO' },
    { title: 'Move+Prove', detail: 'cosmetic/minute/class tolerances (reviewed) ∥ audit whether residual codings are truly no-anchor' },
    { title: 'Reconcile', detail: 'final ledger + a PROVEN floor table (every remaining class: stays-with-proof vs moved)' },
  ],
}

const ROOT = '/home/jmandel/hobby/my-ehi/ehi-fhir'
const RULES = `Project root (cd here): ${ROOT}. Rules: derive from EHI; never fabricate; mint via ../lib/ids; gate stays 0 dangling / 0 type-violations; tolerances NARROW + VERIFYING (still GAP a same-shaped regression) + injection-self-checked; reconciliation must hold.`

phase('Generate')
const generate = await agent(`${RULES}

TASK — emit the DocumentReferences we currently UNDER-surface. The deep-dive found HNO_INFO has ~188 note rows but we emit ~39 DocumentReferences; the target has 51. Audit src/documentreference.ts's note-selection vs HNO_INFO and emit the additional real notes that belong (real EHI notes with bodies in Rich Text/), so the count moves toward the target's 51 — WITHOUT fabricating (only notes that genuinely exist + are the right type/status). Keep refs resolving (author/encounter/custodian) and Binary attachments working under --embed-attachments. Verify: \`bun src/documentreference.ts\`, \`bun build.ts\`, \`bun tools/refcheck.ts\` (0 dangling), \`bun tools/validate.ts DocumentReference\` (0 NEW errors). Edit ONLY src/documentreference.ts (+ src/binary.ts if attachment wiring needs it). Report: DocRef count before→after, and how many target DocRefs are now matched.`, { label: 'gen-docrefs', phase: 'Generate' })

// ---- Crosswalk extension: the anchored codings round-2a's all-codings pass MISSED ----
phase('Crosswalk')
const crosswalk = await agent(`${RULES}

TASK — extend the "all-codings" crosswalk to the EHI-ANCHORED paths round 2a skipped (it only covered DiagnosticReport.code / Medication.code / DocumentReference.type). The answer-key still GAPs ~1062 code.coding leaves that ARE anchored:
- **Condition.code (114)** — the IMO coding \`urn:oid:2.16.840.1.113883.3.247.1.1\` (+ any other non-standard codings the reference carries) is anchored to PROBLEM_LIST.DX_ID. Capture it (system_class=epic-instance-oid/imo) like the standard ICD/SNOMED rows.
- **Observation flowsheet codings (the bulk of the 948)** — \`observation-flowsheet-id\` is anchored to FLO_MEAS_ID (IN the EHI); capture the reference's flowsheet-id coding (and any other anchorable Epic-instance coding) for vitals/survey/social Observations, keyed to FLO_MEAS_ID.
EXCLUDE the genuinely non-anchorable ones (the \`urn:oid:…246.537.6.96\` LOINC-alias and the ENCRYPTED one-way Epic FHIR id like \`tOmaSI-nbFaz…\` — these are not reversible to any EHI local code; document them as floor, do NOT fabricate).
Wire them through tools/apply-answer-key.ts (existing anchor bridges + add the flowsheet/DX_ID anchor if needed), additive/idempotent. Verify: \`bun build.ts --answer-key\` then \`bun compare/classify.ts --out=out-answerkey\` — the Condition + Observation code.coding gap should drop sharply. Edit ONLY crosswalk/* and tools/apply-answer-key.ts. Report rows added + the answer-key coding-gap before→after + what you confirmed as genuine floor (the alias + encrypted ids).`, { label: 'crosswalk-anchored', phase: 'Crosswalk' })

// ---- the three movable tolerance families (reviewed) ----
phase('Tolerances')
const tolerances = await agent(`${RULES}

TASK — add three NARROW tolerance families to compare/tolerances.ts (+ classify.ts if needed), each injection-self-checked (import the real verify(), inject a same-shaped regression, confirm it GAPs; confirm the genuine case tolerates):
A. COSMETIC-DISPLAY for masked names — performer[].display / author[].display / authenticator[].display / valueReference.display / encounter.display where the REFERENCE is ALREADY iso-tolerated (same entity) but the display differs only by Epic's privacy-masking ("Mary S") vs our fuller EHI name ("SMITH, MARY B") or the Epic enc-type label. Tolerate ONLY when the sibling reference resolves to the same natural-key entity; GAP a display on a different entity. (~250 leaves)
B. MINUTE-PRECISION for instants — issued / date / *.valueDateTime / period.* where target and ours are byte-equal after truncating to the minute and differ only in seconds (the export rounds *_DTTM to the minute). Tolerate ONLY same-to-the-minute; GAP a different minute/day. (~140 leaves)
C. ENCOUNTER.CLASS structural-variant — class.system/code/display where ours is the standard v3-ActCode (AMB) and target is the Epic-local class ("13") for the SAME class concept. Tolerate ONLY when our derived class is the correct standard mapping of the encounter's ADT class; GAP a wrong class. (~96 leaves)
Run \`bun compare/classify.ts\`; report per-rule hits + the new ledger. Edit ONLY compare/*.`, { label: 'tolerances-3', phase: 'Tolerances' })

phase('Reconcile')
const reconcile = await agent(`${RULES}

TASK — RECONCILE round 3 HONESTLY.
1. \`bun build.ts\`, \`bun build.ts --answer-key\` — gate 0/0; \`bun compare/classify.ts\` baseline AND \`--out=out-answerkey\` (or OUT_DIR) — new EXACT/TOLERATED/GAP ledgers + delta vs round-2c (baseline 6544/771/7015; answer-key 11304/920/3957). Reconciliation must hold.
2. Build a PROVEN-FLOOR TABLE: for EVERY remaining GAP cluster (by class+path), state STAYS (with the one-line proof — no anchor / not byte-reproducible / precision-absent / export-config) or MOVED-THIS-ROUND or STILL-MOVABLE (named next action). Pull the no-anchor verdicts from compare/CODING-FLOOR-AUDIT.md. The point: no cluster may be called "floor" without its proof; anything not proven is labeled STILL-MOVABLE, not floor.
3. Update SHAPE-GAPS.md, TODO.md (progress log round 3; check off the movables done; refresh backlog with any STILL-MOVABLE found), and write/refresh a concise "Residual ledger" section.
Return: the new ledgers, how many leaves moved GAP→EXACT/TOLERATED this round, the proven-floor total, and the honest STILL-MOVABLE remainder (so we never again call the floor done without proof).`, { label: 'reconcile-3', phase: 'Reconcile' })

return { generate, moveProve, reconcile }
