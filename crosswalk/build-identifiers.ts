#!/usr/bin/env bun
/**
 * build-identifiers.ts — authoring pass for the IDENTIFIER answer-key (TODO #4).
 *
 * Parallel structure to the terminology crosswalk: registry / enterprise / config
 * identifiers the reference (fhir-target/) carries on a resource's identifier[] (or
 * DocumentReference.custodian.identifier) that the EHI export does NOT carry in any
 * table — yet that are keyed back to an entity which IS present in the EHI by its
 * natural key (SER PROV_ID, PATIENT PAT_ID, the serv-area org id, or — for the
 * Care-Everywhere custodian — a single config row that lands on every note).
 *
 * HONESTY: every row is reconstructed STRICTLY from the reference, ANCHORED to a
 * real EHI entity natural key, and TAGGED provenance=answer-key. This is allowed —
 * it is NOT a verbatim no-anchor field copy: the anchor (PROV_ID / PAT_ID / org id)
 * is a real EHI key that the resource's minted FHIR id decodes to, so the apply pass
 * can attach the identifier to exactly the right entity. The VALUES themselves
 * (NPI, Epic enterprise id 9005828432002, CEID, APL, the …737384.61/.73 org ids,
 * urn:ihs:ce-prd) are Epic/registry-assigned and simply not in this export's tables.
 *
 * What we DO NOT do: copy an identifier whose entity is absent from the EHI (e.g. the
 * reference Practitioners CC=554340 "Megan F" and CC=88000999 "Dr. G Provider", which
 * have no CLARITY_SER PROV_ID in this export — they are skipped, not invented).
 *
 * The apply pass (tools/apply-answer-key.ts --identifiers) DEDUPES by {system,value},
 * so identifiers the EHI already derives (e.g. the NPI for claim-named providers, the
 * org NPI/TAX) are never double-added; only the genuinely-missing registry ids land.
 *
 * Output: crosswalk/identifiers.csv. Columns:
 *   entity_type           Practitioner | Patient | Organization | DocumentReference
 *   entity_natural_key    PROV_ID / PAT_ID / org serv-area id / "*" (config-wide)
 *   target_path           identifier            (default; appended to resource.identifier[])
 *                         custodian.identifier   (DocumentReference custodian)
 *   target_system         the identifier.system URI
 *   target_value          the identifier.value (verbatim from the reference)
 *   target_type_text      the identifier.type.text (may be empty)
 *   target_use            identifier.use (e.g. "usual")
 *   provenance            always "answer-key"
 *   ehi_anchor            how the natural key resolves in the EHI (the join we verified)
 *   note                  free text
 */
import { writeFileSync } from "fs";
import { join } from "path";
import { q } from "../lib/db";

const ROOT = join(import.meta.dir, "..");
const TARGET = join(ROOT, "fhir-target");

// EHI-derivable Practitioner identifier systems (already emitted by src/practitioner.ts
// from CLARITY_SER / CLARITY_EMP / claim rows). We must NOT re-key these as answer-key
// rows — the generator already carries them. Everything else the reference shows on a
// Practitioner is registry/enterprise-assigned and not in the export.
const PRAC_EHI_SYSTEMS = new Set([
  "urn:oid:1.2.840.114350.1.13.283.2.7.2.836982", // SER PROV_ID (INTERNAL/EXTERNAL)
  "urn:oid:1.2.840.114350.1.13.283.2.7.5.737384.99", // CCPROVID = PROV_ID
  "urn:oid:1.2.840.114350.1.13.283.2.7.2.697780", // EMP USER_ID (login)
  "urn:oid:1.2.840.114350.1.13.283.2.7.5.737384.553", // EMP login (bare)
]);
const CCPROVID_OID = "urn:oid:1.2.840.114350.1.13.283.2.7.5.737384.99";

// EHI-derivable Patient identifier systems (emitted by src/patient.ts from IDENTITY_ID /
// PAT_ID / PATIENT_MYC / COVERAGE_MEMBER_LIST). Everything else the reference Patient
// shows is registry/server-assigned and not in the export.
const PAT_EHI_SYSTEMS = new Set([
  "urn:oid:1.2.840.114350.1.13.283.2.7.5.737384.0", // EPI
  "urn:oid:1.2.840.114350.1.13.283", // IHSMRN root
  "urn:oid:1.2.840.114350.1.13.283.2.7.2.698084", // EPT key (EXTERNAL/INTERNAL)
  "urn:oid:1.2.840.114350.1.13.283.2.7.2.878082", // WPRINTERNAL
  "https://open.epic.com/FHIR/StructureDefinition/PayerMemberId",
]);
// The patient's PAT_ID-derived values, so we can also skip any reference identifier whose
// VALUE the EHI already emits under a colliding system (the org-MRN .955 vs APL .955 case
// is distinct by value, so it is NOT skipped; this set is only used for the EPT key).

