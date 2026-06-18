/**
 * allergy.ts — FHIR AllergyIntolerance generator for the "allergy" domain.
 *
 * Spine: ALLERGY (one row per surviving/active allergy; deleted-allergy detail is
 * suppressed from the export, leaving only an orphan PAT_ALLERGIES pointer — §32,
 * allergies guide Gotcha 3). The 4 ALLERGY rows == the 4 PROBLEM_LIST_ALL rows with
 * RECORD_TYPE_C_NAME='Allergy' == the target count of 4.
 *
 * Field map (target -> EHI), see gaps/allergy.md for everything unreachable:
 *   clinicalStatus      <- ALRGY_STATUS_C_NAME ("Active")            [HL7 code system]
 *   verificationStatus  <- "confirmed" (Epic default; ALLERGY_CERTAINTY_C_NAME NULL — gap)
 *   type                <- SEVERITY_C_NAME (mislabeled: holds the allergy TYPE, Gotcha 1)
 *   criticality         <- ALLERGY_SEVERITY_C_NAME ("High" -> "high")
 *   code.text           <- ALLERGEN_ID_ALLERGEN_NAME (coding SNOMED/NUI not in export — gap)
 *   category            <- NOT in export (Epic-derived from allergen class) — gap
 *   patient             <- patientRef
 *   onsetDateTime       <- DATE_NOTED (effective calendar date)
 *   recordedDate        <- ALRGY_ENTERED_DTTM (local, minute precision; tz/seconds — gap)
 *   reaction.manifestation.text / description <- ALLERGY_REACTIONS.REACTION_C_NAME
 *       (manifestation.coding SNOMED not in export — gap)
 *
 * EVERYTHING in the EHI is TEXT — CAST before ORDER/MIN (§17).
 */
import { q, parseEpicDateTime } from "../lib/db";
import { id, patientRef, PATIENT_PAT_ID } from "../lib/ids";
import { emit, clean } from "../lib/gen";

// This specimen's records are stamped in US Eastern *standard* time year-round
// (verified: 9:45 AM local -> 14:45Z, 2:34 PM local -> 19:34Z, both UTC-5).
// The export carries no zone or seconds, so we apply -05:00 and lose sub-minute
// precision — recorded as a gap rather than fabricated.
const LOCAL_UTC_OFFSET_HOURS = 5;

/** Epic "M/D/YYYY ..." effective date -> YYYY-MM-DD (date part only). */
function isoDate(v: unknown): string | undefined {
  const s = parseEpicDateTime(v);
  return s ? s.slice(0, 10) : undefined;
}

