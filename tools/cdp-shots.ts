// Capture viewport screenshots of specific sections (visual QA). bun tools/cdp-shots.ts
import { resolve } from "path";
const ROOT = resolve(import.meta.dir, "..");
const URL = "file://" + resolve(ROOT, "report/index.html");
const PORT = 9344;
const CHROME = ["/usr/bin/chromium", "/usr/bin/google-chrome-stable"].find((p) => Bun.file(p).size !== undefined) || "chromium";
const proc = Bun.spawn([CHROME, "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", `--remote-debugging-port=${PORT}`, "--window-size=1320,1100", "about:blank"], { stdout: "ignore", stderr: "ignore" });
let id = 0; const pending = new Map<number, any>();
const wsUrl = await (async () => { for (let i = 0; i < 60; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = l.find((t: any) => t.type === "page"); if (p) return p.webSocketDebuggerUrl; } catch {} await Bun.sleep(100); } throw new Error("no page"); })();
const ws = new WebSocket(wsUrl); await new Promise<void>((r) => (ws.onopen = () => r()));
ws.onmessage = (e) => { const m = JSON.parse(e.data as string); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method: string, params: any = {}) => new Promise<any>((res) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); pending.set(i, res); setTimeout(() => { if (pending.has(i)) { pending.delete(i); res({}); } }, 8000); });
await send("Page.enable"); await send("Runtime.enable");
await send("Page.navigate", { url: URL }); await Bun.sleep(1500);
await send("Runtime.evaluate", { expression: `document.documentElement.style.scrollBehavior='auto'` });
const shoot = async (selector: string, name: string, prep?: string) => {
  if (prep) { await send("Runtime.evaluate", { expression: prep }); await Bun.sleep(400); }
  await send("Runtime.evaluate", { expression: `(()=>{const el=document.querySelector('${selector}'); if(el){const y=el.getBoundingClientRect().top+window.scrollY-70; window.scrollTo(0,y);}})()` });
  await Bun.sleep(450);
  const shot = (await send("Page.captureScreenshot", { format: "png" })).result;
  if (shot?.data) { await Bun.write(resolve(ROOT, `report/_shot-${name}.png`), Buffer.from(shot.data, "base64")); console.log("wrote _shot-" + name + ".png"); }
};
await shoot("#top", "hero");
await shoot("#compare", "compare-json", `[...document.querySelectorAll('.cmp-viewtabs .vtab')].find(b=>b.textContent.includes('Side-by-side'))?.click()`);
await shoot("#families", "families-treemap", `[...document.querySelectorAll('.chart svg g[style]')][1]?.dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
await shoot("#missing", "missing");
ws.close(); proc.kill(); await Bun.sleep(50); process.exit(0);
