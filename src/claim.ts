/**
 * claim.ts — EHI → FHIR R4 Claim (Professional Billing claims).
 *
 * Domain "claim" (group: billing). Owns: Claim. There is NO reference target —
 * QA is the official FHIR R4 validator + adversarial review. See design/claim.md
 * and coverage-and-billing.md.
 *
 * GRAIN: one Claim per INVOICE record (INVOICE.INVOICE_ID, 21 in this specimen).
 * INV_BASIC_INFO(INV_ID, LINE) holds the submission runs of an invoice (each its own
 * L-number INV_NUM + adjudication status). The charge-line bridge INV_TX_PIECES is keyed
 * by INV_ID (the invoice record), not by run, so the invoice record is the level at which
 * items / provider / coverage / dates resolve consistently. Run history folds into the Claim.
 *
 * CLAIM-IMAGE LINK: the transmitted 837 image is keyed by CLM_VALUE_RECORD.RECORD_ID and
 * joined to a run via CLM_VALUES.INV_NUM = INV_BASIC_INFO.INV_NUM. When an image exists we
 * read real CPT/HCPCS (SVC_LN_INFO.LN_PROC_CD), CPT modifiers (LN_PROC_MOD), ICD-10 dx
 * (CLM_DX.CLM_DX) and the line→dx pointer (LN_DX_PTR). Image-less invoices fall back to the
 * charge ledger: Epic PROC_NAME text (no CPT column in CLARITY_EAP) + INV_DX_INFO dx text
 * (no ICD column in CLARITY_EDG) — codes for those live only in the image (recorded as gaps).
 *
 * FIELD SOURCES (see design/claim.md for the full table)
 *   id            id.claim(INVOICE_ID)
 *   identifier    one per run INV_NUM (Epic L-number) + the INVOICE_ID; under project-local
 *                 namespace URIs (the true INV master-file OID is not derivable from this
 *                 export — see gaps/claim.md), values are real and traceable
 *   status        active; cancelled when the latest run INV_STATUS_C_NAME='Voided' (derived)
 *   type          CLM_VALUE_RECORD.CLM_TYP_C_NAME (CMS→professional / UB→institutional); default professional
 *   use           constant 'claim' (INV_TYPE_C_NAME='Claim'; no predetermination/preauth) — structural
 *   patient       patientRef() (INVOICE.PAT_ID = this patient; display derived)
 *   billablePeriod INV_BASIC_INFO.FROM_SVC_DATE / TO_SVC_DATE
 *   created       INV_BASIC_INFO.CLM_ACCEPT_DT (earliest run) | FROM_SVC_DATE (required)
 *   insurer       Organization/<id.organization(EPM_ID)> + CLARITY_EPM.PAYOR_NAME
 *   provider      Practitioner/<id.practitioner(INVOICE.PROV_ID)> + CLARITY_SER.PROV_NAME (required)
 *   priority      constant 'normal' (process-priority) — structural
 *   related       run lineage (REPLACED_INV) → related claim L-number identifier
 *   referral      INV_BASIC_INFO.REF_ID → Practitioner + name
 *   facility      Location/<id.location(INVOICE.DEPARTMENT_ID)> + CLARITY_DEP name
 *   careTeam      distinct charge SERV_PROVIDER_ID (+ billing provider) → Practitioner
 *   diagnosis     image CLM_DX (ICD-10 + ABK/ABF type) | fallback INV_DX_INFO→CLARITY_EDG (text)
 *   insurance     sequence 1, focal true, Coverage/<id.coverage(CVG_ID)>
 *   item          image SVC_LN_INFO lines | fallback charge lines (CPT/text, modifiers, money, dates)
 *   total         CLM_VALUES.TTL_CHG_AMT | Σ item.net
 *
 * MONEY: only Charge rows feed item.net/unitPrice/total (payments/adjustments belong to
 * ExplanationOfBenefit). Charges are positive in this ledger; image LN_AMT/TTL_CHG_AMT positive.
 * All Money is {value, currency:"USD"}.
 *
 * Everything in the EHI is TEXT — CAST before ORDER BY/range. Categories ship pre-resolved
 * as *_C_NAME (general-patterns §17, §23).
 */
