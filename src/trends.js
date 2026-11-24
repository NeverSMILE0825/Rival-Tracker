import {
  livePairCoverage,
  listLivePairsSince,
  pruneLivePairs,
  readTrendState,
  saveLivePair,
  writeTrendState,
} from "./db.js";
import { narrativeKeys, watchNarrative } from "./narrative.js";
import { nowSec, sleep } from "./util.js";

const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const NATIVE = "0x0000000000000000000000000000000000000000";
const QUOTES = new Set([
  WETH,
  NATIVE,
  "0xdac17f958d2ee523a2206206994597c13d831ec7",
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "0x6b175474e89094c44da98b954eedeac495271d0f",
]);
const SKIP_SYMBOLS = new Set(["ETH", "WETH", "USDT", "USDC", "DAI", "USD", "WBTC"]);
const HISTORY = 7 * 86400;
const KEEP = 8 * 86400;
const ALERT_AGE = 10 * 60;

export const TREND_WINDOWS = [
  { id: "1h", seconds: 3600 },
  { id: "6h", seconds: 6 * 3600 },
  { id: "12h", seconds: 12 * 3600 },
  { id: "24h", seconds: 24 * 3600 },
  { id: "3d", seconds: 3 * 86400 },
  { id: "7d", seconds: 7 * 86400 },
];

let started = false;

function quoteKind(token) {
  const address = String(token?.address || "").toLowerCase();
  const symbol = String(token?.symbol || "").toUpperCase();
  if (address === WETH || symbol === "WETH") return "WETH";
  if (address === NATIVE || symbol === "ETH") return "ETH";
  return "";
}

function listedToken(pool) {
  const mainQuote = quoteKind(pool.mainToken);
  const sideQuote = quoteKind(pool.sideToken);
  if ((mainQuote && sideQuote) || (!mainQuote && !sideQuote)) return null;
  const token = mainQuote ? pool.sideToken : pool.mainToken;
  const address = String(token?.address || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(address) || QUOTES.has(address)) return null;
  const name = String(token?.name || "").trim();
  const symbol = String(token?.symbol || "").trim();
  if ((!name && !symbol) || SKIP_SYMBOLS.has(symbol.toUpperCase())) return null;
  return { token: address, name, symbol, quote: mainQuote || sideQuote };
}

async function fetchPage(ts) {
  const url = ts
    ? `https://www.dextools.io/api/core/pool/listing/liveNew?chain=ether&limit=100&ts=${ts}`
    : "https://www.dextools.io/api/core/pool/listing/liveNew/latest?chain=ether&limit=100";
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "X-API-Version": "1",
      referer: "https://www.dextools.io/app/ether/live",
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Dextools live pairs returned ${response.status}`);
  const json = await response.json();
  return {
    pools: json?.data?.pools || [],
    next: Number(json?.data?.next?.ts) || 0,
  };
}

function storePools(pools, alert) {
  for (const pool of pools) {
    const pair = String(pool.address || "").toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(pair) && !/^0x[a-f0-9]{64}$/.test(pair)) continue;
    const token = listedToken(pool);
    const createdAt = Math.floor(Date.parse(pool.creationTime || "") / 1000);
    if (!token || !createdAt) continue;
    const fresh = saveLivePair({ pair, ...token, createdAt });
    if (fresh && alert && nowSec() - createdAt <= ALERT_AGE) {
      watchNarrative({ name: token.name, symbol: token.symbol, createdAt });
    }
  }
}

function usualName(counts) {
  let best = "";
  let score = 0;
  for (const [name, count] of counts) {
    if (count > score && name) {
      best = name;
      score = count;
    }
  }
  return best;
}

export function trendBoard(windowId) {
  const window = TREND_WINDOWS.find((item) => item.id === windowId) || TREND_WINDOWS[0];
  const since = nowSec() - window.seconds;
  const pairs = listLivePairsSince(since);
  const groups = new Map();
  for (const pair of pairs) {
    for (const key of narrativeKeys(pair.name, pair.symbol)) {
      const group = groups.get(key) || { key, count: 0, latest: 0, names: new Map(), pairs: [] };
      group.count += 1;
      group.latest = Math.max(group.latest, Number(pair.createdAt) || 0);
      const name = String(pair.name || "");
      if (name) group.names.set(name, (group.names.get(name) || 0) + 1);
      group.pairs.push(pair);
      groups.set(key, group);
    }
  }
  const rows = [...groups.values()]
    .filter((group) => group.count >= 2)
    .map((group) => ({
      key: group.key,
      name: usualName(group.names),
      count: group.count,
      latest: group.latest,
      pairs: group.pairs
        .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))
        .slice(0, 80)
        .map((pair) => ({
          pair: pair.pair,
          token: pair.token,
          name: pair.name,
          symbol: pair.symbol,
          quote: pair.quote,
          createdAt: pair.createdAt,
        })),
    }))
    .sort((a, b) => b.count - a.count || b.latest - a.latest);
  const coverage = livePairCoverage();
  const target = nowSec() - HISTORY;
  return {
    window: window.id,
    seconds: window.seconds,
    pairs: pairs.length,
    coverage: {
      oldest: coverage.oldest,
      newest: coverage.newest,
      stored: coverage.stored,
      ready: Boolean(coverage.oldest) && coverage.oldest <= target,
    },
    rows,
  };
}

async function backfillPage(cursor) {
  const page = await fetchPage(cursor);
  storePools(page.pools, false);
  const times = page.pools.map((pool) => Math.floor(Date.parse(pool.creationTime || "") / 1000)).filter((time) => time > 0);
  const oldest = times.length ? Math.min(...times) : 0;
  return { next: page.next, oldest };
}

export function startTrendWatch() {
  if (started) return;
  started = true;
  const loop = async () => {
    console.log("Trend watch counts every ETH and WETH pair on Dextools live");
    let cursor = Number(readTrendState("cursor")) || 0;
    let done = readTrendState("done") === "1";
    const coverage = livePairCoverage();
    if (coverage.newest && nowSec() - coverage.newest > 3 * 3600) {
      cursor = 0;
      done = false;
      writeTrendState("cursor", "0");
      writeTrendState("done", "0");
    }
    while (true) {
      try {
        const latest = await fetchPage(0);
        storePools(latest.pools, true);
        if (!cursor) cursor = latest.next;
      } catch (error) {
        console.error("trend latest", error.message);
      }
      for (let step = 0; step < 2 && !done && cursor; step += 1) {
        try {
          const page = await backfillPage(cursor);
          const target = nowSec() - HISTORY;
          if (!page.next || page.next >= cursor || (page.oldest && page.oldest <= target)) {
            done = true;
            writeTrendState("done", "1");
          } else {
            cursor = page.next;
            writeTrendState("cursor", String(cursor));
          }
        } catch (error) {
          console.error("trend history", error.message);
          break;
        }
        await sleep(400);
      }
      try {
        pruneLivePairs(nowSec() - KEEP);
      } catch (error) {
        console.error("trend prune", error.message);
      }
      await sleep(12000);
    }
  };
  loop();
}
