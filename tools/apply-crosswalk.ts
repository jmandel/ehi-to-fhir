#!/usr/bin/env bun
/**
 * apply-crosswalk.ts — OPT-IN, non-destructive enrichment pass.
 *
 *   bun tools/apply-crosswalk.ts [--in out] [--out out-crosswalk] [--all]
 *
 * Reads baseline FHIR resources from an input dir (default out/) and the
 * reconstructed terminology crosswalk (crosswalk/ALL.csv), then LAYERS the
 * crosswalk standard codings (LOINC/SNOMED/ICD/RxNorm/CVX/CPT…) that the EHI
 * export does NOT carry but we recovered, writing ENRICHED copies to an output
 * dir (default out-crosswalk/). The baseline dir is never modified, so output
 * gaps can be measured WITH vs WITHOUT the crosswalk.
 *
 * Two matching modes, exactly as specified:
 *
 *   PRIMARY (preferred) — for every CodeableConcept anywhere in a resource
 *   (code, valueCodeableConcept, vaccineCode, type, category, …), if it already
 *   carries a coding whose {system,code} equals a crosswalk row's
 *   {epic_local_system, epic_local_code}, APPEND that row's
 *   {system:target_system, code:target_code, display:target_display} to the SAME
 *   coding array (if not already present).
 *
 *   FALLBACK (only where the resource carries no Epic-local coding to key on) —
 *   match by the resource's natural key (decoded from its minted id) joined to
 *   the row's ehi_join_column value via the EHI DB, then append the target coding
 *   at the row's fhir_path's coding array.
 *
 * Rules: ADDITIVE ONLY — never remove/modify an existing coding or field; only
 * append codings not already present. Idempotent. Uses ehi_verified rows only
 * unless --all. NEVER adds a coding that isn't in crosswalk/ALL.csv.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "fs";
import { resolve } from "path";
import { q } from "../lib/db";

const ROOT = resolve(import.meta.dir, "..");

// ---- args ------------------------------------------------------------------
const argv = process.argv.slice(2);
function argVal(name: string, def: string): string {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const IN_DIR = resolve(ROOT, argVal("--in", "out"));
const OUT_DIR = resolve(ROOT, argVal("--out", "out-crosswalk"));
const INCLUDE_ALL = argv.includes("--all"); // include non-ehi_verified rows too
const CSV_PATH = resolve(ROOT, "crosswalk", "ALL.csv");
const IDENTIFIERS_CSV = resolve(ROOT, "crosswalk", "identifiers.csv");
// Whether to run the identifier-layering pass (TODO #4). On by default; --no-identifiers
// disables it (e.g. to score the terminology layer alone).
const APPLY_IDENTIFIERS = !argv.includes("--no-identifiers");

// ---- CSV (RFC-4180-ish: quoted fields, "" escapes, embedded commas/newlines) ----
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let i = 0, field = "", row: string[] = [], inQ = false;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

interface Row {
  fhir_path: string;
  concept_display: string;
  ehi_join_table: string;
  ehi_join_column: string;
  epic_local_system: string;
  epic_local_code: string;
  target_system: string;
  target_code: string;
  target_display: string;
  ehi_verified: string;
  // "standard" | "epic-instance-oid". Informational: the answer key layers a row by
  // its anchor regardless of class, but the per-class tally lets us see the
  // epic-instance-OID fan-out land separately from the standard codings.
  system_class: string;
}

function loadCrosswalk(): Row[] {
  const rows = parseCSV(readFileSync(CSV_PATH, "utf8"));
  const hdr = rows[0];
  const idx = Object.fromEntries(hdr.map((h, i) => [h.trim(), i]));
  const get = (r: string[], k: string) => (r[idx[k]] ?? "").trim();
  return rows
    .slice(1)
    .filter((r) => r.length >= hdr.length - 2) // tolerate trailing optional cols
    .map((r) => ({
      fhir_path: get(r, "fhir_path"),
      concept_display: get(r, "concept_display"),
      ehi_join_table: get(r, "ehi_join_table"),
      ehi_join_column: get(r, "ehi_join_column"),
      epic_local_system: get(r, "epic_local_system"),
      epic_local_code: get(r, "epic_local_code"),
      target_system: get(r, "target_system"),
      target_code: get(r, "target_code"),
      target_display: get(r, "target_display"),
      ehi_verified: get(r, "ehi_verified"),
      system_class: get(r, "system_class") || "standard",
    }))
    // A usable crosswalk row must name a real standard coding to attach.
    .filter((r) => r.target_system && r.target_code)
    .filter((r) => INCLUDE_ALL || r.ehi_verified.toLowerCase() === "yes");
}

// ---- additive coding append ------------------------------------------------
type Coding = { system?: string; code?: string; display?: string };

/** Append target coding to a coding[] iff not already present. Returns true if added. */
function appendCoding(codingArr: Coding[], r: Row): boolean {
  const exists = codingArr.some((c) => c.system === r.target_system && c.code === r.target_code);
  if (exists) return false;
  const add: Coding = { system: r.target_system, code: r.target_code };
  if (r.target_display) add.display = r.target_display;
  codingArr.push(add);
  return true;
}

// ---- PRIMARY: walk every CodeableConcept, match by existing coding system+code ----
// Index crosswalk rows by epic_local_system||epic_local_code (only rows whose
// epic_local_system is a real coding-system URI can ever match a coding present
// in the data).
function isUri(s: string): boolean {
  return /^(urn:|https?:)/.test(s);
}