import { q, q1 } from "../lib/db";
import { isoDate as dateOnly } from "../lib/time";
import { id, ref, patientRef } from "../lib/ids";
import { emit, clean } from "../lib/gen";
import { cc, ident } from "../lib/cc";
import { nn, money } from "../lib/fmt";

// Published code systems we can legitimately assert.
const SYS_CLAIM_TYPE = "http://terminology.hl7.org/CodeSystem/claim-type";
const SYS_PROCESS_PRIORITY = "http://terminology.hl7.org/CodeSystem/processpriority";
const SYS_DIAGNOSIS_TYPE = "http://terminology.hl7.org/CodeSystem/ex-diagnosistype";
const SYS_ICD10CM = "http://hl7.org/fhir/sid/icd-10-cm";
const SYS_CPT = "http://www.ama-assn.org/go/cpt";
const SYS_CPT_MOD = "http://www.ama-assn.org/go/cpt"; // CPT modifiers share the CPT system

// Identifier systems for the INVOICE (INV) master file and its claim-run L-numbers.
// The true Epic INV master-file OID is NOT derivable from this export (the previously
// asserted ...726666 is the BEN benefit-collection master, used by coverageeligibility.ts —
// two distinct master files cannot share one INI). Rather than stamp these correct values
// with a wrong/invented Epic OID, we assert honest project-local namespace URIs. The
// identifier VALUES (INVOICE_ID, INV_NUM L-numbers) are real and traceable. See
// gaps/claim.md ("INV master-file OID not available").
const SYS_INVOICE = "urn:ehi:epic:invoice-id"; // INV invoice record (INVOICE.INVOICE_ID)
const SYS_INV_NUM = "urn:ehi:epic:claim-run-number"; // claim-run L-number (INV_BASIC_INFO.INV_NUM)


const provName = (provId: unknown): string | undefined =>
  nn(provId)
    ? q1<{ PROV_NAME: string }>(`SELECT PROV_NAME FROM CLARITY_SER WHERE PROV_ID = ?`, String(provId))?.PROV_NAME ??
      undefined
    : undefined;

const deptName = (depId: unknown): string | undefined =>
  nn(depId)
    ? q1<{ DEPARTMENT_NAME: string }>(`SELECT DEPARTMENT_NAME FROM CLARITY_DEP WHERE DEPARTMENT_ID = ?`, String(depId))
        ?.DEPARTMENT_NAME ?? undefined
    : undefined;

const procName = (procId: unknown): string | undefined =>
  nn(procId)
    ? q1<{ PROC_NAME: string }>(`SELECT PROC_NAME FROM CLARITY_EAP WHERE PROC_ID = ?`, String(procId))?.PROC_NAME ??
      undefined
    : undefined;

const dxName = (dxId: unknown): string | undefined =>
  nn(dxId)
    ? q1<{ DX_NAME: string }>(`SELECT DX_NAME FROM CLARITY_EDG WHERE DX_ID = ?`, String(dxId))?.DX_NAME ?? undefined
    : undefined;


interface Run {
  LINE: string;
  INV_NUM: string;
  INV_STATUS_C_NAME: string | null;
  CVG_ID: string | null;
  EPM_ID: string | null;
  FROM_SVC_DATE: string | null;
  TO_SVC_DATE: string | null;
  REF_ID: string | null;
  REF_ID_REFERRING_PROV_NAM: string | null;
  CLM_ACCEPT_DT: string | null;
  REPLACED_INV: string | null;
}

