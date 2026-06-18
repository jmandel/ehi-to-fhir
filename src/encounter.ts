/**
 * encounter.ts — EHI → FHIR Encounter.
 *
 * Source spine: PAT_ENC (one row per contact, PK PAT_ENC_CSN_ID) + supplements.
 * See ../skills/reading-epic-ehi-export/reference/clinical-areas/encounters-and-visits.md
 *
 * SCOPE / COUNT: the Epic FHIR API exposes a curated subset of the 169 contacts
 * (34 in the target). That selection is Epic-internal and not deterministically
 * reproducible from the EHI tables (real telephone encounters with notes are
 * omitted; zero-content "Orders Only"/"Scanned Document" contacts are kept). We
 * approximate it with the most faithful EHI-supported rule:
 *
 *   CALCULATED_ENC_STAT_C_NAME = 'Complete'  AND
 *     ( has APPT_STATUS_C_NAME               -- booked appointment
 *     | has a PAT_ENC_HSP row                -- facility/ADT (therapy series)
 *     | has a PAT_ENC_DISP row               -- E&M level-of-service
 *     | (has a clinical note AND a reason-for-visit) )  -- documented support enc
 *
 * This yields ~35 encounters (vs 34 target); the residual count delta is an
 * irreducible Epic-API-curation gap, recorded in gaps/encounter.md.
 *
 * class: FHIR makes Encounter.class a REQUIRED v3-ActCode Coding (a STANDARD value set),
 * so it IS derived — from ADT_PAT_CLASS_C_NAME — and emitted (see buildClass()). Epic's
 * own PROPRIETARY class code (system .13260) is absent from the export and not reproduced.
 *
 * CODING GAPS: the Epic numeric codes + OID systems for type (visit-type labels, the
 * "Elective" acuity, the .808267 visit-type, the CPT line), admitSource, and
 * dischargeDisposition are NOT in the export; the accidentrelated extension is absent.
 * type[] is now PARTIALLY emitted as TEXT from real EHI labels: "Elective"
 * (PAT_ENC.HOSP_ADMSN_TYPE_C_NAME) and the telehealth visit type (CLARITY_PRC.EXTERNAL_NAME
 * via PAT_CANCEL_PROC) — see buildTypes(). NOTE: real CPT codes DO exist in the export
 * (SVC_LN_INFO.LN_PROC_CD, qual 'HC': 99213/99396…), correcting the prior false claim that
 * "no CPT column exists" — but they are a lossy claim-service-line proxy (no CSN key,
 * date-only link that over-emits non-type lines and diverges from the target's coded LOS),
 * so the CPT type line is deliberately NOT emitted (false-presence avoidance), recorded in
 * gaps/encounter.md. reasonCode IS real EHI data (PAT_ENC_RSN_VISIT.ENC_REASON_ID is the
 * code in the CL_RSN_FOR_VISIT OID; HOV therapy contacts add HSP_ADMIT_DIAG→CLARITY_EDG).
 */
import { existsSync, readdirSync } from "fs";
import { resolve } from "path";
import { q, q1 } from "../lib/db";
import { id, ref, patientRef } from "../lib/ids";
import { emit, clean } from "../lib/gen";

// Epic OID systems that appear in the export's own identifier columns (not Epic
// terminology we'd be inventing): the CSN identifier system and the reason-for-visit
// master. These are the export's structural identifier namespaces.
const SYS_CSN = "urn:oid:1.2.840.114350.1.13.283.2.7.3.698084.8";
const SYS_REASON = "urn:oid:1.2.840.114350.1.13.283.2.7.2.728286"; // CL_RSN_FOR_VISIT
const SYS_HSP_ACCT = "urn:oid:1.2.840.114350.1.13.283.2.7.2.726582"; // hospital account

const PARTICIPATION = "http://terminology.hl7.org/CodeSystem/v3-ParticipationType";

