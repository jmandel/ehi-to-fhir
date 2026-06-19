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
import { readFileSync } from "fs";
import { resolve } from "path";
import { q } from "../lib/db";
import { isoDate, localToUtcInstant } from "../lib/time";
import { id, patientRef, PATIENT_PAT_ID } from "../lib/ids";
import { emit, clean } from "../lib/gen";
import { concept } from "../lib/cc";

/**
 * FHIR AllergyIntolerance.category — Epic's server-side allergen-class classification
 * (food/medication/biologic). NO allergen-class column ships in the EHI (ALLERGY has none;
 * CL_ELG carries only the name), so the only reconstruction is by ALLERGEN_ID pairing —
 * the same pattern as the existing AllergyIntolerance.code crosswalk bridge. We read the
 * verified pairs from crosswalk/ALL.csv (fhir_path=AllergyIntolerance.category, keyed on
 * ALLERGEN_ID) and emit the plain `code[]` strings here in the baseline translator, because
 * apply-crosswalk only appends Coding objects to coding[] and FHIR category is a code[]
 * string array — a CSV-only add would silently do nothing. See terminology-gap-fixes 2.2/3.3.
 *
 * Returns ALLERGEN_ID -> ordered category codes (target order: e.g. TREE NUT={biologic,food}).
 */
function loadAllergyCategories(): Map<string, string[]> {
  const m = new Map<string, string[]>();
  let text: string;
  try {
    text = readFileSync(resolve(import.meta.dir, "..", "crosswalk", "ALL.csv"), "utf8");
  } catch {
    return m;
  }
  const rows = parseCsv(text);
  if (!rows.length) return m;
  const h = rows[0];
  const iPath = h.indexOf("fhir_path");
  const iCol = h.indexOf("ehi_join_column");
  const iCode = h.indexOf("epic_local_code");
  const iTgt = h.indexOf("target_code");
  if (iPath < 0 || iCol < 0 || iCode < 0 || iTgt < 0) return m;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row[iPath] !== "AllergyIntolerance.category") continue;
    if (row[iCol] !== "ALLERGEN_ID") continue;
    const allergenId = (row[iCode] ?? "").trim();
    const cat = (row[iTgt] ?? "").trim();
    if (!allergenId || !cat) continue;
    const arr = m.get(allergenId) ?? [];
    if (!arr.includes(cat)) arr.push(cat); // preserve CSV order, de-dupe
    m.set(allergenId, arr);
  }
  return m;
}

/** Minimal RFC-4180 CSV parser (quoted fields with commas/quotes/newlines). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* skip */ }
      else field += c;
    }
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Local "M/D/YYYY h:mm:ss AM" entry instant -> UTC ISO (Z). Converts the wall-clock
 * value via the configured org timezone (EHI_TZ). Previously this applied a fixed
 * Eastern -05:00 with NO DST — a bug that mis-stamped summer rows by an hour; routing
 * through the tz-aware central converter is the fix (DNM #4).
 */
const recordedInstant = (v: unknown): string | undefined => localToUtcInstant(v);

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
  ALLERGEN_ID: string | null;
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
           a.ALLERGEN_ID,
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

  const categoriesByAllergen = loadAllergyCategories();

  const resources: any[] = [];
  for (const r of rows) {
    const reactions = reactionsByAllergy.get(r.ALLERGY_ID) ?? [];
    const category = r.ALLERGEN_ID ? categoriesByAllergen.get(String(r.ALLERGEN_ID)) : undefined;
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
        // category: Epic-derived allergen class — reconstructed by ALLERGEN_ID pairing
        // (crosswalk AllergyIntolerance.category). FHIR category is a code[] string array.
        category: category && category.length ? category : undefined,
        criticality: criticality(r.ALLERGY_SEVERITY_C_NAME),
        code: concept(allergen),
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
