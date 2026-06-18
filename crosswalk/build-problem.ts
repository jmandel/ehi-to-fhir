#!/usr/bin/env bun
/**
 * build-problem.ts — reconstruct the "problem" terminology crosswalk excerpt.
 *
 * Pairs each EHI Epic-local DX_ID (the join key a real export ships in
 * PROBLEM_LIST.DX_ID / PAT_ENC_DX.DX_ID, named in CLARITY_EDG.DX_NAME) with the
 * STANDARD codings (ICD-10-CM, SNOMED CT, ICD-9-CM) that the reference FHIR
 * attaches to Condition.code.coding.
 *
 * Anchor:
 *  - dual-coding   : the target Condition carries an embedded Epic-local coding
 *                    (urn:oid:2.16.840.1.113883.3.247.1.1) alongside the standard
 *                    codings in the SAME code.coding[] array.
 *  - content-match : no embedded local coding (or it does not resolve against this
 *                    EHI); recover the EHI DX_ID by matching Condition.code.text to
 *                    CLARITY_EDG.DX_NAME.
 *
 * ehi_verified=yes iff the chosen DX_ID is actually referenced by this export
 * (present in PROBLEM_LIST.DX_ID or PAT_ENC_DX.DX_ID).
 */
import { db } from "../lib/db";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const EPIC_DX_SYSTEM = "urn:oid:2.16.840.1.113883.3.247.1.1";
const STD_SYSTEMS = new Set([
  "http://hl7.org/fhir/sid/icd-10-cm",
  "http://snomed.info/sct",
  "http://hl7.org/fhir/sid/icd-9-cm",
]);

// --- EHI facts -------------------------------------------------------------
// CLARITY_EDG: master DX_ID -> DX_NAME (one name may have several DX_IDs).
const edgByName = new Map<string, { dxId: string; dxName: string }[]>();
const edgById = new Map<string, string>();
for (const r of db.query("SELECT DX_ID, DX_NAME FROM CLARITY_EDG").all() as any[]) {
  const key = String(r.DX_NAME).trim().toLowerCase();
  edgByName.set(key, [...(edgByName.get(key) ?? []), { dxId: String(r.DX_ID), dxName: String(r.DX_NAME) }]);
  edgById.set(String(r.DX_ID), String(r.DX_NAME));
}

// DX_IDs actually referenced by this export => the join would fire.
const referenced = new Set<string>();
for (const t of ["PROBLEM_LIST", "PAT_ENC_DX"]) {
  for (const r of db.query(`SELECT DISTINCT DX_ID FROM ${t} WHERE DX_ID IS NOT NULL AND DX_ID<>''`).all() as any[]) {
    referenced.add(String(r.DX_ID));
  }
}
const inProblemList = new Set(
  (db.query("SELECT DISTINCT DX_ID FROM PROBLEM_LIST WHERE DX_ID IS NOT NULL AND DX_ID<>''").all() as any[]).map(
    (r) => String(r.DX_ID),
  ),
);

// --- target FHIR -----------------------------------------------------------
const conditions: any[] = JSON.parse(readFileSync(resolve(ROOT, "fhir-target/Condition.json"), "utf8"));

type Row = Record<string, string>;
const rows: Row[] = [];
let verifiedRows = 0;
const concepts = new Set<string>();
// unanchored = standard codings whose concept has NO EHI-verified local key
let unanchored = 0;
const seen = new Set<string>(); // dedupe (localCode|targetSystem|targetCode)

function resolveDxId(text: string, embeddedLocal?: string): { dxId: string; verified: boolean; method: string; note: string } {
  // Prefer the embedded local coding IF it actually exists in the EHI.
  if (embeddedLocal && edgById.has(embeddedLocal)) {
    return { dxId: embeddedLocal, verified: referenced.has(embeddedLocal), method: "dual-coding", note: "" };
  }
  // Otherwise recover the EHI DX_ID by name.
  const cands = edgByName.get(text.trim().toLowerCase()) ?? [];
  if (cands.length === 0) {
    // No EHI key at all. If there is an embedded local code, surface it as an unverified dual-coding anchor.
    if (embeddedLocal) {
      return {
        dxId: embeddedLocal,
        verified: false,
        method: "dual-coding",
        note: "embedded Epic DX code not present in this export's CLARITY_EDG/PROBLEM_LIST/PAT_ENC_DX",
      };
    }
    return { dxId: "", verified: false, method: "content-match", note: "no CLARITY_EDG.DX_NAME match" };
  }
  // Disambiguate: prefer a candidate that is actually referenced by this export.
  const ref = cands.filter((c) => referenced.has(c.dxId));
  const chosen = (ref[0] ?? cands[0]).dxId;
  const note =
    cands.length > 1
      ? `name "${text}" maps to ${cands.length} DX_IDs (${cands.map((c) => c.dxId).join("/")}); chose ${chosen}${ref.length ? " (referenced in this export)" : " (none referenced)"}`
      : "";
  const method = embeddedLocal ? "content-match" : "content-match";
  const embedNote =
    embeddedLocal && !edgById.has(embeddedLocal)
      ? `embedded Epic DX ${embeddedLocal} absent from this export; recovered DX_ID via name match`
      : "";
  return {
    dxId: chosen,
    verified: referenced.has(chosen),
    method,
    note: [note, embedNote].filter(Boolean).join("; "),
  };
}

for (const cond of conditions) {
  const code = cond.code ?? {};
  const text: string = code.text ?? "";
  const coding: any[] = code.coding ?? [];
  const embedded = coding.find((c) => c.system === EPIC_DX_SYSTEM)?.code as string | undefined;
  const stds = coding.filter((c) => STD_SYSTEMS.has(c.system));
  if (stds.length === 0) continue;

  const r = resolveDxId(text, embedded);
  concepts.add(text || r.dxId);

  let anchoredAny = false;
  for (const s of stds) {
    const dedupeKey = `${r.dxId}|${s.system}|${s.code}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const ehiVerified = r.verified && r.dxId ? "yes" : "no";
    if (ehiVerified === "yes") verifiedRows++;

    const joinTable = r.dxId && inProblemList.has(r.dxId) ? "PROBLEM_LIST" : "PAT_ENC_DX";
    const confidence =
      r.method === "dual-coding" && r.verified ? "high" : r.verified ? "medium" : r.dxId ? "medium" : "low";

    rows.push({
      area: "problem",
      fhir_path: "Condition.code",
      concept_display: text,
      ehi_join_table: r.dxId ? joinTable : "PROBLEM_LIST",
      ehi_join_column: "DX_ID",
      epic_local_system: EPIC_DX_SYSTEM,
      epic_local_code: r.dxId,
      epic_local_display: r.dxId ? edgById.get(r.dxId) ?? text : "",
      target_system: s.system,
      target_code: s.code ?? "",
      target_display: s.display ?? "",
      anchor_method: r.method,
      ehi_verified: ehiVerified,
      confidence,
      notes: r.note,
    });
    anchoredAny = true;
    if (ehiVerified === "no") unanchored++;
  }
  void anchoredAny;
}

// --- CSV emit (RFC-4180) ---------------------------------------------------
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
  const s = v ?? "";
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const lines = [HEADER.join(",")];
for (const row of rows) lines.push(HEADER.map((h) => esc(row[h] ?? "")).join(","));
const csv = lines.join("\r\n") + "\r\n";
writeFileSync(resolve(ROOT, "crosswalk/problem.csv"), csv);

console.error(
  JSON.stringify(
    { rows: rows.length, verifiedRows, distinctConcepts: concepts.size, unanchored },
    null,
    2,
  ),
);
