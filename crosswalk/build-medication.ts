#!/usr/bin/env bun
/**
 * build-medication.ts — reconstruct the Epic-LOCAL -> STANDARD crosswalk excerpt
 * for the "medication" area.
 *
 * Anchor logic (dual-coding):
 *   Each fhir-target/Medication.json resource carries, side by side in ONE concept:
 *     - the Epic medication-id (Medication.identifier, system
 *       urn:oid:1.2.840.114350.1.13.283.2.7.2.698288, value = MEDICATION_ID), and
 *     - one or more standard RxNorm codings (code.coding[] with system
 *       http://www.nlm.nih.gov/research/umls/rxnorm).
 *   The Epic-local join key the EHI actually ships is ORDER_MED.MEDICATION_ID, which
 *   carries that same MEDICATION_ID value. So we emit one crosswalk row per
 *   (MEDICATION_ID -> RxNorm code) and verify MEDICATION_ID against ORDER_MED.
 *
 * NDC: the README lists NDC as an expected standard system, but this target carries
 *   NO http://hl7.org/fhir/sid/ndc coding and NO NDC OID (2.16.840.1.113883.6.69) for
 *   any medication; the urn:oid:2.16.840.1.113883.6.68 / .6.162 / .6.253 codes are
 *   proprietary drug-knowledge-base codes (FDB/Multum/etc.), not standard NDC, so no
 *   NDC rows are emitted. Devices (FreeStyle Libre) carry no RxNorm and thus no rows.
 */
import { Database } from "bun:sqlite";
import { resolve } from "path";
import { readFileSync, writeFileSync } from "fs";

const ROOT = resolve(import.meta.dir, "..");
const DB_PATH = process.env.EHI_DB ?? resolve(ROOT, "ehi.sqlite");
const db = new Database(DB_PATH, { readonly: true });

const RXNORM_SYS = "http://www.nlm.nih.gov/research/umls/rxnorm";
const MED_ID_OID = "urn:oid:1.2.840.114350.1.13.283.2.7.2.698288";

type Med = {
  identifier?: { system?: string; value?: string }[];
  code?: { text?: string; coding?: { system?: string; code?: string }[] };
};
const meds: Med[] = JSON.parse(
  readFileSync(resolve(ROOT, "fhir-target", "Medication.json"), "utf8")
);

const medOrderVerified = db.prepare(
  "SELECT 1 FROM ORDER_MED WHERE MEDICATION_ID = ? LIMIT 1"
);
const clarityName = db.prepare(
  "SELECT GENERIC_NAME FROM CLARITY_MEDICATION WHERE MEDICATION_ID = ?"
);
const verify = (id: string) => !!medOrderVerified.get(id);
const localName = (id: string) =>
  (clarityName.get(id) as { GENERIC_NAME?: string } | null)?.GENERIC_NAME ?? "";

type Row = {
  area: string; fhir_path: string; concept_display: string;
  ehi_join_table: string; ehi_join_column: string;
  epic_local_system: string; epic_local_code: string; epic_local_display: string;
  target_system: string; target_code: string; target_display: string;
  anchor_method: string; ehi_verified: string; confidence: string; notes: string;
};

const rows: Row[] = [];
// Dedup per (MEDICATION_ID, RxNorm code): the same concept repeats across many
// Medication resources (one per order); a crosswalk is one row per distinct mapping.
const seen = new Set<string>();
const concepts = new Set<string>();

for (const m of meds) {
  const medId = m.identifier?.find((i) => i.system === MED_ID_OID)?.value;
  if (!medId) continue;
  const text = m.code?.text ?? "";
  const rx = (m.code?.coding ?? []).filter((c) => c.system === RXNORM_SYS && c.code);
  if (rx.length === 0) continue; // devices / no standard target -> no row
  concepts.add(medId);
  const verified = verify(medId);
  const nRx = rx.length;
  for (const c of rx) {
    const key = `${medId}|${c.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      area: "medication",
      fhir_path: "Medication.code",
      concept_display: text,
      ehi_join_table: "ORDER_MED",
      ehi_join_column: "MEDICATION_ID",
      epic_local_system: MED_ID_OID,
      epic_local_code: medId,
      epic_local_display: localName(medId),
      target_system: RXNORM_SYS,
      target_code: c.code!,
      target_display: "",
      anchor_method: "dual-coding",
      ehi_verified: verified ? "yes" : "no",
      confidence: verified ? "high" : "medium",
      notes:
        nRx > 1
          ? `1:${nRx} RxNorm fan-out for MEDICATION_ID ${medId} (ingredient/SCD/SBD/pack levels); also non-standard ATC + urn:oid 6.253/6.68/6.162 drug-KB codes in same concept (not emitted)`
          : "",
    });
  }
}

// stable sort: by MEDICATION_ID (numeric), then RxNorm code (numeric)
rows.sort(
  (a, b) =>
    Number(a.epic_local_code) - Number(b.epic_local_code) ||
    Number(a.target_code) - Number(b.target_code)
);

const HEADER = [
  "area", "fhir_path", "concept_display", "ehi_join_table", "ehi_join_column",
  "epic_local_system", "epic_local_code", "epic_local_display",
  "target_system", "target_code", "target_display",
  "anchor_method", "ehi_verified", "confidence", "notes",
] as const;

const esc = (v: string) =>
  /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
const line = (vals: string[]) => vals.map(esc).join(",");

const out = [
  line([...HEADER]),
  ...rows.map((r) => line(HEADER.map((h) => r[h]))),
].join("\r\n") + "\r\n";

writeFileSync(resolve(ROOT, "crosswalk", "medication.csv"), out);

const verifiedRows = rows.filter((r) => r.ehi_verified === "yes").length;
console.log(
  JSON.stringify(
    {
      rows: rows.length,
      verifiedRows,
      distinctConcepts: concepts.size,
      unanchored: rows.length - verifiedRows,
    },
    null,
    2
  )
);
