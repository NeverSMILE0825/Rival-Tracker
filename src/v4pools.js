import https from "node:https";

const alikeCache = new Map();
const pairCache = new Map();

function getJson(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          accept: "application/json",
          "accept-encoding": "identity",
          connection: "close",
          referer: "https://www.dextools.io/app/ether/pair-explorer",
          ...extraHeaders,
        },
        timeout: 8000,
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

export function quoteScore(symbol) {
  const name = String(symbol || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (name === "eth" || name === "weth") return 50;
  if (name === "usdc" || name === "usdt" || name === "usdcc" || name === "usdce" || name === "dai") return 20;
  return 5;
}

export function isV4PoolId(address, exchange) {
  const id = String(address || "").toLowerCase();
  return String(exchange || "").toLowerCase() === "dexe08a90" || /^0x[a-f0-9]{64}$/.test(id);
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export async function fetchAlikePools(token) {
  const key = String(token || "").toLowerCase();
  const cached = alikeCache.get(key);
  if (cached && Date.now() - cached.at < 20_000) return cached.rows;
  const body = await getJson(`https://www.dextools.io/api/core/pool/listing/alike/ether/${key}`, {
    "X-API-Version": "1",
  });
  const rows = (body?.data?.result || [])
    .map((row) => {
      const main = String(row.mainToken?.address || "").toLowerCase();
      const quote = main === key ? row.sideToken?.symbol : row.mainToken?.symbol;
      const fee = finite(row.fee);
      return {
        id: String(row.address || "").toLowerCase(),
        fee,
        tx: finite(row.txCount) || 0,
        liquidity: finite(row.liquidity) || 0,
        quote: quote || "",
        price: finite(row.price),
        v4: isV4PoolId(row.address, row.exchange),
      };
    })
    .filter((row) => row.id);
  alikeCache.set(key, { at: Date.now(), rows });
  return rows;
}

export async function fetchPairSwaps(pair) {
  const id = String(pair || "").toLowerCase();
  if (!/^0x[a-f0-9]{40,64}$/.test(id)) return null;
  const cached = pairCache.get(id);
  if (cached && Date.now() - cached.at < 90_000) return cached.value;
  const body = await getJson(`https://www.dextools.io/shared/data/pair?chain=ether&address=${id}`);
  const row = body?.data?.[0];
  if (!row) return null;
  const createdAt = Date.parse(row.creationTime || row.firstSwapTimestamp || "");
  const value = {
    tx: finite(row.metrics?.txCount),
    tx24h: finite(row.periodStats?.["24h"]?.swaps?.total),
    createdAt: Number.isFinite(createdAt) ? createdAt : null,
  };
  pairCache.set(id, { at: Date.now(), value });
  return value;
}

export function pickMainV4(candidates) {
  const hasLowFee = candidates.some((item) => item.fee != null && item.fee < 10);
  const usable = hasLowFee ? candidates.filter((item) => item.fee == null || item.fee < 10) : candidates;
  const ranked = [...usable].sort((a, b) => {
    const tx = (Number(b.tx) || 0) - (Number(a.tx) || 0);
    if (tx) return tx;
    const quote = (Number(b.quote) || 0) - (Number(a.quote) || 0);
    if (quote) return quote;
    const liquidity = (Number(b.liquidity) || 0) - (Number(a.liquidity) || 0);
    if (liquidity) return liquidity;
    return String(a.id).localeCompare(String(b.id));
  });
  const winner = ranked[0];
  if (!winner) return null;
  const tied = ranked.filter(
    (item) =>
      (Number(item.tx) || 0) === (Number(winner.tx) || 0) &&
      (Number(item.quote) || 0) === (Number(winner.quote) || 0) &&
      (Number(item.liquidity) || 0) === (Number(winner.liquidity) || 0),
  );
  return { id: winner.id, tiedIds: tied.map((item) => item.id) };
}
