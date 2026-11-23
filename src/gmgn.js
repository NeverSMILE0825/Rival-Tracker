import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listTokensForAth, saveTokenAth } from "./db.js";
import { sleep } from "./util.js";

const port = 9334;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profile = path.join(root, "data", "gmgn-chrome");
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

let pageSocket = null;
let started = false;

function send(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 1e9);
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error("GMGN browser timed out"));
    }, 20000);
    const onMessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      if (message.error) reject(new Error(message.error.message || "GMGN browser failed"));
      else resolve(message);
    };
    ws.addEventListener("message", onMessage);
  });
}

async function debuggerTargets() {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error("GMGN browser list failed");
  return response.json();
}

function launchChrome() {
  mkdirSync(profile, { recursive: true });
  const child = spawn(
    chromePath,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
      "--window-position=-2400,-2400",
      "--window-size=900,700",
      "https://gmgn.ai/",
    ],
    { stdio: "ignore", detached: true },
  );
  child.unref();
}

async function ensureChrome() {
  try {
    return await debuggerTargets();
  } catch {
    launchChrome();
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(400);
    try {
      return await debuggerTargets();
    } catch {
      // Chrome is still starting.
    }
  }
  throw new Error("GMGN browser did not start");
}

async function ensureSocket() {
  if (pageSocket && pageSocket.readyState === WebSocket.OPEN) return pageSocket;
  pageSocket = null;
  const targets = await ensureChrome();
  const page = targets.find((target) => target.type === "page" && String(target.url || "").includes("gmgn.ai"));
  if (!page?.webSocketDebuggerUrl) throw new Error("GMGN page is not open");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("GMGN page socket timed out")), 8000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("GMGN page socket failed"));
    });
  });
  pageSocket = ws;
  ws.addEventListener("close", () => {
    if (pageSocket === ws) pageSocket = null;
  });
  return ws;
}

async function fetchAth(addresses) {
  const ws = await ensureSocket();
  const message = await send(ws, "Runtime.evaluate", {
    expression: `(async () => {
      const response = await fetch("/mrwapi/v1/multi_token_info", {
        method: "POST",
        credentials: "include",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ chain: "eth", addresses: ${JSON.stringify(addresses)} })
      });
      const text = await response.text();
      if (!response.ok) return { status: response.status, head: text.slice(0, 140) };
      const json = JSON.parse(text);
      const rows = Array.isArray(json.data) ? json.data : [];
      return {
        status: 200,
        rows: rows.map((row) => {
          const price = Number(row.ath_price);
          const supply = Number(row.total_supply);
          return {
            address: String(row.address || "").toLowerCase(),
            ath: price > 0 && supply > 0 ? price * supply : null
          };
        })
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const value = message.result?.result?.value;
  if (!value || value.status !== 200) throw new Error(value?.head || "GMGN ATH did not respond");
  return value.rows.filter((row) => /^0x[a-f0-9]{40}$/.test(row.address));
}

export function startAthWatch() {
  if (started) return;
  started = true;
  const loop = async () => {
    console.log("GMGN all-time-high market caps are filling the token table");
    while (true) {
      const addresses = listTokensForAth(10).filter((address) => /^0x[a-f0-9]{40}$/.test(address));
      if (!addresses.length) {
        await sleep(15000);
        continue;
      }
      try {
        const rows = await fetchAth(addresses);
        const found = new Set(rows.map((row) => row.address));
        for (const row of rows) saveTokenAth(row.address, row.ath);
        for (const address of addresses) {
          if (!found.has(address)) saveTokenAth(address, null);
        }
      } catch (error) {
        console.error("gmgn ath", error.message);
        if (pageSocket) {
          pageSocket.close();
          pageSocket = null;
        }
        await sleep(8000);
        continue;
      }
      await sleep(4000);
    }
  };
  loop();
}
