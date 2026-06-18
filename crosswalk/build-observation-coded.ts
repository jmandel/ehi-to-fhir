#!/usr/bin/env bun
/**
 * build-observation-coded.ts — reconstruct the "smartdata" terminology crosswalk
 * excerpt for Observation resources in categories {smartdata, survey, social-history}.
 * Covers BOTH Observation.code AND Observation.valueCodeableConcept.
 *
 * Anchor families
 * ---------------
 * A) smartdata (Observation.code): code.coding[] carries an Epic SmartData-element
 *    coding under urn:oid:1.2.840.114350.1.13.283.2.7.2.727688 (code "EPIC#<id>")
 *    side-by-side with one (sometimes zero) SNOMED CT coding → dual-coding rows.
 *    The SmartData element store (SMRTDTA_*) is NOT shipped in this EHI export, and
 *    no "EPIC#" code appears in ANY column of the DB (verified by full scan), so
 *    every smartdata row is ehi_verified=no — but the would-be mapping is recorded.
 *
 * B) survey (Observation.code): code.coding[] carries the Epic flowsheet-id coding
 *    (system http://open.epic.com/FHIR/StructureDefinition/observation-flowsheet-id,
 *    an opaque FHIR-encrypted id) usually side-by-side with a LOINC coding →
 *    dual-coding rows. The EHI ships the RAW flowsheet measure id as
 *    V_EHI_FLO_MEAS_VALUE.FLO_MEAS_ID; the encrypted id cannot be reversed, so we
 *    content-match the FHIR code.text to FLO_MEAS_ID_DISP_NAME (exact, normalized).
 *    On an exact name hit: ehi_verified=yes, epic_local_code = the raw FLO_MEAS_ID,
 *    join = V_EHI_FLO_MEAS_VALUE.FLO_MEAS_ID. Otherwise we still record the
 *    dual-coding pair using the encrypted flowsheet-id as the local code with
 *    ehi_verified=no (the residual gap).
 *
 * C) social-history (Observation.code): code.coding carries LOINC + SNOMED but NO
 *    Epic-local coding. These are panel concepts (Smoking/Alcohol/Drug/Social-doc)
 *    stored in SOCIAL_HX. The EHI has no local numeric code for the concept itself,
 *    so the standard codings are recorded with ehi_verified=no (residual gap).
 *
 * D) social-history (Observation.valueCodeableConcept): the value SNOMED codes
 *    (e.g. "Never smoked tobacco" 266919005) map from fixed SOCIAL_HX _C_NAME
 *    categoricals (SMOKING_TOB_USE_C_NAME, ALCOHOL_USE_C_NAME, ILL_DRUG_USER_C_NAME)
 *    → value-set-literal rows, ehi_verified=yes when the _C_NAME value is present.
 *
 * E) survey (Observation.valueCodeableConcept): values carry LOINC answer-list (LA)
 *    codes or an Epic-local answer OID. These answer codings have no separate
 *    Epic-local key the EHI ships per-answer, so they are recorded as value-set
 *    rows with ehi_verified=no (the flowsheet stores the answer as free text/value,
 *    not a joinable answer code in this export).
 *
 * Writes crosswalk/observation-coded.csv. Deterministic. Modifies nothing else.
 */
import { db } from "../lib/db";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");

const SD_OID = "urn:oid:1.2.840.114350.1.13.283.2.7.2.727688"; // SmartData element master
const FLO_SYS = "http://open.epic.com/FHIR/StructureDefinition/observation-flowsheet-id";
const LOINC = "http://loinc.org";
const SNOMED = "http://snomed.info/sct";

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

const load = (f: string) => JSON.parse(readFileSync(resolve(ROOT, "fhir-target", f), "utf8")) as any[];
const hasCat = (o: any, code: string) =>
  (o.category || []).some((c: any) => (c.coding || []).some((cc: any) => cc.code === code));
const norm = (s: string) => (s || "").trim().toLowerCase();

const obs = load("Observation.json");
const rows: Row[] = [];

