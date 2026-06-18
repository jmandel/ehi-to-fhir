export const meta = {
  name: 'ehi-fhir-round4-movables',
  description: 'Drive down the 906 STILL-MOVABLE answer-key gaps: med dosage/form/course, us-core category, condition enc-dx bridge + linkage, specimen/immunization codings, cosmetic-case + attachment iso-url tolerances; reconcile honestly',
  phases: [
    { title: 'Workers', detail: '7 agents on disjoint files: med, obs-category, condition, immunization, docref, crosswalk+bridge, tolerances' },
    { title: 'Reconcile', detail: 'full build ±answer-key ±embed; gates; classify; floor-audit; docs/TODO' },
  ],
}

const ROOT = '/home/jmandel/hobby/my-ehi/ehi-fhir'
const RULES = `Project root (cd here): ${ROOT}. Rules: derive ONLY from the EHI (or a STANDARD value set that FHIR/US-Core actually binds — never an Epic-proprietary code we can't reverse); NEVER fabricate a code/value/display the export doesn't support ("a blank beats an invention"); mint refs via ../lib/ids by natural key. Do NOT run full \`bun build.ts\` in your phase (the reconcile phase owns the single full build) — VERIFY with your OWN generator only (\`bun src/<file>\`) or a targeted classify. Edit ONLY the files your task names so the 7 parallel workers never collide.`

