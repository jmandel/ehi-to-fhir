import React, { useState } from "react";
import { data, summaries, BUCKET, pct, targetTypes } from "./data";
import { useStore } from "./store";
import { MiniBar, jump } from "./lib";

type Sort = "faithful" | "size" | "gap";

export function Scorecard() {
  const [sort, setSort] = useState<Sort>("gap");
  const [open, setOpen] = useState<string | null>(null);
  const rows = targetTypes.map((rt) => {
    const p = data.summary.perType[rt];
    const tot = p.exact + p.tolerated + p.gap;
    return { rt, ...p, tot, faithful: pct(p.exact + p.tolerated, tot) };
  });
  rows.sort((a, b) => sort === "size" ? b.tot - a.tot : sort === "gap" ? b.gap - a.gap : a.faithful - b.faithful);

  return (
    <div>
      <div className="sc-sort">
        sort by:&nbsp;
        {([["gap", "most couldn't-reproduce"], ["size", "size"], ["faithful", "least faithful first"]] as [Sort, string][]).map(([k, l]) => (
          <button key={k} className={"tag" + (sort === k ? " on" : "")} onClick={() => setSort(k)}>{l}</button>
        ))}
      </div>
      <table className="sc">
        <thead>
          <tr><th>resource type</th><th>fields</th><th className="num">identical</th><th className="num">equivalent</th><th className="num">couldn't</th><th>mix</th><th className="num">faithful</th><th></th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <React.Fragment key={r.rt}>
              <tr className="sc-row" onClick={() => setOpen(open === r.rt ? null : r.rt)}>
                <td><b>{r.rt}</b> <span className="muted sc-plain">{summaries[r.rt]?.plainName}</span></td>
                <td>{r.tot}</td>
                <td className="num" style={{ color: BUCKET.identical.color }}>{r.exact}</td>
                <td className="num" style={{ color: BUCKET.equivalent.color }}>{r.tolerated || ""}</td>
                <td className="num" style={{ color: BUCKET.couldnt.color }}>{r.gap || ""}</td>
                <td style={{ width: 160 }}><MiniBar e={r.exact} t={r.tolerated} g={r.gap} /></td>
                <td className="num"><b>{r.faithful}%</b></td>
                <td className="sc-exp">{open === r.rt ? "▾" : "▸"}</td>
              </tr>
              {open === r.rt && <tr className="sc-drill"><td colSpan={8}><ResourceDrill rt={r.rt} /></td></tr>}
            </React.Fragment>
          ))}
          <tr className="sc-total">
            <td><b>All resources</b></td>
            <td><b>{data.summary.total}</b></td>
            <td className="num" style={{ color: BUCKET.identical.color }}>{data.summary.exact}</td>
            <td className="num" style={{ color: BUCKET.equivalent.color }}>{data.summary.tolerated}</td>
            <td className="num" style={{ color: BUCKET.couldnt.color }}>{data.summary.gap}</td>
            <td><MiniBar e={data.summary.exact} t={data.summary.tolerated} g={data.summary.gap} /></td>
            <td className="num"><b>{pct(data.summary.exact + data.summary.tolerated, data.summary.total)}%</b></td>
            <td></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function ResourceDrill({ rt }: { rt: string }) {
  const open = useStore((s) => s.openCompare);
  const s = summaries[rt];
  if (!s) return null;
  return (
    <div className="drill">
      <p className="drill-lead">{s.whatItIs}</p>
      <div className="drill-grid">
        <Field label="Rebuilt from">{s.rebuiltFrom}</Field>
        <Field label="How faithful">{s.howFaithful}</Field>
        <Field label="What came through perfectly">{s.whatsIdentical}</Field>
        <Field label="What differs, and why it's OK">{s.whatDiffersAndWhy}</Field>
        <Field label="What's still missing">{s.whatsLost}</Field>
        <Field label="Nicest reconstruction trick">{s.mostInterestingTrick}</Field>
      </div>
      <button className="chip" onClick={() => { open(rt); jump("compare"); }}>Compare real {rt} examples →</button>
    </div>
  );
}
const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="drill-field"><div className="drill-label">{label}</div><div>{children}</div></div>
);