function buildPrimaryIndex(rows: Row[]): Map<string, Row[]> {
  const m = new Map<string, Row[]>();
  for (const r of rows) {
    if (!isUri(r.epic_local_system) || !r.epic_local_code) continue;
    const k = r.epic_local_system + "||" + r.epic_local_code;
    (m.get(k) ?? m.set(k, []).get(k)!).push(r);
  }
  return m;
}

/** Does `cc` look like a CodeableConcept (has a coding[] array)? */
function isCodeableConcept(cc: any): cc is { coding: Coding[] } {
  return cc && typeof cc === "object" && Array.isArray(cc.coding);
}

/**
 * Recursively find every coding[] array in a resource, reporting each along with
 * its FHIR element path *relative to the resource root* (array indices elided), e.g.
 * "code", "type", "vaccineCode", "category", "component.code", "value.coding"…
 * This lets PRIMARY honor a crosswalk row's fhir_path (the element it designates)
 * so a panel-level code on `code` does not leak onto `component.code`, etc.
 */
function eachCodingArray(
  node: any,
  fn: (arr: Coding[], elemPath: string, cc: any) => void,
  elemPath = "",
): void {
  if (Array.isArray(node)) {
    // arrays don't extend the element path (FHIR repeats share their field name)
    for (const v of node) eachCodingArray(v, fn, elemPath);
    return;
  }
  if (node && typeof node === "object") {
    // pass the enclosing CodeableConcept (the object that owns coding[]) so a
    // crosswalk fhir_path predicate can disambiguate by its sibling fields (text).
    if (Array.isArray(node.coding)) fn(node.coding, elemPath, node);
    for (const [k, v] of Object.entries(node)) {
      if (k === "coding") continue; // the coding[] itself is the leaf, don't descend as a field
      eachCodingArray(v, fn, elemPath ? `${elemPath}.${k}` : k);
    }
  }
}

/** The element a crosswalk fhir_path designates, e.g. "Observation.code" -> "code",
 *  "Observation.component.code" -> "component.code". Empty when unparseable.
 *  Any trailing [text=…] predicate is stripped (it is matched separately). */
function fhirPathElement(fhir_path: string): string {
  const stripped = fhir_path.replace(/\[[^\]]*\]\s*$/, "");
  const i = stripped.indexOf(".");
  return i >= 0 ? stripped.slice(i + 1) : "";
}

/** Optional disambiguating predicate on a crosswalk fhir_path of the form
 *  "Observation.component.code[text=BP Systolic]" — restricts the row to a
 *  CodeableConcept whose own `text` equals the predicate value. Returns the
 *  required text, or undefined when the fhir_path carries no predicate.
 *  (Only `text=` is supported; an unrecognized predicate yields undefined so the
 *  row simply behaves as un-predicated rather than silently matching nothing.) */
function fhirPathTextPredicate(fhir_path: string): string | undefined {
  const m = fhir_path.match(/\[text=([^\]]*)\]\s*$/);
  return m ? m[1] : undefined;
}

// ---- FALLBACK: natural-key bridges -----------------------------------------
// Resources whose CodeableConcept carries only `text` (no Epic-local coding to
// key on) get matched by their minted id's natural key, bridged through the EHI
// DB to the crosswalk's ehi_join_column value, then the target coding is appended
// at the row's fhir_path.
//
// Each bridge maps a `${ehi_join_table}.${ehi_join_column}` selector to a list of
// { fhirId, joinValue } pairs: fhirId is the minted resource id (same convention
// as lib/ids), joinValue is the crosswalk key (epic_local_code) for that resource.

