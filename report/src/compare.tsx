import React, { useEffect, useMemo } from "react";
import { data, leanData, C, BUCKET, targetTypes, newTypes, familyFor, Pair, Delta, pct } from "./data";
import { useStore } from "./store";
import { BucketBadge, Val, TechDetail, JsonView, MiniBar, Term } from "./lib";

const useDS = () => useStore((s) => (s.cmpDataset === "raw" ? leanData : data));

const MODES = [
  { k: "pairs", label: "Side-by-side matches", hint: "Resources we rebuilt and compared field-by-field against Epic's FHIR." },
  { k: "couldnt", label: "Couldn't rebuild", hint: "Whole resources Epic's API has that the raw export can't produce." },
  { k: "new", label: "Beyond the API", hint: "Resources we built from the export that Epic's API never offered." },
] as const;

export function CompareWidget() {
  const s = useStore();
  const mode = s.cmpMode;
  const ds = useDS();

  const types = mode === "new" ? newTypes
    : mode === "couldnt" ? [...new Set(ds.cantReproduce.map((c) => c.rt))].sort()
    : targetTypes;

  // ensure cmpRt valid for the mode
  useEffect(() => {
    if (!types.includes(s.cmpRt)) s.set({ cmpRt: types[0], cmpSubgroup: "", cmpInstance: null });
  }, [mode]);

  const rt = types.includes(s.cmpRt) ? s.cmpRt : types[0];

  // instances for current mode+type
  const allInstances = useMemo(() => {
    if (mode === "new") return ds.newResources.filter((r) => r.rt === rt).map((r) => ({ id: r.id, subgroup: r.subgroup, label: r.our?.id || r.id, badge: "" }));
    if (mode === "couldnt") return ds.cantReproduce.filter((c) => c.rt === rt).map((c) => ({ id: c.tgtId || c.key, subgroup: c.subgroup, label: c.key, badge: "" }));
    return ds.pairs.filter((p) => p.rt === rt).map((p) => ({ id: p.tgtId, subgroup: p.subgroup, label: p.key, badge: `${p.tol}/${p.gap}`, tol: p.tol, gap: p.gap }));
  }, [mode, rt, ds]);

  const subgroups = useMemo(() => [...new Set(allInstances.map((i) => i.subgroup))].sort(), [allInstances]);
  const sub = s.cmpSubgroup && subgroups.includes(s.cmpSubgroup) ? s.cmpSubgroup : "";
  const instances = sub ? allInstances.filter((i) => i.subgroup === sub) : allInstances;

  // default instance: the most-divergent sample for this type/subgroup, else first
  useEffect(() => {
    if (s.cmpInstance && instances.some((i) => i.id === s.cmpInstance)) return;
    let pick = instances[0]?.id;
    if (mode === "pairs") {
      const samp = ds.samples[rt]?.find((x) => !sub || x.subgroup === sub);
      if (samp && instances.some((i) => i.id === samp.mostDivergent.tgtId)) pick = samp.mostDivergent.tgtId;
    }
    s.set({ cmpInstance: pick ?? null });
  }, [mode, rt, sub, ds]);

  return (
    <div className="cmp">
      <div className="cmp-modes">
        {MODES.map((m) => (
          <button key={m.k} className={"chip" + (mode === m.k ? " on" : "")} onClick={() => s.set({ cmpMode: m.k as any, cmpInstance: null, cmpSubgroup: "" })}>
            {m.label}
          </button>
        ))}
        <span className="cmp-hint">{MODES.find((m) => m.k === mode)!.hint}</span>
      </div>

      <div className="cmp-dataset">
        <span className="cmp-ds-label">Source for “ours”:</span>
        <button className={"toggle" + (s.cmpDataset === "bridge" ? " on" : "")} onClick={() => s.set({ cmpDataset: "bridge", cmpInstance: null })}>Export + terminology bridge</button>
        <button className={"toggle" + (s.cmpDataset === "raw" ? " on" : "")} onClick={() => s.set({ cmpDataset: "raw", cmpInstance: null })}>Raw export only</button>
        <span className="cmp-ds-note">
          {s.cmpDataset === "raw"
            ? "What the raw download yields with no extra help — many coded concepts collapse to text-only. Across the record, this is " + pct(leanData.summary.exact + leanData.summary.tolerated, leanData.summary.total) + "% identical-or-equivalent."
            : "Adds standard codes (drugs, vaccines, allergens, billed procedures) we rebuilt from the export's own keys — " + pct(data.summary.exact + data.summary.tolerated, data.summary.total) + "% identical-or-equivalent. Toggle to see the unaided result."}
        </span>
      </div>

      <div className="cmp-types">
        {types.map((t) => (
          <button key={t} className={"pill" + (rt === t ? " on" : "")} onClick={() => s.set({ cmpRt: t, cmpSubgroup: "", cmpInstance: null })}>{t}</button>
        ))}
      </div>

      {subgroups.length > 1 && (
        <div className="cmp-subs">
          <span className="cmp-sublabel">grouped by category:</span>
          <button className={"tag" + (sub === "" ? " on" : "")} onClick={() => s.set({ cmpSubgroup: "", cmpInstance: null })}>all</button>
          {subgroups.map((g) => (
            <button key={g} className={"tag" + (sub === g ? " on" : "")} onClick={() => s.set({ cmpSubgroup: g, cmpInstance: null })}>{g}</button>
          ))}
        </div>
      )}

      <div className="cmp-body">
        <aside className="cmp-list">
          {instances.map((i) => (
            <button key={i.id} className={"cmp-item" + (s.cmpInstance === i.id ? " on" : "")} onClick={() => s.set({ cmpInstance: i.id })}>
              <span className="cmp-item-key">{i.label}</span>
              {mode === "pairs" && ((i as any).tol > 0 || (i as any).gap > 0
                ? <span className="cmp-item-badge">{(i as any).tol > 0 && <em style={{ color: BUCKET.equivalent.color }}>{(i as any).tol}≈</em>} {(i as any).gap > 0 && <em style={{ color: BUCKET.couldnt.color }}>{(i as any).gap}✗</em>}</span>
                : <span className="cmp-item-badge" style={{ color: BUCKET.identical.color }}>✓ exact</span>)}
            </button>
          ))}
          {!instances.length && <div className="muted">none</div>}
        </aside>
        <section className="cmp-detail">
          {mode === "pairs" && <PairDetail tgtId={s.cmpInstance} rt={rt} ds={ds} />}
          {mode === "couldnt" && <CouldntDetail tgtId={s.cmpInstance} rt={rt} ds={ds} />}
          {mode === "new" && <NewDetail id={s.cmpInstance} rt={rt} ds={ds} />}
        </section>
      </div>
    </div>
  );
}

