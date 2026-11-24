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

function isV4Pool(pool) {
  const exchange = String(pool.exchange || "").toLowerCase();
  const address = String(pool.address || "").toLowerCase();
  return exchange === "dexe08a90" || /^0x[a-f0-9]{64}$/.test(address);
}

function quoteScore(symbol) {
  const name = String(symbol || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (name === "eth" || name === "weth") return 50;
  if (name === "usdc" || name === "usdt" || name === "usdcc" || name === "usdce" || name === "dai") return 20;
  return 5;
}

function poolQuoteSymbol(pool, token) {
  const main = String(pool.mainToken?.address || "").toLowerCase();
  const quote = main === token ? pool.sideToken : pool.mainToken;
  return quote?.symbol || "";
}

export function pickMainV4(candidates) {
  const ranked = [...candidates].sort((a, b) => {
    const liquidity = Number(b.liquidity) - Number(a.liquidity);
    if (liquidity) return liquidity;
    const quote = b.quote - a.quote;
    if (quote) return quote;
    return String(a.id).localeCompare(String(b.id));
  });
  const winner = ranked[0];
  if (!winner) return null;
  const tied = ranked.filter((item) => item.liquidity === winner.liquidity && item.quote === winner.quote);
  return { id: winner.id, tiedIds: tied.map((item) => item.id) };
}

async function listedV4Pairs(token) {
  const response = await fetch(`https://api.dexscreener.com/token-pairs/v1/ethereum/${token}`, {
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error(`Dexscreener HTTP ${response.status}`);
  const payload = await response.json();
  const rows = Array.isArray(payload) ? payload : payload.pairs || [];
  return rows.filter((row) => (row.labels || []).some((label) => String(label).toLowerCase() === "v4"));
}

async function mainV4Gate(pool, token, createdAt, siblings) {
  const mine = String(pool.address || "").toLowerCase();
  const family = [pool, ...siblings];
  const candidates = new Map();
  for (const item of family) {
    const id = String(item.address || "").toLowerCase();
    if (!id) continue;
    candidates.set(id, {
      id,
      liquidity: Number(item.liquidity) || 0,
      quote: quoteScore(poolQuoteSymbol(item, token)),
    });
  }
  try {
    for (const row of await listedV4Pairs(token)) {
      const id = String(row.pairAddress || "").toLowerCase();
      if (!/^0x[a-f0-9]{40,64}$/.test(id)) continue;
      const current = candidates.get(id) || { id, liquidity: 0, quote: quoteScore(row.quoteToken?.symbol) };
      current.liquidity = Math.max(current.liquidity, Number(row.liquidity?.usd) || 0);
      current.quote = Math.max(current.quote, quoteScore(row.quoteToken?.symbol));
      candidates.set(id, current);
    }
  } catch (error) {
    console.error("v4 main pair", error.message);
  }
  const choice = pickMainV4([...candidates.values()]);
  if (!choice) return "retry";
  const newest = family.reduce((latest, item) => {
    const created = Math.floor(Date.parse(item.creationTime || "") / 1000) || createdAt || 0;
    return Math.max(latest, created);
  }, 0);
  const young = newest && nowSec() - newest < 45;
  if (choice.tiedIds.length > 1 && young && choice.tiedIds.includes(mine)) return "retry";
  if (choice.id !== mine) return "skip";
  return "send";
}

async function considerPool(pool, createdAt, siblings = []) {
  const token = launchedToken(pool);
  const pair = String(pool.address || "");
  if (!token || !/^0x[a-fA-F0-9]{40,64}$/.test(pair)) return "skip";
  const address = token.address.toLowerCase();
  if (hasEvent("launch", address)) return "skip";
  const related = await relateToken(address);
  if (!related) return "skip";
  const detectedAt = nowSec();
  const saved = await ensureRivalToken(address, related, {
    name: token.name,
    symbol: token.symbol,
    createdAt,
    createdTx: pool.creationTransaction || related.createdTx || "",
  });
  if (!saved || hasEvent("launch", address)) return "skip";
  if (isV4Pool(pool)) {
    const gate = await mainV4Gate(pool, address, createdAt, siblings);
    if (gate === "retry") return "retry";
    if (gate !== "send") {
      console.error("fast v4 side pair", token.symbol, pair);
      return "skip";
    }
  }
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
  return "send";
}

async function pollLivePairs() {
  const settings = getSettings();
  const since = Number(settings.fastSince) || nowSec();
  if (!settings.fastSince) saveSettings({ fastSince: String(since) });
  const response = await fetchDextools("https://www.dextools.io/api/core/pool/listing/liveNew/latest?chain=ether&limit=40");
  if (!response.ok) throw new Error("Dextools live pairs did not respond");
  const pools = response.json?.data?.pools || [];
  const pending = [];
  for (const pool of pools) {
    const id = String(pool.address || "").toLowerCase();
    if (!id || seenPools.has(id)) continue;
    const createdAt = Math.floor(Date.parse(pool.creationTime || "") / 1000);
    if (!createdAt || createdAt + 30 < since || nowSec() - createdAt > 15 * 60) {
      seenPools.add(id);
      continue;
    }
    pending.push({ pool, createdAt, id });
  }
  const v4ByToken = new Map();
  for (const item of pending) {
    if (!isV4Pool(item.pool)) continue;
    const token = String(launchedToken(item.pool)?.address || "").toLowerCase();
    if (!token) continue;
    const list = v4ByToken.get(token) || [];
    list.push(item.pool);
    v4ByToken.set(token, list);
  }
  let checked = pending.length;
  for (const item of pending) {
    const token = String(launchedToken(item.pool)?.address || "").toLowerCase();
    const siblings = (v4ByToken.get(token) || []).filter((pool) => String(pool.address || "").toLowerCase() !== item.id);
    try {
      const decision = await considerPool(item.pool, item.createdAt, siblings);
      if (decision !== "retry") seenPools.add(item.id);
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
