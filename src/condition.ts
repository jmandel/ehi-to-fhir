/**
 * condition.ts — FHIR Condition generator for the "condition" domain.
 *
 * Produces two Condition flavors, matching fhir-target/Condition.json:
 *
 *  1. problem-list-item  — one per PROBLEM_LIST row (active + resolved persist, §32).
 *       clinicalStatus (Active/Resolved), verificationStatus=confirmed,
 *       category=problem-list-item, code.text (CLARITY_EDG.DX_NAME — no ICD/SNOMED in
 *       this export, see gaps), onsetDateTime=NOTED_DATE, abatementDateTime=RESOLVED_DATE,
 *       recordedDate = earliest PROBLEM_LIST_HX entry (LINE 1), subject=Patient.
 *
 *  2. encounter-diagnosis — one per PAT_ENC_DX row (48 rows).
 *       category = [encounter-diagnosis, visit-diagnosis], code.text (DX_NAME),
 *       subject=Patient, encounter ref (CSN identifier) ONLY when the encounter was
 *       exported. recordedDate for unlinked rows = max(CONTACT_DATE, earliest
 *       ORDER_PROC.ORDER_INST else HNO_INFO.CREATE_INSTANT_DTTM on the encounter) — the dx
 *       was recorded no earlier than the visit's first order/note. Rows linked to a problem
 *       (DX_LINK_PROB_ID) additionally carry clinicalStatus/verificationStatus, onsetDateTime
 *       + recordedDate copied from the linked problem, and evidence.detail -> the
 *       problem-list Condition.
 *
 * EVERYTHING in the EHI is TEXT — CAST before ORDER/MIN. (§17)
 */
import { qIf } from "../lib/db";
import { isoDate } from "../lib/time";
import { id, ref, patientRef, SYS } from "../lib/ids";
import { emit, clean } from "../lib/gen";
import { cc, concept, category } from "../lib/cc";
import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";

// Epic CSN identifier OID (constant in the target encounter references).
const CSN_OID = SYS.CSN;

/**
 * The set of encounter CSNs that the Encounter domain actually exports as Encounter
 * resources. The target only attaches an `encounter` reference when that visit exists
 * as a resource (19 of the 27 enc-dx CSNs here) — the other 8 CSNs are administrative
 * contacts PAT_ENC keeps but the Encounter export drops, and no PAT_ENC-only predicate
 * cleanly separates them (two near-identical rows land on opposite sides). So we read
 * the Encounter domain's own output to decide. If it hasn't been built yet (standalone
 * run), we fall back to "any CSN present in PAT_ENC" — the reference is internally
 * consistent either way because both domains mint via id.encounter(csn).
 */
function exportedEncounterCsns(): Set<string> | undefined {
  const OUT = resolve(import.meta.dir, "..", "out");
  if (!existsSync(OUT)) return undefined;
  const files = readdirSync(OUT).filter(
    (f) => f === "Encounter.json" || f.startsWith("Encounter__")
  );
  if (files.length === 0) return undefined;
  const csns = new Set<string>();
  for (const f of files) {
    try {
      const arr = JSON.parse(readFileSync(resolve(OUT, f), "utf8"));
      for (const e of arr) {
        const v = e?.identifier?.find?.((i: any) => /^\d{6,}$/.test(String(i?.value)))?.value;
        if (v) csns.add(String(v));
      }
    } catch {}
  }
  return csns.size ? csns : undefined;
}

function clinicalStatus(statusName: string | null | undefined) {
  // PROBLEM_STATUS_C_NAME / HX_STATUS_C_NAME -> condition-clinical code
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
        system: "http://terminology.hl7.org/CodeSystem/condition-clinical",
        version: "4.0.0",
        code: m.code,
        display: m.display,
      },
    ],
    text: m.display,
  };
}

const VERIFICATION_CONFIRMED = {
  coding: [
    {
      system: "http://terminology.hl7.org/CodeSystem/condition-ver-status",
      version: "4.0.0",
      code: "confirmed",
      display: "Confirmed",
    },
  ],
  text: "Confirmed",
};

const CATEGORY_PROBLEM_LIST = category(
  cc("http://terminology.hl7.org/CodeSystem/condition-category", "problem-list-item", "Problem List Item")
);

const CATEGORY_ENCOUNTER_DX = category(
  cc("http://terminology.hl7.org/CodeSystem/condition-category", "encounter-diagnosis", "Encounter Diagnosis"),
  cc("http://open.epic.com/FHIR/StructureDefinition/condition-category", "visit-diagnosis", "Visit Diagnosis")
);

/** code.text from CLARITY_EDG.DX_NAME. No ICD/SNOMED/Epic codes ship in this export
 *  (CLARITY_EDG carries only DX_ID + DX_NAME), so we emit text only — see gaps. */
