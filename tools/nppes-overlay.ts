#!/usr/bin/env bun
/**
 * nppes-overlay.ts — external authoritative overlay for provider demographics.
 *
 * WHAT THIS IS (and is not). The EHI export carries each billed provider's NPI
 * (a public 10-digit national identifier) on the claim service lines
 * (SVC_LN_INFO.LN_REND_NPI / LN_SUP_NPI / LN_ORD_NPI / LN_PCP_REF_NPI, and the
 * CLM_VALUES_2 *_PROV_NPI roles). The NPI is NOT patient data — it identifies the
 * clinician, and the federal NPPES registry publishes a free, read-only, no-auth
 * lookup of public provider attributes (legal name, credential, sex, NUCC
 * taxonomy). This module looks those up so we can fill demographics CLARITY_SER
 * does not carry (gender, the "Dr." prefix, credential/qualification).
 *
 * PRIVACY POSTURE. We send ONLY the NPI to npiregistry.cms.hhs.gov — never any
 * patient identifier, name, DOB, or other PHI. The NPI and everything returned is
 * already-public provider directory data. Results are cached to tools/nppes-cache.json
 * so the build is reproducible and works offline; the network is only touched when
 * an NPI is missing from the cache (or `--refresh` is passed).
 *
 * GRACEFUL DEGRADATION. If the registry is unreachable we use whatever is cached and
 * skip the rest — we NEVER fail the build and NEVER fabricate. Anything we DO emit
 * from here is tagged (see practitioner.ts) as external-registry-sourced so it is
 * never confused with EHI-derived data.
 *
 * USAGE
 *   bun tools/nppes-overlay.ts 1205323193 1790854107   # fetch/refresh these NPIs into cache
 *   bun tools/nppes-overlay.ts --refresh <npi...>       # force re-fetch even if cached
 * As a library:
 *   import { loadNppesCache, ensureNppes, NPPES_SYSTEM } from "./nppes-overlay";
 */
import { resolve } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";

const CACHE_PATH = resolve(import.meta.dir, "nppes-cache.json");
const API = "https://npiregistry.cms.hhs.gov/api/?version=2.1&number=";

/** Provenance marker so downstream code can tag fields as registry-sourced. */
export const NPPES_SYSTEM = "https://npiregistry.cms.hhs.gov";

/**
 * Curated SER PROV_ID → public NPI map.
 *
 * Most providers get their NPI for free from the claim rows (name-joined to SER in
 * practitioner.ts), but some clinicians who DO carry a public NPI never appear on a
 * claim service line in this export (they were not billed under their own NPI here),
 * so claim-row recovery yields nothing for them. The NPI is a public, federal,
 * non-PHI identifier; where we can establish the SER↔NPI correspondence by exact
 * legal-name match against the public NPPES registry, we record it here so the same
 * read-only registry overlay (gender, "Dr." prefix) can be applied. Each entry below
 * is name-verified against the registry (see nppes-cache.json) — NOT guessed, and
 * never overriding anything the EHI itself carries.
 *
 * Verified 2026-06-17 against npiregistry.cms.hhs.gov (legal name == CLARITY_SER):
 *   132946 CAHILL, KATHRYN A → 1891752184 (Kathryn Cahill, MD)
 *   137975 SHORE,  MATTHEW W → 1669814737 (Matthew Shore, M.D.)
 *   599471 GILMOUR, AARON K  → 1073140950 (Aaron Gilmour, OTR/L)
 */
export const SER_NPI_OVERRIDES: Record<string, string> = {
  "132946": "1891752184",
  "137975": "1669814737",
  "599471": "1073140950",
};

/** The normalized subset of public NPPES fields we keep (no PHI; provider-only). */
export interface NppesRecord {
  npi: string;
  enumerationType?: string; // "NPI-1" (individual) / "NPI-2" (org)
  firstName?: string;
  middleName?: string;
  lastName?: string;
  namePrefix?: string;
  nameSuffix?: string;
  credential?: string; // raw registry credential string, e.g. "MD", "D.O.", "CRNP"
  sex?: string; // "M" | "F"
  taxonomies?: { code?: string; desc?: string; primary?: boolean }[];
  /** Bookkeeping: when this entry was last written, and whether the NPI had no NPPES match. */
  fetchedAt?: string;
  notFound?: boolean;
  source: "nppes";
}

