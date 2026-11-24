import { getSettings, listBuyers, listTrackedTokens, saveBuyerTrades, saveSettings } from "./db.js";
import { notifyBuyerTrades } from "./telegram.js";
import { formatSwapAmount, sleep } from "./util.js";

const RPCS = ["https://rpc.mevblocker.io", "https://rpc.flashbots.net", "https://eth.drpc.org"];
const TRACE_RPC = "https://eth.drpc.org";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const POOL = "0x000000000004444c5dc75cb358380d2e3de08a90";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const ETH_USD = "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419";
const QUOTES = new Set([
  WETH,
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "0xdac17f958d2ee523a2206206994597c13d831ec7",
  "0x6b175474e89094c44da98b954eedeac495271d0f",
]);

let started = false;

async function rpc(method, params) {
  let last = "Buyer log request failed";
  for (const url of RPCS) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        last = `Buyer log request failed (${response.status})`;
        continue;
      }
      const payload = await response.json();
      if (payload.error) {
        last = payload.error.message || last;
        continue;
      }
      return payload.result;
    } catch (error) {
      last = error.message || last;
    }
  }
  throw new Error(last);
}

function topicAddress(topic) {
  const hex = String(topic || "");
  if (hex.length < 42) return "";
  return `0x${hex.slice(-40).toLowerCase()}`;
}

function hexBlock(number) {
  return `0x${Number(number).toString(16)}`;
}

async function tokenLogs(addresses, fromBlock, toBlock) {
  if (!addresses.length) return [];
  const logs = await rpc("eth_getLogs", [{
    fromBlock: hexBlock(fromBlock),
    toBlock: hexBlock(toBlock),
    address: addresses,
    topics: [TRANSFER],
  }]);
  return Array.isArray(logs) ? logs : [];
}

async function traceTx(hash) {
  const response = await fetch(TRACE_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "debug_traceTransaction",
      params: [hash, { tracer: "callTracer", tracerConfig: { withLog: true } }],
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`Buyer trace failed (${response.status})`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || "Buyer trace failed");
  return payload.result;
}

let ethPrice = { at: 0, usd: 0 };

async function ethUsd() {
  if (ethPrice.usd > 0 && Date.now() - ethPrice.at < 60_000) return ethPrice.usd;
  const raw = await rpc("eth_call", [{ to: ETH_USD, data: "0x50d25bcd" }, "latest"]);
  const usd = Number(BigInt(raw || "0x0")) / 1e8;
  if (usd > 0) ethPrice = { at: Date.now(), usd };
  return usd > 0 ? usd : 0;
}

async function blockTime(number, cache) {
  if (cache.has(number)) return cache.get(number);
  const block = await rpc("eth_getBlockByNumber", [hexBlock(number), false]);
  const timestamp = Number(BigInt(block?.timestamp || "0x0"));
  cache.set(number, timestamp);
  return timestamp;
}

function ownTokenMoves(frame) {
  const moves = [];
  for (const log of frame.logs || []) {
    if (String(log.topics?.[0] || "").toLowerCase() !== TRANSFER) continue;
    const token = String(log.address || "").toLowerCase();
    if (QUOTES.has(token)) continue;
    const src = topicAddress(log.topics?.[1]);
    const dst = topicAddress(log.topics?.[2]);
    let raw = 0n;
    try {
      raw = BigInt(log.data || "0x0");
    } catch {
      raw = 0n;
    }
    if (raw > 0n) moves.push({ token, src, dst });
  }
  return moves;
}

function analyzeFrame(frame) {
  const from = String(frame.from || "").toLowerCase();
  const to = String(frame.to || "").toLowerCase();
  const value = frame.value ? BigInt(frame.value) : 0n;
  const node = {
    tokens: ownTokenMoves(frame).map((move) => move.token),
    addresses: new Set([from, to]),
    ethToPool: to === POOL ? value : 0n,
    ethFromPool: from === POOL ? value : 0n,
    children: [],
  };
  for (const move of ownTokenMoves(frame)) {
    node.addresses.add(move.src);
    node.addresses.add(move.dst);
  }
  for (const call of frame.calls || []) {
    const child = analyzeFrame(call);
    node.children.push(child);
    node.tokens.push(...child.tokens);
    node.ethToPool += child.ethToPool;
    node.ethFromPool += child.ethFromPool;
    for (const address of child.addresses) node.addresses.add(address);
  }
  return node;
}

function buyerZones(node, buyers, tracked) {
  const nested = node.children.flatMap((child) => buyerZones(child, buyers, tracked));
  const tokens = [...new Set(node.tokens.filter((token) => tracked.has(token)))];
  const present = buyers.filter((buyer) => node.addresses.has(buyer.address));
  if (nested.length) {
    const coveredTo = nested.reduce((sum, zone) => sum + zone.ethToPool, 0n);
    const coveredFrom = nested.reduce((sum, zone) => sum + zone.ethFromPool, 0n);
    const extraTo = node.ethToPool - coveredTo;
    const extraFrom = node.ethFromPool - coveredFrom;
    if ((extraTo > 0n || extraFrom > 0n) && tokens.length && present.length) {
      nested.push({ buyers: present, tokens, ethToPool: extraTo, ethFromPool: extraFrom });
    }
    return nested;
  }
  const hasPool = node.ethToPool > 0n || node.ethFromPool > 0n;
  if (!hasPool || !tokens.length || !present.length) return [];
  return [{ buyers: present, tokens, ethToPool: node.ethToPool, ethFromPool: node.ethFromPool }];
}

