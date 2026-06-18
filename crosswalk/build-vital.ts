#!/usr/bin/env bun
/**
 * build-vital.ts — reconstruct the Epic-local -> standard crosswalk excerpt for the
 * "vital" area (vital-signs Observations).
 *
 * Anchor: vital Observation.code.coding carries the Epic flowsheet measure id under
 *   urn:oid:1.2.840.114350.1.13.283.2.7.2.707679  (code = FLO_MEAS_ID)
 *   and the open.epic.com observation-flowsheet-id (a hashed token for the same measure)
 * side-by-side with LOINC codings. The EHI ships the numeric FLO_MEAS_ID in
 * IP_FLWSHT_MEAS.FLO_MEAS_ID, so that is the join key. We pair (FLO_MEAS_ID -> LOINC).
 *
 * Output: crosswalk/vital.csv (RFC-4180).
 */
import { Database } from "bun:sqlite";
import { resolve } from "path";
import { readFileSync, writeFileSync } from "fs";

const ROOT = resolve(import.meta.dir, "..");
const DB_PATH = process.env.EHI_DB ?? resolve(ROOT, "ehi.sqlite");
const db = new Database(DB_PATH, { readonly: true });

const FLO_OID = "urn:oid:1.2.840.114350.1.13.283.2.7.2.707679";
const LOINC = "http://loinc.org";

// --- load vital-signs observations ---
const raw = JSON.parse(readFileSync(resolve(ROOT, "fhir-target", "Observation.json"), "utf8"));
const arr: any[] = Array.isArray(raw) ? raw : raw.entry ? raw.entry.map((e: any) => e.resource) : [raw];
const obs = arr.filter((r) => r.resourceType === "Observation");
const vitals = obs.filter((o) =>
  (o.category || []).some((c: any) => (c.coding || []).some((cc: any) => cc.code === "vital-signs"))
);

// --- collect distinct concepts: FLO_MEAS_ID -> {display, loincs[]} ---
type Concept = { floId: string; display: string; loincs: Map<string, string> };
const concepts = new Map<string, Concept>();

for (const v of vitals) {
  const codings: any[] = v.code?.coding || [];
  const flo = codings.find((c) => c.system === FLO_OID);
  if (!flo) continue;
  if (!concepts.has(flo.code)) {
    concepts.set(flo.code, { floId: flo.code, display: flo.display || v.code?.text || "", loincs: new Map() });
  }
  const concept = concepts.get(flo.code)!;
  for (const c of codings) {
    if (c.system === LOINC) concept.loincs.set(c.code, c.display || "");
  }
}

// --- EHI verification helper (cache by FLO_MEAS_ID) ---
const verifyStmt = db.query<{ FLO_MEAS_ID: string; FLO_MEAS_ID_DISP_NAME: string; n: number }, [string]>(
  "SELECT FLO_MEAS_ID, MAX(FLO_MEAS_ID_DISP_NAME) AS FLO_MEAS_ID_DISP_NAME, COUNT(*) AS n FROM IP_FLWSHT_MEAS WHERE FLO_MEAS_ID = ?"
);

// --- assemble rows ---
type Row = string[];
const HEADER = [
  "area", "fhir_path", "concept_display", "ehi_join_table", "ehi_join_column",
  "epic_local_system", "epic_local_code", "epic_local_display", "target_system",
  "target_code", "target_display", "anchor_method", "ehi_verified", "confidence", "notes",
];
const rows: Row[] = [];

// Generic panel LOINCs that Epic stamps on every flowsheet vital (not the specific concept's code)
const GENERIC = new Set(["8716-3"]); // "Vital signs"

const sortedConcepts = [...concepts.values()].sort((a, b) => Number(a.floId) - Number(b.floId));

let verifiedRows = 0;
let unanchored = 0;

