import {
  getToken,
  listCreationSwaps,
  listProfitPairs,
  missingSwapTargets,
  nextProfitToken,
  nextUnmeasuredSwap,
  noteSwapAttempt,
  profitTotals,
  rememberSwapTxs,
  saveSwapMeasure,
  saveSwapTarget,
  saveTokenProfit,
  setProfitBlock,
  swapTargetCounts,
} from "./db.js";
import { nowSec, sleep } from "./util.js";

const READ_RPCS = ["https://rpc.mevblocker.io", "https://rpc.flashbots.net", "https://eth.drpc.org"];
const TRACE_RPC = "https://eth.drpc.org";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const V2_SWAP = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const V2_MINT = "0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f";
const V2_BURN = "0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496";
const V3_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const V3_MINT = "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde";
const V3_BURN = "0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c";
const SWAP_TOPICS = new Set([V2_SWAP, V3_SWAP]);
const LIQUIDITY_TOPICS = new Set([V2_MINT, V2_BURN, V3_MINT, V3_BURN]);
const V4_POOL = "0x000000000004444c5dc75cb358380d2e3de08a90";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const ZERO = "0x0000000000000000000000000000000000000000";

let started = false;

function lower(value) {
  return String(value || "").toLowerCase();
}

function hexBlock(number) {
  return `0x${Number(number).toString(16)}`;
}

function asWei(value) {
  try {
    return BigInt(value || "0x0");
  } catch {
    return 0n;
  }
}

function topicAddress(topic) {
  const hex = String(topic || "");
  if (hex.length < 42) return "";
  return `0x${hex.slice(-40).toLowerCase()}`;
}

async function rpc(url, method, params, timeout = 12000) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`Profit request failed (${response.status})`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || "Profit request failed");
  return payload.result;
}

async function readRpc(method, params, timeout) {
  let last = "Profit request failed";
  for (const url of READ_RPCS) {
    try {
      return await rpc(url, method, params, timeout);
    } catch (error) {
      last = error.message || last;
    }
  }
  throw new Error(last);
}

function limited(error) {
  return /429|timeout|rate|busy|limit|too many/i.test(error.message || "");
}

export function teamAddresses(counts) {
  const rows = counts.filter((row) => row.dest && Number(row.n) > 0);
  if (!rows.length) return [];
  const max = Math.max(...rows.map((row) => Number(row.n)));
  if (max <= 1) return [];
  return rows.filter((row) => Number(row.n) === max).map((row) => lower(row.dest));
}

function collect(frame, token, bag) {
  const from = lower(frame.from);
  const to = lower(frame.to);
  const value = asWei(frame.value);
  if (value > 0n && from && to) bag.eth.push({ from, to, value });
  for (const log of frame.logs || []) {
    const topic = lower(log.topics?.[0]);
    const address = lower(log.address);
    if (LIQUIDITY_TOPICS.has(topic)) bag.liquidity.add(address);
    if (SWAP_TOPICS.has(topic)) bag.swaps.add(address);
    if (topic !== TRANSFER) continue;
    const src = topicAddress(log.topics?.[1]);
    const dst = topicAddress(log.topics?.[2]);
    const raw = asWei(log.data);
    if (raw <= 0n) continue;
    if (address === token) bag.token.push({ src, dst, raw });
    if (address === WETH) bag.weth.push({ from: src, to: dst, value: raw });
  }
  for (const call of frame.calls || []) collect(call, token, bag);
}

function mintedOnly(moves, taker) {
  let received = 0n;
  let bought = 0n;
  for (const move of moves) {
    if (move.dst !== taker) continue;
    received += move.raw;
    if (move.src && move.src !== ZERO) bought += move.raw;
  }
  return received > 0n && bought === 0n;
}

function tokenNet(moves) {
  const net = new Map();
  const add = (address, delta) => {
    if (!address || address === ZERO) return;
    net.set(address, (net.get(address) || 0n) + delta);
  };
  for (const move of moves) {
    add(move.src, -move.raw);
    add(move.dst, move.raw);
  }
  return net;
}

function gross(moves, address, direction) {
  let total = 0n;
  for (const move of moves) {
    if (direction === "in" && move.to === address) total += move.value;
    if (direction === "out" && move.from === address) total += move.value;
  }
  return total;
}

function measure(moves, nets, pools) {
  let buy = 0n;
  let sell = 0n;
  const used = [];
  for (const pool of pools) {
    const net = nets.get(pool) || 0n;
    const incoming = gross(moves, pool, "in");
    const outgoing = gross(moves, pool, "out");
    if (net < 0n && incoming > 0n) {
      buy += incoming;
      used.push(pool);
    } else if (net > 0n && outgoing > 0n) {
      sell += outgoing;
      used.push(pool);
    }
  }
  return { buy, sell, used };
}