/** Local "M/D/YYYY h:mm:ss AM" entry instant -> UTC ISO (Z), minute precision. */
function recordedInstant(v: unknown): string | undefined {
  const s = parseEpicDateTime(v); // YYYY-MM-DDTHH:MM:SS (local wall clock, no zone)
  if (!s || s.length < 19) return undefined;
  const local = new Date(s + "Z"); // treat parsed wall-clock as if UTC, then shift
  const utc = new Date(local.getTime() + LOCAL_UTC_OFFSET_HOURS * 3600000);
  return utc.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function clinicalStatus(statusName: string | null | undefined) {
  const map: Record<string, { code: string; display: string }> = {
    Active: { code: "active", display: "Active" },
    Resolved: { code: "resolved", display: "Resolved" },
    Inactive: { code: "inactive", display: "Inactive" },
  };
  const m = statusName ? map[statusName] : undefined;
  if (!m) return undefined;
  return {
    coding: [
      {
        // No `version`: this is an HL7 constant code system, not exported data, and
        // pinning "4.0.0" (the FHIR spec version, not the code-system version) makes
        // the terminology server reject it. Leave versionless so the current
        // code-system version (1.0.1) resolves.
        system: "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical",
        code: m.code,
        display: m.display,
      },
    ],
    text: m.display,
  };
}

// ALLERGY_CERTAINTY_C_NAME is NULL in this specimen, so "confirmed" is Epic's default
// verification for a non-rejected active allergy, not an exported datum (see gaps).
const VERIFICATION_CONFIRMED = {
  coding: [
    {
      // Versionless on purpose (see clinicalStatus): "4.0.0" is the FHIR spec
      // version, not this code system's version, and pinning it breaks validation.
      system: "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification",
      code: "confirmed",
      display: "Confirmed",
    },
  ],
  text: "Confirmed",
};

/** SEVERITY_C_NAME actually holds the allergy TYPE (Gotcha 1): "Allergy" -> "allergy". */
function allergyType(typeName: string | null | undefined): string | undefined {
  if (!typeName) return undefined;
  const t = typeName.trim().toLowerCase();
  if (t === "allergy") return "allergy";
  if (t === "intolerance") return "intolerance";
  return undefined; // other ZC-type values not observed; don't guess
}

/** ALLERGY_SEVERITY_C_NAME -> FHIR criticality. "High" -> "high". */
function criticality(sev: string | null | undefined): string | undefined {
  if (!sev) return undefined;
  const s = sev.trim().toLowerCase();
  if (s === "high") return "high";
  if (s === "low") return "low";
  if (s === "unspecified") return "unable-to-assess";
  return undefined;
}

interface AllergyRow {
  ALLERGY_ID: string;
  ALLERGEN_ID_ALLERGEN_NAME: string | null;
  SEVERITY_C_NAME: string | null;          // = allergy TYPE
  ALLERGY_SEVERITY_C_NAME: string | null;  // = criticality/severity
  ALRGY_STATUS_C_NAME: string | null;
  DATE_NOTED: string | null;
  ALRGY_ENTERED_DTTM: string | null;
  REACTION: string | null;                 // free-text reaction comment (NULL here)
}

function buildAllergies(): any[] {
  // Canonical patient path: PAT_ALLERGIES -> ALLERGY (inner join drops the deleted
  // orphan stub, LINE 1 / 30689231, whose detail isn't exported — Gotcha 3).
  const rows = q<AllergyRow>(`
    SELECT a.ALLERGY_ID,
           a.ALLERGEN_ID_ALLERGEN_NAME,
           a.SEVERITY_C_NAME,
           a.ALLERGY_SEVERITY_C_NAME,
           a.ALRGY_STATUS_C_NAME,
           a.DATE_NOTED,
           a.ALRGY_ENTERED_DTTM,
           a.REACTION
      FROM PAT_ALLERGIES pa
      JOIN ALLERGY a ON a.ALLERGY_ID = pa.ALLERGY_RECORD_ID
     WHERE pa.PAT_ID = ?
     ORDER BY CAST(pa.LINE AS INTEGER)
  `, PATIENT_PAT_ID);

  // Coded reactions per allergy (ALLERGY_REACTIONS, LINE-ordered). REACTION_C_NAME is
  // the pre-resolved label; the underlying ZC code is not in the export (Gotcha 2).
  const reactRows = q<{ ALLERGY_ID: string; LINE: string; REACTION_C_NAME: string | null }>(`
    SELECT ALLERGY_ID, LINE, REACTION_C_NAME
      FROM ALLERGY_REACTIONS
     ORDER BY ALLERGY_ID, CAST(LINE AS INTEGER)
  `);
  const reactionsByAllergy = new Map<string, string[]>();
  for (const r of reactRows) {
    if (!r.REACTION_C_NAME) continue;
    const arr = reactionsByAllergy.get(r.ALLERGY_ID) ?? [];
    arr.push(r.REACTION_C_NAME);
    reactionsByAllergy.set(r.ALLERGY_ID, arr);
  }

  const resources: any[] = [];
  for (const r of rows) {
    const reactions = reactionsByAllergy.get(r.ALLERGY_ID) ?? [];
    const reaction = reactions.length
      ? reactions.map((name) => ({
          // manifestation.coding (SNOMED) is Epic-assigned and not in the export —
          // emit text only (see gaps).
          manifestation: [{ text: name }],
          description: name,
        }))
      : undefined;

    const allergen = r.ALLERGEN_ID_ALLERGEN_NAME ?? undefined;

    resources.push(
      clean({
        resourceType: "AllergyIntolerance",
        id: id.allergy(r.ALLERGY_ID),
        clinicalStatus: clinicalStatus(r.ALRGY_STATUS_C_NAME),
        verificationStatus: VERIFICATION_CONFIRMED,
        type: allergyType(r.SEVERITY_C_NAME),
        // category: Epic-derived allergen class, NOT in export — omitted (gap).
        criticality: criticality(r.ALLERGY_SEVERITY_C_NAME),
        code: allergen ? { text: allergen } : undefined,
        patient: patientRef(),
        onsetDateTime: isoDate(r.DATE_NOTED),
        recordedDate: recordedInstant(r.ALRGY_ENTERED_DTTM),
        reaction,
      })
    );
  }

  return resources;
}

function main() {
  emit("AllergyIntolerance", buildAllergies());
}

main();
