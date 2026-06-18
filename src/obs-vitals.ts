/**
 * obs-vitals.ts — Epic EHI → FHIR Observation (category = vital-signs).
 *
 * OWNS only the vital-signs Observation shard. Emits via emit("Observation", arr, "vitals").
 *
 * Spine (vitals-and-flowsheets.md): the flowsheet measurement triplet
 *   V_EHI_FLO_MEAS_VALUE.(FSD_ID,LINE)   — the VALUE (the base IP_FLWSHT_MEAS ships none; §47)
 *   IP_FLWSHT_MEAS.(FSD_ID,LINE)         — who/when metadata
 *   IP_FLWSHT_REC.FSD_ID                 — stay → INPATIENT_DATA_ID, PAT_ID
 *   PAT_ENC.INPATIENT_DATA_ID            — the encounter CSN (the only date that sorts right; §18/§5 of the guide)
 *
 * A measure is a vital iff it is filed under the "Encounter Vitals" flowsheet template
 * (IP_FLWSHT_MEAS.FLT_ID_DISPLAY_NAME) — read from the DB, NOT a hand-listed measure-id set:
 *   5  BP (packed sys/dia → component[])      8  Pulse        10 SpO2
 *   11 Height (inches → cm)                   14 Weight (oz → kg)
 *   210000000012 BP Location (coded)          210000000013 BP Position (coded)
 *   210000000014 BP Cuff Size (coded)
 * The dozens of auto-calculated formula rows (BMI, BSA, IBW, tidal volumes, weight-change…) live
 * under "Custom Formula Data" and the screening/questionnaire rows under their own screening
 * templates, so the template filter excludes them. (guide gotcha 4)
 *
 * One Observation per (FSD_ID, LINE) measurement row. This template-derived set differs from the
 * target's curated vital set by exactly two non-EHI-derivable choices (see gaps): the target drops
 * BP Location and surfaces a calculated BMI — neither distinction is recoverable from any column.
 *
 * VALUE handling keys off V_EHI_FLO_MEAS_VALUE.VALUE_TYPE_C_NAME (guide gotcha 2):
 *   "Blood Pressure"  → component[] systolic/diastolic, mm[Hg] (split MEAS_VALUE_EXTERNAL on '/');
 *                       each component.code (REQUIRED 1..1) reuses the packed-BP flowsheet-measure
 *                       coding (no per-half measure exists in this EHI) + a derived Systolic/Diastolic text
 *   "Patient Weight"  → ounces → kg     (UNITS='ounces'; /16 lb ×0.45359237; guide gotcha 3)
 *   "Patient Height"  → inches → cm     (UNITS='inches'; ×2.54)
 *   "Numeric Type"    → bare number, UCUM unit by measure (Pulse=/min, SpO2=%, BMI=kg/m2)
 *   "Custom List"     → valueCodeableConcept from the raw answer string
 *
 * CODING GAPS (gaps/obs-vitals.md): this export carries NO flowsheet→LOINC/SNOMED mapping
 * (no code column on IP_FLO_GP_DATA / IP_FLWSHT_MEAS / the view; LNC_DB_MAIN is a bare LOINC
 * dictionary with no flowsheet link). So the LOINC vital codes, the SNOMED BP-position/cuff
 * codes, the Epic FHIR flowsheet-id (`tOmaSI-…`) and the `urn:oid:1.2.246.537.6.96` codes the
 * target shows are all Epic-terminology-assigned and unreachable — we emit ONLY the flowsheet
 * measure-id coding (OID …707679, code = FLO_MEAS_ID) plus text, never a fabricated code.
 */
import { q, parseEpicDateTime } from "../lib/db";
import { id, ref, patientRef, PATIENT_PAT_ID } from "../lib/ids";
import { emit, clean } from "../lib/gen";

// Epic instance OID namespaces that genuinely back columns in THIS export.
const SYS_FLO = "urn:oid:1.2.840.114350.1.13.283.2.7.2.707679"; // flowsheet measure id (= FLO_MEAS_ID)
const SYS_ENC = "urn:oid:1.2.840.114350.1.13.283.2.7.3.698084.8"; // Encounter.identifier (CSN)
const SYS_UCUM = "http://unitsofmeasure.org";
const SYS_INTERP = "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation";
const SYS_OBSCAT = "http://terminology.hl7.org/CodeSystem/observation-category";

