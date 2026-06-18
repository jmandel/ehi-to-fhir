/**
 * immunization.ts — Epic EHI → FHIR Immunization.
 *
 * Spine: IMMUNE (the EPT/clinical per-dose ledger), reached from the patient via
 * PAT_IMMUNIZATIONS (PAT_ID → IMMUNE_ID). One Immunization per surviving IMMUNE row.
 * The export ships 19 IMMUNE rows; the target has exactly 19 Immunizations, keyed
 * by IMMUNE_ID (= Immunization.identifier.value). The 2 orphan PAT_IMMUNIZATIONS
 * bridge lines (soft-deleted doses with no IMMUNE row) are correctly excluded.
 *
 * Sources (verified against this specimen):
 *   IMMUNE                    — spine: vaccine name, date, route/site, status,
 *                               historic/external flags, lot/mfg/NDC/dose,
 *                               given-by + order linkage (in-house dose only)
 *   PAT_IMMUNIZATIONS         — patient → IMMUNE bridge (PAT_ID filter)
 *   PAT_ENC (IMM_CSN)         — entry/review encounter reference
 *   ORDER_PROC (ORDER_ID)     — ordering provider (OP performer) for in-house dose
 *   CLARITY_SER / CLARITY_EMP — provider / user display names
 *
 * CODING GAPS (each proven by a recorded search in gaps/immunization.md — re-run
 * them to falsify): this export ships NO bare _C codes and NO ZC_ tables
 * (general-patterns §23; verified: 0 site/route/reportOrigin/dose-unit _C columns,
 * 0 ZC_ tables), and NO CVX/SNOMED vaccine code anywhere (immunizations guide
 * gotcha 6; verified: find-concept "cvx"/"vaccine code" = 0, 0 %CVX% columns). So
 * vaccineCode (CVX), site, route, reportOrigin, and doseQuantity.system/code carry
 * only text/display — never a fabricated Epic-OID code. NDC is the one external code
 * present (1/19 rows, IMMUNE.NDC_NUM_ID_NDC_CODE) and IS emitted. location: the target
 * carries only a bare brand {display:"UnityPoint Health"} (on imm IMM_CSN 991225117).
 * Per the specificity principle we emit the MORE SPECIFIC, RESOLVABLE administering site
 * instead: IMMUNE.IMM_CSN → PAT_ENC.DEPARTMENT_ID → Location. Every IMM_CSN-bearing row
 * in this specimen resolves to DEPARTMENT_ID 1700801002 (CLARITY_DEP "MAC APL INTERNAL
 * MEDICINE", emitted as Location loc-1700801002); rows without an IMM_CSN have no
 * department and get no location (correct).
 */
import { q, q1 } from "../lib/db";
import { isoDate as dateOnly } from "../lib/time";
import { id, ref, patientRef, PATIENT_PAT_ID, epicOid, SYS } from "../lib/ids";
import { emit, clean } from "../lib/gen";
import { cc, concept, ident } from "../lib/cc";
import { enumMap } from "../lib/fmt";
import { empLoginToSerId } from "../lib/providers";

// Epic instance OIDs observed in the target.
const SYS_IMM = epicOid("2.7.2.768076"); // Immunization.identifier (IMMUNE_ID)
const SYS_ENC = SYS.CSN; // Encounter.identifier (CSN)
const SYS_NDC = "http://hl7.org/fhir/sid/ndc";
const SYS_PERF_FN = "http://terminology.hl7.org/CodeSystem/v2-0443";

// Translation map: Epic IMMNZTN_STATUS_C_NAME → FHIR Immunization.status (mapping
// logic, not patient data). Only "Given" occurs in this specimen.
const STATUS_MAP: Record<string, string> = {
  Given: "completed",
  "Not Given": "not-done",
  Refused: "not-done",
  Entered: "entered-in-error",
};

type Row = Record<string, any>;

/** CLARITY_DEP.DEPARTMENT_NAME for a department id (Location.display). */
const deptName = (depId: unknown): string | undefined =>
  q1<{ DEPARTMENT_NAME: string }>(`SELECT DEPARTMENT_NAME FROM CLARITY_DEP WHERE DEPARTMENT_ID = ?`, String(depId))
    ?.DEPARTMENT_NAME;

