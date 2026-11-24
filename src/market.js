import { getSettings, getToken, listTokenAddresses, replaceTokenPairs, setTokenBanner, updateTokenMarket } from "./db.js";
import { fetchAlikePools, fetchPairSwaps, pickMainV4, quoteScore } from "./v4pools.js";
import { nowSec, sleep } from "./util.js";

function classify(liquidity, peak, threshold) {
  if (liquidity == null) {
    if (peak >= threshold) return "rugged";
    return "unlisted";
  }
  if (liquidity >= threshold) return "live";
  if (peak >= threshold && liquidity < threshold * 0.25) return "rugged";
  return "thin";
}

function isPoolId(value) {
  const pair = String(value || "");
  return /^0x[a-fA-F0-9]{40}$/.test(pair) || /^0x[a-fA-F0-9]{64}$/.test(pair);
}

function dextoolsUrl(pairAddress) {
  const pair = String(pairAddress || "");
  if (!isPoolId(pair)) return "";
  return `https://www.dextools.io/app/ether/pair-explorer/${pair}`;
}

function exchangeLabel(pair) {
  const labels = Array.isArray(pair.labels) ? pair.labels.map((item) => String(item)) : [];
  const version = labels.find((item) => /^v\d/i.test(item));
  if (version) return version.toLowerCase();
  if (labels[0]) return labels[0].toLowerCase();
  return String(pair.dexId || "").toLowerCase();
}

function pairStatus(liquidity, threshold) {
  if (!(liquidity > 0)) return "unlisted";
  if (liquidity >= threshold) return "live";
  return "thin";
}

function pairRecord(pair, threshold) {
  const liquidity = Number(pair.liquidity?.usd ?? 0);
  const buys = pair.txns?.h24?.buys || 0;
  const sells = pair.txns?.h24?.sells || 0;
  return {
    pairAddress: pair.pairAddress,
    dex: pair.dexId || null,
    label: exchangeLabel(pair),
    priceUsd: pair.priceUsd != null ? Number(pair.priceUsd) : null,
    liquidityUsd: liquidity,
    marketCap: pair.marketCap != null ? Number(pair.marketCap) : null,
    fdv: pair.fdv != null ? Number(pair.fdv) : null,
    volume24h: pair.volume?.h24 != null ? Number(pair.volume.h24) : null,
    priceChange24h: pair.priceChange?.h24 != null ? Number(pair.priceChange.h24) : null,
    txns24h: buys + sells,
    pairCreatedAt: pair.pairCreatedAt ? Math.floor(Number(pair.pairCreatedAt) / 1000) : null,
    status: pairStatus(liquidity, threshold),
    dextoolsUrl: dextoolsUrl(pair.pairAddress),
    dexscreenerUrl: pair.url || null,
    quoteSymbol: pair.quoteToken?.symbol || null,
    liquidity,
  };
}

async function fetchTokenPairs(address, timeout = 20000, attempts = 3) {
  const url = `https://api.dexscreener.com/token-pairs/v1/ethereum/${address}`;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    if (response.status === 429) {
      await sleep(500 * attempt);
      continue;
    }
    if (!response.ok) throw new Error(`Dexscreener HTTP ${response.status}`);
    const payload = await response.json();
    await sleep(220);
    return Array.isArray(payload) ? payload : payload.pairs || [];
  }
  throw new Error("Dexscreener rate limit");
}