export type NppesCache = Record<string, NppesRecord>;

export function loadNppesCache(): NppesCache {
  if (!existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8")) as NppesCache;
  } catch {
    return {};
  }
}

function saveCache(cache: NppesCache): void {
  // Stable key order for reproducible diffs.
  const ordered: NppesCache = {};
  for (const k of Object.keys(cache).sort()) ordered[k] = cache[k];
  writeFileSync(CACHE_PATH, JSON.stringify(ordered, null, 2) + "\n");
}

/** Map one raw NPPES API result object → our normalized record. */
function normalize(npi: string, result: any): NppesRecord {
  const basic = result?.basic ?? {};
  const taxes = Array.isArray(result?.taxonomies) ? result.taxonomies : [];
  return {
    npi,
    enumerationType: result?.enumeration_type || undefined,
    firstName: basic.first_name || undefined,
    middleName: basic.middle_name || undefined,
    lastName: basic.last_name || undefined,
    namePrefix: basic.name_prefix || undefined,
    nameSuffix: basic.name_suffix || undefined,
    credential: basic.credential || undefined,
    sex: basic.sex || basic.gender || undefined,
    taxonomies: taxes.map((t: any) => ({
      code: t.code || undefined,
      desc: t.desc || undefined,
      primary: !!t.primary,
    })),
    fetchedAt: new Date().toISOString(),
    source: "nppes",
  };
}

/**
 * Fetch a single NPI from the live registry. Returns the normalized record, a
 * notFound stub if the registry has no such NPI, or undefined if the network failed
 * (caller should fall back to cache / skip — never throw).
 */
async function fetchNpi(npi: string): Promise<NppesRecord | undefined> {
  try {
    const res = await fetch(API + encodeURIComponent(npi), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.error(`nppes: HTTP ${res.status} for ${npi} — skipping`);
      return undefined;
    }
    const json: any = await res.json();
    const results = Array.isArray(json?.results) ? json.results : [];
    if (results.length === 0) {
      return { npi, notFound: true, fetchedAt: new Date().toISOString(), source: "nppes" };
    }
    return normalize(npi, results[0]);
  } catch (e) {
    console.error(`nppes: network unreachable for ${npi} (${(e as Error).message}) — using cache/skip`);
    return undefined;
  }
}

/**
 * Ensure each NPI is present in the cache, fetching the missing ones. Returns the
 * (possibly updated) cache. On any network failure we keep whatever we have and move
 * on — the build must never depend on the registry being reachable.
 *
 * @param refresh re-fetch even NPIs already cached.
 */
export async function ensureNppes(npis: Iterable<string>, opts: { refresh?: boolean } = {}): Promise<NppesCache> {
  const cache = loadNppesCache();
  const want = [...new Set([...npis].map((n) => String(n).trim()).filter(Boolean))];
  const todo = want.filter((n) => opts.refresh || !(n in cache));
  if (todo.length === 0) return cache;

  let networkOk = false;
  let dirty = false;
  for (const npi of todo) {
    const rec = await fetchNpi(npi);
    if (rec) {
      cache[npi] = rec;
      networkOk = true;
      dirty = true;
    }
  }
  if (dirty) saveCache(cache);
  if (!networkOk && todo.length > 0) {
    console.error(`nppes: registry unreachable; ${todo.length} NPI(s) left to cache — continuing with cache only`);
  }
  return cache;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const args = process.argv.slice(2);
  const refresh = args.includes("--refresh");
  const npis = args.filter((a) => /^\d{10}$/.test(a));
  if (npis.length === 0) {
    console.error("usage: bun tools/nppes-overlay.ts [--refresh] <npi> [<npi> ...]");
    process.exit(2);
  }
  const cache = await ensureNppes(npis, { refresh });
  const hit = npis.filter((n) => cache[n] && !cache[n].notFound).length;
  const missing = npis.filter((n) => !cache[n] || cache[n].notFound);
  console.error(`nppes: ${hit}/${npis.length} resolved into ${CACHE_PATH}`);
  if (missing.length) console.error(`nppes: unresolved (not in registry or unreachable): ${missing.join(", ")}`);
}
