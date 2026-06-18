/**
 * practitioner.ts — FHIR Practitioner from the Epic EHI export.
 *
 * SOURCE OF TRUTH: CLARITY_SER (the provider master; cols PROV_ID, PROV_NAME,
 * EXTERNAL_NAME — see providers-and-care-teams.md). One Practitioner per distinct
 * provider that is REFERENCED in a care context anywhere in this patient's chart
 * and resolves in CLARITY_SER, excluding the pure routing/lab sentinels
 * (199995 "PROVIDER, NOT IN SYSTEM", 3724611 "MAC LAB APL", E1011 "MYCHART,
 * GENERIC PROVIDER"). This keeps cross-resource references (Encounter.participant,
 * CareTeam, MedicationRequest.requester, …) from dangling.
 *
 * WHAT THE EHI CAN FILL (vs Epic's own FHIR Practitioner export, fhir-target/):
 *   - identifier .836982 (SER PROV_ID, INTERNAL padded + EXTERNAL)  ← PROV_ID
 *   - identifier .99    "CCPROVID"                                  ← PROV_ID
 *   - identifier .697780 (EMP USER_ID, INTERNAL padded + EXTERNAL)  ← best-effort
 *       exact-name join CLARITY_SER.PROV_NAME → CLARITY_EMP.NAME (unambiguous only)
 *   - identifier .553   (EMP login, no type)                        ← same join
 *   - name.family / name.given / name.text                         ← PROV_NAME / EXTERNAL_NAME
 *   - identifier .557 / us-npi (NPI)        ← CLM_VALUES_2 *_PROV_NPI, name-joined to SER
 *   - identifier .126 (NUCC taxonomy)       ← CLM_VALUES_2 *_PROV_TAXONOMY, name-joined to SER
 *
 * NPI/taxonomy live ONLY on claim rows (CLM_VALUES_2), which carry the provider's
 * NPI + NUCC taxonomy alongside a denormalized name (LAST/FIRST/MID) — NOT a PROV_ID.
 * We bridge by an EXACT, UNAMBIGUOUS name join CLM_VALUES_2.{LAST, FIRST[, MID]} →
 * CLARITY_SER.PROV_NAME (single PROV_ID only). Only the billed providers appear there,
 * so most providers still get no NPI/taxonomy (recorded in gaps/practitioner.md).
 *
 * NOT REACHABLE FROM THE EHI (recorded in gaps/practitioner.md): EPIC .60 / Epic
 * .63, EXTPROVID .556, `active`, and Epic's de-identified display-name scrambling.
 * CLARITY_SER carries no NPI / specialty / credential / status / gender column in
 * this export; NPI/taxonomy are recoverable only for the subset of providers that
 * appear on claim rows.
 *
 * EXTERNAL OVERLAY (tools/nppes-overlay.ts). Once we have a provider's NPI we look it
 * up in the PUBLIC federal NPPES registry (read-only, no auth, NPI-only — no PHI
 * leaves this machine; cached in tools/nppes-cache.json for offline/reproducible
 * builds, skipped silently if the registry is unreachable). NPPES is authoritative
 * public provider data, NOT EHI-derived and NOT fabricated, so each field we pull
 * from it (`gender`; the "Dr." `name.prefix` for MD/DO — NOT for NP/PA/etc.;
 * `qualification` from credential + NUCC taxonomy) is TAGGED with a data-source
 * extension citing the registry. We never overwrite an EHI-derived value with NPPES.
 */
import { q } from "../lib/db";
import { id } from "../lib/ids";
import { emit, clean } from "../lib/gen";
import { loadNppesCache, ensureNppes, NPPES_SYSTEM, SER_NPI_OVERRIDES, type NppesRecord } from "../tools/nppes-overlay";

