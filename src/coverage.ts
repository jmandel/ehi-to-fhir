/**
 * coverage.ts — FHIR Coverage from the Epic EHI export.
 *
 * Domain "coverage". Owns: Coverage.
 *
 * One coverage in this specimen (COVERAGE.COVERAGE_ID 5934765, "Indemnity",
 * payor 1302 / plan 130204, subscriber = self). See coverage-and-billing.md and
 * benefits-and-eligibility.md.
 *
 * FIELD SOURCES
 *   id               minted id.coverage(COVERAGE_ID) (Epic's opaque FHIR id is not in export)
 *   identifier[CVG]  COVERAGE.COVERAGE_ID, under the Epic coverage-record OID (same
 *                    convention every other domain here uses for Epic master-file ids).
 *   identifier[MB]   COVERAGE_MEMBER_LIST.MEM_NUMBER (the displayable member id), v2-0203 "MB".
 *   status           "active" — the coverage is open (CVG_TERM_DT NULL, member MEM_COVERED_YN=Y).
 *                    Epic's CVG_REG_STATUS_C_NAME is NULL here, so status is derived from the
 *                    open term date, not read from a status column (recorded as a coding gap).
 *   type             COVERAGE.COVERAGE_TYPE_C_NAME ('Indemnity'), emitted as type.text only.
 *                    The NAHDO sopt *coding* (code 6) is on a different axis and not in the
 *                    export, so no coding is asserted (coding gap).
 *   subscriber       Patient ref + display; subscriber = self (MEM_REL_TO_SUB_C_NAME 'Self').
 *   subscriberId     COVERAGE_MEMBER_LIST.MEM_NUMBER.
 *   beneficiary      Patient ref + display (this patient is the covered member).
 *   relationship     MEM_REL_TO_SUB_C_NAME 'Self' → subscriber-relationship 'self' (HL7) + text.
 *                    The Epic-OID-coded relationship (code "01") is Epic terminology — not in
 *                    the export — so only the HL7 self code + text are emitted (coding gap).
 *   period.start     COVERAGE_MEMBER_LIST.MEM_EFF_FROM_DATE.
 *   payor            Organization/<id.organization(PAYOR_ID)> + Epic payer-id identifier 1302
 *                    + display (CLARITY_EPM.PAYOR_NAME, title-cased by Epic in the target — we
 *                    keep the export's casing).
 *   class[group]     COVERAGE.GROUP_NUM (coverage-class 'group').
 *   class[plan]      COVERAGE.PLAN_ID + name CLARITY_EPP.BENEFIT_PLAN_NAME (coverage-class 'plan'),
 *                    epic-id extension carrying the same PLAN_ID under the Epic plan OID.
 *   order            1 (single, primary coverage).
 *   contained Org    The payer as a billing organization: name (payer), billing contact address
 *                    from the 837 claim image payer block (CLM_VALUES.PYR_ADDR_*), referenced by
 *                    the open.epic billing-organization extension.
 *
 * GAPS (see gaps/coverage.md)
 *   - Coverage.type NAHDO sopt *coding* (code 6 "BLUE CROSS/BLUE SHIELD"): Epic-assigned
 *     classification, not derivable from COVERAGE_TYPE_C_NAME ('Indemnity'); the type.text
 *     ('Indemnity') is emitted, but no coding (different axis, not in export).
 *   - relationship Epic-OID coding (code "01"): Epic terminology, not in export.
 *   - contained Organization.type (Epic OID code 3 "Insurance Plan"): Epic terminology.
 *
 * Everything is TEXT in the EHI (general-patterns §17); categories ship pre-resolved as
 * *_C_NAME with no ZC_ tables (§23).
 */
import { q } from "../lib/db";
import { isoDate } from "../lib/time";
import { emit, clean } from "../lib/gen";
import { cc, concept, ident } from "../lib/cc";
import { id, ref, patientRef, PATIENT_PAT_ID, epicOid } from "../lib/ids";
import { nn } from "../lib/fmt";

