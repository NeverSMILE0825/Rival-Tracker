import https from "node:https";
import { getToken, listTokenPairAddresses, listTokenSwaps, mainTokenPair } from "./db.js";
import { teamAddresses } from "./profit.js";
import { ethToWei } from "./util.js";

const cache = new Map();
let ethQuote = { at: 0, usd: 0 };

function getJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          accept: "application/json",
          "accept-encoding": "identity",
          connection: "close",
          referer: "https://www.dextools.io/app/ether/pair-explorer",
          ...headers,
        },
        timeout: 12000,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`Dextools HTTP ${response.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error("Dextools returned invalid JSON"));
          }
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("Dextools timeout")));
    request.on("error", reject);
  });
}

function realSwaps(token) {
  const rows = listTokenSwaps(token);
  const counts = new Map();
  for (const row of rows) {
    const dest = String(row.tx_to || "").toLowerCase();
    if (!dest) continue;
    counts.set(dest, (counts.get(dest) || 0) + 1);
  }
  const team = new Set(teamAddresses([...counts].map(([dest, n]) => ({ dest, n }))));
  return rows.filter((row) => {
    const side = String(row.side || "");
    if (Number(row.measured) !== 1 || (side !== "buy" && side !== "sell")) return false;
    return !team.has(String(row.tx_to || "").toLowerCase());
  });
}

function eventUsd(event) {
  const type = String(event?.type || "").toLowerCase();
  const usd = Number(event?.amountUSD);
  if ((type === "buy" || type === "sell") && Number.isFinite(usd) && usd >= 0) return usd;
  return null;
}

async function ethUsd() {
  if (ethQuote.usd > 0 && Date.now() - ethQuote.at < 60_000) return ethQuote.usd;
  try {
    const body = await getJson("https://api.dexscreener.com/tokens/v1/ethereum/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");
    const price = Number(Array.isArray(body) ? body.find((pair) => Number(pair?.priceUsd) > 0)?.priceUsd : 0);
    if (price > 0) ethQuote = { at: Date.now(), usd: price };
    return price > 0 ? price : 0;
  } catch {
    return ethQuote.usd || 0;
  }
}

function weiFromEth(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  try {
    return ethToWei(number.toFixed(18)).toString();
  } catch {
    return null;
  }
}

async function gecko(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "RivalTracker/1.0" },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`Chart HTTP ${response.status}`);
  return response.json();
}

function candlePlan(span) {
  if (span <= 6 * 3600) return { frame: "minute", aggregate: 1 };
  if (span <= 36 * 3600) return { frame: "minute", aggregate: 5 };
  if (span <= 10 * 86400) return { frame: "minute", aggregate: 15 };
  if (span <= 40 * 86400) return { frame: "hour", aggregate: 1 };
  return { frame: "hour", aggregate: 4 };
}

async function poolCloses(pair, fromSec) {
  const now = Math.floor(Date.now() / 1000);
  const plan = candlePlan(Math.max(300, now - fromSec));
  const rows = [];
  let before = null;
  for (let page = 0; page < 4; page += 1) {
    const older = before ? `&before_timestamp=${before}` : "";
    const body = await gecko(
      `https://api.geckoterminal.com/api/v2/networks/eth/pools/${pair}/ohlcv/${plan.frame}?aggregate=${plan.aggregate}&limit=1000&currency=usd${older}`,
    );
    const list = body?.data?.attributes?.ohlcv_list || [];
    if (!list.length) break;
    for (const item of list) {
      const time = Number(item?.[0]);
      const close = Number(item?.[4]);
      if (time > 0 && close > 0) rows.push({ time, close, high: Number(item?.[2]) || close, low: Number(item?.[3]) || close });
    }
    const oldest = Number(list[list.length - 1]?.[0]);
    if (!oldest || oldest <= fromSec || list.length < 1000) break;
    before = oldest;
  }
  const unique = [];
  for (const row of rows.sort((a, b) => a.time - b.time)) {
    if (row.time < fromSec - 3600) continue;
    if (unique.length && unique[unique.length - 1].time === row.time) unique[unique.length - 1] = row;
    else unique.push(row);
  }
  return unique;
}

async function topGeckoPool(token) {
  const body = await gecko(`https://api.geckoterminal.com/api/v2/networks/eth/tokens/${token}/pools?page=1`);
  const id = String(body?.data?.[0]?.id || "");
  const pool = id.slice(id.indexOf("_") + 1).toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(pool) || /^0x[a-f0-9]{64}$/.test(pool) ? pool : "";
}

async function tokenChart(tokenRow, supply) {
  if (!(supply > 0)) return [];
  const preferred = mainTokenPair(tokenRow.address);
  const from = Number(tokenRow.pair_created_at) || Number(tokenRow.created_at) || Math.floor(Date.now() / 1000) - 30 * 86400;
  let candles = preferred ? await poolCloses(preferred, from).catch(() => []) : [];
  if (candles.length < 2) {
    const pool = await topGeckoPool(tokenRow.address).catch(() => "");
    if (pool && pool !== preferred) candles = await poolCloses(pool, from).catch(() => []);
  }
  return candles.map((row) => ({
    time: row.time,
    mcap: row.close * supply,
    high: row.high * supply,
    low: row.low * supply,
  }));
}

