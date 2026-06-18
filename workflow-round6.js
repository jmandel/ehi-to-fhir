export const meta = {
  name: 'ehi-fhir-round6-tail-adjudication',
  description: 'Adjudicate the entire remaining gap tail: MOVE each closable cluster (generator/crosswalk) or PROVE-FLOOR with a GROUP-BY. Disjoint-file parallel workers + reconcile.',
  phases: [
    { title: 'Workers', detail: '7 agents on disjoint files: allergy, medication, practitioner+nppes, coverage, patient, crosswalk(SNOMED), tolerances(cosmetic-case)' },
    { title: 'Reconcile', detail: 'full build ±answer-key ±embed; gates; classify; floor-audit; per-cluster adjudication' },
  ],
}

const ROOT = '/home/jmandel/hobby/my-ehi/ehi-fhir'
const RULES = `Project root (cd here): ${ROOT}. Rules: derive ONLY from the EHI or a STANDARD value set FHIR actually binds; NEVER fabricate a code/value/display the export doesn't support ("a blank beats an invention"); mint refs via ../lib/ids. Do NOT run full \`bun build.ts\` (the reconcile phase owns it) — verify with \`bun src/<file>\` or a targeted \`EXCLUDE_SMARTDATA=1 bun compare/classify.ts --out=out-answerkey\`. Edit ONLY the files your task names. ADJUDICATE every cluster you own: either MOVE it (close the gap) or declare it FLOOR with a one-line GROUP-BY proof of why the datum/code is genuinely absent — report both lists.`

