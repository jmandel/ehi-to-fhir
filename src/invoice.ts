/**
 * invoice.ts — FHIR R4 Invoice from the Epic EHI export.
 *
 * Domain "billing". Owns: Invoice. One Invoice per INVOICE row (21 in this specimen).
 *
 * The Epic Professional-Billing claim/invoice cluster (see coverage-and-billing.md):
 *   INVOICE          — INV master / claim container. Key INVOICE_ID. PAT_ID (subject),
 *                      ACCOUNT_ID (guarantor account), PROV_ID (billing provider),
 *                      SERV_AREA_ID (issuing facility org), INIT_INSURANCE_BAL (original
 *                      billed total). RECORD_STATUS_C_NAME is NULL 21/21 here.
 *   INV_BASIC_INFO   — one row per claim SUBMISSION, keyed (INV_ID, LINE). INV_NUM is the
 *                      L-number, INV_STATUS_C_NAME (Closed/Accepted/Rejected/Voided),
 *                      INV_TYPE_C_NAME ("Claim"), FROM_SVC_DATE / TO_SVC_DATE.
 *   INV_TX_PIECES    — (INV_ID, LINE) → TX_ID: the charge transactions on the invoice.
 *   ARPB_TRANSACTIONS— the PB ledger; charge AMOUNT, PROC_ID, SERVICE_DATE per TX (all
 *                      pieces are Charge type, positive amounts).
 *   CLARITY_EAP      — PROC_ID → PROC_NAME (procedure display; no CPT column).
 *   CL_RMT_SVCE_LN_INF — PROC_IDENTIFIER = as-billed CPT/HCPCS on the 837/835
 *                      ("HC:99395", "HC:99213:95" = code[:modifier...]). Joined
 *                      SVC_LINE_CHG_PB_ID = TX_ID.
 *   CLARITY_SER      — PROV_ID → PROV_NAME (billing-provider display).
 *
 * FIELD SOURCES
 *   id            id.invoice(INVOICE_ID)
 *   identifier[]  INV_BASIC_INFO.INV_NUM per submission line (the claim-run L-numbers),
 *                 under the Epic invoice/claim record OID. Plus the INVOICE_ID under the
 *                 same OID (the master key), as every domain here carries the Epic id.
 *   status        derived from INV_BASIC_INFO.INV_STATUS_C_NAME of the LATEST submission:
 *                 Closed/Accepted → balanced; Voided → cancelled; Rejected → cancelled;
 *                 otherwise issued. (lossy — coding gap; Epic has no FHIR-aligned column.)
 *   cancelledReason  the Epic status text (Rejected/Voided) when status=cancelled.
 *   type          INV_TYPE_C_NAME ("Claim") as text only (Epic category, no standard code).
 *   subject       Patient via patientRef() (INVOICE.PAT_ID = this patient).
 *   date          INV_BASIC_INFO.FROM_SVC_DATE of the latest submission (service date stands
 *                 in for posting date — no distinct issue timestamp; gap).
 *   issuer        Organization id.organization(SERV_AREA_ID) (the billing facility,
 *                 minted by location-org.ts) + display CLARITY_SA.SERV_AREA_NAME.
 *   account       Account id.account(ACCOUNT_ID) (guarantor; built by account.ts).
 *   participant   billing Practitioner id.practitioner(PROV_ID) (built by practitioner.ts),
 *                 role = text "Billing provider", display CLARITY_SER.PROV_NAME.
 *   lineItem[]    one per INV_TX_PIECES row (its TX = one charge):
 *     .sequence              INV_TX_PIECES.LINE (positiveInt)
 *     .chargeItemCodeableConcept  CPT from CL_RMT_SVCE_LN_INF.PROC_IDENTIFIER when present
 *                            (code + modifier coding), always text CLARITY_EAP.PROC_NAME.
 *     .priceComponent.type   "base" (the charge amount is the base price).
 *     .priceComponent.amount ARPB_TRANSACTIONS.AMOUNT as Money USD (positive charge).
 *   totalNet / totalGross  Σ line AMOUNT as Money USD (= ININIT_INSURANCE_BAL, verified
 *                          equal per invoice). No separate gross vs net (no tax/surcharge).
 *
 * GAPS (see gaps/invoice.md)
 *   - status: derived/lossy map of Epic Closed/Accepted/Rejected/Voided → FHIR statuses.
 *   - type: Epic text "Claim" only, no standard CodeableConcept code.
 *   - CPT line coding falls back to PROC_NAME text only if a charge lacks a 835 service line
 *     (currently 29/29 distinct charge TX resolve, so no line is text-only here).
 *   - recipient, paymentTerms, note, date-as-issue: not populatable / not distinct in EHI.
 *
 * Everything is TEXT in the EHI (general-patterns §17); amounts CAST before SUM; categories
 * ship pre-resolved as *_C_NAME (§23).
 */
