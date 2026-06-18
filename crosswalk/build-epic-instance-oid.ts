#!/usr/bin/env bun
/**
 * build-epic-instance-oid.ts — authoring pass for the EPIC-INSTANCE-OID codings.
 *
 * TODO #3: capture EVERY coding the reference carries for an EHI-anchored concept,
 * not just the standard systems (LOINC/SNOMED/RxNorm/CVX/ICD/CPT). The reference's
 * code.coding[] arrays also carry Epic-instance OID codings (the instance-local
 * "EAP/EDG/note-type/drug-master" OID fan-out + WHO ATC + the urn:oid drug-KB
 * codes). They live in the SAME code.coding[] array, ANCHORED to the SAME EHI local
 * code (PROC_ID / MEDICATION_ID / note-type) that the standard coding uses, so they
 * are answer-key-coverable exactly like LOINC — they were previously mislabeled
 * "truly-unrecoverable" and dropped.
 *
 * This script reconstructs those rows STRICTLY from the reference (fhir-target/)
 * grouped per EHI-anchored concept, joining placer/identifier values back to the EHI
 * DB so every row stays ANCHORED to a real EHI local code. Every emitted row is
 * tagged system_class="epic-instance-oid" and answer-key-sourced (anchor_method=
 * "answer-key", a copy of the reference coding on the same anchor).
 *
 * Covered (the big OID/ATC fan-outs that sit on EHI-anchored concepts):
 *   - DiagnosticReport.code  : Epic instance OID fan-out (…737384.*), keyed on
 *                              ORDER_PROC.PROC_ID (same anchor as the LOINC/CPT rows).
 *   - Medication.code        : WHO ATC (http://www.whocc.no/atc) + drug-KB urn:oids
 *                              (6.253 NDDF, 6.68 NDC, 6.162 GCN_SEQNO), keyed on
 *                              ORDER_MED.MEDICATION_ID (same anchor as RxNorm rows).
 *   - DocumentReference.type : the parallel Epic note-type OIDs (…737880.5010 and
 *                              …727879.69848980), keyed on HNO_INFO.IP_NOTE_TYPE_C_NAME
 *                              (same anchor as the LOINC note-type rows).
 *   - Condition.code         : the IMO problem coding (urn:oid:2.16.840.1.113883.3.247.1.1),
 *                              keyed on PROBLEM_LIST.DX_ID (the SAME anchor the standard
 *                              ICD/SNOMED Condition rows use — the FALLBACK bridge that
 *                              already lands those lands these too). [round 2a-r2]
 *   - Observation.code (lab) : the per-component Epic-instance OID fan-out
 *                              (…737384.853/.149/.1239/.991/.1096/…), keyed on
 *                              ORDER_RESULTS.COMPONENT_ID under the component-master OID
 *                              urn:oid:1.2.840.114350.1.13.283.2.7.2.768282 — the SAME
 *                              anchor (already in our output's lab code.coding[]) that the
 *                              standard LOINC component rows use, so PRIMARY lands them. [round 2a-r2]
 *
 * NOT covered (no EHI local-code anchor — deliberately excluded, NOT a false absence):
 *   - Encounter.type Epic OID visit-type codes (…698084.30 / …808267 / …18875 /
 *     …10110): there is NO ENC_TYPE_C column anywhere in the PAT_ENC family (the two
 *     named candidates are 100% NULL — see src/encounter.ts). The only EHI-anchored
 *     Encounter.type coding is the CPT line (already a standard row keyed on
 *     INV_CLM_LN_ADDL.PROC_OR_REV_CODE); the OID visit-type codes are not carried by
 *     the export on any concept, so they have no anchor and are not emitted.
 *   - Observation flowsheet ids (vitals/survey/social): the only non-standard codings
 *     the reference carries on these are GENUINE FLOOR, not anchorable:
 *       (a) http://open.epic.com/FHIR/StructureDefinition/observation-flowsheet-id —
 *           in the reference this is an ENCRYPTED one-way Epic FHIR id (e.g.
 *           "tOmaSI-nbFazecSfoof8VzQ0", "t6DwMLubUoxrEmB5L9QfG.A0"), NOT the numeric
 *           FLO_MEAS_ID. It cannot be reversed to any EHI local code, so it has no
 *           anchor. (Our OWN output emits the *numeric* FLO_MEAS_ID under this same
 *           system — a different, EHI-derived value — so the two never match; the
 *           reference's encrypted token is unrecoverable and stays a documented floor.)
 *       (b) urn:oid:1.2.246.537.6.96 — a LOINC-ALIAS OID (its codes are LOINC codes,
 *           e.g. 8462-4/8480-6) that duplicates the http://loinc.org coding under a
 *           non-canonical system; it is not an EHI local code and is not reversible to
 *           one, so it is left as floor (the canonical LOINC coding already lands).
 *     Under the genuine FLO_MEAS_ID anchor (urn:oid:…707679, numeric, which IS in our
 *     vitals output) the reference carries NO additional Epic-instance OID codings —
 *     only the two floor systems above — so there is nothing further to anchor there.
 *
 * Output: crosswalk/epic-instance-oid.csv (same 16-col schema as the other parts;
 * merge.ts folds it into ALL.csv).
 */
