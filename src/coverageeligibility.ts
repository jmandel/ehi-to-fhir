/**
 * coverageeligibility.ts — FHIR CoverageEligibilityResponse from the Epic EHI export.
 *
 * Domain "billing". Owns: CoverageEligibilityResponse.
 *
 * The export carries the 271 (eligibility-response) side of medical benefit
 * verification as a per-service-type cost-share matrix held in benefit-collection
 * (BEN) records: BENEFITS (spine) + SERVICE_BENEFITS (per service type x network
 * tier) + COVERAGE_BENEFITS (whole-plan deductible / OOP). This is exactly what
 * CoverageEligibilityResponse models (insurance[].item[].benefit[]). See
 * design/coverageeligibility.md and benefits-and-eligibility.md.
 *
 * INSTANCE GRAIN — one resource per BENEFITS (BEN) record. 21 records, all this
 *   patient: 18 encounter snapshots (PAT_ENC_3.BENEFIT_ID → servicedDate),
 *   2 coverage plan-period records (BENEFIT_PERIOD_* → insurance.benefitPeriod),
 *   1 unattached (bare scaffold).
 *
 * FIELD SOURCES
 *   id              id.coverageEligibilityResponse(BENEFITS.RECORD_ID) → celig-<id>
 *   identifier      BENEFITS.RECORD_ID under the Epic BEN master OID
 *   status          constant "active" (structural; RECORD_STATUS_C_NAME NULL throughout)
 *   purpose         constant ["benefits"] (the record reports cost-share benefits)
 *   patient         patientRef() (BENEFITS.PAT_ID; display derived, never hardcoded)
 *   serviced.date   PAT_ENC_3.PAT_ENC_DATE_REAL of the encounter pointing here (dateRealToISO)
 *   created         BENEFITS.RECORD_CREATION_DT (parseEpicDateTime) — required dateTime
 *   request         contained minimal #req CoverageEligibilityRequest scaffold (no 270/271
 *                   request persisted in the export; R4 makes request 1..1) — gap
 *   outcome         constant "complete" (a populated benefit snapshot is a completed query)
 *   disposition     text only when a benefit source flag = "Eligibility Query"
 *   insurer         Organization/<id.organization(COVERAGE.PAYOR_ID)> + display (CLARITY_EPM)
 *   insurance.coverage      Coverage/<id.coverage(5934765)> (every line's CVG_ID/CVG_FOR_SVC_TYPE_ID)
 *   insurance.inforce       true when a benefit source = "Eligibility Query"
 *   insurance.benefitPeriod BENEFITS.BENEFIT_PERIOD_START_DATE (coverage-period records)
 *   insurance.item          per (service type, network tier) from SERVICE_BENEFITS; plus a
 *                           whole-plan item (category.text "Plan") from COVERAGE_BENEFITS
 *   item.category           text from CVG_SVC_TYPE_ID_SERVICE_TYPE_NAME + Epic service-type code
 *   item.network            In→in / Out→out (network-type); N/A → no network element
 *   item.benefit.type       copay / coinsurance / deductible / benefit(OOP) per amount column
 *   benefit.allowedMoney    COPAY / DEDUCTIBLE / OUT_OF_POCKET_MAX → {value, currency:"USD"}
 *   benefit.allowedString   COINS_PERCENT → "<n>%"
 *   benefit.usedMoney       deductible/OOP used = max − remaining (only when both present)
 *
 * GAPS (see gaps/coverageeligibility.md)
 *   - request: no CoverageEligibilityRequest persisted → contained #req scaffold (structure only)
 *   - requestor: no requesting provider/org column on BEN
 *   - item.category standard code: only Epic org-configured service-type names ship (no X12)
 *   - item.excluded / covered-vs-not: EVALUATION_STATUS_C_NAME NULL throughout
 *   - item.unit / term: FAMILY_TIER carried as text only (no source term/unit code)
 *   - Pharmacy RTPB (MED_CVG_*): deliberately out of scope (priced per-drug adjudication)
 *
 * Everything is TEXT in the EHI (general-patterns §17); CAST before ORDER BY/MIN/MAX.
 */
