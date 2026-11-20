import https from "node:https";
import {
  getSettings,
  listPaidBannerTargets,
  listTokenAddresses,
  listUnalertedPaid,
  markPaidAlerted,
  savePaid,
  saveSettings,
  setTokenBanner,
} from "./db.js";
import { notifyPaid } from "./telegram.js";
import { nowSec, sleep } from "./util.js";

const ORDER_GAP_MS = 1100;
const FEED_GAP_MS = 8_000;
const SOCIAL_GAP_MS = 10 * 60_000;
const BANNER_GAP_MS = 60_000;
const BANNER_RETRY_MS = 30 * 60_000;
const RECENT_WINDOW_SEC = 24 * 3600;
const NOVEMBER_START = Math.floor(Date.parse("2026-11-01T00:00:00+09:00") / 1000);
const priority = [];
let recentCursor = 0;
let olderCursor = 0;
let recentTurns = 0;
let recentCache = { at: 0, rows: [] };
let olderCache = { at: 0, rows: [] };
let lastSocial = 0;
let lastBanner = 0;
let lastRace = 0;
const bannerMiss = new Map();
let started = false;

export function watchPaid(address) {
  const token = String(address || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(token)) return;
  if (!priority.includes(token)) priority.unshift(token);
}

export function startPaidWatch() {
  if (started) return;
  started = true;
  alertLoop();
  feedLoop();
  maintenanceLoop();
}

function ensureBaseline() {
  const settings = getSettings();
  const saved = Number(settings.paidBaseline);
  if (saved) return saved;
  const now = nowSec();
  saveSettings({ paidBaseline: String(now) });
  return now;
}

function cachedAddresses(cache, whereSql, params) {
  if (Date.now() - cache.at < 20_000 && cache.rows.length) return cache.rows;
  cache.rows = listTokenAddresses(whereSql, params);
  cache.at = Date.now();
  return cache.rows;
}

function nextAlertAddress() {
  if (priority.length) return priority.shift();
  const now = nowSec();
  const recent = cachedAddresses(
    recentCache,
    "WHERE created_at > ? ORDER BY created_at DESC",
    [now - RECENT_WINDOW_SEC],
  );
  if (recent.length && recentTurns < 4) {
    recentTurns += 1;
    const address = recent[recentCursor % recent.length];
    recentCursor += 1;
    return address;
  }
  recentTurns = 0;
  const older = cachedAddresses(
    olderCache,
    "WHERE created_at IS NULL OR created_at <= ? ORDER BY COALESCE(created_at, 0) DESC",
    [now - RECENT_WINDOW_SEC],
  );
  const rows = older.length ? older : recent;
  if (!rows.length) return "";
  const cursor = older.length ? olderCursor : recentCursor;
  const address = rows[cursor % rows.length];
  if (older.length) olderCursor += 1;
  else recentCursor += 1;
  return address;
}

function unixTime(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number > 1e12 ? Math.floor(number / 1000) : Math.floor(number);
}

function orderDetail(kind, status) {
  const labels = {
    tokenProfile: "Token info update",
    communityTakeover: "Community takeover",
    tokenAd: "Token ad",
    trendingBarAd: "Trending bar ad",
  };
  const label = labels[kind] || kind;
  if (status && status !== "approved") return `${label} · ${status}`;
  return label;
}

function nitroDetail(nitro) {
  const packs = (nitro.tickers || []).filter((ticker) => Number(ticker.count) > 0);
  if (!packs.length) return `${Number(nitro.total) || 0} Nitro`;
  return packs
    .map((ticker) => {
      const count = Number(ticker.count);
      const type = Number(ticker.type);
      if (count === 1) return `${type} Nitro`;
      return `${count}×${type} Nitro`;
    })
    .join(", ");
}

