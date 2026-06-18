/**
 * careplan.ts — FHIR CarePlan + CareTeam + Goal for the "careplan" domain.
 *
 * Sources & what the EHI can / cannot fill (see gaps/careplan.md for the full ledger):
 *
 *  GOAL  (target 1, generated 1) — FULLY reconstructable.
 *    From the IGO goal record (GOAL / PT_GOALS_INFO / PT_GOALS_UPDATES + PATIENT_GOALS).
 *      - lifecycleStatus  ← GOAL_STATUS_C_NAME (Active → active)
 *      - category.text    ← AMB_GOAL_TYPE_C_NAME ("Blood Pressure"); the numeric _C code
 *                            (target "4" in oid …737184.20005) is Epic-assigned and NOT in
 *                            this export (no bare _C, no ZC_ tables) → coding gap.
 *      - description.text ← PT_GOALS_UPDATES.DISPLAY_NAME_OT ("Blood Pressure < 140/90").
 *                            The target renders "<" as "below"; we keep the source text.
 *      - startDate        ← CREATE_INST_DTTM (date part) = goal creation.
 *      - expressedBy      ← creating/editing user RAMMELZL → SER provider 144590 (Practitioner),
 *                            resolved EMP-login → SER by exact unambiguous name match.
 *
 *  CAREPLAN  (target 4, generated 1) — only the LONGITUDINAL plan is reconstructable.
 *    The target's one "Plan for Patient Care" (intent=plan, category Longitudinal) is an
 *    Epic-synthesized roll-up of the active problem list + goals + upcoming appointments —
 *    all of which ARE in the export:
 *      - status active, intent plan
 *      - category[0] assess-plan (US-Core careplan-category; Epic-fixed label, emit as given)
 *      - category[1] "Longitudinal" — SNOMED 38717003 is Epic-assigned; we emit text only.
 *      - addresses    ← active PROBLEM_LIST rows (→ Condition, id.condition(PROBLEM_LIST_ID)),
 *                        ordered by PAT_PROBLEM_LIST.LINE (matches target order).
 *      - goal         ← the IGO goal above.
 *      - activity.detail (kind Appointment, status scheduled, scheduledPeriod) ← the future
 *                        Scheduled PAT_ENC. The wall-clock start ships in
 *                        PAT_ENC_APPT.PROV_START_TIME (emitted as a local dateTime); only the
 *                        UTC offset and the appt end/duration are unrecoverable (no length
 *                        column ships) → data gap.
 *    The other 3 target CarePlans are "Patient Instructions" (intent=proposal, Encounter
 *    Level) whose DEFINING content — the free-text encounter Patient-Instructions in
 *    note[].text — is ABSENT (DISCRETE_PAT_INSTRUCTIONS documented but not shipped; a value
 *    scan for the distinctive phrases returns zero; ORDER_MED_SIG.SIG_TEXT is a differently-
 *    worded Rx-sig proxy, a different datum). Their encounter.* IS recoverable in isolation —
 *    the 3 CSNs (948004323 / 974614965 / 958148810) all exist in PAT_ENC — but that linkage
 *    is MOOT: with no note text we cannot know to mint a patient-instruction CarePlan for
 *    those visits, so the encounter ref has no parent to attach to. Not generated → see
 *    gaps/careplan.md for the exact absence searches.
 *
 *  CARETEAM  (target 1, generated 0) — NOT reconstructable.
 *    The longitudinal care-team roster lives in EPT_CARE_TEAMS (the "Provider Care Team"
 *    master), which is documented but NOT shipped (sqlite_master LIKE '%CARE_TEAM%' empty).
 *    No other table enumerates the 3-member roster (Everton 133057 / Rammelkamp 144590 /
 *    Kommer 554368) as one team: PAT_PCP lists only the current+termed PCPs (Rammelkamp +
 *    Dhillon, who is NOT in the target), TREATMENT_TEAM is per-encounter (CSN-keyed). The role
 *    codes (specialty 17, PCP-type 1, SNOMED "Not indicated") are Epic-assigned and absent
 *    (only PAT_PCP *_C_NAME labels survive, moot without a roster). Fabricating a roster would
 *    invent membership → recorded as a gap with its proof in gaps/careplan.md.
 *
 * EVERYTHING in the EHI is TEXT — CAST before ORDER/MIN/range. (§17)
 */
import { q, q1, parseEpicDateTime } from "../lib/db";
import { isoDate } from "../lib/time";
import { id, ref, patientRef, PATIENT_ID } from "../lib/ids";
import { emit, clean } from "../lib/gen";
import { cc, concept, category } from "../lib/cc";
import { enumMap } from "../lib/fmt";
import { empLoginToSerId } from "../lib/providers";