import { q, q1, dateRealToISO, parseEpicDateTime } from "../lib/db";
import { emit, clean } from "../lib/gen";
import { cc } from "../lib/cc";
import { id, ref, patientRef, PATIENT_PAT_ID } from "../lib/ids";
import { nn, money } from "../lib/fmt";

// Published / standard systems we can legitimately assert.
const SYS_NETWORK = "http://terminology.hl7.org/CodeSystem/benefit-network";
const SYS_BENEFIT_TYPE_CODE = "http://terminology.hl7.org/CodeSystem/benefit-type";

// Epic instance master-file OIDs (this instance prefix 1.2.840.114350.1.13.283; same
// convention every other domain generator here uses for Epic master-file ids).
const OID_BENEFITS = "urn:oid:1.2.840.114350.1.13.283.2.7.2.726666"; // BEN benefit-collection record
// Epic service-type (ECD) category code system for this instance (Epic-local, non-OID URI).
const SYS_EPIC_SVC_TYPE = "http://open.epic.com/FHIR/CodeSystem/benefit-service-type";

const COVERAGE_ID = "5934765";


/** Coinsurance percent column → "<n>%" string. */
function percent(v: unknown): string | undefined {
  const s = nn(v);
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!isFinite(n)) return undefined;
  return `${n}%`;
}

/** In/Out → network-type coding (+ text); N/A or unknown → undefined. */
function networkCC(raw: string | undefined): any | undefined {
  if (!raw) return undefined;
  if (/^in$/i.test(raw)) return cc(SYS_NETWORK, "in", "In Network", raw);
  if (/^out$/i.test(raw)) return cc(SYS_NETWORK, "out", "Out of Network", raw);
  return undefined; // "N/A" carries no meaningful network tier
}

// Benefit-type codes that exist in the THO benefit-type CodeSystem (verified against the
// validator). Coinsurance has no code there → text-only CodeableConcept (binding is example).
function benefitType(code: string, display: string): any {
  return cc(SYS_BENEFIT_TYPE_CODE, code, display, null);
}
const COINS_TYPE = { text: "Coinsurance" };
const COPAY_TYPE = benefitType("copay", "Copayment per service");
const DEDUCT_TYPE = benefitType("deductible", "Deductible");
const OOP_TYPE = benefitType("benefit", "Benefit");

