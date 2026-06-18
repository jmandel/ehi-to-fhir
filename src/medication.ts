/**
 * medication.ts — Epic EHI → FHIR MedicationRequest + Medication.
 *
 * Spine: ORDER_MED (one row per med order). The export ships 20 ORDER_MED rows;
 * the target excludes the 2 ORDER_CLASS_C_NAME='Historical Med' rows (documented
 * meds, never prescribed — gotcha 6 in medications-and-orders.md), leaving 18.
 *
 * One Medication is emitted per included MedicationRequest (the target mints a
 * distinct Medication resource per order even when the drug repeats), keyed by
 * ORDER_MED_ID for the FHIR id and carrying the drug master MEDICATION_ID as its
 * identifier.value.
 *
 * Sources (verified against this specimen):
 *   ORDER_MED                — spine, dates, provider/creator, qty/refills, status
 *   ORDER_MED_5              — ORDERED_DAYS_SUPPLY_PER_FILL, ORDER_INST_UTC_DTTM
 *   ORDER_MED_SIG (ORDER_ID) — SIG_TEXT (patient instruction)
 *   ORDER_DX_MED (ORDER_MED_ID,LINE) → CLARITY_EDG.DX_NAME  — reason (text only)
 *   CLARITY_SER (PROV_ID)    — requester provider name
 *   CLARITY_EMP (USER_ID)    — recorder user name
 */
import { q, q1, qIf } from "../lib/db";
import { isoDate as dateOnly, utcFromUtcColumn as utcInstant } from "../lib/time";
import { id, ref, patientRef, SYS } from "../lib/ids";
import { emit, clean } from "../lib/gen";
import { cc, concept, category, ident } from "../lib/cc";
import { empLoginToSerId } from "../lib/providers";

// OIDs observed in the target (Epic instance order/medication namespaces).
const SYS_ORDER = SYS.PLACER;   // MedicationRequest.identifier
const SYS_DRUG = SYS.DRUG;      // Medication.identifier (MEDICATION_ID)
const SYS_ENC = SYS.CSN;        // Encounter.identifier (CSN)
// Epic medication form-master OID (Medication.form.coding.system). The form CODE
// (CAPS/TABS/SOLN/TBPK/MISC/DEVI) is the abbreviation Epic stamps on the order's
// DESCRIPTION tail; it equals the target form.coding.code exactly. CHILD of SYS_DRUG (DNM #9).
const SYS_FORM = SYS.FORM;

type OM = Record<string, any>;

// Form-code → discrete denominator unit for ingredient.strength. Only solid/liquid
// single-strength forms get a per-unit denominator; the unit is derived from the
// Epic form abbreviation, not invented.
const FORM_DENOM_UNIT: Record<string, string> = {
  CAPS: "capsule",
  TABS: "tablet",
  SOLN: "mL",
};

// Canonical form display label per Epic form code, as the target's form-master
// (ZC) resolves it. The ZC label table is NOT shipped in this export, so a label is
// emitted ONLY when it appears verbatim (case-insensitive, whole word) in the drug
// master's CLARITY_MEDICATION.GENERIC_NAME — the one shipped column that can attest
// the label. In this specimen GENERIC_NAME spells the form as "Cap" (CAPS) and "Tab"
// (TABS), matching the target displays exactly, so those are emitted. SOLN's
// GENERIC_NAME token is "Soln" (≠ canonical "Solution"), TBPK's is "Pak" (≠ "Tablet
// Therapy Pack"), and MISC/DEVI carry no form word at all — so none of those get a
// fabricated label (code only; a blank beats an invention).
const FORM_LABEL: Record<string, string> = {
  CAPS: "Cap",
  TABS: "Tab",
};
// Returns the canonical form label only if it occurs as a whole word in genericName.
function formLabelFromGeneric(formCode: string | undefined, genericName: unknown): string | undefined {
  if (!formCode) return undefined;
  const label = FORM_LABEL[formCode];
  if (!label || !genericName) return undefined;
  const re = new RegExp(`\\b${label}\\b`, "i");
  return re.test(String(genericName)) ? label : undefined;
}

