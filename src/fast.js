import https from "node:https";
import { codeAt, inDetectLane, liveGetBlock, liveHeadBlock, liveReceipts, mintedTokens, readTokenMeta, transactionLaunch } from "./chain.js";
import { addEvent, getSettings, getToken, hasEvent, listCompetitors, listLaunchWatchers, recordFunding, saveSettings, setTokenLaunch, tokenExists, upsertToken } from "./db.js";
import { lookupLaunch } from "./launch.js";
import { relateToken } from "./relate.js";
import { watchNarrative } from "./narrative.js";
import { notifyLaunch } from "./telegram.js";
import { ethToWei, nowSec, sleep } from "./util.js";
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
const launchWatchers = new Map();
const freshFunded = new Map();
const seenLaunchTx = new Set();
let launchCursor = 0;
let launchWatchersAt = 0;
let launchTipLog = 0;
let launchTipStarted = false;

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
  const eventAt = Number(stored?.created_at) || launchedAt;
  if (eventAt && detectedAt - eventAt > 15 * 60) {
    console.error("fast launch already old", token.symbol, address, `${detectedAt - eventAt}s`);
    return "skip";
  }
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

function refreshLaunchWatchers() {
  if (launchWatchers.size > 1 && Date.now() - launchWatchersAt < 20000) return;
  const next = new Map();
  for (const rival of listCompetitors()) {
    if (Number(rival.enabled) === 0) continue;
    const address = String(rival.address || "").toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(address)) continue;
    next.set(address, { rival: rival.label, competitorId: rival.id, deployer: address, kind: "rival" });
  }
  for (const row of listLaunchWatchers()) {
    const address = String(row.address || "").toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(address) || next.has(address)) continue;
    next.set(address, { rival: row.label, competitorId: row.competitor_id, deployer: address, kind: "deployer" });
  }
  for (const [address, row] of freshFunded) {
    if (!next.has(address)) next.set(address, row);
  }
  launchWatchers.clear();
  for (const [address, row] of next) launchWatchers.set(address, row);
  launchWatchersAt = Date.now();
}

function noteDirectFunding(tx, rival, blockNumber, timestamp) {
  const to = String(tx.to || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(to) || launchWatchers.get(to)?.kind === "rival") return;
  let value = 0n;
  try {
    value = BigInt(tx.value || "0x0");
  } catch {
    return;
  }
  const settings = getSettings();
  if (value < ethToWei(settings.minFundingEth || "0.01") || value > ethToWei(settings.maxFundingEth || "20")) return;
  const row = { rival: rival.rival, competitorId: rival.competitorId, deployer: to, kind: "deployer" };
  launchWatchers.set(to, row);
  freshFunded.set(to, row);
  if (freshFunded.size > 2000) {
    const oldest = freshFunded.keys().next().value;
    freshFunded.delete(oldest);
  }
  recordFunding({
    competitorId: rival.competitorId,
    deployer: to,
    funder: rival.deployer,
    txHash: String(tx.hash || "").toLowerCase(),
    blockNumber,
    timestamp,
    valueWei: value.toString(),
    kind: "direct",
  });
}

function publishChainLaunch({ address, meta, watcher, timestamp, blockNumber, hash }) {
  if (hasEvent("launch", address)) return;
  if (timestamp && nowSec() - timestamp > 15 * 60) return;
  if (!tokenExists(address)) {
    upsertToken({
      address,
      deployer: watcher.deployer,
      name: meta.name,
      symbol: meta.symbol,
      decimals: meta.decimals,
      createdAt: timestamp,
      createdTx: hash,
      createdBlock: blockNumber,
    });
    void watchNarrative({ name: meta.name, symbol: meta.symbol, createdAt: timestamp });
  } else {
    const stored = getToken(address);
    if (!stored?.created_block || Math.abs((Number(stored.created_at) || 0) - timestamp) > 30) {
      setTokenLaunch(address, { createdAt: timestamp, createdBlock: blockNumber, createdTx: hash, confirmed: false });
    }
  }
  if (hasEvent("launch", address)) return;
  addEvent({
    kind: "launch",
    competitorId: watcher.competitorId,
    address,
    message: `${meta.symbol} launched · ${watcher.rival}`,
  });
  watchPaid(address);
  void notifyLaunch({
    fast: true,
    symbol: meta.symbol,
    name: meta.name,
    address,
    deployer: watcher.deployer,
    rival: watcher.rival,
    launchedAt: timestamp,
    detectedAt: nowSec(),
  });
  void confirmLaunch(address);
  console.error("launch tip", meta.symbol, address, `block ${blockNumber}`);
}