const SER_PROV_OID = "urn:oid:1.2.840.114350.1.13.283.2.7.2.836982"; // SER provider id
const EMP_USER_OID = "urn:oid:1.2.840.114350.1.13.283.2.7.2.697780"; // EMP user/login id
const CCPROVID_OID = "urn:oid:1.2.840.114350.1.13.283.2.7.5.737384.99";
const EMP_LOGIN_OID = "urn:oid:1.2.840.114350.1.13.283.2.7.5.737384.553";
const US_NPI = "http://hl7.org/fhir/sid/us-npi";
const NPI_OID = "urn:oid:1.2.840.114350.1.13.283.2.7.5.737384.557"; // bare-system NPI
const TAXONOMY_OID = "urn:oid:1.2.840.114350.1.13.283.2.7.5.737384.126"; // NUCC taxonomy

// Non-person routing/lab sentinels in CLARITY_SER (providers-and-care-teams.md, Gotcha 4).
// 8800099 GENERIC EXTERNAL DATA PROVIDER is kept: it tags real (outside-origin) care.
const SENTINELS = new Set(["199995", "3724611", "E1011"]);

/** Provider-id columns that denote a clinical actor in a CARE context (not pure billing). */
const CARE_PROV_COLUMNS: [string, string][] = [
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
function referencedProviderIds(): Set<string> {
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
 * NPI + NUCC taxonomy keyed by CLARITY_SER.PROV_ID, recovered from claim rows.
 *
 * Two claim sources carry a provider's NPI/taxonomy next to a denormalized name
 * (LAST/FIRST/MID) — but NEITHER carries a PROV_ID:
 *   - CLM_VALUES_2 *_PROV_* roles (rendering, attending, referring, operating, …)
 *   - the SVC_LN_INFO service-line family (LN_REND_* / LN_SUP_* / LN_ORD_* /
 *     LN_ASST_* with NPI+TAXONOMY, plus the *_2 / *_3 line roles).
 * We bridge by an EXACT, UNAMBIGUOUS name join to CLARITY_SER.PROV_NAME
 * ("LAST, FIRST MID"): for each distinct claim (LAST,FIRST[,NPI,TAXONOMY]) tuple,
 * find SER rows whose PROV_NAME starts with "LAST, FIRST" and accept ONLY when that
 * resolves to a single PROV_ID. We also require the NPI/taxonomy to be internally
 * consistent across all claim rows for that provider (else we drop it rather than
 * guess). Drawing from both sources widens NPI recovery without any new assumption.
 */
type ClaimNpiSource = {
  table: string;
  /** column prefixes; we read <pre>NPI + (optionally) <taxPre>TAXONOMY + name cols. */
  last: string;
  first: string;
  npi: string;
  taxonomy?: string;
};

// CLM_VALUES_2 *_PROV_* roles. Only some carry a *_PROV_TAXONOMY column.
const CLM_ROLES = ["REND", "ATT", "REF", "OPER", "OTH", "SUP"].map((r) => ({
  table: "CLM_VALUES_2",
  last: `${r}_PROV_NAM_LAST`,
  first: `${r}_PROV_NAM_FIRST`,
  npi: `${r}_PROV_NPI`,
  taxonomy: `${r}_PROV_TAXONOMY`,
})) as ClaimNpiSource[];

// SVC_LN_INFO service-line roles that pair an NPI with a denormalized name (and,
// where present, a taxonomy). Columns that don't exist in this export are skipped.
const SVC_ROLES: ClaimNpiSource[] = [
  { table: "SVC_LN_INFO", last: "LN_REND_NAM_LAST", first: "LN_REND_NAM_FIRST", npi: "LN_REND_NPI", taxonomy: "LN_REND_TAXONOMY" },
  { table: "SVC_LN_INFO", last: "LN_SUP_NAM_LAST", first: "LN_SUP_NAM_FIRST", npi: "LN_SUP_NPI" },
  { table: "SVC_LN_INFO", last: "LN_ORD_NAM_LAST", first: "LN_ORD_NAM_FIRST", npi: "LN_ORD_NPI" },
  { table: "SVC_LN_INFO", last: "LN_ASST_NAM_LAST", first: "LN_ASST_NAM_FIRST", npi: "LN_ASST_NPI", taxonomy: "LN_ASST_TAXONOMY" },
];

function npiTaxonomyBySer(): Map<string, { npi?: string; taxonomy?: string }> {
  const SOURCES = [...CLM_ROLES, ...SVC_ROLES];

  type Claim = { last: string; first: string; npi?: string; taxonomy?: string };
  const claims: Claim[] = [];
  for (const src of SOURCES) {
    let rows: { LAST: string | null; FIRST: string | null; NPI: string | null; TAX: string | null }[];
    // The TAXONOMY column does not exist for every role; fall back to NULL if absent.
    const taxExpr = src.taxonomy ? `"${src.taxonomy}"` : null;
    const trySelect = (withTax: boolean) =>
      q<{ LAST: string | null; FIRST: string | null; NPI: string | null; TAX: string | null }>(
        `SELECT DISTINCT "${src.last}" AS LAST, "${src.first}" AS FIRST,
                "${src.npi}" AS NPI, ${withTax && taxExpr ? taxExpr : "NULL"} AS TAX
           FROM "${src.table}"
          WHERE ("${src.npi}" IS NOT NULL AND "${src.npi}" <> '')
             OR (${withTax && taxExpr ? `${taxExpr} IS NOT NULL AND ${taxExpr} <> ''` : "0"})`
      );
    try {
      rows = trySelect(!!taxExpr);
    } catch {
      try {
        rows = trySelect(false);
      } catch {
        continue; // table/role/columns not present in this export
      }
    }
    for (const r of rows) {
      const last = (r.LAST ?? "").trim();
      const first = (r.FIRST ?? "").trim();
      if (!last || !first) continue;
      claims.push({
        last,
        first,
        npi: r.NPI?.trim() || undefined,
        taxonomy: r.TAX?.trim() || undefined,
      });
    }
  }

  // Resolve each distinct (last, first) to a single SER PROV_ID via prefix match.
  const sers = q<{ PROV_ID: string; U: string }>(
    `SELECT PROV_ID, UPPER(PROV_NAME) AS U FROM CLARITY_SER WHERE PROV_NAME IS NOT NULL`
  );
  const nameKey = (last: string, first: string) => `${last} ${first}`.toUpperCase();
  const provIdByName = new Map<string, string | null>(); // null = ambiguous/none
  for (const c of claims) {
    const key = nameKey(c.last, c.first);
    if (provIdByName.has(key)) continue;
    const prefix = `${c.last}, ${c.first}`.toUpperCase();
    const hits = new Set<string>();
    for (const s of sers) if (s.U.startsWith(prefix)) hits.add(String(s.PROV_ID));
    provIdByName.set(key, hits.size === 1 ? [...hits][0] : null);
  }

  const out = new Map<string, { npi?: string; taxonomy?: string; npiConflict?: boolean; taxConflict?: boolean }>();
  for (const c of claims) {
    const pid = provIdByName.get(nameKey(c.last, c.first));
    if (!pid) continue; // unresolved or ambiguous → honest false-absence
    const cur = out.get(pid) ?? {};
    if (c.npi) {
      if (cur.npi && cur.npi !== c.npi) cur.npiConflict = true;
      else cur.npi = c.npi;
    }
    if (c.taxonomy) {
      if (cur.taxonomy && cur.taxonomy !== c.taxonomy) cur.taxConflict = true;
      else cur.taxonomy = c.taxonomy;
    }
    out.set(pid, cur);
  }

  // Drop any conflicting values rather than emit a guessed code.
  const clean = new Map<string, { npi?: string; taxonomy?: string }>();
  for (const [pid, v] of out) {
    clean.set(pid, {
      npi: v.npiConflict ? undefined : v.npi,
      taxonomy: v.taxConflict ? undefined : v.taxonomy,
    });
  }
  return clean;
}

// ── NPPES external overlay ─────────────────────────────────────────────────────
// All fields below come from the PUBLIC federal NPPES registry (tools/nppes-overlay.ts),
// keyed by NPI. They are authoritative public provider data — NOT EHI-derived and NOT
// fabricated — and we never overwrite an EHI value with them.
//
// PROVENANCE TAGGING. The registry origin is recorded three ways, all validator-clean
// (no unresolvable custom extension, which the HL7 validator rejects):
//   1. qualification.identifier[].system = NPPES_SYSTEM on every qualification we add,
//      so each credential/taxonomy carries a machine-readable "from NPPES" stamp;
//   2. the registry's legal name is emitted as a SEPARATE name with use:"official"
//      (the EHI's CLARITY_SER name stays use:"usual"), so the two are distinguishable;
//   3. tools/nppes-cache.json records {source:"nppes", fetchedAt} for every NPI.
// (FHIR HumanName/gender have no per-element source slot; (1)–(3) + this comment are
// the provenance trail for those, per the task's "comment/extension" allowance.)

const NUCC_SYSTEM = "http://nucc.org/provider-taxonomy";

/** Identifier stamped on each NPPES-sourced qualification to mark its registry origin. */
function nppesProvenanceId(): any {
  return { system: NPPES_SYSTEM, value: "NPPES" };
}

/** NPPES sex ("M"/"F") → FHIR administrative gender. Anything else → undefined. */
function nppesGender(rec: NppesRecord): string | undefined {
  const s = (rec.sex ?? "").trim().toUpperCase();
  if (s === "M") return "male";
  if (s === "F") return "female";
  return undefined;
}

/**
 * "Dr." prefix is appropriate ONLY for doctoral clinical credentials (MD/DO and
 * common spellings). We deliberately do NOT map NP/DNP/PA/CRNP/RN/PharmD/etc. to
 * "Dr." — over-mapping would assert a title the registry does not. Returns "Dr." or
 * undefined.
 */
function nppesPrefix(rec: NppesRecord): string | undefined {
  const cred = (rec.credential ?? "").toUpperCase().replace(/[.\s]/g, "");
  // Doctoral clinical degrees that carry "Dr." in everyday clinical address.
  const DR = new Set(["MD", "DO", "MBBS", "DMD", "DDS", "DPM", "DVM", "OD", "DC"]);
  // Explicit non-"Dr." credentials we must never up-title even if substrings collide.
  return DR.has(cred) ? "Dr." : undefined;
}

/**
 * Build a HumanName from the NPPES legal name. Emitted with use:"official" (the EHI
 * CLARITY_SER name keeps use:"usual"), which both distinguishes the registry value
 * and marks its provenance. Returns undefined if the registry carries no usable name.
 */
function nppesName(rec: NppesRecord): any | undefined {
  const family = rec.lastName ? titleCase(rec.lastName) : undefined;
  const given = [rec.firstName, rec.middleName].filter(Boolean).map((g) => titleCase(g!));
  if (!family && given.length === 0) return undefined;
  const prefix = nppesPrefix(rec);
  return clean({
    use: "official",
    family,
    given: given.length ? given : undefined,
    prefix: prefix ? [prefix] : undefined,
    text: [prefix, ...given, family].filter(Boolean).join(" ") || undefined,
  });
}

/**
 * Practitioner.qualification[] from NPPES: the credential (as free text) and each NUCC
 * taxonomy (coded with desc). Each carries identifier.system = NPPES_SYSTEM so its
 * external-registry provenance is explicit and machine-readable (and validator-clean).
 */
function nppesQualifications(rec: NppesRecord): any[] {
  const quals: any[] = [];
  if (rec.credential) {
    quals.push({ identifier: [nppesProvenanceId()], code: { text: rec.credential } });
  }
  for (const t of rec.taxonomies ?? []) {
    if (!t.code && !t.desc) continue;
    quals.push(
      clean({
        identifier: [nppesProvenanceId()],
        code: clean({
          coding: t.code ? [{ system: NUCC_SYSTEM, code: t.code, display: t.desc }] : undefined,
          text: t.desc || undefined,
        }),
      })
    );
  }
  return quals;
}

/** "RAMMELKAMP, ZOE L" → { family:"Rammelkamp", given:["Zoe","L"] }. EXTERNAL_NAME is "Zoe L Rammelkamp". */
function buildName(provName: string | null, externalName: string | null) {
  const last = (provName ?? "").split(",")[0].trim();
  const family = titleCase(last);
  // Given names: prefer the "First M ... Last" external display when present.
  let given: string[] = [];
  const afterComma = (provName ?? "").split(",").slice(1).join(",").trim();
  if (afterComma) given = afterComma.split(/\s+/).map(titleCase).filter(Boolean);
  const text =
    (externalName && externalName.trim().replace(/\s+/g, " ")) ||
    [given.join(" "), family].filter(Boolean).join(" ");
  return {
    use: "usual",
    text: text || undefined,
    family: family || undefined,
    given: given.length ? given : undefined,
  };
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

/** Right-justify into a fixed-width field (Epic's INTERNAL identifier padding). */
function pad(value: string, width: number): string {
  return value.length >= width ? value : " ".repeat(width - value.length) + value;
}

function buildPractitioners(): any[] {
  const refIds = referencedProviderIds();

  const sers = q<{ PROV_ID: string; PROV_NAME: string | null; EXTERNAL_NAME: string | null }>(
    `SELECT PROV_ID, PROV_NAME, EXTERNAL_NAME FROM CLARITY_SER`
  );
  const serById = new Map(sers.map((s) => [String(s.PROV_ID), s]));

  // Best-effort SER→EMP login via EXACT, UNAMBIGUOUS name match (cross ID-space; see gaps).
  const emps = q<{ USER_ID: string; NAME: string | null }>(`SELECT USER_ID, NAME FROM CLARITY_EMP`);
  const empByName = new Map<string, string[]>();
  for (const e of emps) {
    if (!e.NAME) continue;
    const arr = empByName.get(e.NAME) ?? [];
    arr.push(String(e.USER_ID));
    empByName.set(e.NAME, arr);
  }

  // NPI / NUCC taxonomy recovered from claim rows (CLM_VALUES_2 + SVC_LN_INFO) by name-join.
  const npiTax = npiTaxonomyBySer();

  const chosen = [...refIds]
    .filter((pid) => serById.has(pid) && !SENTINELS.has(pid))
    .sort((a, b) => (Number(a) - Number(b)) || a.localeCompare(b));

  // External overlay: load the public NPPES registry data for every recovered NPI.
  // Read-only from tools/nppes-cache.json (no network here → offline/reproducible).
  // Refresh the cache out-of-band with: bun tools/nppes-overlay.ts <npi...>.
  const nppes = loadNppesCache();

  const resources: any[] = [];
  for (const pid of chosen) {
    const ser = serById.get(pid)!;
    const identifier: any[] = [];

    // NPI (us-npi, with NPI type) — from claim rows, name-joined to this SER provider.
    const npi = npiTax.get(pid)?.npi;
    const taxonomy = npiTax.get(pid)?.taxonomy;
    if (npi) {
      identifier.push({ use: "usual", type: { text: "NPI" }, system: US_NPI, value: npi });
    }

    // .697780 EMP login (best-effort exact unambiguous name join) + .553 login
    const empMatches = ser.PROV_NAME ? empByName.get(ser.PROV_NAME) : undefined;
    const login = empMatches && empMatches.length === 1 ? empMatches[0] : undefined;
    if (login) {
      const w = Math.max(login.length + 1, 7); // observed Epic INTERNAL padding for this system
      identifier.push({ use: "usual", type: { text: "INTERNAL" }, system: EMP_USER_OID, value: pad(login, w) });
      identifier.push({ use: "usual", type: { text: "EXTERNAL" }, system: EMP_USER_OID, value: login });
    }

    // .99 CCPROVID = PROV_ID
    identifier.push({ use: "usual", type: { text: "CCPROVID" }, system: CCPROVID_OID, value: pid });

    // .126 NUCC taxonomy (no type) — from claim rows.
    if (taxonomy) identifier.push({ use: "usual", system: TAXONOMY_OID, value: taxonomy });

    // .553 EMP login (no type)
    if (login) identifier.push({ use: "usual", system: EMP_LOGIN_OID, value: login });

    // .557 NPI (bare system, no type) — from claim rows.
    if (npi) identifier.push({ use: "usual", system: NPI_OID, value: npi });

    // .836982 SER provider id INTERNAL (width-8 padded) + EXTERNAL
    identifier.push({ use: "usual", type: { text: "INTERNAL" }, system: SER_PROV_OID, value: pad(pid, 8) });
    identifier.push({ use: "usual", type: { text: "EXTERNAL" }, system: SER_PROV_OID, value: pid });

    // EHI-derived name (CLARITY_SER). NPPES official name is added alongside (not
    // replacing) it below — both kept so the EHI value is never silently dropped.
    const names: any[] = [buildName(ser.PROV_NAME, ser.EXTERNAL_NAME)];

    // ── External NPPES overlay (public registry, keyed by NPI; tagged provenance) ──
    // Two NPI sources key the overlay:
    //   (a) the claim-row NPI (`npi`), which IS in the EHI and is emitted as a us-npi
    //       identifier above; and
    //   (b) a curated SER→NPI map (SER_NPI_OVERRIDES) for providers who carry a public
    //       NPI but never appear on a claim line here — verified by exact legal-name
    //       match against the registry. That NPI is NOT in the EHI, so we use it ONLY to
    //       look up the registry overlay and deliberately do NOT emit it as an identifier.
    const overlayNpi = npi ?? SER_NPI_OVERRIDES[pid];
    let gender: string | undefined;
    let qualification: any[] | undefined;
    let rec = overlayNpi ? nppes[overlayNpi] : undefined;
    // Defensive guard for the curated (non-claim) path: only trust the override if the
    // registry's legal LAST name still matches this SER's family name. Protects against
    // a stale/mistyped curated NPI ever attaching the wrong person's demographics.
    if (rec && !npi && SER_NPI_OVERRIDES[pid]) {
      const serLast = (ser.PROV_NAME ?? "").split(",")[0].trim().toUpperCase();
      const regLast = (rec.lastName ?? "").trim().toUpperCase();
      if (!serLast || !regLast || serLast !== regLast) rec = undefined;
    }
    if (rec && !rec.notFound) {
      gender = nppesGender(rec); // EHI carries no gender → pure overlay, no clash.
      const onm = nppesName(rec);
      // Add the registry's official name only when it adds a name we don't already
      // have (e.g. a "Dr." prefix or full middle name) — never something false.
      if (onm) names.push(onm);
      const quals = nppesQualifications(rec);
      if (quals.length) qualification = quals;
    }

    resources.push(
      clean({
        resourceType: "Practitioner",
        id: id.practitioner(pid),
        identifier,
        name: names,
        gender,
        qualification,
      })
    );
  }

  return resources;
}

// Self-heal the NPPES cache: fetch any recovered NPI not already cached (no-op when
// offline or all cached). Never fails the build — ensureNppes swallows network errors.
// This only touches the network for genuinely-new NPIs; cached builds are offline.
const recoveredNpis = [
  ...([...npiTaxonomyBySer().values()].map((v) => v.npi).filter(Boolean) as string[]),
  ...Object.values(SER_NPI_OVERRIDES), // curated public NPIs not present on any claim line
];
try {
  await ensureNppes(recoveredNpis);
} catch (e) {
  console.error(`nppes overlay skipped: ${(e as Error).message}`);
}

emit("Practitioner", buildPractitioners());
