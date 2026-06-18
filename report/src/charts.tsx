import React, { useMemo } from "react";
import { scaleLinear, scaleLog, scaleSqrt, hierarchy, treemap as d3treemap } from "d3";
import { data, BUCKET, pct, targetTypes, C } from "./data";
import { useStore } from "./store";

// ── Scatter: resource size (x, log) vs % faithful (y), bubble area = couldn't-reproduce count ──
export function FaithfulScatter() {
  const openCompare = useStore((s) => s.openCompare);
  const W = 720, H = 380, m = { t: 20, r: 24, b: 46, l: 48 };
  const pts = targetTypes.map((rt) => {
    const p = data.summary.perType[rt];
    const tot = p.exact + p.tolerated + p.gap;
    return { rt, tot, faithful: pct(p.exact + p.tolerated, tot), gap: p.gap };
  });
  const x = scaleLog().domain([10, 5200]).range([m.l, W - m.r]);
  const y = scaleLinear().domain([40, 100]).range([H - m.b, m.t]);
  const r = scaleSqrt().domain([0, 600]).range([3, 26]);
  const ticksX = [10, 50, 200, 1000, 5000];
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Resource size versus percent faithful">
        {[50, 60, 70, 80, 90, 100].map((g) => (
          <g key={g}>
            <line x1={m.l} x2={W - m.r} y1={y(g)} y2={y(g)} className="grid" />
            <text x={m.l - 8} y={y(g) + 4} className="axlbl" textAnchor="end">{g}%</text>
          </g>
        ))}
        {ticksX.map((t) => (
          <text key={t} x={x(t)} y={H - m.b + 18} className="axlbl" textAnchor="middle">{t}</text>
        ))}
        <text x={(W) / 2} y={H - 6} className="axtitle" textAnchor="middle">number of fields in this resource type (log scale) →</text>
        <text transform={`translate(14 ${H / 2}) rotate(-90)`} className="axtitle" textAnchor="middle">% faithfully reconstructed →</text>
        {pts.map((p) => (
          <g key={p.rt} className="dot" onClick={() => openCompare(p.rt)} style={{ cursor: "pointer" }}>
            <circle cx={x(p.tot)} cy={y(p.faithful)} r={r(p.gap)}
              fill={p.faithful >= 95 ? BUCKET.identical.color : p.faithful >= 80 ? BUCKET.equivalent.color : BUCKET.couldnt.color}
              fillOpacity={0.5} stroke="#fff" />
            <text x={x(p.tot)} y={y(p.faithful) - r(p.gap) - 3} className="dotlbl" textAnchor="middle">{p.rt}</text>
            <title>{`${p.rt}: ${p.faithful}% faithful, ${p.gap} couldn't-reproduce of ${p.tot} fields`}</title>
          </g>
        ))}
      </svg>
      <figcaption>Each bubble is a resource type. Higher = more faithfully reconstructed; bubble size = how many fields couldn't be reproduced. Click a bubble to compare real examples. Big-and-high (DiagnosticReport, Condition) reproduced almost perfectly; the misses concentrate in a few types (Encounter, DocumentReference).</figcaption>
    </figure>
  );
}

// ── Treemap of the 1,857 couldn't-reproduce fields by root-cause family ──
export function FamilyTreemap() {
  const set = useStore((s) => s.set);
  const W = 720, H = 300;
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of data.pairs) for (const d of p.deltas) if (d.status === "GAP") m[d.family || "not-in-export"] = (m[d.family || "not-in-export"] || 0) + 1;
    for (const c of data.cantReproduce) m[c.family] = (m[c.family] || 0) + 1;
    return m;
  }, []);
  const root = useMemo(() => {
    const children = Object.entries(counts).map(([family, value]) => ({ family, value }));
    const h = hierarchy({ children } as any).sum((d: any) => d.value).sort((a, b) => (b.value || 0) - (a.value || 0));
    d3treemap().size([W, H]).padding(2)(h);
    return h;
  }, [counts]);
  const palette = ["#c2410c", "#9a3412", "#b45309", "#a16207", "#7c2d12", "#92400e", "#a8530c", "#854d0e", "#7c3a12", "#6b3410"];
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Couldn't-reproduce fields by cause">
        {(root.leaves() as any[]).map((l, i) => {
          const fam = (C.couldntFamilies as any)[l.data.family];
          const w = l.x1 - l.x0, h = l.y1 - l.y0;
          return (
            <g key={l.data.family} transform={`translate(${l.x0} ${l.y0})`} style={{ cursor: "pointer" }} onClick={() => set({ section: "families" })}>
              <rect width={w} height={h} fill={palette[i % palette.length]} rx={3} />
              {w > 64 && h > 26 && (
                <text x={6} y={16} className="tm-lbl">
                  <tspan x={6} dy={0}>{fam?.title || l.data.family}</tspan>
                  <tspan x={6} dy={15} className="tm-num">{l.value}</tspan>
                </text>
              )}
              <title>{`${fam?.title || l.data.family}: ${l.value} fields`}</title>
            </g>
          );
        })}
      </svg>
      <figcaption>The 1,857 couldn't-reproduce fields, sized by how many fall in each root cause. A few causes dominate — chiefly Epic's internal code dictionaries and standardized codes that the raw export never carried. Click to read what each means.</figcaption>
    </figure>
  );
}