// US-Core CarePlan category (Epic emits this fixed assess-plan label on every plan).
const US_CORE_CAREPLAN_CATEGORY = "http://hl7.org/fhir/us/core/CodeSystem/careplan-category";

const STATUS_MAP: Record<string, string> = {
  Active: "active",
  Completed: "completed",
  Resolved: "completed",
  Cancelled: "cancelled",
  Canceled: "cancelled",
};

/** Practitioner display in the target's "Dr. F Last" style (best-effort from EXTERNAL_NAME). */
function practitionerDisplay(serId: string): string | undefined {
  const ser = q1<{ PROV_NAME: string | null; EXTERNAL_NAME: string | null }>(
    `SELECT PROV_NAME, EXTERNAL_NAME FROM CLARITY_SER WHERE PROV_ID = ?`,
    serId
  );
  const ext = ser?.EXTERNAL_NAME?.trim().replace(/\s+/g, " ");
  return ext || ser?.PROV_NAME?.trim() || undefined;
}

function practitionerRef(serId: string) {
  const r: any = ref("Practitioner", id.practitioner(serId), practitionerDisplay(serId));
  r.type = "Practitioner";
  return r;
}

// ---------------------------------------------------------------------------
// GOAL
// ---------------------------------------------------------------------------
interface GoalRow {
  GOAL_ID: string;
  GOAL_STATUS_C_NAME: string | null;
  AMB_GOAL_TYPE_C_NAME: string | null;
  CREATE_INST_DTTM: string | null;
  EDIT_USER_ID: string | null;
  DISPLAY_NAME_OT: string | null;
}

function buildGoals(): { resources: any[]; goalRefById: Map<string, any> } {
  const rows = q<GoalRow>(`
    SELECT g.GOAL_ID,
           i.GOAL_STATUS_C_NAME,
           i.AMB_GOAL_TYPE_C_NAME,
           i.CREATE_INST_DTTM,
           (SELECT u.EDIT_USER_ID FROM PT_GOALS_UPDATES u
             WHERE u.GOAL_ID = g.GOAL_ID
             ORDER BY CAST(u.CONTACT_DATE_REAL AS REAL) LIMIT 1)   AS EDIT_USER_ID,
           (SELECT u.DISPLAY_NAME_OT FROM PT_GOALS_UPDATES u
             WHERE u.GOAL_ID = g.GOAL_ID
             ORDER BY CAST(u.CONTACT_DATE_REAL AS REAL) DESC LIMIT 1) AS DISPLAY_NAME_OT
      FROM PATIENT_GOALS pg
      JOIN GOAL g            ON g.GOAL_ID = pg.GOAL_ID
      LEFT JOIN PT_GOALS_INFO i ON i.GOAL_ID = g.GOAL_ID
      WHERE COALESCE(g.DELETED_YN,'N') <> 'Y'
     ORDER BY CAST(pg.LINE AS INTEGER)
  `);

  const resources: any[] = [];
  const goalRefById = new Map<string, any>();

  for (const r of rows) {
    const goalId = id.goal(r.GOAL_ID);

    // category: Epic AMB_GOAL_TYPE — only the _C_NAME label survives (text-only, code is a gap).
    const category = r.AMB_GOAL_TYPE_C_NAME
      ? [{ text: r.AMB_GOAL_TYPE_C_NAME }]
      : undefined;

    const description = concept(r.DISPLAY_NAME_OT);

    const serId = empLoginToSerId(r.EDIT_USER_ID);
    const expressedBy = serId ? practitionerRef(serId) : undefined;

    const goal = clean({
      resourceType: "Goal",
      id: goalId,
      lifecycleStatus: enumMap(r.GOAL_STATUS_C_NAME, STATUS_MAP),
      category,
      description,
      subject: patientRef(),
      startDate: isoDate(r.CREATE_INST_DTTM),
      expressedBy,
    });
    resources.push(goal);

    goalRefById.set(
      r.GOAL_ID,
      ref("Goal", goalId, r.DISPLAY_NAME_OT ?? undefined)
    );
  }

  return { resources, goalRefById };
}

// ---------------------------------------------------------------------------
// CAREPLAN — the longitudinal "Plan for Patient Care" roll-up
// ---------------------------------------------------------------------------
interface ProblemRow {
  PROBLEM_LIST_ID: string;
  DX_NAME: string | null;
  LINE: string | null;
}