function slug(s: string | number): string {
  return String(s).trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

interface Bridge {
  fhir_path: string;          // crosswalk fhir_path this bridge serves
  selector: string;          // `${ehi_join_table}.${ehi_join_column}`
  pairs: () => { fhirId: string; joinValue: string }[];
  // Which crosswalk-row field the bridge's joinValue is compared against. Default
  // "epic_local_code" (the numeric/local code). Some elements are anchored on an
  // EHI LABEL the export ships verbatim rather than the numeric code — e.g.
  // DocumentReference.type, whose note-type CODE is NOT in the export but whose
  // LABEL (HNO_INFO.IP_NOTE_TYPE_C_NAME) is; those rows are keyed by the concept
  // label (carried in concept_display), so the bridge joins on that instead.
  keyBy?: "epic_local_code" | "concept_display";
}

function buildBridges(): Bridge[] {
  const bridges: Bridge[] = [];

  // Condition.code (text-only) — problem-list items keyed cond-<PROBLEM_LIST_ID>,
  // crosswalk keys on PROBLEM_LIST.DX_ID.
  bridges.push({
    fhir_path: "Condition.code",
    selector: "PROBLEM_LIST.DX_ID",
    pairs: () =>
      q<{ PROBLEM_LIST_ID: string; DX_ID: string }>(
        `SELECT PROBLEM_LIST_ID, DX_ID FROM PROBLEM_LIST WHERE DX_ID IS NOT NULL`,
      ).map((x) => ({ fhirId: `cond-${slug(x.PROBLEM_LIST_ID)}`, joinValue: String(x.DX_ID) })),
  });
  // Condition.code — encounter-diagnosis items keyed cond-<CSN>-<LINE>,
  // crosswalk keys on PAT_ENC_DX.DX_ID.
  //
  // DX_ID is the master diagnosis key (CLARITY_EDG); it is the SAME key whether a
  // diagnosis is referenced from PAT_ENC_DX (encounter-diagnosis) or PROBLEM_LIST
  // (problem-list). The standard ICD-10/ICD-9/SNOMED codings recovered from
  // problem.csv are anchored on PROBLEM_LIST.DX_ID, so an encounter-diagnosis whose
  // DX_ID happens to also be a problem-list DX_ID (e.g. 260690 "Post concussion
  // syndrome") would NOT get its ICD codings if the encounter-diagnosis bridge only
  // consumed PAT_ENC_DX-keyed rows. We therefore feed the encounter-diagnosis pairs
  // through BOTH selectors — PAT_ENC_DX.DX_ID *and* PROBLEM_LIST.DX_ID — so a
  // standard coding crosswalked under either table lands on the encounter-diagnosis
  // Condition (DX_ID is the same regardless of the referencing table). Idempotent:
  // appendCoding never double-attaches.
  const encDxPairs = () =>
    q<{ PAT_ENC_CSN_ID: string; LINE: string; DX_ID: string }>(
      `SELECT PAT_ENC_CSN_ID, LINE, DX_ID FROM PAT_ENC_DX WHERE DX_ID IS NOT NULL`,
    ).map((x) => ({ fhirId: `cond-${slug(`${x.PAT_ENC_CSN_ID}-${x.LINE}`)}`, joinValue: String(x.DX_ID) }));
  bridges.push({
    fhir_path: "Condition.code",
    selector: "PAT_ENC_DX.DX_ID",
    pairs: encDxPairs,
  });
  bridges.push({
    fhir_path: "Condition.code",
    selector: "PROBLEM_LIST.DX_ID",
    pairs: encDxPairs,
  });

  // AllergyIntolerance.code (text-only) — keyed alg-<ALLERGY_ID>,
  // crosswalk keys on ALLERGY.ALLERGEN_ID.
  bridges.push({
    fhir_path: "AllergyIntolerance.code",
    selector: "ALLERGY.ALLERGEN_ID",
    pairs: () =>
      q<{ ALLERGY_ID: string; ALLERGEN_ID: string }>(
        `SELECT ALLERGY_ID, ALLERGEN_ID FROM ALLERGY WHERE ALLERGEN_ID IS NOT NULL`,
      ).map((x) => ({ fhirId: `alg-${slug(x.ALLERGY_ID)}`, joinValue: String(x.ALLERGEN_ID) })),
  });

  // Medication.code — keyed med-<ORDER_MED_ID>, crosswalk keys on
  // ORDER_MED.MEDICATION_ID (the drug-master id). The Medication resource carries
  // MEDICATION_ID only as identifier.value (not a code.coding), so PRIMARY can't
  // key on it — this bridge maps the minted id's natural key (ORDER_MED_ID) to the
  // crosswalk's join value (MEDICATION_ID) and appends RxNorm/NDC to code.coding.
  bridges.push({
    fhir_path: "Medication.code",
    selector: "ORDER_MED.MEDICATION_ID",
    pairs: () =>
      q<{ ORDER_MED_ID: string; MEDICATION_ID: string }>(
        `SELECT ORDER_MED_ID, MEDICATION_ID FROM ORDER_MED WHERE MEDICATION_ID IS NOT NULL`,
      ).map((x) => ({ fhirId: `med-${slug(x.ORDER_MED_ID)}`, joinValue: String(x.MEDICATION_ID) })),
  });

  // Immunization.vaccineCode — keyed imm-<IMMUNE_ID>, crosswalk keys on
  // IMMUNE.IMMUNE_ID (the record-level join key). The Immunization resource carries
  // IMMUNE_ID only as identifier.value (not a vaccineCode.coding when no NDC is
  // present), so PRIMARY can't key on it — this bridge maps the minted id's natural
  // key (IMMUNE_ID) to the crosswalk's join value (IMMUNE_ID) and appends CVX/NDC.
  bridges.push({
    fhir_path: "Immunization.vaccineCode",
    selector: "IMMUNE.IMMUNE_ID",
    pairs: () =>
      q<{ IMMUNE_ID: string }>(
        `SELECT IMMUNE_ID FROM IMMUNE WHERE IMMUNE_ID IS NOT NULL`,
      ).map((x) => ({ fhirId: `imm-${slug(x.IMMUNE_ID)}`, joinValue: String(x.IMMUNE_ID) })),
  });

  // DiagnosticReport.code — keyed dr-<ORDER_PROC_ID>, crosswalk keys on
  // ORDER_PROC.PROC_ID (the order's procedure id, attached at order level).
  bridges.push({
    fhir_path: "DiagnosticReport.code",
    selector: "ORDER_PROC.PROC_ID",
    pairs: () =>
      q<{ ORDER_PROC_ID: string; PROC_ID: string }>(
        `SELECT ORDER_PROC_ID, PROC_ID FROM ORDER_PROC WHERE PROC_ID IS NOT NULL`,
      ).map((x) => ({ fhirId: `dr-${slug(x.ORDER_PROC_ID)}`, joinValue: String(x.PROC_ID) })),
  });

  // DocumentReference.type — keyed doc-<NOTE_ID>; the note-type CODE is NOT in the
  // export (only the LABEL is — HNO_INFO.IP_NOTE_TYPE_C_NAME / NOTE_TYPE_NOADD_C_NAME,
  // which our DocumentReference.type.text already carries), so we anchor on that LABEL
  // (keyBy concept_display) rather than a numeric local code. This lands BOTH the
  // standard LOINC note-type codings AND the parallel Epic-instance note-type OIDs
  // (…737880.5010 / …727879.69848980) the reference carries on the same concept.
  bridges.push({
    fhir_path: "DocumentReference.type",
    selector: "HNO_INFO.IP_NOTE_TYPE_C_NAME",
    keyBy: "concept_display",
    pairs: () =>
      q<{ NOTE_ID: string; LABEL: string }>(
        `SELECT NOTE_ID, COALESCE(IP_NOTE_TYPE_C_NAME, NOTE_TYPE_NOADD_C_NAME) AS LABEL
           FROM HNO_INFO WHERE COALESCE(IP_NOTE_TYPE_C_NAME, NOTE_TYPE_NOADD_C_NAME) IS NOT NULL`,
      ).map((x) => ({ fhirId: `doc-${slug(x.NOTE_ID)}`, joinValue: String(x.LABEL) })),
  });

  // Specimen.type — keyed spec-<ORDER_PROC_ID>; the numeric Epic specimen-type code is
  // NOT in the export (only the label ORDER_PROC.SPECIMEN_TYPE_C_NAME ships), and our
  // Specimen.type is text-only, so we anchor on that LABEL (keyBy concept_display). This
  // lands BOTH the recovered SNOMED (standard rows, build-other-coded) AND the parallel
  // Epic specimen-type OID (epic-instance, build-epic-instance-oid) on the same concept.
  bridges.push({
    fhir_path: "Specimen.type",
    selector: "ORDER_PROC.SPECIMEN_TYPE_C_NAME",
    keyBy: "concept_display",
    pairs: () =>
      q<{ ORDER_PROC_ID: string; LABEL: string }>(
        `SELECT ORDER_PROC_ID, SPECIMEN_TYPE_C_NAME AS LABEL FROM ORDER_PROC
          WHERE SPECIMEN_TYPE_C_NAME IS NOT NULL AND SPECIMEN_TYPE_C_NAME<>''`,
      ).map((x) => ({ fhirId: `spec-${slug(x.ORDER_PROC_ID)}`, joinValue: String(x.LABEL) })),
  });

  // MedicationRequest.dosageInstruction.route — keyed medreq-<ORDER_MED_ID>; the numeric
  // Epic route code is NOT in the export (only ORDER_MED.MED_ROUTE_C_NAME ships), and our
  // route is text-only, so we anchor on that LABEL (keyBy concept_display). Lands the
  // recovered route SNOMED (standard) + the parallel Epic .7025 route OID (epic-instance)
  // on the dosageInstruction[].route CodeableConcept.
  bridges.push({
    fhir_path: "MedicationRequest.dosageInstruction.route",
    selector: "ORDER_MED.MED_ROUTE_C_NAME",
    keyBy: "concept_display",
    pairs: () =>
      q<{ ORDER_MED_ID: string; LABEL: string }>(
        `SELECT ORDER_MED_ID, MED_ROUTE_C_NAME AS LABEL FROM ORDER_MED
          WHERE MED_ROUTE_C_NAME IS NOT NULL AND MED_ROUTE_C_NAME<>''`,
      ).map((x) => ({ fhirId: `medreq-${slug(x.ORDER_MED_ID)}`, joinValue: String(x.LABEL) })),
  });

  // Immunization.route / Immunization.site — keyed imm-<IMMUNE_ID>; the numeric Epic
  // route/site codes are NOT in the export (only IMMUNE.ROUTE_C_NAME / SITE_C_NAME ship),
  // and our route/site are text-only, so we anchor on the LABEL (keyBy concept_display).
  // The reference carries NO standard coding for these — only the Epic route/site OIDs
  // (epic-instance), which land here on the matching CodeableConcept.
  bridges.push({
    fhir_path: "Immunization.route",
    selector: "IMMUNE.ROUTE_C_NAME",
    keyBy: "concept_display",
    pairs: () =>
      q<{ IMMUNE_ID: string; LABEL: string }>(
        `SELECT IMMUNE_ID, ROUTE_C_NAME AS LABEL FROM IMMUNE
          WHERE ROUTE_C_NAME IS NOT NULL AND ROUTE_C_NAME<>''`,
      ).map((x) => ({ fhirId: `imm-${slug(x.IMMUNE_ID)}`, joinValue: String(x.LABEL) })),
  });
  bridges.push({
    fhir_path: "Immunization.site",
    selector: "IMMUNE.SITE_C_NAME",
    keyBy: "concept_display",
    pairs: () =>
      q<{ IMMUNE_ID: string; LABEL: string }>(
        `SELECT IMMUNE_ID, SITE_C_NAME AS LABEL FROM IMMUNE
          WHERE SITE_C_NAME IS NOT NULL AND SITE_C_NAME<>''`,
      ).map((x) => ({ fhirId: `imm-${slug(x.IMMUNE_ID)}`, joinValue: String(x.LABEL) })),
  });

  // Specimen.type SNOMED anchored to the IN-EXPORT field — SPEC_TYPE_SNOMED.TYPE_SNOMED_CT
  // carries the specimen SNOMED itself (keyed by ORDER_ID). The resulted order links to its
  // placement parent via ORDER_PARENT_INFO, and the parent carries the SNOMED; we land it on
  // spec-<ORDER_PROC_ID>. Gated to genuinely Blood-typed specimens (the parent SNOMED 119297000
  // is the blood-draw source — valid only for Blood, would mislabel the Serum specimens), exactly
  // as src/lab.ts emits the code-only SNOMED. This adds the SNOMED DISPLAY the export omits, and
  // makes the provenance EHI-native (the SNOMED is in SPEC_TYPE_SNOMED, not just the reference).
  // keyBy epic_local_code: the bridge's joinValue is the SNOMED code shipped in the export.
  bridges.push({
    fhir_path: "Specimen.type",
    selector: "SPEC_TYPE_SNOMED.TYPE_SNOMED_CT",
    keyBy: "epic_local_code",
    pairs: () =>
      q<{ ORDER_PROC_ID: string; TYPE_SNOMED_CT: string }>(
        `SELECT p.ORDER_PROC_ID, sts.TYPE_SNOMED_CT
           FROM ORDER_PROC p
           JOIN ORDER_PARENT_INFO pi ON pi.ORDER_ID = p.ORDER_PROC_ID
           JOIN SPEC_TYPE_SNOMED sts ON sts.ORDER_ID = pi.PARENT_ORDER_ID
          WHERE p.SPECIMEN_TYPE_C_NAME = 'Blood'
            AND sts.TYPE_SNOMED_CT IS NOT NULL AND sts.TYPE_SNOMED_CT <> ''`,
      ).map((x) => ({ fhirId: `spec-${slug(x.ORDER_PROC_ID)}`, joinValue: String(x.TYPE_SNOMED_CT).trim() })),
  });

  // AllergyIntolerance.reaction.manifestation SNOMED — keyed alg-<ALLERGY_ID>; the export carries
  // NO reaction->SNOMED map (ALLERGY_REACTIONS has only REACTION_C_NAME, no SNOMED column), so we
  // anchor on that LABEL (keyBy concept_display). Our reaction manifestation is text-only ("Hives");
  // the SNOMED (126485001 "Urticaria (disorder)") is recovered from the reference. Same label-anchor
  // pattern as Specimen.type/route SNOMED.
  bridges.push({
    fhir_path: "AllergyIntolerance.reaction.manifestation",
    selector: "ALLERGY_REACTIONS.REACTION_C_NAME",
    keyBy: "concept_display",
    pairs: () =>
      q<{ ALLERGY_ID: string; LABEL: string }>(
        `SELECT ALLERGY_ID, REACTION_C_NAME AS LABEL FROM ALLERGY_REACTIONS
          WHERE REACTION_C_NAME IS NOT NULL AND REACTION_C_NAME <> ''`,
      ).map((x) => ({ fhirId: `alg-${slug(x.ALLERGY_ID)}`, joinValue: String(x.LABEL) })),
  });

  // Immunization.reportOrigin — keyed imm-<IMMUNE_ID>; the numeric Epic report-origin code is NOT in
  // the export (only IMMUNE.EXTERNAL_ADMIN_C_NAME ships the LABEL "Confirmed"/"MyChart Entered"), and
  // our reportOrigin is display-only, so we anchor on that LABEL (keyBy concept_display). The reference
  // carries NO standard immunization-origin coding for these — only the Epic-instance OID (.4082),
  // which lands here on the reportOrigin CodeableConcept.
  bridges.push({
    fhir_path: "Immunization.reportOrigin",
    selector: "IMMUNE.EXTERNAL_ADMIN_C_NAME",
    keyBy: "concept_display",
    pairs: () =>
      q<{ IMMUNE_ID: string; LABEL: string }>(
        `SELECT IMMUNE_ID, EXTERNAL_ADMIN_C_NAME AS LABEL FROM IMMUNE
          WHERE EXTERNAL_ADMIN_C_NAME IS NOT NULL AND EXTERNAL_ADMIN_C_NAME <> ''`,
      ).map((x) => ({ fhirId: `imm-${slug(x.IMMUNE_ID)}`, joinValue: String(x.LABEL) })),
  });

  // Coverage.type — keyed cov-<COVERAGE_ID>, crosswalk keys on COVERAGE.PAYOR_ID.
  bridges.push({
    fhir_path: "Coverage.type",
    selector: "COVERAGE.PAYOR_ID",
    pairs: () =>
      q<{ COVERAGE_ID: string; PAYOR_ID: string }>(
        `SELECT COVERAGE_ID, PAYOR_ID FROM COVERAGE WHERE PAYOR_ID IS NOT NULL`,
      ).map((x) => ({ fhirId: `cov-${slug(x.COVERAGE_ID)}`, joinValue: String(x.PAYOR_ID) })),
  });

  // Social-history Observations carry text-only code AND text-only value; their
  // ids are fixed (obs-social-<topic>). The crosswalk keys the value coding on the
  // SOCIAL_HX *_C_NAME literal (e.g. "Never"/"Yes"/"No"). joinValue is that literal.
  // Observation.code (the LOINC for the *topic*) keys on SOCIAL_HX with empty col;
  // we bind it to the topic's fixed id directly.
  const socialTopics: { fhirId: string; cName: string }[] = [
    { fhirId: "obs-social-smoking", cName: "SMOKING_TOB_USE_C_NAME" },
    { fhirId: "obs-social-alcohol", cName: "ALCOHOL_USE_C_NAME" },
    { fhirId: "obs-social-drug", cName: "ILL_DRUG_USER_C_NAME" },
  ];
  // Observation.valueCodeableConcept — keyed on the C_NAME literal value.
  for (const t of socialTopics) {
    bridges.push({
      fhir_path: "Observation.valueCodeableConcept",
      selector: `SOCIAL_HX.${t.cName}`,
      pairs: () => {
        const row = q<Record<string, string>>(`SELECT ${t.cName} AS V FROM SOCIAL_HX`)[0];
        const v = row?.V;
        return v ? [{ fhirId: t.fhirId, joinValue: String(v) }] : [];
      },
    });
  }

  return bridges;
}

// Build: fhirId -> Row[] to append, from the fallback bridges crossed with the
// crosswalk. Only rows whose (fhir_path, selector, epic_local_code) line up with a
// bridge pair's (fhir_path, selector, joinValue) are emitted.
function buildFallbackIndex(rows: Row[]): Map<string, Row[]> {
  const bridges = buildBridges();
  // group crosswalk rows by `${fhir_path}||${table}.${col}||${joinValue}`, indexing each
  // row under BOTH its epic_local_code and its concept_display so a bridge may join on
  // either (default: epic_local_code; label-anchored elements: concept_display).
  const byKey = new Map<string, Row[]>();
  const indexRow = (r: Row, joinValue: string) => {
    if (!joinValue) return;
    const sel = `${r.fhir_path}||${r.ehi_join_table}.${r.ehi_join_column}||${joinValue}`;
    (byKey.get(sel) ?? byKey.set(sel, []).get(sel)!).push(r);
  };
  for (const r of rows) {
    indexRow(r, r.epic_local_code);
    if (r.concept_display && r.concept_display !== r.epic_local_code) indexRow(r, r.concept_display);
  }
  const out = new Map<string, Row[]>();
  for (const b of bridges) {
    let pairs: { fhirId: string; joinValue: string }[];
    try {
      pairs = b.pairs();
    } catch {
      continue; // missing table/column in this specimen — skip silently
    }
    for (const p of pairs) {
      const key = `${b.fhir_path}||${b.selector}||${p.joinValue}`;
      const cwRows = byKey.get(key);
      if (!cwRows) continue;
      const cur = out.get(p.fhirId) ?? out.set(p.fhirId, []).get(p.fhirId)!;
      for (const r of cwRows) cur.push(r);
    }
  }
  return out;
}

/** Resolve the CodeableConcept node(s) a single field segment designates, descending
 *  through arrays. Returns the list of CodeableConcept objects the segment points at. */
function ccNodesForField(node: any, field: string): any[] {
  if (Array.isArray(node)) {
    const out: any[] = [];
    for (const x of node) out.push(...ccNodesForField(x, field));
    return out;
  }
  if (!node || typeof node !== "object") return [];
  const v = node[field];
  if (v === undefined) return []; // never invent the field; only enrich what exists
  return Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : [v];
}

/** Ensure the CodeableConcept(s) the fhir_path designates have a coding[] and return
 *  the FIRST such coding[] (additive). Supports both top-level paths
 *  ("Condition.code" / "Coverage.type") and nested ones that descend through an array
 *  ("MedicationRequest.dosageInstruction.route"). */
function targetCodingArray(resource: any, fhir_path: string): Coding[] | undefined {
  const segments = fhir_path.split(".").slice(1); // drop resource type
  if (!segments.length) return undefined;
  let nodes: any[] = [resource];
  for (const seg of segments) {
    const next: any[] = [];
    for (const n of nodes) next.push(...ccNodesForField(n, seg));
    nodes = next;
    if (!nodes.length) return undefined;
  }
  // Prefer a CodeableConcept that already has a coding[]; else the first one.
  const ccObjs = nodes.filter((x) => x && typeof x === "object");
  if (!ccObjs.length) return undefined;
  const node = ccObjs.find((x) => Array.isArray(x.coding)) ?? ccObjs[0];
  if (!node || typeof node !== "object") return undefined;
  if (!Array.isArray(node.coding)) node.coding = [];
  return node.coding;
}

// ============================================================================
// IDENTIFIER LAYERING (TODO #4) — parallel to the terminology pass above.
//
// crosswalk/identifiers.csv carries registry/enterprise/config identifiers the EHI
// export does NOT hold but that the reference keys to an entity PRESENT in the EHI by
// its natural key (SER PROV_ID / PAT_ID / serv-area org id / a config-wide custodian
// row). For each resource we decode its natural key from its minted FHIR id and APPEND
// the matching identifiers to resource.identifier[] (or, for the custodian row, to
// custodian.identifier). ADDITIVE + IDEMPOTENT: a row is never added if an identifier
// with the same {system,value} is already present (so an EHI-derived identifier is
// never overwritten or duplicated). HONESTY: allowed because each row is anchored to a
// real EHI entity and tagged provenance=crosswalk — not a verbatim no-anchor copy.
// ============================================================================
interface IdRow {
  entity_type: string;
  entity_natural_key: string;
  target_path: string; // "identifier" | "custodian.identifier"
  target_system: string;
  target_value: string;
  target_type_text: string;
  target_use: string;
}

function loadIdentifierCrosswalk(): IdRow[] {
  if (!existsSync(IDENTIFIERS_CSV)) return [];
  const rows = parseCSV(readFileSync(IDENTIFIERS_CSV, "utf8"));
  if (!rows.length) return [];
  const hdr = rows[0];
  const idx = Object.fromEntries(hdr.map((h, i) => [h.trim(), i]));
  const get = (r: string[], k: string) => (r[idx[k]] ?? "").trim();
  return rows
    .slice(1)
    .filter((r) => r.length >= hdr.length - 2)
    .map((r) => ({
      entity_type: get(r, "entity_type"),
      entity_natural_key: get(r, "entity_natural_key"),
      target_path: get(r, "target_path") || "identifier",
      target_system: get(r, "target_system"),
      target_value: get(r, "target_value"),
      target_type_text: get(r, "target_type_text"),
      target_use: get(r, "target_use"),
    }))
    .filter((r) => r.entity_type && r.target_system && r.target_value);
}

/** Decode an entity natural key from a minted FHIR id, mirroring lib/ids conventions. */
function naturalKeyFromId(resourceType: string, fhirId: string): string | undefined {
  if (!fhirId) return undefined;
  if (resourceType === "Practitioner" && fhirId.startsWith("prac-")) return fhirId.slice(5);
  if (resourceType === "Patient" && fhirId.startsWith("pat-")) return fhirId.slice(4);
  if (resourceType === "Organization" && fhirId.startsWith("org-")) return fhirId.slice(4);
  return undefined;
}

/** Append an identifier object to arr iff no entry with the same {system,value} exists. */
function appendIdentifier(arr: any[], r: IdRow): boolean {
  const exists = arr.some(
    (i) => i?.system === r.target_system && String(i?.value) === r.target_value,
  );
  if (exists) return false;
  const add: any = { system: r.target_system, value: r.target_value };
  if (r.target_use) add.use = r.target_use;
  if (r.target_type_text) add.type = { text: r.target_type_text };
  arr.push(add);
  return true;
}

/**
 * Layer the identifier crosswalk onto a single resource (additive, idempotent).
 * Returns the number of identifiers added. `tally` lets the caller account per-system.
 */
function layerIdentifiers(
  resource: any,
  byEntity: Map<string, IdRow[]>,
  custodianRows: IdRow[],
  tally: (r: IdRow, resKey: string) => void,
): void {
  const resKey = `${resource.resourceType}/${resource.id}`;

  // (1) resource.identifier[] rows keyed by the entity natural key.
  const nk = naturalKeyFromId(resource.resourceType, resource.id);
  if (nk) {
    const matches = byEntity.get(`${resource.resourceType}||${nk}`);
    if (matches) {
      const additive = matches.filter((r) => r.target_path === "identifier");
      if (additive.length) {
        if (!Array.isArray(resource.identifier)) resource.identifier = [];
        for (const r of additive) if (appendIdentifier(resource.identifier, r)) tally(r, resKey);
      }
    }
  }

  // (2) DocumentReference custodian.identifier — config-wide ("*") rows. Only land on a
  // note that ALREADY has a custodian (never invent the element), additive.
  if (resource.resourceType === "DocumentReference" && resource.custodian && custodianRows.length) {
    const cust = resource.custodian;
    for (const r of custodianRows) {
      // custodian.identifier is single-valued in FHIR R4; treat it as a one-element list.
      if (cust.identifier && cust.identifier.system === r.target_system && String(cust.identifier.value) === r.target_value) {
        continue; // already present (idempotent)
      }
      if (cust.identifier) continue; // never overwrite an existing (EHI-derived) custodian id
      cust.identifier = { system: r.target_system, value: r.target_value };
      tally(r, resKey);
    }
  }
}

// ---- main ------------------------------------------------------------------
function main() {
  if (!existsSync(IN_DIR)) {
    console.error(`input dir not found: ${IN_DIR}`);
    process.exit(1);
  }
  const rows = loadCrosswalk();
  const primaryIndex = buildPrimaryIndex(rows);
  const fallbackIndex = buildFallbackIndex(rows);

  // identifier crosswalk (TODO #4): index entity rows by `${entity_type}||${natural_key}`,
  // and collect the config-wide custodian rows separately.
  const idRows = APPLY_IDENTIFIERS ? loadIdentifierCrosswalk() : [];
  const idByEntity = new Map<string, IdRow[]>();
  const custodianRows: IdRow[] = [];
  for (const r of idRows) {
    if (r.entity_type === "DocumentReference" && r.target_path === "custodian.identifier") {
      custodianRows.push(r);
      continue;
    }
    const k = `${r.entity_type}||${r.entity_natural_key}`;
    (idByEntity.get(k) ?? idByEntity.set(k, []).get(k)!).push(r);
  }

  // Mirror IN_DIR exactly: wipe stale resource files in OUT_DIR first so the enriched dir is a
  // faithful copy of the (possibly lean) baseline + crosswalk layer — never carrying an orphan
  // from an earlier build (e.g. a Binary.json left by a prior --embed-attachments run).
  mkdirSync(OUT_DIR, { recursive: true });
  for (const f of readdirSync(OUT_DIR).filter((f) => f.endsWith(".json")))
    rmSync(resolve(OUT_DIR, f));

  let codingsAdded = 0;
  const touchedResources = new Set<string>();
  const bySystem = new Map<string, number>();
  let filesWritten = 0;

  // identifier-pass accounting (kept separate from the coding tally so the summary can
  // report the two layers distinctly).
  let identifiersAdded = 0;
  const idTouched = new Set<string>();
  const idBySystem = new Map<string, number>();
  const idTally = (r: IdRow, resKey: string) => {
    identifiersAdded++;
    idTouched.add(resKey);
    idBySystem.set(r.target_system, (idBySystem.get(r.target_system) ?? 0) + 1);
  };

  const tally = (r: Row, resKey: string) => {
    codingsAdded++;
    touchedResources.add(resKey);
    bySystem.set(r.target_system, (bySystem.get(r.target_system) ?? 0) + 1);
  };

  const files = readdirSync(IN_DIR).filter(
    (f) => f.endsWith(".json") && f !== "bundle.json",
  );

  for (const f of files) {
    const arr = JSON.parse(readFileSync(resolve(IN_DIR, f), "utf8"));
    if (!Array.isArray(arr)) {
      // copy through non-array JSON untouched
      writeFileSync(resolve(OUT_DIR, f), JSON.stringify(arr, null, 2));
      filesWritten++;
      continue;
    }
    for (const resource of arr) {
      const resKey = `${resource.resourceType}/${resource.id}`;

      // PRIMARY: every coding[] anywhere in the resource — but a row only enriches
      // the FHIR element its crosswalk fhir_path designates. The same Epic-local
      // code can appear on more than one element (e.g. a BP flowsheet id is stamped
      // on both Observation.code and each Observation.component.code); without this
      // gate the panel-level standard codes would leak onto the component codings,
      // landing them on the wrong element. We match the row's fhir_path element
      // ("code", "type", "vaccineCode", "component.code", …) to the coding array's
      // own element path.
      eachCodingArray(resource, (codingArr, elemPath, cc) => {
        // snapshot the codings we may key on (don't react to ones we add this pass)
        const keys = codingArr
          .filter((c) => c.system && c.code)
          .map((c) => c.system + "||" + c.code);
        for (const k of keys) {
          const matches = primaryIndex.get(k);
          if (!matches) continue;
          for (const r of matches) {
            const want = fhirPathElement(r.fhir_path);
            // Only enrich the designated element. If a row's fhir_path lacks an
            // element (bare resource type), fall back to enriching wherever the
            // Epic code is found (prior behavior) rather than dropping it.
            if (want && want !== elemPath) continue;
            // Disambiguating text predicate (e.g. BP component halves that REUSE
            // the same Epic-local coding {707679,5} but differ only by code.text
            // "BP Systolic" / "BP Diastolic"): the row applies ONLY to the
            // CodeableConcept whose own `text` equals the predicate, so the
            // systolic LOINC never lands on the diastolic half and vice-versa.
            const wantText = fhirPathTextPredicate(r.fhir_path);
            if (wantText !== undefined && (cc?.text ?? "") !== wantText) continue;
            if (appendCoding(codingArr, r)) tally(r, resKey);
          }
        }
      });

      // FALLBACK: only when keyed by the minted id (independent of PRIMARY; the
      // bridges are built for resources that carry no Epic-local coding, so this
      // never double-attaches — appendCoding is idempotent regardless).
      const fbRows = fallbackIndex.get(resource.id);
      if (fbRows && fbRows.length) {
        for (const r of fbRows) {
          const arr2 = targetCodingArray(resource, r.fhir_path);
          if (!arr2) continue;
          if (appendCoding(arr2, r)) tally(r, resKey);
        }
      }

      // IDENTIFIER LAYER (TODO #4): append registry/enterprise/config identifiers keyed
      // to this resource's entity natural key (additive, idempotent).
      if (APPLY_IDENTIFIERS && (idByEntity.size || custodianRows.length)) {
        layerIdentifiers(resource, idByEntity, custodianRows, idTally);
      }
    }
    writeFileSync(resolve(OUT_DIR, f), JSON.stringify(arr, null, 2));
    filesWritten++;
  }

  // ---- summary -------------------------------------------------------------
  console.error(`\ncrosswalk pass: ${IN_DIR} -> ${OUT_DIR}`);
  console.error(`  crosswalk rows used: ${rows.length} (${INCLUDE_ALL ? "all" : "ehi_verified only"})`);
  console.error(`  files written:       ${filesWritten}`);
  console.error(`  codings added:       ${codingsAdded}`);
  console.error(`  resources touched:   ${touchedResources.size}`);
  console.error(`  by target_system:`);
  for (const [sys, n] of [...bySystem.entries()].sort((a, b) => b[1] - a[1])) {
    console.error(`    ${String(n).padStart(4)}  ${sys}`);
  }

  if (APPLY_IDENTIFIERS) {
    console.error(`\nidentifier layer (TODO #4):`);
    console.error(`  identifier crosswalk rows: ${idRows.length}`);
    console.error(`  identifiers added:         ${identifiersAdded}`);
    console.error(`  resources touched:         ${idTouched.size}`);
    console.error(`  by target_system:`);
    for (const [sys, n] of [...idBySystem.entries()].sort((a, b) => b[1] - a[1])) {
      console.error(`    ${String(n).padStart(4)}  ${sys}`);
    }
  }

  // machine-readable last line for callers (build.ts).
  console.error(
    `ANSWERKEY SUMMARY: ${codingsAdded} codings / ${touchedResources.size} resources / ${filesWritten} files` +
      (APPLY_IDENTIFIERS ? ` / ${identifiersAdded} identifiers / ${idTouched.size} id-resources` : ""),
  );
}

main();
