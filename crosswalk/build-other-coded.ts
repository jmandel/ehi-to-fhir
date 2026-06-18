#!/usr/bin/env bun
/**
 * build-other-coded.ts — reconstruct the Epic-local -> standard crosswalk excerpt for the
 * "other" area, covering the miscellaneous coded elements across:
 *   - DocumentReference.type   (Epic note-type code  -> LOINC)        dual-coding
 *   - Specimen.type            (Epic specimen-type code -> SNOMED)    dual-coding
 *   - Coverage.type            (Epic payor -> NAHDO SOPT)             content-match
 *   - Encounter.type           (CPT E/M charge — residual, unanchored)
 *   - CarePlan.category        (fixed value-set categoricals)         value-set-literal
 *   - Practitioner.qualification (none present — no rows)
 *
 * ANCHORING NOTES (every code below comes from real data — target FHIR and/or the EHI):
 *
 * DocumentReference.type: the target code.coding[] carries an Epic-local note-type code
 *   (system urn:oid:1.2.840.114350.1.13.283.2.7.4.737880.5010, codes 1/2/36/37) side-by-side
 *   with LOINC document-type codes -> dual-coding. The EHI does NOT ship the numeric note-type
 *   _C value, but it ships the *display name* in HNO_INFO.IP_NOTE_TYPE_C_NAME, which equals the
 *   target coding's display verbatim. We use HNO_INFO.IP_NOTE_TYPE_C_NAME as the join column and
 *   verify the row exists by that display. epic_local_code = the numeric code from the target.
 *
 * Specimen.type: target carries Epic-local specimen-type code
 *   (system urn:oid:1.2.840.114350.1.13.283.2.7.4.798268.300, codes 188/54/100230) side-by-side
 *   with SNOMED -> dual-coding. The EHI does not ship the numeric specimen-type _C, but ships the
 *   display in ORDER_PROC.SPECIMEN_TYPE_C_NAME (verbatim) and even ships the SNOMED itself in
 *   SPEC_TYPE_SNOMED.TYPE_SNOMED_CT. Join column = ORDER_PROC.SPECIMEN_TYPE_C_NAME.
 *
 * Coverage.type: only a standard NAHDO Source-of-Payment-Typology coding is present (no Epic-local
 *   coding in the array). The EHI ships the payor master key COVERAGE.PAYOR_ID, which is the local
 *   anchor a real export would join on. anchor_method=content-match (matched the single coverage by
 *   payor). epic_local_code = PAYOR_ID.
 *
 * Encounter.type: the only standard system is CPT, and it is the per-encounter E/M *charge* code in
 *   its own type[] entry — NOT a translation of the Epic visit type. There is no Epic-local code
 *   paired with it in the array. The CPT charge code IS, however, shipped directly by the EHI on the
 *   claim line in INV_CLM_LN_ADDL.PROC_OR_REV_CODE — so most E/M codes verify against that column
 *   (the EHI carries the standard code itself). Codes with no claim-line presence stay ehi_verified=no.
 *   Encounter.class is derivable, not stored.
 *
 * CarePlan.category: fixed US-Core / SNOMED value-set categoricals stamped by the FHIR server
 *   (assess-plan, Longitudinal, Encounter Level). No Epic-local code; value-set-literal, no EHI key.
 *
 * Output: crosswalk/other-coded.csv (RFC-4180).
 */
import { Database } from "bun:sqlite";
import { resolve } from "path";
import { readFileSync, writeFileSync } from "fs";

const ROOT = resolve(import.meta.dir, "..");
const DB_PATH = process.env.EHI_DB ?? resolve(ROOT, "ehi.sqlite");
const db = new Database(DB_PATH, { readonly: true });

const LOINC = "http://loinc.org";
const SNOMED = "http://snomed.info/sct";
const CPT = "http://www.ama-assn.org/go/cpt";
const SOPT = "https://nahdo.org/sopt";
const USCORE_CP = "http://hl7.org/fhir/us/core/CodeSystem/careplan-category";

const NOTE_OID = "urn:oid:1.2.840.114350.1.13.283.2.7.4.737880.5010";
const SPEC_OID = "urn:oid:1.2.840.114350.1.13.283.2.7.4.798268.300";

function load(name: string): any[] {
  const raw = JSON.parse(readFileSync(resolve(ROOT, "fhir-target", name), "utf8"));
  return Array.isArray(raw) ? raw : raw.entry ? raw.entry.map((e: any) => e.resource) : [raw];
}

