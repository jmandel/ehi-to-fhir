export const meta = {
  name: 'ehi-fhir-portability-audit',
  description: 'Audit the BASELINE generators for hardcoded assumptions that break for a NEW patient at a DIFFERENT Epic provider org (fresh db, no answer-key, no fhir-target). Classify by severity AND portability tier (patient-specific / org-instance / epic-product-stable). Quantify the vocab gap separately.',
  phases: [
    { title: 'Audit', detail: '6 read-only agents sweep lib/ + src/ + tools/ by area for portability hazards on two axes' },
    { title: 'Synthesize', detail: 'dedup, rank, quantify vocab + the instance-OID/timezone blast radius, write AUDIT-PORTABILITY.md' },
  ],
}
const ROOT = '/home/jmandel/hobby/my-ehi/ehi-fhir'

const SCENARIO = `SCENARIO (stronger basis): a NEW patient at a DIFFERENT Epic healthcare organization is loaded into a FRESH ${ROOT}/ehi.sqlite (same Epic PRODUCT + EHI export schema, but a different ORG instance — different instance OID, possibly different timezone, different SER/department/coverage ids, different org-custom flowsheet measures, possibly a different shipped table subset). Build runs the BASELINE pipeline only: \`bun build.ts\` (NO --answer-key → crosswalk/apply-answer-key NOT invoked; NO fhir-target exists). Question: where will the generators emit WRONG data, silently-empty data, or break — and how feasibly portable is each issue? "We want some degree of portability where feasible."

CLASSIFY EVERY FINDING ON TWO AXES:
(1) SEVERITY: CRITICAL-WRONG (emits/anchors a value making output factually wrong) | CRITICAL-EMPTY (hardcoded id/filter won't match → resources silently missing) | FRAGILE (structural assumption may not hold on different-but-valid data: single-row assumed, [0]/first-row pick, a hardcoded *_C_NAME literal compared, count assumed, "exactly N") | LIMITATION (coverage enumerated from THIS export only → new instruments/providers/orgs silently missed; incomplete not wrong) | SAFE (legit constant: FHIR system URI, standard code system literal, enum→standard-code map).
(2) PORTABILITY TIER — WHO it breaks for:
   - PATIENT-SPECIFIC: breaks for ANY new patient (a hardcoded PAT_ID/CSN/COVERAGE_ID/specific DX/date/value/person). MUST fix.
   - ORG-INSTANCE: portable across patients at THIS org but breaks at a DIFFERENT Epic org — the Epic instance OID prefix \`1.2.840.114350.1.13.283.*\` (the .283 is THIS org's instance id), hardcoded timezone (America/Chicago), org-CUSTOM flowsheet measure ids (high custom FLO_MEAS_IDs vs Epic-RELEASED low ones), any baked org/SER/dept/coverage id, org name if hardcoded (note: org name read from CLARITY_SA.EXTERNAL_NAME is DB-derived = portable). Fix where feasible (centralize to one derived/config constant; derive from the export if possible).
   - EPIC-PRODUCT-STABLE: portable across ALL Epic orgs (the EHI Clarity/Caboodle table+column SCHEMA, *_C_NAME enum text→standard-code maps, Epic-RELEASED measure ids, FHIR structure, standard code-system URIs). Acceptable.
   - NON-EPIC: would only break for a non-Epic EHR entirely (out of scope — note briefly, don't dwell).

KEY THINGS TO INVESTIGATE:
- The instance OID prefix .283: ~49 hardcoded occurrences across src+lib. Is the org instance id DERIVABLE from the export (any column/config table carrying the full OID, or an existing identifier we could parse the prefix from), or is it fundamentally external config? Either way the fix is to CENTRALIZE it to one constant so a new org is one change, not 49. Report derivability + blast radius.
- Hardcoded timezone (America/Chicago): which generators; is the org tz derivable (facility/dept/instance config) or must it be a config constant?
- Table/column EXISTENCE assumptions: a different org's export config may ship a different table subset — do generators guard missing tables/columns (tableHasRows/columnsOf) or assume presence?
- PATIENT anchor: lib/ids.ts PATIENT_PAT_ID="Z7004242" used as WHERE PAT_ID=? in ~36 places — the dominant patient-specific blocker.

For EACH finding return: file, line, severity, portabilityTier, short title, what's hardcoded/assumed + why it breaks (or why safe), concrete fix (+ note if the fix is "centralize" vs "derive from export" vs "needs external config"). Read the files; cite real lines; don't guess. List only a few representative SAFE/EPIC-PRODUCT-STABLE items — focus on what breaks.`

const SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          file: { type: "string" }, line: { type: "string" },
          severity: { type: "string", enum: ["CRITICAL-WRONG", "CRITICAL-EMPTY", "FRAGILE", "LIMITATION", "SAFE"] },
          portabilityTier: { type: "string", enum: ["PATIENT-SPECIFIC", "ORG-INSTANCE", "EPIC-PRODUCT-STABLE", "NON-EPIC"] },
          title: { type: "string" }, detail: { type: "string" }, fix: { type: "string" },
        },
        required: ["file", "line", "severity", "portabilityTier", "title", "detail", "fix"],
      },
    },
    areaSummary: { type: "string" },
  },
  required: ["findings", "areaSummary"],
}

phase('Audit')
const areas = [
  ["lib + OID/tz core", "lib/db.ts, lib/ids.ts, lib/gen.ts, lib/profile.ts, lib/q.ts. (1) PATIENT anchor: PATIENT_PAT_ID=\"Z7004242\" used as WHERE PAT_ID=? in ~36 places — map the flow, is any part derived, and the minimal fix to make the pipeline patient-agnostic (derive the single PAT_ID from PATIENT at runtime / arg). (2) Is there ANY central instance-OID-prefix constant, or is .283 scattered? Investigate whether the org instance id is derivable from the export. (3) Date/timezone helpers: where does the America/Chicago assumption live, is it central or per-file, is org tz derivable? Recommend the centralization."],
  ["clinical core", "src/patient.ts, src/encounter.ts, src/condition.ts, src/allergy.ts, src/immunization.ts. Hardcoded PAT_ID/CSN/DX values; encounter-selection (selectCsns rule vs baked CSN list); the .283 OID systems each emits; hardcoded timezone; single-row / [0] / specific *_C_NAME-literal assumptions; table-existence guards."],
  ["observations", "src/obs-vitals.ts, src/obs-social.ts, src/obs-survey.ts, src/obs-smartdata.ts. obs-survey.ts hardcodes FLO_MEAS_ID membership lists + a FLO_MEAS_ID→us-core-category map (~lines 60-117) enumerated from THIS export. Classify: which FLO_MEAS_IDs are Epic-RELEASED (low ids, cross-org stable) vs ORG-CUSTOM (high ids, org-specific) — and the map is incomplete for a new org's instruments (LIMITATION/ORG-INSTANCE). obs-vitals 'Encounter Vitals' template-name filter + America/Chicago tz; SOCIAL_HX single-row; BMI value heuristic; the .283 OID (urn:oid:...707679) on Observation.code."],
  ["meds + labs", "src/medication.ts, src/lab.ts, src/servicerequest.ts. lab.ts SENTINEL / LAB_PANEL_CPTS (standard CPT = epic-product/SAFE vs anything org/patient); specimen filters; med method/dose gates (419652001 gated on sig verb=='Take' — confirm value-driven); .283 OIDs; any hardcoded ORDER/MEDICATION id or specific value; table-existence guards."],
  ["billing + comms + org", "src/account.ts, src/chargeitem.ts, src/claim.ts, src/eob.ts, src/coverage.ts, src/coverageeligibility.ts, src/invoice.ts, src/paymentrecon.ts, src/communication.ts, src/location-org.ts, src/practitioner.ts, src/careplan.ts, src/documentreference.ts, src/binary.ts, src/goal.ts. KNOWN: coverageeligibility.ts COVERAGE_ID=\"5934765\" (patient-specific) — confirm blast radius; communication.ts SENTINELS {199995,3724611,E1011} (classify each: provider/org pseudo-id vs patient); location-org/documentreference single-export-org assumption (CLARITY_SA EXTERNAL_NAME — DB-derived=portable? confirm) + the .283 custodian OID; America/Chicago in communication.ts; any baked org/coverage/account/claim id; single-row assumptions."],
  ["build + tools + VOCAB", "build.ts, tools/nppes-overlay.ts, tools/find-concept.ts, tools/refcheck.ts. build.ts hardcoded ids/flags + does it derive the patient or assume one? nppes-overlay SER_NPI_OVERRIDES (3 curated SER→NPI) = ORG-INSTANCE+patient-set LIMITATION (gated, harmless but org-specific). THEN QUANTIFY THE VOCAB GAP (set-aside issue): run \`bun build.ts\` (baseline) and compare code.coding coverage to \`bun build.ts --answer-key\` (use tools/coding-coverage.ts if present else count codings in out/ vs out-answerkey/). Report: baseline emits N codings, answer-key adds M (the vocab a new patient with no crosswalk loses); WHICH systems are baseline-derivable from the EHI (ICD/CVX/NDC/LOINC-from-LNC_DB_MAIN) vs answer-key-only. Also: is the answer-key itself org-portable (crosswalk anchored on .283 OIDs / this-org local codes)? Note but set aside."],
]
const audits = await parallel(areas.map(([label, scope]) =>
  () => agent(`Project root (cd here): ${ROOT}. READ-ONLY audit — DO NOT edit any files.

${SCENARIO}

YOUR AREA: ${scope}

Read every named file. Return structured findings (file/line/severity/portabilityTier/title/detail/fix) + a one-paragraph areaSummary. Be precise with line numbers; focus on what BREAKS (CRITICAL/FRAGILE/LIMITATION) across BOTH a new patient and a new org.`,
    { label: `audit:${label}`, phase: 'Audit', schema: SCHEMA })
))

