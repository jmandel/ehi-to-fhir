/**
 * paymentrecon.ts — FHIR PaymentReconciliation from the Epic EHI export.
 *
 * Domain "billing". Owns: PaymentReconciliation.
 *
 * Epic stores each received 835 electronic remittance advice (ERA) as a remittance
 * image (CL_REMIT, IMD master; IMAGE_ID is the key every CL_RMT_* child carries).
 * In this specimen each image carries exactly one claim (CL_RMT_CLM_INFO is 1:1 on
 * IMAGE_ID — 24 images, 24 claim rows) and 1–3 service lines (CL_RMT_SVCE_LN_INF,
 * 40 lines total). So one PaymentReconciliation == one CL_REMIT.IMAGE_ID: the payer's
 * remittance/payment report for one adjudicated claim. detail[] carries the per-
 * service-line payment breakdown. See design/paymentrecon.md and gaps/paymentrecon.md.
 *
 * FIELD SOURCES
 *   id                 id.paymentReconciliation(IMAGE_ID) -> pmtrec-<IMAGE_ID>.
 *   identifier[image]  CL_REMIT.IMAGE_ID under the Epic remittance-image OID (same Epic
 *                      master-file OID convention every domain here uses for Epic ids).
 *   identifier[ICN]    CL_RMT_CLM_INFO.ICN_NO — payer claim control number (X12 CLP07).
 *   status             constant "active" (FinancialResourceStatusCodes). CL_REMIT has no
 *                      status column; these are posted/historical ERAs. Mapping-logic
 *                      constant, not patient data (recorded as a gap: no source status).
 *   period.start       CL_RMT_CLM_DT_INFO "Claim statement period start" where present.
 *                      No "period end" qualifier ships in this export — Period{start} is
 *                      valid FHIR. Most images carry only "Received" -> no period emitted.
 *   created            CL_REMIT.CREATION_DATE (image creation = posting date), full dateTime.
 *   paymentIssuer      CL_RMT_CLM_INFO.INV_NO -> INV_BASIC_INFO.INV_NUM -> EPM_ID ->
 *                      Organization(id.organization(EPM_ID)) + display CLARITY_EPM.PAYOR_NAME.
 *                      Resolves 23/24 (org-1302 BLUE CROSS OF WISCONSIN is already emitted by
 *                      the coverage/org generators). The 1 HB claim (INV_NO 37668481002) is
 *                      not in PB INV_BASIC_INFO -> paymentIssuer omitted for that image.
 *   outcome            CL_RMT_CLM_INFO.CLM_STAT_CD_C_NAME mapped to RemittanceOutcome:
 *                      "Processed as Primary"/"Reversal of previous payment" -> complete,
 *                      "Denied" -> error. Posted, fully-adjudicated ERAs.
 *   disposition        CL_RMT_CLM_INFO.CLM_STAT_CD_C_NAME raw label (human-readable text).
 *   paymentDate        CL_REMIT.CREATION_DATE (date part). No separate BPR/check issue date
 *                      ships (CL_REMIT.ISSUE_DATE is 100% NULL) -> CREATION_DATE is posting date.
 *   paymentAmount      CL_RMT_CLM_INFO.CLAIM_PAID_AMT as Money{value, currency:"USD"}. One
 *                      claim per image; equals the sum of service-line PROV_PAYMENT_AMT
 *                      (verified penny-exact). 0.00 for denied / reversal / patient-resp-only.
 *   paymentIdentifier  CL_RMT_CLM_INFO.ICN_NO (payer claim control number).
 *   detail[]           one per CL_RMT_SVCE_LN_INF row.
 *     detail.type      constant "payment" (PaymentTypeCodes) — every 835 SVC line is a payment.
 *     detail.identifier  ICN_NO + SERVICE_LINE composite (line-level trace).
 *     detail.amount    CL_RMT_SVCE_LN_INF.PROV_PAYMENT_AMT as Money USD.
 *     detail.date      CL_REMIT.CREATION_DATE (date) — no per-line service date on the remit line.
 *   processNote[]      CARC service-level adjustments from CL_RMT_SVC_LVL_ADJ, joined on
 *                      (IMAGE_ID, CAS_SERVICE_LINE): type "display", text e.g.
 *                      "CO-45 $104.27 (Contractual Obligation)". CARC code is a transmitted
 *                      X12 code -> traceable.
 *
 * SIGN / MONEY: CLAIM_PAID_AMT and PROV_PAYMENT_AMT are payer-to-provider payments ->
 * positive Money USD, passed through unchanged (no sign flip). The single "Reversal of
 * previous payment" image has CLAIM_CHRG_AMT -315.00 but CLAIM_PAID_AMT 0.00 — we emit the
 * paid figure (0.00), not the charge figure.
 *
 * GAPS (see gaps/paymentrecon.md): no source status column; request (no Task built);
 * requestor (rendering provider is NPI+name only, no resolvable SER id); formCode (Epic
 * form classification not exported); detail.request (PB charge pointer resolves to
 * ARPB_TRANSACTIONS but no ChargeItem resource is built — references must resolve to
 * emitted ids); detail submitter/payee/responsible/predecessor/response (no resolvable id);
 * paymentIssuer for the 1 HB claim (not in PB INV_BASIC_INFO).
 *
 * Everything is TEXT in the EHI (general-patterns §17); CAST before numeric ops/ORDER BY.
 */
