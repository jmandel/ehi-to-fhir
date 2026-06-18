/**
 * providers.ts — provider / care-party resolution shared across generators.
 *
 * SOURCE OF TRUTH: CLARITY_SER (the provider master; PROV_ID, PROV_NAME). The
 * selection rule for "which providers become a Practitioner" lives here once
 * (`SENTINEL_SER_IDS` + `CARE_PROV_COLUMNS` + `referencedProviderIds` +
 * `emittedPractitionerIds`) so cross-resource references never dangle: any
 * generator that wants to know "did the Practitioner generator emit this id?"
 * asks `emittedPractitionerIds()` rather than re-deriving the rule.
 *
 * Conservative false-absence: the lookup helpers (`provName`) return undefined
 * rather than guess; CALLERS choose the drop-vs-display policy.
 */
import { q, q1 } from "./db";
import { id, ref } from "./ids";
import { nn } from "./fmt";

// Non-person routing/lab sentinels in CLARITY_SER (providers-and-care-teams.md, Gotcha 4).
// 8800099 GENERIC EXTERNAL DATA PROVIDER is kept: it tags real (outside-origin) care.
// 199995 "PROVIDER, NOT IN SYSTEM", 3724611 "MAC LAB APL", E1011 "MYCHART, GENERIC PROVIDER".
export const SENTINEL_SER_IDS: ReadonlySet<string> = new Set(["199995", "3724611", "E1011"]);

/** Provider-id columns that denote a clinical actor in a CARE context (not pure billing). */
export const CARE_PROV_COLUMNS: ReadonlyArray<[string, string]> = [
  ["PAT_ENC", "VISIT_PROV_ID"], ["PAT_ENC", "PCP_PROV_ID"], ["PAT_ENC_2", "SUP_PROV_ID"],
  ["PAT_PCP", "PCP_PROV_ID"], ["PATIENT", "CUR_PCP_PROV_ID"], ["TREATMENT_TEAM", "TR_TEAM_ID"],
  ["ORDER_MED", "ORD_PROV_ID"], ["ORDER_MED", "AUTHRZING_PROV_ID"], ["ORDER_MED", "MED_PRESC_PROV_ID"],
  ["ORDER_MED", "MED_REFILL_PROV_ID"], ["ORDER_PROC", "AUTHRZING_PROV_ID"], ["ORDER_PROC", "BILLING_PROV_ID"],
  ["ORDER_PROC", "REFERRING_PROV_ID"], ["ORDER_PROC_2", "PROV_ID"], ["ORDER_PROC_2", "REFD_TO_PROV_ID"],
  ["ORDER_PROC_3", "PROVIDING_PROV_ID"], ["ORDER_SIGNED_MED", "AUTH_PROV_ID"], ["ORDER_SIGNED_MED", "ORDER_PROV_ID"],
  ["ORDER_SIGNED_PROC", "AUTH_PROV_ID"], ["ORDER_SIGNED_PROC", "ORDER_PROV_ID"], ["REFERRAL", "REFERRING_PROV_ID"],
  ["REFERRAL", "PCP_PROV_ID"], ["NOTE_ENC_INFO", "AUTH_LNKED_PROV_ID"], ["MYC_MESG", "PROV_ID"],
  ["HSP_ATND_PROV", "PROV_ID"], ["HSP_ACCT_OTHR_PROV", "OTHER_PROV_ID"], ["DOC_INFORMATION", "PERFORMING_PROV_ID"],
  ["ORDER_RAD_READING", "PROV_ID"],
];

/** Distinct provider ids referenced in any care context. */
export function referencedProviderIds(): Set<string> {
  const out = new Set<string>();
  for (const [tbl, col] of CARE_PROV_COLUMNS) {
    let rows: { v: string }[];
    try {
      rows = q<{ v: string }>(
        `SELECT DISTINCT "${col}" AS v FROM "${tbl}" WHERE "${col}" IS NOT NULL AND "${col}" <> ''`
      );
    } catch {
      continue; // table/column not present in this export
    }
    for (const r of rows) if (r.v != null) out.add(String(r.v).trim());
  }
  return out;
}

/**
 * The exact set of minted Practitioner ids (referenced ∖ sentinels ∩ CLARITY_SER) —
 * the single source of the Practitioner selection rule, so cross-resource refs never
 * dangle. Returns `id.practitioner(pid)` form (mirrors practitioner.ts).
 */