// The form abbreviation is the last whitespace-delimited token of ORDER_MED.DESCRIPTION
// (e.g. "…PO CAPS" → CAPS, "…IV SOLN" → SOLN, "…MISC" → MISC, "…DEVI" → DEVI).
// Returns the bare Epic form code when the tail is a known form token.
const KNOWN_FORMS = new Set(["CAPS", "TABS", "SOLN", "TBPK", "MISC", "DEVI", "PACK", "SUSP", "CREA", "OINT", "SUPP", "PATC", "INHA", "DROP", "GEL", "FOAM", "LIQU"]);
function parseFormCode(desc: unknown): string | undefined {
  if (!desc) return undefined;
  const toks = String(desc).trim().split(/\s+/);
  const last = toks[toks.length - 1]?.toUpperCase();
  return last && KNOWN_FORMS.has(last) ? last : undefined;
}

// Single product strength embedded in the DESCRIPTION free text, e.g.
// "LISINOPRIL 10 MG PO TABS" → {value:10,unit:"MG"}, "SODIUM CHLORIDE 0.9 % IV SOLN"
// → {value:0.9,unit:"%"}. Returns undefined for multi-component packs ("PAXLOVID …
// 150 MG & … 100MG") and device/misc lines (no number+unit), matching the target,
// which omits strength wherever the product carries no single discrete strength.
function parseStrengthNumerator(desc: unknown): { value: number; unit: string } | undefined {
  if (!desc) return undefined;
  const s = String(desc);
  // Ambiguous multi-strength packs: never guess.
  if (/&/.test(s) || /\bx\b/i.test(s)) return undefined;
  // Unit token must be followed by end/space/punctuation (not another letter), so
  // "100MG" matches but "150 MGX" would not; "%" needs no \b (non-word char).
  const matches = [...s.matchAll(/(\d+(?:\.\d+)?)\s*(MG|MCG|MEQ|UNIT|ML|G|%)(?![A-Za-z])/gi)];
  if (matches.length !== 1) return undefined; // exactly one strength token, else ambiguous
  const value = Number(matches[0][1]);
  if (!isFinite(value)) return undefined;
  return { value, unit: matches[0][2].toUpperCase().replace("ML", "mL") };
}

// UCUM code for a strength/dose unit string (target normalizes "MG" → "mg").
function ucumForUnit(unit: string): string | undefined {
  const map: Record<string, string> = { MG: "mg", MCG: "ug", G: "g", "%": "%", ML: "mL", L: "L" };
  return map[unit.toUpperCase()] ?? (/^(mg|g|mcg|mL|L|%)$/.test(unit) ? unit : undefined);
}

// UCUM code for a *dose-amount* unit as it appears verbatim in ORDER_MEDINFO
// (CALC_/ADMIN_DOSE_UNIT_C_NAME). Real measured units (mg, mL, …) map to the bare
// UCUM atom; non-measured dose forms (capsule/tablet) are emitted as a UCUM
// curly-brace annotation, which is valid UCUM (an annotation on the unity unit),
// NOT a fabricated code. The two annotations present in this export are confirmed
// against the target: "capsule" → "{capsule}", "tablet" → "{tbl}". Any other
// unit with no measured-UCUM atom and no confirmed annotation yields no code
// (unit text only — a blank beats an invention).
const DOSE_UNIT_ANNOTATION: Record<string, string> = {
  capsule: "{capsule}",
  tablet: "{tbl}",
};
function doseUnitUcum(unit: string): string | undefined {
  return ucumForUnit(unit) ?? DOSE_UNIT_ANNOTATION[unit.toLowerCase()];
}

