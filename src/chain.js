import { AsyncLocalStorage } from "node:async_hooks";
import { getSettings } from "./db.js";
import { decodeAbiString, isRetryableMessage, parseApiKeys, sleep } from "./util.js";

const RPCS = ["https://ethereum.publicnode.com", "https://ethereum-rpc.publicnode.com"];
const ROUTESCAN = "https://api.routescan.io/v2/network/mainnet/evm/1/etherscan/api";
const ETHERSCAN = "https://api.etherscan.io/v2/api";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_TOPIC = `0x${"0".repeat(64)}`;

const explorerLane = new AsyncLocalStorage();
const explorerLanes = {
  history: { chain: Promise.resolve(), next: 0 },
  live: { chain: Promise.resolve(), next: 0 },
};
let rpcCursor = 0;
let keyCursor = 0;

export function inLiveLane(fn) {
  return explorerLane.run("live", fn);
}

function etherscanKeys() {
  return parseApiKeys(getSettings().etherscanApiKey);
}

function explorerAttemptSlots() {
  const keys = etherscanKeys();
  const slots = [];
  if (keys.length) {
    const start = keyCursor % keys.length;
    keyCursor = (start + 1) % keys.length;
    const tries = Math.min(3, keys.length);
    for (let index = 0; index < tries; index += 1) {
      slots.push({
        name: "etherscan",
        url: ETHERSCAN,
        key: keys[(start + index) % keys.length],
        chainid: "1",
      });
    }
  }
  slots.push({ name: "routescan", url: ROUTESCAN });
  return slots;
}

function explorerGap() {
  const keys = etherscanKeys().length;
  if (keys <= 1) return 280;
  return Math.max(50, Math.floor(220 / Math.min(keys, 6)));
}

async function paceExplorer() {
  const gap = explorerGap();
  const lane = explorerLanes[explorerLane.getStore()] || explorerLanes.history;
  const run = lane.chain.then(async () => {
    const wait = Math.max(0, lane.next - Date.now());
    if (wait) await sleep(wait);
    lane.next = Date.now() + gap;
  });
  lane.chain = run.then(
    () => {},
    () => {},
  );
  await run;
}

async function fetchJson(url, options = {}, timeout = 25000) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
  const text = await response.text();
  if (response.status === 429 || response.status >= 500) {
    throw new Error(`HTTP ${response.status}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Bad JSON (${response.status})`);
  }
}

async function withRetry(fn, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryableMessage(error.message) || attempt === attempts) break;
      await sleep(400 * attempt * attempt);
    }
  }
  throw lastError;
}

function asTxArray(payload) {
  if (!payload) throw new Error("Empty explorer response");
  if (Array.isArray(payload.result)) return payload.result;
  const message = `${payload.message || ""} ${payload.result || ""}`;
  if (/no transactions found/i.test(message) || /no records found/i.test(message)) return [];
  if (payload.status === "0") {
    const error = new Error(typeof payload.result === "string" ? payload.result : payload.message || "Explorer error");
    if (isRetryableMessage(error.message)) throw error;
    throw error;
  }
  throw new Error(payload.message || "Explorer error");
}