// ---------- EHI: raw flowsheet measure name → FLO_MEAS_ID(s) ----------
const floByName = new Map<string, { id: string; disp: string }[]>();
for (const r of db.query(
  "SELECT DISTINCT FLO_MEAS_ID, FLO_MEAS_ID_DISP_NAME AS disp FROM V_EHI_FLO_MEAS_VALUE"
).all() as any[]) {
  const k = norm(r.disp);
  if (!k) continue;
  const arr = floByName.get(k) || [];
  arr.push({ id: String(r.FLO_MEAS_ID), disp: r.disp });
  floByName.set(k, arr);
}

// ---------- EHI: SOCIAL_HX categorical presence (for value-set-literal) ----------
const socialHasValue = (col: string, val: string): boolean => {
  const r = db.query(
    `SELECT 1 AS x FROM SOCIAL_HX WHERE "${col}" = ? LIMIT 1`
  ).get(val) as any;
  return !!r;
};

// ============================================================
// A) smartdata — Observation.code (727688 EPIC# → SNOMED)
// ============================================================
{
  const sd = obs.filter(o => hasCat(o, "smartdata"));
  const seen = new Set<string>();
  for (const o of sd) {
    const coding = (o.code?.coding || []) as any[];
    const local = coding.find(c => c.system === SD_OID);
    if (!local) continue;
    const standards = coding.filter(c => (c.system === SNOMED || c.system === LOINC) && c.code);
    const disp = local.display || o.code?.text || "";
    if (standards.length === 0) {
      // record the residual gap: local code present, no standard coding shipped
      const key = local.code + "|<none>";
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        area: "smartdata", fhir_path: "Observation.code", concept_display: disp,
        ehi_join_table: "SMRTDTA_ELEM_DATA", ehi_join_column: "ELEMENT_ID",
        epic_local_system: SD_OID, epic_local_code: local.code, epic_local_display: local.display || "",
        target_system: "", target_code: "", target_display: "",
        anchor_method: "dual-coding", ehi_verified: "no", confidence: "low",
        notes: `SmartData element "${o.code?.text || ""}"; no standard coding present in target code.coding. `
          + "SMRTDTA_* element store not shipped in this EHI export (no EPIC# code in any DB column).",
      });
      continue;
    }
    for (const s of standards) {
      const key = local.code + "|" + s.system + "|" + s.code;
      if (seen.has(key)) continue;
      seen.add(key);
      const multi = standards.length > 1;
      rows.push({
        area: "smartdata", fhir_path: "Observation.code", concept_display: disp,
        ehi_join_table: "SMRTDTA_ELEM_DATA", ehi_join_column: "ELEMENT_ID",
        epic_local_system: SD_OID, epic_local_code: local.code, epic_local_display: local.display || "",
        target_system: s.system, target_code: s.code, target_display: s.display || "",
        anchor_method: "dual-coding", ehi_verified: "no", confidence: "medium",
        notes: `SmartData element "${o.code?.text || ""}". `
          + "SMRTDTA_* element store not shipped (no EPIC# code in any DB column) → join key unverifiable; pair recorded as would-be mapping."
          + (multi ? " 1:n — element carries multiple standard codings." : ""),
      });
    }
  }
}