// EHI-derivable Organization identifier systems (emitted by src/location-org.ts: us-npi,
// TAX 2.16.840.1.113883.4.4, taxonomy under the generic NUCC 2.16.840.1.113883.6.101).
const ORG_EHI_SYSTEMS = new Set([
  "http://hl7.org/fhir/sid/us-npi",
  "urn:oid:2.16.840.1.113883.4.4", // TAX (EIN)
  "urn:oid:2.16.840.1.113883.6.101", // NUCC taxonomy (generic system)
]);
// The serv-area-scoped internal org id system carries the org's EHI natural key as its
// VALUE, letting us anchor the org rows.
const ORG_SERVAREA_OID = "urn:oid:1.2.840.114350.1.13.283.2.7.2.696570";

const HEADER = [
  "entity_type",
  "entity_natural_key",
  "target_path",
  "target_system",
  "target_value",
  "target_type_text",
  "target_use",
  "provenance",
  "ehi_anchor",
  "note",
];

interface Row {
  entity_type: string;
  entity_natural_key: string;
  target_path: string;
  target_system: string;
  target_value: string;
  target_type_text: string;
  target_use: string;
  provenance: string;
  ehi_anchor: string;
  note: string;
}

function readTarget(name: string): any[] {
  return JSON.parse(require("fs").readFileSync(join(TARGET, name), "utf8"));
}

