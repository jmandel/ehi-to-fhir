/**
 * ids.ts — deterministic FHIR id minting + cross-resource references.
 *
 * Epic's real FHIR ids (e.g. "euBTtyZGh3f-...") are opaque and NOT in the EHI
 * export, so we mint our own stable ids from EHI keys. The ONLY rule that matters:
 * every domain generator must mint the id for a given entity the same way, so a
 * reference from one resource resolves to the id another resource was given.
 *
 * Convention: `<type>-<naturalKey>` with the key slugified. Use the helpers below.
 */
import { titleCaseName } from "./fmt";
import { q1 } from "./db";

/**
 * The whole-pipeline patient anchor, DERIVED from the export (not baked), so the
 * same code exports any single-patient EHI. Override with EHI_PAT_ID; otherwise the
 * sole PATIENT row's PAT_ID. Errors clearly on an empty/absent PATIENT table — a
 * missing anchor must fail loud, never silently mint refs to an undefined patient.
 */
export const PATIENT_PAT_ID: string = (() => {
  const v = process.env.EHI_PAT_ID ?? q1<{ PAT_ID: string }>(`SELECT PAT_ID FROM PATIENT LIMIT 1`)?.PAT_ID;
  if (!v) throw new Error("PATIENT_PAT_ID: no PATIENT row (set EHI_PAT_ID or check the EHI DB)");
  return v;
})();
export const PATIENT_ID = "pat-" + PATIENT_PAT_ID;

/**
 * The Epic org-INSTANCE OID node (`.283`). This is NOT org-independent — it
 * identifies one Epic customer instance. A different org = one edit here (or set
 * EHI_INSTANCE_OID). Every Epic master-file identifier/code system below this org
 * node composes from it via epicOid()/epicOidRaw(), so a new org flips them all.
 * Stored BARE (no `urn:oid:` prefix).
 */
export const EPIC_INSTANCE_OID: string =
  process.env.EHI_INSTANCE_OID ?? "1.2.840.114350.1.13.283";

/**
 * Compose an Epic-instance `identifier.system`/`code.system` URI from a suffix
 * below the org node, e.g. epicOid("2.7.3.698084.8") -> the CSN system.
 * epicOid("") yields the bare root urn (the org-root MRN system).
 */
export function epicOid(suffix: string): string {
  return suffix
    ? `urn:oid:${EPIC_INSTANCE_OID}.${suffix}`
    : `urn:oid:${EPIC_INSTANCE_OID}`;
}

/**
 * Bare-OID (no `urn:oid:`) form, for OIDs interpolated into identifier VALUES
 * (e.g. the doc-id "<tail>_<NOTE_ID>"), not into systems.
 */
export function epicOidRaw(suffix: string): string {
  return suffix ? `${EPIC_INSTANCE_OID}.${suffix}` : EPIC_INSTANCE_OID;
}

/**
 * Registry of recurring Epic-instance master-file systems, so cross-referenced
 * resources (basedOn/encounter-linked) cite byte-identical systems via one symbol.
 * Single-use OIDs may stay inline as epicOid("<suffix>"). Child nodes are kept as
 * DISTINCT entries from their masters on purpose (see CONSOLIDATION-PLAN DNM #8–#12).
 */
export const SYS = {
  CSN: epicOid("2.7.3.698084.8"),       // PAT_ENC_CSN_ID — Encounter identifier
  PLACER: epicOid("2.7.2.798268"),      // ORDER_PROC placer (DR/Obs/SR/med order)
  HSP_ACCT: epicOid("2.7.2.726582"),    // HSP_ACCOUNT master
  ETR: epicOid("2.7.2.726582.1"),       // PB transaction (ETR) — CHILD of HSP_ACCT (DNM #8)
  FLO: epicOid("2.7.2.707679"),         // flowsheet measure id (DNM #12)
  SDI: epicOid("2.7.2.727688"),         // SmartData element measure id (DNM #12)
  DRUG: epicOid("2.7.2.698288"),        // MEDICATION_ID master
  FORM: epicOid("2.7.4.698288.310"),    // drug form — CHILD of DRUG (DNM #9)
  NOTE: epicOid("2.7.2.727879"),        // HNO note id
} as const;

/**
 * Standard (non-Epic) system URIs that recur. ORG-INDEPENDENT — these MUST NOT
 * compose from EPIC_INSTANCE_OID (DNM #13 boundary).
 */
export const STD = {
  LOINC: "http://loinc.org",
  SNOMED: "http://snomed.info/sct",
  UCUM: "http://unitsofmeasure.org",
  RXNORM: "http://www.nlm.nih.gov/research/umls/rxnorm",
  ICD10CM: "http://hl7.org/fhir/sid/icd-10-cm",
  NDC: "http://hl7.org/fhir/sid/ndc",
  NPI: "http://hl7.org/fhir/sid/us-npi",
  CPT: "urn:oid:2.16.840.1.113883.6.12",
  OBS_CATEGORY: "http://terminology.hl7.org/CodeSystem/observation-category",
  V2_0203: "http://terminology.hl7.org/CodeSystem/v2-0203",
} as const;