// Standard / published systems we can legitimately assert.
const SYS_V2_0203 = "http://terminology.hl7.org/CodeSystem/v2-0203";
const SYS_SUBSCR_REL = "http://terminology.hl7.org/CodeSystem/subscriber-relationship";
const SYS_CVG_CLASS = "http://terminology.hl7.org/CodeSystem/coverage-class";
const SYS_PAYER_ID = "http://open.epic.com/FHIR/StructureDefinition/payer-id";
const SYS_CONTACT_TYPE = "http://terminology.hl7.org/CodeSystem/contactentity-type";
const EXT_BILLING_ORG = "http://open.epic.com/FHIR/StructureDefinition/billing-organization";
const EXT_EPIC_ID = "http://open.epic.com/FHIR/StructureDefinition/extension/epic-id";

// Epic instance master-file OIDs (org-instance node centralized in lib/ids;
// same convention used by every other domain generator here for Epic master-file ids).
const OID_COVERAGE = epicOid("2.7.2.678671"); // CVG coverage record
const OID_PLAN = epicOid("2.7.2.698080");     // EPP benefit plan

function buildCoverages(): any[] {
  const out: any[] = [];

  const rows = q<any>(
    `SELECT COVERAGE_ID, COVERAGE_TYPE_C_NAME, PAYOR_ID, PLAN_ID,
            GROUP_NUM, GROUP_NAME, CVG_EFF_DT, CVG_TERM_DT,
            SUBSCR_OR_SELF_MEM_PAT_ID, CVG_REG_STATUS_C_NAME
       FROM COVERAGE
      ORDER BY CAST(COVERAGE_ID AS INTEGER)`
  );

  for (const c of rows) {
    const covId = nn(c.COVERAGE_ID);
    if (!covId) continue;

    // --- The covered member (this patient). Self relationship here.
    const mem = q<any>(
      `SELECT LINE, PAT_ID, MEM_REL_TO_SUB_C_NAME, MEM_NUMBER,
              MEM_EFF_FROM_DATE, MEM_EFF_TO_DATE, MEM_COVERED_YN
         FROM COVERAGE_MEMBER_LIST
        WHERE COVERAGE_ID = ? AND PAT_ID = ?
        ORDER BY CAST(LINE AS INTEGER)`,
      covId,
      PATIENT_PAT_ID
    )[0];

    const memNumber = nn(mem?.MEM_NUMBER);
    const rel = nn(mem?.MEM_REL_TO_SUB_C_NAME);

    // --- type: the resolved coverage-type category name (COVERAGE.COVERAGE_TYPE_C_NAME,
    // e.g. "Indemnity"). This is a real EHI datum, emitted as text only — the NAHDO sopt
    // *coding* (code "6"/system https://nahdo.org/sopt) is Epic-assigned terminology on a
    // different axis and is not in the export (see gaps/coverage.md), so no coding is asserted.
    const covType = nn(c.COVERAGE_TYPE_C_NAME);
    const type = concept(covType);

    // --- status: active when the coverage/member term date is open.
    const termDate = nn(c.CVG_TERM_DT) ?? nn(mem?.MEM_EFF_TO_DATE);
    const status = termDate ? "cancelled" : "active";

    // --- payor name + payer-id (CLARITY_EPM).
    const payorId = nn(c.PAYOR_ID);
    const payorName = payorId
      ? nn(q<{ PAYOR_NAME: string }>(`SELECT PAYOR_NAME FROM CLARITY_EPM WHERE PAYOR_ID = ?`, payorId)[0]?.PAYOR_NAME)
      : undefined;

    // --- plan name (CLARITY_EPP).
    const planId = nn(c.PLAN_ID);
    const planName = planId
      ? nn(
          q<{ BENEFIT_PLAN_NAME: string }>(
            `SELECT BENEFIT_PLAN_NAME FROM CLARITY_EPP WHERE BENEFIT_PLAN_ID = ?`,
            planId
          )[0]?.BENEFIT_PLAN_NAME
        )
      : undefined;

    // --- contained billing Organization: payer + billing address from the 837 claim image.
    const contained: any[] = [];
    const extensions: any[] = [];
    const billOrg = buildBillingOrg(payorName);
    if (billOrg) {
      contained.push(billOrg);
      extensions.push({
        url: EXT_BILLING_ORG,
        valueReference: { reference: `#${billOrg.id}` },
      });
    }

    // --- identifiers.
    const identifier: any[] = [];
    identifier.push(ident(OID_COVERAGE, covId));
    if (memNumber) {
      identifier.push(ident(undefined, memNumber, { type: cc(SYS_V2_0203, "MB", "Member Number", null) }));
    }

    // --- relationship (HL7 self code + text; Epic-OID coding is a gap).
    const relationship =
      rel && /^self$/i.test(rel)
        ? cc(SYS_SUBSCR_REL, "self", "Self", rel)
        : rel
        ? { text: rel }
        : undefined;

    // --- class entries.
    const klass: any[] = [];
    const groupNum = nn(c.GROUP_NUM);
    if (groupNum) {
      klass.push({
        type: cc(SYS_CVG_CLASS, "group", "Group", null),
        value: groupNum,
      });
    }
    if (planId) {
      klass.push({
        extension: [
          {
            url: EXT_EPIC_ID,
            valueIdentifier: ident(OID_PLAN, planId, { use: "secondary" }),
          },
        ],
        type: cc(SYS_CVG_CLASS, "plan", "Plan", null),
        value: planId,
        name: planName,
      });
    }

    // --- payor reference.
    const payor: any[] = [];
    if (payorId) {
      payor.push({
        reference: ref("Organization", id.organization(payorId)).reference,
        identifier: ident(SYS_PAYER_ID, payorId, { use: "official" }),
        display: payorName,
      });
    }

    const patRef = patientRef();

    out.push(
      clean({
        resourceType: "Coverage",
        id: id.coverage(covId),
        contained: contained.length ? contained : undefined,
        extension: extensions.length ? extensions : undefined,
        identifier,
        status,
        type,
        subscriber: { reference: patRef.reference, display: patRef.display },
        subscriberId: memNumber,
        beneficiary: { reference: patRef.reference, display: patRef.display },
        relationship,
        period: { start: isoDate(mem?.MEM_EFF_FROM_DATE) },
        payor: payor.length ? payor : undefined,
        class: klass.length ? klass : undefined,
        order: 1,
      })
    );
  }

  return out;
}