function buildResources(): any[] {
  const out: any[] = [];

  // Insurer (payer behind the single coverage) — derived, never hardcoded.
  const payorId = nn(q1<any>(`SELECT PAYOR_ID FROM COVERAGE WHERE COVERAGE_ID = ?`, COVERAGE_ID)?.PAYOR_ID);
  const payorName = payorId
    ? nn(q1<any>(`SELECT PAYOR_NAME FROM CLARITY_EPM WHERE PAYOR_ID = ?`, payorId)?.PAYOR_NAME)
    : undefined;
  const insurer = payorId
    ? { reference: ref("Organization", id.organization(payorId)).reference, display: payorName }
    : undefined;

  // Encounter snapshots: BENEFIT_ID → encounter service date.
  const encByBen = new Map<string, string>(); // BEN record_id → servicedDate (ISO)
  for (const r of q<any>(
    `SELECT BENEFIT_ID, MIN(CAST(PAT_ENC_DATE_REAL AS REAL)) AS DR
       FROM PAT_ENC_3 WHERE BENEFIT_ID IS NOT NULL
      GROUP BY BENEFIT_ID`
  )) {
    const ben = nn(r.BENEFIT_ID);
    const iso = dateRealToISO(r.DR);
    if (ben && iso) encByBen.set(ben, iso);
  }

  const benefits = q<any>(
    `SELECT RECORD_ID, PAT_ID, RECORD_CREATION_DT,
            BENEFIT_PERIOD_COVERAGE_ID, BENEFIT_PERIOD_START_DATE
       FROM BENEFITS
      ORDER BY CAST(RECORD_ID AS INTEGER)`
  );

  for (const b of benefits) {
    const recId = nn(b.RECORD_ID);
    if (!recId) continue;

    // RECORD_CREATION_DT is always midnight (a day, no real time-of-day) → emit date-only
    // (a valid FHIR dateTime; avoids a bogus timezone on a meaningless 00:00:00).
    const created = parseEpicDateTime(b.RECORD_CREATION_DT)?.slice(0, 10);
    const servicedDate = encByBen.get(recId);
    const benefitPeriodStart = parseEpicDateTime(b.BENEFIT_PERIOD_START_DATE)?.slice(0, 10);

    // ---- insurance.item from SERVICE_BENEFITS (sparse matrix; group per service type x tier).
    const svcRows = q<any>(
      `SELECT LINE, CVG_SVC_TYPE_ID, CVG_SVC_TYPE_ID_SERVICE_TYPE_NAME AS SVC_NAME,
              NET_LVL_SVC_C_NAME, COPAY_AMOUNT, COINS_PERCENT,
              DEDUCTIBLE_AMOUNT, OUT_OF_POCKET_MAX,
              BENEFITS_LAST_UPDATE_SRC_C_NAME
         FROM SERVICE_BENEFITS
        WHERE RECORD_ID = ?
        ORDER BY CAST(CVG_SVC_TYPE_ID AS INTEGER), CAST(LINE AS INTEGER)`,
      recId
    );

    // Group amount-bearing lines by (service type, network tier). Each non-NULL amount
    // on a line becomes one benefit; metadata-only lines (no amounts) are dropped.
    type Bucket = { svcId?: string; svcName?: string; net?: string; benefits: any[] };
    const buckets = new Map<string, Bucket>();
    let anyEligSource = false;

    for (const s of svcRows) {
      if (nn(s.BENEFITS_LAST_UPDATE_SRC_C_NAME) === "Eligibility Query") anyEligSource = true;

      const copay = money(s.COPAY_AMOUNT);
      const coins = percent(s.COINS_PERCENT);
      const deduct = money(s.DEDUCTIBLE_AMOUNT);
      const oop = money(s.OUT_OF_POCKET_MAX);
      if (!copay && !coins && !deduct && !oop) continue; // metadata-only line

      const svcId = nn(s.CVG_SVC_TYPE_ID);
      const net = nn(s.NET_LVL_SVC_C_NAME);
      const key = `${svcId ?? ""}|${net ?? ""}`;
      let bk = buckets.get(key);
      if (!bk) {
        bk = { svcId, svcName: nn(s.SVC_NAME), net, benefits: [] };
        buckets.set(key, bk);
      }
      if (copay) bk.benefits.push({ type: COPAY_TYPE, allowedMoney: copay });
      if (coins) bk.benefits.push({ type: COINS_TYPE, allowedString: coins });
      if (deduct) bk.benefits.push({ type: DEDUCT_TYPE, allowedMoney: deduct });
      if (oop) bk.benefits.push({ type: OOP_TYPE, allowedMoney: oop });
    }

    const items: any[] = [];
    for (const bk of buckets.values()) {
      if (!bk.benefits.length) continue;
      const category = bk.svcName
        ? clean({
            coding: bk.svcId
              ? [{ system: SYS_EPIC_SVC_TYPE, code: bk.svcId, display: bk.svcName }]
              : undefined,
            text: bk.svcName,
          })
        : undefined;
      items.push(
        clean({
          category,
          network: networkCC(bk.net),
          benefit: bk.benefits,
        })
      );
    }

    // ---- whole-plan item from COVERAGE_BENEFITS (deductible / OOP-max, with used = max − remaining).
    const cvgRows = q<any>(
      `SELECT LINE, FAMILY_TIER_C_NAME,
              DEDUCTIBLE_AMOUNT, DEDUCT_REMAIN_AMT,
              OUT_OF_POCKET_MAX, OUT_OF_PCKT_REMAIN,
              CVG_UPDATE_SRC_C_NAME, BENEFITS_LAST_UPDATE_SRC_C_NAME
         FROM COVERAGE_BENEFITS
        WHERE RECORD_ID = ?
        ORDER BY CAST(LINE AS INTEGER)`,
      recId
    );

    for (const c of cvgRows) {
      if (
        nn(c.CVG_UPDATE_SRC_C_NAME) === "Eligibility Query" ||
        nn(c.BENEFITS_LAST_UPDATE_SRC_C_NAME) === "Eligibility Query"
      ) {
        anyEligSource = true;
      }
      const deductMax = money(c.DEDUCTIBLE_AMOUNT);
      const deductRemain = money(c.DEDUCT_REMAIN_AMT);
      const oopMax = money(c.OUT_OF_POCKET_MAX);
      const oopRemain = money(c.OUT_OF_PCKT_REMAIN);
      if (!deductMax && !oopMax) continue; // metadata-only / empty plan line

      const benefit: any[] = [];
      if (deductMax) {
        const used =
          deductRemain && deductMax.value >= deductRemain.value
            ? { value: Number((deductMax.value - deductRemain.value).toFixed(2)), currency: "USD" }
            : undefined;
        benefit.push(clean({ type: DEDUCT_TYPE, allowedMoney: deductMax, usedMoney: used }));
      }
      if (oopMax) {
        const used =
          oopRemain && oopMax.value >= oopRemain.value
            ? { value: Number((oopMax.value - oopRemain.value).toFixed(2)), currency: "USD" }
            : undefined;
        benefit.push(clean({ type: OOP_TYPE, allowedMoney: oopMax, usedMoney: used }));
      }
      if (!benefit.length) continue;

      // category.text is a fixed bucket label ("Plan"); FAMILY_TIER carried as text where present.
      const tier = nn(c.FAMILY_TIER_C_NAME);
      const tierText = tier && !/^n\/a$/i.test(tier) ? tier : undefined;
      items.push(
        clean({
          category: { text: "Plan" },
          name: tierText ? `Plan — ${tierText}` : undefined,
          benefit,
        })
      );
    }

    // ---- insurance block (one per BEN record; coverage always resolves to the single coverage).
    const insurance = [
      clean({
        coverage: { reference: ref("Coverage", id.coverage(COVERAGE_ID)).reference },
        inforce: anyEligSource ? true : undefined,
        benefitPeriod: benefitPeriodStart ? { start: benefitPeriodStart } : undefined,
        item: items.length ? items : undefined,
      }),
    ];

    // ---- contained minimal request scaffold (structure only; gap recorded).
    const containedReq = clean({
      resourceType: "CoverageEligibilityRequest",
      id: "req",
      status: "active",
      purpose: ["benefits"],
      patient: { reference: patientRef().reference },
      created: created,
      insurer: insurer ? { reference: insurer.reference } : undefined,
    });

    out.push(
      clean({
        resourceType: "CoverageEligibilityResponse",
        id: id.coverageEligibilityResponse(recId),
        contained: [containedReq],
        identifier: [{ system: OID_BENEFITS, value: recId }],
        status: "active",
        purpose: ["benefits"],
        patient: { reference: patientRef().reference, display: patientRef().display },
        servicedDate: servicedDate,
        created: created,
        request: { reference: "#req" },
        outcome: "complete",
        disposition: anyEligSource
          ? "Benefits returned by real-time eligibility query"
          : undefined,
        insurer: insurer
          ? { reference: insurer.reference, display: insurer.display }
          : undefined,
        insurance,
      })
    );
  }

  return out;
}

emit("CoverageEligibilityResponse", buildResources());
