import React, { useMemo } from "react";
import { data, C, BUCKET, pct, Family } from "./data";
import { useStore } from "./store";
import { MiniBar, Term, BucketBadge, Val, jump } from "./lib";
import { FaithfulScatter, FamilyTreemap } from "./charts";

const S = data.summary;

export function Hero() {
  const set = useStore((s) => s.set);
  const d = S.decomposition;
  // 4-way headline split (falls back to the 3-way if decomposition is absent)
  const seg = d
    ? [
        { label: "Identical from the export", color: BUCKET.identical.color, n: d.exportIdentical, sub: "byte-for-byte, no help needed" },
        { label: "Equivalent", color: BUCKET.equivalent.color, n: d.exportEquivalent, sub: "same meaning, different form" },
        { label: "Recovered by terminology mapping", color: BUCKET.bridge.color, n: d.bridgeVocab + d.bridgeIdentifier + d.bridgeOther, sub: "standard codes rebuilt from the export's own keys" },
        { label: "Different value we emitted", color: BUCKET.different.color, n: d.different, sub: "a source-faithful value, not byte-identical" },
        { label: "Couldn't reproduce", color: BUCKET.couldnt.color, n: d.absent, sub: "blank — not in the raw data at all" },
      ]
    : [
        { label: "Identical", color: BUCKET.identical.color, n: S.exact, sub: "byte-for-byte" },
        { label: "Equivalent", color: BUCKET.equivalent.color, n: S.tolerated, sub: "same meaning, different form" },
        { label: "Couldn't reproduce", color: BUCKET.couldnt.color, n: S.gap, sub: "not in the raw data" },
      ];
  const tot = seg.reduce((a, s) => a + s.n, 0);
  const exportAlone = d ? d.exportIdentical + d.exportEquivalent : S.exact + S.tolerated;
  return (
    <header className="hero">
      <div className="hero-kicker">FHIR DevDays · a reconstruction experiment</div>
      <h1>{C.meta.title}</h1>
      <p className="hero-tag">{C.meta.tagline}</p>
      <div className="hero-bar">
        <span className="minibar" style={{ height: 34 }}>
          {seg.map((s, i) => s.n > 0 && (
            <span key={i} style={{ width: `${(s.n / tot) * 100}%`, background: s.color }} title={`${s.label}: ${s.n}`}>{(s.n / tot) > 0.07 ? s.n.toLocaleString() : ""}</span>
          ))}
        </span>
        <div className="hero-legend">
          {seg.map((s, i) => (
            <div className="leg" key={i}><span className="leg-dot" style={{ background: s.color }} /><b>{s.label}</b> <span className="leg-n">{s.n.toLocaleString()}</span><div className="leg-sub">{s.sub}</div></div>
          ))}
        </div>
      </div>
      <p className="hero-headline">From the <b>raw export alone</b>, <b>{pct(exportAlone, tot)}%</b> of Epic's FHIR comes out identical or equivalent. A terminology bridge we reconstructed from the export's own keys recovers <b>another {d ? pct(d.bridgeVocab + d.bridgeIdentifier + d.bridgeOther, tot) : 0}%</b> of Epic's standard codes. Only <b>{pct(d ? d.absent : S.gap, tot)}%</b> is genuinely blank — couldn't reproduce — every field with a documented reason.</p>
      <div className="hero-cta">
        <button className="chip on" onClick={() => { set({ section: "compare" }); jump("compare"); }}>Compare real resources →</button>
        <button className="chip" onClick={() => { set({ section: "scorecard" }); jump("scorecard"); }}>See the scorecard</button>
        <button className="chip" onClick={() => { set({ section: "buckets" }); jump("buckets"); }}>How we scored it</button>
      </div>
    </header>
  );
}

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
      <div className="callout" style={{ borderLeftColor: BUCKET.bridge.color }}>
        <b>One nuance worth knowing:</b> {C.bridgeContribution.intro.replace(/\*\*/g, "")} {C.bridgeContribution.takeaway.replace(/\*\*/g, "")}
      </div>
    </section>
  );
}

