/**
 * obs-social.ts — FHIR Observation generator, "obs-social" domain.
 *
 * SHARD: ONLY category=social-history Observations. emit("Observation", arr, "social").
 *
 * Source: SOCIAL_HX (one wide row per history-review contact, re-snapshotted every
 * encounter the section is reviewed — §34) + PAT_SOCIAL_HX_DOC (the free-text
 * "Social Documentation" narrative, line-chunked child — §11). The target collapses
 * the 8 re-snapshots to a single CURRENT Observation per concept (§35), so we read
 * the LATEST snapshot (max PAT_ENC_DATE_REAL, §17/§18) for the status concepts and
 * the latest filed narrative for Social Documentation.
 *
 * Target (fhir-target/Observation.json, category=social-history) = 4 resources:
 *   1. Smoking History        (LOINC 72166-2 / SNOMED 365980008) value "Never"
 *   2. Alcohol Use History    (LOINC 11331-6 / SNOMED 228273003) value "Yes"
 *   3. Drug Use History       (LOINC 11343-1 / SNOMED 228366006) value "No"
 *   4. Social Documentation   (LOINC 29762-2)                    valueString narrative
 *
 * CODING GAPS (see gaps/obs-social.md): the EHI ships NO ZC_ tables and no
 * LOINC/SNOMED for these concepts — only the inline *_C_NAME label text ("Never",
 * "Yes", "No") and the LOINC dictionary LNC_DB_MAIN (labs only). So the code.coding
 * (LOINC/SNOMED concept) and valueCodeableConcept.coding (SNOMED answer) the target
 * carries are Epic-terminology-assigned and NOT in the export. We emit code.text and
 * valueCodeableConcept.text only — the text IS the captured datum.
 *
 * CODE.TEXT LABELS: the target's "Smoking History"/"Alcohol Use History"/"Drug Use
 * History" are LOINC concept display strings that are NOT in the EHI (they appear only
 * in _schema_* metadata). The EHI's own label for each concept is the history-review
 * type name PAT_HX_REV_TYPE.HX_REVIEWED_TYPE_C_NAME ("Tobacco", "Alcohol", "Drug Use").
 * We read those EHI labels at runtime (hxReviewLabel) rather than copy the target's
 * LOINC display — see gaps/obs-social.md.
 *
 * EVERYTHING in the EHI is TEXT — CAST before ORDER/MIN (§17).
 */
import { q, q1 } from "../lib/db";
import { id, patientRef } from "../lib/ids";
import { emit, clean } from "../lib/gen";

const CATEGORY_SOCIAL_HISTORY = [
  {
    coding: [
      {
        system: "http://terminology.hl7.org/CodeSystem/observation-category",
        code: "social-history",
        display: "Social History",
      },
    ],
    text: "Social History",
  },
];

/**
 * Central-time (America/Chicago) local-midnight of a calendar day -> UTC instant.
 * The social-history `issued` instants in the target are the snapshot/review
 * calendar date at local midnight expressed in UTC: a summer date (CDT, UTC-5)
 * renders ...T05:00:00Z, a winter date (CST, UTC-6) renders ...T06:00:00Z.
 * (Verified: smoking 2024-07-02 -> 05:00Z, alcohol/drug 2025-12-04 -> 06:00Z.)
 * We compute the offset from the actual US DST rule for that date.
 */
function isCentralDST(y: number, m: number, d: number): boolean {
  // DST: 2nd Sunday of March .. 1st Sunday of November (US rule since 2007).
  const secondSundayMar = nthSunday(y, 3, 2);
  const firstSundayNov = nthSunday(y, 11, 1);
  const t = Date.UTC(y, m - 1, d);
  return t >= Date.UTC(y, 2, secondSundayMar) && t < Date.UTC(y, 10, firstSundayNov);
}
function nthSunday(y: number, month1: number, n: number): number {
  const first = new Date(Date.UTC(y, month1 - 1, 1)).getUTCDay(); // 0=Sun
  const firstSunday = 1 + ((7 - first) % 7);
  return firstSunday + (n - 1) * 7;
}
/** "YYYY-MM-DD" calendar day -> UTC instant for Central local midnight. */
function centralMidnightToUtc(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const offset = isCentralDST(y, m, d) ? 5 : 6; // hours behind UTC
  const hh = String(offset).padStart(2, "0");
  return `${isoDate}T${hh}:00:00Z`;
}

/** Epic *_DATE_REAL (days since 1840-12-31) -> "YYYY-MM-DD". */
function dateRealIso(v: unknown): string | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Math.floor(Number(v));
  if (!isFinite(n)) return undefined;
  return new Date(Date.UTC(1840, 11, 31) + n * 86400000).toISOString().slice(0, 10);
}

/**
 * The EHI's own label for a social-history concept, read from the history-review
 * type dictionary (PAT_HX_REV_TYPE.HX_REVIEWED_TYPE_C_NAME). `like` is matched
 * against the distinct review-type names so we never hardcode the label string
 * itself — e.g. hxReviewLabel("Tobacco") returns whatever the EHI calls it.
 * Returns undefined if the EHI carries no such review type.
 */
function hxReviewLabel(like: string): string | undefined {
  return q1<{ HX_REVIEWED_TYPE_C_NAME: string }>(
    `SELECT DISTINCT HX_REVIEWED_TYPE_C_NAME FROM PAT_HX_REV_TYPE
      WHERE HX_REVIEWED_TYPE_C_NAME = ? LIMIT 1`,
    like
  )?.HX_REVIEWED_TYPE_C_NAME;
}

