/**
 * eob.ts — FHIR R4 ExplanationOfBenefit from the Epic EHI export.
 *
 * Domain "eob". Owns: ExplanationOfBenefit. No reference target in fhir-target/;
 * spec is FHIR R4 + the EHI data + design/eob.md. QA = HL7 validator.
 *
 * GRAIN: one EOB per in-export adjudicated claim submission (INVOICE_NUM / L-number)
 * whose matched charge resolves in THIS patient's ARPB_TRANSACTIONS ledger. 74 EOB
 * matched-charge TXs exist but only 29 (across 18 L-numbers) resolve in-export; the
 * rest belong to another guarantor-account member outside this export (coverage-and-
 * billing gotcha 4). We only emit claims whose items we can fully describe.
 *
 * FIELD SOURCES
 *   id              id.explanationOfBenefit(INVOICE_NUM) -> eob-L1002834030
 *   identifier      INVOICE_NUM (Epic invoice OID) + payer ICN (PMT_EOB_INFO_I.ICN)
 *   status          INV_BASIC_INFO.INV_STATUS_C_NAME: Voided->cancelled, else active
 *   type            constant "professional" (PB / ARPB charges) — FHIR claim-type enum
 *   use             constant "claim" — adjudicated post-service claim, FHIR enum
 *   patient         patientRef() (display derived from PATIENT.PAT_NAME)
 *   created         INV_BASIC_INFO.CLM_ACCEPT_DT, fallback MIN(PMT_EOB_INFO_I.TX_MATCH_DATE)
 *   insurer         Organization/org-<EPM_ID/PAYOR_ID> via id.organization; display CLARITY_EPM.PAYOR_NAME
 *   provider        Practitioner/prac-<SERV_PROVIDER_ID> (1st charge); display CLARITY_SER.PROV_NAME
 *   outcome         constant "complete" — every built instance has a posted 835 line
 *   insurance       focal=true, Coverage/cov-<COVERAGE_ID> via id.coverage
 *   billablePeriod  MIN/MAX ARPB_TRANSACTIONS.SERVICE_DATE across the claim's charges
 *   careTeam        the serving Practitioner(s), sequenced; item.careTeamSequence links
 *   diagnosis       CLM_DX (837-transmitted ICD-10) via INV_BASIC_INFO.CLM_EXT_VAL_ID
 *   item            one per in-export matched charge (PEOB_MTCH_CHG_TX_ID)
 *     productOrService  CPT/HCPCS from CL_RMT_SVCE_LN_INF.PROC_IDENTIFIER (HC:99395)
 *     modifier          modifier tail of PROC_IDENTIFIER (HC:99213:25 -> 25)
 *     servicedDate      ARPB_TRANSACTIONS.SERVICE_DATE
 *     quantity          ARPB_TRANSACTIONS.PROCEDURE_QUANTITY
 *     unitPrice/net     ARPB_TRANSACTIONS.AMOUNT (charge, positive)
 *     encounter         Encounter/enc-<PAT_ENC_CSN_ID>
 *     adjudication      PMT_EOB_INFO_I summed across the charge's payment line(s):
 *                       submitted=AMOUNT, eligible=CVD_AMT, benefit=PAID_AMT,
 *                       deductible=DED_AMT, copay=COPAY_AMT, coinsurance=COINS_AMT,
 *                       noncovered=NONCVD_AMT
 *   total           claim rollups: submitted, eligible, benefit
 *   payment.amount  Σ PMT_EOB_INFO_I.PAID_AMT for the claim
 *   processNote     CARC text from PMT_EOB_INFO_II (claim-level; see gaps for why not per-item)
 *
 * GAPS (gaps/eob.md): claim back-reference (no Claim generated), item.diagnosisSequence
 * (DX_ID->ICD-10 crosswalk absent so charge DX cannot be keyed to CLM_DX codes), per-item
 * CARC reason on multi-charge claims (II.LINE != I.LINE), Epic claim-subtype terminology.
 *
 * Everything in the EHI is TEXT (general-patterns §17) — CAST before ORDER/MIN/MAX.
 */
import { q, q1, parseEpicDateTime } from "../lib/db";
import { emit, clean } from "../lib/gen";
import { id, ref, patientRef } from "../lib/ids";

