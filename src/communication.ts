/**
 * communication.ts — FHIR R4 Communication from the Epic EHI export.
 *
 * Domain "secure-communications". Owns: Communication.
 *
 * One Communication per MYC_MESG row (116) — each row is one completed send/direction
 * of a MyChart secure message: a body, parties, a subject line, a send instant, and
 * reply threading. These are historical EVENTS, so status = completed (Communication,
 * not CommunicationRequest). See design/communication.md and
 * ../skills/reading-epic-ehi-export/reference/clinical-areas/patient-provider-messaging.md
 *
 * FIELD SOURCES
 *   id                id.communication(MESSAGE_ID)
 *   identifier        MYC_MESG.MESSAGE_ID under the Epic MyChart-message master OID
 *                     (same .2.7.2.<INI> convention every other domain uses for Epic ids).
 *   status            constant "completed" — all 116 are completed sends; RECORD_STATUS_C_NAME
 *                     (the soft-delete/revoke sentinel) is NULL on all 116 → none entered-in-error.
 *   category          {text:"notification"} ONLY for unambiguous system sends ("MYCHART, GENERIC");
 *                     CommunicationCategory binding is example and Epic exports no native category code.
 *   medium            ParticipationMode ELECTRONIC — structural truth (all MyChart messages are
 *                     electronic); example binding. Not a per-row column.
 *   subject           patientRef() — every row carries this patient's PAT_ID; display derived.
 *   topic             {text: SUBJECT} — subject lines have no coded value.
 *   sent              MYC_MESG.CREATED_TIME ("M/D/YYYY h:mm:ss AM", America/Chicago → ISO instant).
 *   sender/recipient  direction-dependent (party model below).
 *   inResponseTo      PARENT_MESSAGE_ID → id.communication (all 44 parents are MYC_MESG rows).
 *   encounter         PAT_ENC_CSN_ID → id.encounter, GATED to CSNs the Encounter generator emits
 *                     (16 of 42 message CSNs) so the reference never dangles.
 *   about             MYC_MESG_ORD_ITEMS.REN_REQ_ORDER_ID → id.medicationRequest (3 renewal
 *                     requests; all 3 resolve in ORDER_MED and are emitted as MedicationRequest).
 *   payload.contentString  reassembled body (RTF-stripped for the 90 newer; plain for the 26 older).
 *
 * PARTY MODEL (patient-provider-messaging.md §"Party"):
 *   - From Patient (62): sender = the patient; recipient = the addressed care-team user
 *     TO_USER_ID_NAME (42 named; 20 unaddressed → recipient omitted).
 *   - To Patient (54): sender = the answering user FROM_USER_ID_NAME (54/54 named);
 *     recipient = the patient.
 *   The care-team party id is an EMP/MyChart-user id (a DIFFERENT id space from our
 *   Practitioner minter, which keys on CLARITY_SER.PROV_ID). We mint a Practitioner
 *   reference for a care-team party ONLY when its _NAME exactly+uniquely matches a single
 *   CLARITY_SER.PROV_ID AND the Practitioner generator actually emits that PROV_ID;
 *   otherwise the party is display-only ({display}, no reference) so nothing dangles.
 *
 * GAPS (see gaps/communication.md): received, priority, statusReason, reasonCode/Reference,
 * basedOn/partOf/instantiates*; topic/category/medium codings (text/constant only — no native
 * Epic codes exported); encounter for the ~26 message CSNs the Encounter generator omits;
 * questionnaire-submission answer content (MYC_MESG_QUESR_ANS → HQA, not in this export).
 *
 * Everything in the EHI is TEXT (general-patterns §17); CAST before ORDER BY.
 */
import { q, q1 } from "../lib/db";
import { emit, clean } from "../lib/gen";
import { id, ref, patientRef } from "../lib/ids";

// Epic instance master-file OID (instance prefix 1.2.840.114350.1.13.283; the
// .2.7.2.<INI> convention every other domain generator uses for Epic master-file ids).
// MYC = MyChart message master file (INI 7041).
const OID_MYC_MESG = "urn:oid:1.2.840.114350.1.13.283.2.7.2.7041";

const SYS_PARTICIPATION_MODE = "http://terminology.hl7.org/CodeSystem/v3-ParticipationMode";

// The system pseudo-sender for templated/notification MyChart messages.
const SYSTEM_SENDER = "MYCHART, GENERIC";

