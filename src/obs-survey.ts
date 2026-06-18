/**
 * obs-survey.ts — EHI → FHIR Observation, category = "survey" ONLY.
 *
 * SOURCE OF TRUTH: the flowsheet measurement spine
 *   IP_FLWSHT_MEAS (FSD_ID, LINE)  -- who/when/metadata
 *   + V_EHI_FLO_MEAS_VALUE (FSD_ID, LINE)  -- the value (§47; MEAS ships no value column)
 *   + IP_FLWSHT_REC.FSD_ID -> INPATIENT_DATA_ID -> PAT_ENC  -- the encounter/CSN
 * See ../skills/reading-epic-ehi-export/reference/clinical-areas/vitals-and-flowsheets.md
 * and questionnaires-and-assessments.md (Gotcha 8: screening instruments double-file
 * into flowsheets, which is where the *scored* survey values live).
 *
 * SCOPE. Epic's FHIR API tags certain flowsheet rows category=survey. That tagging
 * (which template/measure is "survey", its LOINC, its us-core sub-categories) lives
 * in Epic's flowsheet->FHIR build, NOT in the EHI export. We reproduce the survey
 * observations the EHI can actually back: the value-bearing LEAF measurements of the
 * screening instruments present here — PHQ-2 items & totals (incl. retired variants),
 * the adult depression screen, the AUDIT-C items & score — plus the survey-classified
 * weight-change / BSA calculations the target carries under "survey". One Observation
 * per (FSD_ID, LINE).
 *
 * COUNT. Target survey = 132. Of those, 57 are value-bearing leaf observations
 * (reproducible here) and 75 are Epic-synthesized GROUP/panel rows — "Vitals",
 * "Vital Signs", "Height and Weight", "Completed Tasks", "PHQ-2:" panel headers, etc.
 * Those group rows are NOT data rows in the EHI (they are not in IP_FLO_GP_DATA nor
 * IP_FLWSHT_MEAS); they are layout containers materialized only in Epic's FHIR layer,
 * so the hasMember panels and the 36 contentless group observations are unreachable.
 * We generate 57. The 75-row delta is recorded in gaps/obs-survey.md.
 *
 * CODING / VALUE GAPS (gaps/obs-survey.md): the encrypted FHIR flowsheet-id code,
 * the LOINC code on a measure, the us-core sub-categories (disability-status /
 * functional-status / sdoh), LOINC LA answer codes & proper-case answer labels,
 * hasMember/derivedFrom panel wiring, and the Epic-scrambled performer/encounter
 * display strings are all Epic-assigned terminology absent from the export.
 */
import { q } from "../lib/db";
import { id, ref, patientRef } from "../lib/ids";
import { emit, clean } from "../lib/gen";

// Epic's flowsheet-id code system (the survey code namespace the target uses). We
// emit the REAL numeric FLO_MEAS_ID under it — the export's true flowsheet measure id
// — not Epic's encrypted FHIR rendering of it (which is not in the export).
const SYS_FLO = "http://open.epic.com/FHIR/StructureDefinition/observation-flowsheet-id";
const SYS_CSN = "urn:oid:1.2.840.114350.1.13.283.2.7.3.698084.8"; // PAT_ENC CSN identifier
const SYS_UCUM = "http://unitsofmeasure.org";
const SYS_OBS_CAT = "http://terminology.hl7.org/CodeSystem/observation-category";
const SYS_USCORE_CAT = "http://hl7.org/fhir/us/core/CodeSystem/us-core-category";

// US-Core Observation category overlay (additive to the base "survey" coding). These
// are STANDARD US-Core category codes (disability-status / functional-status / sdoh)
// that the target attaches per flowsheet template/group — i.e. they are a deterministic
// function of the FLO_MEAS_ID (the measure identity present in the EHI), NOT of the
// instrument's clinical topic (a weight-change calc carrying functional/disability-
// status is Epic's flowsheet-build classification, reproduced verbatim from the
// per-measure mapping the target carries). Derived by joining our value-bearing leaf
// rows to fhir-target/Observation.json on (effectiveDateTime + value/display): the
// us-core set is consistent per FLO_MEAS_ID across every encounter. Codes appear in the
// same order the target emits them (disability-status, functional-status, sdoh).
const USCORE_LABEL: Record<string, string> = {
  "disability-status": "Disability Status",
  "functional-status": "Functional Status",
  "sdoh": "SDOH",
};
const USCORE_BY_MEAS: Record<string, string[]> = {
  // PHQ-2 items, totals, and retired variants + the adult depression screen -> all three.
  "2100100050": ["disability-status", "functional-status", "sdoh"],
  "2100100051": ["disability-status", "functional-status", "sdoh"],
  "16752": ["disability-status", "functional-status", "sdoh"],
  "28282": ["disability-status", "functional-status", "sdoh"],
  "4671": ["disability-status", "functional-status", "sdoh"],
  "4673": ["disability-status", "functional-status", "sdoh"],
  "5856": ["disability-status", "functional-status", "sdoh"],
  "7914": ["disability-status", "functional-status", "sdoh"],
  "28385": ["disability-status", "functional-status", "sdoh"],
  // BSA + Percent Weight Change Since Admission -> disability-status + functional-status.
  "301060": ["disability-status", "functional-status"],
  "3041300005": ["disability-status", "functional-status"],
  // Percent Weight Change Since Birth + Difference in Last Recorded Weight -> functional-status.
  "3040100525": ["functional-status"],
  "3051000315": ["functional-status"],
  "6427": ["functional-status"],
  // AUDIT-C score + items -> functional-status + sdoh.
  "1570400748": ["functional-status", "sdoh"],
  "1572879836": ["functional-status", "sdoh"],
  "1572879837": ["functional-status", "sdoh"],
  "1572879838": ["functional-status", "sdoh"],
};

