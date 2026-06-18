export const meta = {
  name: 'ehi-fhir-round7-final-fixes',
  description: 'Close the last genuine FIX wins (method SNOMED, DR.issued instant, NPPES gender, surface real notes) or prove FLOOR; reconcile + triage to drive OPEN down.',
  phases: [
    { title: 'Workers', detail: '4 disjoint-file agents: medication(method SNOMED), lab(DR.issued), practitioner+nppes(gender), documentreference(notes)' },
    { title: 'Reconcile', detail: 'build ±answer-key ±embed; gates; classify; floor-audit; triage; report OPEN' },
  ],
}
const ROOT = '/home/jmandel/hobby/my-ehi/ehi-fhir'
const RULES = `Project root (cd here): ${ROOT}. Rules: derive ONLY from the EHI or a STANDARD value set FHIR binds; NEVER fabricate; "a blank beats an invention". Do NOT run full \`bun build.ts\` (reconcile owns it) — verify with \`bun src/<file>\` + targeted \`EXCLUDE_SMARTDATA=1 bun compare/classify.ts --out=out-answerkey\`. Edit ONLY your named files. ADJUDICATE: either MOVE (close the gap) or declare FLOOR with a GROUP-BY proof.`

phase('Workers')
const workers = await parallel([
  () => agent(`${RULES}
TASK — src/medication.ts: MedicationRequest.dosageInstruction[].method.coding[] (target SNOMED 419652001 "Take", 5 orders × system/code/display = 15 leaves).
We ALREADY emit method.text "Take" for these orders. FIRST verify the "Take" comes from a REAL EHI sig source (find where method.text is set — which column/table; ORDER_MED has no SIG column per pragma, so confirm the actual source, e.g. ORDER_MEDINFO / HV_* / a sig table).
- IF "Take" is a faithful EHI-derived administration verb: ADD method.coding = {system http://snomed.info/sct, code 419652001, display "Take"} alongside the existing text — this is a deterministic standard administration-method map anchored to the EHI sig verb, NOT fabrication.
- IF "Take" is a hardcoded/default we inject with no EHI sig source: then BOTH the text and a SNOMED are unfounded — report FLOOR and (optionally) flag the text as suspect.
Verify \`bun src/medication.ts\` + \`bun tools/validate.ts MedicationRequest\` (0 new errors) + classify (method gap before→after). Edit ONLY src/medication.ts. Report MOVED vs FLOOR with the sig-source proof.`, { label: 'r7:method', phase: 'Workers' }),

  () => agent(`${RULES}
TASK — src/lab.ts: DiagnosticReport.issued (7 leaves; ours 7–61s LATER than target). We currently use LAST_FINAL_UTC_DTTM (?? FIRST_FINAL ?? RSLT_UPD).
Investigate ORDER_PROC_6 / ORDER_RESULTS instant columns: which one byte-matches the target's issued for these 7 reports? If an EARLIER result-instant column (e.g. FIRST_FINAL, an instantiated/verified instant) matches the target, switch to it (keeping the existing correction-safety guard for the 439060607 correction case — don't regress that).
- IF a column matches: MOVE.
- IF the difference is genuinely sub-minute rounding only: instead add/confirm a minute-precision tolerance for DiagnosticReport.issued (compare/tolerances.ts already has minute-rounded-diagnosticreport-issued — check why it doesn't fire; our seconds may be non-00). Prefer the generator fix if a faithful earlier column exists.
- IF neither: FLOOR with proof (the target's instant has no faithful EHI column).
Verify \`bun src/lab.ts\` + classify (DR.issued before→after). Edit ONLY src/lab.ts (or compare/tolerances.ts if the tolerance route is chosen — but not both files unless needed). Report MOVED/TOLERATED/FLOOR with the column proof.`, { label: 'r7:issued', phase: 'Workers' }),

  () => agent(`${RULES}
TASK — tools/nppes-overlay.ts + src/practitioner.ts: Practitioner.gender (+ name.prefix) for the 3 NPI-bearing SERs (Cahill NPI 1891752184, Shore 1669814737, Gilmour 1073140950; the other 22 SERs are NPI-less = floor).
Fetch these 3 NPIs from the public NPPES registry (https://npiregistry.cms.hhs.gov/api/?version=2.1&number=<NPI>), cache to tools/nppes-cache.json, overlay gender (+ credential→prefix "Dr." for MD/DO) onto the matching prac-<SER>. If the network is unavailable, use cache if present, else SKIP gracefully (report "network unavailable, floor for now") — never fail the build, never fabricate.
Verify \`bun src/practitioner.ts\` + \`bun tools/validate.ts Practitioner\`. Edit ONLY tools/nppes-overlay.ts, tools/nppes-cache.json, src/practitioner.ts. Report gender/prefix filled (or network-skip) + remaining floor.`, { label: 'r7:nppes', phase: 'Workers' }),

  () => agent(`${RULES}
TASK — src/documentreference.ts: the 23 target DocumentReferences we don't emit (we emit 44, target 51 — note: HNO_INFO has 188 note rows but HNO_PLAIN_TEXT has only ~24 relational bodies). ADJUDICATE each unaligned target DocRef:
- IF it has a REAL recoverable body (a raw/Rich Text/HNO_<NOTE_ID>_*.RTF file OR an HNO_PLAIN_TEXT row OR a DOC_INFORMATION scanned file) that we currently skip: emit it (right type/status, refs resolve, Binary attachment works) → MOVE.
- IF it has NO relational/file body (Epic-API-only metadata note): FLOOR — prove with the NOTE_ID absent from HNO_PLAIN_TEXT AND no RTF file.
Do NOT fabricate a note. Verify \`bun src/documentreference.ts\` + \`bun tools/refcheck.ts\` (0 dangling) + \`bun tools/validate.ts DocumentReference\`. Edit ONLY src/documentreference.ts (+ src/binary.ts if a newly-surfaced note needs attachment wiring). Report count before→after + how many MOVED vs proven FLOOR (API-only).`, { label: 'r7:notes', phase: 'Workers' }),
])

phase('Reconcile')
const reconcile = await agent(`${RULES}
TASK — RECONCILE round 7 (single full build).
1. \`bun build.ts\`, \`bun build.ts --answer-key\`, \`bun build.ts --answer-key --embed-attachments\` — 0 dangling / 0 type-violations each.
2. \`EXCLUDE_SMARTDATA=1 bun compare/classify.ts\` (baseline) AND \`--out=out-answerkey\` (with embed) — ledgers + delta vs round-6 (answer-key+embed 12505/1700/1858). Reconciliation must hold; report + fix any OVER CAP (bump only if every hit verify-gated, with a note).
3. \`bun tools/floor-audit.ts\` then \`bun tools/triage.ts\` — report the new **OPEN = FIX + TOLERATE** count and ACCEPT, and the delta vs round-6 (OPEN 89 / ACCEPT 1769). For every cluster STILL in FIX/TOLERATE, give a one-line verdict (named action or proof it is FLOOR → update tools/floor-audit.ts verdict() so the disposition is encoded, NOT left as a stale label).
4. \`bun tools/validate.ts\` on edited types — 0 new errors.
5. Update TODO.md (round-7 progress + the OPEN→0 burndown), and compare/TRIAGE.md is regenerated.
Return: new ledgers, leaves moved (FIX→done / →ACCEPT / TOLERATE→done), the new OPEN count + remaining backlog. Edit docs + tools/floor-audit.ts only.`, { label: 'r7:reconcile', phase: 'Reconcile' })

return { workers, reconcile }