function nn(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

/** Parse "M/D/YYYY h:mm:ss AM" as America/Chicago wall time → ISO instant (UTC, Z). */
function chicagoToISO(v: unknown): string | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const m = String(v).trim().match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i
  );
  if (!m) return undefined;
  let [, mo, d, y, hh, mm, ss, ap] = m;
  if (hh === undefined) return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`; // date-only
  let H = parseInt(hh);
  if (ap) {
    if (/PM/i.test(ap) && H < 12) H += 12;
    if (/AM/i.test(ap) && H === 12) H = 0;
  }
  const Y = +y, MO = +mo, D = +d, MI = +(mm ?? 0), S = +(ss ?? 0);
  const offset = chicagoOffsetHours(Y, MO, D, H);
  const utcMs = Date.UTC(Y, MO - 1, D, H - offset, MI, S);
  return new Date(utcMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** US Central DST: 2nd Sun Mar 02:00 → 1st Sun Nov 02:00 = CDT(-5), else CST(-6). */
function chicagoOffsetHours(Y: number, MO: number, D: number, H: number): number {
  const nthSunday = (year: number, month: number, n: number) => {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + (n - 1) * 7;
  };
  const marSun = nthSunday(Y, 3, 2);
  const novSun = nthSunday(Y, 11, 1);
  const afterStart = MO > 3 || (MO === 3 && (D > marSun || (D === marSun && H >= 2)));
  const beforeEnd = MO < 11 || (MO === 11 && (D < novSun || (D === novSun && H < 2)));
  return afterStart && beforeEnd ? -5 : -6;
}

// ---------------------------------------------------------------------------
// RTF → text. The body stores chunk one RTF document across (MESSAGE_ID, LINE)
// rows; reassemble in LINE order. Patient-composer bodies split chunks at \par
// boundaries; letter-template bodies split at arbitrary widths (mid-token). Both
// reassemble correctly by concatenating chunks with NO separator (the chunk
// boundary is not itself a character in the original RTF).
// ---------------------------------------------------------------------------

/**
 * Remove RTF groups whose first control word is one of `names`, honoring nested
 * braces and an optional \* "ignorable destination" prefix. Drops header metadata
 * groups (fonttbl/colortbl/stylesheet) and — critically — {\*\revtbl{Unknown;}},
 * the letter-template revision table whose placeholder author "Unknown;" otherwise
 * leaks into extracted prose (messaging guide, "Unstructured tie-back").
 */
function dropNamedGroups(s: string, names: Set<string>): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "{") {
      let k = i + 1;
      if (s[k] === "\\" && s[k + 1] === "*") k += 2;
      if (s[k] === "\\") {
        let m = k + 1;
        while (m < s.length && /[a-zA-Z]/.test(s[m])) m++;
        if (names.has(s.slice(k + 1, m))) {
          let depth = 0, j = i;
          for (; j < s.length; j++) {
            if (s[j] === "{") depth++;
            else if (s[j] === "}") { depth--; if (depth === 0) { j++; break; } }
          }
          i = j;
          continue;
        }
      }
    }
    out += s[i];
    i++;
  }
  return out;
}

const RTF_DROP_GROUPS = new Set([
  "fonttbl", "colortbl", "stylesheet", "revtbl", "info", "generator", "pict",
  "themedata", "colorschememapping", "latentstyles", "datastore",
  "listtable", "listoverridetable",
]);

function stripRtf(s: string): string {
  s = dropNamedGroups(s, RTF_DROP_GROUPS);
  // Paragraph/line/tab control words → whitespace.
  s = s.replace(/\\par[d]?\b/g, "\n").replace(/\\line\b/g, "\n").replace(/\\tab\b/g, "\t");
  // \uN unicode escape (optional fallback char) and \'hh hex escape.
  s = s.replace(/\\u(-?\d+)\s?\??/g, (_m, n) => String.fromCharCode(((+n) + 65536) % 65536));
  s = s.replace(/\\'([0-9a-fA-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
  // Remaining control words (\word + optional numeric arg + optional space) and control symbols.
  s = s.replace(/\\[a-zA-Z]+-?\d*\s?/g, "");
  s = s.replace(/\\[^a-zA-Z]/g, "");
  s = s.replace(/[{}]/g, "");
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ");
  return s.trim();
}

/** Reassemble a message body from whichever store holds it (RTF newer, plain older). */
function messageBody(messageId: string): string | undefined {
  const rtf = q1<{ b: string | null }>(
    `SELECT group_concat(RTF_TXT, '') AS b
       FROM (SELECT RTF_TXT FROM MYC_MESG_RTF_TEXT WHERE MESSAGE_ID = ? ORDER BY CAST(LINE AS INTEGER))`,
    messageId
  )?.b;
  if (nn(rtf)) {
    const text = stripRtf(rtf!);
    return nn(text);
  }
  // Plain store: line-based; preserve blank lines (NULL chunks are real empty paragraphs).
  const plain = q1<{ b: string | null }>(
    `SELECT group_concat(COALESCE(MSG_TXT, ''), char(10)) AS b
       FROM (SELECT MSG_TXT FROM MSG_TXT WHERE MESSAGE_ID = ? ORDER BY CAST(LINE AS INTEGER))`,
    messageId
  )?.b;
  return nn(plain);
}

// ---------------------------------------------------------------------------
// Party resolution: care-team _NAME → a single emitted Practitioner (PROV_ID),
// else display-only. Built once.
// ---------------------------------------------------------------------------

/** PROV_NAMEs that resolve to exactly one CLARITY_SER.PROV_ID → that PROV_ID. */
function buildNameToProvId(): Map<string, string> {
  const rows = q<{ PROV_NAME: string; n: number; pid: string }>(
    `SELECT PROV_NAME, COUNT(DISTINCT PROV_ID) AS n, MIN(PROV_ID) AS pid
       FROM CLARITY_SER
      WHERE NULLIF(PROV_NAME, '') IS NOT NULL
      GROUP BY PROV_NAME`
  );
  const map = new Map<string, string>();
  for (const r of rows) if (Number(r.n) === 1 && nn(r.pid)) map.set(r.PROV_NAME, String(r.pid));
  return map;
}

const NAME_TO_PROV = buildNameToProvId();

/**
 * A party reference for a care-team user, identified only by display name.
 * Practitioner reference when the name maps to a single CLARITY_SER PROV_ID AND
 * that Practitioner is actually emitted; otherwise display-only (no reference).
 */
function carePartyRef(name: string | undefined, emittedPrac: Set<string>): any | undefined {
  const nm = nn(name);
  if (!nm) return undefined;
  const provId = NAME_TO_PROV.get(nm);
  if (provId && emittedPrac.has(id.practitioner(provId))) {
    return ref("Practitioner", id.practitioner(provId), nm);
  }
  return { display: nm }; // unresolvable user (system sender / EMP-only staff)
}

/** The set of Practitioner ids the Practitioner generator emits (its CARE-context rule). */
function emittedPractitionerIds(): Set<string> {
  // Mirror practitioner.ts: every distinct PROV_ID referenced in a care context that
  // resolves in CLARITY_SER and is not a routing/lab sentinel. We compute the same set
  // here from the same source columns so a sender/recipient reference never dangles.
  const SENTINELS = new Set(["199995", "3724611", "E1011"]);
  const CARE_PROV_COLUMNS: [string, string][] = [
    ["PAT_ENC", "VISIT_PROV_ID"], ["PAT_ENC", "PCP_PROV_ID"], ["PAT_ENC_2", "SUP_PROV_ID"],
    ["PAT_PCP", "PCP_PROV_ID"], ["PATIENT", "CUR_PCP_PROV_ID"], ["TREATMENT_TEAM", "TR_TEAM_ID"],
    ["ORDER_MED", "ORD_PROV_ID"], ["ORDER_MED", "AUTHRZING_PROV_ID"], ["ORDER_MED", "MED_PRESC_PROV_ID"],
    ["ORDER_MED", "MED_REFILL_PROV_ID"], ["ORDER_PROC", "AUTHRZING_PROV_ID"], ["ORDER_PROC", "BILLING_PROV_ID"],
    ["ORDER_PROC", "REFERRING_PROV_ID"], ["ORDER_PROC_2", "PROV_ID"], ["ORDER_PROC_2", "REFD_TO_PROV_ID"],
    ["ORDER_PROC_3", "PROVIDING_PROV_ID"], ["ORDER_SIGNED_MED", "AUTH_PROV_ID"], ["ORDER_SIGNED_MED", "ORDER_PROV_ID"],
    ["ORDER_SIGNED_PROC", "AUTH_PROV_ID"], ["ORDER_SIGNED_PROC", "ORDER_PROV_ID"], ["REFERRAL", "REFERRING_PROV_ID"],
    ["REFERRAL", "PCP_PROV_ID"], ["NOTE_ENC_INFO", "AUTH_LNKED_PROV_ID"], ["MYC_MESG", "PROV_ID"],
    ["HSP_ATND_PROV", "PROV_ID"], ["HSP_ACCT_OTHR_PROV", "OTHER_PROV_ID"], ["DOC_INFORMATION", "PERFORMING_PROV_ID"],
    ["ORDER_RAD_READING", "PROV_ID"],
  ];
  const referenced = new Set<string>();
  for (const [tbl, col] of CARE_PROV_COLUMNS) {
    try {
      for (const r of q<{ v: string }>(
        `SELECT DISTINCT "${col}" AS v FROM "${tbl}" WHERE "${col}" IS NOT NULL AND "${col}" <> ''`
      )) {
        if (r.v != null) referenced.add(String(r.v).trim());
      }
    } catch {
      // table/column absent in this export
    }
  }
  const out = new Set<string>();
  for (const pid of referenced) {
    if (SENTINELS.has(pid)) continue;
    const ser = q1<{ PROV_ID: string }>(`SELECT PROV_ID FROM CLARITY_SER WHERE PROV_ID = ?`, pid);
    if (ser) out.add(id.practitioner(pid));
  }
  return out;
}

const EMITTED_PRAC = emittedPractitionerIds();

/** CSNs the Encounter generator emits — mirror its selection so encounter refs resolve. */
function emittedEncounterCsns(): Set<string> {
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
  `);
  return new Set(rows.map((r) => String(r.csn)));
}

