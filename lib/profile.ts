/**
 * profile.ts — structural shape profiling for FHIR resource arrays.
 *
 * Flattens each resource into dotted paths (array indices collapse to []), so two
 * resource sets can be compared by *which fields appear and how often* and *which
 * coding systems show up at each path*. This is the scorecard the cleanup loop reads:
 * a path present in 100% of target but 0% of generated is a missing-field gap.
 */

export type PathProfile = {
  count: number;
  paths: Record<string, number>;        // dotted path -> # resources containing it
  systems: Record<string, Record<string, number>>; // path(ending in .system) -> {systemUrl: count}
};

function walk(node: any, prefix: string, seen: Set<string>, systems: Record<string, Set<string>>) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, prefix + "[]", seen, systems);
    return;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      const p = prefix ? `${prefix}.${k}` : k;
      seen.add(p);
      if (k === "system" && typeof v === "string") {
        (systems[p] ??= new Set()).add(v);
      }
      walk(v, p, seen, systems);
    }
    return;
  }
  // leaf scalar: path already recorded by parent
}

export function profile(resources: any[]): PathProfile {
  const paths: Record<string, number> = {};
  const systems: Record<string, Record<string, number>> = {};
  for (const r of resources) {
    const seen = new Set<string>();
    const sysSeen: Record<string, Set<string>> = {};
    walk(r, "", seen, sysSeen);
    for (const p of seen) paths[p] = (paths[p] ?? 0) + 1;
    for (const [p, set] of Object.entries(sysSeen)) {
      systems[p] ??= {};
      for (const s of set) systems[p][s] = (systems[p][s] ?? 0) + 1;
    }
  }
  return { count: resources.length, paths, systems };
}

export function pct(n: number, total: number): string {
  if (total === 0) return "  -  ";
  return `${Math.round((100 * n) / total)}%`.padStart(4);
}