function buildImmunizations(): any[] {
  // Spine: surviving IMMUNE rows for this patient (bridge filters to the patient;
  // orphan bridge lines drop out via the inner join).
  const rows = q<Row>(
    `
    SELECT i.*
    FROM PAT_IMMUNIZATIONS pi
    JOIN IMMUNE i ON pi.IMMUNE_ID = i.IMMUNE_ID
    WHERE pi.PAT_ID = ?
    ORDER BY CAST(i.IMMUNE_ID AS INTEGER)
  `,
    PATIENT_PAT_ID
  );

  const out: any[] = [];

  for (const r of rows) {
    const immId = String(r.IMMUNE_ID);

    // --- vaccineCode: text from the type masterfile name; NDC coding when present.
    // CVX is NOT in this export -> no CVX coding (gap, crosswalk worker handles it).
    // IMMUNZATN_ID_NAME is the ONLY vaccine display the EHI carries (IMM_PRODUCT_C_NAME
    // is 0/19 populated). The export ships it UPPER-CASE ("INFLUENZA (FLUCELVAX) CCIIV4,
    // PREFILLED SYRINGE") whereas the target shows a title-cased variant ("Influenza
    // (FLUCELVAX) ccIIV4, prefilled syringe"). We keep the truthful EHI label verbatim
    // rather than fabricate casing the export does not support (a blank beats an
    // invention); the case-only delta is cosmetic and left to a tolerance rule.
    const vaccineCode: any = { text: r.IMMUNZATN_ID_NAME || undefined };
    const ndc = r.NDC_NUM_ID_NDC_CODE;
    if (ndc) vaccineCode.coding = [{ system: SYS_NDC, code: String(ndc) }];

    // --- status: derived from the Epic status name via STATUS_MAP (mapping logic).
    // 'Given' → completed is the only value in this specimen.
    const status = enumMap(r.IMMNZTN_STATUS_C_NAME, STATUS_MAP);

    // --- primarySource: a historically-documented dose (IMM_HISTORIC_ADM_YN='Y')
    // was not administered in this Epic instance -> false. The one in-house dose
    // (HISTORIC null, with order + given-by) -> true.
    const primarySource = r.IMM_HISTORIC_ADM_YN !== "Y";

    // --- reportOrigin: only the source category name is in the export (no _C code).
    const reportOrigin = r.EXTERNAL_ADMIN_C_NAME
      ? { text: r.EXTERNAL_ADMIN_C_NAME, coding: [{ display: r.EXTERNAL_ADMIN_C_NAME }] }
      : undefined;

    // --- encounter: entry/review CSN (reference + business identifier). The
    // human-facing encounter type display ("Office Visit"/"Abstract") is not in
    // the export, so no display (gap).
    const csn = r.IMM_CSN ? String(r.IMM_CSN) : undefined;
    const encounter = csn
      ? {
          reference: ref("Encounter", id.encounter(csn)).reference,
          identifier: ident(SYS_ENC, csn, { use: "usual" }),
        }
      : undefined;

    // --- location: the administering site, derived from the dose's encounter
    // (IMM_CSN → PAT_ENC.DEPARTMENT_ID → Location). More specific & resolvable than
    // the target's bare brand {display:"UnityPoint Health"}. No CSN → no department
    // → no location (correct false-absence).
    let location: any | undefined;
    if (csn) {
      const depId = q1<Row>(`SELECT DEPARTMENT_ID FROM PAT_ENC WHERE PAT_ENC_CSN_ID = ?`, csn)?.DEPARTMENT_ID;
      if (depId) location = ref("Location", id.location(depId), deptName(depId));
    }

    // --- route / site: administration route (ROUTE_C_NAME, 19/19 "Intramuscular")
    // and body-site (SITE_C_NAME, 16/19 e.g. "Left Arm"/"Right Deltoid"). The EHI
    // ships ONLY the denormalized _C_NAME label — there is no bare numeric route/site
    // _C code column and no ZC_ table (verified: IMMUNE has only ROUTE_C_NAME,
    // SITE_C_NAME, and an empty PHYSICAL_SITE), and the target's codings live in an
    // Epic-instance OID (.4030/.4040) we cannot reverse from the export. So we emit
    // .text only — no fabricated coding shell. The crosswalk worker owns adding the
    // standard route/site coding(s), anchored on this EHI text. (PHYSICAL_SITE is
    // 0/19 populated -> not used.)
    const site = concept(r.SITE_C_NAME);
    const route = concept(r.ROUTE_C_NAME);

    // --- manufacturer / lot / expiration (in-house dose only here).
    const manufacturer = r.MFG_C_NAME ? { display: r.MFG_C_NAME } : undefined;
    const lotNumber = r.LOT || undefined;
    const expirationDate = dateOnly(r.EXPIRATION_DATE);

    // --- doseQuantity: amount + unit are in the export; the Epic-OID unit system
    // /code (.4019 "1") is NOT -> value + unit text only.
    let doseQuantity: any | undefined;
    const amt = r.IMMNZTN_DOSE_AMOUNT;
    if (amt !== null && amt !== undefined && amt !== "") {
      const v = Number(amt);
      if (isFinite(v)) doseQuantity = clean({ value: v, unit: r.IMMNZTN_DOSE_UNIT_C_NAME || undefined });
    }

    // --- performer: administering (given-by user) + ordering (order's prov).
    const performer: any[] = [];
    if (r.GIVEN_BY_USER_ID) {
      const empName =
        r.GIVEN_BY_USER_ID_NAME ||
        q1<Row>(`SELECT NAME FROM CLARITY_EMP WHERE USER_ID = ?`, String(r.GIVEN_BY_USER_ID))?.NAME;
      // GIVEN_BY_USER_ID is a CLARITY_EMP.USER_ID, NOT a CLARITY_SER.PROV_ID. The
      // Practitioner domain keys on PROV_ID, so we bridge USER_ID → PROV_ID via the
      // exact, UNAMBIGUOUS name join (CLARITY_EMP.NAME = CLARITY_SER.PROV_NAME). Mint
      // the actor ref only when that resolves to exactly one PROV_ID; otherwise omit
      // the dangling reference and keep the display (false-absence over a broken ref).
      const provId = empLoginToSerId(r.GIVEN_BY_USER_ID);
      performer.push({
        function: cc(SYS_PERF_FN, "AP", "Administering Provider"),
        actor: {
          reference: provId ? ref("Practitioner", id.practitioner(provId)).reference : undefined,
          type: "Practitioner",
          display: empName || undefined,
        },
      });
    }
    if (r.ORDER_ID) {
      const op = q1<Row>(
        `SELECT AUTHRZING_PROV_ID FROM ORDER_PROC WHERE ORDER_PROC_ID = ?`,
        String(r.ORDER_ID)
      );
      const provId = op?.AUTHRZING_PROV_ID;
      if (provId) {
        const provName = q1<Row>(`SELECT PROV_NAME FROM CLARITY_SER WHERE PROV_ID = ?`, String(provId))?.PROV_NAME;
        performer.push({
          function: cc(SYS_PERF_FN, "OP", "Ordering Provider"),
          actor: {
            reference: ref("Practitioner", id.practitioner(provId)).reference,
            type: "Practitioner",
            display: provName || undefined,
          },
        });
      }
    }

    out.push(
      clean({
        resourceType: "Immunization",
        id: id.immunization(immId),
        identifier: [ident(SYS_IMM, immId, { use: "usual" })],
        status,
        vaccineCode,
        patient: patientRef(),
        encounter,
        location,
        occurrenceDateTime: dateOnly(r.IMMUNE_DATE),
        primarySource,
        reportOrigin,
        manufacturer,
        lotNumber,
        expirationDate,
        site,
        route,
        doseQuantity,
        performer: performer.length ? performer : undefined,
      })
    );
  }

  return out;
}

emit("Immunization", buildImmunizations());