async function fetchTransferCount(address) {
  const response = await fetch(`https://eth.blockscout.com/api/v2/tokens/${address}/counters`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(4000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Blockscout HTTP ${response.status}`);
  const payload = await response.json();
  return parseCount(payload.transfers_count);
}

function parseCount(value) {
  const digits = String(value ?? "").replace(/[^\d]/g, "");
  if (!digits) return null;
  const count = Number(digits);
  return Number.isFinite(count) ? count : null;
}

function largestCount(...values) {
  const counts = values.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0);
  if (!counts.length) return null;
  return Math.max(...counts);
}

function mapLimit(items, limit, fn) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await fn(items[index], index);
    }
  });
  return Promise.all(workers);
}

function markMainPair(records) {
  const v4 = records.filter((record) => String(record.label || "").toLowerCase() === "v4");
  const choice = pickMainV4(
    v4.map((record) => ({
      id: String(record.pairAddress || "").toLowerCase(),
      liquidity: Number(record.liquidityUsd) || 0,
      quote: quoteScore(record.quoteSymbol),
      tx: Number(record.txnsTotal) || 0,
      fee: record.fee == null ? null : Number(record.fee),
    })),
  );
  for (const record of records) {
    record.isMain = choice && String(record.pairAddress || "").toLowerCase() === choice.id ? 1 : 0;
  }
  return records;
}

function displayPair(records) {
  const main = records.find((record) => record.isMain);
  if (main) return main;
  return records.reduce((best, record) => {
    if (!best || Number(record.liquidityUsd) > Number(best.liquidityUsd)) return record;
    return best;
  }, null);
}

async function attachV4Pairs(token, records, threshold) {
  let pools = [];
  try {
    pools = await fetchAlikePools(token);
  } catch (error) {
    console.error("v4 pools", token, error.message);
    return markMainPair(records);
  }
  const byId = new Map(records.map((record) => [String(record.pairAddress || "").toLowerCase(), record]));
  for (const pool of pools) {
    if (!pool.v4 || !pool.id) continue;
    const existing = byId.get(pool.id);
    if (existing) {
      if (pool.tx > 0) existing.txnsTotal = pool.tx;
      if (pool.fee != null) existing.fee = pool.fee;
      if (!existing.quoteSymbol && pool.quote) existing.quoteSymbol = pool.quote;
      continue;
    }
    byId.set(pool.id, {
      pairAddress: pool.id,
      dex: "uniswap",
      label: "v4",
      quoteSymbol: pool.quote || null,
      priceUsd: pool.price,
      liquidityUsd: pool.liquidity || 0,
      marketCap: null,
      volume24h: null,
      priceChange24h: null,
      txns24h: null,
      txnsTotal: pool.tx || null,
      pairCreatedAt: null,
      status: pool.tx > 0 && !(pool.liquidity > 0) ? "thin" : pairStatus(pool.liquidity, threshold),
      dextoolsUrl: dextoolsUrl(pool.id),
      dexscreenerUrl: null,
      fee: pool.fee,
      liquidity: pool.liquidity || 0,
    });
  }
  const merged = [...byId.values()];
  const v4 = merged.filter((record) => String(record.label || "").toLowerCase() === "v4");
  await mapLimit(v4, 3, async (record) => {
    try {
      const stats = await fetchPairSwaps(record.pairAddress);
      if (!stats) return;
      if (stats.tx != null) record.txnsTotal = stats.tx;
      if (stats.tx24h != null) record.txns24h = stats.tx24h;
      else if (stats.tx != null && stats.createdAt && Date.now() - stats.createdAt < 24 * 60 * 60 * 1000) record.txns24h = stats.tx;
    } catch (error) {
      console.error("v4 pair tx", record.pairAddress, error.message);
    }
  });
  return markMainPair(merged);
}

function bestPair(pairs, token) {
  const want = String(token || "").toLowerCase();
  const records = pairs.filter((pair) => {
    if (!isPoolId(pair.pairAddress)) return false;
    const base = String(pair.baseToken?.address || "").toLowerCase();
    return !want || base === want;
  });
  records.sort((a, b) => {
    const liquidity = Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0);
    if (liquidity) return liquidity;
    const score = (pair) => ((pair.labels || []).some((label) => /^v4/i.test(String(label))) ? 1 : 0);
    return score(b) - score(a);
  });
  return records[0] || null;
}

async function rememberLaunchMarket(token, pairs) {
  const existing = getToken(token);
  if (!existing) return;
  const threshold = Number(getSettings().rugLiquidityUsd) || 1500;
  const records = pairs.filter((pair) => pair.pairAddress).map((pair) => pairRecord(pair, threshold));
  if (!records.length) return;
  const enriched = await attachV4Pairs(token, records, threshold);
  replaceTokenPairs(token, enriched);
  const winner = displayPair(enriched);
  if (!winner) return;
  const previousPeak = Number(existing.peak_liquidity_usd) || 0;
  const liquidity = Number(winner.liquidityUsd ?? 0);
  const v4 = String(winner.label || "").toLowerCase() === "v4";
  updateTokenMarket(token, {
    pairAddress: winner.pairAddress || null,
    dex: winner.dex,
    priceUsd: winner.priceUsd,
    liquidityUsd: liquidity,
    marketCap: winner.marketCap,
    fdv: winner.fdv,
    volume24h: winner.volume24h,
    priceChange24h: winner.priceChange24h,
    txns24h: winner.txns24h,
    txnsTotal: v4 ? (winner.txnsTotal == null ? null : winner.txnsTotal) : largestCount(winner.txns24h, existing.txns_total),
    peakLiquidityUsd: Math.max(previousPeak, liquidity),
    pairCreatedAt: winner.pairCreatedAt || existing.pair_created_at,
    status: classify(liquidity, Math.max(previousPeak, liquidity), threshold),
    dextoolsUrl: winner.dextoolsUrl || dextoolsUrl(winner.pairAddress),
    dexscreenerUrl: `https://dexscreener.com/ethereum/${token}`,
  });
}