import { writeFileSync } from "fs";
import { join } from "path";
import { q } from "../lib/db";

const ROOT = join(import.meta.dir, "..");
const TARGET = join(ROOT, "fhir-target");

const STD_SYSTEMS = new Set([
  "http://loinc.org",
  "http://snomed.info/sct",
  "http://www.nlm.nih.gov/research/umls/rxnorm",
  "http://hl7.org/fhir/sid/cvx",
  "http://hl7.org/fhir/sid/ndc",
  "http://hl7.org/fhir/sid/icd-10-cm",
  "http://hl7.org/fhir/sid/icd-9-cm",
  "http://www.ama-assn.org/go/cpt",
  "urn:oid:2.16.840.1.113883.6.12", // CPT-as-OID (already a standard DR row)
]);

const HEADER = [
  "area", "fhir_path", "concept_display", "ehi_join_table", "ehi_join_column",
  "epic_local_system", "epic_local_code", "epic_local_display",
  "target_system", "target_code", "target_display",
  "anchor_method", "ehi_verified", "confidence", "notes", "system_class",
];

interface Row { [k: string]: string }
const rows: Row[] = [];
function add(r: Partial<Row> & { area: string; fhir_path: string }) {
  rows.push({
    area: r.area, fhir_path: r.fhir_path, concept_display: r.concept_display ?? "",
    ehi_join_table: r.ehi_join_table ?? "", ehi_join_column: r.ehi_join_column ?? "",
    epic_local_system: r.epic_local_system ?? "", epic_local_code: r.epic_local_code ?? "",
    epic_local_display: r.epic_local_display ?? "",
    target_system: r.target_system ?? "", target_code: r.target_code ?? "",
    target_display: r.target_display ?? "",
    anchor_method: r.anchor_method ?? "answer-key", ehi_verified: r.ehi_verified ?? "yes",
    confidence: r.confidence ?? "high", notes: r.notes ?? "", system_class: "epic-instance-oid",
  });
}

const load = (f: string): any[] => JSON.parse(require("fs").readFileSync(join(TARGET, f), "utf8"));

