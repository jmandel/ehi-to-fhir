import React, { useMemo } from "react";
import { data, C, BUCKET, pct, Family } from "./data";
import { useStore } from "./store";
import { MiniBar, Term, BucketBadge } from "./lib";
import { FaithfulScatter, FamilyTreemap } from "./charts";

const S = data.summary;

export function Hero() {
  const set = useStore((s) => s.set);
  const faithful = pct(S.exact + S.tolerated, S.total);
  return (
    <header className="hero">
      <div className="hero-kicker">FHIR DevDays · a reconstruction experiment</div>
      <h1>{C.meta.title}</h1>
      <p className="hero-tag">{C.meta.tagline}</p>
      <div className="hero-bar">
        <MiniBar e={S.exact} t={S.tolerated} g={S.gap} h={34} showText />
        <div className="hero-legend">
          <Legend bucket="identical" n={S.exact} sub="byte-for-byte" />
          <Legend bucket="equivalent" n={S.tolerated} sub="same meaning, different form" />
          <Legend bucket="couldnt" n={S.gap} sub="not in the raw data" />
        </div>
      </div>
      <p className="hero-headline"><b>{faithful}%</b> of Epic's FHIR API output was reconstructed <b>identically or equivalently</b> from the raw patient download — and every field in the remaining {pct(S.gap, S.total)}% that couldn't be reproduced has a documented reason.</p>
      <div className="hero-cta">
        <button className="chip on" onClick={() => set({ section: "compare" })}>Compare real resources →</button>
        <button className="chip" onClick={() => set({ section: "scorecard" })}>See the scorecard</button>
        <button className="chip" onClick={() => set({ section: "buckets" })}>How we scored it</button>
      </div>
    </header>
  );
}
const Legend = ({ bucket, n, sub }: { bucket: keyof typeof BUCKET; n: number; sub: string }) => (
  <div className="leg"><span className="leg-dot" style={{ background: BUCKET[bucket].color }} /><b>{BUCKET[bucket].name}</b> <span className="leg-n">{n.toLocaleString()}</span><div className="leg-sub">{sub}</div></div>
);

export function Intro() {
  return (
    <section className="prose">
      {C.meta.premise.map((p, i) => <p key={i} dangerouslySetInnerHTML={{ __html: md(p) }} />)}
      <div className="callout"><b>Why care?</b> {C.meta.whyCare}</div>
      <p className="muted small">{C.meta.specimen}</p>
    </section>
  );
}

export function TwoViews() {
  const t = C.twoViews;
  return (
    <section>
      <h2>{t.heading}</h2>
      <div className="twoviews">
        <Panel title={t.export.title} points={t.export.points} kind="export" />
        <div className="tv-arrow" aria-hidden>→<div className="tv-arrow-lbl">rebuild this<br />from that</div></div>
        <Panel title={t.api.title} points={t.api.points} kind="api" />
      </div>
      <div className="callout"><b>The answer key.</b> {t.answerKey}</div>
    </section>
  );
}
const Panel = ({ title, points, kind }: { title: string; points: string[]; kind: string }) => (
  <div className={"tv-panel tv-" + kind}>
    <h3>{title}</h3>
    <ul>{points.map((p, i) => <li key={i} dangerouslySetInnerHTML={{ __html: md(p) }} />)}</ul>
  </div>
);

export function Buckets() {
  const b = C.buckets;
  const cards = [b.identical, b.equivalent, b.couldnt];
  return (
    <section>
      <h2>{b.heading}</h2>
      <p className="prose-inline">{b.intro}</p>
      <div className="bucket-cards">
        {cards.map((c) => (
          <div className="bucket-card" key={c.key} style={{ borderTopColor: c.color }}>
            <div className="bucket-name" style={{ color: c.color }}>{c.name}</div>
            <div className="bucket-def">{c.def}</div>
            {"discipline" in c && <div className="bucket-disc">{(c as any).discipline}</div>}
            <div className="bucket-internal">project term: <code>{c.internalName}</code></div>
          </div>
        ))}
      </div>
      <div className="callout big" dangerouslySetInnerHTML={{ __html: md(b.headline) }} />
    </section>
  );
}

function familyCounts() {
  const eq: Record<string, number> = {}, co: Record<string, number> = {};
  for (const p of data.pairs) for (const d of p.deltas) {
    if (d.status === "TOLERATED") eq[d.kind || "other"] = (eq[d.kind || "other"] || 0) + 1;
    else co[d.family || "not-in-export"] = (co[d.family || "not-in-export"] || 0) + 1;
  }
  for (const c of data.cantReproduce) co[c.family] = (co[c.family] || 0) + 1;
  return { eq, co };
}

