/**
 * decompose.ts — split the canonical (terminology-bridge ON) result into what the RAW EXPORT
 * achieves on its own vs. what the reconstructed terminology bridge adds, over the SAME 16,120-leaf
 * denominator (canonical alignment). For every target leaf:
 *   - couldn't        : GAP even with the bridge
 *   - reproduced (EXACT/TOLERATED): does the LEAN output (out/, no bridge) already carry that same
 *     value at that path?  yes -> raw-export reproduced ;  no -> recovered by the bridge
 *       (sub-split bridge-recovered by path: coding -> vocabulary ; identifier -> identifier ; else other)
 * Bridge is additive (same ids, only adds codings/identifiers), so lean-reproduced ⊆ bridge-reproduced
 * and the comparison is clean.
 *
 *   bun tools/decompose.ts   (uses the canonical compare/LEDGER.json + out/ + out-answerkey/)
 */
import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
const ROOT = resolve(import.meta.dir, "..");
const L = JSON.parse(readFileSync(resolve(ROOT, "compare/LEDGER.json"), "utf8"));
function indexDir(dir: string) { const m = new Map<string, any>(); if (!existsSync(dir)) return m; for (const f of readdirSync(dir)) { if (!f.endsWith(".json") || f === "bundle.json") continue; try { const a = JSON.parse(readFileSync(resolve(dir, f), "utf8")); if (Array.isArray(a)) for (const r of a) if (r?.resourceType && r?.id) m.set(`${r.resourceType}/${r.id}`, r); } catch {} } return m; }
const TGT = indexDir(resolve(ROOT, "fhir-target")), BRIDGE = indexDir(resolve(ROOT, "out-answerkey")), LEAN = indexDir(resolve(ROOT, "out"));

// leaf path->values multiset
function leaves(r: any) { const m = new Map<string, any[]>(); (function go(p: string, n: any) { if (n == null) return; if (Array.isArray(n)) return n.forEach((x) => go(p + "[]", x)); if (typeof n === "object") return Object.entries(n).forEach(([k, v]) => go(p ? `${p}.${k}` : k, v)); (m.get(p) ?? m.set(p, []).get(p)!).push(n); })("", r); return m; }

// canonical per-leaf disposition lookup: (rt/tgtId) -> path -> [{val, kind}] for gaps & tol
const disp = new Map<string, { gaps: Map<string, any[]>; tol: Map<string, any[]> }>();
const slot = (k: string) => disp.get(k) ?? disp.set(k, { gaps: new Map(), tol: new Map() }).get(k)!;
const push = (m: Map<string, any[]>, p: string, v: any) => (m.get(p) ?? m.set(p, []).get(p)!).push(v);
for (const g of L.gaps) if (g.tgtId && g.path !== "(whole resource)") push(slot(`${g.rt}/${g.tgtId}`).gaps, g.path, g.targetVal);
for (const t of L.toleratedDeltas) if (t.tgtId) push(slot(`${t.rt}/${t.tgtId}`).tol, t.path, { tv: t.targetVal, ov: t.ourVal });

const cat: Record<string, number> = { exportIdentical: 0, exportEquivalent: 0, bridgeVocab: 0, bridgeIdentifier: 0, bridgeOther: 0, couldnt: 0 };
let wholeResourceGaps = 0;
const isCoding = (p: string) => /coding\[\]\.(system|code|display)$|\.code$|\.system$/.test(p) || /vaccineCode|valueCodeableConcept/.test(p);
const isIdent = (p: string) => /identifier/.test(p);

for (const vp of L.viewerPairs as any[]) {
  const target = TGT.get(`${vp.rt}/${vp.tgtId}`); if (!target) continue;
  const bridgeOur = BRIDGE.get(`${vp.rt}/${vp.ourId}`), leanOur = LEAN.get(`${vp.rt}/${vp.ourId}`);
  const leanLeaves = leanOur ? leaves(leanOur) : new Map();
  const d = disp.get(`${vp.rt}/${vp.tgtId}`) || { gaps: new Map(), tol: new Map() };
  const leanHas = (path: string, v: any) => (leanLeaves.get(path) || []).some((x: any) => JSON.stringify(x) === JSON.stringify(v));
  const remove = (pool: any[], v: any) => { const i = pool.findIndex((x) => JSON.stringify(x) === JSON.stringify(v)); if (i >= 0) pool.splice(i, 1); };
  const byPath = new Map<string, any[]>();
  for (const [path, vals] of leaves(target)) { if (path !== "id") byPath.set(path, [...vals]); }
  // every path the ledger has gaps/tol for is also a target path
  for (const [path, pool] of byPath) {
    const gArr = (d.gaps.get(path) || []).slice();
    const tArr = (d.tol.get(path) || []).slice();
    // 1) gaps consume one target leaf each -> couldn't
    for (const gv of gArr) { remove(pool, gv); cat.couldnt++; }
    // 2) tolerated consume one each -> reproduced; our value = ov; bridge-attributable iff lean lacks ov
    for (const t of tArr) { remove(pool, t.tv); leanHas(path, t.ov) ? cat.exportEquivalent++ : (isCoding(path) ? cat.bridgeVocab++ : isIdent(path) ? cat.bridgeIdentifier++ : cat.bridgeOther++); }
    // 3) remainder are EXACT (bridge-our byte-matches target); raw-export already has it iff lean does
    for (const ev of pool) { leanHas(path, ev) ? cat.exportIdentical++ : (isCoding(path) ? cat.bridgeVocab++ : isIdent(path) ? cat.bridgeIdentifier++ : cat.bridgeOther++); }
  }
}
// whole-resource gaps (counted as 1 each in the ledger denominator)
for (const g of L.gaps) if (g.path === "(whole resource)") { cat.couldnt++; wholeResourceGaps++; }

const total = Object.values(cat).reduce((a, b) => a + b, 0);
const pc = (n: number) => ((100 * n) / total).toFixed(1) + "%";
console.log("=== bridge-contribution decomposition (denominator = canonical target leaves) ===");
for (const [k, v] of Object.entries(cat)) console.log(`  ${k.padEnd(18)} ${String(v).padStart(6)}  ${pc(v)}`);
console.log(`  ${"TOTAL".padEnd(18)} ${String(total).padStart(6)}  (ledger total ${L.totalTargetElements}; whole-resource gaps ${wholeResourceGaps})`);
console.log("\nHeadline rollup:");
console.log(`  Identical from the raw export alone : ${cat.exportIdentical}`);
console.log(`  Equivalent (form only, no bridge)   : ${cat.exportEquivalent}`);
console.log(`  Recovered by terminology mapping    : ${cat.bridgeVocab}`);
console.log(`  Recovered by identifier mapping     : ${cat.bridgeIdentifier}`);
console.log(`  Recovered by other bridge data      : ${cat.bridgeOther}`);
console.log(`  Couldn't reproduce (even w/ bridge) : ${cat.couldnt}`);