function takerMeasure(moves, nets, taker) {
  const net = nets.get(taker) || 0n;
  if (net > 0n) return { buy: gross(moves, taker, "out"), sell: 0n };
  if (net < 0n) return { buy: 0n, sell: gross(moves, taker, "in") };
  return { buy: 0n, sell: 0n };
}

function pickSide(buy, sell) {
  if (buy <= 0n && sell <= 0n) return null;
  if (buy >= sell) return { side: "buy", wei: buy };
  return { side: "sell", wei: sell };
}

export function swapFromTrace(trace, tokenAddress, pairAddresses = []) {
  if (!trace) return { side: "", wei: 0n };
  const token = lower(tokenAddress);
  const bag = { eth: [], token: [], weth: [], liquidity: new Set(), swaps: new Set() };
  collect(trace, token, bag);
  if (!bag.token.length) return { side: "", wei: 0n };
  const created = lower(trace.to);
  if ((trace.type === "CREATE" || trace.type === "CREATE2") && created) {
    bag.eth = bag.eth.filter((move) => move.to !== created);
  }
  const liquidityOnly = new Set([...bag.liquidity].filter((pool) => !bag.swaps.has(pool)));
  if (liquidityOnly.size) {
    const tradeMove = (move) => !liquidityOnly.has(move.to) && !liquidityOnly.has(move.from);
    bag.eth = bag.eth.filter(tradeMove);
    bag.weth = bag.weth.filter(tradeMove);
  }
  const nets = tokenNet(bag.token);
  const pools = new Set([V4_POOL, ...pairAddresses.map(lower)].filter((address) => /^0x[a-f0-9]{40}$/.test(address)));
  pools.delete(token);
  pools.delete(WETH);
  for (const pool of liquidityOnly) pools.delete(pool);
  const native = measure(bag.eth, nets, pools);
  const wrapped = measure(bag.weth, nets, pools);
  let nativeSide = pickSide(native.buy, native.sell);
  let wrappedSide = pickSide(wrapped.buy, wrapped.sell);
  const adding = liquidityOnly.size > 0 && bag.swaps.size === 0;
  const creating = trace.type === "CREATE" || trace.type === "CREATE2";
  if (!nativeSide && !wrappedSide && !adding && !(creating && mintedOnly(bag.token, lower(trace.from)))) {
    const taker = lower(trace.from);
    const nativeTaker = takerMeasure(bag.eth, nets, taker);
    const wrappedTaker = takerMeasure(bag.weth, nets, taker);
    nativeSide = pickSide(nativeTaker.buy, nativeTaker.sell);
    wrappedSide = pickSide(wrappedTaker.buy, wrappedTaker.sell);
  }
  const choice = [nativeSide, wrappedSide]
    .filter(Boolean)
    .sort((a, b) => (a.wei > b.wei ? -1 : a.wei < b.wei ? 1 : 0))[0];
  return choice || { side: "", wei: 0n };
}

async function headBlock() {
  return Number(BigInt(await readRpc("eth_blockNumber", [])));
}

async function tokenLogs(token, fromBlock, toBlock) {
  const logs = await readRpc("eth_getLogs", [{
    fromBlock: hexBlock(fromBlock),
    toBlock: hexBlock(toBlock),
    address: token,
    topics: [TRANSFER],
  }], 20000);
  return Array.isArray(logs) ? logs : [];
}

async function catchLogs(token) {
  const head = await headBlock();
  let created = Number(token.created_block) || 0;
  if (created > head) created = 0;
  let cursor = Number(token.profit_block) || 0;
  if (!cursor) {
    const stamp = Number(token.created_at) || 0;
    const headTime = Number(BigInt((await readRpc("eth_getBlockByNumber", ["latest", false]))?.timestamp || "0x0"));
    const estimated = stamp && headTime ? head - Math.ceil((headTime - stamp) / 12) - 2000 : head - 300000;
    cursor = Math.max(1, created > 1 ? created - 1 : estimated) - 1;
    if (cursor >= head) cursor = Math.max(0, head - 1);
  }
  if (cursor >= head) return { done: true, head };
  let span = Math.max(1, Math.min(20000, head - cursor));
  while (span >= 1) {
    const from = cursor + 1;
    const to = Math.min(head, from + span - 1);
    try {
      const logs = await tokenLogs(token.address, from, to);
      const rows = [];
      const seen = new Set();
      for (const log of logs) {
        const hash = lower(log.transactionHash);
        if (!hash || seen.has(hash)) continue;
        seen.add(hash);
        rows.push({ hash, block: Number(BigInt(log.blockNumber || "0x0")) });
      }
      if (rows.length) rememberSwapTxs(token.address, rows);
      setProfitBlock(token.address, to);
      token.profit_block = to;
      return { done: to >= head, head };
    } catch (error) {
      if (!limited(error) && span > 1) {
        span = Math.max(1, Math.floor(span / 4));
        continue;
      }
      throw error;
    }
  }
  throw new Error("Profit log range could not be read");
}