function slug(s: string | number): string {
  return String(s).trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

export const id = {
  patient: () => PATIENT_ID,
  encounter: (csn: string | number) => `enc-${slug(csn)}`,            // PAT_ENC_CSN_ID
  practitioner: (serId: string | number) => `prac-${slug(serId)}`,    // CLARITY_SER (.PROV_ID)
  location: (depId: string | number) => `loc-${slug(depId)}`,         // CLARITY_DEP / location id
  organization: (k: string | number) => `org-${slug(k)}`,
  condition: (k: string | number) => `cond-${slug(k)}`,
  observation: (k: string | number) => `obs-${slug(k)}`,
  medication: (k: string | number) => `med-${slug(k)}`,
  medicationRequest: (orderMedId: string | number) => `medreq-${slug(orderMedId)}`, // ORDER_MED.ORDER_MED_ID
  immunization: (k: string | number) => `imm-${slug(k)}`,
  allergy: (k: string | number) => `alg-${slug(k)}`,
  diagnosticReport: (k: string | number) => `dr-${slug(k)}`,          // ORDER_PROC.ORDER_PROC_ID
  serviceRequest: (orderProcId: string | number) => `sr-${slug(orderProcId)}`, // ORDER_PROC.ORDER_PROC_ID
  specimen: (k: string | number) => `spec-${slug(k)}`,
  documentReference: (k: string | number) => `doc-${slug(k)}`,
  carePlan: (k: string | number) => `cp-${slug(k)}`,
  careTeam: (k: string | number) => `ct-${slug(k)}`,
  goal: (k: string | number) => `goal-${slug(k)}`,
  coverage: (k: string | number) => `cov-${slug(k)}`,
  // secure communications
  communication: (k: string | number) => `comm-${slug(k)}`,        // MYC_MESG / MSG_TXT message id
  // billing & insurance
  account: (k: string | number) => `acct-${slug(k)}`,              // HAR / guarantor account
  chargeItem: (k: string | number) => `chg-${slug(k)}`,            // ARPB_TRANSACTIONS charge tx id
  invoice: (k: string | number) => `inv-${slug(k)}`,               // INVOICE id
  claim: (k: string | number) => `clm-${slug(k)}`,                 // claim / billing tx group
  explanationOfBenefit: (k: string | number) => `eob-${slug(k)}`,  // PMT_EOB / claim adjudication
  paymentReconciliation: (k: string | number) => `pmtrec-${slug(k)}`, // CL_REMIT remittance
  coverageEligibilityResponse: (k: string | number) => `celig-${slug(k)}`, // BENEFITS / COVERAGE_BENEFITS snapshot
};

/** A FHIR reference object. `display` is optional but recommended. */
export function ref(resourceType: string, fhirId: string, display?: string) {
  const r: any = { reference: `${resourceType}/${fhirId}` };
  if (display) r.display = display;
  return r;
}

/**
 * The patient display, DERIVED from the EHI. Both pieces are truthful EHI data:
 *  - the legal name from PATIENT.PAT_NAME ("MANDEL,JOSHUA C"), and
 *  - the patient's preferred first name from PATIENT_3.PREFERRED_NAME ("Josh").
 * When a PREFERRED_NAME is present we substitute it for the legal first name,
 * yielding "Last, PreferredFirst MiddleInitial" (e.g. "Mandel, Josh C"); otherwise
 * we fall back to the title-cased PAT_NAME ("Mandel, Joshua C").
 * Never hardcode the patient name in a generator — call patientRef().
 * Computed lazily and cached so importing ids.ts doesn't force a DB read.
 */
let _patientDisplay: string | undefined;
export function patientDisplay(): string | undefined {
  if (_patientDisplay !== undefined) return _patientDisplay || undefined;
  const { q1 } = require("./db");
  const row = q1<{ PAT_NAME: string }>(`SELECT PAT_NAME FROM PATIENT WHERE PAT_ID = ?`, PATIENT_PAT_ID);
  const raw = row?.PAT_NAME?.trim();
  if (!raw) {
    _patientDisplay = "";
    return undefined;
  }
  // "MANDEL,JOSHUA C" -> title-cased ["Mandel", "Joshua", "C"] (cosmetic only).
  const [lastRaw = "", restRaw = ""] = raw.split(",");
  const last = lastRaw.trim().split(/\s+/).map(titleCaseName).join(" ");
  const restParts = restRaw.trim().split(/\s+/).filter(Boolean).map(titleCaseName); // [first, middleInitial?]
  // Prefer the EHI preferred first name when present, keeping any middle initial(s).
  const pref = q1<{ PREFERRED_NAME: string }>(
    `SELECT PREFERRED_NAME FROM PATIENT_3 WHERE PAT_ID = ?`, PATIENT_PAT_ID
  )?.PREFERRED_NAME?.trim();
  if (pref) restParts[0] = pref;
  _patientDisplay = `${last}, ${restParts.join(" ")}`.trim();
  return _patientDisplay || undefined;
}

/** Reference to the Patient. Display derives from the EHI unless explicitly overridden. */
export const patientRef = (display?: string) => ref("Patient", PATIENT_ID, display ?? patientDisplay());