import { q, parseEpicDateTime } from "../lib/db";
import { emit, clean } from "../lib/gen";
import { cc, ident } from "../lib/cc";
import { id, ref, patientRef } from "../lib/ids";
import { nn, money } from "../lib/fmt";

// Standard / published systems.
const SYS_CPT = "http://www.ama-assn.org/go/cpt";
const SYS_MODIFIER = "http://www.ama-assn.org/go/cpt"; // CPT modifiers share the CPT system.
const SYS_V2_0203 = "http://terminology.hl7.org/CodeSystem/v2-0203";

// NB: the Epic INV master-file OID suffix is NOT verifiable from the export (same
// reasoning account.ts applies to EAR), so identifiers are asserted as type + value only,
// with no fabricated system URI. Recorded as a coding gap.


/**
 * Map Epic INV_STATUS_C_NAME of the governing (latest) submission to FHIR InvoiceStatus.
 * Epic: Closed, Accepted, Rejected, Voided. FHIR: draft|issued|balanced|cancelled|eie.
 */
function mapStatus(epic: string | undefined): { status: string; cancelledReason?: string } {
  switch ((epic ?? "").toLowerCase()) {
    case "closed":
    case "accepted":
      return { status: "balanced" };
    case "voided":
      return { status: "cancelled", cancelledReason: epic };
    case "rejected":
      return { status: "cancelled", cancelledReason: epic };
    default:
      // Submitted-but-not-resolved → issued (none in this specimen, but be safe).
      return { status: "issued" };
  }
}

/** CL_RMT_SVCE_LN_INF.PROC_IDENTIFIER "HC:99213:95" → CPT coding + modifier coding(s). */
function cptCoding(tx: string): any[] | undefined {
  const row = q<{ PROC_IDENTIFIER: string }>(
    `SELECT DISTINCT PROC_IDENTIFIER FROM CL_RMT_SVCE_LN_INF
      WHERE SVC_LINE_CHG_PB_ID = ? AND PROC_IDENTIFIER IS NOT NULL`,
    tx
  )[0];
  const raw = nn(row?.PROC_IDENTIFIER);
  if (!raw) return undefined;
  // Format: <qual>:<code>[:<modifier>...] where qual=HC (HCPCS/CPT). Strip the qualifier.
  const parts = raw.split(":").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return undefined;
  const qual = parts[0].toUpperCase();
  if (qual !== "HC") return undefined; // only assert CPT system for HC-qualified codes.
  const code = parts[1];
  const codings: any[] = [{ system: SYS_CPT, code }];
  for (const mod of parts.slice(2)) {
    codings.push({ system: SYS_MODIFIER, code: mod });
  }
  return codings;
}