export async function lookupLaunchMarket(address) {
  const token = String(address || "").toLowerCase();
  const deadline = Date.now() + 20_000;
  let pairs = [];
  while (Date.now() < deadline) {
    try {
      pairs = await fetchTokenPairs(token, 6000, 1);
      if (bestPair(pairs, token)) break;
    } catch (error) {
      console.error("launch pair lookup", error.message);
    }
    if (Date.now() + 2500 >= deadline) break;
    await sleep(2500);
  }
  const best = bestPair(pairs, token);
  if (best) await rememberLaunchMarket(token, pairs.filter((pair) => String(pair.baseToken?.address || "").toLowerCase() === token));
  const saved = best?.pairAddress ? null : getToken(token);
  const pairAddress = best?.pairAddress || saved?.pair_address || "";
  const header = pairs.map((pair) => pair.info?.header).find((url) => typeof url === "string" && url.startsWith("https://")) || "";
  if (header) setTokenBanner(token, header);
  const socials = Array.isArray(best?.info?.socials) ? best.info.socials : [];
  const website = Array.isArray(best?.info?.websites) ? best.info.websites[0]?.url || "" : "";
  return {
    pairAddress,
    dextoolsUrl: dextoolsUrl(pairAddress),
    dexscreenerUrl: /^0x[a-f0-9]{40}$/.test(token) ? `https://dexscreener.com/ethereum/${token}` : "",
    imageUrl: header || "",
    logoUrl: typeof best?.info?.imageUrl === "string" ? best.info.imageUrl : "",
    pairCreatedAt: best?.pairCreatedAt ? Math.floor(Number(best.pairCreatedAt) / 1000) : null,
    priceUsd: best?.priceUsd != null ? Number(best.priceUsd) : null,
    liquidityUsd: best?.liquidity?.usd != null ? Number(best.liquidity.usd) : null,
    marketCap: best?.marketCap != null ? Number(best.marketCap) : null,
    volume24h: best?.volume?.h24 != null ? Number(best.volume.h24) : null,
    priceChange24h: best?.priceChange?.h24 != null ? Number(best.priceChange.h24) : null,
    website: /^https?:\/\//i.test(website) ? website : "",
    twitter: socialUrl(socials, "twitter"),
  };
}

function socialUrl(socials, type) {
  const match = socials.find((item) => String(item?.type || "").toLowerCase() === type);
  const url = String(match?.url || "");
  return /^https?:\/\//i.test(url) ? url : "";
}