function buildClaims(): any[] {
  const out: any[] = [];

  const invoices = q<any>(
    `SELECT INVOICE_ID, PROV_ID, DEPARTMENT_ID
       FROM INVOICE
      ORDER BY CAST(INVOICE_ID AS INTEGER)`
  );

  for (const inv of invoices) {
    const invId = nn(inv.INVOICE_ID);
    if (!invId) continue;

    // --- Submission runs (LINE order). The last run is the current state.
    const runs = q<Run>(
      `SELECT LINE, INV_NUM, INV_STATUS_C_NAME, CVG_ID, EPM_ID, FROM_SVC_DATE, TO_SVC_DATE,
              REF_ID, REF_ID_REFERRING_PROV_NAM, CLM_ACCEPT_DT, REPLACED_INV
         FROM INV_BASIC_INFO
        WHERE INV_ID = ?
        ORDER BY CAST(LINE AS INTEGER)`,
      invId
    );
    if (!runs.length) continue;
    const latest = runs[runs.length - 1];

    // --- Claim image: the latest run whose INV_NUM has a CLM_VALUES image; else the latest
    //     run with any image; else none. RECORD_ID drives CLM_DX / SVC_LN_INFO / type / total.
    let imageRecordId: string | undefined;
    for (let i = runs.length - 1; i >= 0 && !imageRecordId; i--) {
      const r = q1<{ RECORD_ID: string }>(
        `SELECT RECORD_ID FROM CLM_VALUES WHERE INV_NUM = ?`,
        runs[i].INV_NUM
      );
      if (r?.RECORD_ID) imageRecordId = String(r.RECORD_ID);
    }

    // --- status (derived): cancelled if the current run is Voided, else active.
    const status = /^voided$/i.test(latest.INV_STATUS_C_NAME ?? "") ? "cancelled" : "active";

    // --- type: from the claim image; default professional (PB office charge) when none.
    const type = buildType(imageRecordId);

    // --- created (required): earliest run accept date, else earliest service-from date.
    const created =
      dateOnly(runs.map((r) => r.CLM_ACCEPT_DT).find((d) => nn(d))) ??
      dateOnly(runs.map((r) => r.FROM_SVC_DATE).find((d) => nn(d)));

    // --- billablePeriod (per-invoice service span).
    const bpStart = dateOnly(latest.FROM_SVC_DATE);
    const bpEnd = dateOnly(latest.TO_SVC_DATE);
    const billablePeriod = bpStart || bpEnd ? clean({ start: bpStart, end: bpEnd }) : undefined;

    // --- identifiers: one per run L-number + the invoice-record id.
    const identifier: any[] = [ident(SYS_INVOICE, invId)];
    for (const r of runs) {
      const num = nn(r.INV_NUM);
      if (num) identifier.push({ system: SYS_INV_NUM, value: num });
    }

    // --- insurer (payor).
    const payorId = nn(latest.EPM_ID);
    const payorName = payorId
      ? nn(q1<{ PAYOR_NAME: string }>(`SELECT PAYOR_NAME FROM CLARITY_EPM WHERE PAYOR_ID = ?`, payorId)?.PAYOR_NAME)
      : undefined;
    const insurer = payorId ? ref("Organization", id.organization(payorId), payorName) : undefined;

    // --- provider (required): the billing provider on the invoice.
    const billProvId = nn(inv.PROV_ID);
    const provider = billProvId
      ? ref("Practitioner", id.practitioner(billProvId), provName(billProvId))
      : undefined;

    // --- referral: OMITTED. FHIR Claim.referral is Reference(ServiceRequest), but the
    // EHI carries only a referring *provider* (INV_BASIC_INFO.REF_ID → Practitioner), and
    // there is no ServiceRequest to point at. A Practitioner reference here is invalid
    // (and claim-careteamrole has no "referring" code), so the referring provider is not
    // representable on Claim — see gaps/claim.md ([reference] gap).

    // --- facility (service department/location).
    const depId = nn(inv.DEPARTMENT_ID);
    const facility = depId ? ref("Location", id.location(depId), deptName(depId)) : undefined;

    // --- related: claim it replaced (resubmission lineage), by L-number identifier.
    const related: any[] = [];
    for (const r of runs) {
      const repl = nn(r.REPLACED_INV);
      if (repl) {
        related.push({ claim: { identifier: ident(SYS_INV_NUM, repl) } });
      }
    }

    // --- careTeam: distinct charge service providers (+ billing provider), 1-indexed.
    const { careTeam, ctSeqByProv } = buildCareTeam(invId, billProvId);

    // --- diagnosis: image ICD-10 (ABK/ABF) or fallback INV_DX_INFO text.
    const { diagnosis, dxSeqByImageLine } = buildDiagnosis(invId, imageRecordId);

    // --- insurance (required): the primary coverage, focal.
    const cvgId = nn(latest.CVG_ID);
    const insurance = cvgId
      ? [{ sequence: 1, focal: true, coverage: ref("Coverage", id.coverage(cvgId)) }]
      : [{ sequence: 1, focal: true, coverage: { display: "Coverage not recorded" } }];

    // --- items: image service lines if present, else the charge ledger.
    const items = imageRecordId
      ? buildImageItems(imageRecordId, depId, dxSeqByImageLine)
      : buildChargeItems(invId, depId, ctSeqByProv);

    // --- total: image TTL_CHG_AMT, else Σ item.net.
    let total = imageRecordId
      ? money(q1<{ TTL_CHG_AMT: string }>(`SELECT TTL_CHG_AMT FROM CLM_VALUES WHERE RECORD_ID = ?`, imageRecordId)?.TTL_CHG_AMT)
      : undefined;
    if (!total) {
      const sum = items.reduce((acc, it) => acc + (it.net?.value ?? 0), 0);
      if (sum > 0) total = money(sum, { round: true });
    }

    out.push(
      clean({
        resourceType: "Claim",
        id: id.claim(invId),
        identifier,
        status,
        type,
        use: "claim",
        patient: patientRef(),
        billablePeriod,
        created,
        insurer,
        provider,
        priority: cc(SYS_PROCESS_PRIORITY, "normal", "Normal", null),
        related: related.length ? related : undefined,
        facility,
        careTeam: careTeam.length ? careTeam : undefined,
        diagnosis: diagnosis.length ? diagnosis : undefined,
        insurance,
        item: items.length ? items : undefined,
        total,
      })
    );
  }

  return out;
}

