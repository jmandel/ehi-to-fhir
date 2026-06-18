#!/usr/bin/env bun
/**
 * build-allergy.ts — reconstruct the Epic local-code -> standard-coding crosswalk
 * excerpt for the "allergy" area.
 *
 * Anchor model:
 *   - The EHI join key a real export would use is ALLERGY.ALLERGEN_ID (Epic allergen
 *     master-file id), labelled by ALLERGEN_ID_ALLERGEN_NAME.
 *   - The reference FHIR AllergyIntolerance.code.coding carries the STANDARD codings
 *     (SNOMED CT + NCI NDF-RT @ urn:oid:2.16.840.1.113883.3.26.1.5) but does NOT
 *     carry an Epic allergen-id coding in code.coding. So there is no dual-coding
 *     anchor; we content-match the resource to its EHI ALLERGY row by allergen
 *     name (code.text == ALLERGEN_ID_ALLERGEN_NAME) and recover ALLERGEN_ID.
 *   - One row per (ALLERGEN_ID -> standard coding). A concept with SNOMED + N NDF-RT
 *     codes fans out to 1 + N rows.
 *   - Resources whose code has only .text (no code.coding) yield no rows (no standard
 *     code exists to crosswalk; nothing to anchor).
 */
import { Database } from "bun:sqlite";
import { resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const db = new Database(resolve(ROOT, "ehi.sqlite"), { readonly: true });
db.run("PRAGMA busy_timeout = 8000");

const allergies = JSON.parse(
  await Bun.file(resolve(ROOT, "fhir-target/AllergyIntolerance.json")).text(),
) as any[];

// standard system URI -> friendly target_system label as required by README
const STD_SYSTEMS: Record<string, string> = {
  "http://snomed.info/sct": "http://snomed.info/sct",
  // NCI NDF-RT (National Drug File - Reference Terminology); a standard NCI system
  "urn:oid:2.16.840.1.113883.3.26.1.5": "urn:oid:2.16.840.1.113883.3.26.1.5",
};
const SYS_DISPLAY: Record<string, string> = {
  "http://snomed.info/sct": "SNOMED CT",
  "urn:oid:2.16.840.1.113883.3.26.1.5": "NCI NDF-RT",
};

// Epic allergen master file — the local key system. The allergen id is an Epic
// master-file id (.ALLERGEN_ID); no urn:oid for it appears in this export's FHIR,
// so we name the EHI master file as the local system.
const EPIC_LOCAL_SYSTEM = "Epic ALLERGEN master file (ALLERGY.ALLERGEN_ID)";

type Row = {
  area: string;
  fhir_path: string;
  concept_display: string;
  ehi_join_table: string;
  ehi_join_column: string;
  epic_local_system: string;
  epic_local_code: string;
  epic_local_display: string;
  target_system: string;
  target_code: string;
  target_display: string;
  anchor_method: string;
  ehi_verified: string;
  confidence: string;
  notes: string;
};

const rows: Row[] = [];

for (const ai of allergies) {
  const text: string = ai?.code?.text ?? "";
  const codings: any[] = ai?.code?.coding ?? [];

  // content-match to EHI ALLERGY row by allergen name
  const ehi = db
    .query(
      "SELECT ALLERGEN_ID, ALLERGEN_ID_ALLERGEN_NAME FROM ALLERGY WHERE ALLERGEN_ID_ALLERGEN_NAME = ?",
    )
    .get(text) as { ALLERGEN_ID: string; ALLERGEN_ID_ALLERGEN_NAME: string } | null;

  const stdCodings = codings.filter((c) => c.system in STD_SYSTEMS);
  if (stdCodings.length === 0) continue; // only .text -> nothing standard to crosswalk

  const matched = !!ehi;
  const allergenId = ehi?.ALLERGEN_ID ?? "";
  const allergenName = ehi?.ALLERGEN_ID_ALLERGEN_NAME ?? text;

  // count of NDF-RT siblings for note
  const ndfCount = stdCodings.filter(
    (c) => c.system === "urn:oid:2.16.840.1.113883.3.26.1.5",
  ).length;
  const hasSnomed = stdCodings.some((c) => c.system === "http://snomed.info/sct");

  for (const c of stdCodings) {
    const sysLabel = STD_SYSTEMS[c.system];
    const isNdf = c.system === "urn:oid:2.16.840.1.113883.3.26.1.5";
    let note = "";
    if (isNdf) {
      note = `NCI NDF-RT class member; ${ndfCount} NDF-RT codes + ${hasSnomed ? "1 SNOMED" : "0 SNOMED"} share this allergen-id (1:n fan-out)`;
    } else {
      note = `SNOMED class concept; same allergen-id also fans out to ${ndfCount} NDF-RT codes`;
    }
    if (!matched) note += "; no EHI ALLERGEN_ID match";

    rows.push({
      area: "allergy",
      fhir_path: "AllergyIntolerance.code",
      concept_display: text,
      ehi_join_table: "ALLERGY",
      ehi_join_column: "ALLERGEN_ID",
      epic_local_system: EPIC_LOCAL_SYSTEM,
      epic_local_code: allergenId,
      epic_local_display: allergenName,
      target_system: sysLabel,
      target_code: c.code,
      target_display: c.display ?? SYS_DISPLAY[c.system] ?? "",
      anchor_method: "content-match",
      ehi_verified: matched ? "yes" : "no",
      confidence: matched ? "medium" : "low",
      notes: note,
    });
  }
}

// RFC-4180 CSV
const HEADER = [
  "area",
  "fhir_path",
  "concept_display",
  "ehi_join_table",
  "ehi_join_column",
  "epic_local_system",
  "epic_local_code",
  "epic_local_display",
  "target_system",
  "target_code",
  "target_display",
  "anchor_method",
  "ehi_verified",
  "confidence",
  "notes",
];

function esc(v: string): string {
  if (/[",\r\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}

const lines = [HEADER.join(",")];
for (const r of rows) {
  lines.push(
    [
      r.area,
      r.fhir_path,
      r.concept_display,
      r.ehi_join_table,
      r.ehi_join_column,
      r.epic_local_system,
      r.epic_local_code,
      r.epic_local_display,
      r.target_system,
      r.target_code,
      r.target_display,
      r.anchor_method,
      r.ehi_verified,
      r.confidence,
      r.notes,
    ]
      .map((x) => esc(String(x ?? "")))
      .join(","),
  );
}

const out = lines.join("\r\n") + "\r\n";
await Bun.write(resolve(ROOT, "crosswalk/allergy.csv"), out);

// tally to stderr for inspection
const verified = rows.filter((r) => r.ehi_verified === "yes").length;
const concepts = new Set(rows.map((r) => r.concept_display)).size;
const unanchored = rows.filter((r) => r.ehi_verified === "no").length;
console.error(
  JSON.stringify({ rows: rows.length, verified, concepts, unanchored }, null, 2),
);
