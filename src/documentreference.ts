/**
 * documentreference.ts — FHIR DocumentReference from Epic EHI clinical notes (HNO).
 *
 * SCOPE / WHAT WE PRODUCE
 *   The target DocumentReference.json holds three families:
 *     (A) Clinical Notes  (28)  — HNO notes, content text/html + text/rtf.   ← WE PRODUCE THESE.
 *     (B) Diagnostic imaging study (3) — imaging ORDER_PROC reports, html.   ← GAP (see gaps file).
 *     (C) Summary Document (20) — Epic-generated C-CDA (Encounter/Patient Summary), application/xml.
 *                                                                            ← GAP (export-time artifact).
 *
 *   (B) and (C) are NOT reproducible from the EHI without fabrication:
 *     - (C) C-CDA docs are generated on the fly at export time; their identifier
 *       (...688883.<n>), Binary URLs, and generation `date` exist nowhere in the export.
 *     - (B)'s subset selection (which 3 of 9 imaging orders, and the duplicate),
 *       its `798268` identifier, its `date`, and its Epic encounter-type display
 *       are all Epic-publishing/Epic-terminology artifacts absent from the export.
 *   Both are documented as data gaps. We faithfully reproduce family (A).
 *
 * SELECTION OF CLINICAL NOTES (family A)
 *   Epic publishes a DocumentReference for a note only when its note type is
 *   configured "released to the patient/FHIR" — a setting that does NOT ship in the
 *   EHI export. The closest EHI signal is NOTE_ENC_INFO.NOTE_SHARED_W_PAT_HX_YN='Y'
 *   ("shared with patient") plus the always-released "Patient Instructions" type.
 *   We select Signed/Addendum notes that have an exported body (an RTF file) and are
 *   either shared-with-patient or of type "Patient Instructions". This over-produces
 *   relative to the 28 the target snapshot happens to contain (the residual ~11 are
 *   real shared notes the snapshot omits) — see the gaps file; the exact 28-row
 *   subset is not derivable from the export.
 *
 * FIELD MAP (verified against the target)
 *   id                       ← id.documentReference(NOTE_ID)
 *   identifier[0]            ← {SYS_NOTE,  value=NOTE_ID}
 *   identifier[1]            ← {SYS_NOTE_DOC, value="<noteOidTail>_<NOTE_ID>"}
 *   status                   = "current"
 *   docStatus                = "amended" if any Addendum contact else "final"
 *   type.text                ← COALESCE(IP_NOTE_TYPE_C_NAME, NOTE_TYPE_NOADD_C_NAME)
 *                              (Epic note-type codes + LOINC NOT in export → text only; coding GAP)
 *   category                 = fixed us-core "clinical-note"
 *   subject                  = patientRef()  (display derived from PATIENT.PAT_NAME)
 *   date                     ← HNO_INFO.CREATE_INSTANT_DTTM (UTC; minute precision)
 *   author[0]                ← first contact's AUTH_LNKED_PROV_ID → Practitioner
 *   authenticator            ← latest contact's author + NOTE_FILE_TIME_DTTM instant
 *   extension[attester]*     ← one per Signed/Addendum contact: mode text (Signer /
 *                              Addendum/Transcription Authenticator; Epic code GAP),
 *                              time=NOTE_FILE_TIME_DTTM, party=contact author
 *   custodian.display        ← CLARITY_SA.EXTERNAL_NAME ("UnityPoint Health", single export org)
 *   custodian.identifier     = OMITTED — Care-Everywhere id urn:ihs:ce-prd not in export (GAP)
 *   content[]                = text/rtf attachment whose `url` points at a Binary we mint
 *                              from the note's EXACT exported bytes (raw/Rich Text/HNO_<id>_*.RTF),
 *                              content-addressed `Binary/bin-<sha1>` (resolves IN-bundle) +
 *                              size + base64 SHA-1 hash; plus a clearly-DERIVED text/plain
 *                              attachment (rtf2txt). We OMIT inline `data` (it lives in the
 *                              Binary) and OMIT Epic's text/html (its bytes are not in the
 *                              export → would be fabrication) and the unreproducible Epic
 *                              Binary/<opaque> id. See src/binary.ts (opt-in --embed-attachments).
 *   context.extension        ← first contact's AUTHOR_PRVD_TYPE_C_NAME (text; Epic code GAP)
 *   context.encounter        ← HNO_INFO.PAT_ENC_CSN_ID → Encounter ref + CSN identifier
 *                              (encounter `display` = Epic enc-type label, not in export → omitted)
 *   context.period.start     ← SPEC_NOTE_TIME_DTTM (= DATE_OF_SERVIC_DTTM; UTC)
 *
 * All EHI is TEXT; *_DTTM columns are UTC instants (the *_LOCAL_DTTM siblings are
 * Chicago). The export rounds these to the minute, so seconds differ from the
 * target's second-precision values — a precision gap, not a data gap.
 */
