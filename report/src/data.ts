// Centralized, typed access to the inlined data + content.
import raw from "../viewer/data.json";
import leanRaw from "../viewer/data-lean.json";
import { content } from "./content";
import summariesJson from "./summaries.json";

export type Delta = {
  path: string;
  status: "TOLERATED" | "GAP";
  targetVal: any;
  ourVal: any;
  rationale: string;
  ruleId?: string;
  kind?: string;   // equivalence family key (TOLERATED)
  cls?: string;
  family?: string; // couldnt family key (GAP)
};
export type Pair = {
  rt: string; subgroup: string; key: string; tgtId: string; ourId: string;
  target: any; ours: any; deltas: Delta[]; exact: number; tol: number; gap: number;
};
export type CantRepro = { rt: string; key: string; tgtId: string | null; subgroup: string; target: any; reason: string; family: string };
export type OurOnly = { rt: string; key: string; ourId: string; subgroup: string; our: any };
export type NewRes = { rt: string; id: string; subgroup: string; our: any };
export type PerType = Record<string, { exact: number; tolerated: number; gap: number }>;

export type Decomposition = { exportIdentical: number; exportEquivalent: number; bridgeVocab: number; bridgeIdentifier: number; bridgeOther: number; different: number; absent: number };
export type Dataset = {
  summary: { exact: number; tolerated: number; gap: number; total: number; reconciles: boolean; gapByClass: Record<string, number>; perType: PerType; decomposition: Decomposition | null };
  pairs: Pair[];
  cantReproduce: CantRepro[];
  ourOnly: OurOnly[];
  newResources: NewRes[];
  samples: Record<string, { subgroup: string; count: number; mostDivergent: { tgtId: string; why: string }; cleanest: { tgtId: string; why: string } }[]>;
};
// `data` = canonical (crosswalk / terminology bridge ON) — drives the headline, scorecard, families.
// `leanData` = the honest "raw export only" view (no bridge): coded concepts collapse to text-only.
export const data = raw as unknown as Dataset;
export const leanData = leanRaw as unknown as Dataset;

export const C = content;
export const summaries = summariesJson as Record<string, {
  plainName: string; whatItIs: string; rebuiltFrom: string; howFaithful: string;
  whatsIdentical: string; whatDiffersAndWhy: string; whatsLost: string; mostInterestingTrick: string;
}>;

// bucket colors (shared with content.buckets)
export const BUCKET = {
  identical: { name: "Identical", color: "#1a7f37", bg: "#eaf6ec" },
  equivalent: { name: "Equivalent", color: "#bf8700", bg: "#fbf3df" },
  bridge: { name: "Recovered by terminology mapping", color: "#0e7490", bg: "#e2f1f5" },
  different: { name: "Different value we emitted", color: "#7e57c2", bg: "#efeafc" },
  couldnt: { name: "Couldn't reproduce", color: "#c2410c", bg: "#fbeae2" },
  extra: { name: "EHI-only", color: "#1f6feb", bg: "#e7f0fd" },
} as const;

export const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);

// family lookup for a delta -> the plain-language explanation in content
export function familyFor(d: Delta) {
  if (d.status === "TOLERATED") return { bucket: "equivalent" as const, fam: (C.equivalenceFamilies as any)[d.kind || "other"] };
  // GAP: did we emit a value (different, deliberate) or nothing (couldn't reproduce)?
  const emitted = d.ourVal !== null && d.ourVal !== undefined;
  if (emitted) return { bucket: "different" as const, fam: (C.differentFamilies as any)[d.family || ""] || (C.couldntFamilies as any)[d.family || "not-in-export"] };
  return { bucket: "couldnt" as const, fam: (C.couldntFamilies as any)[d.family || "not-in-export"] };
}

// list of resource types that have a reference target (in perType), ordered by total size desc
export const targetTypes = Object.keys(data.summary.perType).sort(
  (a, b) => {
    const s = (t: string) => data.summary.perType[t].exact + data.summary.perType[t].tolerated + data.summary.perType[t].gap;
    return s(b) - s(a);
  }
);
export const newTypes = [...new Set(data.newResources.map((r) => r.rt))].sort();
