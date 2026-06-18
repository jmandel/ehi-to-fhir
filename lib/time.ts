/**
 * time.ts — the one timezone/datetime module for EHI→FHIR.
 *
 * Built ON `lib/db.ts`'s `parseEpicDateTime` (which stays a FLOATING local datetime,
 * zone-agnostic) and `naiveLocal` (the time-bearing front-half). This file owns the
 * date-only and UTC-instant emit shapes shared across the domain generators.
 *
 * Helpers, by timezone-bearing-ness:
 *   org-INDEPENDENT (no tz):
 *     - `isoDate`           : date-only YYYY-MM-DD
 *     - `utcFromUtcColumn`  : read a genuine *_UTC_DTTM column (already UTC) and stamp Z
 *   timezone-bearing (the ONLY routines that consult `EHI_TZ`):
 *     - `localToUtcInstant`        : wall-clock local → UTC instant; prefers a paired
 *                                    *_UTC_DTTM sibling (exact per-record offset), else
 *                                    converts a naive local via `tz=EHI_TZ`.
 *     - `localMidnightToUtcInstant`: a YYYY-MM-DD calendar day's local midnight → UTC
 *                                    instant (the social-history snapshot semantics).
 */
import { parseEpicDateTime } from "./db";

/**
 * The single configured org timezone. Cross-org deployments set EHI_TZ; the default
 * matches this export's source instance (US Central). Every wall-clock→UTC conversion
 * routes through this — there are no other hardcoded zone offsets in the pipeline.
 */
export const EHI_TZ = process.env.EHI_TZ ?? "America/Chicago";

/**
 * Date-only "YYYY-MM-DD" from an Epic textual datetime. When the parsed value carries a
 * time-of-day it is truncated to the date; when it does not (already date-only), the
 * parsed value is returned unchanged — the most defensive variant (never fabricates a
 * truncation on a value that had no `T`).
 */
export function isoDate(v: unknown): string | undefined {
  const iso = parseEpicDateTime(v);
  if (!iso) return undefined;
  return iso.includes("T") ? iso.slice(0, 10) : iso;
}

/**
 * Read a genuine `*_UTC_DTTM` column — already a UTC wall-clock — and stamp `Z`.
 * NO offset math: the value is already UTC, so applying a tz offset would double-shift
 * it. Returns undefined when the value carries no time-of-day. (DNM #2.)
 */
export function utcFromUtcColumn(v: unknown): string | undefined {
  const iso = parseEpicDateTime(v);
  return iso && iso.includes("T") ? `${iso}Z` : undefined;
}

/** Format an ISO instant with the milliseconds stripped (`.000Z` / `.123Z` → `Z`). */
function stampZ(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Offset (ms to ADD to a local-wall-clock-read-as-UTC value to reach true UTC) for a
 * given naive local datetime in `tz`. Uses a real IANA tz database via Intl, so DST
 * transitions are exact for any zone — no hand-rolled nth-Sunday rule. For
 * America/Chicago this returns exactly the +6h (CST) / +5h (CDT) the legacy routines
 * computed, so those instants stay byte-identical.
 *
 * Derivation: format the candidate UTC instant back into `tz` and measure how far the
 * rendered local wall clock drifts from the intended local wall clock; that drift is
 * the offset. One refinement pass handles the offset-of-the-offset near transitions.
 */
function tzOffsetMs(Y: number, MO: number, D: number, h: number, mi: number, s: number, tz: string): number {
  const intended = Date.UTC(Y, MO - 1, D, h, mi, s);
  const localAsUtcAt = (utcMs: number): number => {
    const p = TZ_FMT(tz).formatToParts(new Date(utcMs));
    const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
    let hr = g("hour");
    if (hr === 24) hr = 0; // some engines render midnight as 24
    return Date.UTC(g("year"), g("month") - 1, g("day"), hr, g("minute"), g("second"));
  };
  // First guess: assume the intended instant IS UTC; measure the rendered drift.
  let off = intended - localAsUtcAt(intended);
  // Refine once: re-measure at the corrected instant (covers the DST gap/overlap edges).
  off = intended - localAsUtcAt(intended + off) + off;
  return off;
}

const _fmtCache = new Map<string, Intl.DateTimeFormat>();
function TZ_FMT(tz: string): Intl.DateTimeFormat {
  let f = _fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    _fmtCache.set(tz, f);
  }
  return f;
}

/**
 * THE central wall-clock→UTC converter.
 *
 * Resolution order:
 *   1. `opts.utcSibling` — when the record carries a paired genuine `*_UTC_DTTM` value,
 *      derive the EXACT per-record offset from the local↔UTC pair (lab's per-order
 *      approach, org-INDEPENDENT). This is preferred whenever available (DNM #1).
 *   2. else convert the naive local datetime as `tz` (default `EHI_TZ`) wall time using
 *      a real IANA tz database (exact DST for any zone).
 *   3. naive + `Z` as a last resort when no offset can be derived (no time-of-day, or
 *      the sibling parsed but `tz` is somehow unresolvable).
 *
 * Returns undefined when the local value carries no time-of-day (date-only / empty).
 */
export function localToUtcInstant(
  localVal: unknown,
  opts?: { utcSibling?: unknown; tz?: string }
): string | undefined {
  const local = parseEpicDateTime(localVal);
  if (!local || !local.includes("T")) return undefined;

  // 1. Sibling-derived exact offset (preferred; org-independent).
  if (opts?.utcSibling !== undefined) {
    const sib = parseEpicDateTime(opts.utcSibling);
    if (sib && sib.includes("T")) {
      const offsetMs = new Date(`${sib}Z`).getTime() - new Date(`${local}Z`).getTime();
      return stampZ(new Date(`${local}Z`).getTime() + offsetMs);
    }
  }

  // Parse the naive local components.
  const [d, t] = local.split("T");
  const [Y, MO, D] = d.split("-").map(Number);
  const [h, mi, s] = t.split(":").map((x) => Number(x ?? 0));

  // 2. tz-aware conversion via the real tz database.
  const tz = opts?.tz ?? EHI_TZ;
  const off = tzOffsetMs(Y, MO, D, h, mi, s || 0, tz);
  if (Number.isFinite(off)) {
    return stampZ(Date.UTC(Y, MO - 1, D, h, mi, s || 0) + off);
  }

  // 3. last resort: naive + Z.
  return `${local}Z`;
}

/**
 * A YYYY-MM-DD calendar day's LOCAL MIDNIGHT (in `tz`, default `EHI_TZ`) as a UTC
 * instant — the social-history snapshot/review semantics (a summer/CDT date renders
 * ...T05:00:00Z, a winter/CST date ...T06:00:00Z for America/Chicago). Kept distinct
 * from the wall-clock converter on purpose (DNM #3).
 */
export function localMidnightToUtcInstant(isoDate: string, tz?: string): string | undefined {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return undefined;
  const [Y, MO, D] = isoDate.split("-").map(Number);
  const off = tzOffsetMs(Y, MO, D, 0, 0, 0, tz ?? EHI_TZ);
  return stampZ(Date.UTC(Y, MO - 1, D, 0, 0, 0) + off);
}
