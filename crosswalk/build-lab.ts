#!/usr/bin/env bun
/**
 * build-lab.ts — reconstruct the "lab" terminology crosswalk excerpt.
 *
 * Two anchor families:
 *  1) Observation (category=laboratory): component-level dual-coding.
 *     code.coding[] carries LOINC (http://loinc.org) side-by-side with the Epic
 *     component-level key under urn:oid:1.2.840.114350.1.13.283.2.7.2.768282.
 *     That .768282 code IS ORDER_RESULTS.COMPONENT_ID → dual-coding rows.
 *  2) DiagnosticReport: order-level. code.coding carries CPT
 *     (urn:oid:2.16.840.1.113883.6.12) and LOINC. The Epic-local join key the
 *     EHI ships is ORDER_PROC.PROC_ID, reached from the DR's placer identifier
 *     (system urn:oid:1.2.840.114350.1.13.283.2.7.2.798268 = ORDER_PROC_ID).
 *     PROC_ID is not itself a numeric coding in code.coding, so these are
 *     content-match anchors (DR↔ORDER_PROC by placer ORDER_PROC_ID → PROC_ID).
 *
 * Writes crosswalk/lab.csv. Deterministic.
 */
import { db } from "../lib/db";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const COMP_OID = "urn:oid:1.2.840.114350.1.13.283.2.7.2.768282"; // component master → COMPONENT_ID
const LOINC = "http://loinc.org";
const CPT = "urn:oid:2.16.840.1.113883.6.12";
const PLACER_OID = "urn:oid:1.2.840.114350.1.13.283.2.7.2.798268"; // ORDER_PROC_ID (placer)

type Row = {
  area: string; fhir_path: string; concept_display: string;
  ehi_join_table: string; ehi_join_column: string;
  epic_local_system: string; epic_local_code: string; epic_local_display: string;
  target_system: string; target_code: string; target_display: string;
  anchor_method: string; ehi_verified: string; confidence: string; notes: string;
};

const HEADER = "area,fhir_path,concept_display,ehi_join_table,ehi_join_column,epic_local_system,epic_local_code,epic_local_display,target_system,target_code,target_display,anchor_method,ehi_verified,confidence,notes";