type Row = string[];
const HEADER = [
  "area", "fhir_path", "concept_display", "ehi_join_table", "ehi_join_column",
  "epic_local_system", "epic_local_code", "epic_local_display", "target_system",
  "target_code", "target_display", "anchor_method", "ehi_verified", "confidence", "notes",
];
const rows: Row[] = [];
let verifiedRows = 0;
let unanchored = 0;
const concepts = new Set<string>();

function add(r: Omit<Record<string, string>, never> & {
  fhir_path: string; concept_display: string; ehi_join_table: string; ehi_join_column: string;
  epic_local_system: string; epic_local_code: string; epic_local_display: string;
  target_system: string; target_code: string; target_display: string;
  anchor_method: string; ehi_verified: string; confidence: string; notes: string;
}) {
  rows.push([
    "other", r.fhir_path, r.concept_display, r.ehi_join_table, r.ehi_join_column,
    r.epic_local_system, r.epic_local_code, r.epic_local_display, r.target_system,
    r.target_code, r.target_display, r.anchor_method, r.ehi_verified, r.confidence, r.notes,
  ]);
  if (r.ehi_verified === "yes") verifiedRows++; else unanchored++;
}

// ---------------------------------------------------------------------------
// 1) DocumentReference.type  (Epic note-type code -> LOINC, dual-coding)
// ---------------------------------------------------------------------------
const docs = load("DocumentReference.json").filter((r) => r.resourceType === "DocumentReference");
// distinct concept: local note-type code -> {display, loincs map}
type DocConcept = { code: string; display: string; loincs: Map<string, string> };
const docConcepts = new Map<string, DocConcept>();
const docNoLocal = new Map<string, { display: string; loincs: Map<string, string> }>(); // residual

for (const d of docs) {
  const codings: any[] = d.type?.coding || [];
  const local = codings.find((c) => c.system === NOTE_OID);
  const loincs = codings.filter((c) => c.system === LOINC && c.code);
  if (local) {
    if (!docConcepts.has(local.code)) {
      docConcepts.set(local.code, { code: local.code, display: local.display || d.type?.text || "", loincs: new Map() });
    }
    const c = docConcepts.get(local.code)!;
    for (const l of loincs) if (l.display) c.loincs.set(l.code, l.display);
  } else {
    const key = d.type?.text || "(no type)";
    if (!docNoLocal.has(key)) docNoLocal.set(key, { display: key, loincs: new Map() });
    const c = docNoLocal.get(key)!;
    for (const l of loincs) c.loincs.set(l.code, l.display || "");
  }
}

const verifyNote = db.query<{ n: number }, [string]>(
  "SELECT COUNT(*) AS n FROM HNO_INFO WHERE IP_NOTE_TYPE_C_NAME = ?"
);

for (const c of [...docConcepts.values()].sort((a, b) => Number(a.code) - Number(b.code))) {
  concepts.add("doc:" + c.code);
  const verified = (verifyNote.get(c.display)?.n ?? 0) > 0;
  const loincs = [...c.loincs.entries()];
  const fanout = loincs.length > 1;
  for (const [lc, ld] of loincs) {
    add({
      fhir_path: "DocumentReference.type",
      concept_display: c.display,
      ehi_join_table: "HNO_INFO",
      ehi_join_column: "IP_NOTE_TYPE_C_NAME",
      epic_local_system: NOTE_OID,
      epic_local_code: c.code,
      epic_local_display: c.display,
      target_system: LOINC,
      target_code: lc,
      target_display: ld,
      anchor_method: "dual-coding",
      ehi_verified: verified ? "yes" : "no",
      confidence: verified ? (fanout ? "high" : "high") : "medium",
      notes: [
        "EHI ships the note-type display in HNO_INFO.IP_NOTE_TYPE_C_NAME (verbatim), not the numeric _C; numeric code taken from target coding",
        fanout ? "1:n note-type->LOINC fan-out" : "",
      ].filter(Boolean).join("; "),
    });
  }
}
// residual DocRef concepts with a LOINC but no Epic-local code in the array
for (const c of docNoLocal.values()) {
  for (const [lc, ld] of c.loincs.entries()) {
    concepts.add("docres:" + lc);
    add({
      fhir_path: "DocumentReference.type",
      concept_display: c.display,
      ehi_join_table: "",
      ehi_join_column: "",
      epic_local_system: "",
      epic_local_code: "",
      epic_local_display: "",
      target_system: LOINC,
      target_code: lc,
      target_display: ld,
      anchor_method: "dual-coding",
      ehi_verified: "no",
      confidence: "low",
      notes: "LOINC-only document type in target (no Epic-local note-type coding in the array); residual gap",
    });
  }
}