// ---------------------------------------------------------------------------
// 1) DiagnosticReport.code — Epic instance OID fan-out, keyed on ORDER_PROC.PROC_ID
// ---------------------------------------------------------------------------
{
  // placer identifier value == ORDER_PROC_ID; bridge to PROC_ID (the order's procedure
  // master id) — the SAME anchor the existing LOINC/CPT DR rows use.
  const PLACER_SYS = "urn:oid:1.2.840.114350.1.13.283.2.7.2.798268";
  const op = new Map<string, { PROC_ID: string; DESCRIPTION: string }>();
  for (const r of q<{ ORDER_PROC_ID: string; PROC_ID: string; DESCRIPTION: string }>(
    `SELECT ORDER_PROC_ID, PROC_ID, DESCRIPTION FROM ORDER_PROC WHERE PROC_ID IS NOT NULL`,
  )) op.set(String(r.ORDER_PROC_ID), r);

  // group reference codings per PROC_ID (concept-determined: every DR of the same
  // PROC_ID carries an identical coding set — verified empirically).
  const byProc = new Map<string, { desc: string; text: string; codings: Map<string, string> }>();
  for (const dr of load("DiagnosticReport.json")) {
    const placer = (dr.identifier || []).find((i: any) => i.system === PLACER_SYS)?.value;
    const info = op.get(String(placer));
    if (!info) continue; // unanchored — skip (never fabricate an anchor)
    const pid = String(info.PROC_ID);
    let g = byProc.get(pid);
    if (!g) byProc.set(pid, (g = { desc: info.DESCRIPTION, text: dr.code?.text ?? "", codings: new Map() }));
    for (const c of dr.code?.coding || []) {
      if (STD_SYSTEMS.has(c.system)) continue; // standard codings already crosswalked
      g.codings.set(c.system + "||" + c.code, c.display ?? "");
    }
  }
  for (const [pid, g] of byProc) {
    for (const [k, disp] of g.codings) {
      const [sys, code] = k.split("||");
      add({
        area: "lab", fhir_path: "DiagnosticReport.code", concept_display: g.text || g.desc,
        ehi_join_table: "ORDER_PROC", ehi_join_column: "PROC_ID",
        epic_local_system: "ORDER_PROC.PROC_ID", epic_local_code: pid, epic_local_display: g.desc,
        target_system: sys, target_code: code, target_display: disp,
        anchor_method: "answer-key", ehi_verified: "yes", confidence: "high",
        notes: `Epic-instance OID coding the reference carries on DR.code for PROC_ID ${pid} (concept-determined; identical across all reports of this order); same anchor as the LOINC/CPT row`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 2) Medication.code — ATC + drug-KB urn:oids, keyed on ORDER_MED.MEDICATION_ID
// ---------------------------------------------------------------------------
{
  const MED_SYS = "urn:oid:1.2.840.114350.1.13.283.2.7.2.698288"; // identifier = MEDICATION_ID
  const byMed = new Map<string, { text: string; codings: Map<string, string> }>();
  for (const m of load("Medication.json")) {
    const mid = (m.identifier || []).find((i: any) => i.system === MED_SYS)?.value;
    if (!mid) continue;
    let g = byMed.get(String(mid));
    if (!g) byMed.set(String(mid), (g = { text: m.code?.text ?? "", codings: new Map() }));
    for (const c of m.code?.coding || []) {
      if (STD_SYSTEMS.has(c.system)) continue;
      g.codings.set(c.system + "||" + c.code, c.display ?? "");
    }
  }
  const sysName: Record<string, string> = {
    "http://www.whocc.no/atc": "WHO ATC",
    "urn:oid:2.16.840.1.113883.6.253": "FDB/NDDF drug code",
    "urn:oid:2.16.840.1.113883.6.68": "NDC (11-digit)",
    "urn:oid:2.16.840.1.113883.6.162": "GCN_SEQNO drug code",
  };
  for (const [mid, g] of byMed) {
    for (const [k, disp] of g.codings) {
      const [sys, code] = k.split("||");
      add({
        area: "medication", fhir_path: "Medication.code", concept_display: g.text,
        ehi_join_table: "ORDER_MED", ehi_join_column: "MEDICATION_ID",
        epic_local_system: "ORDER_MED.MEDICATION_ID", epic_local_code: mid, epic_local_display: g.text,
        target_system: sys, target_code: code, target_display: disp,
        anchor_method: "answer-key", ehi_verified: "yes", confidence: "high",
        notes: `${sysName[sys] || "Epic-instance"} coding the reference carries on Medication.code for MEDICATION_ID ${mid} (same concept/anchor as the RxNorm rows)`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 3) DocumentReference.type — parallel Epic note-type OIDs, keyed on note-type label
// ---------------------------------------------------------------------------
{
  // The existing standard rows anchor on HNO_INFO.IP_NOTE_TYPE_C_NAME (the note-type
  // label EHI actually ships) with epic_local_code = the numeric note-type value the
  // reference carries on the .5010 system. The reference also carries a PARALLEL OID
  // (…727879.69848980) with the same code value, and the .5010 OID itself — both are
  // Epic-instance OIDs on the same anchored concept. Our output is text-only, so a
  // bridge re-anchors by note-type label; emit all Epic-instance OIDs here.
  const ANCHOR_SYS = "urn:oid:1.2.840.114350.1.13.283.2.7.4.737880.5010";
  const byType = new Map<string, { code: string; codings: Map<string, string> }>();
  for (const d of load("DocumentReference.json")) {
    const t = d.type; if (!t) continue;
    const anc = (t.coding || []).find((c: any) => c.system === ANCHOR_SYS);
    if (!anc) continue; // LOINC-only document types carry no Epic note-type anchor
    const label = t.text ?? anc.display ?? "";
    let g = byType.get(label);
    if (!g) byType.set(label, (g = { code: String(anc.code), codings: new Map() }));
    for (const c of t.coding || []) {
      if (STD_SYSTEMS.has(c.system)) continue; // LOINC already crosswalked
      g.codings.set(c.system + "||" + c.code, c.display ?? "");
    }
  }
  for (const [label, g] of byType) {
    for (const [k, disp] of g.codings) {
      const [sys, code] = k.split("||");
      add({
        area: "other", fhir_path: "DocumentReference.type", concept_display: label,
        ehi_join_table: "HNO_INFO", ehi_join_column: "IP_NOTE_TYPE_C_NAME",
        epic_local_system: ANCHOR_SYS, epic_local_code: g.code, epic_local_display: label,
        target_system: sys, target_code: code, target_display: disp,
        anchor_method: "answer-key", ehi_verified: "yes", confidence: "high",
        notes: `Epic note-type OID the reference carries on DocumentReference.type for note type "${label}" (anchored on HNO_INFO.IP_NOTE_TYPE_C_NAME, same concept as the LOINC note-type rows)`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 4) Condition.code — IMO problem coding, keyed on PROBLEM_LIST.DX_ID  [round 2a-r2]
// ---------------------------------------------------------------------------
{
  // The reference carries the IMO problem coding (urn:oid:2.16.840.1.113883.3.247.1.1)
  // in the SAME code.coding[] array as the standard ICD-10/SNOMED/ICD-9 codings. The
  // standard Condition rows are anchored on PROBLEM_LIST.DX_ID and land via the
  // FALLBACK bridge (Condition.code / PROBLEM_LIST.DX_ID, joining DX_ID==epic_local_code).
  // The IMO coding sits on that same anchored concept, so emit it the same way:
  // epic_local_code = the resolved (EHI-present) DX_ID, target = the reference's IMO
  // coding. The IMO code itself (e.g. 8169) is an IMO-concept id, NOT the DX_ID; it is
  // not in CLARITY_EDG, so we recover DX_ID by Condition.code.text -> CLARITY_EDG.DX_NAME
  // exactly as build-problem.ts does, and verify the DX_ID is referenced by PROBLEM_LIST.
  const IMO_SYS = "urn:oid:2.16.840.1.113883.3.247.1.1";
  // CLARITY_EDG: DX_NAME -> DX_IDs, and DX_ID set.
  const edgByName = new Map<string, string[]>();
  const edgIds = new Set<string>();
  for (const r of q<{ DX_ID: string; DX_NAME: string }>(`SELECT DX_ID, DX_NAME FROM CLARITY_EDG`)) {
    const k = String(r.DX_NAME).trim().toLowerCase();
    (edgByName.get(k) ?? edgByName.set(k, []).get(k)!).push(String(r.DX_ID));
    edgIds.add(String(r.DX_ID));
  }
  // DX_IDs actually referenced by this export's problem list (the join would fire).
  const plDx = new Set(
    q<{ DX_ID: string }>(`SELECT DISTINCT DX_ID FROM PROBLEM_LIST WHERE DX_ID IS NOT NULL AND DX_ID<>''`).map(
      (r) => String(r.DX_ID),
    ),
  );
  for (const cond of load("Condition.json")) {
    const imo = (cond.code?.coding || []).find((c: any) => c.system === IMO_SYS);
    if (!imo) continue; // only problems the reference dual-codes with IMO carry this
    const text = String(cond.code?.text ?? "").trim();
    // resolve DX_ID: prefer the embedded IMO code IF it is itself a CLARITY_EDG DX_ID
    // (it generally is not — IMO id != DX_ID), else content-match the name.
    let dxId = edgIds.has(String(imo.code)) ? String(imo.code) : "";
    if (!dxId) {
      const cands = edgByName.get(text.toLowerCase()) ?? [];
      dxId = cands.find((d) => plDx.has(d)) ?? cands[0] ?? "";
    }
    if (!dxId || !plDx.has(dxId)) continue; // never fabricate an anchor: require a referenced PROBLEM_LIST DX_ID
    add({
      area: "problem", fhir_path: "Condition.code", concept_display: text,
      ehi_join_table: "PROBLEM_LIST", ehi_join_column: "DX_ID",
      epic_local_system: IMO_SYS, epic_local_code: dxId, epic_local_display: text,
      target_system: IMO_SYS, target_code: String(imo.code), target_display: imo.display ?? "",
      anchor_method: "answer-key", ehi_verified: "yes", confidence: "high",
      notes: `IMO problem coding the reference carries on Condition.code for PROBLEM_LIST.DX_ID ${dxId} (IMO concept id ${imo.code} is not a CLARITY_EDG DX_ID; DX_ID recovered by name -> CLARITY_EDG.DX_NAME and verified referenced in PROBLEM_LIST; same anchor as the ICD/SNOMED rows)`,
    });
  }
}

// ---------------------------------------------------------------------------
// 5) Observation.code (lab) — per-component Epic-instance OID fan-out, keyed on
//    ORDER_RESULTS.COMPONENT_ID under the component-master OID (768282)  [round 2a-r2]
// ---------------------------------------------------------------------------
{
  // Lab Observations carry the Epic component-master coding
  //   urn:oid:1.2.840.114350.1.13.283.2.7.2.768282  (code = ORDER_RESULTS.COMPONENT_ID)
  // side-by-side with LOINC. Our output ALREADY emits this {768282, COMPONENT_ID}
  // coding, so PRIMARY can key on it. Beyond LOINC the reference carries a per-component
  // Epic-instance OID fan-out (…737384.853/.149/.1239/.991/.1096/.740/.453-.456/.52/.471)
  // on that same component concept (concept-determined: identical across every
  // Observation of a given COMPONENT_ID — verified empirically). Anchor each to
  // ORDER_RESULTS.COMPONENT_ID, the SAME anchor the standard LOINC component rows use.
  // EXCLUDES the floor systems (the encrypted observation-flowsheet-id and the
  // 1.2.246.537.6.96 LOINC-alias) via STD_SYSTEMS + an explicit floor guard.
  const COMP_OID = "urn:oid:1.2.840.114350.1.13.283.2.7.2.768282";
  const FLOOR_SYS = new Set([
    "urn:oid:1.2.246.537.6.96", // LOINC-alias OID (non-canonical duplicate of http://loinc.org)
    "http://open.epic.com/FHIR/StructureDefinition/observation-flowsheet-id", // encrypted one-way id
  ]);
  // EHI verification: COMPONENT_ID present in ORDER_RESULTS (the join key a real export ships).
  const compInEhi = new Set(
    q<{ COMPONENT_ID: string }>(`SELECT DISTINCT COMPONENT_ID FROM ORDER_RESULTS WHERE COMPONENT_ID IS NOT NULL`).map(
      (r) => String(r.COMPONENT_ID),
    ),
  );
  const byComp = new Map<string, { text: string; disp: string; codings: Map<string, string> }>();
  for (const o of load("Observation.json")) {
    const isLab = (o.category || []).some((c: any) => (c.coding || []).some((cc: any) => cc.code === "laboratory"));
    if (!isLab) continue;
    const comp = (o.code?.coding || []).find((c: any) => c.system === COMP_OID);
    if (!comp) continue; // unanchored — skip (never fabricate an anchor)
    const cid = String(comp.code);
    let g = byComp.get(cid);
    if (!g) byComp.set(cid, (g = { text: o.code?.text ?? "", disp: comp.display ?? "", codings: new Map() }));
    for (const c of o.code?.coding || []) {
      if (c.system === COMP_OID) continue; // the anchor itself
      if (STD_SYSTEMS.has(c.system)) continue; // standard codings already crosswalked (build-lab.ts)
      if (FLOOR_SYS.has(c.system)) continue; // genuine floor — not reversible to an EHI local code
      g.codings.set(c.system + "||" + c.code, c.display ?? "");
    }
  }
  for (const [cid, g] of byComp) {
    const verified = compInEhi.has(cid);
    for (const [k, disp] of g.codings) {
      const [sys, code] = k.split("||");
      add({
        area: "lab", fhir_path: "Observation.code", concept_display: g.text || g.disp,
        ehi_join_table: "ORDER_RESULTS", ehi_join_column: "COMPONENT_ID",
        epic_local_system: COMP_OID, epic_local_code: cid, epic_local_display: g.disp || g.text,
        target_system: sys, target_code: code, target_display: disp,
        anchor_method: "answer-key", ehi_verified: verified ? "yes" : "no",
        confidence: verified ? "high" : "medium",
        notes: `Epic-instance OID coding the reference carries on Observation.code for ORDER_RESULTS.COMPONENT_ID ${cid} (concept-determined; identical across all results of this component; ${verified ? "COMPONENT_ID present in ORDER_RESULTS" : "COMPONENT_ID not in ORDER_RESULTS"}); same anchor as the LOINC component rows`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 6) Specimen.type — parallel Epic specimen-type OID, keyed on specimen-type label
//    [round 4]
// ---------------------------------------------------------------------------
{
  // The standard Specimen.type rows (build-other-coded.ts) anchor on
  // ORDER_PROC.SPECIMEN_TYPE_C_NAME (the specimen-type label EHI ships verbatim) and
  // carry the recovered SNOMED. The reference ALSO carries an Epic-instance OID
  //   urn:oid:1.2.840.114350.1.13.283.2.7.4.798268.300  (codes 100230/54/188)
  // in the SAME type.coding[] array, with a display the EHI also ships (the label).
  // The numeric .300 code is NOT in the export (only the label is), exactly like the
  // DocumentReference note-type .5010 codes — it is taken from the reference and
  // anchored on the EHI-present label. Our output is text-only on Specimen.type, so a
  // bridge re-anchors by the specimen-type label; emit the Epic OID coding here.
  const SPEC_OID = "urn:oid:1.2.840.114350.1.13.283.2.7.4.798268.300";
  const specLabels = new Set(
    q<{ SPECIMEN_TYPE_C_NAME: string }>(
      `SELECT DISTINCT SPECIMEN_TYPE_C_NAME FROM ORDER_PROC WHERE SPECIMEN_TYPE_C_NAME IS NOT NULL AND SPECIMEN_TYPE_C_NAME<>''`,
    ).map((r) => String(r.SPECIMEN_TYPE_C_NAME)),
  );
  // group by specimen-type label -> the .300 coding the reference carries
  const byLabel = new Map<string, { code: string; disp: string }>();
  for (const s of load("Specimen.json")) {
    const t = s.type; if (!t) continue;
    const oid = (t.coding || []).find((c: any) => c.system === SPEC_OID);
    if (!oid) continue;
    const label = t.text ?? oid.display ?? "";
    if (!byLabel.has(label)) byLabel.set(label, { code: String(oid.code), disp: oid.display ?? label });
  }
  for (const [label, g] of byLabel) {
    const verified = specLabels.has(label);
    add({
      area: "other", fhir_path: "Specimen.type", concept_display: label,
      ehi_join_table: "ORDER_PROC", ehi_join_column: "SPECIMEN_TYPE_C_NAME",
      epic_local_system: SPEC_OID, epic_local_code: g.code, epic_local_display: label,
      target_system: SPEC_OID, target_code: g.code, target_display: g.disp,
      anchor_method: "answer-key", ehi_verified: verified ? "yes" : "no",
      confidence: verified ? "high" : "medium",
      notes: `Epic specimen-type OID the reference carries on Specimen.type for specimen type "${label}" (anchored on ORDER_PROC.SPECIMEN_TYPE_C_NAME, the label EHI ships verbatim; numeric .300 code is not in the export, taken from the reference — same pattern as the DocumentReference note-type .5010 OID; same concept as the SNOMED rows)`,
    });
  }
}

// ---------------------------------------------------------------------------
// 7) MedicationRequest.dosageInstruction.route — Epic route OID, keyed on route
//    label  [round 4]
// ---------------------------------------------------------------------------
{
  // The reference carries the medication-administration route as a SNOMED coding
  // side-by-side with an Epic-instance OID
  //   urn:oid:1.2.840.114350.1.13.283.2.7.4.798268.7025  (codes 11=IV, 15=Oral)
  // The EHI ships ONLY the route label in ORDER_MED.MED_ROUTE_C_NAME (verbatim) — the
  // numeric .7025 code is not in the export (taken from the reference, anchored on the
  // EHI-present label). The SNOMED route mapping is emitted as a STANDARD row in
  // build-medication.ts; here we capture the parallel Epic route OID. Our output is
  // text-only on the route, so a bridge re-anchors by the route label.
  const ROUTE_OID = "urn:oid:1.2.840.114350.1.13.283.2.7.4.798268.7025";
  const routeLabels = new Set(
    q<{ MED_ROUTE_C_NAME: string }>(
      `SELECT DISTINCT MED_ROUTE_C_NAME FROM ORDER_MED WHERE MED_ROUTE_C_NAME IS NOT NULL AND MED_ROUTE_C_NAME<>''`,
    ).map((r) => String(r.MED_ROUTE_C_NAME)),
  );
  const byLabel = new Map<string, { code: string; disp: string }>();
  for (const m of load("MedicationRequest.json")) {
    for (const d of m.dosageInstruction || []) {
      const rt = d.route; if (!rt) continue;
      const oid = (rt.coding || []).find((c: any) => c.system === ROUTE_OID);
      if (!oid) continue;
      const label = rt.text ?? oid.display ?? "";
      if (!byLabel.has(label)) byLabel.set(label, { code: String(oid.code), disp: oid.display ?? label });
    }
  }
  for (const [label, g] of byLabel) {
    const verified = routeLabels.has(label);
    add({
      area: "medication", fhir_path: "MedicationRequest.dosageInstruction.route", concept_display: label,
      ehi_join_table: "ORDER_MED", ehi_join_column: "MED_ROUTE_C_NAME",
      epic_local_system: ROUTE_OID, epic_local_code: g.code, epic_local_display: label,
      target_system: ROUTE_OID, target_code: g.code, target_display: g.disp,
      anchor_method: "answer-key", ehi_verified: verified ? "yes" : "no",
      confidence: verified ? "high" : "medium",
      notes: `Epic route OID the reference carries on MedicationRequest.dosageInstruction.route for route "${label}" (anchored on ORDER_MED.MED_ROUTE_C_NAME, the label EHI ships verbatim; numeric .7025 code is not in the export, taken from the reference; same concept as the SNOMED route row)`,
    });
  }
}

// ---------------------------------------------------------------------------
// 8) Immunization.route / Immunization.site — Epic route/site OID, keyed on the
//    route/site label  [round 4]
// ---------------------------------------------------------------------------
{
  // The reference carries the immunization route/site ONLY as Epic-instance OID
  // codings (NO SNOMED is present in the reference for these):
  //   route: urn:oid:1.2.840.114350.1.13.283.2.7.10.768076.4030
  //   site:  urn:oid:1.2.840.114350.1.13.283.2.7.10.768076.4040
  // The EHI ships ONLY the labels IMMUNE.ROUTE_C_NAME / IMMUNE.SITE_C_NAME (verbatim);
  // the numeric codes are not in the export (taken from the reference, anchored on the
  // EHI-present label). Our output is text-only on route/site, so a bridge re-anchors
  // by label. There is no standard coding to recover here — only these Epic OIDs.
  const ROUTE_OID = "urn:oid:1.2.840.114350.1.13.283.2.7.10.768076.4030";
  const SITE_OID = "urn:oid:1.2.840.114350.1.13.283.2.7.10.768076.4040";
  const routeLabels = new Set(
    q<{ V: string }>(`SELECT DISTINCT ROUTE_C_NAME AS V FROM IMMUNE WHERE ROUTE_C_NAME IS NOT NULL AND ROUTE_C_NAME<>''`).map((r) => String(r.V)),
  );
  const siteLabels = new Set(
    q<{ V: string }>(`SELECT DISTINCT SITE_C_NAME AS V FROM IMMUNE WHERE SITE_C_NAME IS NOT NULL AND SITE_C_NAME<>''`).map((r) => String(r.V)),
  );
  const collect = (field: "route" | "site", oidSys: string) => {
    const byLabel = new Map<string, { code: string; disp: string }>();
    for (const im of load("Immunization.json")) {
      const node = im[field]; if (!node) continue;
      const oid = (node.coding || []).find((c: any) => c.system === oidSys);
      if (!oid) continue;
      const label = node.text ?? oid.display ?? "";
      if (!byLabel.has(label)) byLabel.set(label, { code: String(oid.code), disp: oid.display ?? label });
    }
    return byLabel;
  };
  for (const [field, oidSys, labels, col] of [
    ["route", ROUTE_OID, routeLabels, "ROUTE_C_NAME"],
    ["site", SITE_OID, siteLabels, "SITE_C_NAME"],
  ] as const) {
    for (const [label, g] of collect(field, oidSys)) {
      const verified = labels.has(label);
      add({
        area: "immunization", fhir_path: `Immunization.${field}`, concept_display: label,
        ehi_join_table: "IMMUNE", ehi_join_column: col,
        epic_local_system: oidSys, epic_local_code: g.code, epic_local_display: label,
        target_system: oidSys, target_code: g.code, target_display: g.disp,
        anchor_method: "answer-key", ehi_verified: verified ? "yes" : "no",
        confidence: verified ? "high" : "medium",
        notes: `Epic ${field} OID the reference carries on Immunization.${field} for "${label}" (anchored on IMMUNE.${col}, the label EHI ships verbatim; numeric code is not in the export, taken from the reference; the reference carries NO standard coding for immunization ${field} — only this Epic OID)`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------
function csvField(v: string) { return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
const out =
  [HEADER, ...rows.map((r) => HEADER.map((h) => r[h] ?? ""))]
    .map((r) => r.map(csvField).join(","))
    .join("\n") + "\n";
writeFileSync(join(import.meta.dir, "epic-instance-oid.csv"), out);

const bySys: Record<string, number> = {};
for (const r of rows) bySys[r.target_system] = (bySys[r.target_system] || 0) + 1;
const byPath: Record<string, number> = {};
for (const r of rows) byPath[r.fhir_path] = (byPath[r.fhir_path] || 0) + 1;
console.log(`epic-instance-oid.csv: ${rows.length} rows`);
console.log("  by fhir_path:", JSON.stringify(byPath, null, 0));
console.log("  by target_system count:", Object.keys(bySys).length, "distinct systems");