function buildInvoices(): any[] {
  const out: any[] = [];

  const invoices = q<any>(
    `SELECT INVOICE_ID, PAT_ID, ACCOUNT_ID, PROV_ID, SERV_AREA_ID,
            INIT_INSURANCE_BAL
       FROM INVOICE
      ORDER BY CAST(INVOICE_ID AS INTEGER)`
  );

  for (const inv of invoices) {
    const invId = nn(inv.INVOICE_ID);
    if (!invId) continue;

    // --- Submission rows (claim runs). Latest line governs status + date.
    const submissions = q<any>(
      `SELECT LINE, INV_NUM, INV_STATUS_C_NAME, INV_TYPE_C_NAME, FROM_SVC_DATE
         FROM INV_BASIC_INFO
        WHERE INV_ID = ?
        ORDER BY CAST(LINE AS INTEGER)`,
      invId
    );
    const latest = submissions[submissions.length - 1];

    // --- identifiers: each submission's claim/invoice L-number (typed "FILL"), plus the
    // master INVOICE_ID (typed placer "PLAC"). No system asserted (OID not verifiable).
    const identifier: any[] = [];
    identifier.push(
      ident(undefined, invId, { use: "secondary", type: cc(SYS_V2_0203, "PLAC", "Placer Identifier", null) })
    );
    for (const s of submissions) {
      const num = nn(s.INV_NUM);
      if (num)
        identifier.push(
          ident(undefined, num, { use: "official", type: cc(SYS_V2_0203, "FILL", "Filler Identifier", null) })
        );
    }

    // --- status / cancelledReason.
    const { status, cancelledReason } = mapStatus(nn(latest?.INV_STATUS_C_NAME));

    // --- type (Epic text only).
    const typeText = nn(latest?.INV_TYPE_C_NAME);

    // --- date (service date of the governing submission). FROM_SVC_DATE carries a
    // placeholder "12:00:00 AM" time, so emit date-only (a valid FHIR dateTime form that
    // avoids asserting a spurious time/zone).
    const date = parseEpicDateTime(latest?.FROM_SVC_DATE)?.slice(0, 10);

    // --- issuer (billing facility org).
    const saId = nn(inv.SERV_AREA_ID);
    let issuer: any | undefined;
    if (saId) {
      const saName = nn(
        q<{ SERV_AREA_NAME: string }>(`SELECT SERV_AREA_NAME FROM CLARITY_SA WHERE SERV_AREA_ID = ?`, saId)[0]
          ?.SERV_AREA_NAME
      );
      issuer = ref("Organization", id.organization(saId), saName);
    }

    // --- account (guarantor).
    const acctId = nn(inv.ACCOUNT_ID);
    const account = acctId ? ref("Account", id.account(acctId)) : undefined;

    // --- billing-provider participant.
    const provId = nn(inv.PROV_ID);
    let participant: any[] | undefined;
    if (provId) {
      const provName = nn(
        q<{ PROV_NAME: string }>(`SELECT PROV_NAME FROM CLARITY_SER WHERE PROV_ID = ?`, provId)[0]?.PROV_NAME
      );
      participant = [
        clean({
          role: { text: "Billing provider" },
          actor: ref("Practitioner", id.practitioner(provId), provName),
        }),
      ];
    }

    // --- line items: one per charge piece.
    const pieces = q<any>(
      `SELECT LINE, TX_ID
         FROM INV_TX_PIECES
        WHERE INV_ID = ?
        ORDER BY CAST(LINE AS INTEGER), CAST(TX_PIECE AS INTEGER)`,
      invId
    );

    const lineItem: any[] = [];
    let total = 0;
    let haveTotal = false;
    for (const p of pieces) {
      const tx = nn(p.TX_ID);
      if (!tx) continue;
      const charge = q<any>(
        `SELECT AMOUNT, PROC_ID FROM ARPB_TRANSACTIONS WHERE TX_ID = ?`,
        tx
      )[0];
      if (!charge) continue;

      // chargeItemCodeableConcept: CPT coding (when on the 835 service line) + proc-name text.
      const codings = cptCoding(tx);
      const procId = nn(charge.PROC_ID);
      const procName = procId
        ? nn(q<{ PROC_NAME: string }>(`SELECT PROC_NAME FROM CLARITY_EAP WHERE PROC_ID = ?`, procId)[0]?.PROC_NAME)
        : undefined;
      const chargeItem = clean({ coding: codings, text: procName });

      const amt = money(charge.AMOUNT);
      if (amt) {
        total += amt.value;
        haveTotal = true;
      }

      const seqRaw = nn(p.LINE);
      const seq = seqRaw && Number.isInteger(Number(seqRaw)) ? Number(seqRaw) : undefined;

      lineItem.push(
        clean({
          sequence: seq && seq > 0 ? seq : undefined,
          chargeItemCodeableConcept: Object.keys(chargeItem).length ? chargeItem : undefined,
          priceComponent: amt ? [{ type: "base", amount: amt }] : [{ type: "base" }],
        })
      );
    }

    const totalMoney = haveTotal ? { value: Math.round(total * 100) / 100, currency: "USD" } : undefined;

    const patRef = patientRef();

    out.push(
      clean({
        resourceType: "Invoice",
        id: id.invoice(invId),
        identifier,
        status,
        cancelledReason,
        type: typeText ? { text: typeText } : undefined,
        subject: { reference: patRef.reference, display: patRef.display },
        date,
        issuer,
        account,
        participant,
        lineItem: lineItem.length ? lineItem : undefined,
        totalNet: totalMoney,
        totalGross: totalMoney,
      })
    );
  }

  return out;
}

emit("Invoice", buildInvoices());