phase('Workers')
const workers = await parallel([
  // 1 — MedicationRequest dosage + Medication form (the largest untouched movable domain, ~250 leaves)
  () => agent(`${RULES}

TASK — recover MedicationRequest dosage + Medication form from ORDER_MED (EHI-present; currently null).
The answer-key ledger shows these GAP with ourVal=null though the source is in the export:
- **doseAndRate.doseQuantity** (target e.g. value 1, unit "capsule", system http://unitsofmeasure.org, code "{capsule}"): from ORDER_MED discrete-dose columns (HV_DISCRETE_DOSE / DISCRETE_DOSE / HV_DOSE_UNIT_C_NAME, or DOSE/DOSE_UNIT_C_NAME — inspect which are populated for THIS export). Emit value+unit always; add UCUM system/code ONLY for real UCUM units (mg→"mg", mL→"mL"); for a non-UCUM dose form like "capsule" emit unit text + UCUM annotation code "{capsule}" exactly as FHIR allows (curly-brace annotation is valid UCUM, not fabrication).
- **dosageInstruction.route.text** (Oral/Intramuscular) from ORDER_MED.MED_ROUTE_C_NAME (route SNOMED coding is handled by the crosswalk worker — do NOT add a fabricated SNOMED here, text only).
- **courseOfTherapyType** — STANDARD value set http://terminology.hl7.org/CodeSystem/medicationrequest-course-of-therapy ("acute" = Short course (acute) therapy / "continuous"). Derive from the order's PRN/continuing/one-time class in ORDER_MED (e.g. HV_DISCR_FREQ_ID / a PRN flag / order class) — emit the standard code+display only when the EHI class unambiguously maps; else omit.
- **Medication.form** (target "Cap"): from ORDER_MED form column (e.g. MED_FORM / a form C_NAME) or the MEDICATION master if present. Emit form.text from the EHI label; add the Epic form coding only if a real code column exists (else text only).
Verify: \`bun src/medication.ts\` then spot-check out/Medication*.json + out/MedicationRequest.json for the new fields; run \`EXCLUDE_SMARTDATA=1 bun compare/classify.ts\` and confirm Medication/MedicationRequest GAP drops. Edit ONLY src/medication.ts. Report fields filled + per-path gap before→after. If a named column is NOT populated in this export, say so (proof: the GROUP BY) and emit nothing rather than guess.`, { label: 'r4:medication', phase: 'Workers' }),

  // 2 — Observation US-Core category overlay (~123)
  () => agent(`${RULES}

TASK — add the US-Core Observation category overlay the target carries (~123 leaves, ourVal=null).
Target adds codings in system http://hl7.org/fhir/us/core/CodeSystem/us-core-category with codes like "disability-status", "functional-status", "sdoh" (social-determinants) ON survey/social Observations, IN ADDITION to the base http://terminology.hl7.org/CodeSystem/observation-category code we already emit. These are STANDARD US-Core codes, assigned by the survey instrument / flowsheet group — derivable, not Epic-proprietary.
1. Determine, per survey/social Observation, which us-core-category applies from the instrument/topic already in the generator (e.g. a disability/function screening → functional-status or disability-status; a social-determinant screen → sdoh; smoking/alcohol/drug social-hx → the category the target uses). Map ONLY where the instrument identity makes the US-Core category unambiguous; do NOT blanket-assign.
2. Append the us-core-category coding to category[] (additive; keep the existing base category coding).
Verify with \`bun src/obs-survey.ts\` and \`bun src/obs-social.ts\` + \`EXCLUDE_SMARTDATA=1 bun compare/classify.ts\` (Observation category gap drops; no new mis-assignment — check a few against fhir-target/). Edit ONLY src/obs-survey.ts and src/obs-social.ts. Report categories assigned by code + gap before→after. If an instrument's US-Core category is NOT determinable from the EHI, leave it and report which.`, { label: 'r4:obs-category', phase: 'Workers' }),

  // 3 — Condition→Encounter linkage (~25 wrong CSN) + verify enc-dx
  () => agent(`${RULES}

TASK — fix Condition.encounter linkage. The answer-key ledger shows Condition.encounter.identifier.value target=1169847546 but ourVal=1098684634 (~25 leaves) — our encounter-diagnosis Conditions point at the WRONG CSN.
1. Inspect src/condition.ts encounter-diagnosis path: how cond-<CSN>-<LINE> resolves its Encounter reference/identifier. Find why the CSN differs from PAT_ENC_DX.PAT_ENC_CSN_ID (likely a join taking the wrong contact, or a problem-list overview CSN vs the diagnosis CSN). Verify the correct CSN per (PAT_ENC_DX.PAT_ENC_CSN_ID) against fhir-target/ for a couple of conditions.
2. Fix so each encounter-diagnosis Condition references the encounter whose CSN actually carries that DX_ID line, with the real CSN identifier.value. Keep refs resolving (the Encounter shard must mint that CSN — if the correct CSN is NOT among the 34 curated encounters, that's a curation gap: reference by identifier only / document it, do not point at a wrong-but-present CSN).
Verify \`bun src/condition.ts\` + \`bun tools/refcheck.ts\` (0 dangling) + \`EXCLUDE_SMARTDATA=1 bun compare/classify.ts\` (Condition.encounter gap drops). Edit ONLY src/condition.ts. Report CSNs corrected + before→after.`, { label: 'r4:condition', phase: 'Workers' }),

  // 4 — Immunization route/site/text (~70)
  () => agent(`${RULES}

TASK — recover Immunization route/site and reconcile vaccineCode.text (~70 leaves).
From IMMUNE (+ siblings): emit dosageInstruction-equivalent fields the FHIR Immunization carries — route (IMMNZTN_ROUTE_C_NAME / a route column) and site (IMMNZTN_SITE_C_NAME / body-site) as .text from the EHI label; add a SNOMED/v3 coding ONLY if a real code column exists (else text only — the crosswalk worker handles standard route/site codings). Check vaccineCode.text: target "Influenza (FLUCELVAX) ccIIV4" vs our upper-case "INFLUENZA (FLUCELV…" — keep the truthful EHI label (do not title-case-fabricate); if the EHI carries a better display column use it.
Verify \`bun src/immunization.ts\` + \`bun tools/validate.ts Immunization\` (0 new errors) + \`EXCLUDE_SMARTDATA=1 bun compare/classify.ts\`. Edit ONLY src/immunization.ts. Report fields filled + gap before→after, with the GROUP BY proving each column is populated (else omit + say so).`, { label: 'r4:immunization', phase: 'Workers' }),

  // 5 — surface more DocumentReferences (~23 whole-resource) WITHOUT fabricating
  () => agent(`${RULES}

TASK — surface the remaining real DocumentReferences (target has ~23 we don't emit; we currently emit 44).
Audit src/documentreference.ts note-selection vs HNO_INFO (and DOC_INFORMATION scanned docs / Media). Emit the additional notes that GENUINELY exist with a real body in raw/Rich Text/ (or a real scanned-doc file) and are the right type/status — moving our count toward the target — WITHOUT fabricating (only notes that exist + have content). Keep author/encounter/custodian refs resolving and Binary attachments working under --embed-attachments.
Verify \`bun src/documentreference.ts\`, \`bun tools/refcheck.ts\` (0 dangling), \`bun tools/validate.ts DocumentReference\` (0 new errors). Edit ONLY src/documentreference.ts (+ src/binary.ts ONLY if attachment wiring for a new note needs it). Report count before→after + how many more target DocRefs now align. If some target DocRefs have NO recoverable body (Epic-API-only), say which and leave them (curation floor).`, { label: 'r4:docref', phase: 'Workers' }),

  // 6 — crosswalk + apply-answer-key bridges: condition enc-dx fix, specimen SNOMED, med/imm route SNOMED
  () => agent(`${RULES}

TASK — extend the answer-key crosswalk + bridges for anchored codings still GAP (ourVal=null with answer-key ON).
1. **Condition encounter-diagnosis bridge (~88 leaves).** problem.csv already carries DX_ID→{ICD-10/ICD-9/SNOMED/IMO} keyed PROBLEM_LIST.DX_ID, and problem-list Conditions get them, but the **encounter-diagnosis** Conditions (cond-<CSN>-<LINE>, same DX_ID via PAT_ENC_DX) do NOT, because the PAT_ENC_DX bridge only consumes PAT_ENC_DX-keyed crosswalk rows. FIX tools/apply-answer-key.ts: let the PAT_ENC_DX bridge ALSO match crosswalk rows whose join is PROBLEM_LIST.DX_ID (DX_ID is the same master key regardless of referencing table) — so the standard ICD codings land on encounter-diagnosis Conditions too. (The SNOMED 40425004 is genuine floor where no DX_ID→SNOMED exists, but ICD-9/ICD-10 ARE in problem.csv — confirm they flow.)
2. **Specimen.type (~40 leaves).** Target carries SNOMED (e.g. 100230 "Serum") + an Epic OID on Specimen.type. SPEC_TYPE_SNOMED.TYPE_SNOMED_CT IS in the export. Add crosswalk rows (lab.csv or a new specimen anchor) keyed to the specimen's EHI type, and a bridge in apply-answer-key.ts (Specimen.type, keyed by the specimen's natural key → SPEC_TYPE_SNOMED) so the SNOMED + epic-instance-OID land.
3. **Medication route SNOMED + Immunization route/site SNOMED** — IF a real Epic-route→SNOMED mapping is reconstructable from the reference (the route coding the target carries on an EHI-anchored route concept), add tagged epic-instance/standard rows keyed to ORDER_MED.MED_ROUTE_C_NAME / IMMUNE route. Only anchored rows; tag system_class.
Verify \`bun build.ts --answer-key\` then \`EXCLUDE_SMARTDATA=1 bun compare/classify.ts --out=out-answerkey\` — Condition/Specimen/route coding gaps drop. Edit ONLY crosswalk/* and tools/apply-answer-key.ts (additive/idempotent). Report rows added + per-path gap before→after + anything confirmed floor.`, { label: 'r4:crosswalk', phase: 'Workers' }),

  // 7 — tolerances: cosmetic-display CASE for coding.display, attachment iso-url (USER: tolerate), masked displays
  () => agent(`${RULES}

TASK — add NARROW, injection-self-checked tolerance families to compare/tolerances.ts (each must still GAP a same-shaped regression; import the real verify() and inject a wrong-value/wrong-entity case to confirm it GAPs, before keeping it).
A. **COSMETIC-CASE for coding.display** — where our coding.display equals the target's case-insensitively AND the coding's {system,code} match (same concept), tolerate the case-only difference (e.g. reasonCode "ANNUAL EXAM" vs "Annual Exam"; encounter reasonCode[].coding[].display + reasonCode[].text ~71 leaves). GAP a genuinely different display (different letters, not just case).
B. **ATTACHMENT iso-url (USER-APPROVED, ~84 leaves)** — treat content[].attachment.url "Binary/<our-sha1>" == target "Binary/<Epic-opaque-id>" as the SAME note's attachment when they hang off the SAME DocumentReference note anchor (iso-ref semantics, identical to how we tolerate synthetic resource ids elsewhere); also tolerate content[].attachment.contentType (text/rtf vs text/html for the same note). MUST still GAP an attachment on a DIFFERENT note. This requires the answer-key/build to include the Binary (run with --embed-attachments in reconcile) — note that dependency.
C. **masked requester/recorder/performer/author display** (e.g. "Dr. G Provider"/"User E" vs our EHI name) — extend the existing cosmetic-display family to these reference .display fields ONLY when the sibling reference resolves to the SAME natural-key entity; GAP a display on a different entity.
Run \`EXCLUDE_SMARTDATA=1 bun compare/classify.ts\`; report per-rule hits + the new ledger. Edit ONLY compare/*.`, { label: 'r4:tolerances', phase: 'Workers' }),
])