async function syncOrders(address, baseline) {
  let response;
  try {
    response = await fetch(`https://api.dexscreener.com/orders/v1/ethereum/${address}`, {
      signal: AbortSignal.timeout(8000),
    });
  } catch (error) {
    console.error("paid orders", error.message);
    setTimeout(() => watchPaid(address), 10_000);
    return;
  }
  if (response.status === 429) {
    setTimeout(() => watchPaid(address), 10_000);
    return;
  }
  if (!response.ok) return;
  const payload = await response.json().catch(() => ({}));
  const orders = Array.isArray(payload) ? payload : payload.orders || [];
  const boosts = Array.isArray(payload) ? [] : payload.boosts || [];
  for (const order of orders) {
    const status = String(order.status || "").toLowerCase();
    if (status === "cancelled" || status === "rejected") continue;
    const paidAt = unixTime(order.paymentTimestamp);
    if (!paidAt) continue;
    const kind = String(order.type || "order");
    savePaid({
      fingerprint: `dexscreener|${kind}|${paidAt}|${status}`,
      tokenAddress: address,
      source: "dexscreener",
      kind,
      amount: null,
      paidAt,
      detail: orderDetail(kind, status),
      baseline,
    });
  }
  for (const boost of boosts) {
    const paidAt = unixTime(boost.paymentTimestamp);
    const amount = Number(boost.amount) || 0;
    if (!paidAt || !amount) continue;
    const id = boost.id || `${paidAt}-${amount}`;
    savePaid({
      fingerprint: `dexscreener|boost|${id}|${paidAt}|${amount}`,
      tokenAddress: address,
      source: "dexscreener",
      kind: "boost",
      amount,
      paidAt,
      detail: `${amount} boost`,
      baseline,
    });
  }
}

function fetchDextools(url, version) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          accept: "application/json",
          "accept-encoding": "identity",
          "X-API-Version": version,
          connection: "close",
        },
        timeout: 12000,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            statusCode: response.statusCode,
            json: async () => JSON.parse(text),
          });
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("The operation was aborted due to timeout")));
    request.on("error", reject);
  });
}

async function syncRacePage(baseline, page) {
  const known = new Set(listTokenAddresses());
  if (!known.size) return null;
  let response;
  try {
    response = await fetchDextools(
      `https://www.dextools.io/api/core/pool/listing/token-race?chains=ether&page=${page}&pageSize=100&lite=false`,
      "2",
    );
  } catch (error) {
    console.error("paid nitro", error.message);
    return null;
  }
  if (!response.ok) return null;
  const payload = await response.json().catch(() => ({}));
  const data = payload.data || {};
  const results = Array.isArray(data.results) ? data.results : [];
  for (const row of results) {
    const address = String(row.mainToken?.address || "").toLowerCase();
    if (!known.has(address)) continue;
    const nitro = row.nitro || {};
    const total = Number(nitro.total) || 0;
    if (!total) continue;
    const paidAt = unixTime(Date.parse(nitro.lastNitro || ""));
    if (!paidAt) continue;
    savePaid({
      fingerprint: `dextools|nitro|${address}`,
      tokenAddress: address,
      source: "dextools",
      kind: "nitro",
      amount: total,
      paidAt,
      detail: nitroDetail(nitro),
      baseline,
    });
  }
  return { totalPages: Number(data.totalPages) || 1, count: results.length };
}

async function syncRace(baseline, maxPages = 4) {
  let page = 0;
  let totalPages = 1;
  while (page < totalPages && page < maxPages) {
    const result = await syncRacePage(baseline, page);
    if (!result || !result.count) break;
    totalPages = result.totalPages;
    page += 1;
  }
}

function bannerChoices(address) {
  const token = String(address || "").toLowerCase();
  return [
    `https://dd.dexscreener.com/ds-data/tokens/ethereum/${token}/header.png?size=xl`,
    `https://www.dextools.io/resources/tokens/banners/ether/${token}.jpg`,
    `https://dd.dexscreener.com/ds-data/tokens/ethereum/${token}.png?size=lg`,
  ];
}

async function imageExists(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      headers: { accept: "image/*", range: "bytes=0-32" },
      signal: controller.signal,
    });
    const type = response.headers.get("content-type") || "";
    const ok = (response.ok || response.status === 206) && type.startsWith("image/");
    controller.abort();
    return ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function hasDexscreenerBanner(url) {
  const banner = String(url || "");
  return banner.includes("cdn.dexscreener.com") || banner.includes("/header.png");
}

async function syncBanners() {
  const targets = listPaidBannerTargets();
  for (const target of targets) {
    const current = target.banner_url || "";
    if (hasDexscreenerBanner(current)) continue;
    const tried = bannerMiss.get(target.address) || 0;
    if (Date.now() - tried < BANNER_RETRY_MS) continue;
    const choices = current ? [bannerChoices(target.address)[0]] : bannerChoices(target.address);
    let saved = "";
    for (const url of choices) {
      const probe = url.includes("header.png?size=xl") ? url.replace("size=xl", "size=sm") : url;
      if (await imageExists(probe)) {
        saved = url;
        break;
      }
    }
    if (saved && saved !== current) {
      setTokenBanner(target.address, saved);
      bannerMiss.delete(target.address);
    } else if (!saved) {
      bannerMiss.set(target.address, Date.now());
    }
  }
}