const whyLabelFor = (b: string) => (b === "equivalent" ? "Why it's the same: " : b === "different" ? "Why we keep ours: " : "Why it's blank: ");
function DiffRow({ d }: { d: Delta }) {
  const { bucket, fam } = familyFor(d);
  return (
    <tr>
      <td className="d-path">{d.path}</td>
      <td><Val v={d.targetVal} /></td>
      <td><Val v={d.ourVal} /></td>
      <td className="d-why">
        <BucketBadge bucket={bucket} small />
        <div className="d-fam">{fam?.title}</div>
        <div className="d-explain"><b>{whyLabelFor(bucket)}</b>{fam?.why}</div>
        <TechDetail label="technical detail">
          <div className="muted">{d.ruleId ? <>rule: <code>{d.ruleId}</code><br /></> : null}{d.rationale}</div>
        </TechDetail>
      </td>
    </tr>
  );
}

function PairDetail({ tgtId, rt, ds }: { tgtId: string | null; rt: string; ds: typeof data }) {
  const view = useStore((s) => s.cmpView);
  const set = useStore((s) => s.set);
  const bf = useStore((s) => s.cmpBucketFilter);
  const pair = ds.pairs.find((p) => p.rt === rt && p.tgtId === tgtId) as Pair | undefined;
  const statusByPath = useMemo(() => { const m = new Map<string, string>(); for (const d of pair?.deltas || []) m.set(d.path, d.status); return m; }, [pair]);
  if (!pair) return <div className="muted pad">Select a resource on the left.</div>;
  const deltas = pair.deltas.filter((d) => bf === "all" || (bf === "equivalent" && d.status === "TOLERATED") || (bf === "couldnt" && d.status === "GAP"));
  const diffNote = `${pair.exact} identical · ${pair.tol} equivalent · ${pair.gap} differ/blank`;
  return (
    <div>
      <div className="cmp-head">
        <h3>{rt} · <span className="muted">{pair.key}</span></h3>
        <MiniBar e={pair.exact} t={pair.tol} g={pair.gap} h={18} showText />
        <div className="cmp-counts">
          <b style={{ color: BUCKET.identical.color }}>{pair.exact}</b> identical&nbsp;·&nbsp;
          <b style={{ color: BUCKET.equivalent.color }}>{pair.tol}</b> equivalent&nbsp;·&nbsp;
          <b style={{ color: BUCKET.couldnt.color }}>{pair.gap}</b> differ or blank
        </div>
      </div>

      <div className="cmp-viewtabs">
        <button className={"vtab" + (view === "diff" ? " on" : "")} onClick={() => set({ cmpView: "diff" })}>Differences{pair.deltas.length ? ` (${pair.deltas.length})` : ""}</button>
        <button className={"vtab" + (view === "json" ? " on" : "")} onClick={() => set({ cmpView: "json" })}>Side-by-side resources</button>
      </div>

      {view === "diff" ? (
        pair.deltas.length === 0 ? (
          <div className="ok-banner">Every field Epic's API returned was reproduced <b>identically</b> from the raw export.</div>
        ) : (
          <>
            <div className="diff-filter">
              show:&nbsp;
              {(["all", "equivalent", "couldnt"] as const).map((f) => (
                <button key={f} className={"tag" + (bf === f ? " on" : "")} onClick={() => set({ cmpBucketFilter: f })}>
                  {f === "all" ? "all differences" : f === "equivalent" ? "equivalent only" : "differ / blank only"}
                </button>
              ))}
            </div>
            <table className="diff">
              <thead><tr><th>field</th><th>Epic's FHIR API</th><th>ours (from the export)</th><th>what's going on</th></tr></thead>
              <tbody>{deltas.map((d, i) => <DiffRow key={i} d={d} />)}</tbody>
            </table>
          </>
        )
      ) : (
        <>
          <p className="muted small">Both full resources, with every differing field <span style={{ color: BUCKET.equivalent.color }}>highlighted</span>. {diffNote}.</p>
          <div className="json-sxs">
            <div><div className="json-h">Epic's FHIR API</div><JsonView obj={pair.target} statusByPath={statusByPath} title="" /></div>
            <div><div className="json-h">Ours (rebuilt from the export)</div><JsonView obj={pair.ours} statusByPath={statusByPath} title="" /></div>
          </div>
        </>
      )}
    </div>
  );
}