/** Claim.type from the image CLM_TYP_C_NAME; default professional (PB). */
function buildType(imageRecordId: string | undefined): any {
  let code = "professional";
  if (imageRecordId) {
    const t = nn(
      q1<{ CLM_TYP_C_NAME: string }>(
        `SELECT CLM_TYP_C_NAME FROM CLM_VALUE_RECORD WHERE RECORD_ID = ?`,
        imageRecordId
      )?.CLM_TYP_C_NAME
    );
    if (t && /^ub/i.test(t)) code = "institutional";
    else if (t && /^cms/i.test(t)) code = "professional";
  }
  return cc(SYS_CLAIM_TYPE, code, code === "institutional" ? "Institutional" : "Professional", null);
}

/** careTeam from distinct charge service providers + the billing provider. */
function buildCareTeam(invId: string, billProvId: string | undefined) {
  const provIds: string[] = [];
  const seen = new Set<string>();
  const add = (p: string | undefined) => {
    const id0 = nn(p);
    if (id0 && !seen.has(id0)) {
      seen.add(id0);
      provIds.push(id0);
    }
  };
  add(billProvId);
  const rows = q<{ SERV_PROVIDER_ID: string }>(
    `SELECT DISTINCT t.SERV_PROVIDER_ID
       FROM INV_TX_PIECES p
       JOIN ARPB_TRANSACTIONS t ON t.TX_ID = p.TX_ID
      WHERE p.INV_ID = ? AND t.TX_TYPE_C_NAME = 'Charge' AND t.SERV_PROVIDER_ID IS NOT NULL
      ORDER BY CAST(t.SERV_PROVIDER_ID AS INTEGER)`,
    invId
  );
  for (const r of rows) add(r.SERV_PROVIDER_ID);

  const ctSeqByProv = new Map<string, number>();
  const careTeam = provIds.map((pid, i) => {
    const seq = i + 1;
    ctSeqByProv.set(pid, seq);
    return clean({
      sequence: seq,
      provider: ref("Practitioner", id.practitioner(pid), provName(pid)),
    });
  });
  return { careTeam, ctSeqByProv };
}