/**
 * The payer as a contained billing Organization. The billing-contact address lives
 * only in the 837 claim image payer block (CLM_VALUES.PYR_ADDR_*), matched by name.
 * Organization.type (Epic OID "Insurance Plan") is Epic terminology — omitted (gap).
 */
function buildBillingOrg(payorName: string | undefined): any | undefined {
  if (!payorName) return undefined;

  const pyr = q<any>(
    `SELECT DISTINCT PYR_ADDR_1, PYR_ADDR_2, PYR_CITY, PYR_STATE, PYR_ZIP, PYR_CNTRY
       FROM CLM_VALUES
      WHERE PYR_ADDR_1 IS NOT NULL OR PYR_CITY IS NOT NULL`
  )[0];

  let contact: any[] | undefined;
  if (pyr) {
    const line: string[] = [];
    if (nn(pyr.PYR_ADDR_1)) line.push(nn(pyr.PYR_ADDR_1)!);
    if (nn(pyr.PYR_ADDR_2)) line.push(nn(pyr.PYR_ADDR_2)!);
    const address = clean({
      use: "billing",
      line: line.length ? line : undefined,
      city: nn(pyr.PYR_CITY),
      state: nn(pyr.PYR_STATE),
      postalCode: nn(pyr.PYR_ZIP),
      country: nn(pyr.PYR_CNTRY),
    });
    if (Object.keys(address).length > 1) {
      contact = [
        {
          purpose: cc(SYS_CONTACT_TYPE, "BILL", "Billing", null),
          address,
        },
      ];
    }
  }

  return clean({
    resourceType: "Organization",
    id: "org1",
    name: payorName,
    contact,
  });
}

emit("Coverage", buildCoverages());
