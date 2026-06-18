/**
 * location-org.ts — FHIR Location + Organization from the Epic EHI export.
 *
 * Domain "location-org". Owns: Location, Organization.
 *
 * LOCATION
 *   Epic's patient-facing FHIR Locations in this specimen are the *departments*
 *   (CLARITY_DEP) the patient was actually seen in (referenced by PAT_ENC.DEPARTMENT_ID)
 *   plus one service-area "place" (the unique CLARITY_SA with a patient-facing
 *   EXTERNAL_NAME, "UnityPoint Health").
 *   Department display = EXTERNAL_NAME (patient-facing) coalesced to DEPARTMENT_NAME
 *   (general-patterns Gotcha 8 in providers guide). The external sentinel dept (8,
 *   "GENERIC EXTERNAL DATA DEPARTMENT") is excluded (§44).
 *   Location ids are minted id.location(DEPARTMENT_ID) so the Encounter domain's
 *   location refs line up; the service-area place uses id.location("LOC-10").
 *
 * ORGANIZATION
 *   - The billing/facility org "Mac Associated Physicians LLP": its name + Epic
 *     service-area id come from the CLARITY_SA whose name contains the patient's
 *     primary-location EXTERNAL_NAME (derives to SERV_AREA_ID 18); its NPI / taxonomy /
 *     tax-id / address come from the 837 claim image billing-provider block
 *     (CLM_VALUES.BIL_PROV_*), matched by name.
 *   - Result-lab orgs referenced by orders (ORDER_PROC.RESULT_LAB_ID → CLARITY_LLB).
 *   - The payer "Blue Cross of Wisconsin" (CLARITY_EPM.PAYOR_ID 1302) — id.organization(1302)
 *     so the Coverage domain's payor ref lines up.
 *
 * Everything is TEXT in the EHI (general-patterns §17). Categories ship pre-resolved
 * as *_C_NAME with no ZC_ tables (§23). Provider/SER name companions are dropped but
 * masters ship (providers guide Gotcha 2) — not relevant here, we resolve names inline.
 */
import { q, columnsOf } from "../lib/db";
import { emit, clean } from "../lib/gen";
import { id, PATIENT_PAT_ID } from "../lib/ids";
import { nn, coalesceName } from "../lib/fmt";

// Standard (non-Epic-instance) identifier systems we can legitimately assert.
const SYS_NPI = "http://hl7.org/fhir/sid/us-npi";
const SYS_TAX = "urn:oid:2.16.840.1.113883.4.4"; // US federal EIN/Tax ID
const SYS_NUCC = "urn:oid:2.16.840.1.113883.6.101"; // NUCC Health Care Provider Taxonomy

// The external-data sentinel department (§44) is identified by its name in CLARITY_DEP
// ("GENERIC EXTERNAL DATA DEPARTMENT"), not by a hardcoded id — its DEPARTMENT_ID is
// looked up at runtime so no specific record id is baked into the generator.
const SENTINEL_DEPT_NAME = "GENERIC EXTERNAL DATA DEPARTMENT";