export function emittedPractitionerIds(): Set<string> {
  const out = new Set<string>();
  for (const pid of referencedProviderIds()) {
    if (SENTINEL_SER_IDS.has(pid)) continue;
    const ser = q1<{ PROV_ID: string }>(`SELECT PROV_ID FROM CLARITY_SER WHERE PROV_ID = ?`, pid);
    if (ser) out.add(id.practitioner(pid));
  }
  return out;
}

/**
 * True when a PROV_NAME denotes a lab / non-clinician resource (contains ` LAB `,
 * incl. "MAC LAB APL"). Intentionally narrower than the sentinel id-set — it catches
 * unenumerated lab resources by name. Caller decides where to apply it (e.g. encounter
 * suppresses the PART participant but still allows the REF participant).
 */
export function isNonHumanResource(provName: string | null | undefined): boolean {
  const nm = provName ?? "";
  return !!nm && / LAB /.test(` ${nm} `);
}

/**
 * Bridge a CLARITY_EMP.USER_ID (a login like "RAMMELZL") to a CLARITY_SER.PROV_ID via the
 * exact, UNAMBIGUOUS name join (CLARITY_EMP.NAME = CLARITY_SER.PROV_NAME). USER_ID lives in
 * the EMP id-space; the Practitioner domain keys on PROV_ID (SER id-space), so a reference
 * must be bridged. Returns the PROV_ID only when the login resolves to exactly one provider;
 * undefined for zero/ambiguous/empty (conservative false-absence — CALLERS choose drop-vs-display).
 */
export function empLoginToSerId(userId: string | number | null | undefined): string | undefined {
  if (!userId) return undefined;
  const sers = q<{ PROV_ID: string }>(
    `SELECT s.PROV_ID FROM CLARITY_EMP e JOIN CLARITY_SER s ON s.PROV_NAME = e.NAME WHERE e.USER_ID = ?`,
    String(userId)
  );
  return sers.length === 1 ? String(sers[0].PROV_ID) : undefined;
}

/**
 * Batch form of empLoginToSerId for hot loops: USER_ID → PROV_ID for every login that maps to
 * exactly one provider (GROUP BY USER_ID HAVING COUNT(*)=1 enforces the same unambiguity rule).
 */
export function empToSerMap(): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of q<{ USER_ID: string; PROV_ID: string }>(
    `SELECT emp.USER_ID, s.PROV_ID
       FROM CLARITY_EMP emp
       JOIN CLARITY_SER s ON s.PROV_NAME = emp.NAME
      GROUP BY emp.USER_ID HAVING COUNT(*) = 1`
  )) {
    out.set(String(e.USER_ID), String(e.PROV_ID));
  }
  return out;
}

/**
 * Resolve a bare display NAME (a CLARITY_SER.PROV_NAME) to a single PROV_ID when the name maps
 * to exactly one provider; else undefined. Distinct from empLoginToSerId (which starts from an
 * EMP login); this starts from a name already in the SER name-space.
 */
export function nameToSerId(provNm: string | null | undefined): string | undefined {
  const nm = nn(provNm);
  if (!nm) return undefined;
  const sers = q<{ PROV_ID: string }>(
    `SELECT PROV_ID FROM CLARITY_SER WHERE PROV_NAME = ?`,
    nm
  );
  return sers.length === 1 ? String(sers[0].PROV_ID) : undefined;
}

/** CLARITY_SER.PROV_NAME for a PROV_ID (display lookup, nn-guarded). */
export function provName(provId: unknown): string | undefined {
  return nn(provId)
    ? q1<{ PROV_NAME: string }>(`SELECT PROV_NAME FROM CLARITY_SER WHERE PROV_ID = ?`, String(provId))?.PROV_NAME ??
        undefined
    : undefined;
}

/** Typed Practitioner reference; undefined when provId falsy. */
export function practitionerRef(provId: string | number | null | undefined, display?: string | null): any | undefined {
  if (!provId) return undefined;
  const r: any = ref("Practitioner", id.practitioner(provId), display || undefined);
  r.type = "Practitioner";
  return r;
}

/**
 * Organization ref via id.organization(); undefined when key falsy. The CALLER passes
 * the key including any prefix (e.g. lab's `'LLB-'+RESULT_LAB_ID`) — the two key spaces
 * are not collapsed here.
 */
export function orgRef(orgKey: string | number | null | undefined, display?: string | null): any | undefined {
  if (!orgKey) return undefined;
  return ref("Organization", id.organization(orgKey), display || undefined);
}