export function tradesFromTrace(trace, { hash, blockNumber, buyers, tokens, ethUsd }) {
  if (!trace) return [];
  const zones = buyerZones(analyzeFrame(trace), buyers, tokens);
  const grouped = new Map();
  for (const zone of zones) {
    for (const buyer of zone.buyers) {
      for (const tokenAddress of zone.tokens) {
        const key = `${buyer.id}|${tokenAddress}`;
        const row = grouped.get(key) || { buyer, tokenAddress, buy: 0n, sell: 0n };
        row.buy += zone.ethToPool;
        row.sell += zone.ethFromPool;
        grouped.set(key, row);
      }
    }
  }
  const trades = [];
  for (const row of grouped.values()) {
    const side = row.buy >= row.sell ? "buy" : "sell";
    const wei = side === "buy" ? row.buy : row.sell;
    if (wei <= 0n) continue;
    const token = tokens.get(row.tokenAddress);
    const amountUsd = ethUsd > 0 ? Math.round((Number(wei) / 1e18) * ethUsd * 100) / 100 : null;
    trades.push({
      buyerId: row.buyer.id,
      tokenAddress: token.address,
      txHash: hash,
      blockNumber,
      side,
      amount: Number(wei) / 1e18,
      amountUsd,
      amountWei: wei.toString(),
      amountLabel: formatSwapAmount(wei, amountUsd),
      marketCap: Number(token.market_cap) > 0 ? Number(token.market_cap) : null,
      buyerLabel: row.buyer.label || "",
      buyerAddress: row.buyer.address,
      tokenSymbol: token.symbol || "",
      tokenName: token.name || "",
    });
  }
  return trades;
}

async function readRange(buyers, tokenRows, fromBlock, toBlock) {
  const tokens = new Map(tokenRows.map((token) => [String(token.address).toLowerCase(), token]));
  const tracked = [...tokens.keys()].filter((address) => !QUOTES.has(address));
  const logs = [];
  for (let index = 0; index < tracked.length; index += 90) {
    const chunk = [];
    for (let cursor = index; cursor < Math.min(tracked.length, index + 90); cursor += 30) {
      chunk.push(tokenLogs(tracked.slice(cursor, cursor + 30), fromBlock, toBlock));
    }
    for (const page of await Promise.all(chunk)) logs.push(...page);
  }
  const byHash = new Map();
  for (const log of logs) {
    const hash = String(log.transactionHash || "").toLowerCase();
    if (!hash) continue;
    const current = byHash.get(hash) || { hash, blockNumber: Number(BigInt(log.blockNumber || "0x0")) };
    byHash.set(hash, current);
  }
  const price = byHash.size ? await ethUsd() : 0;
  const known = buyers.map((buyer) => ({ ...buyer, address: String(buyer.address).toLowerCase() }));
  const trades = [];
  for (const item of byHash.values()) {
    let trace;
    try {
      trace = await traceTx(item.hash);
    } catch (error) {
      if (/429|timeout|rate|busy|limit/i.test(error.message)) throw error;
      console.error("buyer trace", error.message);
      continue;
    }
    trades.push(...tradesFromTrace(trace, {
      hash: item.hash,
      blockNumber: item.blockNumber,
      buyers: known,
      tokens,
      ethUsd: price,
    }));
  }
  const times = new Map();
  for (const trade of trades) {
    trade.timestamp = await blockTime(trade.blockNumber, times);
  }
  return trades.filter((trade) => trade.timestamp);
}

async function tick() {
  const buyers = listBuyers();
  if (!buyers.length) return;
  const head = Number(BigInt(await rpc("eth_blockNumber", [])));
  if (!head) return;
  const saved = Number(getSettings().buyerSeenBlock) || 0;
  if (!saved || saved > head) {
    saveSettings({ buyerSeenBlock: String(Math.max(0, head - 1)) });
    return;
  }
  if (saved >= head) return;
  const fromBlock = saved + 1;
  const toBlock = Math.min(head, fromBlock + 5);
  const trades = await readRange(buyers, listTrackedTokens(), fromBlock, toBlock);
  const fresh = saveBuyerTrades(trades);
  saveSettings({ buyerSeenBlock: String(toBlock) });
  if (fresh.length) notifyBuyerTrades(fresh);
}

export function startBuyerWatch() {
  if (started) return;
  started = true;
  const loop = async () => {
    console.log("Buyer trades are watched on their own, apart from launch detection");
    while (true) {
      const before = Number(getSettings().buyerSeenBlock) || 0;
      try {
        await tick();
      } catch (error) {
        console.error("buyer watch", error.message);
        await sleep(5000);
        continue;
      }
      const after = Number(getSettings().buyerSeenBlock) || 0;
      await sleep(after > before ? 400 : 2000);
    }
  };
  loop();
}