// Vital-signs flowsheet rows are DERIVED, not hand-listed: a measure is a vital iff it is filed
// under the "Encounter Vitals" flowsheet template (IP_FLWSHT_MEAS.FLT_ID_DISPLAY_NAME). That
// template carries exactly the 8 core vitals rows for this patient — BP(5), Pulse(8), SpO2(10),
// Height(11), Weight(14), BP Location(…012), BP Position(…013), BP Cuff Size(…014) — while every
// auto-calculated row (BMI, BSA, IBW, tidal volumes, weight-change…) lives under "Custom Formula
// Data" and every screening/questionnaire row under its own screening template. We read the
// template name from the DB; we do NOT enumerate measure ids copied from the target.
//
// NOTE (see gaps/obs-vitals.md): this template-derived set differs from the target's curated
// vital-signs set in two places that NO EHI column can predict, so we do not special-case them:
//   • BP Location (210000000012) is on this template (identical in every column to BP Position/Cuff)
//     yet the target drops it entirely. We emit it; excluding it would require lifting the answer.
//   • Calculated BMI is a "Custom Formula Data" row, not an "Encounter Vitals" row, and exists as
//     FIVE near-identical variants for this patient with no EHI flag to pick one (verified — see
//     gaps for the exact GROUP_CONCAT value sets):
//       301070 "BMI (Calculated)"  25.7,24.3,25.3,24.9,25   ← target surfaces THIS one (decimal)
//       5445   "BMI (Calculated)"  26,24,25,25,25           (same name, integer-rounded)
//       210000000020 "BMI"         24.98,25.8,24.32,25.1,25.34
//       210100200230 "BMI Frailty" 25.8,24.3,25.3,25,25.1
//       10245  'BMI >35="1"…'      0,0,0,0,0                (a threshold formula, not a BMI value)
//     Two variants share the canonical name "BMI (Calculated)" and differ only in value precision;
//     "prefer the decimal one" is a heuristic that matches the target's values, i.e. it would be
//     lifted from the answer, not derived from any EHI column. PAT_ENC.BMI is a separate encounter-
//     level source (9 values: 24.27,25.55,25.04,25.40,25.54,24.93,24.61,25.29,25.75) but those are
//     DIFFERENT numbers from the target's, so the target's BMI is the flowsheet 301070 row, not
//     PAT_ENC.BMI. No column distinguishes 301070 as "the vital", so BMI is not emitted here rather
//     than copy a specific measure id (or a precision heuristic) out of the answer.
const VITAL_TEMPLATE = "Encounter Vitals";

// UCUM unit for the bare "Numeric Type" vitals on this template whose UNITS column is NULL
// (Pulse). SpO2 (id 10) carries UNITS='%' in the DB and is read from there, not here. "/min" is
// the physiologic-standard unit for heart rate — a derivation recorded only because no UNITS
// column value exists for it.
const NUMERIC_UNIT: Record<string, { unit: string; code: string }> = {
  "8": { unit: "/min", code: "/min" }, // Pulse → heart rate (UNITS NULL)
};

type Row = Record<string, any>;

