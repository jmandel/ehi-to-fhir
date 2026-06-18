/**
 * chargeitem.ts — FHIR R4 ChargeItem from the Epic EHI export.
 *
 * Domain "billing". Owns: ChargeItem.
 *
 * Source: Professional Billing (PB) ledger `ARPB_TRANSACTIONS` (ETR master),
 * filtered to TX_TYPE_C_NAME='Charge' (29 rows in this specimen). One charge line =
 * one ChargeItem (CPT + amount + quantity + billing context). See design/chargeitem.md,
 * coverage-and-billing.md, general-patterns.md.
 *
 * FIELD SOURCES
 *   id                 id.chargeItem(TX_ID)  → "chg-<TX_ID>"
 *   identifier[ETR]    ARPB_TRANSACTIONS.TX_ID under the Epic ETR (PB transaction) OID
 *   status             derived: VOID_DATE non-null → "entered-in-error"; else "billable".
 *                      No native Epic column maps to ChargeItemStatus ([status] gap).
 *   code               (1) transmitted CPT/HCPCS from CL_RMT_SVCE_LN_INF.PROC_IDENTIFIER
 *                          ("HC:99213:95" → code 99213, system AMA CPT). 29/29 resolve.
 *                      (2) Epic internal proc PROC_ID under the Epic EAP OID,
 *                          display = CLARITY_EAP.PROC_NAME.
 *                      text = PROC_NAME (+ " [mod 95]" suffix when transmitted CPT modifiers
 *                          exist on the 835 identifier, since R4 Coding has no modifier slot;
 *                          ledger MODIFIER_* columns are NOT used — they mix in Epic-internal
 *                          flags like "MCP" that are not CPT modifiers).
 *   subject            patientRef() (display derived from PATIENT.PAT_NAME, never hardcoded).
 *   context            PAT_ENC_CSN_ID → id.encounter(CSN). 29/29 resolve to built Encounters.
 *   occurrenceDateTime SERVICE_DATE, date-only (source carries a 12:00:00 AM midnight sentinel;
 *                      FHIR dateTime with a time needs a timezone, which we don't have).
 *   quantity           PROCEDURE_QUANTITY (unitless count).
 *   priceOverride      AMOUNT → Money{value, currency:"USD"}. All charges are DEBIT_CREDIT='Debit'
 *                      (positive). This is the *charged* amount, not a true list-price override
 *                      (no list-price column ships) — documented best-fit ([coding] gap).
 *   performer.actor    SERV_PROVIDER_ID → id.practitioner(PROV_ID). All resolve to built
 *                      Practitioners. performer.function omitted (no role code in EHI).
 *   performingOrganization / costCenter
 *                      SERVICE_AREA_ID (18) → id.organization(18), a built Organization.
 *   enteredDate        POST_DATE (ledger post date), date-only.
 *   account            ACCOUNT_ID → id.account(ACCOUNT_ID). Account IS built (src/account.ts /
 *                      out/Account.json); 29/29 charges carry ACCOUNT_ID, all resolve.
 *   reason             PRIMARY_DX_ID → CLARITY_EDG.DX_NAME (text/display only). 29/29 resolve.
 *                      ICD-10 code is NOT traceable per-charge (CLM_DX keys on claim-image
 *                      RECORD_ID with no DX_ID link) → [coding] gap.
 *
 * DELIBERATELY OMITTED (no traceable / resolvable source)
 *   enterer  — USER_ID is an EMP user with no Practitioner/PractitionerRole minted → would dangle.
 *   definitionUri/Canonical, partOf, factorOverride, overrideReason, service, product[x],
 *   supportingInformation, bodysite, note — not in EHI / no resolvable target.
 *
 * Everything in the EHI is TEXT (general-patterns §17): CAST before numeric ORDER BY.
 */
import { q } from "../lib/db";
import { isoDate as dateOnly } from "../lib/time";
import { emit, clean } from "../lib/gen";
import { ident } from "../lib/cc";
import { id, ref, patientRef, epicOid, SYS } from "../lib/ids";
import { nn, money } from "../lib/fmt";

// Published / standard systems we can legitimately assert.
const SYS_CPT = "http://www.ama-assn.org/go/cpt"; // CPT/HCPCS (HC qualifier on the 835 line)

// Epic instance master-file OIDs (org-instance node centralized in lib/ids; same convention
// every other domain generator here uses for Epic master-file ids).
const OID_ETR = SYS.ETR;                       // PB transaction (ETR) id — CHILD of HSP_ACCT (DNM #8)
const OID_EAP = epicOid("2.7.2.696580");       // EAP procedure master id


/** Quantity count from a TEXT decimal; undefined if not numeric. */
function qty(v: unknown): { value: number } | undefined {
  const s = nn(v);
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) return undefined;
  return { value: n };
}

/**
 * The transmitted CPT/HCPCS for a PB charge from the 835 service line.
 * PROC_IDENTIFIER = "HC:<code>" or "HC:<code>:<mod>". Returns { code, modifiers[] }.
 * The account-scoped remit table can reference other members' TXs, but we join FROM our
 * patient's charges, so only this charge's lines are read. Multiple lines may repeat the
 * same identifier — we take the first distinct code.
 */
