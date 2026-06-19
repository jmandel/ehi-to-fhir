import React, { useMemo } from "react";
import { scaleLinear, scaleLog, scaleSqrt, hierarchy, treemap as d3treemap } from "d3";
import { data, BUCKET, pct, targetTypes, C, DOMAIN_META, domainColor } from "./data";
import { useStore } from "./store";
import { jump } from "./lib";

// ── Scatter, three independent signals + a categorical:
//    X = avg fields per instance (log) · Y = % faithful · bubble area = # instances · color = clinical domain.
//    Splitting "size" into instances (area) × fields/instance (x) keeps volume from being double-counted. ──
const FILL_OP = 0.55; // bubble fill opacity; legend swatches use the same tint so colors visually match.
// mix a hex color toward white by (1-op) so a solid swatch reads as the bubble's pale fill-over-white.
const tint = (hex: string, op: number) => {
  const n = parseInt(hex.slice(1), 16), mix = (c: number) => Math.round(c * op + 255 * (1 - op));
  return `rgb(${mix(n >> 16)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
};

type Geo = { rt: string; n: number; avg: number; faithful: number; cx: number; cy: number; R: number };
type Placed = { lx: number; ly: number; anchor: string; leader: { x1: number; y1: number; x2: number; y2: number } | null };
// Greedy collision-avoiding label placement: try several anchor positions around each bubble (biggest
// bubbles first), score each by overlap with already-placed labels, with bubbles, and with the frame,
// pick the cheapest, and draw a thin leader line whenever the label had to move off its default spot.
function layoutLabels(geo: Geo[], W: number, H: number, m: { t: number; r: number; b: number; l: number }): Record<string, Placed> {
  const CW = 5.9, LH = 13, L = m.l, R = W - m.r, T = m.t, B = H - m.b;
  const ov = (a: any, b: any) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const circles = geo.map((g) => ({ x: g.cx - g.R, y: g.cy - g.R, w: 2 * g.R, h: 2 * g.R }));
  const placed: any[] = [], out: Record<string, Placed> = {};
  for (const g of [...geo].sort((a, b) => b.R - a.R)) {
    const tw = g.rt.length * CW + 2;
    const cands = [
      { dx: 0, dy: -(g.R + 8), a: "middle" }, { dx: 0, dy: g.R + LH + 4, a: "middle" },
      { dx: g.R + 5, dy: 4, a: "start" }, { dx: -(g.R + 5), dy: 4, a: "end" },
      { dx: 0, dy: -(g.R + 8 + LH), a: "middle" }, { dx: 0, dy: g.R + LH * 2 + 4, a: "middle" },
      { dx: g.R * 0.75 + 4, dy: -(g.R * 0.75 + 6), a: "start" }, { dx: -(g.R * 0.75 + 4), dy: -(g.R * 0.75 + 6), a: "end" },
      { dx: g.R * 0.75 + 4, dy: g.R * 0.75 + 10, a: "start" }, { dx: -(g.R * 0.75 + 4), dy: g.R * 0.75 + 10, a: "end" },
    ].map((c, i) => {
      const lx = g.cx + c.dx, ly = g.cy + c.dy;
      const bx = c.a === "middle" ? lx - tw / 2 : c.a === "start" ? lx : lx - tw;
      return { ...c, i, lx, ly, box: { x: bx, y: ly - LH + 3, w: tw, h: LH } };
    });
    let best = cands[0], cost0 = Infinity;
    for (const c of cands) {
      let cost = c.i * 4;
      for (const p of placed) cost += ov(c.box, p) * 40;
      for (const cb of circles) cost += ov(c.box, cb) * 1.2;
      cost += (Math.max(0, L - c.box.x) + Math.max(0, c.box.x + c.box.w - R) + Math.max(0, T - c.box.y) + Math.max(0, c.box.y + c.box.h - B)) * 30;
      if (cost < cost0) { cost0 = cost; best = c; }
    }
    placed.push(best.box);
    let leader = null;
    if (best.i !== 0) {
      const ex = best.lx, ey = best.ly - 4, ang = Math.atan2(ey - g.cy, ex - g.cx);
      leader = { x1: g.cx + Math.cos(ang) * g.R, y1: g.cy + Math.sin(ang) * g.R, x2: ex, y2: ey };
    }
    out[g.rt] = { lx: best.lx, ly: best.ly, anchor: best.a, leader };
  }
  return out;
}

export function FaithfulScatter() {
  const openCompare = useStore((s) => s.openCompare);
  const W = 720, H = 380, m = { t: 20, r: 24, b: 46, l: 52 };
  const inst = data.summary.perTypeInstances || {};
  const pts = targetTypes.map((rt) => {
    const p = data.summary.perType[rt];
    const tot = p.exact + p.tolerated + p.gap;
    const n = inst[rt] || 1;
    return { rt, tot, n, avg: tot / n, faithful: pct(p.exact + p.tolerated, tot) };
  });
  const maxN = Math.max(...pts.map((p) => p.n));
  const maxAvg = Math.max(...pts.map((p) => p.avg));
  const minAvg = Math.min(...pts.map((p) => p.avg));
  const x = scaleLog().domain([Math.min(2.5, minAvg * 0.85), Math.max(120, maxAvg * 1.15)]).range([m.l, W - m.r]);
  const y = scaleLinear().domain([40, 100]).range([H - m.b, m.t]);
  const r = scaleSqrt().domain([0, maxN]).range([4, 30]);
  const ticksX = [3, 5, 10, 20, 50, 100, 200].filter((t) => t >= x.domain()[0] && t <= x.domain()[1]);
  const sizeLegend = [1, Math.round(maxN / 4), maxN].filter((v, i, a) => v > 0 && a.indexOf(v) === i);
  const geo: Geo[] = pts.map((p) => ({ rt: p.rt, n: p.n, avg: p.avg, faithful: p.faithful, cx: x(p.avg), cy: y(p.faithful), R: r(p.n) }));
  const lab = layoutLabels(geo, W, H, m);
  const go = (rt: string) => { openCompare(rt); jump("compare"); };
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Average fields per instance versus percent faithful, sized by instance count, colored by domain">
        {[50, 60, 70, 80, 90, 100].map((g) => (
          <g key={g}>
            <line x1={m.l} x2={W - m.r} y1={y(g)} y2={y(g)} className="grid" />
            <text x={m.l - 8} y={y(g) + 4} className="axlbl" textAnchor="end">{g}%</text>
          </g>
        ))}
        {ticksX.map((t) => (
          <text key={t} x={x(t)} y={H - m.b + 18} className="axlbl" textAnchor="middle">{t}</text>
        ))}
        <text x={(W) / 2} y={H - 6} className="axtitle" textAnchor="middle">average fields per instance (log scale) →</text>
        <text transform={`translate(14 ${H / 2}) rotate(-90)`} className="axtitle" textAnchor="middle">% faithfully reconstructed →</text>
        {/* bubbles — biggest first so small ones stay on top and clickable */}
        {geo.slice().sort((a, b) => b.R - a.R).map((p) => (
          <g key={p.rt} className="dot" onClick={() => go(p.rt)} style={{ cursor: "pointer" }}>
            <circle cx={p.cx} cy={p.cy} r={p.R} fill={domainColor(p.rt)} fillOpacity={FILL_OP} stroke="#fff" />
            <title>{`${p.rt}: ${p.faithful}% faithful · ${p.n} instance${p.n === 1 ? "" : "s"} · ~${Math.round(p.avg)} fields each`}</title>
          </g>
        ))}
        {/* leader lines for displaced labels */}
        {geo.map((p) => lab[p.rt].leader && (
          <line key={p.rt} x1={lab[p.rt].leader!.x1} y1={lab[p.rt].leader!.y1} x2={lab[p.rt].leader!.x2} y2={lab[p.rt].leader!.y2} stroke="#aab0b8" strokeWidth={0.8} />
        ))}
        {/* labels with white halo (paint-order stroke) so they read over bubbles and lines */}
        {geo.map((p) => (
          <text key={p.rt} x={lab[p.rt].lx} y={lab[p.rt].ly} className="dotlbl" textAnchor={lab[p.rt].anchor as any}
            onClick={() => go(p.rt)} style={{ cursor: "pointer", paintOrder: "stroke", stroke: "#fff", strokeWidth: 3, strokeLinejoin: "round" }}>{p.rt}</text>
        ))}
      </svg>
      <div className="chart-legend">
        {DOMAIN_META.map((d) => (
          <span key={d.key} className="cl-item"><span className="cl-dot" style={{ background: tint(d.color, FILL_OP), border: `1.5px solid ${d.color}` }} />{d.label}</span>
        ))}
        <span className="cl-sep" />
        <span className="cl-item">
          {sizeLegend.map((v) => (
            <span key={v} className="cl-circ" style={{ width: 2 * r(v), height: 2 * r(v) }} />
          ))}
          &nbsp;bubble size = # of instances Epic returned
        </span>
      </div>
      <figcaption><b>Each bubble is a resource type</b>, with three independent signals and a category. Left–right = the average number of fields in <i>one</i> instance (its intrinsic richness — Patient is a single, very detailed resource; an Observation is small but there are many); up = the share reproduced identically or equivalently; bubble size = how many of that type Epic returned; color = clinical domain. Click a bubble to jump to real examples. The misses concentrate in a few types (Encounter lowest, then DocumentReference, Observation).</figcaption>
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
