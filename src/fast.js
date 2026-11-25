import https from "node:https";
import { inDetectLane, transactionLaunch } from "./chain.js";
import { addEvent, getSettings, getToken, hasEvent, saveSettings, setTokenLaunch, tokenExists, upsertToken } from "./db.js";
import { lookupLaunch } from "./launch.js";
import { relateToken } from "./relate.js";
import { watchNarrative } from "./narrative.js";
import { notifyLaunch } from "./telegram.js";
import { nowSec, sleep } from "./util.js";
import { watchPaid } from "./paid.js";
import { fetchAlikePools, pickMainV4, quoteScore } from "./v4pools.js";

const QUOTES = new Set([
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  "0xdac17f958d2ee523a2206206994597c13d831ec7",
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "0x6b175474e89094c44da98b954eedeac495271d0f",
]);
const seenPools = new Set();
const poolQueue = [];
const poolQueued = new Set();
let poolActive = 0;
let started = false;

function fetchDextools(url, timeout = 4000) {
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
        timeout,
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

function poolQuoteSymbol(pool, token) {
  const main = String(pool.mainToken?.address || "").toLowerCase();
  const quote = main === token ? pool.sideToken : pool.mainToken;
  return quote?.symbol || "";
}

async function mainV4Gate(pool, token, createdAt, siblings) {
  const mine = String(pool.address || "").toLowerCase();
  const family = [pool, ...siblings];
  const candidates = new Map();
  const remember = (item) => {
    if (!item.id) return;
    const current = candidates.get(item.id) || { id: item.id, liquidity: 0, quote: 0, tx: 0, fee: null };
    current.liquidity = Math.max(current.liquidity, Number(item.liquidity) || 0);
    current.quote = Math.max(current.quote, Number(item.quote) || 0);
    current.tx = Math.max(current.tx, Number(item.tx) || 0);
    if (item.fee != null && Number.isFinite(Number(item.fee))) current.fee = Number(item.fee);
    candidates.set(item.id, current);
  };
  for (const item of family) {
    remember({
      id: String(item.address || "").toLowerCase(),
      liquidity: item.liquidity,
      quote: quoteScore(poolQuoteSymbol(item, token)),
      tx: item.txCount,
      fee: item.fee,
    });
  }
  try {
    for (const row of await fetchAlikePools(token)) {
      if (!row.v4) continue;
      remember({ id: row.id, liquidity: row.liquidity, quote: quoteScore(row.quote), tx: row.tx, fee: row.fee });
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
  const winner = candidates.get(choice.id);
  if (winner && winner.fee != null && winner.fee >= 10 && young && choice.id === mine) return "retry";
  if (choice.id !== mine) return "skip";
  return "send";
}

function confirmLaunch(address) {
  lookupLaunch(address)
    .then((launch) => {
      if (launch?.createdAt) setTokenLaunch(address, launch);
    })
    .catch((error) => console.error("launch confirm", error.message));
}

async function considerPool(pool, createdAt, siblings = []) {
  const token = launchedToken(pool);
  const pair = String(pool.address || "");
  if (!token || !/^0x[a-fA-F0-9]{40,64}$/.test(pair)) return "skip";
  const address = token.address.toLowerCase();
  if (hasEvent("launch", address)) return "skip";
  const related = await relateToken(address);
  if (!related) return "retry";
  if (isV4Pool(pool)) {
    const gate = await Promise.race([
      mainV4Gate(pool, address, createdAt, siblings),
      sleep(4000).then(() => "retry"),
    ]);
    if (gate === "retry") return "retry";
    if (gate !== "send") {
      console.error("fast v4 side pair", token.symbol, pair);
      return "skip";
    }
  }
  let launchedAt = createdAt;
  let createdBlock = 0;
  let createdTx = "";
  if (related.createdTx) {
    const chain = await Promise.race([
      transactionLaunch(related.createdTx).catch(() => null),
      sleep(2500).then(() => null),
    ]);
    if (chain?.createdAt) {
      launchedAt = chain.createdAt;
      createdBlock = chain.createdBlock;
      createdTx = chain.createdTx;
    }
  }
  if (!token.name || !token.symbol || !launchedAt) return "retry";
  if (!tokenExists(address)) {
    upsertToken({
      address,
      deployer: related.deployer,
      name: token.name,
      symbol: token.symbol,
      decimals: 18,
      createdAt: launchedAt,
      createdTx,
      createdBlock,
    });
    void watchNarrative({ name: token.name, symbol: token.symbol, createdAt: launchedAt });
  }
  if (hasEvent("launch", address)) return "skip";
  const stored = getToken(address);
  const detectedAt = nowSec();
  addEvent({
    kind: "launch",
    competitorId: related.competitorId,
    address,
    message: `${token.symbol} launched · ${related.rival}`,
  });
  watchPaid(address);
  void notifyLaunch({
    fast: true,
    symbol: token.symbol,
    name: token.name,
    address,
    deployer: related.deployer,
    rival: related.rival,
    launchedAt: Number(stored?.created_at) || launchedAt,
    detectedAt,
    market: {
      pairAddress: pair,
      dextoolsUrl: `https://www.dextools.io/app/ether/pair-explorer/${pair}`,
      marketCap: Number(pool.marketCap) || null,
      liquidityUsd: Number(pool.liquidity) || null,
      priceUsd: Number(pool.price) || null,
    },
  });
  void confirmLaunch(address);
  console.error("fast launch", token.symbol, address);
  return "send";
}

function drainPools() {
  while (poolActive < 3 && poolQueue.length) {
    const item = poolQueue.shift();
    poolActive += 1;
    inDetectLane(() => considerPool(item.pool, item.createdAt, item.siblings))
      .then((decision) => {
        if (decision !== "retry") seenPools.add(item.id);
      })
      .catch((error) => console.error("fast pair", error.message))
      .finally(() => {
        poolQueued.delete(item.id);
        poolActive -= 1;
        drainPools();
      });
  }
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
  for (const item of pending) {
    if (poolQueued.has(item.id)) continue;
    const token = String(launchedToken(item.pool)?.address || "").toLowerCase();
    const siblings = (v4ByToken.get(token) || []).filter((pool) => String(pool.address || "").toLowerCase() !== item.id);
    poolQueued.add(item.id);
    poolQueue.push({ ...item, siblings });
  }
  drainPools();
  if (seenPools.size > 5000) {
    for (const id of seenPools) {
      seenPools.delete(id);
      if (seenPools.size <= 2500) break;
    }
  }
}

export function startFastWatch() {
  if (started) return;
  started = true;
  const loop = async () => {
    console.log("Fast Mode watches Dextools live pairs every 2 seconds, ahead of other work");
    while (true) {
      if (getSettings().fastMode !== "1") {
        await sleep(1000);
        continue;
      }
      const startedAt = Date.now();
      try {
        await pollLivePairs();
      } catch (error) {
        console.error("fast mode", error.message);
      }
      const spent = Date.now() - startedAt;
      if (spent > 2500) console.error(`fast pair list took ${Math.round(spent / 1000)}s`);
      await sleep(Math.max(200, 2000 - spent));
    }
  };
  loop();
}