function csvField(v: string): string {
  if (v == null) v = "";
  if (/[",\r\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}
function csvRow(r: Row): string {
  return [r.area, r.fhir_path, r.concept_display, r.ehi_join_table, r.ehi_join_column,
    r.epic_local_system, r.epic_local_code, r.epic_local_display, r.target_system,
    r.target_code, r.target_display, r.anchor_method, r.ehi_verified, r.confidence, r.notes]
    .map(csvField).join(",");
}

const load = (f: string) => JSON.parse(readFileSync(resolve(ROOT, "fhir-target", f), "utf8"));

// --- EHI verification helpers ---
const componentExists = (id: string): { name: string } | undefined =>
  db.query("SELECT COMPONENT_ID_NAME AS name FROM ORDER_RESULTS WHERE COMPONENT_ID = ? LIMIT 1").get(id) as any;

const procFromPlacer = (orderProcId: string): { PROC_ID: string; DESCRIPTION: string } | undefined =>
  db.query("SELECT PROC_ID, DESCRIPTION FROM ORDER_PROC WHERE ORDER_PROC_ID = ? LIMIT 1").get(orderProcId) as any;

const procExists = (procId: string): { DESCRIPTION: string } | undefined =>
  db.query("SELECT DESCRIPTION FROM ORDER_PROC WHERE PROC_ID = ? LIMIT 1").get(procId) as any;

const rows: Row[] = [];

// ======================= 1) Observation component-level =======================
const obs = load("Observation.json") as any[];
const labObs = obs.filter(o =>
  (o.category || []).some((c: any) => (c.coding || []).some((cc: any) => cc.code === "laboratory")));

// distinct (componentId, loincCode) -> row
const compSeen = new Set<string>();
for (const o of labObs) {
  const coding = (o.code?.coding || []) as any[];
  const comp = coding.find(c => c.system === COMP_OID);
  if (!comp) continue;
  const loincs = coding.filter(c => c.system === LOINC && c.code); // a concept may carry >1 LOINC
  const compDisp = comp.display || o.code?.text || "";
  for (const l of loincs) {
    const key = comp.code + "|" + l.code;
    if (compSeen.has(key)) continue;
    compSeen.add(key);
    const ehi = componentExists(comp.code);
    const multi = loincs.length > 1;
    rows.push({
      area: "lab",
      fhir_path: "Observation.code",
      concept_display: compDisp,
      ehi_join_table: "ORDER_RESULTS",
      ehi_join_column: "COMPONENT_ID",
      epic_local_system: COMP_OID,
      epic_local_code: comp.code,
      epic_local_display: comp.display || "",
      target_system: LOINC,
      target_code: l.code,
      target_display: l.display || "",
      anchor_method: "dual-coding",
      ehi_verified: ehi ? "yes" : "no",
      confidence: ehi ? "high" : "medium",
      notes: (ehi ? `EHI COMPONENT_ID_NAME="${ehi.name}". ` : "COMPONENT_ID not found in ORDER_RESULTS. ")
        + (multi ? "1:n — component carries multiple LOINC codings (one sibling row per LOINC)." : ""),
    });
  }
}

// ======================= 2) DiagnosticReport order-level =======================
const dr = load("DiagnosticReport.json") as any[];
const drSeen = new Set<string>();
for (const d of dr) {
  const coding = (d.code?.coding || []) as any[];
  const text = d.code?.text || "";
  // placer identifier carries ORDER_PROC_ID
  const placer = (d.identifier || []).find((i: any) => i.system === PLACER_OID);
  const orderProcId = placer?.value;
  const proc = orderProcId ? procFromPlacer(orderProcId) : undefined;
  const procId = proc?.PROC_ID;
  const procDesc = proc?.DESCRIPTION || "";
  const ehiOk = procId ? !!procExists(procId) : false;

  // standard codings on the report: CPT + LOINC
  const standards: { system: string; code: string; display: string }[] = [];
  for (const c of coding) {
    if (c.system === CPT && c.code) standards.push({ system: CPT, code: c.code, display: c.display || "" });
    if (c.system === LOINC && c.code) standards.push({ system: LOINC, code: c.code, display: c.display || "" });
  }
  for (const s of standards) {
    // dedupe by PROC_ID + target (panels repeat across multiple report instances)
    const localCode = procId || `ORDER_PROC_ID:${orderProcId || "?"}`;
    const key = localCode + "|" + s.system + "|" + s.code;
    if (drSeen.has(key)) continue;
    drSeen.add(key);
    rows.push({
      area: "lab",
      fhir_path: "DiagnosticReport.code",
      concept_display: text || procDesc,
      ehi_join_table: "ORDER_PROC",
      ehi_join_column: "PROC_ID",
      epic_local_system: "ORDER_PROC.PROC_ID",
      epic_local_code: localCode,
      epic_local_display: procDesc,
      target_system: s.system,
      target_code: s.code,
      target_display: s.display,
      anchor_method: "content-match",
      ehi_verified: ehiOk ? "yes" : "no",
      confidence: ehiOk ? "medium" : "low",
      notes: `DR↔ORDER_PROC via placer ORDER_PROC_ID=${orderProcId}`
        + (procId ? ` → PROC_ID=${procId} ("${procDesc}").` : " (no PROC_ID resolved).")
        + (s.system === CPT ? " CPT (urn:oid:2.16.840.1.113883.6.12)." : "")
        + " PROC_ID is not dual-coded numerically in code.coding; standard code attached at order level.",
    });
  }
}

// stable sort: path, then concept, then target_system, then target_code
rows.sort((a, b) =>
  a.fhir_path.localeCompare(b.fhir_path) ||
  a.concept_display.localeCompare(b.concept_display) ||
  a.epic_local_code.localeCompare(b.epic_local_code) ||
  a.target_system.localeCompare(b.target_system) ||
  a.target_code.localeCompare(b.target_code));

const out = [HEADER, ...rows.map(csvRow)].join("\r\n") + "\r\n";
writeFileSync(resolve(ROOT, "crosswalk", "lab.csv"), out);

// tally to stderr
const verified = rows.filter(r => r.ehi_verified === "yes").length;
const concepts = new Set(rows.map(r => r.epic_local_code)).size;
const unanchored = rows.filter(r => r.ehi_verified === "no").length;
console.error(JSON.stringify({
  rows: rows.length, verifiedRows: verified, distinctConcepts: concepts, unanchored,
}, null, 2));