phase('Synthesize')
const all = audits.filter(Boolean).flatMap((a) => a.findings || [])
const summaries = audits.filter(Boolean).map((a, i) => `**${areas[i][0]}**: ${a.areaSummary}`).join("\n\n")
const synth = await agent(`Project root (cd here): ${ROOT}. Audit coordinator. ${all.length} portability findings from 6 area auditors (JSON) + summaries. ${SCENARIO}

FINDINGS JSON:
${JSON.stringify(all, null, 1)}

AREA SUMMARIES:
${summaries}

TASK — write ${ROOT}/AUDIT-PORTABILITY.md, a prioritized two-axis portability audit for "new patient at a DIFFERENT Epic org, fresh db, baseline build, no answer-key, no fhir-target":
1. **Executive summary**: the two headline blockers (the PATIENT anchor; the ORG-INSTANCE OID/timezone hardcodes) + counts by severity and by portability tier, and the bottom line: (a) would a fresh same-org patient build correctly? (b) a different-org patient? what MUST be fixed for each level.
2. **A matrix / counts**: severity × portabilityTier (how many CRITICAL are PATIENT-SPECIFIC vs ORG-INSTANCE, etc.).
3. **CRITICAL — PATIENT-SPECIFIC (fix for any reuse)** table: file:line · title · why-breaks · fix. Lead with PATIENT_PAT_ID + COVERAGE_ID + any others.
4. **CRITICAL/ORG-INSTANCE (fix for cross-org)** table: the .283 OID prefix (blast radius + derivability + centralization fix), timezone, org-custom measures, any baked org ids.
5. **FRAGILE** + **LIMITATION** tables (note which tier).
6. **VOCAB GAP (accepted, out of scope)**: the quantified size; set aside.
7. **Recommended fix order**: smallest changes that unlock the most portability (likely: derive PATIENT_PAT_ID → centralize instance-OID prefix → centralize timezone → …). For each, note whether it's derive-from-export, centralize-constant, or needs-external-config.
DEDUPE overlapping findings; you may Read files to confirm but make NO edits. Don't fabricate; use only reported findings. Return the executive summary text.`,
  { label: 'synthesize', phase: 'Synthesize' })

return { audits, synth }