const SYS_CLAIM_TYPE = "http://terminology.hl7.org/CodeSystem/claim-type";
const SYS_ADJUDICATION = "http://terminology.hl7.org/CodeSystem/adjudication";
const SYS_CPT = "http://www.ama-assn.org/go/cpt";
const SYS_CARETEAM_ROLE = "http://terminology.hl7.org/CodeSystem/claimcareteamrole";
const SYS_DIAG_TYPE = "http://terminology.hl7.org/CodeSystem/ex-diagnosistype";
const SYS_ICD10 = "http://hl7.org/fhir/sid/icd-10-cm";
const SYS_CARC = "https://x12.org/codes/claim-adjustment-reason-codes";
const SYS_PAYER_ID = "http://open.epic.com/FHIR/StructureDefinition/payer-id";

// Epic instance master-file OIDs (instance prefix 1.2.840.114350.1.13.283; same
// convention coverage.ts uses for Epic master-file ids).
const OID_INVOICE = "urn:oid:1.2.840.114350.1.13.283.2.7.3.689224"; // hospital/professional account invoice
const SYS_ICN = "http://open.epic.com/FHIR/StructureDefinition/payer-claim-control-number";

function nn(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

/** Parse a decimal string into a number, or undefined if not a finite number. */
function num(v: unknown): number | undefined {
  const s = nn(v);
  if (s === undefined) return undefined;
  const n = Number(s);
  return isFinite(n) ? n : undefined;
}

/** FHIR Money from a number (rounded to cents), USD. */
function money(n: number | undefined): any {
  if (n === undefined) return undefined;
  return { value: Math.round(n * 100) / 100, currency: "USD" };
}

function dateOnly(v: unknown): string | undefined {
  return parseEpicDateTime(v)?.slice(0, 10);
}

type Bucket = {
  submitted?: number; // charge amount
  eligible?: number; // CVD_AMT
  benefit?: number; // PAID_AMT
  deductible?: number; // DED_AMT
  copay?: number; // COPAY_AMT
  coinsurance?: number; // COINS_AMT
  noncovered?: number; // NONCVD_AMT
};

function addBucket(b: Bucket, k: keyof Bucket, v: number | undefined) {
  if (v === undefined) return;
  b[k] = (b[k] ?? 0) + v;
}

// adjudication category, in emission order. `code` is a published HL7
// `adjudication` CodeSystem code; entries with `code: undefined` are not in that
// CodeSystem and are represented by `category.text` only (extensible binding —
// asserting an unknown code in the published system is a validator error).
const ADJ_CATS: { key: keyof Bucket; code?: string; display: string }[] = [
  { key: "submitted", code: "submitted", display: "Submitted Amount" },
  { key: "eligible", code: "eligible", display: "Eligible Amount" },
  { key: "deductible", code: "deductible", display: "Deductible" },
  { key: "copay", code: "copay", display: "CoPay" },
  { key: "coinsurance", display: "Co-insurance Amount" }, // not in HL7 adjudication CS -> text only
  { key: "noncovered", display: "Noncovered Amount" }, // not in HL7 adjudication CS -> text only
  { key: "benefit", code: "benefit", display: "Benefit Amount" },
];

function adjCategory(c: { code?: string; display: string }): any {
  return c.code
    ? { coding: [{ system: SYS_ADJUDICATION, code: c.code, display: c.display }], text: c.display }
    : { text: c.display };
}

function adjudicationFrom(b: Bucket): any[] {
  const out: any[] = [];
  for (const c of ADJ_CATS) {
    if (b[c.key] === undefined) continue;
    out.push({ category: adjCategory(c), amount: money(b[c.key]) });
  }
  return out;
}

function buildEobs(): any[] {
  const out: any[] = [];

  // The 18 in-export adjudicated claims, deterministic order.
  const invoices = q<{ INVOICE_NUM: string }>(
    `SELECT DISTINCT i.INVOICE_NUM AS INVOICE_NUM
       FROM PMT_EOB_INFO_I i
       JOIN ARPB_TRANSACTIONS t
         ON t.TX_ID = i.PEOB_MTCH_CHG_TX_ID AND t.TX_TYPE_C_NAME = 'Charge'
      WHERE i.INVOICE_NUM IS NOT NULL
      ORDER BY i.INVOICE_NUM`
  );

  for (const { INVOICE_NUM: invNum } of invoices) {
    // --- claim header (INV_BASIC_INFO).
    const hdr = q1<any>(
      `SELECT INV_NUM, INV_STATUS_C_NAME, CVG_ID, EPM_ID, CLM_ACCEPT_DT, CLM_EXT_VAL_ID
         FROM INV_BASIC_INFO WHERE INV_NUM = ? ORDER BY CAST(LINE AS INTEGER) LIMIT 1`,
      invNum
    );

    // --- the in-export charges on this claim, with their CPT and adjudication.
    const charges = q<any>(
      `SELECT DISTINCT i.PEOB_MTCH_CHG_TX_ID AS CHG_TX_ID
         FROM PMT_EOB_INFO_I i
         JOIN ARPB_TRANSACTIONS t
           ON t.TX_ID = i.PEOB_MTCH_CHG_TX_ID AND t.TX_TYPE_C_NAME = 'Charge'
        WHERE i.INVOICE_NUM = ?
        ORDER BY CAST(i.PEOB_MTCH_CHG_TX_ID AS INTEGER)`,
      invNum
    );
    if (charges.length === 0) continue;

    // careTeam: serving providers across the claim, sequenced in first-seen order.
    const teamSeqByProv = new Map<string, number>();
    const careTeam: any[] = [];

    const items: any[] = [];
    const claimBucket: Bucket = {};
    let claimPaid: number | undefined;
    const serviceDates: string[] = [];
    let headerProvId: string | undefined;
    let headerProvName: string | undefined;
    let coverageId = nn(hdr?.CVG_ID);
    let payorId = nn(hdr?.EPM_ID);
    let icn: string | undefined;

    let itemSeq = 0;
    for (const { CHG_TX_ID: chgTx } of charges) {
      const chg = q1<any>(
        `SELECT TX_ID, SERVICE_DATE, AMOUNT, PROCEDURE_QUANTITY, PROC_ID,
                SERV_PROVIDER_ID, BILLING_PROV_ID, PAYOR_ID, COVERAGE_ID, PAT_ENC_CSN_ID
           FROM ARPB_TRANSACTIONS WHERE TX_ID = ?`,
        chgTx
      );
      if (!chg) continue;

      coverageId = coverageId ?? nn(chg.COVERAGE_ID);
      payorId = payorId ?? nn(chg.PAYOR_ID);

      const provId = nn(chg.SERV_PROVIDER_ID) ?? nn(chg.BILLING_PROV_ID);
      const provName = provId
        ? nn(q1<any>(`SELECT PROV_NAME FROM CLARITY_SER WHERE PROV_ID = ?`, provId)?.PROV_NAME)
        : undefined;
      if (provId && !headerProvId) {
        headerProvId = provId;
        headerProvName = provName;
      }
      let careTeamSeq: number | undefined;
      if (provId) {
        if (!teamSeqByProv.has(provId)) {
          const seq = teamSeqByProv.size + 1;
          teamSeqByProv.set(provId, seq);
          careTeam.push({
            sequence: seq,
            provider: ref("Practitioner", id.practitioner(provId), provName),
            role: {
              coding: [{ system: SYS_CARETEAM_ROLE, code: "primary", display: "Primary provider" }],
            },
          });
        }
        careTeamSeq = teamSeqByProv.get(provId);
      }

      // CPT/HCPCS + modifiers from the 835 service line (HC:99213:25).
      const procIdent = nn(
        q1<any>(
          `SELECT PROC_IDENTIFIER FROM CL_RMT_SVCE_LN_INF WHERE SVC_LINE_CHG_PB_ID = ?
            ORDER BY CAST(LINE AS INTEGER) LIMIT 1`,
          chgTx
        )?.PROC_IDENTIFIER
      );
      const procName = nn(
        q1<any>(`SELECT PROC_NAME FROM CLARITY_EAP WHERE PROC_ID = ?`, nn(chg.PROC_ID))?.PROC_NAME
      );

      let cptCode: string | undefined;
      let modifiers: string[] = [];
      if (procIdent) {
        const parts = procIdent.split(":");
        // parts[0] is the qualifier (HC). code is next, rest are modifiers.
        if (parts.length >= 2) {
          cptCode = nn(parts[1]);
          modifiers = parts.slice(2).map((p) => p.trim()).filter(Boolean);
        }
      }

      const productOrService = cptCode
        ? { coding: [{ system: SYS_CPT, code: cptCode, display: procName }], text: procName }
        : procName
        ? { text: procName }
        : undefined;
      // item.productOrService is required 1..1 — every in-export charge carries PROC_IDENTIFIER.
      if (!productOrService) continue;

      const modifier = modifiers.length
        ? modifiers.map((m) => ({ coding: [{ system: SYS_CPT, code: m }] }))
        : undefined;

      const svcDate = dateOnly(chg.SERVICE_DATE);
      if (svcDate) serviceDates.push(svcDate);

      const qty = num(chg.PROCEDURE_QUANTITY);
      const netAmt = num(chg.AMOUNT);
      const csn = nn(chg.PAT_ENC_CSN_ID);

      // --- adjudication: sum PMT_EOB_INFO_I across this charge's payment line(s).
      const eobLines = q<any>(
        `SELECT CVD_AMT, NONCVD_AMT, DED_AMT, COPAY_AMT, COINS_AMT, PAID_AMT, ICN
           FROM PMT_EOB_INFO_I WHERE PEOB_MTCH_CHG_TX_ID = ? AND INVOICE_NUM = ?`,
        chgTx,
        invNum
      );
      const itemBucket: Bucket = {};
      if (netAmt !== undefined) itemBucket.submitted = netAmt;
      for (const e of eobLines) {
        addBucket(itemBucket, "eligible", num(e.CVD_AMT));
        addBucket(itemBucket, "noncovered", num(e.NONCVD_AMT));
        addBucket(itemBucket, "deductible", num(e.DED_AMT));
        addBucket(itemBucket, "copay", num(e.COPAY_AMT));
        addBucket(itemBucket, "coinsurance", num(e.COINS_AMT));
        addBucket(itemBucket, "benefit", num(e.PAID_AMT));
        const p = num(e.PAID_AMT);
        if (p !== undefined) claimPaid = (claimPaid ?? 0) + p;
        icn = icn ?? nn(e.ICN);
      }
      // roll item buckets into claim totals
      for (const k of Object.keys(itemBucket) as (keyof Bucket)[]) {
        addBucket(claimBucket, k, itemBucket[k]);
      }

      itemSeq += 1;
      items.push(
        clean({
          sequence: itemSeq,
          careTeamSequence: careTeamSeq !== undefined ? [careTeamSeq] : undefined,
          productOrService,
          modifier,
          servicedDate: svcDate,
          quantity: qty !== undefined ? { value: qty } : undefined,
          unitPrice: qty && netAmt !== undefined ? money(netAmt / qty) : undefined,
          net: money(netAmt),
          encounter: csn ? [ref("Encounter", id.encounter(csn))] : undefined,
          adjudication: adjudicationFrom(itemBucket),
        })
      );
    }

    if (items.length === 0) continue;

    // --- status from INV_STATUS_C_NAME.
    const invStatus = nn(hdr?.INV_STATUS_C_NAME);
    const status = invStatus && /voided/i.test(invStatus) ? "cancelled" : "active";

    // --- created: CLM_ACCEPT_DT, fallback earliest remit-match date.
    let created = dateOnly(hdr?.CLM_ACCEPT_DT);
    if (!created) {
      const m = q1<any>(
        `SELECT MIN(TX_MATCH_DATE) AS D FROM PMT_EOB_INFO_I WHERE INVOICE_NUM = ?`,
        invNum
      );
      created = dateOnly(m?.D);
    }
    if (!created) continue; // created is required 1..1

    // --- insurer (payer org).
    const payorName = payorId
      ? nn(q1<any>(`SELECT PAYOR_NAME FROM CLARITY_EPM WHERE PAYOR_ID = ?`, payorId)?.PAYOR_NAME)
      : undefined;
    const insurer = payorId
      ? {
          reference: ref("Organization", id.organization(payorId)).reference,
          identifier: { system: SYS_PAYER_ID, value: payorId },
          display: payorName,
        }
      : undefined;
    if (!insurer) continue; // insurer required 1..1

    // --- provider (claim header level).
    const provider = headerProvId
      ? ref("Practitioner", id.practitioner(headerProvId), headerProvName)
      : undefined;
    if (!provider) continue; // provider required 1..1

    // --- insurance (focal coverage).
    if (!coverageId) continue; // insurance.coverage required
    const insurance = [
      { focal: true, coverage: ref("Coverage", id.coverage(coverageId)) },
    ];

    // --- billablePeriod from service dates.
    let billablePeriod: any | undefined;
    if (serviceDates.length) {
      const sorted = [...serviceDates].sort();
      billablePeriod = { start: sorted[0], end: sorted[sorted.length - 1] };
    }

    // --- diagnosis: 837-transmitted ICD-10 from CLM_DX (via CLM_EXT_VAL_ID).
    const diagnosis: any[] = [];
    const extId = nn(hdr?.CLM_EXT_VAL_ID);
    if (extId) {
      const dxRows = q<any>(
        `SELECT LINE, CLM_DX_QUAL, CLM_DX FROM CLM_DX WHERE RECORD_ID = ?
          ORDER BY CAST(LINE AS INTEGER)`,
        extId
      );
      let dseq = 0;
      for (const d of dxRows) {
        const code = nn(d.CLM_DX);
        if (!code) continue;
        dseq += 1;
        const qual = nn(d.CLM_DX_QUAL);
        // ABK = principal, ABF = other (837 diagnosis qualifiers).
        const dtype =
          qual === "ABK"
            ? { coding: [{ system: SYS_DIAG_TYPE, code: "principal", display: "Principal Diagnosis" }] }
            : undefined;
        diagnosis.push(
          clean({
            sequence: dseq,
            diagnosisCodeableConcept: { coding: [{ system: SYS_ICD10, code }] },
            type: dtype ? [dtype] : undefined,
          })
        );
      }
    }

    // --- claim-level totals.
    const total: any[] = [];
    for (const c of ADJ_CATS) {
      if (c.key === "submitted" || c.key === "eligible" || c.key === "benefit") {
        if (claimBucket[c.key] !== undefined) {
          total.push({ category: adjCategory(c), amount: money(claimBucket[c.key]) });
        }
      }
    }

    // --- payment amount (insurer payment posted by this 835).
    const payment = claimPaid !== undefined ? { amount: money(claimPaid) } : undefined;

    // --- processNote: CARC remit text from PMT_EOB_INFO_II for this claim's payment TXs.
    const noteRows = q<any>(
      `SELECT DISTINCT ii.EOB_CODES, ii.WINNINGRMC_ID_REMIT_CODE_NAME, ii.PEOB_EOB_GRPCODE_C_NAME
         FROM PMT_EOB_INFO_II ii
         JOIN PMT_EOB_INFO_I i ON i.TX_ID = ii.TX_ID
        WHERE i.INVOICE_NUM = ? AND ii.WINNINGRMC_ID_REMIT_CODE_NAME IS NOT NULL`,
      invNum
    );
    const seenNote = new Set<string>();
    const processNote: any[] = [];
    let noteSeq = 0;
    for (const n of noteRows) {
      const text = nn(n.WINNINGRMC_ID_REMIT_CODE_NAME);
      if (!text || seenNote.has(text)) continue;
      seenNote.add(text);
      noteSeq += 1;
      processNote.push(clean({ number: noteSeq, type: "display", text }));
    }

    // --- identifiers.
    const identifier: any[] = [{ system: OID_INVOICE, value: invNum }];
    if (icn) identifier.push({ system: SYS_ICN, value: icn });

    out.push(
      clean({
        resourceType: "ExplanationOfBenefit",
        id: id.explanationOfBenefit(invNum),
        identifier,
        status,
        type: {
          coding: [{ system: SYS_CLAIM_TYPE, code: "professional", display: "Professional" }],
        },
        use: "claim",
        patient: patientRef(),
        billablePeriod,
        created,
        insurer,
        provider,
        outcome: "complete",
        careTeam: careTeam.length ? careTeam : undefined,
        diagnosis: diagnosis.length ? diagnosis : undefined,
        insurance,
        item: items,
        total: total.length ? total : undefined,
        payment,
        processNote: processNote.length ? processNote : undefined,
      })
    );
  }

  return out;
}

emit("ExplanationOfBenefit", buildEobs());
