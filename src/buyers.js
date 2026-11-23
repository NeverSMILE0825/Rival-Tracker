import { getSettings, listBuyers, listTrackedTokens, saveBuyerTrades, saveSettings } from "./db.js";
import { sleep } from "./util.js";

const RPC = "https://ethereum-rpc.publicnode.com";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

let started = false;

async function rpc(method, params) {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Buyer log request failed (${response.status})`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || "Buyer log request failed");
  return payload.result;
}

function padTopic(address) {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

function topicAddress(topic) {
  const hex = String(topic || "");
  if (hex.length < 42) return "";
  return `0x${hex.slice(-40).toLowerCase()}`;
}

function hexBlock(number) {
  return `0x${Number(number).toString(16)}`;
}

async function transferLogs(buyers, fromBlock, toBlock, topicIndex) {
  const topics = [TRANSFER, null, null];
  topics[topicIndex] = buyers.map((buyer) => padTopic(buyer.address));
  const logs = await rpc("eth_getLogs", [{ fromBlock: hexBlock(fromBlock), toBlock: hexBlock(toBlock), topics }]);
  return Array.isArray(logs) ? logs : [];
}

function tokenAmount(rawHex, decimals) {
  const places = Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : 18;
  let raw;
  try {
    raw = BigInt(rawHex || "0x0");
  } catch {
    return null;
  }
  if (raw <= 0n) return null;
  const base = 10n ** BigInt(places);
  const whole = raw / base;
  const fraction = (raw % base).toString().padStart(places, "0").replace(/0+$/, "");
  const text = fraction ? `${whole.toString()}.${fraction}` : whole.toString();
  const amount = Number(text);
  return Number.isFinite(amount) ? amount : null;
}

async function blockTime(number, cache) {
  if (cache.has(number)) return cache.get(number);
  const block = await rpc("eth_getBlockByNumber", [hexBlock(number), false]);
  const timestamp = Number(BigInt(block?.timestamp || "0x0"));
  cache.set(number, timestamp);
  return timestamp;
}

function collect(logs, buyersByTopic, tokens, incoming) {
  const grouped = new Map();
  for (const log of logs) {
    const token = tokens.get(String(log.address || "").toLowerCase());
    if (!token) continue;
    const from = topicAddress(log.topics?.[1]);
    const to = topicAddress(log.topics?.[2]);
    if (from === "0x0000000000000000000000000000000000000000") continue;
    const topic = incoming ? log.topics?.[2] : log.topics?.[1];
    const buyer = buyersByTopic.get(String(topic || "").toLowerCase());
    if (!buyer) continue;
    if (from === buyer.address && to === buyer.address) continue;
    const amount = tokenAmount(log.data, token.decimals);
    if (!(amount > 0)) continue;
    const txHash = String(log.transactionHash || "").toLowerCase();
    const key = `${buyer.id}|${token.address}|${txHash}`;
    const row = grouped.get(key) || {
      buyerId: buyer.id,
      tokenAddress: token.address,
      txHash,
      blockNumber: Number(BigInt(log.blockNumber || "0x0")),
      bought: 0,
      sold: 0,
      marketCap: Number(token.market_cap) > 0 ? Number(token.market_cap) : null,
    };
    if (incoming) row.bought += amount;
    else row.sold += amount;
    grouped.set(key, row);
  }
  return grouped;
}

async function readRange(buyers, tokens, fromBlock, toBlock) {
  const buyersByTopic = new Map(buyers.map((buyer) => [padTopic(buyer.address), buyer]));
  const [received, sent] = await Promise.all([
    transferLogs(buyers, fromBlock, toBlock, 2),
    transferLogs(buyers, fromBlock, toBlock, 1),
  ]);
  const grouped = collect(received, buyersByTopic, tokens, true);
  for (const [key, row] of collect(sent, buyersByTopic, tokens, false)) {
    const current = grouped.get(key);
    if (!current) grouped.set(key, row);
    else current.sold += row.sold;
  }
  const times = new Map();
  const trades = [];
  for (const row of grouped.values()) {
    const net = row.bought - row.sold;
    if (!net) continue;
    const timestamp = await blockTime(row.blockNumber, times);
    if (!timestamp) continue;
    trades.push({
      buyerId: row.buyerId,
      tokenAddress: row.tokenAddress,
      txHash: row.txHash,
      blockNumber: row.blockNumber,
      timestamp,
      side: net > 0 ? "buy" : "sell",
      amount: Math.abs(net),
      marketCap: row.marketCap,
    });
  }
  return trades;
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
  const tokens = new Map(listTrackedTokens().map((token) => [String(token.address).toLowerCase(), token]));
  const trades = await readRange(buyers, tokens, fromBlock, toBlock);
  saveBuyerTrades(trades);
  saveSettings({ buyerSeenBlock: String(toBlock) });
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