const DEX_FEEDS = [
  "https://api.dexscreener.com/token-profiles/latest/v1",
  "https://api.dexscreener.com/community-takeovers/latest/v1",
  "https://api.dexscreener.com/ads/latest/v1",
  "https://api.dexscreener.com/token-boosts/latest/v1",
];

async function syncFastFeeds(baseline) {
  const known = new Set(listTokenAddresses());
  if (!known.size) return;
  const hits = new Set();
  const dexFeeds = Promise.all(
    DEX_FEEDS.map(async (url) => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) return;
        const payload = await response.json().catch(() => []);
        const rows = Array.isArray(payload) ? payload : [];
        for (const row of rows) {
          if (String(row.chainId || "") !== "ethereum") continue;
          const address = String(row.tokenAddress || "").toLowerCase();
          if (known.has(address)) hits.add(address);
        }
      } catch (error) {
        console.error("paid feed", error.message);
      }
    }),
  );
  const dextoolsFeeds = Promise.all([syncRacePage(baseline, 0), syncSocialPage(baseline, 0)]);
  await dexFeeds;
  for (const address of hits) await syncOrders(address, baseline);
  await flushAlerts();
  await dextoolsFeeds;
  await flushAlerts();
}

async function syncSocialPage(baseline, page) {
  const known = new Set(listTokenAddresses());
  if (!known.size) return false;
  let response;
  try {
    response = await fetchDextools(
      `https://www.dextools.io/api/core/token/listings/social-network-updates/list?limit=50&chain=ether&page=${page}`,
      "1",
    );
  } catch (error) {
    console.error("paid dextools info", error.message);
    return false;
  }
  if (!response.ok) return false;
  const payload = await response.json().catch(() => ({}));
  const rows = payload.data?.result || [];
  let oldest = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const address = String(row.id || "").toLowerCase();
    const paidAt = unixTime(Date.parse(row.updatedAt || ""));
    if (paidAt) oldest = Math.min(oldest, paidAt);
    if (!known.has(address) || !paidAt) continue;
    savePaid({
      fingerprint: `dextools|info|${address}|${paidAt}`,
      tokenAddress: address,
      source: "dextools",
      kind: "info",
      amount: null,
      paidAt,
      detail: "Token info update",
      baseline,
    });
  }
  return oldest >= NOVEMBER_START && rows.length > 0;
}

async function syncSocials(baseline) {
  for (let page = 0; page < 8; page += 1) {
    const more = await syncSocialPage(baseline, page);
    if (!more) break;
  }
}

let flushChain = Promise.resolve();

function flushAlerts() {
  const run = flushChain.then(() => deliverAlerts());
  flushChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

async function deliverAlerts() {
  const rows = listUnalertedPaid();
  for (const row of rows) {
    try {
      const sent = await notifyPaid(row);
      if (sent) markPaidAlerted(row.fingerprint);
    } catch (error) {
      console.error("paid alert", error.message);
    }
  }
}

async function feedLoop() {
  const baseline = ensureBaseline();
  console.log("Paid alerts are checking Dexscreener and Dextools every 8 seconds");
  while (true) {
    const started = Date.now();
    try {
      await syncFastFeeds(baseline);
    } catch (error) {
      console.error("paid feed", error.message);
    }
    await sleep(Math.max(1000, FEED_GAP_MS - (Date.now() - started)));
  }
}

async function alertLoop() {
  const baseline = ensureBaseline();
  while (true) {
    const started = Date.now();
    try {
      const address = nextAlertAddress();
      if (address) await syncOrders(address, baseline);
      await flushAlerts();
    } catch (error) {
      console.error("paid watch", error.message);
    }
    const spent = Date.now() - started;
    await sleep(Math.max(50, ORDER_GAP_MS - spent));
  }
}

async function maintenanceLoop() {
  const baseline = ensureBaseline();
  while (true) {
    try {
      if (Date.now() - lastRace > 45_000) {
        await syncRace(baseline, 4);
        lastRace = Date.now();
        await flushAlerts();
      }
      if (Date.now() - lastSocial > SOCIAL_GAP_MS) {
        await syncSocials(baseline);
        lastSocial = Date.now();
        await flushAlerts();
      }
      if (Date.now() - lastBanner > BANNER_GAP_MS) {
        await syncBanners();
        lastBanner = Date.now();
      }
    } catch (error) {
      console.error("paid maintenance", error.message);
    }
    await sleep(5000);
  }
}