const EMITTED_CSNS = emittedEncounterCsns();

// ---------------------------------------------------------------------------

function buildCommunications(): any[] {
  const out: any[] = [];

  const msgs = q<any>(
    `SELECT MESSAGE_ID, CREATED_TIME, PARENT_MESSAGE_ID, PAT_ENC_CSN_ID,
            FROM_USER_ID_NAME, TO_USER_ID_NAME, TOFROM_PAT_C_NAME, SUBJECT, PAT_ID
       FROM MYC_MESG
      ORDER BY CAST(MESSAGE_ID AS INTEGER)`
  );

  // Pre-resolve the existing-message id set so inResponseTo never dangles.
  const allMsgIds = new Set(msgs.map((m) => String(m.MESSAGE_ID)));

  for (const m of msgs) {
    const messageId = nn(m.MESSAGE_ID);
    if (!messageId) continue;

    const direction = nn(m.TOFROM_PAT_C_NAME); // "From Patient" | "To Patient"
    const fromUser = nn(m.FROM_USER_ID_NAME);
    const toUser = nn(m.TO_USER_ID_NAME);

    // Party model.
    let sender: any | undefined;
    let recipient: any[] = [];
    if (direction === "To Patient") {
      sender = carePartyRef(fromUser, EMITTED_PRAC);
      recipient = [patientRef()];
    } else {
      // From Patient (default for any non-"To Patient" row).
      sender = patientRef();
      const r = carePartyRef(toUser, EMITTED_PRAC);
      if (r) recipient = [r];
    }

    // category: only for unambiguous system sends.
    const isSystem = direction === "To Patient" && fromUser === SYSTEM_SENDER;
    const category = isSystem ? [{ text: "notification" }] : undefined;

    // inResponseTo (parent message, gated to existing rows).
    const parent = nn(m.PARENT_MESSAGE_ID);
    const inResponseTo =
      parent && allMsgIds.has(parent)
        ? [ref("Communication", id.communication(parent))]
        : undefined;

    // encounter (gated to emitted CSNs).
    const csn = nn(m.PAT_ENC_CSN_ID);
    const encounter =
      csn && EMITTED_CSNS.has(csn) ? ref("Encounter", id.encounter(csn)) : undefined;

    // about: renewal-request order(s) → MedicationRequest.
    const orderRows = q<{ REN_REQ_ORDER_ID: string }>(
      `SELECT REN_REQ_ORDER_ID FROM MYC_MESG_ORD_ITEMS
        WHERE MESSAGE_ID = ? AND NULLIF(REN_REQ_ORDER_ID,'') IS NOT NULL
        ORDER BY CAST(LINE AS INTEGER)`,
      messageId
    );
    const about = orderRows
      .map((o) => String(o.REN_REQ_ORDER_ID))
      .filter((oid) => q1(`SELECT 1 FROM ORDER_MED WHERE ORDER_MED_ID = ?`, oid))
      .map((oid) => ref("MedicationRequest", id.medicationRequest(oid)));

    // payload (body).
    const body = messageBody(messageId);
    const payload = body ? [{ contentString: body }] : undefined;

    out.push(
      clean({
        resourceType: "Communication",
        id: id.communication(messageId),
        identifier: [{ system: OID_MYC_MESG, value: messageId }],
        status: "completed",
        category,
        medium: [
          {
            coding: [
              { system: SYS_PARTICIPATION_MODE, code: "ELECTRONIC", display: "electronic data" },
            ],
          },
        ],
        subject: patientRef(),
        topic: nn(m.SUBJECT) ? { text: nn(m.SUBJECT) } : undefined,
        sent: chicagoToISO(m.CREATED_TIME),
        sender,
        recipient: recipient.length ? recipient : undefined,
        inResponseTo,
        about: about.length ? about : undefined,
        encounter,
        payload,
      })
    );
  }

  return out;
}

emit("Communication", buildCommunications());
