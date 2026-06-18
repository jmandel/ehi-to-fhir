#!/usr/bin/env bun
/**
 * build-immunization.ts — reconstruct the immunization terminology crosswalk excerpt.
 *
 * Pairing logic:
 *   - The reference FHIR `Immunization.vaccineCode.coding[]` carries the STANDARD coding(s):
 *       CVX (http://hl7.org/fhir/sid/cvx) for every record, plus NDC for one record.
 *   - The Epic-LOCAL join key the EHI actually ships for that resource is the immunization
 *     record id, surfaced in FHIR `Immunization.identifier` under
 *       urn:oid:1.2.840.114350.1.13.283.2.7.2.768076  (value == IMMUNE.IMMUNE_ID).
 *   - We pair (IMMUNE_ID -> CVX) and verify IMMUNE_ID is present in IMMUNE.IMMUNE_ID.
 *   - For the one record that also carries an NDC, we emit a sibling NDC row, verified
 *     against IMMUNE.NDC_NUM_ID_NDC_CODE.
 *
 * Output: crosswalk/immunization.csv (RFC-4180).
 */
import { q1 } from "../lib/db";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const HEADER =
  "area,fhir_path,concept_display,ehi_join_table,ehi_join_column,epic_local_system,epic_local_code,epic_local_display,target_system,target_code,target_display,anchor_method,ehi_verified,confidence,notes";

const IMMUNE_OID = "urn:oid:1.2.840.114350.1.13.283.2.7.2.768076";
const CVX = "http://hl7.org/fhir/sid/cvx";
const NDC = "http://hl7.org/fhir/sid/ndc";

function csvField(v: string): string {
  if (v == null) v = "";
  if (/[",\r\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}
function row(cells: string[]): string {
  return cells.map(csvField).join(",");
}

type Imm = {
  id: string;
  vaccineText: string;
  immuneId: string | null; // identifier value under 768076 OID
  cvx: string | null;
  ndc: string | null;
};

const target = JSON.parse(
  readFileSync(resolve(import.meta.dir, "..", "fhir-target", "Immunization.json"), "utf8"),
) as any[];

const imms: Imm[] = target.map((r) => {
  const ident = (r.identifier ?? []).find((i: any) => i.system === IMMUNE_OID);
  const codings = r.vaccineCode?.coding ?? [];
  const cvx = codings.find((c: any) => c.system === CVX)?.code ?? null;
  const ndc = codings.find((c: any) => c.system === NDC)?.code ?? null;
  return {
    id: r.id,
    vaccineText: r.vaccineCode?.text ?? "",
    immuneId: ident?.value ?? null,
    cvx,
    ndc,
  };
});

const rows: string[] = [HEADER];

for (const imm of imms) {
  // Look up the EHI IMMUNE row by the record id (the join key the export ships).
  const dbRow = imm.immuneId
    ? q1<{
        IMMUNE_ID: string;
        IMMUNZATN_ID: string | null;
        IMMUNZATN_ID_NAME: string | null;
        NDC_NUM_ID_NDC_CODE: string | null;
      }>(
        `SELECT IMMUNE_ID, IMMUNZATN_ID, IMMUNZATN_ID_NAME, NDC_NUM_ID_NDC_CODE
         FROM IMMUNE WHERE IMMUNE_ID = ?`,
        imm.immuneId,
      )
    : undefined;

  const verified = dbRow ? "yes" : "no";
  const localDisplay = dbRow?.IMMUNZATN_ID_NAME ?? imm.vaccineText;

  // CVX row (every record has a CVX in vaccineCode).
  if (imm.cvx) {
    rows.push(
      row([
        "immunization",
        "Immunization.vaccineCode",
        imm.vaccineText,
        "IMMUNE",
        "IMMUNE_ID",
        IMMUNE_OID,
        imm.immuneId ?? "",
        localDisplay,
        CVX,
        imm.cvx,
        imm.vaccineText,
        "dual-coding",
        verified,
        verified === "yes" ? "high" : "low",
        `IMMUNE_ID is the record-level join key (FHIR identifier 768076); vaccine type IMMUNZATN_ID=${dbRow?.IMMUNZATN_ID ?? "?"} carries the CVX concept`,
      ]),
    );
  }

  // NDC sibling row (only one record carries an NDC in vaccineCode).
  if (imm.ndc) {
    const ndcVerified = dbRow?.NDC_NUM_ID_NDC_CODE === imm.ndc ? "yes" : "no";
    rows.push(
      row([
        "immunization",
        "Immunization.vaccineCode",
        imm.vaccineText,
        "IMMUNE",
        "IMMUNE_ID",
        IMMUNE_OID,
        imm.immuneId ?? "",
        localDisplay,
        NDC,
        imm.ndc,
        imm.vaccineText,
        "dual-coding",
        ndcVerified,
        ndcVerified === "yes" ? "high" : "low",
        `NDC sibling coding; verified against IMMUNE.NDC_NUM_ID_NDC_CODE for IMMUNE_ID=${imm.immuneId}`,
      ]),
    );
  }
}

writeFileSync(resolve(import.meta.dir, "immunization.csv"), rows.join("\r\n") + "\r\n");

// Tally for the operator.
const data = rows.slice(1);
const verifiedRows = data.filter((r) => /,yes,(high|medium|low),/.test(r)).length;
console.log(`rows=${data.length} verifiedRows=${verifiedRows}`);