function transmittedCpt(txId: string): { code: string; modifiers: string[] } | undefined {
  const rows = q<{ PROC_IDENTIFIER: string }>(
    `SELECT PROC_IDENTIFIER FROM CL_RMT_SVCE_LN_INF
      WHERE SVC_LINE_CHG_PB_ID = ? AND PROC_IDENTIFIER IS NOT NULL
      ORDER BY CAST(LINE AS INTEGER)`,
    txId
  );
  for (const r of rows) {
    const raw = nn(r.PROC_IDENTIFIER);
    if (!raw) continue;
    const parts = raw.split(":");
    // ["HC", code, mod?, mod?...] — drop the qualifier, first segment is the code.
    if (parts.length < 2) continue;
    const code = nn(parts[1]);
    if (!code) continue;
    const modifiers = parts.slice(2).map((m) => m.trim()).filter(Boolean);
    return { code, modifiers };
  }
  return undefined;
}

function buildChargeItems(): any[] {
  const out: any[] = [];

  const rows = q<any>(
    `SELECT TX_ID, PROC_ID, SERVICE_DATE, POST_DATE, VOID_DATE,
            PROCEDURE_QUANTITY, AMOUNT, DEBIT_CREDIT_FLAG_NAME,
            SERV_PROVIDER_ID, SERVICE_AREA_ID, PAT_ENC_CSN_ID,
            ACCOUNT_ID, PRIMARY_DX_ID
       FROM ARPB_TRANSACTIONS
      WHERE TX_TYPE_C_NAME = 'Charge'
      ORDER BY CAST(TX_ID AS INTEGER)`
  );

  for (const c of rows) {
    const txId = nn(c.TX_ID);
    if (!txId) continue;

    // --- status: void → entered-in-error; else billable (mapping decision, [status] gap).
    const status = nn(c.VOID_DATE) ? "entered-in-error" : "billable";

    // --- code: CPT coding (transmitted) + Epic internal proc coding; text = PROC_NAME.
    const procId = nn(c.PROC_ID);
    const procName = procId
      ? nn(q<{ PROC_NAME: string }>(`SELECT PROC_NAME FROM CLARITY_EAP WHERE PROC_ID = ?`, procId)[0]?.PROC_NAME)
      : undefined;

    const cpt = transmittedCpt(txId);

    // As-billed modifiers: use ONLY the transmitted CPT modifiers from the 835 service line.
    // The ledger MODIFIER_ONE..FOUR columns are NOT a reliable as-billed CPT-modifier source:
    // they also carry Epic-internal charge flags (e.g. "MCP", a posting/coverage flag that is
    // never a CPT/HCPCS modifier and is never transmitted on the claim — SUBM_PROC_IDENT is null
    // for every such row). Every genuine CPT modifier here (25, 95) is already present on the
    // transmitted identifier, so the transmitted list is both correct and complete.
    const modifiers = cpt?.modifiers ?? [];

    const coding: any[] = [];
    if (cpt) {
      coding.push({ system: SYS_CPT, code: cpt.code });
    }
    if (procId) {
      coding.push({ system: OID_EAP, code: procId, display: procName });
    }
    // text: PROC_NAME, with as-billed modifiers appended (R4 Coding has no modifier slot).
    const text =
      procName && modifiers.length
        ? `${procName} [mod ${modifiers.join(", ")}]`
        : procName ?? (modifiers.length ? `[mod ${modifiers.join(", ")}]` : undefined);

    const code = clean({ coding: coding.length ? coding : undefined, text });

    // --- subject (required).
    const subject = patientRef();

    // --- context: Encounter (built).
    const csn = nn(c.PAT_ENC_CSN_ID);
    const context = csn ? ref("Encounter", id.encounter(csn)) : undefined;

    // --- performer.actor: serving provider (built Practitioner).
    const provId = nn(c.SERV_PROVIDER_ID);
    const performer = provId
      ? [{ actor: ref("Practitioner", id.practitioner(provId)) }]
      : undefined;

    // --- performingOrganization / costCenter: service area (built Organization).
    const areaId = nn(c.SERVICE_AREA_ID);
    const orgRef = areaId ? ref("Organization", id.organization(areaId)) : undefined;

    // --- account: guarantor/HAR account (built — src/account.ts / out/Account.json).
    const acctId = nn(c.ACCOUNT_ID);
    const account = acctId ? [ref("Account", id.account(acctId))] : undefined;

    // --- reason: primary dx name (text/display only; ICD-10 not traceable per-charge → gap).
    const dxId = nn(c.PRIMARY_DX_ID);
    const dxName = dxId
      ? nn(q<{ DX_NAME: string }>(`SELECT DX_NAME FROM CLARITY_EDG WHERE DX_ID = ?`, dxId)[0]?.DX_NAME)
      : undefined;
    const reason = dxName ? [{ text: dxName }] : undefined;

    out.push(
      clean({
        resourceType: "ChargeItem",
        id: id.chargeItem(txId),
        identifier: [ident(OID_ETR, txId)],
        status,
        code,
        subject: { reference: subject.reference, display: subject.display },
        context,
        occurrenceDateTime: dateOnly(c.SERVICE_DATE),
        performer,
        performingOrganization: orgRef,
        costCenter: orgRef,
        quantity: qty(c.PROCEDURE_QUANTITY),
        priceOverride: money(c.AMOUNT),
        enteredDate: dateOnly(c.POST_DATE),
        account,
        reason,
      })
    );
  }

  return out;
}

emit("ChargeItem", buildChargeItems());