/** Epic local "M/D/YYYY h:mm:ss AM/PM" wall-clock → UTC instant (America/Chicago). */
function localToUtcInstant(v: unknown): string | undefined {
  const iso = parseEpicDateTime(v); // naive local, no zone
  if (!iso || iso.length <= 10) return iso || undefined;
  // Treat the parsed local time as America/Chicago and convert to UTC.
  const [d, t] = iso.split("T");
  const [Y, M, D] = d.split("-").map(Number);
  const [h, m, s] = t.split(":").map(Number);
  const offsetH = chicagoOffsetHours(Y, M, D, h);
  const ms = Date.UTC(Y, M - 1, D, h + offsetH, m, s || 0);
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

/** Hours to ADD to Chicago local to get UTC: 6 in CST, 5 in CDT. DST = 2nd Sun Mar .. 1st Sun Nov. */
function chicagoOffsetHours(Y: number, M: number, D: number, _h: number): number {
  const secondSundayMar = nthSunday(Y, 3, 2);
  const firstSundayNov = nthSunday(Y, 11, 1);
  const dayNum = Date.UTC(Y, M - 1, D);
  const isDst = dayNum >= Date.UTC(Y, 2, secondSundayMar) && dayNum < Date.UTC(Y, 10, firstSundayNov);
  return isDst ? 5 : 6;
}

function nthSunday(Y: number, month1: number, n: number): number {
  // day-of-month of the nth Sunday in month1 (1-based month).
  const firstDow = new Date(Date.UTC(Y, month1 - 1, 1)).getUTCDay(); // 0=Sun
  const firstSunday = 1 + ((7 - firstDow) % 7);
  return firstSunday + (n - 1) * 7;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function buildVitals(): any[] {
  const rows = q<Row>(
    `
    SELECT v.FSD_ID, v.LINE, v.FLO_MEAS_ID, v.FLO_MEAS_ID_DISP_NAME, v.VALUE_TYPE_C_NAME,
           v.UNITS, v.MEAS_VALUE_EXTERNAL,
           m.RECORDED_TIME, m.ENTRY_TIME, m.TAKEN_USER_ID, m.TAKEN_USER_ID_NAME,
           m.ABNORMAL_C_NAME, m.ABNORMAL_TYPE_C_NAME, m.EDITED_LINE,
           e.PAT_ENC_CSN_ID, e.PAT_ENC_DATE_REAL
    FROM V_EHI_FLO_MEAS_VALUE v
    JOIN IP_FLWSHT_MEAS m ON v.FSD_ID = m.FSD_ID AND v.LINE = m.LINE
    JOIN IP_FLWSHT_REC  r ON m.FSD_ID = r.FSD_ID
    JOIN PAT_ENC        e ON r.INPATIENT_DATA_ID = e.INPATIENT_DATA_ID
    WHERE m.FLT_ID_DISPLAY_NAME = ?
      AND r.PAT_ID = ?
    ORDER BY CAST(e.PAT_ENC_DATE_REAL AS REAL), CAST(v.FLO_MEAS_ID AS INTEGER), CAST(v.LINE AS INTEGER)
  `,
    VITAL_TEMPLATE,
    PATIENT_PAT_ID
  );

  // Best-effort TAKEN_USER (EMP login) → SER provider id, via exact unambiguous name match
  // (cross ID-space; §41/§6). Performer references must line up with the practitioner shard,
  // which mints ids from CLARITY_SER.PROV_ID.
  const empToSer = new Map<string, string>();
  for (const e of q<Row>(
    `SELECT emp.USER_ID, s.PROV_ID
       FROM CLARITY_EMP emp
       JOIN CLARITY_SER s ON s.PROV_NAME = emp.NAME
      GROUP BY emp.USER_ID HAVING COUNT(*) = 1`
  )) {
    empToSer.set(String(e.USER_ID), String(e.PROV_ID));
  }

  const out: any[] = [];

  for (const r of rows) {
    const fmid = String(r.FLO_MEAS_ID);
    const name = String(r.FLO_MEAS_ID_DISP_NAME);
    const raw = r.MEAS_VALUE_EXTERNAL == null ? "" : String(r.MEAS_VALUE_EXTERNAL).trim();
    if (raw === "") continue; // no reading

    const obs: any = {
      resourceType: "Observation",
      id: id.observation(`flo-${r.FSD_ID}-${r.LINE}`),
      // EDITED_LINE is populated exactly on the rows the target marks "amended" (the 9/28/2023
      // weight & BMI re-edit); everything else is a final reading.
      status: r.EDITED_LINE != null ? "amended" : "final",
      category: [
        {
          coding: [{ system: SYS_OBSCAT, code: "vital-signs", display: "Vital Signs" }],
          text: "Vital Signs",
        },
      ],
      code: {
        coding: [{ system: SYS_FLO, code: fmid, display: name }],
        text: name,
      },
      subject: patientRef(),
    };

    // Encounter: reference + the export's own CSN identifier (no Epic-assigned "Office Visit"
    // type display — that label isn't reachable from PAT_ENC here; see gaps).
    if (r.PAT_ENC_CSN_ID != null) {
      const csn = String(r.PAT_ENC_CSN_ID);
      obs.encounter = {
        ...ref("Encounter", id.encounter(csn)),
        identifier: { use: "usual", system: SYS_ENC, value: csn },
      };
    }

    const eff = localToUtcInstant(r.RECORDED_TIME);
    if (eff) obs.effectiveDateTime = eff;
    const iss = localToUtcInstant(r.ENTRY_TIME);
    if (iss) obs.issued = iss;

    // Performer: the taking user, mapped EMP→SER so it resolves to a Practitioner resource.
    if (r.TAKEN_USER_ID != null) {
      const ser = empToSer.get(String(r.TAKEN_USER_ID));
      if (ser) obs.performer = [ref("Practitioner", id.practitioner(ser), r.TAKEN_USER_ID_NAME || undefined)];
    }

    // Abnormal flag → interpretation. Vitals abnormal flags are essentially absent in this
    // export (exactly the one High BP); ABNORMAL_C_NAME='Yes' → v3 "A" (Abnormal). (guide gotcha 7)
    if (String(r.ABNORMAL_C_NAME || "").toLowerCase() === "yes") {
      obs.interpretation = [{ coding: [{ system: SYS_INTERP, code: "A", display: "Abnormal" }] }];
    }

    // VALUE — branch on VALUE_TYPE_C_NAME (guide gotcha 2).
    const vtype = String(r.VALUE_TYPE_C_NAME || "");
    if (vtype === "Blood Pressure") {
      const m = raw.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
      if (m) {
        const sys = Number(m[1]);
        const dia = Number(m[2]);
        // The export packs BP as a single "142/74" string under ONE flowsheet measure
        // (FLO_MEAS_ID=5, "BP"); there is NO distinct systolic/diastolic flowsheet measure in this
        // EHI (verified: IP_FLO_GP_DATA / IP_FLOWSHEET_ROWS / V_EHI_FLO_MEAS_VALUE carry only the
        // packed "BP" row — see gaps). So neither sub-component has its own FLO_MEAS_ID, code, or
        // terminology, and the LOINC codes 8480-6/8462-4 the target shows are Epic-assigned, absent
        // here. component.code is REQUIRED (1..1), so we derive it ONLY from data that is genuinely
        // in the EHI: the parent BP flowsheet-measure coding (SYS_FLO + fmid + name) — identical for
        // both components because the EHI gives them the same identity — plus a text label that
        // names the structural half ("BP Systolic" / "BP Diastolic") we split out of the value. The
        // measure name ("BP") IS from the EHI; "Systolic"/"Diastolic" is the derivation we record.
        const bpCoding = { system: SYS_FLO, code: fmid, display: name };
        obs.component = [
          {
            code: { coding: [bpCoding], text: `${name} Systolic` },
            valueQuantity: { value: sys, unit: "mm[Hg]", system: SYS_UCUM, code: "mm[Hg]" },
          },
          {
            code: { coding: [bpCoding], text: `${name} Diastolic` },
            valueQuantity: { value: dia, unit: "mm[Hg]", system: SYS_UCUM, code: "mm[Hg]" },
          },
        ];
      }
    } else if (vtype === "Patient Weight") {
      // stored in ounces (guide gotcha 3) → kg
      const oz = Number(raw);
      if (isFinite(oz)) {
        obs.valueQuantity = { value: round1((oz / 16) * 0.45359237), unit: "kg", system: SYS_UCUM, code: "kg" };
      }
    } else if (vtype === "Patient Height") {
      // stored in inches → cm
      const inch = Number(raw);
      if (isFinite(inch)) {
        obs.valueQuantity = { value: round1(inch * 2.54), unit: "cm", system: SYS_UCUM, code: "cm" };
      }
    } else if (vtype === "Numeric Type") {
      const n = Number(raw);
      if (isFinite(n)) {
        // Prefer the unit carried in the export's UNITS column (SpO2 ships UNITS='%'); fall back
        // to the physiologic-standard derivation only where UNITS is NULL (Pulse, BMI).
        const dbUnit = r.UNITS == null ? "" : String(r.UNITS).trim();
        const u = dbUnit ? { unit: dbUnit, code: dbUnit } : NUMERIC_UNIT[fmid];
        obs.valueQuantity = u
          ? { value: n, unit: u.unit, system: SYS_UCUM, code: u.code }
          : { value: n };
      }
    } else if (vtype === "Custom List") {
      // Coded answer (BP Position 'sitting', BP Cuff Size 'Reg'). The export ships only the raw
      // local code/label; the SNOMED equivalent and the expanded display ("Regular (Adult)") are
      // Epic-terminology-assigned and absent (see gaps).
      obs.valueCodeableConcept = { coding: [{ code: raw, display: raw }], text: raw };
    } else if (raw) {
      // Defensive: any other type ships as text.
      obs.valueString = raw;
    }

    out.push(clean(obs));
  }

  return out;
}

emit("Observation", buildVitals(), "vitals");