function codeFromDxName(dxName: string | null | undefined) {
  return concept(dxName);
}

interface ProblemRow {
  PROBLEM_LIST_ID: string;
  DX_ID: string | null;
  DX_NAME: string | null;
  PROBLEM_STATUS_C_NAME: string | null;
  NOTED_DATE: string | null;
  RESOLVED_DATE: string | null;
  FIRST_ENTRY: string | null; // earliest HX_DATE_OF_ENTRY (LINE 1)
}

function buildProblems(): { resources: any[]; byProblemId: Map<string, { conditionId: string; onset?: string; recorded?: string; display?: string; status?: string }> } {
  const rows = qIf<ProblemRow>("PROBLEM_LIST", `
    SELECT p.PROBLEM_LIST_ID,
           p.DX_ID,
           e.DX_NAME              AS DX_NAME,
           p.PROBLEM_STATUS_C_NAME,
           p.NOTED_DATE,
           p.RESOLVED_DATE,
           (SELECT h.HX_DATE_OF_ENTRY
              FROM PROBLEM_LIST_HX h
             WHERE h.PROBLEM_LIST_ID = p.PROBLEM_LIST_ID
             ORDER BY CAST(h.LINE AS INTEGER)
             LIMIT 1)            AS FIRST_ENTRY
      FROM PROBLEM_LIST p
      LEFT JOIN CLARITY_EDG e ON p.DX_ID = e.DX_ID
     ORDER BY (SELECT CAST(pp.LINE AS INTEGER) FROM PAT_PROBLEM_LIST pp
                WHERE pp.PROBLEM_LIST_ID = p.PROBLEM_LIST_ID)
  `);

  const byProblemId = new Map<string, { conditionId: string; onset?: string; recorded?: string; display?: string; status?: string }>();
  const resources: any[] = [];

  for (const r of rows) {
    const conditionId = id.condition(r.PROBLEM_LIST_ID);
    const onset = isoDate(r.NOTED_DATE);
    // recordedDate = original entry (PROBLEM_LIST_HX LINE 1); fall back to nothing.
    const recorded = isoDate(r.FIRST_ENTRY);

    const cond = clean({
      resourceType: "Condition",
      id: conditionId,
      clinicalStatus: clinicalStatus(r.PROBLEM_STATUS_C_NAME),
      verificationStatus: VERIFICATION_CONFIRMED,
      category: CATEGORY_PROBLEM_LIST,
      code: codeFromDxName(r.DX_NAME),
      subject: patientRef(),
      onsetDateTime: onset,
      abatementDateTime: isoDate(r.RESOLVED_DATE),
      recordedDate: recorded,
    });
    resources.push(cond);

    byProblemId.set(r.PROBLEM_LIST_ID, {
      conditionId,
      onset,
      recorded,
      display: r.DX_NAME ?? undefined,
      status: r.PROBLEM_STATUS_C_NAME ?? undefined,
    });
  }

  return { resources, byProblemId };
}

interface EncDxRow {
  PAT_ENC_CSN_ID: string;
  LINE: string;
  DX_ID: string | null;
  DX_NAME: string | null;
  PRIMARY_DX_YN: string | null;
  DX_CHRONIC_YN: string | null;
  DX_LINK_PROB_ID: string | null;
  CONTACT_DATE: string | null;
  PAT_ENC_DATE_REAL: string | null;
  ORDER_INST: string | null; // earliest ORDER_PROC.ORDER_INST on this encounter
  NOTE_INST: string | null;  // earliest HNO_INFO.CREATE_INSTANT_DTTM on this encounter
  ENC_EXISTS: number; // 1 if the CSN is an exported encounter
}

