import React, { useState } from "react";
import { BUCKET, C } from "./data";
import { useStore } from "./store";

// set state + reliably scroll to a section (works even if the section value didn't change)
export const jump = (id: string) => requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start" }));

export const fmt = (v: any): string => {
  if (v === null || v === undefined) return "∅ (absent)";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};

export function BucketBadge({ bucket, small }: { bucket: keyof typeof BUCKET; small?: boolean }) {
  const b = BUCKET[bucket];
  return (
    <span className="badge" style={{ background: b.bg, color: b.color, fontSize: small ? 10 : 11 }}>
      {b.name}
    </span>
  );
}

// inline value, with absent styling
export function Val({ v }: { v: any }) {
  const absent = v === null || v === undefined;
  return <span className={"val" + (absent ? " val-absent" : "")}>{fmt(v)}</span>;
}

// collapsible disclosure for technical detail (rule ids, raw evidence) — never shown by default
export function TechDetail({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="tech">
      <button className="tech-toggle" onClick={() => setOpen((o) => !o)}>{open ? "▾" : "▸"} {label}</button>
      {open && <div className="tech-body">{children}</div>}
    </span>
  );
}

// Inline glossary term: dotted underline, click opens the glossary drawer scrolled to it.
const GLOSS = new Map(C.glossary.map((g) => [g.term.toLowerCase(), g.def]));
export function Term({ children, t }: { children: React.ReactNode; t?: string }) {
  const key = (t || String(children)).toLowerCase();
  const def = GLOSS.get(key);
  const setOpen = useStore((s) => s.set);
  if (!def) return <>{children}</>;
  return (
    <span className="term" title={def} onClick={() => setOpen({ glossaryOpen: true })} tabIndex={0}>
      {children}
    </span>
  );
}

// horizontal 3-segment bar (identical / equivalent / couldnt)
export function MiniBar({ e, t, g, h = 14, showText }: { e: number; t: number; g: number; h?: number; showText?: boolean }) {
  const tot = e + t + g || 1;
  const seg = (n: number, b: keyof typeof BUCKET) =>
    n > 0 ? <span style={{ width: `${(n / tot) * 100}%`, background: BUCKET[b].color }} title={`${BUCKET[b].name}: ${n}`}>{showText && (n / tot) > 0.08 ? n : ""}</span> : null;
  return (
    <span className="minibar" style={{ height: h }}>
      {seg(e, "identical")}{seg(t, "equivalent")}{seg(g, "couldnt")}
    </span>
  );
}

// readable, collapsible JSON with per-leaf bucket highlighting.
// statusByPath maps a leaf path ("code.coding[].display") -> "TOLERATED" | "GAP".
function leafStatusColor(s?: string) {
  return s === "TOLERATED" ? BUCKET.equivalent.color : s === "GAP" ? BUCKET.couldnt.color : undefined;
}
function JsonNode({ node, path, keyLabel, statusByPath, depth }: { node: any; path: string; keyLabel?: string; statusByPath: Map<string, string>; depth: number }) {
  const indent = { paddingLeft: depth * 14 };
  if (node === null || node === undefined) {
    return <div style={indent}><K k={keyLabel} /><span className="j-null">null</span></div>;
  }
  if (Array.isArray(node)) {
    if (node.length === 0) return <div style={indent}><K k={keyLabel} /><span className="j-punct">[]</span></div>;
    return (
      <div style={indent}>
        <K k={keyLabel} /><span className="j-punct">[</span>
        {node.map((it, i) => <JsonNode key={i} node={it} path={path + "[]"} statusByPath={statusByPath} depth={depth + 1} />)}
        <div style={indent}><span className="j-punct">]</span></div>
      </div>
    );
  }
  if (typeof node === "object") {
    const keys = Object.keys(node);
    return (
      <div style={indent}>
        <K k={keyLabel} /><span className="j-punct">{"{"}</span>
        {keys.map((k) => <JsonNode key={k} node={node[k]} path={path ? `${path}.${k}` : k} keyLabel={k} statusByPath={statusByPath} depth={depth + 1} />)}
        <div style={indent}><span className="j-punct">{"}"}</span></div>
      </div>
    );
  }
  // leaf
  const color = leafStatusColor(statusByPath.get(path));
  return (
    <div style={indent} className={color ? "j-hl" : ""}>
      <K k={keyLabel} />
      <span className="j-val" style={color ? { background: color + "22", borderBottom: `2px solid ${color}` } : undefined}>
        {typeof node === "string" ? `"${node}"` : String(node)}
      </span>
    </div>
  );
}
const K = ({ k }: { k?: string }) => (k ? <span className="j-key">{k}: </span> : null);

export function JsonView({ obj, statusByPath, title }: { obj: any; statusByPath?: Map<string, string>; title?: string }) {
  const [open, setOpen] = useState(false);
  if (!obj) return <div className="json-empty">no resource</div>;
  return (
    <div className="jsonview">
      {title && <button className="json-toggle" onClick={() => setOpen((o) => !o)}>{open ? "▾ hide" : "▸ show"} {title}</button>}
      {(open || !title) && <div className="json-body">
        <JsonNode node={obj} path="" statusByPath={statusByPath || new Map()} depth={0} />
      </div>}
    </div>
  );
}
