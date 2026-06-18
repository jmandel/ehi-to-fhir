/**
 * fmt.ts — value/row-shape primitives shared across domain generators.
 *
 * Pure formatting helpers with no DB or id concern: the universal TEXT-column
 * normalizer (`nn`), FHIR Money construction (`money`), the shared
 * `*_C_NAME`→code lookup mechanism (`enumMap` — the map TABLES stay per-domain),
 * first-non-empty coalescing (`coalesceName`), and Epic ALL-CAPS humanization
 * (`titleCaseName`). The emit-contract (`clean`) stays in gen.ts.
 */

/** Trim a DB TEXT value; undefined for null/undefined/empty-after-trim. */
export function nn(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

/**
 * FHIR Money(USD) from a textual or numeric amount; undefined for
 * null/empty/non-numeric. `opts.round` rounds to cents — for computed-number
 * callers (eob/claim sums) that must not leak floating-point tails.
 */
export function money(
  v: unknown,
  opts?: { round?: boolean },
): { value: number; currency: string } | undefined {
  const s = nn(v);
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) return undefined;
  return { value: opts?.round ? Math.round(n * 100) / 100 : n, currency: "USD" };
}

/**
 * The shared `*_C_NAME`→code lookup mechanism with never-guess fallthrough:
 * trims the key, returns `map[key]` or undefined. The map TABLES stay
 * per-domain (immunization status ≠ careplan goal status, etc.).
 */
export function enumMap<V>(value: unknown, map: Record<string, V>): V | undefined {
  const k = nn(value);
  if (k === undefined) return undefined;
  return map[k];
}

/** First non-empty trimmed value — `nn(a) ?? nn(b) ?? ...`. */
export function coalesceName(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    const s = nn(v);
    if (s !== undefined) return s;
  }
  return undefined;
}

/**
 * Title-case a single whitespace-delimited token (`w[0]+w.slice(1).toLowerCase()`)
 * to humanize ALL-CAPS Epic names. Empty input is returned unchanged.
 */
export function titleCaseName(w: string): string {
  return w ? w[0] + w.slice(1).toLowerCase() : w;
}
