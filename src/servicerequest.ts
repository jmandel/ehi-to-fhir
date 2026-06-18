/**
 * servicerequest.ts — Epic EHI → FHIR ServiceRequest for the resulted lab/micro orders.
 *
 * These are the ORDER_PROC rows that the lab Observation.basedOn / DiagnosticReport.basedOn
 * point at. lab.ts mints those references via id.serviceRequest(ORDER_PROC_ID); this generator
 * emits the matching ServiceRequest so the links RESOLVE (no fabrication — one SR per real
 * resulted lab order, keyed identically).
 *
 * Spine: the SAME order set as lab.ts (ORDER_PROC where ORDER_CLASS_C_NAME = 'Lab Collect'
 * AND it carries ORDER_RESULTS). That guarantees a 1:1 correspondence with the
 * DiagnosticReport / lab-Observation orders, so every basedOn reference has a referent.
 *
 * Field derivation (all from the EHI — no invented values):
 *   id           id.serviceRequest(ORDER_PROC_ID)
 *   identifier   placer id = ORDER_PROC_ID (same system the DR/Obs use)
 *   status       from ORDER_STATUS_C_NAME (Completed → "completed")
 *   intent       "order" (these are placed clinician orders — ORDER_PROC rows)
 *   code         text = ORDER_PROC.DESCRIPTION (the proc-master order name)
 *   subject      Patient
 *   encounter    PAT_ENC_CSN_ID → Encounter
 *   requester    AUTHRZING_PROV_ID → Practitioner (CLARITY_SER name)
 *   authoredOn   ORDERING_DATE (date)
 */
import { qIf } from "../lib/db";
import { isoDate as dateOnly } from "../lib/time";
import { id, ref, patientRef, SYS } from "../lib/ids";
import { emit, clean } from "../lib/gen";
import { concept, ident } from "../lib/cc";

const SYS_PLACER = SYS.PLACER; // order placer id (matches DR/Obs)
const SYS_ENC = SYS.CSN;  // Encounter CSN

type Row = Record<string, any>;

/** ORDER_STATUS_C_NAME → FHIR ServiceRequest.status. */
function srStatus(name: unknown): string {
  const s = String(name ?? "").trim().toLowerCase();
  if (s === "completed") return "completed";
  if (s === "canceled" || s === "cancelled") return "revoked";
  if (s === "pending" || s === "sent" || s === "active") return "active";
  return "completed"; // all orders in this specimen are Completed/Final result
}

function build(): any[] {
  // Same order set as lab.ts: resulted Lab Collect orders. Join the header fields we need.
  const rows = qIf<Row>(
    "ORDER_RESULTS",
    `SELECT p.ORDER_PROC_ID, p.DESCRIPTION, p.ORDER_STATUS_C_NAME, p.PAT_ENC_CSN_ID,
            p.AUTHRZING_PROV_ID, p.ORDERING_DATE, p.ORDER_TYPE_C_NAME,
            ser.PROV_NAME AS AUTH_PROV_NAME
       FROM ORDER_PROC p
       LEFT JOIN CLARITY_SER ser ON ser.PROV_ID = p.AUTHRZING_PROV_ID
      WHERE p.ORDER_CLASS_C_NAME = 'Lab Collect'
        AND EXISTS (SELECT 1 FROM ORDER_RESULTS r WHERE r.ORDER_PROC_ID = p.ORDER_PROC_ID)
      GROUP BY p.ORDER_PROC_ID
      ORDER BY CAST(p.ORDER_PROC_ID AS INTEGER)`
  );

  const out: any[] = [];
  for (const r of rows) {
    const orderId = String(r.ORDER_PROC_ID);
    const csn = r.PAT_ENC_CSN_ID ? String(r.PAT_ENC_CSN_ID) : undefined;

    const encounter = csn
      ? {
          reference: `Encounter/${id.encounter(csn)}`,
          identifier: ident(SYS_ENC, csn, { use: "usual" }),
        }
      : undefined;

    const requester = r.AUTHRZING_PROV_ID
      ? {
          reference: `Practitioner/${id.practitioner(r.AUTHRZING_PROV_ID)}`,
          type: "Practitioner",
          display: r.AUTH_PROV_NAME ? String(r.AUTH_PROV_NAME).trim() : undefined,
        }
      : undefined;

    out.push(
      clean({
        resourceType: "ServiceRequest",
        id: id.serviceRequest(orderId),
        identifier: [ident(SYS_PLACER, orderId, { use: "usual" })],
        status: srStatus(r.ORDER_STATUS_C_NAME),
        intent: "order",
        code: r.DESCRIPTION ? concept(String(r.DESCRIPTION).trim()) : undefined,
        subject: patientRef(),
        encounter,
        authoredOn: dateOnly(r.ORDERING_DATE),
        requester,
      })
    );
  }
  return out;
}

emit("ServiceRequest", build());
