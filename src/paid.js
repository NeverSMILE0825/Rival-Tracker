import {
  getSettings,
  listTokenAddresses,
  listUnalertedPaid,
  markPaidAlerted,
  savePaid,
  saveSettings,
} from "./db.js";
import { notifyPaid } from "./telegram.js";
import { nowSec, sleep } from "./util.js";

const ORDER_GAP_MS = 1100;
const RACE_GAP_MS = 60_000;
const priority = [];
let cursor = 0;
let lastRace = 0;
let started = false;
let chain = Promise.resolve();

function enqueue(task) {
  const run = chain.then(task, task);
  chain = run.then(
    () => {},
    () => {},
  );
  return run;
}

export function watchPaid(address) {
  const token = String(address || "").toLowerCase();
  if (/^0x[a-f0-9]{40}$/.test(token)) priority.push(token);
}

export function startPaidWatch() {
  if (started) return;
  started = true;
  enqueue(() => loop());
}

function ensureBaseline() {
  const settings = getSettings();
  const saved = Number(settings.paidBaseline);
  if (saved) return saved;
  const now = nowSec();
  saveSettings({ paidBaseline: String(now) });
  return now;
}

function nextAddress() {
  if (priority.length) return priority.shift();
  const addresses = listTokenAddresses("ORDER BY COALESCE(created_at, 0) DESC");
  if (!addresses.length) return "";
  const address = addresses[cursor % addresses.length];
  cursor += 1;
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
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    console.error("paid orders", error.message);
    return;
  }
  if (response.status === 429) {
    await sleep(5000);
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

async function syncRace(baseline) {
  const known = new Set(listTokenAddresses());
  if (!known.size) return;
  let page = 0;
  let totalPages = 1;
  while (page < totalPages && page < 10) {
    let response;
    try {
      response = await fetch(
        `https://www.dextools.io/api/core/pool/listing/token-race?chains=ether&page=${page}&pageSize=100`,
        {
          headers: { accept: "application/json", "X-API-Version": "2" },
          signal: AbortSignal.timeout(20000),
        },
      );
    } catch (error) {
      console.error("paid nitro", error.message);
      return;
    }
    if (!response.ok) return;
    const payload = await response.json().catch(() => ({}));
    const data = payload.data || {};
    totalPages = Number(data.totalPages) || 1;
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
    if (!results.length) break;
    page += 1;
  }
}

async function flushAlerts() {
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

async function loop() {
  const baseline = ensureBaseline();
  while (true) {
    let paused = ORDER_GAP_MS;
    try {
      if (Date.now() - lastRace > RACE_GAP_MS) {
        await syncRace(baseline);
        lastRace = Date.now();
      }
      const address = nextAddress();
      if (address) {
        await syncOrders(address, baseline);
      } else {
        paused = 5000;
      }
      await flushAlerts();
    } catch (error) {
      console.error("paid watch", error.message);
    }
    await sleep(paused);
  }
}
