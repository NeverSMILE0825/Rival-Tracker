import { transactionLaunch } from "./chain.js";
import { tokenCreation } from "./gmgn.js";

const TOLERANCE = 180;

function unix(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number > 1e12 ? Math.floor(number / 1000) : Math.floor(number);
}

function plausible(createdAt) {
  return createdAt > 1_000_000_000 && createdAt < Math.floor(Date.now() / 1000) + 3600;
}

function close(left, right) {
  return left > 0 && right > 0 && Math.abs(left - right) <= TOLERANCE;
}

async function readJson(url, headers = {}) {
  let response = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    response = await fetch(url, {
      headers: { accept: "application/json", ...headers },
      signal: AbortSignal.timeout(8000),
    });
    if (response.status !== 429 || attempt === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (!response.ok) throw new Error(`Launch check returned ${response.status}`);
  return response.json();
}

export async function dextoolsTokenLaunch(address) {
  const body = await readJson(`https://www.dextools.io/shared/data/token?tokens=ether:${address}`, {
    referer: "https://www.dextools.io/app/ether/pair-explorer",
  });
  const row = body?.data?.[0] || {};
  const createdAt = unix(Math.floor(Date.parse(row.creationTime || "") / 1000));
  const createdBlock = Number(row.creationBlock) || 0;
  if (!plausible(createdAt)) return null;
  return { createdAt, createdBlock };
}

export async function dexscreenerPairLaunch(address) {
  const body = await readJson(`https://api.dexscreener.com/token-pairs/v1/ethereum/${address}`);
  const pairs = Array.isArray(body) ? body : body?.pairs || [];
  let createdAt = 0;
  for (const pair of pairs) {
    const at = unix(pair.pairCreatedAt);
    if (!plausible(at)) continue;
    if (!createdAt || at < createdAt) createdAt = at;
  }
  return createdAt ? { createdAt } : null;
}

export async function gmgnTokenLaunch(address) {
  const launch = await tokenCreation(address);
  if (!launch || !plausible(launch.createdAt)) return null;
  return launch;
}

function tokenStamp(source, pairAt) {
  const createdAt = plausible(source?.createdAt) ? source.createdAt : 0;
  if (!createdAt) return 0;
  if (pairAt && createdAt > pairAt + TOLERANCE) return 0;
  return createdAt;
}

export function chooseLaunch(chain, dextools, dexscreener, gmgn) {
  const screenAt = plausible(dexscreener?.createdAt) ? dexscreener.createdAt : 0;
  const dexAt = tokenStamp(dextools, screenAt);
  const gmgnAt = tokenStamp(gmgn, screenAt);
  const chainAt = plausible(chain?.createdAt) ? chain.createdAt : 0;

  let createdAt = 0;
  let createdBlock = dexAt ? Number(dextools?.createdBlock) || 0 : 0;
  let confirmed = false;

  if (dexAt) {
    createdAt = dexAt;
    confirmed = true;
    if (gmgnAt && gmgnAt < dexAt - TOLERANCE) {
      createdAt = gmgnAt;
      createdBlock = 0;
    }
  } else if (gmgnAt) {
    createdAt = gmgnAt;
    confirmed = true;
  } else if (screenAt) {
    createdAt = screenAt;
  }

  let createdTx = "";
  if (chainAt && createdAt && close(chainAt, createdAt)) {
    createdBlock = chain.createdBlock || createdBlock;
    createdTx = chain.createdTx || "";
  } else if (chainAt && (!createdAt || chainAt < createdAt - TOLERANCE)) {
    createdAt = chainAt;
    createdBlock = chain.createdBlock || 0;
    createdTx = chain.createdTx || "";
  }

  if (!createdAt) return null;
  return { createdAt, createdBlock, createdTx, confirmed };
}

export async function lookupLaunch(address, knownTx = "") {
  const token = String(address || "").toLowerCase();
  const [dextools, dexscreener, gmgn, chain] = await Promise.all([
    dextoolsTokenLaunch(token).catch(() => null),
    dexscreenerPairLaunch(token).catch(() => null),
    gmgnTokenLaunch(token).catch(() => null),
    /^0x[a-fA-F0-9]{64}$/.test(knownTx) ? transactionLaunch(knownTx).catch(() => null) : null,
  ]);
  return chooseLaunch(chain, dextools, dexscreener, gmgn);
}