// ---------------------------------------------------------------------------
// LOCATION
// ---------------------------------------------------------------------------
function buildLocations(): any[] {
  const out: any[] = [];

  // Departments of the EMITTED FHIR Encounters (not every PAT_ENC). The target's
  // department-Locations are exactly the departments referenced by the encounters the
  // Encounter generator actually emits, so we drive selection off the SAME emission
  // predicate (encounter.ts selectCsns). Departments referenced only by non-emitted
  // contacts (e.g. BUSINESS SERVICES / Central Scheduling) must not leak in.
  // The external-data sentinel dept (8) cannot reach an emitted encounter, but we keep
  // the guard explicit. CLARITY_DEP resolves the name.
  const depRows = q<{ DEPARTMENT_ID: string; DEPARTMENT_NAME: string | null; EXTERNAL_NAME: string | null }>(
    `SELECT d.DEPARTMENT_ID, d.DEPARTMENT_NAME, d.EXTERNAL_NAME
       FROM CLARITY_DEP d
      WHERE d.DEPARTMENT_NAME IS NOT ?
        AND d.DEPARTMENT_ID IN (
              SELECT DISTINCT e.DEPARTMENT_ID
                FROM PAT_ENC e
               WHERE e.DEPARTMENT_ID IS NOT NULL
                 AND e.CALCULATED_ENC_STAT_C_NAME = 'Complete'
                 AND (
                   e.APPT_STATUS_C_NAME IS NOT NULL
                   OR EXISTS (SELECT 1 FROM PAT_ENC_HSP h  WHERE h.PAT_ENC_CSN_ID = e.PAT_ENC_CSN_ID)
                   OR EXISTS (SELECT 1 FROM PAT_ENC_DISP p WHERE p.PAT_ENC_CSN_ID = e.PAT_ENC_CSN_ID)
                   OR (
                     EXISTS (SELECT 1 FROM HNO_INFO n           WHERE n.PAT_ENC_CSN_ID = e.PAT_ENC_CSN_ID)
                     AND EXISTS (SELECT 1 FROM PAT_ENC_RSN_VISIT r WHERE r.PAT_ENC_CSN_ID = e.PAT_ENC_CSN_ID)
                   )
                 )
            )
      ORDER BY CAST(d.DEPARTMENT_ID AS INTEGER)`,
    SENTINEL_DEPT_NAME
  );

  for (const d of depRows) {
    const name = coalesceName(d.EXTERNAL_NAME, d.DEPARTMENT_NAME); // patient-facing first (Gotcha 8)
    if (!name) continue;
    out.push(
      clean({
        resourceType: "Location",
        id: id.location(d.DEPARTMENT_ID),
        name,
        mode: "instance",
      })
    );
  }

  // The service-area "place" the patient's chart hangs under. It is the UNIQUE
  // CLARITY_SA row carrying a patient-facing EXTERNAL_NAME (every other service area
  // leaves EXTERNAL_NAME null), so we select it by that property rather than by a baked-in
  // record id. This resolves deterministically to SERV_AREA_ID 10 ("UnityPoint Health").
  // Its EXTERNAL_NAME is the FHIR Location name.
  const sa = q<{ SERV_AREA_ID: string; SERV_AREA_NAME: string | null; EXTERNAL_NAME: string | null }>(
    `SELECT SERV_AREA_ID, SERV_AREA_NAME, EXTERNAL_NAME
       FROM CLARITY_SA
      WHERE EXTERNAL_NAME IS NOT NULL
      ORDER BY CAST(SERV_AREA_ID AS INTEGER)`
  );
  for (const s of sa) {
    const name = coalesceName(s.EXTERNAL_NAME, s.SERV_AREA_NAME);
    if (!name) continue;
    out.push(
      clean({
        resourceType: "Location",
        id: id.location("LOC-" + s.SERV_AREA_ID),
        name,
        mode: "instance",
      })
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// ORGANIZATION
// ---------------------------------------------------------------------------
function buildOrganizations(): any[] {
  const out: any[] = [];

  // --- Facility / billing org: "MAC ASSOCIATED PHYSICIANS LLP".
  // The service-area row is DERIVED, not hardcoded: it is the CLARITY_SA whose
  // SERV_AREA_NAME contains the EXTERNAL_NAME of the patient's own primary location
  // (PAT_PRIM_LOC → CLARITY_LOC_2, "ASSOCIATED PHYSICIANS LLP"). This resolves
  // deterministically to SERV_AREA_ID 18. NPI / taxonomy / tax-id / address come from
  // the 837 claim image billing-provider block.
  const facSa = q<{ SERV_AREA_ID: string; SERV_AREA_NAME: string | null }>(
    `SELECT sa.SERV_AREA_ID, sa.SERV_AREA_NAME
       FROM CLARITY_SA sa
       JOIN CLARITY_LOC_2 l2 ON sa.SERV_AREA_NAME LIKE '%' || l2.EXTERNAL_NAME || '%'
       JOIN PAT_PRIM_LOC ppl ON ppl.LOC_ID = l2.LOC_ID
      WHERE ppl.PAT_ID = ?
        AND ppl.TERM_DATE IS NULL
      ORDER BY CAST(sa.SERV_AREA_ID AS INTEGER)`,
    PATIENT_PAT_ID
  )[0];

  if (facSa) {
    // The billing-provider name used to match CLM_VALUES is NOT a copied literal: it is
    // the EXTERNAL_NAME of the patient's own primary location (PAT_PRIM_LOC → CLARITY_LOC_2),
    // which for this facility renders as "ASSOCIATED PHYSICIANS LLP" — the same string Epic
    // stamps into the 837 billing-provider last-name field. Derived at runtime so no
    // facility name is baked into the generator.
    const bilName = q<{ EXTERNAL_NAME: string | null }>(
      `SELECT l2.EXTERNAL_NAME
         FROM PAT_PRIM_LOC ppl
         JOIN CLARITY_LOC_2 l2 ON l2.LOC_ID = ppl.LOC_ID
        WHERE ppl.PAT_ID = ?
          AND ppl.TERM_DATE IS NULL
        ORDER BY CAST(ppl.LINE AS INTEGER)`,
      PATIENT_PAT_ID
    ).map((r) => nn(r.EXTERNAL_NAME)).find(Boolean);

    // Pull the billing-provider record whose name is our facility's. We key off the
    // claim image (CLM_VALUES) — the only place the NPI/TAX/address materialize.
    const bil = bilName
      ? q<any>(
          `SELECT DISTINCT BIL_PROV_NAM_LAST, BIL_PROV_NPI, BIL_PROV_TAXONOMY,
                            BIL_PROV_TAXID_QUAL, BIL_PROV_TAXID,
                            BIL_PROV_ADDR_1, BIL_PROV_ADDR_2, BIL_PROV_CITY,
                            BIL_PROV_STATE, BIL_PROV_ZIP
             FROM CLM_VALUES
            WHERE BIL_PROV_NAM_LAST = ?`,
          bilName
        )[0]
      : undefined;

    const identifiers: any[] = [];
    // Epic service-area master id (the value is in the EHI; the Epic OID namespace is not).
    // Emit as a plain value-only identifier (no fabricated system).
    // NPI + Tax-ID carry standard systems we can legitimately assert.
    if (bil && nn(bil.BIL_PROV_NPI)) {
      identifiers.push({
        use: "usual",
        type: { text: "NPI" },
        system: SYS_NPI,
        value: nn(bil.BIL_PROV_NPI),
      });
    }
    if (bil && nn(bil.BIL_PROV_TAXID) && nn(bil.BIL_PROV_TAXID_QUAL) === "EI") {
      identifiers.push({
        use: "usual",
        type: { text: "TAX" },
        system: SYS_TAX,
        value: nn(bil.BIL_PROV_TAXID),
      });
    }
    // Provider taxonomy (193200000X) — value lives in CLM_VALUES.BIL_PROV_TAXONOMY.
    // Asserted under the standard NUCC Health Care Provider Taxonomy OID (the
    // FHIR-recommended system), exactly as NPI is asserted under us-npi rather than the
    // Epic-instance master OID. The Epic-instance OID for this value remains a coding gap.
    if (bil && nn(bil.BIL_PROV_TAXONOMY)) {
      identifiers.push({
        use: "usual",
        system: SYS_NUCC,
        value: nn(bil.BIL_PROV_TAXONOMY),
      });
    }

    const address = bil ? buildBilAddress(bil) : undefined;

    out.push(
      clean({
        resourceType: "Organization",
        id: id.organization(facSa.SERV_AREA_ID),
        identifier: identifiers,
        active: true,
        name: nn(facSa.SERV_AREA_NAME),
        address: address ? [address] : undefined,
      })
    );
  }

  // --- Result-lab orgs referenced by the patient's *lab* orders (ORDER_PROC.RESULT_LAB_ID).
  // CLARITY_LLB is the resulting-lab master. Restrict to actual laboratory orders
  // (ORDER_TYPE_C_NAME Lab/Microbiology) — the Imaging / referral / document-storage
  // result "labs" (radiology, OnBase) are not Organizations in the FHIR view.
  // Name from CLARITY_LLB. The lab's mailing ADDRESS is recovered from the result
  // metadata of that lab's own orders (PERFORMING_ORG_INFO structured city/state/zip +
  // the "Testing performed at <org>, <street> <city>, <ST> <zip>" free-text narrative in
  // ORDER_RES_COMMENT for the street line) — see buildLabAddress. alias/telecom remain a
  // documented gap (Epic lab-interface sender config, not shipped).
  const labIds = new Set<string>();
  if (columnsOf("ORDER_PROC").includes("RESULT_LAB_ID")) {
    for (const r of q<{ RESULT_LAB_ID: string }>(
      `SELECT DISTINCT RESULT_LAB_ID FROM ORDER_PROC
        WHERE RESULT_LAB_ID IS NOT NULL
          AND ORDER_TYPE_C_NAME IN ('Lab','Microbiology')`
    ))
      if (nn(r.RESULT_LAB_ID)) labIds.add(String(r.RESULT_LAB_ID));
  }

  if (labIds.size) {
    const labs = q<{ RESULTING_LAB_ID: string; LLB_NAME: string | null }>(
      `SELECT RESULTING_LAB_ID, LLB_NAME FROM CLARITY_LLB
        WHERE RESULTING_LAB_ID IN (${[...labIds].map(() => "?").join(",")})
        ORDER BY CAST(RESULTING_LAB_ID AS INTEGER)`,
      ...[...labIds]
    );
    for (const l of labs) {
      const name = nn(l.LLB_NAME);
      if (!name) continue;
      const address = buildLabAddress(l.RESULTING_LAB_ID, name);
      out.push(
        clean({
          resourceType: "Organization",
          id: id.organization("LLB-" + l.RESULTING_LAB_ID),
          active: true,
          name, // EHI carries trailing spaces verbatim on some labs; preserved as-is.
          address: address ? [address] : undefined,
        })
      );
    }
  }

  // --- Payer org: CLARITY_EPM.PAYOR_ID (Blue Cross of Wisconsin). id.organization(PAYOR_ID)
  // so the Coverage domain's payor reference resolves.
  for (const p of q<{ PAYOR_ID: string; PAYOR_NAME: string | null }>(
    `SELECT PAYOR_ID, PAYOR_NAME FROM CLARITY_EPM ORDER BY CAST(PAYOR_ID AS INTEGER)`
  )) {
    const name = nn(p.PAYOR_NAME);
    if (!name) continue;
    out.push(
      clean({
        resourceType: "Organization",
        id: id.organization(p.PAYOR_ID),
        active: true,
        name,
      })
    );
  }

  return out;
}

// Recover a lab Organization's mailing address from its orders' result metadata.
//
// The CLARITY_LLB master carries no address. Two real performing-org sources do:
//   - PERFORMING_ORG_INFO (per order line): structured PERFORMING_ORG_CITY / STATE / ZIP
//     and the actual PERFORMING_ORG_NAME.
//   - ORDER_RES_COMMENT.RESULTS_CMT: a "Testing performed at <org>, <street> <city>, <ST>
//     <zip>" narrative carrying the STREET line (the only place it materializes).
//
// RESULT_LAB_ID alone is ambiguous (id 359 "…MERITER SUNQUEST…" appears on orders whose
// performing org is sometimes "Meriter Laboratories", sometimes "Associated Physicians
// LLP"). We disambiguate WITHOUT guessing by requiring the performing-org name to share a
// distinctive token with the LLB name (MERITER↔Meriter, ASSOCIATED↔Associated). The street
// is cut out of the narrative deterministically at the structured city string — no
// heuristic street/city split. Returns undefined if nothing matches.
function buildLabAddress(labId: string, llbName: string): any | undefined {
  // Distinctive, non-generic tokens of the LLB name to match the performing-org name on.
  const STOP = new Set(["UPH", "MADISON", "LAB", "SUNQUEST", "MAC", "LLP", "PHYSICIANS"]);
  const llbTokens = llbName
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter((t) => t.length >= 4 && !STOP.has(t));

  // Structured city/state/zip + the performing-org name, for this lab's orders.
  const rows = q<{
    PERFORMING_ORG_NAME: string | null;
    PERFORMING_ORG_CITY: string | null;
    PERFORMING_ORG_STATE_C_NAME: string | null;
    PERFORMING_ORG_ZIP_CODE: string | null;
  }>(
    `SELECT DISTINCT poi.PERFORMING_ORG_NAME, poi.PERFORMING_ORG_CITY,
                     poi.PERFORMING_ORG_STATE_C_NAME, poi.PERFORMING_ORG_ZIP_CODE
       FROM PERFORMING_ORG_INFO poi
       JOIN ORDER_PROC op ON op.ORDER_PROC_ID = poi.ORDER_ID
      WHERE op.RESULT_LAB_ID = ?`,
    labId
  );

  // The performing org whose name shares a distinctive token with the LLB name.
  const match = rows.find((r) => {
    const u = (nn(r.PERFORMING_ORG_NAME) ?? "").toUpperCase();
    return llbTokens.some((t) => u.includes(t));
  });
  if (!match) return undefined;
  const orgName = nn(match.PERFORMING_ORG_NAME);
  const city = nn(match.PERFORMING_ORG_CITY);
  const state = nn(match.PERFORMING_ORG_STATE_C_NAME);
  const zip = nn(match.PERFORMING_ORG_ZIP_CODE);
  if (!orgName) return undefined;

  // Street line ← the narrative "Testing performed at <orgName>, <street> ... <city> ...".
  // Cut at the structured city so the split is deterministic (the narrative runs street and
  // city together with no delimiter for some labs). Only this lab's own orders are read.
  let line: string | undefined;
  const cmts = q<{ RESULTS_CMT: string | null }>(
    `SELECT DISTINCT orc.RESULTS_CMT
       FROM ORDER_RES_COMMENT orc
       JOIN ORDER_PROC op ON op.ORDER_PROC_ID = orc.ORDER_ID
      WHERE op.RESULT_LAB_ID = ?
        AND orc.RESULTS_CMT LIKE ?`,
    labId,
    "Testing performed at " + orgName + ",%"
  );
  const head = "Testing performed at " + orgName + ",";
  for (const c of cmts) {
    const cmt = nn(c.RESULTS_CMT);
    if (!cmt || !cmt.startsWith(head)) continue;
    let rest = cmt.slice(head.length).trim();
    const ci = city ? rest.indexOf(city) : -1;
    if (ci > 0) rest = rest.slice(0, ci);
    const street = rest.replace(/[,\s]+$/, "").trim();
    if (street) {
      line = street;
      break;
    }
  }

  if (!line && !city && !state && !zip) return undefined;

  const cityStateZip = [city, state, zip].filter(Boolean).join(" ");
  const text = [line, cityStateZip].filter(Boolean).join("\r\n");
  return {
    use: "work",
    text: text || undefined,
    line: line ? [line] : undefined,
    city,
    state,
    postalCode: zip,
  };
}

function buildBilAddress(bil: any): any | undefined {
  const line: string[] = [];
  if (nn(bil.BIL_PROV_ADDR_1)) line.push(nn(bil.BIL_PROV_ADDR_1)!);
  if (nn(bil.BIL_PROV_ADDR_2)) line.push(nn(bil.BIL_PROV_ADDR_2)!);
  const city = nn(bil.BIL_PROV_CITY);
  const state = nn(bil.BIL_PROV_STATE);
  const zip = nn(bil.BIL_PROV_ZIP);
  if (!line.length && !city && !state && !zip) return undefined;

  // text mirrors Epic's rendered block: "<line>\r\n<CITY> <STATE> <ZIP>"
  const cityStateZip = [city, state, zip].filter(Boolean).join(" ");
  const text = [line.join("\r\n"), cityStateZip].filter(Boolean).join("\r\n");

  return {
    text: text || undefined,
    line: line.length ? line : undefined,
    city,
    state,
    postalCode: zip,
  };
}

// ---------------------------------------------------------------------------
emit("Location", buildLocations());
emit("Organization", buildOrganizations());