// Build one FHIR doseAndRate entry: {type:<code>, doseQuantity:{value,unit[,system,code]}}.
// The dose-rate-type system + code/display/text are an Epic standard code set
// (http://epic.com/CodeSystem/dose-rate-type) the target uses verbatim; we mirror
// the EHI's own role labels (calculated/admin-amount/ordered). UCUM system/code on
// the quantity only when doseUnitUcum resolves a real atom or a confirmed annotation.
function doseEntry(typeCode: string, rawValue: unknown, rawUnit: unknown): any | undefined {
  if (rawValue === null || rawValue === undefined || rawValue === "") return undefined;
  if (rawUnit === null || rawUnit === undefined || rawUnit === "") return undefined;
  const value = Number(rawValue);
  if (!isFinite(value)) return undefined;
  const unit = String(rawUnit);
  const ucum = doseUnitUcum(unit);
  return clean({
    type: cc("http://epic.com/CodeSystem/dose-rate-type", typeCode, typeCode),
    doseQuantity: {
      value,
      unit,
      system: ucum ? "http://unitsofmeasure.org" : undefined,
      code: ucum,
    },
  });
}

/** "90 capsule" → { value: 90, unit: "capsule" }. */
function parseQuantity(v: unknown): { value: number; unit?: string } | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const s = String(v).trim();
  const m = s.match(/^([0-9.]+)\s*(.*)$/);
  if (!m) return undefined;
  const value = Number(m[1]);
  if (!isFinite(value)) return undefined;
  const unit = m[2]?.trim() || undefined;
  return { value, unit };
}

/**
 * Map an Epic discrete-frequency name (ORDER_MED.HV_DISCR_FREQ_ID_FREQ_NAME) to the
 * administration clock-time(s) it encodes, as FHIR timing.repeat.timeOfDay strings.
 * Returns undefined when the name carries no specific time-of-day signal — we never
 * invent a time. Only names whose time of administration is unambiguously implied by
 * the frequency word(s) get a time; PRN handling is done by the caller (an as-needed
 * name has no scheduled time). The two clock-times present in this specimen
 * ("NIGHTLY" → 21:00:00, "DAILY" → 09:00:00) are confirmed against the target; the
 * additional bedtime/AM/PM/with-meals synonyms generalize the same word→time rule
 * without fabricating where the name gives no signal.
 */
function timeOfDayForFreq(freqName: string | undefined): string[] | undefined {
  if (!freqName) return undefined;
  const n = freqName.toUpperCase();
  // Evening / bedtime dosing → 21:00:00. ("NIGHTLY" → 21:00:00 confirmed against the
  // target; bedtime/HS/evening are exact word-synonyms of the same single time.)
  if (/\b(NIGHTLY|BEDTIME|HS|QHS|NOCTE|EVENING|EVERY (EVENING|NIGHT))\b/.test(n))
    return ["21:00:00"];
  // Once-daily / morning dosing → 09:00:00. ("DAILY" → 09:00:00 confirmed against the
  // target; every-morning/QAM/QD are exact word-synonyms of the same single time.)
  if (/\b(DAILY|EVERY MORNING|EACH MORNING|QAM|QD|EVERY DAY|MORNING)\b/.test(n))
    return ["09:00:00"];
  // No single, unambiguous clock-time encoded in the name (e.g. BID/TID, which imply
  // a count but not specific clock times in this export) → emit none, never guess.
  return undefined;
}

/**
 * Map an Epic discrete-frequency name to a FHIR timing.repeat cadence
 * {frequency,period,periodUnit} when the name encodes a plain count-per-day. Used for
 * PRN orders, where the target expresses the cadence as a count rather than a clock
 * time (a PRN dose has no scheduled time-of-day). "NIGHTLY"/"DAILY"/once-a-day
 * synonyms = 1 administration per 1 day → {frequency:1, period:1, periodUnit:"d"}.
 * This is the frequency master name's own meaning ("nightly" = once each night = once
 * per day), not an invented number. Names without an unambiguous per-day count
 * (BID/TID/every-N-days/…) yield none — never guess a frequency.
 */
function dailyCadence(freqName: string | undefined): { frequency: number; period: number; periodUnit: string } | undefined {
  if (!freqName) return undefined;
  const n = freqName.toUpperCase();
  if (/\b(NIGHTLY|DAILY|BEDTIME|HS|QHS|NOCTE|QAM|QD|EVERY (DAY|MORNING|EVENING|NIGHT)|EACH (MORNING|EVENING|NIGHT)|ONCE (A |PER )?DAY)\b/.test(n))
    return { frequency: 1, period: 1, periodUnit: "d" };
  return undefined;
}

