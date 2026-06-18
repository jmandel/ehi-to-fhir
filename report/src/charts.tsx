import React, { useMemo } from "react";
import { scaleLinear, scaleLog, scaleSqrt, hierarchy, treemap as d3treemap } from "d3";
import { data, BUCKET, pct, targetTypes, C } from "./data";
import { useStore } from "./store";
import { jump } from "./lib";

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
          <g key={p.rt} className="dot" onClick={() => { openCompare(p.rt); jump("compare"); }} style={{ cursor: "pointer" }}>
            <circle cx={x(p.tot)} cy={y(p.faithful)} r={r(p.gap)}
              fill={p.faithful >= 95 ? BUCKET.identical.color : p.faithful >= 80 ? BUCKET.equivalent.color : BUCKET.couldnt.color}
              fillOpacity={0.5} stroke="#fff" />
            <text x={x(p.tot)} y={y(p.faithful) - r(p.gap) - 3} className="dotlbl" textAnchor="middle">{p.rt}</text>
            <title>{`${p.rt}: ${p.faithful}% faithful, ${p.gap} couldn't-reproduce of ${p.tot} fields`}</title>
          </g>
        ))}
      </svg>
      <div className="chart-legend">
        <span className="cl-item"><span className="cl-dot" style={{ background: BUCKET.identical.color }} />≥ 95% faithful</span>
        <span className="cl-item"><span className="cl-dot" style={{ background: BUCKET.equivalent.color }} />80–95%</span>
        <span className="cl-item"><span className="cl-dot" style={{ background: BUCKET.couldnt.color }} />&lt; 80%</span>
        <span className="cl-sep" />
        <span className="cl-item"><span className="cl-circ" style={{ width: 8, height: 8 }} /><span className="cl-circ" style={{ width: 16, height: 16 }} /> bubble size = number of fields that couldn't be reproduced</span>
      </div>
      <figcaption><b>Each bubble is a resource type.</b> Left–right = how many fields it has (log scale); up = the share reproduced identically or equivalently (the <b>color just re-states that height</b> in three bands); bubble size = how many fields couldn't be reproduced. Click a bubble to jump to real examples. Big-and-high (DiagnosticReport, Condition) reproduced almost perfectly; the misses concentrate in a few types (Encounter lowest, then DocumentReference, Observation).</figcaption>
    </figure>
  );
}

// ── Treemap of the couldn't-reproduce fields by root-cause family (clickable) ──
const famTitle = (k: string) => (C.couldntFamilies as any)[k]?.title || (C.differentFamilies as any)[k]?.title || k;
export function FamilyTreemap({ counts, onPick, selected }: { counts: Record<string, number>; onPick: (f: string) => void; selected: string | null }) {
  const W = 760, H = 320;
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  const root = useMemo(() => {
    const children = Object.entries(counts).map(([family, value]) => ({ family, value }));
    const h = hierarchy({ children } as any).sum((dd: any) => dd.value).sort((a, b) => (b.value || 0) - (a.value || 0));
    d3treemap().size([W, H]).padding(3)(h);
    return h;
  }, [JSON.stringify(counts)]);
  const palette = ["#c2410c", "#9a3412", "#b45309", "#a16207", "#7c2d12", "#92400e", "#a8530c", "#854d0e", "#7c3a12", "#6b3410"];
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Couldn't-reproduce fields by cause" style={{ overflow: "visible" }}>
        {(root.leaves() as any[]).map((l, i) => {
          const w = l.x1 - l.x0, h = l.y1 - l.y0, isSel = selected === l.data.family;
          return (
            <g key={l.data.family} transform={`translate(${l.x0} ${l.y0})`} style={{ cursor: "pointer" }} onClick={() => onPick(l.data.family)}>
              <rect width={w} height={h} fill={palette[i % palette.length]} rx={4} stroke={isSel ? "#1c2128" : "#fff"} strokeWidth={isSel ? 2.5 : 1} />
              <foreignObject x={0} y={0} width={w} height={h}>
                <div className="tm-cell" style={{ fontSize: w < 90 ? 10 : 12.5 }}>
                  <div className="tm-cell-title">{famTitle(l.data.family)}</div>
                  <div className="tm-cell-num">{l.value} · {Math.round((l.value / total) * 100)}%</div>
                </div>
              </foreignObject>
              <title>{`${famTitle(l.data.family)}: ${l.value} fields — click for examples`}</title>
            </g>
          );
        })}
      </svg>
      <figcaption>The {total.toLocaleString()} fields that came out <b>blank</b>, sized by root cause. A few dominate — chiefly Epic's internal code dictionaries and the standardized codes the raw export never carried. <b>Click any box</b> for examples and the proof.</figcaption>
    </figure>
  );
}