export type Ex = { rt: string; path: string; target: any; ours: any };
function familyData() {
  const eq: Record<string, number> = {}, diff: Record<string, number> = {}, absent: Record<string, number> = {};
  const exBy: Record<string, Ex[]> = {};
  const addEx = (fam: string, e: Ex) => { (exBy[fam] ??= []).push(e); };
  for (const p of data.pairs) for (const dl of p.deltas) {
    if (dl.status === "TOLERATED") { eq[dl.kind || "other"] = (eq[dl.kind || "other"] || 0) + 1; continue; }
    const fam = dl.family || "not-in-export";
    (dl.emitted ? diff : absent)[fam] = ((dl.emitted ? diff : absent)[fam] || 0) + 1;
    addEx(fam, { rt: p.rt, path: dl.path, target: dl.targetVal, ours: dl.ourVal });
  }
  for (const c of data.cantReproduce) { absent[c.family] = (absent[c.family] || 0) + 1; addEx(c.family, { rt: c.rt, path: "(whole resource)", target: c.key, ours: null }); }
  return { eq, diff, absent, exBy };
}
const famContent = (k: string): Family => ((C.differentFamilies as any)[k] || (C.couldntFamilies as any)[k] || (C.equivalenceFamilies as any)[k] || { title: k, what: "", why: "", soWhat: "", guardOrProof: "" });