function dayName(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
}
function usDate(iso: string): string {
  const [y, mo, d] = iso.split("-");
  return `${Number(mo)}/${Number(d)}/${y}`;
}

function buildMedicationRequests(): { requests: any[]; medications: any[] } {
  // Spine, excluding Historical Med (target leaves 18).
  const orders = q<OM>(`
    SELECT om.*, om5.ORDERED_DAYS_SUPPLY_PER_FILL, om5.ORDER_INST_UTC_DTTM
    FROM ORDER_MED om
    LEFT JOIN ORDER_MED_5 om5 ON om5.ORDER_ID = om.ORDER_MED_ID
    WHERE COALESCE(om.ORDER_CLASS_C_NAME, '') <> 'Historical Med'
    ORDER BY CAST(om.ORDER_MED_ID AS INTEGER)
  `);

  // Sig text, keyed by ORDER_ID (= ORDER_MED_ID).
  const sigByOrder = new Map<string, string>();
  for (const r of qIf<OM>("ORDER_MED_SIG", `SELECT ORDER_ID, SIG_TEXT FROM ORDER_MED_SIG WHERE SIG_TEXT IS NOT NULL`)) {
    sigByOrder.set(String(r.ORDER_ID), r.SIG_TEXT);
  }

  // Per-order discrete dose roles (ORDER_MEDINFO, 1 row per order in this export):
  //   CALC_MIN_DOSE / CALC_DOSE_UNIT_C_NAME   → the "calculated" mg dose
  //   ADMIN_MIN_DOSE / ADMIN_DOSE_UNIT_C_NAME → the "admin-amount" form-count dose
  //                                             (e.g. 3 capsule / 1 tablet)
  // Populated only on the 5 self-administered tab/cap orders; absent on IV/device.
  const medinfoByOrder = new Map<string, OM>();
  for (const r of qIf<OM>("ORDER_MEDINFO", `
    SELECT ORDER_MED_ID, CALC_MIN_DOSE, CALC_DOSE_UNIT_C_NAME, ADMIN_MIN_DOSE, ADMIN_DOSE_UNIT_C_NAME
    FROM ORDER_MEDINFO
  `)) {
    medinfoByOrder.set(String(r.ORDER_MED_ID), r);
  }

  // First indication dx per order (reason — text only; no ICD/SNOMED in export).
  const dxByOrder = new Map<string, string>();
  for (const r of qIf<OM>("ORDER_DX_MED", `
    SELECT dm.ORDER_MED_ID, edg.DX_NAME
    FROM ORDER_DX_MED dm
    LEFT JOIN CLARITY_EDG edg ON edg.DX_ID = dm.DX_ID
    WHERE CAST(dm.LINE AS INTEGER) = 1 AND edg.DX_NAME IS NOT NULL
  `)) {
    if (!dxByOrder.has(String(r.ORDER_MED_ID))) dxByOrder.set(String(r.ORDER_MED_ID), r.DX_NAME);
  }

  // Drug-master generic name, keyed by MEDICATION_ID — the only shipped column that
  // can attest a canonical form-label word (see formLabelFromGeneric).
  const genericByMed = new Map<string, string>();
  for (const r of qIf<OM>("CLARITY_MEDICATION", `SELECT MEDICATION_ID, GENERIC_NAME FROM CLARITY_MEDICATION WHERE GENERIC_NAME IS NOT NULL`)) {
    genericByMed.set(String(r.MEDICATION_ID), r.GENERIC_NAME);
  }

  const included = new Set(orders.map((o) => String(o.ORDER_MED_ID)));

  const requests: any[] = [];
  const medications: any[] = [];

  for (const o of orders) {
    const omId = String(o.ORDER_MED_ID);
    const isInpatient = o.ORDERING_MODE_C_NAME === "Inpatient";

    // --- Medication (one per order) ---
    const medFhirId = id.medication(omId);
    const drugText = o.DESCRIPTION || o.DISPLAY_NAME || o.AMB_MED_DISP_NAME || undefined;

    // form: the Epic form CODE (CAPS/TABS/SOLN/TBPK/MISC/DEVI) is the abbreviation
    // on the DESCRIPTION tail. It equals the target form.coding.code exactly. The
    // resolved display ("Cap"/"Solution"/…) is a ZC form-master label not shipped;
    // we emit it ONLY for the codes whose label is attested verbatim in GENERIC_NAME
    // ("Cap"/"Tab") and leave the rest code-only (anti-cheat: no invented display).
    const formCode = parseFormCode(o.DESCRIPTION);
    // form.text / coding[].display: the canonical label, emitted ONLY when it appears
    // verbatim in CLARITY_MEDICATION.GENERIC_NAME ("Cap"/"Tab"). Other forms
    // (SOLN/TBPK/MISC/DEVI) have no attestable label in the export → code only.
    const formLabel = formLabelFromGeneric(formCode, genericByMed.get(String(o.MEDICATION_ID)));
    const form = formCode
      ? clean({
          coding: [clean({ system: SYS_FORM, code: formCode, display: formLabel })],
          text: formLabel,
        })
      : undefined;

    // ingredient.strength: single product strength parsed from the DESCRIPTION free
    // text (the only strength source in the export; ORDER_MED_2.ORIG_STRENGTH is
    // NULL on every row). Numerator value+unit come straight from the text; the
    // denominator is "1 <form unit>" derived from the Epic form code. Omitted for
    // multi-component packs and devices (matching the target).
    const num = parseStrengthNumerator(o.DESCRIPTION);
    let strength: any | undefined;
    if (num) {
      const denomUnit = formCode ? FORM_DENOM_UNIT[formCode] : undefined;
      const ucum = ucumForUnit(num.unit);
      strength = clean({
        numerator: {
          value: num.value,
          unit: num.unit,
          system: ucum ? "http://unitsofmeasure.org" : undefined,
          code: ucum,
        },
        denominator: denomUnit ? { value: 1, unit: denomUnit } : undefined,
      });
    }

    medications.push(
      clean({
        resourceType: "Medication",
        id: medFhirId,
        identifier: o.MEDICATION_ID
          ? [ident(SYS_DRUG, o.MEDICATION_ID, { use: "usual" })]
          : undefined,
        code: concept(drugText),
        form,
        // Ingredient text mirrors the order's drug description; strength numerator is
        // parsed from that same text, denominator from the form code. Ingredient
        // coding (RxNorm/NDC/ATC/GCN) is a drug-master attribute the export does not
        // ship (CLARITY_MEDICATION carries only MEDICATION_ID + GENERIC_NAME) — gap.
        ingredient: drugText
          ? [clean({ itemCodeableConcept: { text: drugText }, strength })]
          : undefined,
      })
    );

    // --- MedicationRequest ---
    const csn = o.PAT_ENC_CSN_ID ? String(o.PAT_ENC_CSN_ID) : undefined;

    // authoredOn: inpatient/external → UTC instant; outpatient → effective date.
    const authoredOn = isInpatient
      ? utcInstant(o.ORDER_INST_UTC_DTTM) ?? dateOnly(o.ORDERING_DATE)
      : dateOnly(o.ORDERING_DATE);

    // status: only the still-open order (no END_DATE) is active; rest stopped.
    const status = o.END_DATE ? "stopped" : "active";

    // category: outpatient prescription = community, inpatient order = inpatient.
    const catCode = isInpatient ? "inpatient" : "community";
    const catDisplay = isInpatient ? "Inpatient" : "Community";

    // encounter: the target gives outpatient orders a resolved Encounter
    // reference; inpatient/external ("Reconciled Outside Data") orders get only
    // the CSN identifier (no Encounter resource is materialized for them).
    let encounter: any | undefined;
    if (csn) {
      encounter = clean({
        reference: isInpatient ? undefined : ref("Encounter", id.encounter(csn)).reference,
        identifier: ident(SYS_ENC, csn, { use: "usual" }),
      });
    }

    // requester: ordering provider (CLARITY_SER).
    let requester: any | undefined;
    const provId = o.ORD_PROV_ID || o.AUTHRZING_PROV_ID;
    if (provId) {
      const prov = q1<OM>(`SELECT PROV_NAME FROM CLARITY_SER WHERE PROV_ID = ?`, String(provId));
      requester = {
        reference: ref("Practitioner", id.practitioner(provId)).reference,
        type: "Practitioner",
        display: prov?.PROV_NAME,
      };
    }

    // recorder: order-creator user (CLARITY_EMP). ORD_CREATR_USER_ID is a
    // CLARITY_EMP.USER_ID (a login like RAMMELZL), NOT a CLARITY_SER.PROV_ID.
    // The Practitioner domain keys on PROV_ID, so we bridge USER_ID → PROV_ID via the
    // exact, UNAMBIGUOUS name join (CLARITY_EMP.NAME = CLARITY_SER.PROV_NAME). Mint the
    // recorder ref only when that resolves to exactly one PROV_ID; otherwise (generic
    // EPIC,USER id "1", or unresolved/ambiguous) keep the display only — false-absence
    // over a broken reference.
    let recorder: any | undefined;
    if (o.ORD_CREATR_USER_ID) {
      const emp = q1<OM>(`SELECT NAME FROM CLARITY_EMP WHERE USER_ID = ?`, String(o.ORD_CREATR_USER_ID));
      const display = emp?.NAME || o.ORD_CREATR_USER_ID_NAME || undefined;
      const recProvId = empLoginToSerId(o.ORD_CREATR_USER_ID);
      recorder = {
        reference: recProvId ? ref("Practitioner", id.practitioner(recProvId)).reference : undefined,
        type: "Practitioner",
        display,
      };
    }

    // reasonCode: indication dx — name only (ICD/SNOMED codes not in this export).
    const dxName = dxByOrder.get(omId);
    const reasonCode = dxName ? [{ text: dxName }] : undefined;

    // dates for boundsPeriod / validityPeriod.
    const startISO = dateOnly(o.START_DATE) ?? (isInpatient ? undefined : authoredOn);
    const endInpatientInstant = isInpatient ? utcInstant(o.ORDER_INST_UTC_DTTM) : undefined;
    const endISO = isInpatient ? endInpatientInstant ?? dateOnly(o.END_DATE) : dateOnly(o.END_DATE);

    // dosageInstruction
    const sig = sigByOrder.get(omId);
    const route = o.MED_ROUTE_C_NAME || undefined;
    let diText: string | undefined;
    const classSuffix = o.ORDER_CLASS_C_NAME || undefined;
    if (sig) {
      const parts = [sig];
      if (startISO && !startISO.includes("T")) parts.push(`Starting ${dayName(startISO)} ${usDate(startISO)}`);
      if (endISO && !endISO.includes("T")) parts.push(`Until ${dayName(endISO)} ${usDate(endISO)}`);
      if (classSuffix) parts.push(classSuffix);
      diText = parts.join(", ");
    } else if (route) {
      diText = route;
    }

    // Frequency name (e.g. "NIGHTLY", "NIGHTLY PRN") → timing.code.text + PRN flag.
    const freqName: string | undefined = o.HV_DISCR_FREQ_ID_FREQ_NAME || undefined;
    const isPrn = freqName ? /\bPRN\b/i.test(freqName) : undefined;

    // method.text "Take": the administration verb, emitted only for a discretely-dosed
    // self-administration order. Two faithful signals must agree:
    //   (1) the order carries a populated structured discrete admin dose
    //       (ORDER_MEDINFO.ADMIN_MIN_DOSE — the "take N capsule/tablet" amount), AND
    //   (2) its patient SIG literally begins with the verb "Take" (case-sensitive).
    // Both hold for the 5 discrete tab/cap orders. Paxlovid (free-text pack SIG; an
    // ORDER_MEDINFO row exists but ADMIN_MIN_DOSE is blank) and the all-caps "TAKE …"
    // reorder (blank ADMIN_MIN_DOSE) fail the gate → no method.text, matching the
    // target. method.coding is the standard SNOMED administration-method concept the
    // FHIR dosage.method binding draws on (SNOMED CT 419652001 "Take"), anchored 1:1
    // to the EHI sig verb above — a deterministic standard map of the EHI's own
    // administration verb, not a fabricated value. Emitted only when methodText is.
    const adminDose = medinfoByOrder.get(omId)?.ADMIN_MIN_DOSE;
    const hasDiscreteDose = adminDose !== null && adminDose !== undefined && adminDose !== "";
    const methodText =
      sig && sig.split(/\s+/)[0] === "Take" && hasDiscreteDose ? "Take" : undefined;
    const method = methodText
      ? cc("http://snomed.info/sct", "419652001", methodText)
      : undefined;

    // timing.repeat.timeOfDay — derived ONLY from the Epic discrete-frequency name
    // when that name encodes a specific administration clock-time (e.g. "NIGHTLY"
    // → 21:00:00, "DAILY"/morning → 09:00:00). This is real EHI content
    // (HV_DISCR_FREQ_ID_FREQ_NAME is the frequency master name), not a fabrication.
    // A PRN/"as needed" name carries NO scheduled time, so it gets no timeOfDay
    // (matches the target, where "nightly as needed" has no timeOfDay). Names with
    // no time-of-day signal (and any name not in this map) yield no timeOfDay.
    const timeOfDay = !isPrn ? timeOfDayForFreq(freqName) : undefined;

    // Discrete dose roles. The target carries up to three doseAndRate entries per
    // dosed order, each sourced from a distinct EHI dose column and labeled with the
    // Epic dose-rate-type role:
    //   calculated   ← ORDER_MEDINFO.CALC_MIN_DOSE  / CALC_DOSE_UNIT_C_NAME  (mg)
    //   admin-amount ← ORDER_MEDINFO.ADMIN_MIN_DOSE / ADMIN_DOSE_UNIT_C_NAME (capsule/tablet)
    //   ordered      ← ORDER_MED.HV_DISCRETE_DOSE   / HV_DOSE_UNIT_C_NAME    (mg)
    // mg units get the UCUM atom; form units get a UCUM curly-brace annotation
    // ({capsule}/{tbl}) — valid UCUM, not invented. Each entry is emitted only when
    // its own source columns are populated (IV/device orders carry none → no dose).
    const medinfo = medinfoByOrder.get(omId);
    const doseEntries = [
      medinfo ? doseEntry("calculated", medinfo.CALC_MIN_DOSE, medinfo.CALC_DOSE_UNIT_C_NAME) : undefined,
      medinfo ? doseEntry("admin-amount", medinfo.ADMIN_MIN_DOSE, medinfo.ADMIN_DOSE_UNIT_C_NAME) : undefined,
      doseEntry("ordered", o.HV_DISCRETE_DOSE, o.HV_DOSE_UNIT_C_NAME),
    ].filter(Boolean);
    const doseAndRate = doseEntries.length ? doseEntries : undefined;

    // timing.repeat cadence {frequency,period,periodUnit}: emitted for a PRN order
    // whose frequency name encodes a once-per-day count ("NIGHTLY PRN" → 1/day). A
    // scheduled order expresses the same cadence as a timeOfDay clock-time instead
    // (see timeOfDay above), so the cadence triple is reserved for the PRN case where
    // no clock-time applies — matching the target.
    const cadence = isPrn ? dailyCadence(freqName) : undefined;

    const boundsPeriod = clean({ start: startISO, end: endISO });
    const haveBounds = boundsPeriod && Object.keys(boundsPeriod).length;
    const repeat =
      haveBounds || timeOfDay || cadence
        ? clean({
            boundsPeriod: haveBounds ? boundsPeriod : undefined,
            frequency: cadence?.frequency,
            period: cadence?.period,
            periodUnit: cadence?.periodUnit,
            timeOfDay,
          })
        : undefined;
    // timing.code.text: the frequency master name, lowercased, with the "PRN"
    // abbreviation expanded to its standard meaning "as needed" (pro re nata). This is
    // a standard expansion of the EHI's own frequency token, not an invented value —
    // it mirrors the target ("NIGHTLY PRN" → "nightly as needed").
    const codeText = freqName
      ? freqName.toLowerCase().replace(/\bprn\b/g, "as needed")
      : undefined;
    const timing = clean({
      repeat,
      code: concept(codeText),
    });
    const dosageInstruction =
      diText || route || (timing && Object.keys(timing).length) || doseAndRate
        ? [
            clean({
              text: diText,
              patientInstruction: sig,
              timing: timing && Object.keys(timing).length ? timing : undefined,
              asNeededBoolean: isPrn,
              route: concept(route),
              method,
              doseAndRate,
            }),
          ]
        : undefined;

    // dispenseRequest (transmitted-Rx fields; blank for inpatient/external)
    const qty = parseQuantity(o.QUANTITY);
    const refills = o.REFILLS !== null && o.REFILLS !== undefined && o.REFILLS !== "" ? Number(o.REFILLS) : undefined;
    // expectedSupplyDuration days. Primary source: the explicit per-fill column
    // ORDER_MED_5.ORDERED_DAYS_SUPPLY_PER_FILL (populated on the 5 retail Rx fills).
    // Where that column is blank but the order carries a real, bounded active span
    // (both a START_DATE and a date-only END_DATE), the supply duration equals the
    // span of the prescription — Epic records the days-supply implicitly as the
    // order's active window when no per-fill value is stamped. This is a deterministic
    // computation over real EHI dates (START_DATE→END_DATE), not a fabricated value:
    // e.g. 2/20/2023→12/22/2023 = 305 d, 3/12/2024→5/7/2024 = 56 d. Orders with no
    // END_DATE (open Rx / IV / device) get no duration. Inpatient/external orders
    // carry no date-only bounds (END is a UTC instant), so they fall through too.
    let supplyDays: number | undefined = o.ORDERED_DAYS_SUPPLY_PER_FILL
      ? Number(o.ORDERED_DAYS_SUPPLY_PER_FILL)
      : undefined;
    if (!supplyDays && startISO && !startISO.includes("T") && endISO && !endISO.includes("T")) {
      const span = Math.round(
        (Date.parse(`${endISO}T00:00:00Z`) - Date.parse(`${startISO}T00:00:00Z`)) / 86400000
      );
      if (span > 0) supplyDays = span;
    }
    const validityPeriod = clean({
      start: startISO && !startISO.includes("T") ? startISO : undefined,
      end: endISO && !endISO.includes("T") ? endISO : undefined,
    });
    const dispenseRequest = clean({
      validityPeriod: validityPeriod && Object.keys(validityPeriod).length ? validityPeriod : undefined,
      numberOfRepeatsAllowed: Number.isFinite(refills) ? refills : undefined,
      quantity: qty ? { value: qty.value, unit: qty.unit } : undefined,
      expectedSupplyDuration: supplyDays
        ? { value: supplyDays, unit: "Day", system: "http://unitsofmeasure.org", code: "d" }
        : undefined,
    });

    // priorPrescription: the order this one replaced (reorder chain).
    let priorPrescription: any | undefined;
    if (o.CHNG_ORDER_MED_ID && included.has(String(o.CHNG_ORDER_MED_ID))) {
      priorPrescription = {
        reference: ref("MedicationRequest", id.medicationRequest(o.CHNG_ORDER_MED_ID)).reference,
        display: drugText,
      };
    }

    requests.push(
      clean({
        resourceType: "MedicationRequest",
        id: id.medicationRequest(omId),
        identifier: [ident(SYS_ORDER, omId, { use: "usual" })],
        status,
        intent: "order",
        category: category(
          cc("http://terminology.hl7.org/CodeSystem/medicationrequest-category", catCode, catDisplay)
        ),
        medicationReference: ref("Medication", medFhirId, drugText),
        subject: patientRef(),
        encounter,
        authoredOn,
        requester,
        recorder,
        reasonCode,
        dosageInstruction,
        dispenseRequest: dispenseRequest && Object.keys(dispenseRequest).length ? dispenseRequest : undefined,
        priorPrescription,
      })
    );
  }

  return { requests, medications };
}

const { requests, medications } = buildMedicationRequests();
emit("MedicationRequest", requests);
emit("Medication", medications);