phase('Workers')
const workers = await parallel([
  // 1 — AllergyIntolerance
  () => agent(`${RULES}
TASK — src/allergy.ts. Adjudicate:
- **category[] (6, target e.g. "biologic"/"medication"/"food"/"environment").** Derive from the allergen TYPE in the EHI (ALLERGY / ALLERGEN tables — inspect ALLERGEN_TYPE_C_NAME / ALLERGEN_ID class, or ALLERGY_* category columns). category is a REQUIRED-binding standard code set; map the EHI allergen class to it ONLY where unambiguous, else omit + prove.
- **clinicalStatus.coding[].version / verificationStatus.coding[].version (4+4, target "4.0.0").** This is the FHIR ValueSet version Epic stamps; if you judge it a server artifact (not EHI-derived) leave it (report FLOOR) — do NOT invent.
- **reaction[].manifestation[].coding[] SNOMED (4×3, 126485001 "Urticaria (disorder)")** is the CROSSWALK worker's job — DO NOT touch it here (leave for crosswalk); just note it.
Verify \`bun src/allergy.ts\` + \`bun tools/validate.ts AllergyIntolerance\`. Edit ONLY src/allergy.ts. Report MOVED vs FLOOR with proofs.`, { label: 'r6:allergy', phase: 'Workers' }),

  // 2 — Medication / MedicationRequest generator fields
  () => agent(`${RULES}
TASK — src/medication.ts. Adjudicate:
- **MedicationRequest.dispenseRequest.expectedSupplyDuration (16: value 225, unit "Day", system http://unitsofmeasure.org, code "d").** Source in ORDER_MED (days-supply column, e.g. HV_DISCRETE_* / a DAYS_SUPPLY / quantity÷rate). Emit value + unit "Day" + UCUM d when a real days-supply exists; else omit + prove.
- **Medication.form.text / form.coding[].display (18, target "Cap"/"Tab"/"Solution"/...).** Round-4 proof: CLARITY_MEDICATION.GENERIC_NAME contains "Cap"/"Tab" verbatim for capsule/tablet but NOT canonical labels for SOLN/MISC/DEVI/TBPK. So MOVE form.text/display for the cap/tablet forms you can extract truthfully; PROVE-FLOOR the rest (GROUP BY the form code vs available label columns). Do NOT fabricate a label.
- **dosageInstruction[].method.text "Take" (5) + dosageInstruction[].text + timing.repeat (frequency/period/periodUnit, 1 each) + timing.code.text "nightly as needed".** Derive the SIG structure from ORDER_MED sig columns (HV_DISCR_FREQ / SIG / dose-freq) where present; MOVE what's faithfully derivable, PROVE-FLOOR the rest. (method SNOMED coding is the crosswalk worker's — leave it.)
Verify \`bun src/medication.ts\` + \`bun tools/validate.ts MedicationRequest Medication\`. Edit ONLY src/medication.ts. Report MOVED vs FLOOR with GROUP-BY proofs.`, { label: 'r6:medication', phase: 'Workers' }),

  // 3 — Practitioner + NPPES overlay
  () => agent(`${RULES}
TASK — src/practitioner.ts (+ tools/nppes-overlay.ts / tools/nppes-cache.json if needed). Adjudicate:
- **gender (6, "female") + name.prefix[] (3, "Dr.").** Extend the NPPES overlay to the providers currently missing these (match more SERs to NPIs from SVC_LN_INFO.LN_*_NPI; pull gender + credential→prefix from NPPES public registry, cache it). MOVE where an NPI+NPPES match exists; PROVE-FLOOR (no NPI / no NPPES record) the rest.
- **identifier[] (7, value " MWS266", system urn:oid:1.2.840.114350.1.1..., use "usual", type.text "INTERNAL").** This is an Epic provider identifier — check whether MWS266-style ids live in CLARITY_SER (PROV_ID / a provider login/mnemonic column) or elsewhere. If EHI-present + keyed to our prac-<SER>, MOVE (emit identifier with the right system/use/type); else PROVE-FLOOR.
- **name.text "Mary S" / name.family "S" / name.given "Z" (masked initials).** The TARGET privacy-masks one name part to an initial; we emit the truthful full EHI name. This is FLOOR (we will NOT mask/truncate to match) — confirm + report as FLOOR (not movable).
- **whole-resource (8, e.g. 554340).** A few target Practitioners we don't emit. Check if they have a CLARITY_SER row / appear only in claims/NPPES; MOVE (emit) if there's a real SER provider, else PROVE-FLOOR (provider not in the export's SER master).
Verify \`bun src/practitioner.ts\` + \`bun tools/validate.ts Practitioner\` + \`bun tools/refcheck.ts\` (0 dangling). Edit ONLY src/practitioner.ts, tools/nppes-overlay.ts, tools/nppes-cache.json. Report MOVED vs FLOOR with proofs + NPIs/SERs recovered.`, { label: 'r6:practitioner', phase: 'Workers' }),

  // 4 — Coverage + DiagnosticReport.performer org adjudication
  () => agent(`${RULES}
TASK — src/coverage.ts AND src/lab.ts (DiagnosticReport). Adjudicate:
- **Coverage.type.text (1): target "BLUE CROSS/BLUE SHIELD" vs our "Indemnity".** Find the truthful source: which EHI column gives the plan/financial-class name? If "BLUE CROSS/BLUE SHIELD" is the faithful payor/plan name in the EHI (COVERAGE / BENEFIT_* / financial class), MOVE; if "Indemnity" is the truthful EHI value and the target's is a different field, keep ours + PROVE the divergence. (Coverage.relationship Self/01 (1): derive subscriber relationship from COVERAGE/MEMBER if present; else floor.)
- **DiagnosticReport.performer[].reference + .display (9+5): target "UPH MADISON SUNQUEST LAB" vs our "UPH MADISON MERITER LAB".** ADJUDICATE the org mismatch: query the EHI for the performing lab of these DiagnosticReports (ORDER_PROC / lab result performing-org columns). If the EHI says MERITER (ours is truthful, target relabeled), this is FLOOR — document. If the EHI says SUNQUEST (we picked the wrong org), FIX src/lab.ts to reference the correct Organization. Report which, with the query.
Verify \`bun src/coverage.ts\` + \`bun src/lab.ts\` + \`bun tools/refcheck.ts\`. Edit ONLY src/coverage.ts and src/lab.ts. Report MOVED vs FLOOR with proofs.`, { label: 'r6:coverage-dr', phase: 'Workers' }),

  // 5 — Patient (non-redaction fields only)
  () => agent(`${RULES}
TASK — src/patient.ts. Adjudicate ONLY the non-PHI-redaction fields (the [REDACTED-*] telecom/address/contact values are an INTENTIONAL privacy policy — those stay FLOOR, do NOT un-redact; just confirm them as policy-FLOOR):
- **contact[].relationship[].coding[] (2, system http://terminology.hl7.org/CodeSystem/v2-0131, code "SPS", display "spouse").** Derive the emergency-contact relationship from the EHI contact/relationship column (PAT_EMERGENCY_CONTACTS / a RELATIONSHIP_C_NAME) and map to the standard v2-0131 code where unambiguous; else floor.
- **extension gender-identity (1, SNOMED 446151000124109 "Identifies as male...") + extension birthsex valueCode (1, 184115007).** Derive from SOCIAL_HX / SEX_* / gender-identity columns if present; MOVE if EHI-anchored, else PROVE-FLOOR.
- **name.family/given case (2, "MANDEL" vs "Mandel"): this is letter-CASE only — leave it; the tolerances worker handles a cosmetic-case-name rule.** Just note it.
- **address[].period.start (1, 2018-07-17 vs our 2018-08-09): check the right effective date column; MOVE if a truer date exists, else floor.**
Verify \`bun src/patient.ts\` + \`bun tools/validate.ts Patient\`. Edit ONLY src/patient.ts. Report MOVED vs FLOOR with proofs.`, { label: 'r6:patient', phase: 'Workers' }),

  // 6 — crosswalk SNOMED (Specimen, allergy reaction, med method) + immunization reportOrigin
  () => agent(`${RULES}
TASK — crosswalk/* + tools/apply-answer-key.ts. Add answer-key codings for these EHI-ANCHORED concepts (additive/idempotent, tag system_class), each via a bridge keyed to the resource's natural key:
- **Specimen.type SNOMED (6, e.g. 100230 "Serum") + epic OID.** Anchored to SPEC_TYPE_SNOMED.TYPE_SNOMED_CT (IN the export). Add crosswalk rows + a Specimen.type bridge (specimen natural key → SPEC_TYPE_SNOMED).
- **AllergyIntolerance.reaction[].manifestation[].coding[] SNOMED (12, 126485001 "Urticaria (disorder)").** IF the export carries a reaction→SNOMED map (ALLERGY_REACTIONS + a SNOMED column) anchor it; else PROVE-FLOOR (no reaction-SNOMED map).
- **MedicationRequest.dosageInstruction[].method.coding[] SNOMED (5, 419652001 "Take").** IF anchorable to an EHI sig-method code, add it; else PROVE-FLOOR.
- **Immunization.reportOrigin.coding[] (5, code 2) + Immunization.doseQuantity (1).** reportOrigin: standard immunization-origin value set — derive from IMMUNE source/origin column if present, else floor.
Verify \`bun build.ts --answer-key\` then \`EXCLUDE_SMARTDATA=1 bun compare/classify.ts --out=out-answerkey\`. Edit ONLY crosswalk/* and tools/apply-answer-key.ts. Report rows added + per-path before→after + what's FLOOR with proof.`, { label: 'r6:crosswalk', phase: 'Workers' }),

  // 7 — tolerances: cosmetic-case for whole text values (name/address), state expansion, status version
  () => agent(`${RULES}
TASK — compare/tolerances.ts (+ classify.ts ONLY if a new pairing is needed). Add NARROW, injection-self-checked tolerance families (import the real verify(), inject a regression, confirm it GAPs, before keeping). DO NOT touch any other file.
A. **COSMETIC-CASE for name/text values** where ours differs from target ONLY by letter-case after norm() (lower+trim+collapse): Patient.name.family/given ("MANDEL" vs "Mandel"), Organization.name ("MAC ASSOCIATED PHYSICIANS" vs "Mac Associated Physicians"), Organization.address[].line[] / address[].text (street case). Tolerate ONLY norm-equal (a real-letter difference -> GAP). These have NO code anchor, so gate STRICTLY on norm-equality of the SAME element (do not pair across entities).
B. **STATE name expansion** Organization/Patient address[].state: tolerate "WI" vs "Wisconsin" ONLY via a fixed USPS 2-letter<->name table (both name the SAME state); a different state -> GAP.
C. **AllergyIntolerance clinicalStatus/verificationStatus .version "4.0.0"**: tolerate the server-stamped ValueSet version as a structural-variant (our side absent) ONLY for these two status scopes; any non-version drift -> GAP.
Do NOT tolerate the [REDACTED-*] PHI (those are intentional omissions, stay GAP/floor) and do NOT tolerate masked-initial names ("Mary S" vs "Mary B Smith" is truncation, not case -> must stay GAP). Run \`EXCLUDE_SMARTDATA=1 bun compare/classify.ts --out=out-answerkey\`; report per-rule hits + confirm reconciliation + no over-cap. Edit ONLY compare/*.`, { label: 'r6:tolerances', phase: 'Workers' }),
])

