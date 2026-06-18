/**
 * classify-lib.ts — shared types/helpers between tolerances.ts (the registry) and
 * classify.ts (the consumer). Kept separate to avoid a require cycle.
 */

export const norm = (s: any): string =>
  String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

// name normalize: lowercase, strip commas/periods, collapse whitespace (for token compares).
export const normName = (s: any): string =>
  String(s ?? "").toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();

// Build the set of recorded name-forms of a Patient (or any resource with name[]):
// for each name[] entry, "family, given0 given1 ..." normalized, plus name.text normalized.
export function nameFormsOf(res: any): Set<string> {
  const out = new Set<string>();
  for (const n of res?.name || []) {
    if (n.text) out.add(norm(n.text));
    const fam = n.family || "";
    const giv = (n.given || []).join(" ");
    if (fam || giv) {
      out.add(norm(`${fam}, ${giv}`)); // "Mandel, Josh C"
      out.add(norm(`${giv} ${fam}`)); // "Josh C Mandel"
    }
  }
  return out;
}

/**
 * ClassifyContext — the per-delta evidence a rule's verify() predicate may consult.
 * It is NARROW by design: a predicate can resolve refs, read sibling element values,
 * and query a small set of pre-built data joins (department table, location-name
 * uniqueness). It CANNOT mutate anything.
 */
export interface ClassifyContext {
  // the delta under classification
  resourceType: string;
  path: string; // dotted path, e.g. "Observation.encounter.reference" -> here path is "encounter.reference" relative? No: full element path within resource
  targetVal: any; // the target leaf value at this path
  ourVal: any; // our leaf value at this path

  // resolve a "Type/id" reference string to its full resource on a side
  resolve: (ref: string, side: "tgt" | "our") => any | null;

  // read a sibling element's first value on each side of THIS matched pair (relative path within resource)
  targetAt: (relPath: string) => any;
  ourAt: (relPath: string) => any;

  // the WHOLE matched resource on each side (the root the current leaf belongs to). Lets a
  // predicate climb above the leaf's immediate owner to a resource-level anchor — e.g. the
  // parent DocumentReference's DOCUMENT_ID identifier for a content[].attachment leaf, which is
  // not reachable from the attachment owner object alone.
  targetRoot: any;
  ourRoot: any;

  // data joins
  department: (departmentId: string) => { DEPARTMENT_NAME: string; EXTERNAL_NAME: string } | null;
  locationNamesUnique: (side: "tgt" | "our") => boolean;
  // fail-closed per-key uniqueness: does this Specimen accession value resolve to EXACTLY ONE
  // Specimen on the given side? (accession is non-injective — H613684 maps to 3 distinct specimens —
  // so a specimen-by-accession ref may only be tolerated when the accession is unambiguous.)
  specimenAccessionUnique: (side: "tgt" | "our", accession: string) => boolean;

  // FAIL-CLOSED order-equivalence for basedOn iso-refs. The target's ServiceRequest is opaque and
  // ABSENT from the target export (so it can't be resolved/keyed directly), and the order DISPLAY is
  // NON-INJECTIVE (the same panel ordered twice shares the display). This accessor precomputes the
  // observed (targetRef -> ourRef) pairing across ALL aligned Observation/DiagnosticReport.basedOn
  // leaves and returns the our-side ref a given target ref maps to ONLY when that mapping is a strict
  // BIJECTION for both refs (each target ref -> exactly one our ref AND each our ref <- exactly one
  // target ref). If a leaf is re-pointed to a DIFFERENT order, that target ref now co-occurs with two
  // distinct our refs -> the key is ambiguous -> returns null -> GAP. Returns null for any ref the map
  // does not bijectively resolve.
  basedOnOrderMate: (targetRef: string) => string | null;

  // GENERALIZED opaque-target iso-ref bijection (same fail-closed machinery as basedOnOrderMate):
  // for a reference path whose TARGET id is an opaque Epic server id absent from the target export,
  // returns the our-side ref the given target ref maps to ONLY when the (target<->our) pairing is a
  // strict BIJECTION across all aligned resource pairs at that scope; null otherwise (-> GAP).
  // scope selects the precomputed map: MedicationRequest.medicationReference / *.specimen.* / *.evidence.*.
  refBijectionMate: (scope: string, targetRef: string) => string | null;

  // STANDARD v3-ActCode Encounter.class our builder DERIVES for the encounter with this CSN, from its
  // ADT patient class (ADT_PAT_CLASS_C_NAME in PAT_ENC_HSP ?? PAT_ENC_2) via the SAME enum map as
  // src/encounter.ts buildClass(). Lets the Encounter.class standard-vs-Epic-local tolerance VERIFY that
  // our emitted class equals the correct ADT-class-derived standard mapping (a wrong class -> mismatch ->
  // GAP). Returns null when the CSN / DB is unavailable (fail-closed -> GAP).
  encounterStdClass: (csn: string) => { system: string; code: string; display: string } | null;
}
