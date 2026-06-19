import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useStore } from "./store";
import { data } from "./data";
import { Hero, Intro, TwoViews, Buckets, Families, MissingEntirely, NewResources, Method, Residual, Glossary } from "./sections";
import { Scorecard } from "./scorecard";
import { CompareWidget } from "./compare";
import { FaithfulScatter } from "./charts";

const NAV = [
  ["top", "Overview"],
  ["buckets", "How we scored"],
  ["scorecard", "Scorecard"],
  ["compare", "Compare resources"],
  ["families", "Why things differ"],
  ["missing", "What's missing"],
  ["beyond", "Beyond the API"],
  ["method", "How it was built"],
  ["residual", "What's lost"],
];

function Nav() {
  const section = useStore((s) => s.section);
  const set = useStore((s) => s.set);
  const go = (id: string) => {
    set({ section: id });
    document.getElementById(id)?.scrollIntoView({ block: "start" });
  };
  return (
    <nav className="nav">
      <span className="nav-brand">EHI → FHIR</span>
      <div className="nav-links">
        {NAV.map(([id, label]) => (
          <button key={id} className={"nav-link" + (section === id ? " on" : "")} onClick={() => go(id)}>{label}</button>
        ))}
      </div>
      <button className="nav-gloss" onClick={() => set({ glossaryOpen: true })}>Terms</button>
      <a className="nav-gloss" style={{ textDecoration: "none" }} href="https://github.com/jmandel/ehi-to-fhir" target="_blank" rel="noopener noreferrer">GitHub ↗</a>
    </nav>
  );
}

// when store.section changes via a button elsewhere, scroll to it
function ScrollSync() {
  const section = useStore((s) => s.section);
  useEffect(() => { document.getElementById(section)?.scrollIntoView({ block: "start" }); }, [section]);
  return null;
}

function App() {
  return (
    <>
      <Nav />
      <ScrollSync />
      <main className="page">
        <div id="top"><Hero /><Intro /></div>
        <div id="twoviews" className="band"><TwoViews /></div>
        <div id="buckets" className="band alt"><Buckets /></div>
        <div id="scorecard" className="band">
          <h2>The scorecard</h2>
          <p className="prose-inline">Every resource type Epic's API returned, and how much of it we rebuilt. Click a row for a plain-language summary; click a bubble to jump into real examples.</p>
          <FaithfulScatter />
          <Scorecard />
        </div>
        <div id="compare" className="band alt">
          <h2>Compare real resources, side by side</h2>
          <p className="prose-inline">Pick a resource type (then a category, then an instance). Differences are colored and explained in plain language: <b style={{ color: "#bf8700" }}>equivalent</b> (same meaning) or <b style={{ color: "#c2410c" }}>couldn't reproduce</b>. The default lands on the most instructive example. Use the <b>“Source for ours”</b> toggle to see the unaided <b>raw export only</b> result — where many coded concepts collapse to text — versus what our reconstructed terminology bridge recovers.</p>
          <CompareWidget />
        </div>
        <div id="families" className="band"><Families /></div>
        <div id="missing" className="band alt"><MissingEntirely /></div>
        <div id="beyond" className="band"><NewResources /></div>
        <div id="method" className="band"><Method /></div>
        <div id="residual" className="band alt"><Residual /></div>
        <footer className="foot">
          <p style={{ marginBottom: 10 }}>
            📦 <b>Take it with you:</b> download this whole record as a self-contained{" "}
            <a href="./health-records-skill-josh-mandel-fhir.zip">SMART-on-FHIR “health-record-assistant” skill bundle</a>{" "}
            — the reconstructed FHIR plus clinical-note text, redacted exactly as on this page; a drop-in, 1:1-shaped substitute for a real patient-portal download.
          </p>
          <p>One real patient record (the author's own, published with consent; a family member's contact details removed) · {data.summary.total.toLocaleString()} fields scored · reconciles {data.summary.reconciles ? "✓" : "✗"}. Built deterministically from the Epic EHI export; figures regenerate from <code>compare/LEDGER.json</code> via <code>bun tools/build-viewer.ts</code> and this page via <code>bun report/build.ts</code>.</p>
        </footer>
      </main>
      <Glossary />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