/**
 * diagnosis[]: image path = CLM_DX (real ICD-10, ABK principal / ABF other);
 * fallback = INV_DX_INFO → CLARITY_EDG.DX_NAME (text only, no ICD code in export).
 * Returns a map image-line-no → claim diagnosis sequence (CLM_DX.LINE is the dx ordinal
 * that LN_DX_PTR points at).
 */
function buildDiagnosis(invId: string, imageRecordId: string | undefined) {
  const diagnosis: any[] = [];
  const dxSeqByImageLine = new Map<string, number>();

  if (imageRecordId) {
    const rows = q<{ LINE: string; CLM_DX_QUAL: string; CLM_DX: string }>(
      `SELECT LINE, CLM_DX_QUAL, CLM_DX FROM CLM_DX WHERE RECORD_ID = ? ORDER BY CAST(LINE AS INTEGER)`,
      imageRecordId
    );
    let seq = 0;
    for (const r of rows) {
      const code = nn(r.CLM_DX);
      if (!code) continue;
      seq += 1;
      dxSeqByImageLine.set(String(r.LINE), seq);
      // ABK = principal, ABF = other (HL7 ex-diagnosistype). Quals other than these are dropped.
      const qual = nn(r.CLM_DX_QUAL);
      const dtype =
        qual === "ABK"
          ? cc(SYS_DIAGNOSIS_TYPE, "principal", "Principal Diagnosis", null)
          : undefined;
      diagnosis.push(
        clean({
          sequence: seq,
          diagnosisCodeableConcept: cc(SYS_ICD10CM, code, undefined, null),
          type: dtype ? [dtype] : undefined,
        })
      );
    }
    if (diagnosis.length) return { diagnosis, dxSeqByImageLine };
  }

  // Fallback: invoice-level diagnoses (text only — no ICD code in the export).
  const rows = q<{ LINE: string; DX_ID: string }>(
    `SELECT LINE, DX_ID FROM INV_DX_INFO WHERE INVOICE_ID = ? ORDER BY CAST(LINE AS INTEGER)`,
    invId
  );
  let seq = 0;
  const seenDx = new Set<string>();
  for (const r of rows) {
    const dxId = nn(r.DX_ID);
    if (!dxId || seenDx.has(dxId)) continue;
    const name = dxName(dxId);
    if (!name) continue;
    seenDx.add(dxId);
    seq += 1;
    diagnosis.push(
      clean({
        sequence: seq,
        diagnosisCodeableConcept: { text: name },
      })
    );
  }
  return { diagnosis, dxSeqByImageLine };
}

/** item[] from the 837 service lines (real CPT/HCPCS + modifiers + money + dx pointers). */
function buildImageItems(
  imageRecordId: string,
  depId: string | undefined,
  dxSeqByImageLine: Map<string, number>
): any[] {
  const rows = q<any>(
    `SELECT LINE, LN_FROM_DT, LN_TO_DT, LN_PROC_CD, LN_PROC_DESC, LN_PROC_MOD,
            LN_QTY, LN_AMT, LN_POS_CD, LN_DX_PTR
       FROM SVC_LN_INFO WHERE RECORD_ID = ? ORDER BY CAST(LINE AS INTEGER)`,
    imageRecordId
  );
  const facilityRef = depId ? ref("Location", id.location(depId), deptName(depId)) : undefined;

  return rows.map((r, idx) => {
    const cpt = nn(r.LN_PROC_CD);
    const desc = nn(r.LN_PROC_DESC);
    const productOrService = cpt
      ? cc(SYS_CPT, cpt, desc, desc)
      : desc
      ? { text: desc }
      : { text: "Service line" };

    const mod = nn(r.LN_PROC_MOD);
    const modifier = mod ? [cc(SYS_CPT_MOD, mod, undefined, null)] : undefined;

    const from = dateOnly(r.LN_FROM_DT);
    const to = dateOnly(r.LN_TO_DT);
    const serviced =
      from && to && from !== to
        ? { servicedPeriod: { start: from, end: to } }
        : from
        ? { servicedDate: from }
        : {};

    const qtyN = nn(r.LN_QTY) !== undefined ? Number(r.LN_QTY) : undefined;
    const quantity = qtyN !== undefined && isFinite(qtyN) ? { value: qtyN } : undefined;
    const net = money(r.LN_AMT);

    // LN_DX_PTR like "1,2,3" → claim diagnosis sequences via CLM_DX.LINE map.
    const diagnosisSequence: number[] = [];
    for (const p of String(r.LN_DX_PTR ?? "").split(",")) {
      const seq = dxSeqByImageLine.get(p.trim());
      if (seq && !diagnosisSequence.includes(seq)) diagnosisSequence.push(seq);
    }

    return clean({
      sequence: idx + 1,
      diagnosisSequence: diagnosisSequence.length ? diagnosisSequence : undefined,
      productOrService,
      modifier,
      ...serviced,
      locationReference: facilityRef,
      quantity,
      unitPrice: net,
      net,
    });
  });
}