export function Families() {
  const { eq, diff, absent, exBy } = useMemo(familyData, []);
  const sel = useStore((s) => s.selectedFamily);
  const setSel = useStore((s) => s.set);
  const entries = (m: Record<string, number>, dict: any) => Object.keys(m).map((k) => ({ k, f: dict(k), n: m[k] })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  const eqEntries = Object.entries(C.equivalenceFamilies).map(([k, f]) => ({ k, f, n: eq[k] || 0 })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  const diffEntries = entries(diff, famContent);
  const absentEntries = entries(absent, famContent);
  const diffTotal = Object.values(diff).reduce((a, b) => a + b, 0);
  const absentTotal = Object.values(absent).reduce((a, b) => a + b, 0);
  return (
    <section>
      <h2>Why fields differ</h2>
      <p className="prose-inline">Every difference falls into one of three kinds: it <b>doesn't matter</b> (same meaning, different form), we <b>emitted a different value on purpose</b> (the export's truthful value, not Epic's rendering), or we genuinely <b>couldn't reproduce it</b> (the field came out blank — with the evidence why).</p>

      <h3 className="fam-h" style={{ color: BUCKET.equivalent.color }}>Different, but equivalent <span className="fam-tot">{S.tolerated.toLocaleString()} fields</span></h3>
      <p className="fam-sub">Surface differences a FHIR consumer can ignore — verified to mean the same thing.</p>
      <div className="fam-grid">{eqEntries.map(({ k, f, n }) => <FamilyCard key={k} fk={k} f={f} n={n} bucket="equivalent" exs={exBy[k]} />)}</div>

      <h3 className="fam-h" style={{ color: BUCKET.different.color }}>We emitted a different value, on purpose <span className="fam-tot">{diffTotal.toLocaleString()} fields</span></h3>
      <p className="fam-sub">Not a loss — we <b>did</b> produce a value, just not byte-identical to Epic's. We keep the truthful value from the source rather than mimic Epic's rendering.</p>
      <div className="fam-grid">{diffEntries.map(({ k, f, n }) => <FamilyCard key={k} fk={k} f={f} n={n} bucket="different" exs={exBy[k]} />)}</div>

      <h3 className="fam-h" style={{ color: BUCKET.couldnt.color }}>Couldn't reproduce <span className="fam-tot">{absentTotal.toLocaleString()} fields</span></h3>
      <p className="fam-sub">Came out blank — the data isn't in the export. Click a box to see examples and the proof.</p>
      <FamilyTreemap counts={absent} onPick={(f) => setSel({ selectedFamily: sel === f ? null : f })} selected={sel} />
      {sel && absent[sel] != null && <FamilyDetail fk={sel} exs={exBy[sel]} n={absent[sel]} onClose={() => setSel({ selectedFamily: null })} />}
      <div className="fam-grid">{absentEntries.map(({ k, f, n }) => <FamilyCard key={k} fk={k} f={f} n={n} bucket="couldnt" exs={exBy[k]} />)}</div>
    </section>
  );
}

function ExTable({ exs }: { exs?: Ex[] }) {
  if (!exs?.length) return null;
  const seen = new Set<string>(), rows: Ex[] = [];
  for (const e of exs) { const key = e.rt + "|" + e.path; if (seen.has(key)) continue; seen.add(key); rows.push(e); if (rows.length >= 4) break; }
  return (
    <table className="ex-table">
      <thead><tr><th>field</th><th>Epic</th><th>ours</th></tr></thead>
      <tbody>{rows.map((e, i) => <tr key={i}><td className="ex-rt">{e.rt} <span className="ex-path">{e.path}</span></td><td><Val v={e.target} /></td><td><Val v={e.ours} /></td></tr>)}</tbody>
    </table>
  );
}
function FamilyCard({ fk, f, n, bucket, exs }: { fk: string; f: Family; n: number; bucket: keyof typeof BUCKET; exs?: Ex[] }) {
  const whyLabel = bucket === "equivalent" ? "Why it's the same: " : bucket === "different" ? "Why we keep ours: " : "Why it's blank: ";
  return (
    <div className="fam-card" style={{ borderLeftColor: BUCKET[bucket].color }}>
      <div className="fam-card-head"><span className="fam-title">{f.title}</span><span className="fam-n" style={{ background: BUCKET[bucket].bg, color: BUCKET[bucket].color }}>{n.toLocaleString()}</span></div>
      <div className="fam-what">{f.what}</div>
      <div className="fam-why"><b>{whyLabel}</b>{f.why}</div>
      <div className="fam-sowhat">{f.soWhat}</div>
      <ExTable exs={exs} />
      <div className="fam-guard">{bucket === "equivalent" ? "Guard: " : "Proof: "}{f.guardOrProof}</div>
    </div>
  );
}
function FamilyDetail({ fk, exs, n, onClose }: { fk: string; exs?: Ex[]; n: number; onClose: () => void }) {
  const f = famContent(fk);
  return (
    <div className="fam-detail" style={{ borderColor: BUCKET.couldnt.color }}>
      <div className="fam-detail-head"><span className="fam-title">{f.title}</span> <span className="fam-n" style={{ background: BUCKET.couldnt.bg, color: BUCKET.couldnt.color }}>{n.toLocaleString()} fields</span><button className="fam-x" onClick={onClose}>×</button></div>
      <div className="fam-what">{f.what}</div>
      <div className="fam-why"><b>Why it's blank: </b>{f.why}</div>
      <ExTable exs={exs} />
      <div className="fam-guard">Proof: {f.guardOrProof}</div>
    </div>
  );
}

export function MissingEntirely() {
  const m = C.missingEntirely;
  return (
    <section>
      <h2>{m.heading}</h2>
      <p className="prose-inline">{m.intro}</p>
      <div className="miss-grid">
        {m.items.map((it, i) => (
          <div className="miss-card" key={i}>
            <div className="miss-head"><span className="miss-title">{it.title}</span><span className="miss-count">{it.count}</span></div>
            <div className="miss-detail">{it.detail}</div>
            <div className="miss-proof"><b>How we know:</b> {it.proof}</div>
          </div>
        ))}
      </div>
      <div className="callout">{m.note}</div>
    </section>
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
            <div className="new-types">{g.types.map((t) => <button key={t} className="pill extra" onClick={() => { set({ section: "compare", cmpMode: "new", cmpRt: t, cmpInstance: null, cmpSubgroup: "" }); jump("compare"); }}>{t} <em>{count(t)}</em></button>)}</div>
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