function looksLikeDeploy(tx) {
  if (!tx.to) return true;
  const input = String(tx.input || "0x").toLowerCase();
  return input !== "0x" && input !== "0x0";
}

async function inspectLaunchBatch(jobs) {
  const pending = [];
  for (const job of jobs) {
    const hash = String(job.tx.hash || "").toLowerCase();
    if (!hash || seenLaunchTx.has(hash) || !looksLikeDeploy(job.tx)) continue;
    seenLaunchTx.add(hash);
    pending.push({ ...job, hash });
  }
  if (seenLaunchTx.size > 8000) {
    for (const item of seenLaunchTx) {
      seenLaunchTx.delete(item);
      if (seenLaunchTx.size <= 4000) break;
    }
  }
  for (let index = 0; index < pending.length; index += 25) {
    const slice = pending.slice(index, index + 25);
    let receipts = new Map();
    try {
      receipts = await liveReceipts(slice.map((job) => job.hash));
    } catch (error) {
      await sleep(400);
      try {
        receipts = await liveReceipts(slice.map((job) => job.hash));
      } catch (retryError) {
        console.error("launch receipts", retryError.message || error.message);
        continue;
      }
    }
    for (const job of slice) {
      const receipt = receipts.get(job.hash);
      if (!receipt || (receipt.status && BigInt(receipt.status) === 0n)) continue;
      const candidates = new Set(mintedTokens(receipt));
      if (receipt.contractAddress) candidates.add(String(receipt.contractAddress).toLowerCase());
      for (const address of candidates) {
        if (!/^0x[a-f0-9]{40}$/.test(address) || QUOTES.has(address) || hasEvent("launch", address)) continue;
        let prior = "0x";
        try {
          prior = await codeAt(address, job.blockNumber - 1);
        } catch (error) {
          console.error("launch code", error.message);
          continue;
        }
        if (prior && prior !== "0x") continue;
        const meta = await readTokenMeta(address);
        if (!meta) continue;
        publishChainLaunch({ address, meta, watcher: job.watcher, timestamp: job.timestamp, blockNumber: job.blockNumber, hash: job.hash });
      }
    }
  }
}

async function pollLaunchBlocks() {
  refreshLaunchWatchers();
  const head = await liveHeadBlock();
  if (!head) return;
  if (!launchCursor) {
    const saved = Number(getSettings().launchSeenBlock) || 0;
    launchCursor = saved > 0 && saved < head && head - saved <= 30 ? saved : Math.max(0, head - 1);
  }
  if (head - launchCursor > 30) launchCursor = head - 2;
  const end = Math.min(head, launchCursor + 3);
  for (let blockNumber = launchCursor + 1; blockNumber <= end; blockNumber += 1) {
    const block = await liveGetBlock(blockNumber);
    if (!block?.transactions) return;
    const timestamp = Number(BigInt(block.timestamp || "0x0"));
    for (const tx of block.transactions) {
      const from = String(tx.from || "").toLowerCase();
      const watcher = launchWatchers.get(from);
      if (watcher?.kind === "rival") noteDirectFunding(tx, watcher, blockNumber, timestamp);
    }
    const jobs = [];
    for (const tx of block.transactions) {
      const from = String(tx.from || "").toLowerCase();
      const watcher = launchWatchers.get(from);
      if (watcher) jobs.push({ tx, watcher, blockNumber, timestamp });
    }
    if (jobs.length) void inspectLaunchBatch(jobs).catch((error) => console.error("launch tip", error.message));
    launchCursor = blockNumber;
    saveSettings({ launchSeenBlock: String(blockNumber) });
  }
  if (Date.now() - launchTipLog > 20000) {
    launchTipLog = Date.now();
    console.error(`launch tip at block ${launchCursor.toLocaleString()} watching ${launchWatchers.size.toLocaleString()} wallets`);
  }
}

function startLaunchTip() {
  if (launchTipStarted) return;
  launchTipStarted = true;
  console.log("Launch detection reads each new block directly, ahead of Dextools");
  const loop = async () => {
    while (true) {
      if (getSettings().fastMode !== "1") {
        await sleep(1000);
        continue;
      }
      try {
        await pollLaunchBlocks();
      } catch (error) {
        console.error("launch tip", error.message);
      }
      await sleep(1200);
    }
  };
  loop();
}

export function startFastWatch() {
  if (started) return;
  started = true;
  startLaunchTip();
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