// ---------------------------------------------------------------------------
// 2) Specimen.type  (Epic specimen-type code -> SNOMED, dual-coding)
// ---------------------------------------------------------------------------
const specs = load("Specimen.json").filter((r) => r.resourceType === "Specimen");
type SpecConcept = { code: string; display: string; snomeds: Map<string, string> };
const specConcepts = new Map<string, SpecConcept>();
for (const s of specs) {
  const codings: any[] = s.type?.coding || [];
  const local = codings.find((c) => c.system === SPEC_OID);
  if (!local) continue;
  if (!specConcepts.has(local.code)) {
    specConcepts.set(local.code, { code: local.code, display: local.display || s.type?.text || "", snomeds: new Map() });
  }
  const c = specConcepts.get(local.code)!;
  for (const sn of codings) if (sn.system === SNOMED && sn.code) c.snomeds.set(sn.code, sn.display || "");
}

const verifySpec = db.query<{ n: number }, [string]>(
  "SELECT COUNT(*) AS n FROM ORDER_PROC WHERE SPECIMEN_TYPE_C_NAME = ?"
);
const verifySpecSnomed = db.query<{ n: number }, [string]>(
  "SELECT COUNT(*) AS n FROM SPEC_TYPE_SNOMED WHERE TYPE_SNOMED_CT = ?"
);

for (const c of [...specConcepts.values()].sort((a, b) => Number(a.code) - Number(b.code))) {
  concepts.add("spec:" + c.code);
  const verified = (verifySpec.get(c.display)?.n ?? 0) > 0;
  const snomeds = [...c.snomeds.entries()];
  if (snomeds.length === 0) {
    // local specimen type present in target but no SNOMED coding (e.g. Serum) -> nothing standard to attach
    // still record as residual so the missing-standard gap is explicit
    add({
      fhir_path: "Specimen.type",
      concept_display: c.display,
      ehi_join_table: "ORDER_PROC",
      ehi_join_column: "SPECIMEN_TYPE_C_NAME",
      epic_local_system: SPEC_OID,
      epic_local_code: c.code,
      epic_local_display: c.display,
      target_system: SNOMED,
      target_code: "",
      target_display: "",
      anchor_method: "dual-coding",
      ehi_verified: verified ? "yes" : "no",
      confidence: "low",
      notes: "Epic specimen-type present but no SNOMED coding populated in target for this type (empty snomed.info/sct coding); no standard code to attach",
    });
    continue;
  }
  for (const [sc, sd] of snomeds) {
    const snomedInEhi = (verifySpecSnomed.get(sc)?.n ?? 0) > 0;
    add({
      fhir_path: "Specimen.type",
      concept_display: c.display,
      ehi_join_table: "ORDER_PROC",
      ehi_join_column: "SPECIMEN_TYPE_C_NAME",
      epic_local_system: SPEC_OID,
      epic_local_code: c.code,
      epic_local_display: c.display,
      target_system: SNOMED,
      target_code: sc,
      target_display: sd,
      anchor_method: "dual-coding",
      ehi_verified: verified ? "yes" : "no",
      confidence: verified ? "high" : "medium",
      notes: [
        "EHI ships specimen-type display in ORDER_PROC.SPECIMEN_TYPE_C_NAME (verbatim), not the numeric _C; numeric code taken from target coding",
        snomedInEhi ? "EHI also ships this SNOMED directly in SPEC_TYPE_SNOMED.TYPE_SNOMED_CT" : "",
      ].filter(Boolean).join("; "),
    });
  }
}

// ---------------------------------------------------------------------------
// 3) Coverage.type  (Epic payor -> NAHDO SOPT, content-match)
// ---------------------------------------------------------------------------
const covs = load("Coverage.json").filter((r) => r.resourceType === "Coverage");
const verifyPayor = db.query<{ n: number }, [string]>(
  "SELECT COUNT(*) AS n FROM COVERAGE WHERE PAYOR_ID = ?"
);
for (const cov of covs) {
  const sopt = (cov.type?.coding || []).find((c: any) => c.system === SOPT);
  if (!sopt) continue;
  const payor = (cov.payor || []).find((p: any) => p.identifier?.system?.includes("payer-id"));
  const payorId = payor?.identifier?.value || "";
  concepts.add("cov:" + sopt.code);
  const verified = payorId ? (verifyPayor.get(payorId)?.n ?? 0) > 0 : false;
  add({
    fhir_path: "Coverage.type",
    concept_display: cov.type?.text || sopt.display || "",
    ehi_join_table: "COVERAGE",
    ehi_join_column: "PAYOR_ID",
    epic_local_system: "Epic Payor master (COVERAGE.PAYOR_ID)",
    epic_local_code: payorId,
    epic_local_display: payor?.display || "",
    target_system: SOPT,
    target_code: sopt.code,
    target_display: sopt.display || "",
    anchor_method: "content-match",
    ehi_verified: verified ? "yes" : "no",
    confidence: verified ? "medium" : "low",
    notes: "NAHDO Source-of-Payment-Typology is the only standard coding on Coverage.type (no Epic-local coding in the array); FHIR server derives SOPT from the payor/financial-class. Anchored to payor master key COVERAGE.PAYOR_ID; SOPT not derivable from EHI alone",
  });
}