function activeProblemAddresses(): any[] {
  const rows = q<ProblemRow>(`
    SELECT p.PROBLEM_LIST_ID,
           e.DX_NAME,
           pp.LINE
      FROM PROBLEM_LIST p
      LEFT JOIN CLARITY_EDG e       ON e.DX_ID = p.DX_ID
      LEFT JOIN PAT_PROBLEM_LIST pp ON pp.PROBLEM_LIST_ID = p.PROBLEM_LIST_ID
     WHERE p.PROBLEM_STATUS_C_NAME = 'Active'
     ORDER BY CAST(pp.LINE AS INTEGER)
  `);
  return rows.map((r) =>
    ref("Condition", id.condition(r.PROBLEM_LIST_ID), r.DX_NAME ?? undefined)
  );
}

interface ApptRow {
  PAT_ENC_CSN_ID: string;
  CONTACT_DATE: string | null;
  EFFECTIVE_DATE_DTTM: string | null;
  APPT_STATUS_C_NAME: string | null;
  PROV_START_TIME: string | null;
}

function upcomingAppointmentActivities(): any[] {
  // Future Scheduled appointments (§43 data-dated-after-export). The appointment clock-time
  // IS in the export: PAT_ENC_APPT.PROV_START_TIME ("the date and time the appointment is
  // scheduled to begin with this provider") carries the wall-clock start (e.g. 2:30 PM),
  // whereas PAT_ENC.EFFECTIVE_DATE_DTTM/CONTACT_DATE are only the midnight calendar date.
  // We emit the local dateTime start from PROV_START_TIME, falling back to the date when it
  // is absent. The UTC offset (to reach the target's Z value) and the appointment end /
  // duration are NOT in the export (no length column ships) — see gaps/careplan.md.
  const rows = q<ApptRow>(`
    SELECT e.PAT_ENC_CSN_ID, e.CONTACT_DATE, e.EFFECTIVE_DATE_DTTM, e.APPT_STATUS_C_NAME,
           pa.PROV_START_TIME
      FROM PAT_ENC e
      LEFT JOIN PAT_ENC_APPT pa ON pa.PAT_ENC_CSN_ID = e.PAT_ENC_CSN_ID
     WHERE e.APPT_STATUS_C_NAME = 'Scheduled'
     ORDER BY CAST(e.PAT_ENC_DATE_REAL AS REAL)
  `);
  return rows.map((r) => {
    // Date-only start. PROV_START_TIME carries a local wall-clock time but the EHI gives
    // no timezone, and FHIR dateTime requires an offset when a time is present — rather
    // than assert a possibly-wrong Central offset we emit the date (gaps/careplan.md notes
    // the lost appointment wall-clock time).
    const start = (
      parseEpicDateTime(r.PROV_START_TIME) ??
      isoDate(r.EFFECTIVE_DATE_DTTM ?? r.CONTACT_DATE)
    )?.slice(0, 10);
    return {
      detail: clean({
        kind: "Appointment",
        status: "scheduled",
        doNotPerform: false,
        scheduledPeriod: start ? { start } : undefined,
      }),
    };
  });
}

function buildLongitudinalCarePlan(goalRefs: any[]): any[] {
  const addresses = activeProblemAddresses();
  const goal = goalRefs.length ? goalRefs : undefined;
  const activity = upcomingAppointmentActivities();

  const cp = clean({
    resourceType: "CarePlan",
    id: id.carePlan("longitudinal"),
    status: "active",
    intent: "plan",
    category: category(
      cc(US_CORE_CAREPLAN_CATEGORY, "assess-plan", "Assessment and Plan of Treatment"),
      // "Longitudinal": target codes SNOMED 38717003, which is Epic-assigned and not in the
      // export — emit text only (coding gap).
      { text: "Longitudinal" }
    ),
    subject: patientRef(),
    addresses,
    goal,
    activity: activity.length ? activity : undefined,
  });

  return [cp];
}

// ---------------------------------------------------------------------------
function main() {
  const { resources: goals, goalRefById } = buildGoals();
  emit("Goal", goals);

  const carePlans = buildLongitudinalCarePlan([...goalRefById.values()]);
  emit("CarePlan", carePlans);

  // CareTeam: the longitudinal roster master (EPT_CARE_TEAMS) is not shipped in this export,
  // and no other table enumerates the team's membership/roles. PAT_PCP carries real PCP data
  // but is the patient's PCP-designation HISTORY (one current + one termed PCP, the termed one
  // NOT in the documented roster), not a care-team roster — emitting it as a CareTeam would
  // misrepresent both what the data is and who the team is. Per the documented, attributed
  // judgment call in gaps/careplan.md ("DECISION: NO"), CareTeam stays unbuilt rather than
  // fabricating/surrogating a roster.
  emit("CareTeam", []);
}

main();