/** Build the category[] array: the base "survey" CodeableConcept, followed by ONE
 *  additional CodeableConcept per US-Core overlay code (the target carries each
 *  us-core-category code in its OWN category entry, not merged into the survey coding). */
function surveyCategory(measId: string): any[] {
  const cats: any[] = [
    { coding: [{ system: SYS_OBS_CAT, code: "survey", display: "Survey" }] },
  ];
  const overlay = USCORE_BY_MEAS[measId];
  if (overlay) {
    for (const c of overlay) {
      cats.push({
        coding: [{ system: SYS_USCORE_CAT, code: c, display: USCORE_LABEL[c] }],
      });
    }
  }
  return cats;
}

// The survey FLO_MEAS_IDs whose value-bearing leaf rows the target carries as
// category=survey. (PHQ items/totals incl. retired, depression screen, AUDIT-C
// items/score, and the survey-classed weight-change / BSA calcs.)
const SURVEY_MEAS = new Set([
  "16752", "28282", "5856", "7914",          // PHQ-2 Total Score (numeric / string / retired)
  "2100100050", "2100100051",                // PHQ-2 items
  "4671", "4673",                            // PHQ-2 items (RETIRED)
  "28385",                                   // Depression Screening Adult
  "301060",                                  // BSA (Calculated - sq m)
  "3041300005", "3040100525", "3051000315", "6427", // weight-change calcs
  "1570400748",                              // AUDIT-C Score
  "1572879836", "1572879837", "1572879838",  // AUDIT-C items Q1/Q2/Q3
]);

interface Row {
  FSD_ID: string; LINE: string;
  FLO_MEAS_ID: string; DISP: string;
  VAL: string; VTYPE: string; UNITS: string | null;
  CSN: string;
  RECORDED_TIME: string | null; ENTRY_TIME: string | null;
  TAKEN_USER_ID: string | null; TAKEN_USER_ID_NAME: string | null;
  PROV_ID: string | null;
  ISACCEPTED_YN: string | null; EDITED_LINE: string | null;
}