// ---------------------------------------------------------------------------
// 4) Encounter.type  (CPT E/M charge — residual, unanchored)
// ---------------------------------------------------------------------------
const encs = load("Encounter.json").filter((r) => r.resourceType === "Encounter");
const cptSet = new Map<string, string>();
for (const e of encs) {
  for (const t of e.type || []) {
    for (const c of t.coding || []) {
      if (c.system === CPT && c.code) cptSet.set(c.code, c.display || "");
    }
  }
}
const verifyClaimCpt = db.query<{ n: number }, [string]>(
  "SELECT COUNT(*) AS n FROM INV_CLM_LN_ADDL WHERE PROC_OR_REV_CODE = ?"
);
for (const [code, disp] of [...cptSet.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  concepts.add("enc-cpt:" + code);
  const onClaim = (verifyClaimCpt.get(code)?.n ?? 0) > 0;
  add({
    fhir_path: "Encounter.type",
    concept_display: disp,
    ehi_join_table: onClaim ? "INV_CLM_LN_ADDL" : "",
    ehi_join_column: onClaim ? "PROC_OR_REV_CODE" : "",
    epic_local_system: onClaim ? "http://www.ama-assn.org/go/cpt" : "",
    epic_local_code: onClaim ? code : "",
    epic_local_display: onClaim ? disp : "",
    target_system: CPT,
    target_code: code,
    target_display: disp,
    anchor_method: "content-match",
    ehi_verified: onClaim ? "yes" : "no",
    confidence: onClaim ? "medium" : "low",
    notes: onClaim
      ? "CPT E/M code is a separate type[] entry (the per-encounter charge), not a translation of the Epic visit type. The CPT itself is shipped on the claim line in INV_CLM_LN_ADDL.PROC_OR_REV_CODE (the EHI carries the standard code directly), so the join fires. Encounter.class is derivable not stored"
      : "CPT E/M code is a separate type[] entry (the per-encounter charge), not a translation of the Epic visit type; this code does not appear on any claim line in the EHI (INV_CLM_LN_ADDL.PROC_OR_REV_CODE). Residual gap. Encounter.class is derivable not stored",
  });
}

// ---------------------------------------------------------------------------
// 5) CarePlan.category  (fixed value-set categoricals)
// ---------------------------------------------------------------------------
const cps = load("CarePlan.json").filter((r) => r.resourceType === "CarePlan");
const cpCat = new Map<string, { system: string; code: string; display: string }>();
for (const cp of cps) {
  for (const cat of cp.category || []) {
    for (const c of cat.coding || []) {
      if (c.code) cpCat.set(c.system + "|" + c.code, { system: c.system, code: c.code, display: c.display || "" });
    }
  }
}
for (const c of cpCat.values()) {
  concepts.add("cp:" + c.system + "|" + c.code);
  const isUsCore = c.system === USCORE_CP;
  add({
    fhir_path: "CarePlan.category",
    concept_display: c.display,
    ehi_join_table: "",
    ehi_join_column: "",
    epic_local_system: "",
    epic_local_code: "",
    epic_local_display: "",
    target_system: c.system,
    target_code: c.code,
    target_display: c.display,
    anchor_method: "value-set-literal",
    ehi_verified: "no",
    confidence: "low",
    notes: isUsCore
      ? "Fixed US-Core CarePlan category stamped on every CarePlan by the FHIR server; no Epic-local code, no EHI key"
      : "Fixed SNOMED CarePlan category (longitudinal vs encounter-level plan) stamped by the FHIR server; no Epic-local code, no EHI key",
  });
}

// Practitioner.qualification: inspected — all qualification arrays are empty in this export. No rows.

// ---------------------------------------------------------------------------
// CSV serialization (RFC-4180)
// ---------------------------------------------------------------------------
function field(s: string): string {
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
const lines = [HEADER.join(","), ...rows.map((row) => row.map(field).join(","))];
writeFileSync(resolve(ROOT, "crosswalk", "other-coded.csv"), lines.join("\r\n") + "\r\n");

console.error(JSON.stringify({
  rows: rows.length,
  verifiedRows,
  distinctConcepts: concepts.size,
  unanchored,
}, null, 2));