async function fetchPairs(addresses) {
  const all = [];
  let retries = 0;
  for (let index = 0; index < addresses.length; index += 30) {
    const chunk = addresses.slice(index, index + 30);
    try {
      const response = await fetch(`https://api.dexscreener.com/tokens/v1/ethereum/${chunk.join(",")}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (response.status === 429 && retries < 2) {
        retries += 1;
        await sleep(800);
        index -= 30;
        continue;
      }
      retries = 0;
      if (!response.ok) throw new Error(`Dexscreener HTTP ${response.status}`);
      const payload = await response.json();
      const pairs = Array.isArray(payload) ? payload : payload.pairs || [];
      all.push(...pairs);
    } catch (error) {
      console.error("market refresh failed", error.message);
    }
    if (index + 30 < addresses.length) await sleep(250);
  }
  return all;
}

let marketChain = Promise.resolve();
let liveMarketStarted = false;

export function refreshMarkets(addresses, options = {}) {
  const run = marketChain.then(() => refreshMarketsNow(addresses, options));
  marketChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

export function startLiveMarkets() {
  if (liveMarketStarted) return;
  liveMarketStarted = true;
  const run = async (label, load, pause, options) => {
    while (getSettings().live === "1") {
      try {
        const addresses = load();
        if (addresses.length) await refreshMarkets(addresses, options);
      } catch (error) {
        console.error(label, error.message);
      }
      await sleep(pause);
    }
  };
  run(
    "live markets",
    () => listTokenAddresses("WHERE created_at >= ? ORDER BY created_at DESC LIMIT 30", [nowSec() - 6 * 3600]),
    20000,
    { transfers: false },
  ).then(() => {
    liveMarketStarted = false;
  });
  run(
    "market backlog",
    () => listTokenAddresses("ORDER BY COALESCE(market_at, 0) ASC LIMIT 8"),
    60000,
    { transfers: true },
  );
}

async function refreshMarketsNow(addresses, options = {}) {
  const settings = getSettings();
  const threshold = Number(settings.rugLiquidityUsd) || 1500;
  const list =
    addresses && addresses.length
      ? [...new Set(addresses.map((address) => address.toLowerCase()))]
      : listTokenAddresses("ORDER BY COALESCE(market_at, 0) ASC LIMIT 180");
  let updated = 0;
  for (let index = 0; index < list.length; index += 30) {
    const chunk = list.slice(index, index + 30);
    let pairs = [];
    try {
      pairs = await fetchPairs(chunk);
    } catch (error) {
      console.error("market refresh failed", error.message);
      continue;
    }
    const grouped = new Map();
    const banners = new Map();
    for (const pair of pairs) {
      const token = pair.baseToken?.address?.toLowerCase();
      if (!token || !chunk.includes(token)) continue;
      const header = pair.info?.header;
      if (typeof header === "string" && header.startsWith("https://")) banners.set(token, header);
      if (!pair.pairAddress) continue;
      const list = grouped.get(token) || [];
      list.push(pairRecord(pair, threshold));
      grouped.set(token, list);
    }
    for (const [token, header] of banners) setTokenBanner(token, header);
    for (const address of chunk) {
      const existing = getToken(address);
      if (!existing) continue;
      const records = await attachV4Pairs(address, grouped.get(address) || [], threshold);
      replaceTokenPairs(address, records);
      const winner = displayPair(records);
      const previousPeak = Number(existing.peak_liquidity_usd) || 0;
      const v4 = String(winner?.label || "").toLowerCase() === "v4";
      let indexedTotal = null;
      if (!v4 && options.transfers !== false) {
        try {
          indexedTotal = await fetchTransferCount(address);
        } catch (error) {
          console.error("transfer count skipped", address, error.message);
        }
      }
      const txnsTotal = v4
        ? winner?.txnsTotal == null ? null : winner.txnsTotal
        : largestCount(indexedTotal, winner?.txns24h, existing.txns_total);
      if (!winner) {
        const status = classify(null, previousPeak, threshold);
        updateTokenMarket(address, {
          pairAddress: existing.pair_address,
          dex: existing.dex,
          priceUsd: status === "rugged" ? existing.price_usd : null,
          liquidityUsd: status === "rugged" ? 0 : null,
          marketCap: existing.market_cap,
          fdv: existing.fdv,
          volume24h: null,
          priceChange24h: null,
          txns24h: null,
          txnsTotal,
          peakLiquidityUsd: previousPeak,
          pairCreatedAt: existing.pair_created_at,
          status,
          dextoolsUrl: dextoolsUrl(existing.pair_address),
          dexscreenerUrl: `https://dexscreener.com/ethereum/${address}`,
        });
        updated += 1;
        continue;
      }
      const liquidity = Number(winner.liquidityUsd ?? 0);
      const peak = Math.max(previousPeak, liquidity);
      updateTokenMarket(address, {
        pairAddress: winner.pairAddress || null,
        dex: winner.dex,
        priceUsd: winner.priceUsd,
        liquidityUsd: liquidity,
        marketCap: winner.marketCap,
        fdv: winner.fdv,
        volume24h: winner.volume24h,
        priceChange24h: winner.priceChange24h,
        txns24h: winner.txns24h,
        txnsTotal,
        peakLiquidityUsd: peak,
        pairCreatedAt: winner.pairCreatedAt || existing.pair_created_at,
        status: classify(liquidity, peak, threshold),
        dextoolsUrl: winner.dextoolsUrl || dextoolsUrl(winner.pairAddress),
        dexscreenerUrl: `https://dexscreener.com/ethereum/${address}`,
      });
      updated += 1;
    }
    if (index + 30 < list.length) await sleep(250);
  }
  return updated;
}