import { q, q1 } from "../lib/db";
import { emit, clean } from "../lib/gen";
import { id, ref, patientRef } from "../lib/ids";
import { attachmentsForNote, attachmentsForOrder } from "./binary";
import { existsSync, readdirSync } from "fs";
import { resolve } from "path";

const SYS_NOTE = "urn:oid:1.2.840.114350.1.13.283.2.7.2.727879";       // HNO note id
const NOTE_OID_TAIL = "1.2.840.114350.1.13.283.2.7.2.727879";          // tail used in the doc-id value
const SYS_NOTE_DOC = "urn:oid:1.2.840.114350.1.72.3.15";               // "<tail>_<NOTE_ID>" doc id
const SYS_CSN = "urn:oid:1.2.840.114350.1.13.283.2.7.3.698084.8";      // Encounter CSN (matches encounter.ts)
const SYS_PROV_TYPE = "urn:oid:1.2.840.114350.1.13.283.2.7.4.836982.1040"; // author-provider-type (codes not in export)
const SYS_ATTEST_MODE = "urn:oid:1.2.840.114350.1.72.1.7.7.10.696784.72072"; // attester mode (codes not in export)
const ATTESTER_URL = "http://hl7.org/fhir/5.0/StructureDefinition/extension-DocumentReference.attester";
const PROV_TYPE_URL = "http://open.epic.com/FHIR/StructureDefinition/extension/clinical-note-author-provider-type";
const AUTH_INSTANT_URL = "http://open.epic.com/FHIR/StructureDefinition/extension/clinical-note-authentication-instant";
const FORMAT_SYS = "http://ihe.net/fhir/ValueSet/IHE.FormatCode.codesystem";
const SYS_ORDER_PLACER = "urn:oid:1.2.840.114350.1.13.283.2.7.2.798268"; // imaging ORDER_PROC placer id (matches DR/Obs/ServiceRequest)