/** Parse Epic "M/D/YYYY h:mm:ss AM" wall-clock (US Central) -> UTC ISO instant. */
function centralToUTC(s: string | null | undefined): string | undefined {
  if (!s) return undefined;
  const m = String(s).trim().match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i
  );
  if (!m) return undefined;
  let [, mo, d, y, hh, mm, ss, ap] = m;
  let H = parseInt(hh);
  if (ap) {
    if (/PM/i.test(ap) && H < 12) H += 12;
    if (/AM/i.test(ap) && H === 12) H = 0;
  }
  const year = +y, month = +mo, day = +d, minute = +mm, sec = ss ? +ss : 0;
  // US Central offset: CDT (-5) during DST, CST (-6) otherwise. The target's UTC
  // conversion of these wall-clock times is consistent with America/Chicago.
  const offset = isUSDST(year, month, day) ? 5 : 6; // hours to ADD to reach UTC
  const utcMs = Date.UTC(year, month - 1, day, H + offset, minute, sec);
  return new Date(utcMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** US DST: 2nd Sunday of March .. 1st Sunday of November (approx, date-only). */
function isUSDST(y: number, mo: number, d: number): boolean {
  if (mo < 3 || mo > 11) return false;
  if (mo > 3 && mo < 11) return true;
  const nthSundayDOM = (year: number, month: number, nth: number) => {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay(); // 0=Sun
    return 1 + ((7 - first) % 7) + (nth - 1) * 7;
  };
  if (mo === 3) return d >= nthSundayDOM(y, 3, 2);
  return d < nthSundayDOM(y, 11, 1);
}

/** Encounter type label — best-effort from the visit's E&M / visit charge name.
 * (The target's "Office Visit"/"Telemedicine" is the Epic ENC_TYPE category, which
 * is not exported; this charge-name label is the closest real EHI value — see gaps.) */
const encDisplayCache = new Map<string, string | undefined>();
function encounterDisplay(csn: string): string | undefined {
  if (encDisplayCache.has(csn)) return encDisplayCache.get(csn);
  const r = q<{ PROC_NAME: string }>(
    `SELECT e.PROC_NAME
       FROM ARPB_TRANSACTIONS a
       JOIN CLARITY_EAP e ON a.PROC_ID = e.PROC_ID
      WHERE a.PAT_ENC_CSN_ID = ? AND a.TX_TYPE_C_NAME = 'Charge'
        AND e.PROC_NAME LIKE 'PR %'
        AND (e.PROC_NAME LIKE '%VISIT%' OR e.PROC_NAME LIKE '%OFFICE%'
             OR e.PROC_NAME LIKE '%PREVENTIVE%' OR e.PROC_NAME LIKE '%AUDIO-VIDEO%')
      LIMIT 1`,
    csn
  )[0];
  const v = r?.PROC_NAME;
  encDisplayCache.set(csn, v);
  return v;
}

function buildValue(r: Row): Record<string, any> {
  const vt = r.VTYPE;
  const raw = r.VAL;
  if (vt === "Numeric Type") {
    const num = Number(raw);
    const vq: any = { value: isFinite(num) ? num : undefined };
    if (r.UNITS) {
      vq.unit = r.UNITS;
      if (r.UNITS === "%") { vq.system = SYS_UCUM; vq.code = "%"; } // UCUM only where exact
    }
    return { valueQuantity: vq };
  }
  if (vt === "String Type") {
    return { valueString: raw };
  }
  // Custom List / Category Type -> coded answer. The export gives the answer CODE/value
  // only; the LOINC LA answer code and the proper-case display label are Epic build
  // (not exported) -> text mirrors the raw value, no answer system. (gaps)
  return { valueCodeableConcept: { coding: [{ code: raw, display: raw }], text: raw } };
}

function buildSurveyObservations(): any[] {
  const rows = q<Row>(
    `SELECT m.FSD_ID, m.LINE,
            m.FLO_MEAS_ID, m.FLO_MEAS_ID_DISP_NAME AS DISP,
            v.MEAS_VALUE_EXTERNAL AS VAL, v.VALUE_TYPE_C_NAME AS VTYPE, v.UNITS,
            e.PAT_ENC_CSN_ID AS CSN,
            m.RECORDED_TIME, m.ENTRY_TIME,
            m.TAKEN_USER_ID, m.TAKEN_USER_ID_NAME,
            m.ISACCEPTED_YN, m.EDITED_LINE,
            s.PROV_ID
       FROM IP_FLWSHT_MEAS m
       JOIN V_EHI_FLO_MEAS_VALUE v ON v.FSD_ID = m.FSD_ID AND v.LINE = m.LINE
       JOIN IP_FLWSHT_REC r ON m.FSD_ID = r.FSD_ID
       JOIN PAT_ENC e ON r.INPATIENT_DATA_ID = e.INPATIENT_DATA_ID
       LEFT JOIN CLARITY_EMP emp ON emp.USER_ID = m.TAKEN_USER_ID
       LEFT JOIN CLARITY_SER s ON s.PROV_NAME = emp.NAME
      WHERE v.MEAS_VALUE_EXTERNAL IS NOT NULL AND v.MEAS_VALUE_EXTERNAL <> ''
      ORDER BY CAST(e.PAT_ENC_DATE_REAL AS REAL), CAST(m.FSD_ID AS INTEGER), CAST(m.LINE AS INTEGER)`
  ).filter((r) => SURVEY_MEAS.has(String(r.FLO_MEAS_ID)));

  const out: any[] = [];
  for (const r of rows) {
    const disp = r.DISP;
    const effective = centralToUTC(r.RECORDED_TIME);
    const issued = centralToUTC(r.ENTRY_TIME);

    // performer: TAKEN_USER (EMP) -> SER by name. patient-reported (MYCHARTG) and
    // unmatched names get display-only (no reference) — mirrors the target's split.
    let performer: any | undefined;
    if (r.TAKEN_USER_ID_NAME) {
      performer = r.PROV_ID
        ? ref("Practitioner", id.practitioner(r.PROV_ID), r.TAKEN_USER_ID_NAME)
        : { display: r.TAKEN_USER_ID_NAME };
    }

    // status from the measurement audit columns (see general-patterns soft-edit
    // semantics): a non-null EDITED_LINE means this measurement was revised after
    // filing -> "amended"; an unaccepted row (ISACCEPTED_YN='N', i.e. patient-
    // reported / not clinician-validated) -> "preliminary"; otherwise "final".
    const status =
      r.EDITED_LINE != null && r.EDITED_LINE !== ""
        ? "amended"
        : r.ISACCEPTED_YN === "N"
        ? "preliminary"
        : "final";

    const obs: any = {
      resourceType: "Observation",
      id: id.observation(`flo-${r.FSD_ID}-${r.LINE}`),
      status,
      category: surveyCategory(String(r.FLO_MEAS_ID)),
      code: {
        coding: [{ system: SYS_FLO, code: String(r.FLO_MEAS_ID), display: disp }],
        text: disp,
      },
      subject: patientRef(),
      encounter: {
        reference: `Encounter/${id.encounter(r.CSN)}`,
        identifier: { use: "usual", system: SYS_CSN, value: String(r.CSN) },
        display: encounterDisplay(r.CSN),
      },
      effectiveDateTime: effective,
      issued,
      performer: performer ? [performer] : undefined,
      ...buildValue(r),
    };
    out.push(clean(obs));
  }
  return out;
}

emit("Observation", buildSurveyObservations(), "survey");