async function explorerGet(params) {
  let lastError;
  for (const slot of explorerAttemptSlots()) {
    try {
      return await withRetry(
        async () => {
          await paceExplorer();
          const query = new URLSearchParams(params);
          if (slot.chainid) query.set("chainid", slot.chainid);
          if (slot.key) query.set("apikey", slot.key);
          const payload = await fetchJson(`${slot.url}?${query}`);
          return asTxArray(payload);
        },
        slot.name === "etherscan" ? 2 : 5,
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Explorer request failed");
}

export async function normalTxs(address, startBlock, page, offset = 100, endBlock = 99999999) {
  return explorerGet({
    module: "account",
    action: "txlist",
    address,
    startblock: String(startBlock),
    endblock: String(endBlock),
    page: String(page),
    offset: String(offset),
    sort: "asc",
  });
}

export async function internalTxs(address, startBlock, page, offset = 100, endBlock = 99999999) {
  return explorerGet({
    module: "account",
    action: "txlistinternal",
    address,
    startblock: String(startBlock),
    endblock: String(endBlock),
    page: String(page),
    offset: String(offset),
    sort: "asc",
  });
}

export async function contractCreations(addresses) {
  const unique = [...new Set(addresses.map((item) => String(item || "").toLowerCase()))].filter((item) =>
    /^0x[a-f0-9]{40}$/.test(item),
  );
  const rows = [];
  for (let index = 0; index < unique.length; index += 5) {
    const batch = unique.slice(index, index + 5);
    rows.push(...(await creationBatch(batch)));
  }
  return rows;
}

async function creationBatch(batch) {
  try {
    return await creationQuery(batch);
  } catch (error) {
    if (batch.length === 1) {
      if (/not found|no data|no records|invalid/i.test(error.message)) return [];
      throw error;
    }
    const rows = [];
    for (const address of batch) rows.push(...(await creationBatch([address])));
    return rows;
  }
}

function creationQuery(batch) {
  return explorerGet({
    module: "contract",
    action: "getcontractcreation",
    contractaddresses: batch.join(","),
  });
}

async function rpc(method, params, timeout = 25000) {
  let lastError;
  for (let i = 0; i < RPCS.length; i += 1) {
    const url = RPCS[(rpcCursor + i) % RPCS.length];
    try {
      const payload = await withRetry(() =>
        fetchJson(
          url,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          },
          timeout,
        ),
      );
      if (payload.error) throw new Error(payload.error.message || "RPC error");
      rpcCursor = (rpcCursor + i) % RPCS.length;
      return payload.result;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("RPC failed");
}

export async function headBlock() {
  const hex = await rpc("eth_blockNumber", [], 8000);
  return Number(BigInt(hex));
}

export async function getBlock(number) {
  const block = Number(number);
  if (!Number.isFinite(block) || block < 0) return null;
  return rpc("eth_getBlockByNumber", [`0x${block.toString(16)}`, true], 8000);
}

async function liveRpc(method, params) {
  let lastError;
  for (const url of RPCS) {
    try {
      const payload = await fetchJson(
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        },
        4000,
      );
      if (payload.error) throw new Error(payload.error.message || "RPC error");
      return payload.result;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("RPC failed");
}

export async function liveHeadBlock() {
  return Number(BigInt(await liveRpc("eth_blockNumber", [])));
}

export async function liveGetBlock(number) {
  const block = Number(number);
  if (!Number.isFinite(block) || block < 0) return null;
  return liveRpc("eth_getBlockByNumber", [`0x${block.toString(16)}`, true]);
}

async function nonceBatch(list) {
  const body = list.map((address, index) => ({
    jsonrpc: "2.0",
    id: index,
    method: "eth_getTransactionCount",
    params: [address, "latest"],
  }));
  let lastError;
  for (let index = 0; index < RPCS.length; index += 1) {
    const url = RPCS[(rpcCursor + index) % RPCS.length];
    try {
      const payload = await fetchJson(
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        6000,
      );
      const rows = Array.isArray(payload) ? payload : [payload];
      const counts = new Map();
      for (const item of rows) {
        if (!item || item.result == null || item.error) continue;
        const address = list[Number(item.id)];
        if (!address) continue;
        counts.set(address, Number(BigInt(item.result)));
      }
      if (!counts.size) throw new Error("Nonce batch was empty");
      rpcCursor = (RPCS.indexOf(url) + 1) % RPCS.length;
      return counts;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Nonce batch failed");
}

export async function transactionCounts(addresses) {
  const list = [...new Set(addresses.map((address) => String(address || "").toLowerCase()))].filter((address) =>
    /^0x[a-f0-9]{40}$/.test(address),
  );
  if (!list.length) return new Map();
  const chunks = [];
  for (let index = 0; index < list.length; index += 100) chunks.push(list.slice(index, index + 100));
  const counts = new Map();
  let lastError;
  for (let index = 0; index < chunks.length; index += 4) {
    const wave = chunks.slice(index, index + 4);
    const parts = await Promise.all(
      wave.map((chunk) =>
        nonceBatch(chunk).catch((error) => {
          lastError = error;
          return new Map();
        }),
      ),
    );
    for (const part of parts) {
      for (const [address, count] of part) counts.set(address, count);
    }
  }
  if (!counts.size) throw lastError || new Error("Nonce batch was empty");
  return counts;
}

export async function blockByTime(timestamp, closest = "before") {
  const now = Math.floor(Date.now() / 1000);
  if (timestamp >= now - 15) return headBlock();
  let lastError;
  for (const slot of explorerAttemptSlots()) {
    try {
      const query = new URLSearchParams({
        module: "block",
        action: "getblocknobytime",
        timestamp: String(timestamp),
        closest: closest === "after" ? "after" : "before",
      });
      if (slot.chainid) query.set("chainid", slot.chainid);
      if (slot.key) query.set("apikey", slot.key);
      const payload = await withRetry(async () => {
        await paceExplorer();
        return fetchJson(`${slot.url}?${query}`);
      }, slot.name === "etherscan" ? 2 : 5);
      const block = Number(payload.result);
      if (Number.isFinite(block) && block > 0) return block;
      throw new Error(payload.result || payload.message || "Block lookup failed");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Block lookup failed");
}

export async function blockBefore(days) {
  const timestamp = Math.floor(Date.now() / 1000) - days * 86400;
  return blockByTime(timestamp, "before");
}

export async function getBalance(address) {
  const hex = await rpc("eth_getBalance", [address, "latest"]);
  return BigInt(hex).toString();
}

async function ethCall(to, data) {
  try {
    const result = await rpc("eth_call", [{ to, data }, "latest"]);
    return result;
  } catch {
    return null;
  }
}

export async function readTokenMeta(address) {
  const [nameHex, symbolHex, decimalsHex] = await Promise.all([
    ethCall(address, "0x06fdde03"),
    ethCall(address, "0x95d89b41"),
    ethCall(address, "0x313ce567"),
  ]);
  const name = decodeAbiString(nameHex);
  const symbol = decodeAbiString(symbolHex);
  if (!name || !symbol) return null;
  if (!decimalsHex || decimalsHex === "0x") return null;
  let decimals;
  try {
    decimals = Number(BigInt(decimalsHex));
  } catch {
    return null;
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 24) return null;
  const lowered = `${name} ${symbol}`.toLowerCase();
  if (
    lowered.includes("uniswap") ||
    lowered.includes("lp token") ||
    lowered.includes("positions nft") ||
    symbol.toUpperCase().includes("UNI-V") ||
    ["WETH", "USDC", "USDT", "DAI"].includes(symbol.toUpperCase())
  ) {
    return null;
  }
  return { name: name.slice(0, 64), symbol: symbol.slice(0, 32), decimals };
}

export async function getReceipt(hash) {
  let lastError;
  for (let i = 0; i < RPCS.length; i += 1) {
    const url = RPCS[(rpcCursor + i) % RPCS.length];
    try {
      const payload = await withRetry(() =>
        fetchJson(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [hash] }),
        }),
      );
      if (payload.error) throw new Error(payload.error.message || "RPC error");
      if (payload.result) {
        rpcCursor = (rpcCursor + i + 1) % RPCS.length;
        return payload.result;
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError && isRetryableMessage(lastError.message)) throw lastError;
  return null;
}

export function mintedTokens(receipt) {
  if (!receipt?.logs) return [];
  const found = [];
  for (const log of receipt.logs) {
    if (!log.topics || log.topics[0] !== TRANSFER_TOPIC) continue;
    if ((log.topics[1] || "").toLowerCase() !== ZERO_TOPIC) continue;
    if (log.address) found.push(log.address.toLowerCase());
  }
  return [...new Set(found)];
}

export function isDeploymentTx(tx, receipt) {
  if (receipt?.contractAddress) return true;
  if (!tx.to) return true;
  const contract = (tx.contractAddress || "").toLowerCase();
  const to = (tx.to || "").toLowerCase();
  if (contract && to === contract) return true;
  const input = tx.input || "";
  return input.startsWith("0x60806040") || input.startsWith("0x60e06040");
}

export async function internalTransfers(txHash) {
  const payload = await withRetry(async () => {
    await sleep(220);
    return fetchJson(`https://eth.blockscout.com/api/v2/transactions/${txHash}/internal-transactions`, {
      headers: { accept: "application/json" },
    });
  });
  return payload.items || [];
}

export function plainEthTransfer(tx) {
  const input = (tx.input || "0x").toLowerCase();
  if (input !== "0x" && input !== "0x0") return false;
  const gas = Number(tx.gasUsed || 0);
  if (gas && gas > 60000) return false;
  return Boolean(tx.to);
}

export { TRANSFER_TOPIC };