function CouldntDetail({ tgtId, rt, ds }: { tgtId: string | null; rt: string; ds: typeof data }) {
  const c = ds.cantReproduce.find((x) => x.rt === rt && (x.tgtId || x.key) === tgtId);
  if (!c) return <div className="muted pad">Select a resource on the left.</div>;
  const fam = (C.couldntFamilies as any)[c.family];
  return (
    <div>
      <div className="cmp-head"><h3>{rt} · <span className="muted">{c.key}</span></h3></div>
      <div className="couldnt-banner">
        <BucketBadge bucket="couldnt" />
        <div className="d-fam">{fam?.title || "Couldn't reproduce"}</div>
        <p>{fam?.why}</p>
        <TechDetail label="technical detail"><span className="muted">{c.reason}</span></TechDetail>
      </div>
      {c.target && <div><div className="json-h">The resource Epic's API returns (we can't rebuild it from the export):</div><JsonView obj={c.target} /></div>}
    </div>
  );
}

function NewDetail({ id, rt, ds }: { id: string | null; rt: string; ds: typeof data }) {
  const r = ds.newResources.find((x) => x.rt === rt && x.our?.id === id) || ds.newResources.find((x) => x.rt === rt);
  const group = C.newResources.groups.find((g) => g.types.includes(rt));
  if (!r) return <div className="muted pad">Select a resource on the left.</div>;
  return (
    <div>
      <div className="cmp-head"><h3>{rt} · <span className="muted">{r.our?.id}</span> <BucketBadge bucket="extra" /></h3></div>
      <div className="new-banner">
        <p><b>{group?.name}.</b> {group?.blurb}</p>
        <p className="muted">Epic's patient-access FHIR API doesn't expose this — we rebuilt it from the export. There's no answer key, so it's validated by the official HL7 validator and reviewed by hand rather than diffed.</p>
      </div>
      <div className="json-h">What we produced:</div>
      <JsonView obj={r.our} />
    </div>
  );
}