async function tokenSupply(token) {
  const body = await getJson(`https://www.dextools.io/shared/data/token?tokens=ether:${token}`);
  const metrics = body?.data?.[0]?.metrics || {};
  const circulating = Number(metrics.circulatingSupply);
  const total = Number(metrics.totalSupply);
  const max = Number(metrics.maxSupply);
  if (circulating > 0) return circulating;
  if (total > 0) return total;
  if (max > 0) return max;
  return null;
}

async function pairEvents(pair) {
  const events = [];
  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < 300; page += 1) {
    const parts = ["limit=100"];
    if (cursor) {
      for (const [key, value] of Object.entries(cursor)) {
        if (value != null) parts.push(`${key}=${value}`);
      }
    }
    const direction = cursor ? "desc" : "newest";
    const body = await getJson(`https://www.dextools.io/api/core/pool/events/ether/${pair}/${direction}?${parts.join("&")}`, {
      "X-API-Version": "2",
    });
    const data = body?.data || {};
    let added = 0;
    for (const event of data.events || []) {
      const id = String(event.id || "").toLowerCase();
      if (!/^0x[a-f0-9]{64}$/.test(id) || seen.has(id)) continue;
      seen.add(id);
      events.push(event);
      added += 1;
    }
    const next = data.next;
    if (!next || added === 0) break;
    if (cursor && next.blockNumber === cursor.blockNumber && next.logIndex === cursor.logIndex) break;
    cursor = next;
  }
  return events;
}

export async function realBuyerTrades(address) {
  const token = String(address || "").toLowerCase();
  const saved = getToken(token);
  if (!saved) return null;
  const cached = cache.get(token);
  if (cached && Date.now() - cached.at < (cached.ready ? 60_000 : 15_000)) return cached.value;
  const swaps = realSwaps(token);
  const ready = Boolean(saved.profit_checked_at);
  const pairs = listTokenPairAddresses(token);
  const byTx = new Map();
  const makerCount = new Map();
  let supply = null;
  let chart = [];
  try {
    const supplyPromise = tokenSupply(token).catch(() => null);
    const chartPromise = supplyPromise.then((value) => tokenChart(saved, value).catch(() => []));
    const lists = await Promise.all(pairs.map((pair) => pairEvents(pair).catch(() => [])));
    for (const events of lists) {
      for (const event of events) {
        const id = String(event.id || "").toLowerCase();
        const type = String(event.type || "").toLowerCase();
        if (type === "buy" || type === "sell" || type === "add" || type === "remove") {
          const maker = String(event.maker || "").toLowerCase();
          if (/^0x[a-f0-9]{40}$/.test(maker)) makerCount.set(maker, (makerCount.get(maker) || 0) + 1);
        }
        const current = byTx.get(id);
        if (!current || ((type === "buy" || type === "sell") && current.type !== "buy" && current.type !== "sell")) byTx.set(id, event);
      }
    }
    supply = await supplyPromise;
    chart = await chartPromise;
  } catch (error) {
    console.error("real buyers", token, error.message);
  }
  const rows = swaps.map((swap) => {
    const hash = String(swap.tx_hash || "").toLowerCase();
    const event = byTx.get(hash);
    const side = String(swap.side || event?.type || "").toLowerCase();
    const type = side === "sell" ? "sell" : "buy";
    const maker = String(event?.maker || "").toLowerCase();
    const price = Number(event?.price) || Number(event?.previousData?.price);
    const mcap = supply && price > 0 ? price * supply : null;
    const amountWei = swap.amount_wei && swap.amount_wei !== "0" ? String(swap.amount_wei) : weiFromEth(event?.amountETH);
    const time = Number(event?.timestamp) || null;
    return {
      tx: hash,
      time,
      block: Number(swap.block_number) || 0,
      type,
      mcap,
      amountWei,
      amountUsd: eventUsd(event),
      count: /^0x[a-f0-9]{40}$/.test(maker) ? makerCount.get(maker) || 1 : null,
      maker: /^0x[a-f0-9]{40}$/.test(maker) ? maker : "",
    };
  });
  if (rows.some((row) => row.amountUsd == null && row.amountWei)) {
    const price = await ethUsd();
    if (price > 0) {
      for (const row of rows) {
        if (row.amountUsd == null && row.amountWei) row.amountUsd = (Number(row.amountWei) / 1e18) * price;
      }
    }
  }
  const value = { ready, symbol: saved.symbol || "", name: saved.name || "", rows, chart };
  cache.set(token, { at: Date.now(), ready: ready && rows.length > 0, value });
  return value;
}
