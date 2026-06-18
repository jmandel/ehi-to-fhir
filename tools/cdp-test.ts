/**
 * cdp-test.ts — headless-chromium smoke test of report/index.html over the Chrome DevTools Protocol.
 * Launches chromium headless, loads the file:// page, captures console/page errors, asserts the React
 * app actually rendered (key sections + interactive bits present), exercises a couple of clicks, and
 * writes a screenshot. No puppeteer; raw CDP over WebSocket.
 *
 *   bun tools/cdp-test.ts
 */
import { resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const URL = "file://" + resolve(ROOT, "report/index.html");
const PORT = 9333;
const CHROME = ["/usr/bin/chromium", "/usr/bin/google-chrome-stable"].find((p) => Bun.file(p).size !== undefined) || "chromium";

const proc = Bun.spawn([CHROME, "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  `--remote-debugging-port=${PORT}`, "--window-size=1280,2200", "about:blank"], { stdout: "ignore", stderr: "ignore" });

async function getWs(): Promise<string> {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t: any) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("chromium page target never came up");
}

let id = 0;
const pending = new Map<number, (v: any) => void>();
const events: any[] = [];
function send(ws: WebSocket, method: string, params: any = {}): Promise<any> {
  const myId = ++id;
  ws.send(JSON.stringify({ id: myId, method, params }));
  return new Promise((res) => {
    pending.set(myId, res); // resolves with the FULL message {id,result?,error?}
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); res({ error: { message: "timeout " + method } }); } }, 8000);
  });
}

const consoleErrors: string[] = [];
const pageErrors: string[] = [];

try {
  const wsUrl = await getWs();
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((res) => (ws.onopen = () => res()));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data as string);
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
    else if (m.method) {
      events.push(m);
      if (m.method === "Runtime.exceptionThrown") pageErrors.push(m.params?.exceptionDetails?.exception?.description || JSON.stringify(m.params?.exceptionDetails));
      if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error") consoleErrors.push((m.params.args || []).map((a: any) => a.value || a.description || a.unserializableValue || "").join(" "));
      if (m.method === "Log.entryAdded" && m.params?.entry?.level === "error") consoleErrors.push(m.params.entry.text);
    }
  };
  await send(ws, "Page.enable");
  await send(ws, "Runtime.enable");
  await send(ws, "Log.enable");

  await send(ws, "Page.navigate", { url: URL });
  // wait for load event
  await new Promise<void>((res) => { const t = setInterval(() => { if (events.some((e) => e.method === "Page.loadEventFired")) { clearInterval(t); res(); } }, 50); setTimeout(() => res(), 6000); });
  await Bun.sleep(900); // let React paint

  const evalJs = async (expr: string) => {
    const m = await send(ws, "Runtime.evaluate", { expression: expr, returnByValue: true });
    if (m.error) { consoleErrors.push("eval error: " + JSON.stringify(m.error)); return undefined; }
    if (m.result?.exceptionDetails) { return undefined; }
    return m.result?.result?.value;
  };

  const checks: [string, any][] = [];
  checks.push(["#root has children", await evalJs(`document.querySelector('#root')?.children.length > 0`)]);
  checks.push(["hero h1 text", await evalJs(`document.querySelector('.hero h1')?.textContent || ''`)]);
  checks.push(["nav links count", await evalJs(`document.querySelectorAll('.nav-link').length`)]);
  checks.push(["scorecard rows", await evalJs(`document.querySelectorAll('.sc-row').length`)]);
  checks.push(["compare type pills", await evalJs(`document.querySelectorAll('.cmp-types .pill').length`)]);
  checks.push(["diff table present", await evalJs(`!!document.querySelector('table.diff') || !!document.querySelector('.ok-banner')`)]);
  checks.push(["family cards", await evalJs(`document.querySelectorAll('.fam-card').length`)]);
  checks.push(["new-resource cards", await evalJs(`document.querySelectorAll('.new-card').length`)]);
  checks.push(["scatter svg circles", await evalJs(`document.querySelectorAll('.chart svg circle').length`)]);
  checks.push(["treemap rects", await evalJs(`document.querySelectorAll('.chart svg rect').length`)]);

  // exercise: expand a scorecard row, then click a compare type pill, then toggle full JSON
  await evalJs(`document.querySelectorAll('.sc-row')[0]?.click()`);
  await Bun.sleep(150);
  checks.push(["drill-in opens", await evalJs(`!!document.querySelector('.drill')`)]);
  await evalJs(`[...document.querySelectorAll('.cmp-types .pill')].find(b=>b.textContent==='Encounter')?.click()`);
  await Bun.sleep(250);
  checks.push(["compare switched to Encounter", await evalJs(`!!document.querySelector('.cmp-head h3')?.textContent.includes('Encounter')`)]);
  await evalJs(`[...document.querySelectorAll('.json-controls .chip')][0]?.click()`);
  await Bun.sleep(250);
  checks.push(["full JSON shows", await evalJs(`document.querySelectorAll('.jsonview .json-body').length`)]);
  checks.push(["highlighted leaves in JSON", await evalJs(`document.querySelectorAll('.json-body .j-val[style*="border-bottom"]').length`)]);
  // glossary
  await evalJs(`document.querySelector('.nav-gloss')?.click()`);
  await Bun.sleep(150);
  checks.push(["glossary opens", await evalJs(`!!document.querySelector('.gloss-drawer')`)]);
  await evalJs(`document.querySelector('.gloss-x')?.click()`); await Bun.sleep(80);

  // viewport screenshot of the top of the page (best-effort)
  try {
    await evalJs(`window.scrollTo(0,0)`); await Bun.sleep(120);
    const shot = (await send(ws, "Page.captureScreenshot", { format: "png" })).result;
    if (shot?.data) await Bun.write(resolve(ROOT, "report/_smoketest.png"), Buffer.from(shot.data, "base64"));
    else console.log("(screenshot unavailable)");
  } catch (e) { console.log("(screenshot failed: " + e + ")"); }

  console.log("\n=== CDP smoke test ===");
  let fail = 0;
  for (const [name, val] of checks) {
    const ok = typeof val === "number" ? val > 0 : typeof val === "boolean" ? val : !!val;
    if (!ok) fail++;
    console.log(`${ok ? "✓" : "✗"} ${name}: ${JSON.stringify(val)}`);
  }
  console.log(`\nconsole errors (${consoleErrors.length}):`); consoleErrors.slice(0, 20).forEach((e) => console.log("  ! " + e));
  console.log(`page exceptions (${pageErrors.length}):`); pageErrors.slice(0, 20).forEach((e) => console.log("  ! " + e));
  console.log(`\nscreenshot: report/_smoketest.png`);
  const pass = fail === 0 && pageErrors.length === 0;
  console.log(pass ? "\nRESULT: PASS ✅" : `\nRESULT: ${fail} check fails, ${pageErrors.length} exceptions ❌`);
  ws.close();
  proc.kill();
  await Bun.sleep(50);
  process.exit(pass ? 0 : 1);
} catch (e) {
  console.error("HARNESS ERROR:", e);
  proc.kill();
  process.exit(2);
}