phase('Reconcile')
const reconcile = await agent(`${RULES}

TASK — RECONCILE round 4 (the single full build happens here; the 7 workers edited disjoint files).
1. \`bun build.ts\`, \`bun build.ts --answer-key\`, \`bun build.ts --embed-attachments\`, and \`bun build.ts --answer-key --embed-attachments\` (confirm flags compose) — REFERENCE INTEGRITY 0 dangling / 0 type-violations on each.
2. \`EXCLUDE_SMARTDATA=1 bun compare/classify.ts\` (baseline) AND \`EXCLUDE_SMARTDATA=1 bun compare/classify.ts --out=out-answerkey\` — report the new EXACT/TOLERATED/GAP ledgers + delta vs round-3 (baseline 6544/1145/6523; answer-key 11957/1397/2709 {real 1254, coding 1130, unsure 325}). For the attachment tolerance to score, classify the --embed-attachments answer-key output (build out-answerkey WITH --embed-attachments, or run apply-answer-key on the embedded out/). Reconciliation must hold (exact+tolerated+gap=total).
3. \`bun tools/floor-audit.ts\` — regenerate compare/CODING-FLOOR-AUDIT.md; report the new FLOOR / MOVABLE / UNSURE totals (round-3 was 1205 / 906 / 598). Every cluster the audit still labels MOVABLE or UNSURE that you did NOT close this round must get a one-line next-action or a proof it is actually FLOOR — no cluster called floor without proof.
4. \`bun tools/validate.ts\` on Medication/MedicationRequest/Immunization/Condition/Specimen/DocumentReference — 0 new errors.
5. Update docs: TODO.md (Progress log: round 4, check off what moved, refresh backlog), SHAPE-GAPS.md, ANSWER-KEY-EVAL.md, and the Residual ledger.
Return: the new baseline + answer-key ledgers, leaves moved GAP→EXACT/TOLERATED this round, the regenerated FLOOR/MOVABLE/UNSURE totals, and the honest remaining backlog. Edit docs only (TODO.md/SHAPE-GAPS.md/ANSWER-KEY-EVAL.md); do not touch generators/crosswalk/compare.`, { label: 'r4:reconcile', phase: 'Reconcile' })

return { workers, reconcile }
