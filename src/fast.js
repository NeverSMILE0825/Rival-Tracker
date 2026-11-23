import https from "node:https";
import { addEvent, getSettings, hasEvent, saveSettings } from "./db.js";
import { ensureRivalToken, relateToken } from "./relate.js";
import { notifyLaunch } from "./telegram.js";
import { nowSec, sleep } from "./util.js";
import { watchPaid } from "./paid.js";

const QUOTES = new Set([
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  "0xdac17f958d2ee523a2206206994597c13d831ec7",
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "0x6b175474e89094c44da98b954eedeac495271d0f",
]);
const seenPools = new Set();
let started = false;

function fetchDextools(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          accept: "application/json",
          "accept-encoding": "identity",
          "X-API-Version": "1",
          connection: "close",
          referer: "https://www.dextools.io/app/ether/live",
        },
        timeout: 8000,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = {};
          try {
            json = JSON.parse(text);
          } catch {
            json = {};
          }
          resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, json });
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("The operation was aborted due to timeout")));
    request.on("error", reject);
  });
}

function launchedToken(pool) {
  const main = String(pool.mainToken?.address || "").toLowerCase();
  const side = String(pool.sideToken?.address || "").toLowerCase();
  if (/^0x[a-f0-9]{40}$/.test(main) && !QUOTES.has(main)) return pool.mainToken;
  if (/^0x[a-f0-9]{40}$/.test(side) && !QUOTES.has(side)) return pool.sideToken;
  return null;
}

async function considerPool(pool, createdAt) {
  const token = launchedToken(pool);
  const pair = String(pool.address || "");
  if (!token || !/^0x[a-fA-F0-9]{40,64}$/.test(pair)) return;
  const address = token.address.toLowerCase();
  if (hasEvent("launch", address)) return;
  const related = await relateToken(address);
  if (!related) return;
  const detectedAt = nowSec();
  const saved = await ensureRivalToken(address, related, {
    name: token.name,
    symbol: token.symbol,
    createdAt,
    createdTx: pool.creationTransaction || related.createdTx || "",
  });
  if (!saved || hasEvent("launch", address)) return;
  addEvent({
    kind: "launch",
    competitorId: related.competitorId,
    address,
    message: `${token.symbol} launched · ${related.rival}`,
  });
  notifyLaunch({
    fast: true,
    symbol: token.symbol,
    name: token.name,
    address,
    deployer: related.deployer,
    rival: related.rival,
    launchedAt: createdAt,
    detectedAt,
    market: {
      pairAddress: pair,
      dextoolsUrl: `https://www.dextools.io/app/ether/pair-explorer/${pair}`,
      marketCap: Number(pool.marketCap) || null,
      liquidityUsd: Number(pool.liquidity) || null,
      priceUsd: Number(pool.price) || null,
    },
  });
  watchPaid(address);
  console.error("fast launch", token.symbol, address);
}

async function pollLivePairs() {
  const settings = getSettings();
  const since = Number(settings.fastSince) || nowSec();
  if (!settings.fastSince) saveSettings({ fastSince: String(since) });
  const response = await fetchDextools("https://www.dextools.io/api/core/pool/listing/liveNew/latest?chain=ether&limit=40");
  if (!response.ok) throw new Error("Dextools live pairs did not respond");
  const pools = response.json?.data?.pools || [];
  let checked = 0;
  for (const pool of pools) {
    const id = String(pool.address || "").toLowerCase();
    if (!id || seenPools.has(id)) continue;
    const createdAt = Math.floor(Date.parse(pool.creationTime || "") / 1000);
    if (!createdAt || createdAt + 30 < since || nowSec() - createdAt > 15 * 60) {
      seenPools.add(id);
      continue;
    }
    checked += 1;
    try {
      await considerPool(pool, createdAt);
      seenPools.add(id);
    } catch (error) {
      console.error("fast pair", error.message);
    }
  }
  if (seenPools.size > 5000) {
    for (const id of seenPools) {
      seenPools.delete(id);
      if (seenPools.size <= 2500) break;
    }
  }
  if (checked) console.error(`fast mode checked ${checked} new pairs`);
}

export function startFastWatch() {
  if (started) return;
  started = true;
  const loop = async () => {
    console.log("Fast Mode watches Dextools live pairs when it is turned on");
    while (true) {
      if (getSettings().fastMode !== "1") {
        await sleep(1000);
        continue;
      }
      try {
        await pollLivePairs();
      } catch (error) {
        console.error("fast mode", error.message);
      }
      await sleep(6000);
    }
  };
  loop();
}