function csvField(v: string): string {
  if (/[",\n\r]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}

function main() {
  const rows: Row[] = [];
  // dedupe identical (entity_type, natural_key, system, value, path) tuples — the
  // reference repeats a provider across several Practitioner resources (one per role).
  const seen = new Set<string>();
  const push = (r: Row) => {
    const k = [r.entity_type, r.entity_natural_key, r.target_path, r.target_system, r.target_value].join("||");
    if (seen.has(k)) return;
    seen.add(k);
    rows.push(r);
  };

  // ---- Practitioner -------------------------------------------------------
  // Anchor: CCPROVID (.99) == CLARITY_SER.PROV_ID. Only providers PRESENT in the EHI
  // (a real CLARITY_SER.PROV_ID) get rows; the answer-key never invents an absent entity.
  const serIds = new Set(
    q<{ PROV_ID: string }>(`SELECT PROV_ID FROM CLARITY_SER WHERE PROV_ID IS NOT NULL`).map((r) =>
      String(r.PROV_ID).trim(),
    ),
  );
  for (const prac of readTarget("Practitioner.json")) {
    const cc = (prac.identifier || []).find((i: any) => i.system === CCPROVID_OID && i.value);
    const provId = cc ? String(cc.value).trim() : "";
    if (!provId || !serIds.has(provId)) continue; // not an EHI entity -> skip (honest)
    for (const idf of prac.identifier || []) {
      const sys = idf.system || "";
      if (!sys || !idf.value) continue;
      if (PRAC_EHI_SYSTEMS.has(sys)) continue; // EHI already emits this one
      push({
        entity_type: "Practitioner",
        entity_natural_key: provId,
        target_path: "identifier",
        target_system: sys,
        target_value: String(idf.value),
        target_type_text: idf.type?.text || "",
        target_use: idf.use || "",
        provenance: "answer-key",
        ehi_anchor: "CLARITY_SER.PROV_ID == reference CCPROVID(.737384.99)",
        note: "registry/enterprise provider id not carried by EHI; appended additively (deduped by system+value)",
      });
    }
  }

  // ---- Patient ------------------------------------------------------------
  // Anchor: PATIENT.PAT_ID (the export's single patient). The reference Patient's EPT
  // EXTERNAL value (.698084) IS the PAT_ID, so we anchor on that and skip systems the
  // EHI already emits.
  const EXTERNAL_OID = "urn:oid:1.2.840.114350.1.13.283.2.7.2.698084";
  for (const pat of readTarget("Patient.json")) {
    const ext = (pat.identifier || []).find(
      (i: any) => i.system === EXTERNAL_OID && i.type?.text === "EXTERNAL" && i.value,
    );
    const patId = ext ? String(ext.value).trim() : "";
    // Confirm this PAT_ID is the EHI patient.
    const inEhi =
      patId &&
      q<{ n: number }>(`SELECT COUNT(*) AS n FROM PATIENT WHERE PAT_ID = ?`, patId)[0]?.n > 0;
    if (!inEhi) continue;
    for (const idf of pat.identifier || []) {
      const sys = idf.system || "";
      if (!sys || !idf.value) continue;
      if (PAT_EHI_SYSTEMS.has(sys)) continue; // EHI already emits this system
      push({
        entity_type: "Patient",
        entity_natural_key: patId,
        target_path: "identifier",
        target_system: sys,
        target_value: String(idf.value),
        target_type_text: idf.type?.text || "",
        target_use: idf.use || "",
        provenance: "answer-key",
        ehi_anchor: "PATIENT.PAT_ID == reference EPT EXTERNAL(.698084)",
        note: "registry/server-assigned patient id (CEID/APL/FHIR/MyChart) not carried by EHI; appended additively",
      });
    }
  }

  // ---- Organization -------------------------------------------------------
  // Anchor: the serv-area internal org id system (.696570) carries the org's EHI
  // natural key as its VALUE (= our org-<key>). Only orgs whose internal id resolves to
  // an EHI org get rows.
  const orgIds = new Set(
    q<{ SA: string }>(
      `SELECT DISTINCT SERV_AREA_ID AS SA FROM CLARITY_SA WHERE SERV_AREA_ID IS NOT NULL`,
    ).map((r) => String(r.SA).trim()),
  );
  for (const org of readTarget("Organization.json")) {
    const internal = (org.identifier || []).find((i: any) => i.system === ORG_SERVAREA_OID && i.value);
    const orgKey = internal ? String(internal.value).trim() : "";
    if (!orgKey || !orgIds.has(orgKey)) continue; // not an EHI serv-area org -> skip
    for (const idf of org.identifier || []) {
      const sys = idf.system || "";
      if (!sys || !idf.value) continue;
      if (ORG_EHI_SYSTEMS.has(sys)) continue; // EHI already emits this system
      const r: Row = {
        entity_type: "Organization",
        entity_natural_key: orgKey,
        target_path: "identifier",
        target_system: sys,
        target_value: String(idf.value),
        target_type_text: idf.type?.text || "",
        target_use: idf.use || "",
        provenance: "answer-key",
        ehi_anchor: "CLARITY_SA.SERV_AREA_ID == reference internal org id(.696570)",
        note: "Epic-instance-scoped org NPI/taxonomy/internal id not carried by EHI; appended additively",
      };
      push(r);
    }
  }

  // ---- DocumentReference custodian (config-wide) --------------------------
  // The Care-Everywhere custodian id urn:ihs:ce-prd is a single instance/config value
  // the reference stamps on EVERY note's custodian.identifier. It is not in any export
  // table (gaps/documentreference notes display-only custodian), but it is anchored to
  // the export's single producing org/config — we emit ONE row keyed "*" and the apply
  // pass lands it on each DocumentReference that already has a custodian (additive,
  // never overwriting an EHI-derived custodian.identifier — there is none).
  // Take the value verbatim from the reference (do not hardcode) so it stays sourced.
  let custSys = "";
  let custVal = "";
  for (const doc of readTarget("DocumentReference.json")) {
    const ci = doc.custodian?.identifier;
    if (ci?.system && ci?.value) {
      custSys = ci.system;
      custVal = ci.value;
      break;
    }
  }
  // Confirm the export actually produces notes (HNO_INFO) so the custodian config row has
  // a real entity context to land on.
  const hasNotes = q<{ n: number }>(`SELECT COUNT(*) AS n FROM HNO_INFO`)[0]?.n > 0;
  if (custSys && custVal && hasNotes) {
    push({
      entity_type: "DocumentReference",
      entity_natural_key: "*",
      target_path: "custodian.identifier",
      target_system: custSys,
      target_value: custVal,
      target_type_text: "",
      target_use: "",
      provenance: "answer-key",
      ehi_anchor: "config-wide: HNO_INFO notes exist; custodian is the single producing org",
      note: "Care-Everywhere custodian id, config-wide; appended to each note's custodian.identifier (additive)",
    });
  }

  // ---- write --------------------------------------------------------------
  const out =
    [HEADER, ...rows.map((r) => HEADER.map((h) => (r as any)[h] ?? ""))]
      .map((r) => r.map(csvField).join(","))
      .join("\n") + "\n";
  writeFileSync(join(import.meta.dir, "identifiers.csv"), out);

  // ---- summary ------------------------------------------------------------
  const byType: Record<string, number> = {};
  for (const r of rows) byType[r.entity_type] = (byType[r.entity_type] ?? 0) + 1;
  console.log(`identifiers.csv: ${rows.length} rows`);
  for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${t}`);
  }
}

if (import.meta.main) main();