/** item[] from the charge ledger (Epic PROC_NAME text; no CPT in export → gap). */
function buildChargeItems(
  invId: string,
  depId: string | undefined,
  ctSeqByProv: Map<string, number>
): any[] {
  const rows = q<any>(
    `SELECT p.LINE AS PIECE_LINE, t.TX_ID, t.PROC_ID, t.SERVICE_DATE, t.AMOUNT,
            t.PROCEDURE_QUANTITY, t.MODIFIER_ONE, t.MODIFIER_TWO, t.MODIFIER_THREE, t.MODIFIER_FOUR,
            t.SERV_PROVIDER_ID, t.PAT_ENC_CSN_ID, t.DEPARTMENT_ID
       FROM INV_TX_PIECES p
       JOIN ARPB_TRANSACTIONS t ON t.TX_ID = p.TX_ID
      WHERE p.INV_ID = ? AND t.TX_TYPE_C_NAME = 'Charge'
      ORDER BY CAST(p.LINE AS INTEGER), CAST(p.TX_PIECE AS INTEGER)`,
    invId
  );

  return rows.map((r, idx) => {
    const name = procName(r.PROC_ID);
    // No CPT column in CLARITY_EAP — text only (code-not-in-export, see gaps/claim.md).
    const productOrService = name ? { text: name } : { text: "Charge" };

    // Charge-ledger modifiers (MODIFIER_ONE..FOUR) mix true CPT/HCPCS modifiers (e.g. "25",
    // "95") with Epic-internal billing modifiers (e.g. "MCP") that are NOT CPT codes. We can't
    // tell them apart deterministically, so we emit them as text only — asserting the CPT
    // system here would risk a false-presence coding (see gaps/claim.md). The image path
    // (837 LN_PROC_MOD) carries true claim modifiers and IS coded under CPT.
    const modifier = [r.MODIFIER_ONE, r.MODIFIER_TWO, r.MODIFIER_THREE, r.MODIFIER_FOUR]
      .map((m) => nn(m))
      .filter((m): m is string => m !== undefined)
      .map((code) => ({ text: code }));

    const date = dateOnly(r.SERVICE_DATE);
    const qtyN = nn(r.PROCEDURE_QUANTITY) !== undefined ? Number(r.PROCEDURE_QUANTITY) : undefined;
    const quantity = qtyN !== undefined && isFinite(qtyN) ? { value: qtyN } : undefined;
    const net = money(r.AMOUNT);

    const provId = nn(r.SERV_PROVIDER_ID);
    const ctSeq = provId ? ctSeqByProv.get(provId) : undefined;

    const csn = nn(r.PAT_ENC_CSN_ID);
    const encounter = csn ? [ref("Encounter", id.encounter(csn))] : undefined;

    const lineDep = nn(r.DEPARTMENT_ID) ?? depId;
    const locationReference = lineDep ? ref("Location", id.location(lineDep), deptName(lineDep)) : undefined;

    return clean({
      sequence: idx + 1,
      careTeamSequence: ctSeq ? [ctSeq] : undefined,
      productOrService,
      modifier: modifier.length ? modifier : undefined,
      servicedDate: date,
      locationReference,
      quantity,
      unitPrice: net,
      net,
      encounter,
    });
  });
}

emit("Claim", buildClaims());