/** "12/4/2025 2:17:00 PM" (UTC instant in the export) → "2025-12-04T14:17:00Z". */
function dttmToUTC(v: unknown): string | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!m) return undefined;
  let [, mo, d, y, hh, mm, ss, ap] = m;
  let H = parseInt(hh);
  if (ap) {
    if (/PM/i.test(ap) && H < 12) H += 12;
    if (/AM/i.test(ap) && H === 12) H = 0;
  }
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}T${String(H).padStart(2, "0")}:${mm}:${(ss ?? "00").padStart(2, "0")}Z`;
}

/** Note ids that have an exported Rich-Text body (the body is the join key, §14). */
function noteIdsWithRtf(): Set<string> {
  const dir = resolve(import.meta.dir, "..", "..", "raw", "Rich Text");
  const out = new Set<string>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const m = f.match(/^HNO_(\d+)_/i);
    if (m) out.add(m[1]);
  }
  return out;
}

const ATTEST_MODE: Record<string, { text: string }> = {
  Signed: { text: "Signer" },
  Addendum: { text: "Addendum/Transcription Authenticator" },
};

function practitionerRefFromProv(provId: string | null | undefined, display?: string | null) {
  if (!provId) return undefined;
  const r: any = ref("Practitioner", id.practitioner(provId), display || undefined);
  r.type = "Practitioner";
  return r;
}

/**
 * The custodian DISPLAY ("UnityPoint Health") is the export's customer-facing
 * organization name, carried by CLARITY_SA.EXTERNAL_NAME (the institutional
 * service-area external/display name). There is exactly one non-blank
 * EXTERNAL_NAME in the export ("UnityPoint Health"), so it is the single
 * organization display for every produced note. The paired custodian.identifier
 * (urn:ietf:rfc:3986 / "urn:ihs:ce-prd") is a Care-Everywhere/HIE publishing id
 * absent from the export (see gaps file) → display-only custodian.
 */
function custodianDisplay(): string | undefined {
  const r = q1<{ EXTERNAL_NAME: string }>(
    `SELECT EXTERNAL_NAME FROM CLARITY_SA
      WHERE EXTERNAL_NAME IS NOT NULL AND TRIM(EXTERNAL_NAME) <> ''
      ORDER BY CAST(SERV_AREA_ID AS INTEGER)
      LIMIT 1`
  );
  return r?.EXTERNAL_NAME?.trim() || undefined;
}

/** Note types the target snapshot actually publishes as DocumentReferences. We never
 *  surface a note whose Epic type is NOT one of these (e.g. "Problem Overview"),
 *  because inventing a never-published type family would be fabrication, not recovery. */
const TARGET_NOTE_TYPES = new Set([
  "Progress Notes",
  "Telephone Encounter",
  "Consults",
  "Patient Instructions",
]);

/** noteType text for a NOTE_ID (COALESCE inpatient → no-addendum), or "" if none. */
function noteTypeOf(h: { IP_NOTE_TYPE_C_NAME?: string | null; NOTE_TYPE_NOADD_C_NAME?: string | null }): string {
  return (h.IP_NOTE_TYPE_C_NAME || h.NOTE_TYPE_NOADD_C_NAME || "").trim();
}

/**
 * The set of NOTE_IDs we publish a DocumentReference for. Single source of selection
 * truth (src/binary.ts mints Binaries for EXACTLY these notes → no orphan Binaries).
 *
 * Selection (all clauses require a Signed/Addendum contact AND an exported RTF body):
 *
 *   (1) RELEASED CORE — notes that carry the closest EHI "released-to-patient" signal:
 *       NOTE_ENC_INFO.NOTE_SHARED_W_PAT_HX_YN='Y', plus the always-released
 *       "Patient Instructions" type. (This is the historical selection.)
 *
 *   (2) ENCOUNTER SIBLINGS — additional REAL notes authored in the SAME encounter
 *       (HNO_INFO.PAT_ENC_CSN_ID) as a (1)-released note, restricted to the note
 *       *types the target actually publishes* (TARGET_NOTE_TYPES). Rationale: Epic
 *       releases an encounter's clinical documentation as a set; a same-encounter
 *       clinical note of a published type is part of that same released visit
 *       documentation. The shared-with-patient flag in the EHI is leaky (3 target
 *       notes lack it; 11 flagged notes are absent from the snapshot — see gaps file),
 *       so it under-surfaces real notes Epic would publish. The CSN-sibling signal is
 *       fully EHI-derivable and adds only genuine, body-backed, correctly-typed notes.
 *
 * This UNDER-produces relative to the full ~75-note RTF-backed Signed/Addendum pool
 * (we deliberately do NOT dump every note — that would over-shoot the target shape and
 * sweep in never-published types); and it OVER-produces relative to the exact 28-row
 * clinical-note subset the snapshot happens to contain (the residual extras are real
 * shared/same-encounter notes the snapshot omits). The exact 28-row subset is not
 * derivable from the export (the per-type "released to FHIR" config does not ship).
 */
export function publishedNoteIds(): string[] {
  const rtf = noteIdsWithRtf();

  // (1) Released-core candidates (have a body, Signed/Addendum, shared OR Patient Instructions).
  const core = q<{ NOTE_ID: string; PAT_ENC_CSN_ID: string | null }>(
    `SELECT DISTINCT h.NOTE_ID, h.PAT_ENC_CSN_ID
       FROM HNO_INFO h
       JOIN NOTE_ENC_INFO e ON e.NOTE_ID = h.NOTE_ID
      WHERE e.NOTE_STATUS_C_NAME IN ('Signed','Addendum')
        AND (
              EXISTS (SELECT 1 FROM NOTE_ENC_INFO s
                       WHERE s.NOTE_ID = h.NOTE_ID AND s.NOTE_SHARED_W_PAT_HX_YN = 'Y')
              OR h.IP_NOTE_TYPE_C_NAME = 'Patient Instructions'
              OR h.NOTE_TYPE_NOADD_C_NAME = 'Patient Instructions'
            )`
  ).filter((r) => rtf.has(r.NOTE_ID)); // require an exported body

  const selected = new Set<string>(core.map((r) => r.NOTE_ID));
  const releasedCsns = new Set<string>(
    core.map((r) => (r.PAT_ENC_CSN_ID ? String(r.PAT_ENC_CSN_ID) : "")).filter(Boolean)
  );

  // (2) Encounter siblings: same-CSN, Signed/Addendum, body-backed, target-published type.
  if (releasedCsns.size) {
    const siblings = q<{
      NOTE_ID: string;
      PAT_ENC_CSN_ID: string | null;
      IP_NOTE_TYPE_C_NAME: string | null;
      NOTE_TYPE_NOADD_C_NAME: string | null;
    }>(
      `SELECT DISTINCT h.NOTE_ID, h.PAT_ENC_CSN_ID, h.IP_NOTE_TYPE_C_NAME, h.NOTE_TYPE_NOADD_C_NAME
         FROM HNO_INFO h
         JOIN NOTE_ENC_INFO e ON e.NOTE_ID = h.NOTE_ID
        WHERE e.NOTE_STATUS_C_NAME IN ('Signed','Addendum')`
    );
    for (const s of siblings) {
      if (selected.has(s.NOTE_ID)) continue;
      if (!rtf.has(s.NOTE_ID)) continue; // require an exported body
      if (!s.PAT_ENC_CSN_ID || !releasedCsns.has(String(s.PAT_ENC_CSN_ID))) continue;
      if (!TARGET_NOTE_TYPES.has(noteTypeOf(s))) continue; // never invent a non-published type
      selected.add(s.NOTE_ID);
    }
  }

  return [...selected];
}

/**
 * Encounter CSNs that the Encounter generator actually emits. We must only reference
 * an Encounter that exists in the bundle, so this MIRRORS src/encounter.ts's emitted
 * set = selectCsns() (Complete contacts with appt/hsp/disp/note-with-reason) UNION its
 * referenced-closure (notes/imm/meds that pull extra Complete contacts in). We re-derive
 * the relevant clauses here (no cross-file import / no build-order dependency); the only
 * consumer is the imaging-DocRef guard below, which never references a CSN this set omits.
 */
function emittedEncounterCsns(): Set<string> {
  const out = new Set<string>();
  // selectCsns(): Complete PAT_ENC with a real anchor.
  for (const r of q<{ csn: string }>(
    `SELECT e.PAT_ENC_CSN_ID AS csn FROM PAT_ENC e
      WHERE e.CALCULATED_ENC_STAT_C_NAME = 'Complete'
        AND ( e.APPT_STATUS_C_NAME IS NOT NULL
          OR EXISTS (SELECT 1 FROM PAT_ENC_HSP h  WHERE h.PAT_ENC_CSN_ID = e.PAT_ENC_CSN_ID)
          OR EXISTS (SELECT 1 FROM PAT_ENC_DISP d WHERE d.PAT_ENC_CSN_ID = e.PAT_ENC_CSN_ID)
          OR ( EXISTS (SELECT 1 FROM HNO_INFO n          WHERE n.PAT_ENC_CSN_ID = e.PAT_ENC_CSN_ID)
               AND EXISTS (SELECT 1 FROM PAT_ENC_RSN_VISIT r WHERE r.PAT_ENC_CSN_ID = e.PAT_ENC_CSN_ID) ) )`
  )) out.add(String(r.csn));

  // referenced-closure: Complete PAT_ENC pulled in because an emitted resource refs it.
  const addIfComplete = (csn: string | null | undefined) => {
    if (!csn) return;
    const row = q1<{ csn: string }>(
      `SELECT PAT_ENC_CSN_ID AS csn FROM PAT_ENC WHERE PAT_ENC_CSN_ID = ? AND CALCULATED_ENC_STAT_C_NAME = 'Complete'`,
      String(csn)
    );
    if (row) out.add(String(csn));
  };
  for (const r of q<{ csn: string }>(`SELECT IMM_CSN AS csn FROM IMMUNE WHERE IMM_CSN IS NOT NULL`)) addIfComplete(r.csn);
  for (const r of q<{ csn: string }>(
    `SELECT PAT_ENC_CSN_ID AS csn FROM ORDER_MED
      WHERE PAT_ENC_CSN_ID IS NOT NULL AND (ORDERING_MODE_C_NAME IS NULL OR ORDERING_MODE_C_NAME <> 'Inpatient')`
  )) addIfComplete(r.csn);
  // DocumentReference.context.encounter for every clinical note we publish.
  for (const noteId of publishedNoteIds()) {
    const h = q1<{ csn: string }>(`SELECT PAT_ENC_CSN_ID AS csn FROM HNO_INFO WHERE NOTE_ID = ?`, noteId);
    addIfComplete(h?.csn);
  }
  return out;
}

/**
 * Imaging ORDER_PROC_IDs we publish a "Diagnostic imaging study" DocumentReference for.
 * Selection (all clauses fully EHI-derivable):
 *   (1) ORDER_TYPE_C_NAME = 'Imaging';
 *   (2) has a recoverable report body: at least one non-archived ORDER_NARRATIVE line;
 *   (3) its PAT_ENC_CSN_ID resolves to an Encounter we actually emit (so context.encounter
 *       and its identifier resolve in-bundle — never a dangling ref / fabricated encounter).
 * Like the clinical-note selection, this is the honest body-backed derivation: the EXACT
 * Epic-published imaging subset (and the target's duplicate of one order) is a publishing
 * artifact not in the export, so we emit one DocRef per qualifying order rather than invent
 * a duplicate body. In THIS specimen (2)+(3) land exactly on the target's two distinct
 * imaging studies (439060613 MRI BRAIN, 1025926289 XR CERVICAL SPINE).
 */
export function publishedImagingOrderIds(): string[] {
  const encs = emittedEncounterCsns();
  const rows = q<{ ORDER_PROC_ID: string; PAT_ENC_CSN_ID: string | null }>(
    `SELECT op.ORDER_PROC_ID, op.PAT_ENC_CSN_ID
       FROM ORDER_PROC op
      WHERE op.ORDER_TYPE_C_NAME = 'Imaging'
        AND EXISTS (SELECT 1 FROM ORDER_NARRATIVE n
                     WHERE n.ORDER_PROC_ID = op.ORDER_PROC_ID
                       AND (n.IS_ARCHIVED_YN IS NULL OR n.IS_ARCHIVED_YN <> 'Y'))`
  );
  return rows
    .filter((r) => r.PAT_ENC_CSN_ID && encs.has(String(r.PAT_ENC_CSN_ID)))
    .map((r) => String(r.ORDER_PROC_ID));
}

function buildDocumentReferences() {
  const custodianName = custodianDisplay();
  const candidates = publishedNoteIds();

  const out: any[] = [];
  for (const noteId of candidates) {
    const h = q1<any>(
      `SELECT NOTE_ID, IP_NOTE_TYPE_C_NAME, NOTE_TYPE_NOADD_C_NAME, PAT_ENC_CSN_ID,
              CREATE_INSTANT_DTTM
         FROM HNO_INFO WHERE NOTE_ID = ?`,
      noteId
    );
    if (!h) continue;

    // All contacts, oldest first (CONTACT_DATE_REAL is TEXT → CAST, §17/§18).
    const contacts = q<any>(
      `SELECT CONTACT_SERIAL_NUM, CONTACT_DATE_REAL, NOTE_STATUS_C_NAME,
              AUTH_LNKED_PROV_ID, AUTHOR_USER_ID_NAME, AUTHOR_PRVD_TYPE_C_NAME,
              NOTE_FILE_TIME_DTTM, SPEC_NOTE_TIME_DTTM
         FROM NOTE_ENC_INFO WHERE NOTE_ID = ?
        ORDER BY CAST(CONTACT_DATE_REAL AS REAL)`,
      noteId
    );
    if (!contacts.length) continue;

    const signedContacts = contacts.filter((c) => ATTEST_MODE[c.NOTE_STATUS_C_NAME]);
    if (!signedContacts.length) continue;

    const first = signedContacts[0];
    const last = signedContacts[signedContacts.length - 1];
    const hasAddendum = signedContacts.some((c) => c.NOTE_STATUS_C_NAME === "Addendum");

    const typeText = h.IP_NOTE_TYPE_C_NAME || h.NOTE_TYPE_NOADD_C_NAME || undefined;

    // attester extension — one per signing contact
    const attesters = signedContacts.map((c) => {
      const mode = ATTEST_MODE[c.NOTE_STATUS_C_NAME];
      return {
        extension: [
          {
            url: "mode",
            // Epic mode CODE not in export → text only (coding GAP)
            valueCodeableConcept: { text: mode.text },
          },
          { url: "time", valueDateTime: dttmToUTC(c.NOTE_FILE_TIME_DTTM) },
          {
            url: "party",
            valueReference: practitionerRefFromProv(c.AUTH_LNKED_PROV_ID, c.AUTHOR_USER_ID_NAME)
              ? ref("Practitioner", id.practitioner(c.AUTH_LNKED_PROV_ID), c.AUTHOR_USER_ID_NAME || undefined)
              : undefined,
          },
        ],
        url: ATTESTER_URL,
      };
    });

    // context.extension — author-provider-type (text only; Epic code GAP)
    const provType = first.AUTHOR_PRVD_TYPE_C_NAME
      ? [{ url: PROV_TYPE_URL, valueCodeableConcept: { text: first.AUTHOR_PRVD_TYPE_C_NAME } }]
      : undefined;

    const authInstant = dttmToUTC(last.NOTE_FILE_TIME_DTTM);
    const authenticator = last.AUTH_LNKED_PROV_ID
      ? {
          extension: authInstant
            ? [{ valueDateTime: authInstant, url: AUTH_INSTANT_URL }]
            : undefined,
          reference: `Practitioner/${id.practitioner(last.AUTH_LNKED_PROV_ID)}`,
          type: "Practitioner",
          display: last.AUTHOR_USER_ID_NAME || undefined,
        }
      : undefined;

    const csn = h.PAT_ENC_CSN_ID;
    const encounter = csn
      ? [
          {
            reference: `Encounter/${id.encounter(csn)}`,
            identifier: { use: "usual", system: SYS_CSN, value: String(csn) },
            // encounter `display` = Epic encounter-type label, not in export → omitted (GAP)
          },
        ]
      : undefined;

    out.push(
      clean({
        resourceType: "DocumentReference",
        id: id.documentReference(noteId),
        extension: attesters,
        identifier: [
          { system: SYS_NOTE, value: String(noteId) },
          { system: SYS_NOTE_DOC, value: `${NOTE_OID_TAIL}_${noteId}` },
        ],
        status: "current",
        docStatus: hasAddendum ? "amended" : "final",
        type: typeText ? { text: typeText } : undefined,
        category: [
          {
            coding: [
              {
                system: "http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category",
                code: "clinical-note",
                display: "Clinical Note",
              },
            ],
            text: "Clinical Note",
          },
        ],
        subject: patientRef(),
        date: dttmToUTC(h.CREATE_INSTANT_DTTM),
        author: practitionerRefFromProv(first.AUTH_LNKED_PROV_ID, first.AUTHOR_USER_ID_NAME)
          ? [practitionerRefFromProv(first.AUTH_LNKED_PROV_ID, first.AUTHOR_USER_ID_NAME)]
          : undefined,
        authenticator,
        // custodian DISPLAY ("UnityPoint Health") ← CLARITY_SA.EXTERNAL_NAME (the export's
        // single customer-facing org name). The paired custodian.identifier
        // ("urn:ihs:ce-prd", urn:ietf:rfc:3986) is a Care-Everywhere/HIE publishing id
        // absent from the export → display-only custodian (GAP on identifier only).
        custodian: custodianName ? { display: custodianName } : undefined,
        // content[] attachments come from src/binary.ts: a text/rtf entry (+ a clearly-
        // DERIVED text/plain rendering), with size + base64 SHA-1 hash of the EXACT exported
        // bytes, title=note type, creation=note date. The `url` points at a Binary/<hash>
        // ONLY under --embed-attachments (EMBED_ATTACHMENTS=1), because that is the only build
        // that actually bundles the Binary resources — pointing at an unbundled Binary would
        // dangle. The lean build carries the same attachment metadata WITHOUT the url.
        content: attachmentsForNote(noteId, {
          title: typeText,
          creation: dttmToUTC(h.CREATE_INSTANT_DTTM),
        }).map((a) => ({
          attachment: {
            contentType: a.contentType,
            url: process.env.EMBED_ATTACHMENTS ? a.url : undefined,
            size: a.size,
            hash: a.hash,
            title: a.title,
            creation: a.creation,
          },
          format: {
            system: FORMAT_SYS,
            code: "urn:ihe:iti:xds:2017:mimeTypeSufficient",
            display: "mimeType Sufficient",
          },
        })),
        context: {
          extension: provType,
          encounter,
          period: { start: dttmToUTC(first.SPEC_NOTE_TIME_DTTM) },
        },
      })
    );
  }

  return out;
}

/**
 * Family (B): "Diagnostic imaging study" DocumentReferences for imaging ORDER_PROCs
 * that carry a recoverable radiology report body (ORDER_NARRATIVE) and live in an
 * encounter we emit. Field map (all EHI-derived):
 *   id                     ← id.documentReference(ORDER_PROC_ID)   ("doc-<order>")
 *   identifier[0]          ← {SYS_ORDER_PLACER (.798268), value=ORDER_PROC_ID}
 *   status                 = "current"
 *   type.text              ← ORDER_PROC.DESCRIPTION's family is imaging → fixed
 *                            "Diagnostic imaging study" (the target's type.text). The paired
 *                            LOINC 18748-4 is an Epic-assigned document-type code NOT in the
 *                            export (crosswalk: traceable=no) → text only (coding GAP).
 *   category               = us-core "clinical-note" (the target uses this category for imaging)
 *   subject                = patientRef()
 *   date / context.period  ← ORDER_PROC.RESULT_TIME (UTC-rounded). The target's study-time
 *                            instant is an Epic-publishing value absent from the export → a
 *                            per-field value GAP, not a reason to withhold the resource.
 *   custodian.display      ← CLARITY_SA.EXTERNAL_NAME ("UnityPoint Health")
 *   content[]              = text/plain attachment over the EXACT recovered ORDER_NARRATIVE
 *                            bytes (Binary/bin-<sha1>; src/binary.ts). The target's text/html
 *                            Binary bytes are NOT in the export → we carry the relational
 *                            narrative we DO have, labeled honestly as text/plain.
 *   context.encounter      ← ORDER_PROC.PAT_ENC_CSN_ID → Encounter ref + CSN identifier
 */
function buildImagingDocumentReferences() {
  const custodianName = custodianDisplay();
  const out: any[] = [];
  for (const orderId of publishedImagingOrderIds()) {
    const op = q1<any>(
      `SELECT ORDER_PROC_ID, PAT_ENC_CSN_ID, RESULT_TIME FROM ORDER_PROC WHERE ORDER_PROC_ID = ?`,
      orderId
    );
    if (!op) continue;

    const when = dttmToUTC(op.RESULT_TIME);
    const csn = op.PAT_ENC_CSN_ID;
    const encounter = csn
      ? [{ reference: `Encounter/${id.encounter(csn)}`, identifier: { use: "usual", system: SYS_CSN, value: String(csn) } }]
      : undefined;

    out.push(
      clean({
        resourceType: "DocumentReference",
        identifier: [{ use: "usual", system: SYS_ORDER_PLACER, value: String(orderId) }],
        id: id.documentReference(orderId),
        status: "current",
        // LOINC 18748-4 is Epic-assigned + not in export (coding GAP) → type.text only.
        type: { text: "Diagnostic imaging study" },
        category: [
          {
            coding: [
              {
                system: "http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category",
                code: "clinical-note",
                display: "Clinical Note",
              },
            ],
            text: "Clinical Note",
          },
        ],
        subject: patientRef(),
        date: when,
        custodian: custodianName ? { display: custodianName } : undefined,
        content: attachmentsForOrder(orderId, { title: "Diagnostic imaging study", creation: when }).map((a) => ({
          attachment: {
            contentType: a.contentType,
            url: process.env.EMBED_ATTACHMENTS ? a.url : undefined,
            size: a.size,
            hash: a.hash,
            title: a.title,
            creation: a.creation,
          },
          format: {
            system: FORMAT_SYS,
            code: "urn:ihe:iti:xds:2017:mimeTypeSufficient",
            display: "mimeType Sufficient",
          },
        })),
        context: { encounter, period: when ? { start: when } : undefined },
      })
    );
  }
  return out;
}

if (import.meta.main)
  emit("DocumentReference", [...buildDocumentReferences(), ...buildImagingDocumentReferences()]);