// ============================================================
// B) survey — Observation.code (flowsheet-id → LOINC/SNOMED)
// ============================================================
{
  const surv = obs.filter(o => hasCat(o, "survey"));
  const seen = new Set<string>();
  for (const o of surv) {
    const coding = (o.code?.coding || []) as any[];
    const flo = coding.find(c => c.system === FLO_SYS);
    if (!flo) continue;
    const standards = coding.filter(c => (c.system === LOINC || c.system === SNOMED) && c.code);
    const text = o.code?.text || "";
    // Content-match the raw flowsheet name to V_EHI_FLO_MEAS_VALUE.FLO_MEAS_ID_DISP_NAME.
    // The FHIR code.text is usually absent for flowsheet rows; the joinable flowsheet
    // name is carried as the flowsheet-id coding's `display`. Try code.text first, then
    // the flowsheet-id display. (The encrypted flowsheet-id itself is not reversible.)
    const textMatch = floByName.get(norm(text));
    const dispMatch = floByName.get(norm(flo.display || ""));
    const match = (textMatch && textMatch.length) ? textMatch : dispMatch;
    const matchedOn = (textMatch && textMatch.length) ? "code.text" : "flowsheet display name";
    const verified = !!match && match.length > 0;
    // when verified, local code is the raw FLO_MEAS_ID; else the encrypted flowsheet-id
    const localSystem = verified ? "V_EHI_FLO_MEAS_VALUE.FLO_MEAS_ID" : FLO_SYS;
    const localCode = verified ? match![0].id : flo.code;
    const localDisp = verified ? match![0].disp : (flo.display || text);
    const fanout = verified && match!.length > 1 ? ` (name maps to ${match!.length} FLO_MEAS_IDs: ${match!.map(m => m.id).join(",")})` : "";

    if (standards.length === 0) {
      const key = "B|" + localCode + "|<none>|" + flo.code;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        area: "survey", fhir_path: "Observation.code", concept_display: text,
        ehi_join_table: "V_EHI_FLO_MEAS_VALUE", ehi_join_column: "FLO_MEAS_ID",
        epic_local_system: localSystem, epic_local_code: localCode, epic_local_display: localDisp,
        target_system: "", target_code: "", target_display: "",
        anchor_method: "content-match", ehi_verified: verified ? "yes" : "no",
        confidence: verified ? "low" : "low",
        notes: (verified
          ? `flowsheet-id "${flo.code}" content-matched by ${matchedOn} ("${flo.display || text}") to FLO_MEAS_ID=${localCode}${fanout}; `
          : `flowsheet-id "${flo.code}" not name-matched to any FLO_MEAS_ID; `)
          + "no standard coding present in target code.coding.",
      });
      continue;
    }
    for (const s of standards) {
      const key = "B|" + localCode + "|" + s.system + "|" + s.code;
      if (seen.has(key)) continue;
      seen.add(key);
      const concept = text || s.display || "";
      rows.push({
        area: "survey", fhir_path: "Observation.code", concept_display: concept,
        ehi_join_table: "V_EHI_FLO_MEAS_VALUE", ehi_join_column: "FLO_MEAS_ID",
        epic_local_system: localSystem, epic_local_code: localCode, epic_local_display: localDisp,
        target_system: s.system, target_code: s.code, target_display: s.display || "",
        anchor_method: verified ? "content-match" : "dual-coding",
        ehi_verified: verified ? "yes" : "no",
        confidence: verified ? "medium" : "low",
        notes: (verified
          ? `flowsheet question content-matched by ${matchedOn} ("${flo.display || text}") to FLO_MEAS_ID=${localCode}${fanout}; LOINC/SNOMED dual-coded in target (standard coding from target code.coding).`
          : `flowsheet-id "${flo.code}" dual-coded with standard in target; encrypted id not reversible to a raw FLO_MEAS_ID in this export (name not matched).`),
      });
    }
  }
}

// ============================================================
// C) social-history — Observation.code (LOINC + SNOMED, no Epic-local)
// ============================================================
{
  const soc = obs.filter(o => hasCat(o, "social-history"));
  const seen = new Set<string>();
  for (const o of soc) {
    const coding = (o.code?.coding || []) as any[];
    const standards = coding.filter(c => (c.system === LOINC || c.system === SNOMED) && c.code);
    const text = o.code?.text || "";
    for (const s of standards) {
      const key = "C|" + text + "|" + s.system + "|" + s.code;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        area: "social", fhir_path: "Observation.code", concept_display: text,
        ehi_join_table: "SOCIAL_HX", ehi_join_column: "",
        epic_local_system: "", epic_local_code: "", epic_local_display: "",
        target_system: s.system, target_code: s.code, target_display: s.display || "",
        anchor_method: "content-match", ehi_verified: "no", confidence: "low",
        notes: `Social-history panel "${text}" lives in SOCIAL_HX, but no Epic-local concept code is carried in target code.coding or shipped in the EHI; standard coding recorded as residual gap.`,
      });
    }
  }
}

