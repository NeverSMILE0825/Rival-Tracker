import { getSettings, getToken, listTokenAddresses, replaceTokenPairs, setTokenBanner, updateTokenMarket } from "./db.js";
import { sleep } from "./util.js";

function classify(liquidity, peak, threshold) {
  if (liquidity == null) {
    if (peak >= threshold) return "rugged";
    return "unlisted";
  }
  if (liquidity >= threshold) return "live";
  if (peak >= threshold && liquidity < threshold * 0.25) return "rugged";
  return "thin";
}

function dextoolsUrl(pairAddress, tokenAddress) {
  if (pairAddress) return `https://www.dextools.io/app/ether/pair-explorer/${pairAddress}`;
  return `https://www.dextools.io/app/ether/token/${tokenAddress}`;
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
    dextoolsUrl: dextoolsUrl(pair.pairAddress, pair.baseToken?.address),
    dexscreenerUrl: pair.url || null,
    quoteSymbol: pair.quoteToken?.symbol || null,
    liquidity,
  };
}

async function fetchTokenPairs(address) {
  const url = `https://api.dexscreener.com/token-pairs/v1/ethereum/${address}`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
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
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(`https://eth.blockscout.com/api/v2/tokens/${address}/counters`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (response.status === 404) return null;
    if (response.status === 429 || response.status >= 500) {
      await sleep(700 * attempt);
      continue;
    }
    if (!response.ok) throw new Error(`Blockscout HTTP ${response.status}`);
    const payload = await response.json();
    const count = Number(payload.transfers_count);
    return Number.isFinite(count) ? count : null;
  }
  return null;
}

function bestPair(pairs) {
  const records = pairs.filter((pair) => pair.pairAddress);
  records.sort((a, b) => {
    const liquidity = Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0);
    if (liquidity) return liquidity;
    const score = (pair) => ((pair.labels || []).some((label) => /^v4/i.test(String(label))) ? 1 : 0);
    return score(b) - score(a);
  });
  return records[0] || null;
}

export async function lookupLaunchMarket(address) {
  const token = String(address || "").toLowerCase();
  let pairs = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      pairs = await fetchTokenPairs(token);
      if (pairs.length) break;
    } catch (error) {
      console.error("launch pair lookup", error.message);
    }
    if (attempt === 1 && !pairs.length) await sleep(1000);
  }
  const best = bestPair(pairs);
  const saved = best?.pairAddress ? null : getToken(token);
  const pairAddress = best?.pairAddress || saved?.pair_address || "";
  const header = pairs.map((pair) => pair.info?.header).find((url) => typeof url === "string" && url.startsWith("https://")) || "";
  if (header) setTokenBanner(token, header);
  const imageUrl = header;
  return {
    pairAddress,
    dextoolsUrl: pairAddress
      ? `https://www.dextools.io/app/ether/pair-explorer/${pairAddress}`
      : `https://www.dextools.io/app/ether/token/${token}`,
    dexscreenerUrl: `https://dexscreener.com/ethereum/${token}`,
    imageUrl: imageUrl || "",
  };
}

async function fetchPairs(addresses) {
  const all = [];
  for (const address of addresses) {
    all.push(...(await fetchTokenPairs(address)));
  }
  return all;
}

let marketChain = Promise.resolve();
let liveMarketStarted = false;

export function refreshMarkets(addresses) {
  const run = marketChain.then(() => refreshMarketsNow(addresses));
  marketChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

export function startLiveMarkets() {
  if (liveMarketStarted) return;
  liveMarketStarted = true;
  const loop = async () => {
    while (getSettings().live === "1") {
      try {
        await refreshMarkets(listTokenAddresses());
      } catch (error) {
        console.error("live markets", error.message);
      }
      await sleep(5000);
    }
    liveMarketStarted = false;
  };
  loop();
}

async function refreshMarketsNow(addresses) {
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
      const records = grouped.get(address) || [];
      replaceTokenPairs(address, records);
      const winner = records.reduce((best, record) => {
        if (!best || record.liquidity > best.liquidity) return record;
        return best;
      }, null);
      const previousPeak = Number(existing.peak_liquidity_usd) || 0;
      let txnsTotal = null;
      try {
        txnsTotal = await fetchTransferCount(address);
      } catch (error) {
        console.error("transfer count skipped", address, error.message);
      }
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
          dextoolsUrl: dextoolsUrl(existing.pair_address, address),
          dexscreenerUrl: existing.dexscreener_url || `https://dexscreener.com/ethereum/${address}`,
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
        dextoolsUrl: winner.dextoolsUrl || dextoolsUrl(winner.pairAddress, address),
        dexscreenerUrl: winner.dexscreenerUrl || `https://dexscreener.com/ethereum/${address}`,
      });
      updated += 1;
    }
    if (index + 30 < list.length) await sleep(250);
  }
  return updated;
}