phase('Reconcile')
const reconcile = await agent(`${RULES}
TASK — RECONCILE round 6 (single full build here).
1. \`bun build.ts\`, \`bun build.ts --answer-key\`, \`bun build.ts --answer-key --embed-attachments\` — REFERENCE INTEGRITY 0 dangling / 0 type-violations each.
2. \`EXCLUDE_SMARTDATA=1 bun compare/classify.ts\` (baseline) AND \`--out=out-answerkey\` (with embed) — new EXACT/TOLERATED/GAP ledgers + delta vs round-5 (answer-key+embed 12442/1681/1940). Reconciliation must hold; report any OVER CAP (bump a stale cap ONLY if every hit is verify-gated, with a justifying note).
3. \`bun tools/floor-audit.ts\` — regenerate compare/CODING-FLOOR-AUDIT.md; report FLOOR/MOVABLE/UNSURE (round-5 was 1540/72/350). For EVERY remaining cluster that is still MOVABLE or UNSURE, give a one-line verdict: a named next action OR a proof it is FLOOR. The GOAL: drive MOVABLE+UNSURE to only proven-floor + a tiny, explicitly-named irreducible-movable remainder.
4. \`bun tools/validate.ts\` on every edited type — 0 new errors.
5. Update TODO.md (round-6 progress + final adjudication table), SHAPE-GAPS.md, ANSWER-KEY-EVAL.md.
Return: new ledgers, leaves moved this round, the regenerated FLOOR/MOVABLE/UNSURE, and the per-cluster adjudication (every cluster = MOVED or FLOOR-with-proof). Edit docs only.`, { label: 'r6:reconcile', phase: 'Reconcile' })

return { workers, reconcile }