interface SocialRow {
  PAT_ENC_CSN_ID: string;
  ISO: string | null; // snapshot contact date (from PAT_ENC.PAT_ENC_DATE_REAL)
  TOBACCO_USER_C_NAME: string | null;
  SMOKING_TOB_USE_C_NAME: string | null;
  ALCOHOL_USE_C_NAME: string | null;
  ILL_DRUG_USER_C_NAME: string | null;
}

/** The latest SOCIAL_HX snapshot — current view (§35). */
function latestSnapshot(): SocialRow | undefined {
  return q1<SocialRow>(`
    SELECT s.PAT_ENC_CSN_ID,
           (SELECT CAST(e.PAT_ENC_DATE_REAL AS REAL) FROM PAT_ENC e
             WHERE e.PAT_ENC_CSN_ID = s.PAT_ENC_CSN_ID)            AS DR,
           s.TOBACCO_USER_C_NAME,
           s.SMOKING_TOB_USE_C_NAME,
           s.ALCOHOL_USE_C_NAME,
           s.ILL_DRUG_USER_C_NAME
      FROM SOCIAL_HX s
     ORDER BY DR DESC
     LIMIT 1
  `) as any;
}

/** Latest filed Social Documentation narrative (reassembled across LINE — §11). */
function latestSocialDoc(): { csn: string; text: string } | undefined {
  // The doc is filed only on some snapshots; take the one on the latest snapshot
  // that has a narrative (order by the snapshot's contact date, §18).
  const csns = q<{ PAT_ENC_CSN_ID: string }>(`
    SELECT DISTINCT d.PAT_ENC_CSN_ID
      FROM PAT_SOCIAL_HX_DOC d
     ORDER BY (SELECT CAST(e.PAT_ENC_DATE_REAL AS REAL) FROM PAT_ENC e
                WHERE e.PAT_ENC_CSN_ID = d.PAT_ENC_CSN_ID) DESC
  `);
  if (!csns.length) return undefined;
  const csn = csns[0].PAT_ENC_CSN_ID;
  const lines = q<{ HX_SOCIAL_DOC: string }>(
    `SELECT HX_SOCIAL_DOC FROM PAT_SOCIAL_HX_DOC
      WHERE PAT_ENC_CSN_ID = ? ORDER BY CAST(LINE AS INTEGER)`,
    csn
  );
  const text = lines.map((l) => l.HX_SOCIAL_DOC ?? "").join("");
  return text.trim() ? { csn, text } : undefined;
}

function build(): any[] {
  const snap = latestSnapshot();
  const out: any[] = [];
  if (!snap) return out;

  const snapIso = dateRealIso(
    q1<{ DR: string }>(
      `SELECT CAST(PAT_ENC_DATE_REAL AS REAL) AS DR FROM PAT_ENC WHERE PAT_ENC_CSN_ID = ?`,
      snap.PAT_ENC_CSN_ID
    )?.DR
  );

  // 1. Smoking History — status from SMOKING_TOB_USE_C_NAME (fall back to TOBACCO_USER_C_NAME).
  // NOTE: the target also carries a performer ("Ashley T"), effectivePeriod, and issued
  // anchored to ONE specific tobacco history-review event. Which review anchors the
  // observation is not derivable from the EHI (the target's chosen review shares its
  // 2024-07-02 date with a second tobacco reviewer, and is neither the latest snapshot
  // nor the latest review) — see gaps/obs-social.md. We omit those fields rather than
  // pin to the target's named provider.
  const smokingVal = snap.SMOKING_TOB_USE_C_NAME ?? snap.TOBACCO_USER_C_NAME;
  if (smokingVal) {
    out.push(
      clean({
        resourceType: "Observation",
        id: id.observation("social-smoking"),
        status: "final",
        category: CATEGORY_SOCIAL_HISTORY,
        code: { text: hxReviewLabel("Tobacco") },
        subject: patientRef(),
        valueCodeableConcept: { text: smokingVal },
      })
    );
  }

  // 2. Alcohol Use History — ALCOHOL_USE_C_NAME, anchored to the latest snapshot.
  if (snap.ALCOHOL_USE_C_NAME) {
    out.push(
      clean({
        resourceType: "Observation",
        id: id.observation("social-alcohol"),
        status: "final",
        category: CATEGORY_SOCIAL_HISTORY,
        code: { text: hxReviewLabel("Alcohol") },
        subject: patientRef(),
        issued: snapIso ? centralMidnightToUtc(snapIso) : undefined,
        valueCodeableConcept: { text: snap.ALCOHOL_USE_C_NAME },
      })
    );
  }

  // 3. Drug Use History — ILL_DRUG_USER_C_NAME, anchored to the latest snapshot.
  if (snap.ILL_DRUG_USER_C_NAME) {
    out.push(
      clean({
        resourceType: "Observation",
        id: id.observation("social-drug"),
        status: "final",
        category: CATEGORY_SOCIAL_HISTORY,
        code: { text: hxReviewLabel("Drug Use") },
        subject: patientRef(),
        issued: snapIso ? centralMidnightToUtc(snapIso) : undefined,
        valueCodeableConcept: { text: snap.ILL_DRUG_USER_C_NAME },
      })
    );
  }

  // 4. Social Documentation — the latest filed free-text narrative (valueString).
  const doc = latestSocialDoc();
  if (doc) {
    out.push(
      clean({
        resourceType: "Observation",
        id: id.observation("social-documentation"),
        status: "final",
        category: CATEGORY_SOCIAL_HISTORY,
        code: { text: hxReviewLabel("Social Documentation") },
        subject: patientRef(),
        valueString: doc.text,
      })
    );
  }

  return out;
}

emit("Observation", build(), "social");