async function fillTargets(token) {
  const hashes = missingSwapTargets(token.address, 8);
  if (!hashes.length) return false;
  await Promise.all(hashes.map(async (hash) => {
    const tx = await readRpc("eth_getTransactionByHash", [hash]);
    saveSwapTarget(token.address, hash, lower(tx?.to));
  }));
  return true;
}

async function traceSwap(hash) {
  return rpc(TRACE_RPC, "debug_traceTransaction", [hash, { tracer: "callTracer", tracerConfig: { withLog: true } }], 15000);
}

async function measureOne(token) {
  const team = teamAddresses(swapTargetCounts(token.address));
  const row = nextUnmeasuredSwap(token.address, team);
  if (!row) return false;
  try {
    const trace = await traceSwap(row.tx_hash);
    const pairs = listProfitPairs(token.address);
    const result = swapFromTrace(trace, token.address, pairs);
    saveSwapMeasure(token.address, row.tx_hash, result.side, result.wei.toString());
  } catch (error) {
    if (limited(error)) throw error;
    noteSwapAttempt(token.address, row.tx_hash);
    if ((Number(row.attempts) || 0) + 1 >= 3) saveSwapMeasure(token.address, row.tx_hash, "", "0");
    console.error("profit trace", token.symbol || token.address, error.message);
  }
  return true;
}

function writeTotals(token, head, done) {
  const team = teamAddresses(swapTargetCounts(token.address));
  let buy = 0n;
  let sell = 0n;
  let buys = 0;
  let sells = 0;
  for (const row of profitTotals(token.address, team)) {
    const wei = asWei(row.amount_wei);
    if (row.side === "buy") {
      buy += wei;
      buys += 1;
    } else if (row.side === "sell") {
      sell += wei;
      sells += 1;
    }
  }
  saveTokenProfit(token.address, {
    wei: (buy - sell).toString(),
    buys,
    sells,
    block: head,
    checkedAt: done ? nowSec() : token.profit_checked_at || null,
  });
}

async function step() {
  const token = nextProfitToken(nowSec());
  if (!token) {
    await sleep(5000);
    return;
  }
  const logs = await catchLogs(token);
  if (!logs.done) {
    await sleep(150);
    return;
  }
  if (await fillTargets(token)) {
    await sleep(200);
    return;
  }
  if (await measureOne(token)) {
    writeTotals(token, Number(token.profit_block) || 0, false);
    await sleep(800);
    return;
  }
  const head = await headBlock();
  if (Number(token.profit_block) < head) {
    await sleep(100);
    return;
  }
  const team = teamAddresses(swapTargetCounts(token.address));
  if (nextUnmeasuredSwap(token.address, team)) return;
  writeTotals(token, head, true);
  await sleep(300);
}

async function repairCreationSwaps() {
  const rows = listCreationSwaps();
  const tokens = new Set();
  for (const row of rows) {
    try {
      const trace = await traceSwap(row.tx_hash);
      const result = swapFromTrace(trace, row.token_address, listProfitPairs(row.token_address));
      saveSwapMeasure(row.token_address, row.tx_hash, result.side, result.wei.toString());
      tokens.add(row.token_address);
    } catch (error) {
      if (limited(error)) throw error;
      console.error("profit repair", row.tx_hash, error.message);
    }
  }
  for (const address of tokens) {
    const token = getToken(address);
    if (token) writeTotals(token, Number(token.profit_block) || 0, Boolean(token.profit_checked_at));
  }
}

export function startProfitWatch() {
  if (started) return;
  started = true;
  const loop = async () => {
    console.log("Token profit is calculated apart from launch detection");
    try {
      await repairCreationSwaps();
    } catch (error) {
      console.error("profit repair", error.message);
    }
    while (true) {
      try {
        await step();
      } catch (error) {
        console.error("profit", error.message);
        await sleep(limited(error) ? 15000 : 5000);
      }
    }
  };
  loop();
}
