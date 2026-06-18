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

export const PATIENT_PAT_ID = "Z7004242"; // PATIENT.PAT_ID for this specimen
export const PATIENT_ID = "pat-" + PATIENT_PAT_ID;

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
  const tc = (w: string) => (w ? w[0] + w.slice(1).toLowerCase() : w);
  const last = lastRaw.trim().split(/\s+/).map(tc).join(" ");
  const restParts = restRaw.trim().split(/\s+/).filter(Boolean).map(tc); // [first, middleInitial?]
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