import { q, parseEpicDateTime } from "../lib/db";
import { emit, clean } from "../lib/gen";
import { cc, ident } from "../lib/cc";
import { id, ref } from "../lib/ids";
import { nn, money, enumMap } from "../lib/fmt";

// Epic remittance-image (IMD) record OID. Same Epic-instance prefix (1.2.840.114350.1.13.283)
// and master-file-OID convention every other domain generator here uses for Epic ids.
const OID_REMIT_IMAGE = "urn:oid:1.2.840.114350.1.13.283.2.7.2.798268";
// Payer claim control number (X12 CLP07 ICN) — payer-assigned, no published/derivable OID.
// Emitted value-only (FHIR Identifier permits value without system) rather than inventing a
// system URI; recorded as a coding/system gap.

// FHIR published system we can legitimately assert.
const SYS_PMT_TYPE = "http://terminology.hl7.org/CodeSystem/payment-type";

// RemittanceOutcome (required binding): queued | complete | error | partial.
// Maps the posted ERA claim-status label to adjudication outcome (mapping logic).
const OUTCOME_MAP: Record<string, string> = {
  "Processed as Primary": "complete",
  "Reversal of previous payment": "complete",
  Denied: "error",
};


function buildPaymentReconciliations(): any[] {
  const out: any[] = [];

  const images = q<any>(
    `SELECT r.IMAGE_ID, r.CREATION_DATE,
            c.ICN_NO, c.CLAIM_PAID_AMT, c.CLM_STAT_CD_C_NAME, c.INV_NO
       FROM CL_REMIT r
       JOIN CL_RMT_CLM_INFO c ON c.IMAGE_ID = r.IMAGE_ID
      ORDER BY CAST(r.IMAGE_ID AS INTEGER)`
  );

  for (const im of images) {
    const imageId = nn(im.IMAGE_ID);
    if (!imageId) continue;

    // CREATION_DATE is date-only here (every value is the midnight sentinel, no real time
    // component and no timezone in the EHI). Emit `created` (a dateTime element) as a bare
    // date — valid for dateTime and avoids fabricating a timezone offset.
    const created = parseEpicDateTime(im.CREATION_DATE)?.slice(0, 10);
    const paymentDate = created; // posting date; CL_REMIT.ISSUE_DATE is 100% NULL
    const icn = nn(im.ICN_NO);
    const statusLabel = nn(im.CLM_STAT_CD_C_NAME);

    // --- identifiers: the remittance-image record id + the payer ICN.
    const identifier: any[] = [ident(OID_REMIT_IMAGE, imageId)];
    if (icn) identifier.push(ident(undefined, icn));

    // --- paymentIssuer: INV_NO -> INV_BASIC_INFO.EPM_ID -> Organization + payer name.
    let paymentIssuer: any;
    const invNo = nn(im.INV_NO);
    if (invNo) {
      const epmId = nn(
        q<{ EPM_ID: string }>(`SELECT EPM_ID FROM INV_BASIC_INFO WHERE INV_NUM = ?`, invNo)[0]?.EPM_ID
      );
      if (epmId) {
        const payorName = nn(
          q<{ PAYOR_NAME: string }>(`SELECT PAYOR_NAME FROM CLARITY_EPM WHERE PAYOR_ID = ?`, epmId)[0]
            ?.PAYOR_NAME
        );
        paymentIssuer = ref("Organization", id.organization(epmId), payorName);
      }
    }

    // --- outcome (required-binding enum) + disposition (raw label as text).
    const outcome = enumMap(statusLabel, OUTCOME_MAP);

    // --- detail[]: one per 835 service line.
    const svc = q<any>(
      `SELECT SERVICE_LINE, PROV_PAYMENT_AMT
         FROM CL_RMT_SVCE_LN_INF
        WHERE IMAGE_ID = ?
        ORDER BY CAST(SERVICE_LINE AS INTEGER)`,
      imageId
    );
    const detail = svc.map((s) => {
      const line = nn(s.SERVICE_LINE);
      return clean({
        identifier: icn && line ? ident(undefined, `${icn}-${line}`) : undefined,
        type: cc(SYS_PMT_TYPE, "payment", "Payment", null),
        date: paymentDate,
        amount: money(s.PROV_PAYMENT_AMT),
      });
    });

    // --- processNote[]: CARC service-level adjustments (transmitted X12 reason codes).
    const adjs = q<any>(
      `SELECT SVC_CAS_GRP_CODE_C_NAME, SVC_ADJ_REASON_CD, SVC_ADJ_AMT
         FROM CL_RMT_SVC_LVL_ADJ
        WHERE IMAGE_ID = ?
        ORDER BY CAST(CAS_SERVICE_LINE AS INTEGER), CAST(LINE AS INTEGER)`,
      imageId
    );
    const processNote = adjs
      .map((a) => {
        const reason = nn(a.SVC_ADJ_REASON_CD);
        const amt = nn(a.SVC_ADJ_AMT);
        const grp = nn(a.SVC_CAS_GRP_CODE_C_NAME);
        if (!reason && !amt && !grp) return undefined;
        // e.g. "45 $104.27 (Contractual Obligation)" — all parts from the EHI row.
        const parts: string[] = [];
        if (reason) parts.push(reason);
        if (amt !== undefined) parts.push(`$${amt}`);
        const head = parts.join(" ");
        const text = grp ? (head ? `${head} (${grp})` : grp) : head;
        return text ? { type: "display", text } : undefined;
      })
      .filter(Boolean);

    // --- period.start: "Claim statement period start" qualifier where present.
    const periodStart = nn(
      q<{ CLAIM_DT: string }>(
        `SELECT CLAIM_DT FROM CL_RMT_CLM_DT_INFO
          WHERE IMAGE_ID = ? AND CLAIM_DATE_QUAL_C_NAME = 'Claim statement period start'
          ORDER BY CAST(LINE AS INTEGER) LIMIT 1`,
        imageId
      )[0]?.CLAIM_DT
    );
    const period = periodStart
      ? { start: parseEpicDateTime(periodStart)?.slice(0, 10) }
      : undefined;

    out.push(
      clean({
        resourceType: "PaymentReconciliation",
        id: id.paymentReconciliation(imageId),
        identifier,
        status: "active",
        period,
        created,
        paymentIssuer,
        outcome,
        disposition: statusLabel,
        paymentDate,
        paymentAmount: money(im.CLAIM_PAID_AMT) ?? { value: 0, currency: "USD" },
        paymentIdentifier: icn ? ident(undefined, icn) : undefined,
        detail: detail.length ? detail : undefined,
        processNote: processNote.length ? processNote : undefined,
      })
    );
  }

  return out;
}

emit("PaymentReconciliation", buildPaymentReconciliations());