// FHIR R4 makes Encounter.class a REQUIRED (1..1) Coding, drawn from the v3-ActCode
// "ActEncounterCode" value set. This is a STANDARD HL7 code system (not Epic terminology),
// so — unlike Epic's proprietary class/type codes (system …696784.13260) which are absent
// from the export — we can and must derive it. We map Epic's patient-class signal
// (ADT_PAT_CLASS_C_NAME) to the standard v3-ActCode. See buildClass() / gaps/encounter.md.
const SYS_ACTCODE = "http://terminology.hl7.org/CodeSystem/v3-ActCode";

/** Parse "M/D/YYYY h:mm:ss AM" as America/Chicago wall time → ISO instant (UTC, Z). */
function chicagoToISO(v: unknown): string | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const m = String(v).trim().match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i
  );
  if (!m) return undefined;
  let [, mo, d, y, hh, mm, ss, ap] = m;
  if (hh === undefined) return undefined; // date-only, no usable instant
  let H = parseInt(hh);
  if (ap) {
    if (/PM/i.test(ap) && H < 12) H += 12;
    if (/AM/i.test(ap) && H === 12) H = 0;
  }
  const Y = +y, MO = +mo, D = +d, MI = +(mm ?? 0), S = +(ss ?? 0);
  // Determine the Chicago UTC offset (CST -6 / CDT -5) for this local date.
  const offset = chicagoOffsetHours(Y, MO, D, H);
  const utcMs = Date.UTC(Y, MO - 1, D, H - offset, MI, S);
  return new Date(utcMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** US Central DST: 2nd Sunday of March 02:00 → 1st Sunday of November 02:00 = CDT(-5), else CST(-6). */
function chicagoOffsetHours(Y: number, MO: number, D: number, H: number): number {
  const nthSunday = (year: number, month: number, n: number) => {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay(); // 0=Sun
    return 1 + ((7 - first) % 7) + (n - 1) * 7;
  };
  const marSun = nthSunday(Y, 3, 2);
  const novSun = nthSunday(Y, 11, 1);
  const afterStart = MO > 3 || (MO === 3 && (D > marSun || (D === marSun && H >= 2)));
  const beforeEnd = MO < 11 || (MO === 11 && (D < novSun || (D === novSun && H < 2)));
  return afterStart && beforeEnd ? -5 : -6;
}

/** Effective contact day (YYYY-MM-DD) from *_DATE_REAL or CONTACT_DATE. */
function contactDay(e: any): string | undefined {
  // CONTACT_DATE renders the calendar day; parse "M/D/YYYY ..." → ISO date.
  const m = String(e.CONTACT_DATE ?? "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  // CONTACT_DATE is M/D/YYYY → m[1]=month, m[2]=day, m[3]=year.
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return undefined;
}

const provName = (provId: any): string | undefined =>
  q1<{ PROV_NAME: string }>(`SELECT PROV_NAME FROM CLARITY_SER WHERE PROV_ID = ?`, String(provId))?.PROV_NAME;

const deptName = (depId: any): string | undefined =>
  q1<{ DEPARTMENT_NAME: string }>(`SELECT DEPARTMENT_NAME FROM CLARITY_DEP WHERE DEPARTMENT_ID = ?`, String(depId))
    ?.DEPARTMENT_NAME;

function selectCsns(): string[] {
  const rows = q<{ csn: string }>(`
    SELECT e.PAT_ENC_CSN_ID AS csn
    FROM PAT_ENC e
    WHERE e.CALCULATED_ENC_STAT_C_NAME = 'Complete'
      AND (
        e.APPT_STATUS_C_NAME IS NOT NULL
        OR EXISTS (SELECT 1 FROM PAT_ENC_HSP h  WHERE h.PAT_ENC_CSN_ID = e.PAT_ENC_CSN_ID)
        OR EXISTS (SELECT 1 FROM PAT_ENC_DISP d WHERE d.PAT_ENC_CSN_ID = e.PAT_ENC_CSN_ID)
        OR (
          EXISTS (SELECT 1 FROM HNO_INFO n          WHERE n.PAT_ENC_CSN_ID = e.PAT_ENC_CSN_ID)
          AND EXISTS (SELECT 1 FROM PAT_ENC_RSN_VISIT r WHERE r.PAT_ENC_CSN_ID = e.PAT_ENC_CSN_ID)
        )
      )
    ORDER BY CAST(e.PAT_ENC_DATE_REAL AS REAL)
  `);
  return rows.map((r) => String(r.csn));
}

/**
 * Referential closure — CSNs of real PAT_ENC contacts that are REFERENCED by a
 * resource we emit but that selectCsns() drops (no APPT_STATUS / no PAT_ENC_HSP /
 * no PAT_ENC_DISP / no note-with-reason). These contacts are genuine 'Complete'
 * PAT_ENC rows; because emitted resources point at them, internal referential
 * integrity REQUIRES we also emit them (as faithful EHI-derived stubs via the
 * normal buildEncounters path). We MIRROR each referrer's reference-emission
 * predicate so we add exactly the CSNs that are actually referenced:
 *
 *   - Immunization.encounter   ← IMMUNE.IMM_CSN (immunization.ts emits a ref
 *                                whenever IMM_CSN is present).
 *   - MedicationRequest.encounter ← ORDER_MED.PAT_ENC_CSN_ID, but only for
 *                                NON-inpatient orders (medication.ts omits the
 *                                Encounter reference when ORDERING_MODE_C_NAME =
 *                                'Inpatient').
 *   - DocumentReference.context.encounter ← HNO_INFO.PAT_ENC_CSN_ID for the notes
 *                                documentreference.ts actually materializes: a
 *                                Signed/Addendum note that is shared-with-patient
 *                                or Patient-Instructions AND has an exported
 *                                Rich-Text body (the body is the join key).
 */
function referencedClosureCsns(): string[] {
  const refd = new Set<string>();

  // Immunization.encounter ← IMMUNE.IMM_CSN
  for (const r of q<{ csn: string }>(`SELECT IMM_CSN AS csn FROM IMMUNE WHERE IMM_CSN IS NOT NULL`)) {
    refd.add(String(r.csn));
  }

  // MedicationRequest.encounter ← ORDER_MED.PAT_ENC_CSN_ID (non-inpatient only)
  for (const r of q<{ csn: string }>(
    `SELECT PAT_ENC_CSN_ID AS csn FROM ORDER_MED
      WHERE PAT_ENC_CSN_ID IS NOT NULL
        AND (ORDERING_MODE_C_NAME IS NULL OR ORDERING_MODE_C_NAME <> 'Inpatient')`
  )) {
    refd.add(String(r.csn));
  }

  // DocumentReference.context.encounter ← HNO_INFO.PAT_ENC_CSN_ID for emitted notes.
  // Candidate-note predicate mirrors documentreference.ts (Signed/Addendum +
  // shared-with-patient or Patient Instructions); then require an exported RTF body.
  const rtf = new Set<string>();
  const rtfDir = resolve(import.meta.dir, "..", "..", "raw", "Rich Text");
  if (existsSync(rtfDir)) {
    for (const f of readdirSync(rtfDir)) {
      const m = f.match(/^HNO_(\d+)_/i);
      if (m) rtf.add(m[1]);
    }
  }
  const noteRows = q<{ NOTE_ID: string; csn: string }>(
    `SELECT DISTINCT h.NOTE_ID, h.PAT_ENC_CSN_ID AS csn
       FROM HNO_INFO h
       JOIN NOTE_ENC_INFO e ON e.NOTE_ID = h.NOTE_ID
      WHERE h.PAT_ENC_CSN_ID IS NOT NULL
        AND e.NOTE_STATUS_C_NAME IN ('Signed','Addendum')
        AND (
              EXISTS (SELECT 1 FROM NOTE_ENC_INFO s
                       WHERE s.NOTE_ID = h.NOTE_ID AND s.NOTE_SHARED_W_PAT_HX_YN = 'Y')
              OR h.IP_NOTE_TYPE_C_NAME = 'Patient Instructions'
              OR h.NOTE_TYPE_NOADD_C_NAME = 'Patient Instructions'
            )`
  );
  for (const r of noteRows) {
    if (rtf.has(String(r.NOTE_ID))) refd.add(String(r.csn));
  }

  // Keep only real 'Complete' PAT_ENC rows (never fabricate a non-existent contact).
  const out: string[] = [];
  for (const csn of refd) {
    const row = q1<{ csn: string }>(
      `SELECT PAT_ENC_CSN_ID AS csn FROM PAT_ENC
        WHERE PAT_ENC_CSN_ID = ? AND CALCULATED_ENC_STAT_C_NAME = 'Complete'`,
      csn
    );
    if (row) out.push(csn);
  }
  return out;
}

function buildReasonCodes(csn: string) {
  const out: any[] = [];

  // Outpatient reason-for-visit: PAT_ENC_RSN_VISIT.ENC_REASON_ID IS the code in the
  // CL_RSN_FOR_VISIT OID — emitted with real system + code + display.
  const rsn = q<{ ENC_REASON_ID: string; REASON_VISIT_NAME: string }>(
    `SELECT r.ENC_REASON_ID, c.REASON_VISIT_NAME
     FROM PAT_ENC_RSN_VISIT r
     LEFT JOIN CL_RSN_FOR_VISIT c ON r.ENC_REASON_ID = c.REASON_VISIT_ID
     WHERE r.PAT_ENC_CSN_ID = ?
     ORDER BY CAST(r.LINE AS INTEGER)`,
    csn
  );
  for (const r of rsn) {
    const text = r.REASON_VISIT_NAME ?? undefined;
    out.push(
      clean({
        coding: r.ENC_REASON_ID
          ? [{ system: SYS_REASON, code: String(r.ENC_REASON_ID), display: text }]
          : undefined,
        text,
      })
    );
  }

  // Facility/HOV reason-for-visit: the therapy-series HOV contacts carry NO
  // PAT_ENC_RSN_VISIT row; their reason is the admit diagnosis in HSP_ADMIT_DIAG
  // (DX_ID → CLARITY_EDG.DX_NAME). The target emits this as a SNOMED-coded reasonCode,
  // but no DX_ID→SNOMED map ships (CLARITY_EDG has only DX_ID/DX_NAME), so we emit the
  // diagnosis as text only — its display matches the target exactly (e.g. CSN 922943112:
  // DX_ID 284018 = "Late effect of traumatic injury to brain").
  const adm = q<{ DX_NAME: string }>(
    `SELECT e.DX_NAME
     FROM HSP_ADMIT_DIAG d JOIN CLARITY_EDG e ON d.DX_ID = e.DX_ID
     WHERE d.PAT_ENC_CSN_ID = ? AND e.DX_NAME IS NOT NULL
     ORDER BY CAST(d.LINE AS INTEGER)`,
    csn
  );
  for (const a of adm) {
    out.push(clean({ text: a.DX_NAME }));
  }

  return out;
}

/**
 * Encounter.type — PARTIALLY DERIVED (text-only, from real EHI labels).
 *
 * The target's type[] mixes several Epic-terminology codings. We emit the entries whose
 * LABEL is genuinely present in the export (as type[].text), and we deliberately omit the
 * ones whose value is unrecoverable or only available as a lossy proxy. The Epic numeric
 * codes + OID systems themselves (…698084.18875, …2.808267, …698084.30, …698084.10110)
 * are NOT in the export, so we never emit a coding for these — text only (principle 3:
 * codes only when truly present).
 *
 * EMITTED (label faithfully in the export):
 *   1. "Elective" acuity  ← PAT_ENC.HOSP_ADMSN_TYPE_C_NAME = 'Elective'.
 *      Exact, per-encounter source: every target encounter carrying the .18875/"Elective"
 *      type has HOSP_ADMSN_TYPE_C_NAME='Elective' and vice-versa (19/19 within the target
 *      set; the other 'Elective' PAT_ENC rows are simply not in the curated 34). Emitted
 *      as { text: "Elective" }.
 *   2. Telehealth visit type  ← CLARITY_PRC.EXTERNAL_NAME via PAT_CANCEL_PROC.CAN_PRCD_C_ID.
 *      For CSN 829213099 the per-encounter visit-type procedure 570827036 resolves to
 *      CLARITY_PRC EXTERNAL_NAME 'Telehealth' — the EXACT target type display. Emitted as
 *      { text: <EXTERNAL_NAME> }. (Only this one .808267 visit-type code is recoverable;
 *      the rest — Office Visit 570821122, Lab 570824604, etc. — are absent from every
 *      populated CSN-linked table, so no other visit-type entry is emittable.)
 *
 * OMITTED (unrecoverable or lossy proxy — recorded in gaps/encounter.md):
 *   - Visit-type labels "Office Visit"/"Telephone"/"Lab"/"Results Follow-Up"/"Telemedicine"
 *     (.698084.30): there is NO ENC_TYPE_C column anywhere in the PAT_ENC family; the two
 *     named candidates (PAT_ENC_6.HUS_VISIT_TYPE_C_NAME, PAT_ENC_BILLING_ENC.
 *     BILLING_ENC_TYPE_C_NAME) are 100% NULL. Genuinely absent.
 *   - "Virtual Care Visit" for CSN 1127808563: a real telehealth SIGNAL exists
 *     (PATIENT_ENC_VIDEO_VISIT.PAT_ENC_LVL_VIDEO_VISIT_ID is populated only for this CSN;
 *     ARPB charge "SYNCHRONOUS AUDIO-VIDEO VISIT"), but NO matching label string is in the
 *     export — emitting the target text "Virtual Care Visit"/"Telemedicine" would be
 *     fabricating a label, so we omit it (signal noted in gaps).
 *   - The CPT-coded level-of-service line (99213/99396…). CONTRARY to the old assertion
 *     that "the CPT is stripped — no CPT/HCPCS column anywhere," real CPT codes DO exist:
 *     SVC_LN_INFO.LN_PROC_CD (LN_PROC_QUAL='HC') = 99213/99214/99395/99396… (also
 *     INV_CLM_LN_ADDL.UB_CPT_CODE, HSP_TX_LINE_INFO.LL_CPT_CODE). BUT this is a lossy
 *     claim-service-line proxy, not the encounter's coded type: SVC_LN_INFO has no CSN key
 *     (RECORD_ID=claim id; PAT_ENC.CLAIM_ID is 100% NULL) and only a service DATE, so the
 *     only link to a CSN is same-date — which (a) over-emits non-type CPTs the target never
 *     lists (labs 80048/36415, vaccines 90471, add-ons G2211), and (b) diverges from the
 *     target's coded LOS on real encounters (CSN 958148810 target=99212 but SVC/ARPB=99213
 *     'LOW MDM 20 MIN'; CSN 1127808563 target=99213 but SVC=98005/G2211). The display
 *     ("PR OFFICE/OUTPATIENT ESTABLISHED LOW MDM 20 MIN") lives separately in
 *     CLARITY_EAP.PROC_NAME (SVC_LN_INFO.LN_PROC_DESC is NULL). Attaching it per-encounter
 *     would inject wrong/extra codes (false-presence), so we do not emit it — recorded as a
 *     lossy-source gap, not a confirmed-absence.
 */
function buildTypes(csn: string, e: any) {
  const out: any[] = [];

  // 1. "Elective" acuity — PAT_ENC.HOSP_ADMSN_TYPE_C_NAME (label only; no Epic .18875 code).
  if (e.HOSP_ADMSN_TYPE_C_NAME) {
    out.push({ text: String(e.HOSP_ADMSN_TYPE_C_NAME) });
  }

  // 2. Telehealth visit type — the per-encounter visit-type procedure (PAT_CANCEL_PROC.
  //    CAN_PRCD_C_ID) resolved through CLARITY_PRC.EXTERNAL_NAME (label only; the .808267
  //    code itself is not in a coding-bearing column for this datum).
  const prc = q1<{ EXTERNAL_NAME: string; PRC_NAME: string }>(
    `SELECT c.EXTERNAL_NAME, c.PRC_NAME
     FROM PAT_CANCEL_PROC p JOIN CLARITY_PRC c ON p.CAN_PRCD_C_ID = c.PRC_ID
     WHERE p.PAT_ENC_CSN_ID = ?
     ORDER BY CAST(p.LINE AS INTEGER) LIMIT 1`,
    csn
  );
  const visitTypeLabel = prc?.EXTERNAL_NAME || prc?.PRC_NAME;
  if (visitTypeLabel) out.push({ text: String(visitTypeLabel) });

  return out.map(clean);
}

/**
 * Encounter.class — DERIVED (FHIR-required 1..1 Coding, v3-ActCode value set).
 *
 * Unlike Epic's proprietary class code (system …696784.13260: "Appointment"/"HOV"/
 * "Support OP Encounter"), which is NOT in the export, FHIR's required class value set is
 * the STANDARD v3-ActCode. We derive the standard code deterministically from the only
 * patient-class signal the export carries — ADT_PAT_CLASS_C_NAME (PAT_ENC_2 and, for
 * facility/ADT contacts, PAT_ENC_HSP) — via a small enum map (legitimate terminology
 * mapping, like a status map; no per-CSN hardcoding).
 *
 * In THIS specimen the only non-blank patient class anywhere is "Therapies Series"
 * (2 outpatient hospital-therapy contacts; ADT class is NOT Inpatient/Emergency, and
 * HOSP_ADMSN_TYPE_C_NAME is "Elective" — an outpatient/scheduled flag, not an admission).
 * Outpatient hospital therapy is ambulatory care, so it maps to AMB, as does every
 * appointment / lab / telephone / support contact. The result is AMB for all 35.
 *
 * The map keys on the standard ADT class vocabulary so that an export which DID carry
 * Inpatient/Emergency/etc. would classify correctly; the default for an unrecognized or
 * blank class is AMB — the only defensible code for an ambulatory specimen contact (all
 * selected contacts are office/lab/telephone/outpatient-therapy, none with an admission).
 *
 * NOTE on virtual (VR): the target does NOT classify these two telehealth contacts as the
 * v3-ActCode VR — its Encounter.class is the Epic PROPRIETARY class code (.696784.13260)
 * "Appointment"/"HOV", which maps to AMB (the proprietary triple is not reproduced; see
 * gaps). The telehealth SIGNAL is instead carried in Encounter.type, where it IS partly
 * derivable and now emitted: CSN 829213099 gets "Telehealth" from CLARITY_PRC.EXTERNAL_NAME
 * (via PAT_CANCEL_PROC), and CSN 1127808563 has a real video-visit signal
 * (PATIENT_ENC_VIDEO_VISIT.PAT_ENC_LVL_VIDEO_VISIT_ID populated) but no matching label
 * string to emit (see buildTypes / gaps). The old claim that telehealth is wholly
 * "unrecoverable" because EVISIT_* flags are blank was overstated — those flags being
 * blank does not mean the datum is absent.
 */
function actClass(code: string, display: string) {
  return { system: SYS_ACTCODE, code, display };
}

function buildClass(e: any, hsp: any): { system: string; code: string; display: string } {
  // Prefer the facility/ADT patient class (PAT_ENC_HSP) when present, else the encounter
  // patient class (PAT_ENC_2); both expose ADT_PAT_CLASS_C_NAME.
  const adt = q1<{ ADT_PAT_CLASS_C_NAME: string }>(
    `SELECT ADT_PAT_CLASS_C_NAME FROM PAT_ENC_2 WHERE PAT_ENC_CSN_ID = ?`,
    String(e.PAT_ENC_CSN_ID)
  )?.ADT_PAT_CLASS_C_NAME;
  const cls = (hsp?.ADT_PAT_CLASS_C_NAME || adt || "").trim().toLowerCase();

  // Epic ADT patient-class label → v3-ActCode (ActEncounterCode).
  switch (cls) {
    case "inpatient":
      return actClass("IMP", "inpatient encounter");
    case "emergency":
      return actClass("EMER", "emergency");
    case "observation":
      return actClass("OBSENC", "observation encounter");
    case "outpatient":
    case "therapies series": // outpatient hospital therapy series — ambulatory care
      return actClass("AMB", "ambulatory");
    default:
      // Blank / unrecognized: every selected contact in this export is an ambulatory
      // office/lab/telephone/outpatient-therapy visit (no admission anywhere) → AMB.
      return actClass("AMB", "ambulatory");
  }
}

function buildParticipants(e: any, csn: string) {
  const out: any[] = [];

  // Referrer (REF) — REFERRAL_SOURCE_ID → CLARITY_SER.
  if (e.REFERRAL_SOURCE_ID) {
    const nm = provName(e.REFERRAL_SOURCE_ID) ?? e.REFERRAL_SOURCE_ID_REFERRING_PROV_NAM ?? undefined;
    out.push({
      type: [{ coding: [{ system: PARTICIPATION, code: "REF", display: "referrer" }], text: "referrer" }],
      individual: { ...ref("Practitioner", id.practitioner(e.REFERRAL_SOURCE_ID), nm), type: "Practitioner" },
    });
  }

  // Level-of-service authorizing physician — PAT_ENC_DISP.LOS_AUTH_PROV_ID.
  const disp = q1<{ LOS_AUTH_PROV_ID: string }>(
    `SELECT LOS_AUTH_PROV_ID FROM PAT_ENC_DISP WHERE PAT_ENC_CSN_ID = ?`,
    csn
  );
  if (disp?.LOS_AUTH_PROV_ID) {
    const nm = provName(disp.LOS_AUTH_PROV_ID);
    out.push({
      type: [{ text: "losAuthorizingPhysician" }],
      individual: { ...ref("Practitioner", id.practitioner(disp.LOS_AUTH_PROV_ID), nm), type: "Practitioner" },
    });
  }

  // Primary participation (PART) — the visit/rendering provider, with the appt slot
  // window as the participant period (start only; slot end length is not exported).
  //
  // Suppress PART when VISIT_PROV_ID resolves to a non-clinician LAB resource (e.g.
  // CLARITY_SER 'MAC LAB APL', prov 3724611). On Lab-class contacts Epic stores the
  // laboratory pseudo-provider as the visit provider, but the curated target emits only
  // the REF participant for these — no Practitioner PART. Deterministic signal in this
  // export: PROV_NAME denoting a lab resource (matches 'MAC LAB APL' / contains ' LAB ').
  const visitNm = e.VISIT_PROV_ID ? provName(e.VISIT_PROV_ID) : undefined;
  const isLabResource = !!visitNm && / LAB /.test(` ${visitNm} `);
  if (e.VISIT_PROV_ID && !isLabResource) {
    const nm = visitNm;
    const apptStart = chicagoToISO(
      q1<{ PROV_START_TIME: string }>(
        `SELECT PROV_START_TIME FROM PAT_ENC_APPT WHERE PAT_ENC_CSN_ID = ? ORDER BY CAST(LINE AS INTEGER) LIMIT 1`,
        csn
      )?.PROV_START_TIME
    );
    out.push({
      type: [{ coding: [{ system: PARTICIPATION, code: "PART", display: "Participation" }], text: "Participation" }],
      period: apptStart ? { start: apptStart } : undefined,
      individual: ref("Practitioner", id.practitioner(e.VISIT_PROV_ID), nm),
    });
  }

  return out.map(clean);
}

function buildHospitalization(h: any) {
  if (!h) return undefined;
  const admInst = chicagoToISO(h.HOSP_ADMSN_TIME);
  const ho = clean({
    // observation-datetime extension carries the admission instant.
    extension: admInst
      ? [{ valueDateTime: admInst, url: "http://open.epic.com/FHIR/StructureDefinition/extension/observation-datetime" }]
      : undefined,
    // admitSource / dischargeDisposition: only the EHI label is available; the Epic
    // category code + OID system are not in the export → text only.
    admitSource: h.ADMIT_SOURCE_C_NAME ? { text: h.ADMIT_SOURCE_C_NAME } : undefined,
    dischargeDisposition: h.DISCH_DISP_C_NAME ? { text: h.DISCH_DISP_C_NAME } : undefined,
  });
  return Object.keys(ho).length ? ho : undefined;
}

function buildLocations(e: any, hsp: any) {
  if (!e.DEPARTMENT_ID) return [];
  // Facility (HOV) contacts carry the admit/discharge window as a location period.
  const period = hsp
    ? clean({ start: chicagoToISO(hsp.HOSP_ADMSN_TIME), end: chicagoToISO(hsp.HOSP_DISCH_TIME) })
    : undefined;
  return [
    clean({
      location: ref("Location", id.location(e.DEPARTMENT_ID), deptName(e.DEPARTMENT_ID)),
      period: period && Object.keys(period).length ? period : undefined,
    }),
  ];
}

function buildAccount(e: any) {
  if (!e.HSP_ACCOUNT_ID) return [];
  const nm = q1<{ HSP_ACCOUNT_NAME: string }>(
    `SELECT HSP_ACCOUNT_NAME FROM HSP_ACCOUNT WHERE HSP_ACCOUNT_ID = ?`,
    String(e.HSP_ACCOUNT_ID)
  )?.HSP_ACCOUNT_NAME;
  return [
    clean({
      reference: "Account/" + id.account(String(e.HSP_ACCOUNT_ID)),
      identifier: { system: SYS_HSP_ACCT, value: String(e.HSP_ACCOUNT_ID) },
      display: nm,
    }),
  ];
}

/** Encounter.period: appt slot start for booked appts; admit/disch for facility; else contact day. */
function buildPeriod(e: any, csn: string, hsp: any) {
  if (hsp) {
    const start = chicagoToISO(hsp.HOSP_ADMSN_TIME);
    const end = chicagoToISO(hsp.HOSP_DISCH_TIME);
    if (start || end) return clean({ start, end });
  }
  const apptStart = chicagoToISO(
    q1<{ PROV_START_TIME: string }>(
      `SELECT PROV_START_TIME FROM PAT_ENC_APPT WHERE PAT_ENC_CSN_ID = ? ORDER BY CAST(LINE AS INTEGER) LIMIT 1`,
      csn
    )?.PROV_START_TIME
  );
  if (apptStart) return { start: apptStart }; // slot end length not exported
  const day = contactDay(e);
  if (day) return { start: day, end: day };
  return undefined;
}

function buildEncounters() {
  // Curated selection UNION the referential closure (encounters referenced by an
  // emitted resource but dropped by selectCsns()) — required for internal
  // referential integrity. Both paths emit the same faithful EHI-derived encounter.
  const selected = selectCsns();
  const seen = new Set(selected);
  const csns = [...selected];
  for (const csn of referencedClosureCsns()) {
    if (!seen.has(csn)) {
      seen.add(csn);
      csns.push(csn);
    }
  }
  const out: any[] = [];

  for (const csn of csns) {
    const e = q1<any>(
      `SELECT PAT_ENC_CSN_ID, CONTACT_DATE, PAT_ENC_DATE_REAL, VISIT_PROV_ID,
              DEPARTMENT_ID, REFERRAL_SOURCE_ID, REFERRAL_SOURCE_ID_REFERRING_PROV_NAM,
              HSP_ACCOUNT_ID, HOSP_ADMSN_TYPE_C_NAME
       FROM PAT_ENC WHERE PAT_ENC_CSN_ID = ?`,
      csn
    );
    if (!e) continue;

    const hsp = q1<any>(
      `SELECT ADMIT_SOURCE_C_NAME, DISCH_DISP_C_NAME, HOSP_ADMSN_TIME, HOSP_DISCH_TIME,
              ADT_PAT_CLASS_C_NAME
       FROM PAT_ENC_HSP WHERE PAT_ENC_CSN_ID = ?`,
      csn
    );

    const enc = clean({
      resourceType: "Encounter",
      id: id.encounter(csn),
      identifier: [{ use: "usual", system: SYS_CSN, value: csn }],
      status: "finished", // all selected contacts are CALCULATED_ENC_STAT 'Complete'
      // class: FHIR-required v3-ActCode, DERIVED from ADT_PAT_CLASS_C_NAME (see buildClass).
      class: buildClass(e, hsp),
      type: buildTypes(csn, e),
      subject: patientRef(),
      participant: buildParticipants(e, csn),
      period: buildPeriod(e, csn, hsp),
      reasonCode: buildReasonCodes(csn),
      account: buildAccount(e),
      hospitalization: buildHospitalization(hsp),
      location: buildLocations(e, hsp),
    });

    out.push(enc);
  }
  return out;
}

emit("Encounter", buildEncounters());