function buildEncounterDx(
  byProblemId: Map<string, { conditionId: string; onset?: string; recorded?: string; display?: string; status?: string }>,
  exportedCsns: Set<string> | undefined
): any[] {
  const rows = qIf<EncDxRow>("PAT_ENC_DX", `
    SELECT d.PAT_ENC_CSN_ID,
           d.LINE,
           d.DX_ID,
           e.DX_NAME                       AS DX_NAME,
           d.PRIMARY_DX_YN,
           d.DX_CHRONIC_YN,
           d.DX_LINK_PROB_ID,
           d.CONTACT_DATE,
           d.PAT_ENC_DATE_REAL,
           -- Earliest clinical-activity instant on this encounter. The contact date is
           -- midnight-only (the calendar day); the diagnosis's recorded timestamp can fall
           -- on a *later* day when the visit's documentation/orders were placed after the
           -- contact day (e.g. CSN 829467718 contact 7/16 but note authored 7/21; CSN
           -- 1101967391 contact 11/24 but order placed 11/27). Order-placement instant takes
           -- precedence over note-creation instant where both exist. (See gaps.)
           (SELECT MIN(o.ORDER_INST) FROM ORDER_PROC o
             WHERE o.PAT_ENC_CSN_ID = d.PAT_ENC_CSN_ID)            AS ORDER_INST,
           (SELECT MIN(h.CREATE_INSTANT_DTTM) FROM HNO_INFO h
             WHERE h.PAT_ENC_CSN_ID = d.PAT_ENC_CSN_ID)            AS NOTE_INST,
           (SELECT 1 FROM PAT_ENC pe WHERE pe.PAT_ENC_CSN_ID = d.PAT_ENC_CSN_ID) AS ENC_EXISTS
      FROM PAT_ENC_DX d
      LEFT JOIN CLARITY_EDG e ON d.DX_ID = e.DX_ID
     -- Emit newest-encounter-first, grouped by encounter (PAT_ENC_DATE_REAL DESC), then by
     -- LINE within the encounter. This reproduces the target's encounter-grouped ordering
     -- exactly (verified row-for-row against fhir-target/Condition.json). It matters because
     -- the encounter-diagnosis natural key (code.text + onset/recordedDate) is non-injective:
     -- e.g. "Preventative health care" recorded 2025-12-04 appears on BOTH CSN 1169847546
     -- (the .02 fractional contact) and CSN 1098684634, and "Post concussion syndrome" onset
     -- 2020-09-01 appears on ~11 contacts. Positional alignment then decides which of our
     -- Conditions pairs with which target leaf; matching the target's encounter order makes
     -- every shared-key leaf land on its true CSN instead of a neighbouring one.
     ORDER BY CAST(d.PAT_ENC_DATE_REAL AS REAL) DESC, CAST(d.LINE AS INTEGER) ASC
  `);

  const resources: any[] = [];

  for (const r of rows) {
    const linked = r.DX_LINK_PROB_ID ? byProblemId.get(r.DX_LINK_PROB_ID) : undefined;

    // recordedDate:
    //   - linked rows inherit the linked problem's recorded date (the diagnosis was first
    //     recorded when the problem was added).
    //   - unlinked rows: the date the dx was recorded at the visit. CONTACT_DATE is the
    //     calendar day of the visit (midnight), but the actual recording happened no earlier
    //     than the visit's first order placement / note authorship. We therefore take the
    //     later of CONTACT_DATE and the earliest clinical-activity instant on the encounter
    //     (order-placement instant preferred over note-creation instant). For the common case
    //     where everything happened on the contact day this is a no-op; it recovers the two
    //     visits where documentation slipped to a later day (CSN 829467718 -> 7/21,
    //     CSN 1101967391 -> 11/27). Verified to match the target on all 28 unlinked enc-dx.
    const contactISO = isoDate(r.CONTACT_DATE);
    const activityISO = isoDate(r.ORDER_INST) ?? isoDate(r.NOTE_INST);
    const unlinkedRecorded =
      activityISO && (!contactISO || activityISO > contactISO) ? activityISO : contactISO;
    const recorded = linked?.recorded ?? unlinkedRecorded;

    // Encounter reference only when the encounter was actually exported as a resource
    // (gate on the Encounter domain's output; fall back to PAT_ENC existence standalone).
    const encExported = exportedCsns
      ? exportedCsns.has(String(r.PAT_ENC_CSN_ID))
      : !!r.ENC_EXISTS;
    const encounter = encExported
      ? {
          reference: ref("Encounter", id.encounter(r.PAT_ENC_CSN_ID)).reference,
          identifier: {
            use: "usual",
            system: CSN_OID,
            value: String(r.PAT_ENC_CSN_ID),
          },
          // encounter.display (visit type, e.g. "Office Visit") is NOT reachable from
          // PAT_ENC in this export — see gaps. Omitted rather than fabricated.
        }
      : undefined;

    const evidence = linked
      ? [
          {
            detail: [ref("Condition", linked.conditionId, linked.display)],
          },
        ]
      : undefined;

    const cond = clean({
      resourceType: "Condition",
      id: id.condition(`${r.PAT_ENC_CSN_ID}-${r.LINE}`),
      // Linked-to-a-problem encounter dx carry the linked problem's lifecycle status.
      clinicalStatus: linked ? clinicalStatus(linked.status) : undefined,
      verificationStatus: linked ? VERIFICATION_CONFIRMED : undefined,
      category: CATEGORY_ENCOUNTER_DX,
      code: codeFromDxName(r.DX_NAME),
      subject: patientRef(),
      encounter,
      onsetDateTime: linked?.onset,
      recordedDate: recorded,
      evidence,
    });
    resources.push(cond);
  }

  return resources;
}

function main() {
  const { resources: problems, byProblemId } = buildProblems();
  const encDx = buildEncounterDx(byProblemId, exportedEncounterCsns());
  emit("Condition", [...problems, ...encDx]);
}

main();