export function Families() {
  const { eq, co } = useMemo(familyCounts, []);
  const eqEntries = Object.entries(C.equivalenceFamilies).map(([k, f]) => ({ k, f, n: eq[k] || 0 })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  const coEntries = Object.entries(C.couldntFamilies).map(([k, f]) => ({ k, f, n: co[k] || 0 })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  return (
    <section>
      <h2>Why fields differ</h2>
      <p className="prose-inline">Every difference falls into a small number of patterns. The first set are differences that <b>don't matter</b> — same meaning, different form. The second set are fields that genuinely <b>couldn't be reproduced</b> — each with the evidence behind it.</p>

      <h3 className="fam-h" style={{ color: BUCKET.equivalent.color }}>Different, but equivalent <span className="fam-tot">{S.tolerated.toLocaleString()} fields</span></h3>
      <div className="fam-grid">{eqEntries.map(({ k, f, n }) => <FamilyCard key={k} f={f} n={n} bucket="equivalent" />)}</div>

      <h3 className="fam-h" style={{ color: BUCKET.couldnt.color }}>Couldn't reproduce <span className="fam-tot">{S.gap.toLocaleString()} fields</span></h3>
      <FamilyTreemap />
      <div className="fam-grid">{coEntries.map(({ k, f, n }) => <FamilyCard key={k} f={f} n={n} bucket="couldnt" />)}</div>
    </section>
  );
}
function FamilyCard({ f, n, bucket }: { f: Family; n: number; bucket: keyof typeof BUCKET }) {
  return (
    <div className="fam-card" style={{ borderLeftColor: BUCKET[bucket].color }}>
      <div className="fam-card-head"><span className="fam-title">{f.title}</span><span className="fam-n" style={{ background: BUCKET[bucket].bg, color: BUCKET[bucket].color }}>{n.toLocaleString()}</span></div>
      <div className="fam-what">{f.what}</div>
      <div className="fam-why"><b>{bucket === "equivalent" ? "Why it's the same: " : "Why it can't be reproduced: "}</b>{f.why}</div>
      <div className="fam-sowhat">{f.soWhat}</div>
      {f.example && <div className="fam-eg">e.g. {f.example}</div>}
      <div className="fam-guard">{bucket === "equivalent" ? "Guard: " : "Proof: "}{f.guardOrProof}</div>
    </div>
  );
}

export function NewResources() {
  const nr = C.newResources;
  const set = useStore((s) => s.set);
  const count = (rt: string) => data.newResources.filter((r) => r.rt === rt).length;
  return (
    <section>
      <h2>{nr.heading}</h2>
      <p className="prose-inline">{nr.intro}</p>
      <div className="new-grid">
        {nr.groups.map((g) => (
          <div className="new-card" key={g.name} style={{ borderTopColor: BUCKET.extra.color }}>
            <div className="new-name">{g.name}</div>
            <div className="new-types">{g.types.map((t) => <button key={t} className="pill extra" onClick={() => set({ section: "compare", cmpMode: "new", cmpRt: t, cmpInstance: null, cmpSubgroup: "" })}>{t} <em>{count(t)}</em></button>)}</div>
            <div className="new-blurb">{g.blurb}</div>
          </div>
        ))}
      </div>
      <div className="callout"><b>How do we trust these without an answer key?</b> {nr.qa}</div>
    </section>
  );
}

export function Method() {
  const m = C.method;
  return (
    <section>
      <h2>{m.heading}</h2>
      <p className="prose-inline">{m.intro}</p>
      <div className="story-grid">
        {m.stories.map((s, i) => (
          <div className="story" key={i}><div className="story-t">{s.title}</div><p>{s.body}</p></div>
        ))}
      </div>
      <div className="callout"><b>The payoff of searching hard.</b> {m.recovered}</div>
    </section>
  );
}

export function Residual() {
  const r = C.residual;
  return (
    <section>
      <h2>{r.heading}</h2>
      <p className="prose-inline">{r.intro}</p>
      <ol className="resid">
        {r.points.map((p, i) => <li key={i}><b>{p.title}.</b> {p.body}</li>)}
      </ol>
      <div className="callout big">{r.bottomLine}</div>
    </section>
  );
}

export function Glossary() {
  const open = useStore((s) => s.glossaryOpen);
  const set = useStore((s) => s.set);
  if (!open) return null;
  return (
    <div className="gloss-overlay" onClick={() => set({ glossaryOpen: false })}>
      <div className="gloss-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="gloss-head"><h3>Terms used in this report</h3><button className="gloss-x" onClick={() => set({ glossaryOpen: false })}>×</button></div>
        <dl>{C.glossary.map((g) => <React.Fragment key={g.term}><dt>{g.term}</dt><dd>{g.def}</dd></React.Fragment>)}</dl>
      </div>
    </div>
  );
}

// tiny markdown: **bold** and `code`
export function md(s: string): string {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
}