for (const concept of sortedConcepts) {
  const r = verifyStmt.get(concept.floId);
  const ehiVerified = r && r.n > 0;
  const ehiDisp = r?.FLO_MEAS_ID_DISP_NAME || "";

  const loincs = [...concept.loincs.entries()];
  if (loincs.length === 0) {
    // standard code absent for this concept in target -> nothing to anchor as LOINC
    continue;
  }
  const specificLoincs = loincs.filter(([code]) => !GENERIC.has(code));
  const hasSpecific = specificLoincs.length > 0;

  for (const [code, disp] of loincs) {
    const isGeneric = GENERIC.has(code);
    const ehi = ehiVerified ? "yes" : "no";
    // confidence: dual-coding + verified = high; generic panel code = medium (not concept-specific)
    let confidence: string;
    if (isGeneric) confidence = "medium";
    else confidence = ehiVerified ? "high" : "medium";

    const notes: string[] = [];
    if (isGeneric) notes.push("generic flowsheet panel LOINC stamped on all vitals, not concept-specific");
    if (concept.loincs.size > 1 && !isGeneric) notes.push("1:n FLO_MEAS_ID->LOINC fan-out");
    if (!hasSpecific && isGeneric) notes.push("only generic LOINC present for this measure in target");

    if (ehiVerified) verifiedRows++;
    if (!ehiVerified) unanchored++;

    rows.push([
      "vital",
      "Observation.code",
      concept.display,
      "IP_FLWSHT_MEAS",
      "FLO_MEAS_ID",
      FLO_OID,
      concept.floId,
      ehiDisp || concept.display,
      LOINC,
      code,
      disp,
      "dual-coding",
      ehi,
      confidence,
      notes.join("; "),
    ]);
  }
}

// --- BP component LOINCs (systolic / diastolic) -----------------------------
// The packed "BP" flowsheet measure (FLO_MEAS_ID 5) is split into two
// Observation.component[] halves whose code REUSES the same Epic-local measure
// coding ({707679, 5, "BP"}) — the EHI has no per-half measure id. The only thing
// that distinguishes the halves in the baseline is the derived component
// code.text ("BP Systolic" / "BP Diastolic"). The standard per-half LOINCs
// (8480-6 systolic, 8462-4 diastolic) are NOT carried by the export, so we
// deliver them through the answer key, targeting Observation.component.code and
// gating the half via a [text=…] predicate on the fhir_path so the apply pass
// attaches each LOINC to the correct component only (never cross-contaminating).
// These LOINC↔half mappings are the standard, deterministic FHIR vital-signs
// representation (US Core / LOINC blood-pressure panel 85354-9 children).
const BP_FLO = sortedConcepts.find((c) => c.floId === "5");
if (BP_FLO) {
  const r = verifyStmt.get("5");
  const ehiVerified = r && r.n > 0;
  const ehiDisp = r?.FLO_MEAS_ID_DISP_NAME || BP_FLO.display;
  const halves: [string, string, string][] = [
    // [component code.text gate, LOINC code, LOINC display]
    ["BP Systolic", "8480-6", "Systolic blood pressure"],
    ["BP Diastolic", "8462-4", "Diastolic blood pressure"],
  ];
  for (const [textGate, code, disp] of halves) {
    rows.push([
      "vital",
      `Observation.component.code[text=${textGate}]`,
      `Blood Pressure (${textGate.replace(/^BP /, "")})`,
      "IP_FLWSHT_MEAS",
      "FLO_MEAS_ID",
      FLO_OID,
      "5",
      ehiDisp,
      LOINC,
      code,
      disp,
      "component-split",
      ehiVerified ? "yes" : "no",
      "high",
      "per-half BP component LOINC; reuses packed FLO_MEAS_ID 5 coding, disambiguated by component code.text",
    ]);
  }
}

// --- CSV serialization (RFC-4180) ---
function field(s: string): string {
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
const lines = [HEADER.join(","), ...rows.map((row) => row.map(field).join(","))];
const out = lines.join("\r\n") + "\r\n";
writeFileSync(resolve(ROOT, "crosswalk", "vital.csv"), out);

const distinctConcepts = sortedConcepts.filter((c) => c.loincs.size > 0).length;
console.error(JSON.stringify({
  rows: rows.length,
  verifiedRows,
  distinctConcepts,
  unanchored,
}, null, 2));