// ============================================================
// D) social-history — Observation.valueCodeableConcept (value-set-literal)
// ============================================================
// Fixed SOCIAL_HX categorical → value SNOMED, matched by code.text concept.
{
  const soc = obs.filter(o => hasCat(o, "social-history"));
  // map concept code.text → the SOCIAL_HX categorical column that carries the answer
  const colByConcept: Record<string, string> = {
    "Smoking History": "SMOKING_TOB_USE_C_NAME",
    "Alcohol Use History": "ALCOHOL_USE_C_NAME",
    "Drug Use History": "ILL_DRUG_USER_C_NAME",
  };
  const seen = new Set<string>();
  for (const o of soc) {
    const vcc = o.valueCodeableConcept;
    if (!vcc) continue;
    const vsn = (vcc.coding || []).filter((c: any) => c.system === SNOMED && c.code);
    if (vsn.length === 0) continue;
    const concept = o.code?.text || "";
    const col = colByConcept[concept];
    const localCat = vcc.text || ""; // the _C_NAME value (e.g. "Never", "Yes", "No")
    const verified = !!col && !!localCat && socialHasValue(col, localCat);
    for (const s of vsn) {
      const key = "D|" + concept + "|" + localCat + "|" + s.code;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        area: "social", fhir_path: "Observation.valueCodeableConcept", concept_display: concept,
        ehi_join_table: "SOCIAL_HX", ehi_join_column: col || "",
        epic_local_system: col ? `SOCIAL_HX.${col}` : "", epic_local_code: localCat,
        epic_local_display: localCat,
        target_system: SNOMED, target_code: s.code, target_display: s.display || "",
        anchor_method: "value-set-literal", ehi_verified: verified ? "yes" : "no",
        confidence: verified ? "high" : "low",
        notes: col
          ? `SOCIAL_HX.${col}="${localCat}" → SNOMED ${s.code} ("${s.display || ""}")`
            + (verified ? "; value confirmed present in SOCIAL_HX." : "; value not found in SOCIAL_HX.")
          : `No SOCIAL_HX categorical column mapped for concept "${concept}".`,
      });
    }
  }
}

// ============================================================
// E) survey — Observation.valueCodeableConcept (answer codings)
// ============================================================
// Survey answers carry LOINC LA codes (or an Epic-local answer OID) but no separate
// joinable Epic-local answer key is shipped per answer → residual-gap value rows.
{
  const surv = obs.filter(o => hasCat(o, "survey"));
  const seen = new Set<string>();
  for (const o of surv) {
    const vcc = o.valueCodeableConcept;
    if (!vcc) continue;
    const vstd = (vcc.coding || []).filter((c: any) => (c.system === LOINC || c.system === SNOMED) && c.code);
    if (vstd.length === 0) continue;
    const flo = (o.code?.coding || []).find((c: any) => c.system === FLO_SYS);
    const concept = o.code?.text || (o.code?.coding || []).find((c: any) => c.system === LOINC)?.display || "";
    for (const s of vstd) {
      const key = "E|" + (flo?.code || "") + "|" + s.system + "|" + s.code;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        area: "survey", fhir_path: "Observation.valueCodeableConcept", concept_display: concept,
        ehi_join_table: "V_EHI_FLO_MEAS_VALUE", ehi_join_column: "MEAS_VALUE_EXTERNAL",
        epic_local_system: "", epic_local_code: "", epic_local_display: vcc.text || s.display || "",
        target_system: s.system, target_code: s.code, target_display: s.display || "",
        anchor_method: "value-set-literal", ehi_verified: "no", confidence: "low",
        notes: `Survey answer for flowsheet-id "${flo?.code || "?"}"; LOINC answer-list code in target value. `
          + "EHI stores the answer as MEAS_VALUE_EXTERNAL free text, with no joinable per-answer local code → residual gap.",
      });
    }
  }
}

// ---------- sort & emit ----------
rows.sort((a, b) =>
  a.area.localeCompare(b.area) ||
  a.fhir_path.localeCompare(b.fhir_path) ||
  a.concept_display.localeCompare(b.concept_display) ||
  a.epic_local_code.localeCompare(b.epic_local_code) ||
  a.target_system.localeCompare(b.target_system) ||
  a.target_code.localeCompare(b.target_code));

const out = [HEADER, ...rows.map(csvRow)].join("\r\n") + "\r\n";
writeFileSync(resolve(ROOT, "crosswalk", "observation-coded.csv"), out);

// ---------- tally ----------
const verified = rows.filter(r => r.ehi_verified === "yes").length;
const distinctConcepts = new Set(rows.map(r => r.epic_local_code || r.concept_display)).size;
const unanchored = rows.filter(r => r.ehi_verified === "no" && r.target_code).length;
console.error(JSON.stringify({
  rows: rows.length, verifiedRows: verified, distinctConcepts, unanchored,
}, null, 2));
