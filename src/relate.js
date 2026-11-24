import { contractCreations, normalTxs, readTokenMeta, transactionLaunch } from "./chain.js";
import {
  getSettings,
  getToken,
  listCompetitors,
  listRivalCreators,
  listTokensMissingLaunch,
  recordFunding,
  setTokenLaunch,
  tokenExists,
  upsertToken,
} from "./db.js";
import { watchNarrative } from "./narrative.js";
import { ethToWei, sleep } from "./util.js";

const unrelatedUntil = new Map();
const tokenMissUntil = new Map();
let creatorCache = { at: 0, creators: new Map(), rivals: new Map() };

function loadCreators() {
  if (Date.now() - creatorCache.at < 20000 && creatorCache.rivals.size) return creatorCache;
  const rivals = new Map();
  for (const rival of listCompetitors()) {
    if (rival.enabled) rivals.set(String(rival.address).toLowerCase(), rival);
  }
  const creators = new Map();
  for (const row of listRivalCreators()) {
    creators.set(String(row.address).toLowerCase(), row);
  }
  creatorCache = { at: Date.now(), creators, rivals };
  return creatorCache;
}

function remember(address, row) {
  creatorCache.creators.set(address, row);
  unrelatedUntil.delete(address);
}

export async function relateDeployer(address) {
  const key = String(address || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(key)) return null;
  const { creators, rivals } = loadCreators();
  const known = creators.get(key);
  if (known) {
    return { deployer: key, rival: known.label, competitorId: known.competitor_id };
  }
  const rival = rivals.get(key);
  if (rival) return { deployer: key, rival: rival.label, competitorId: rival.id };
  if ((unrelatedUntil.get(key) || 0) > Date.now()) return null;
  const found = await fundingFromChain(key, creators, rivals);
  if (found === undefined) return null;
  if (!found) {
    unrelatedUntil.set(key, Date.now() + 10 * 60 * 1000);
    return null;
  }
  remember(key, found);
  return { deployer: key, rival: found.label, competitorId: found.competitor_id };
}

async function fundingFromChain(address, creators, rivals) {
  const settings = getSettings();
  const minWei = ethToWei(settings.minFundingEth || "0.01");
  const maxWei = ethToWei(settings.maxFundingEth || "20");
  const dust = ethToWei(settings.dustEth || "0.005");
  let txs = [];
  try {
    txs = await normalTxs(address, 0, 1, 100);
  } catch (error) {
    console.error("fast relate", error.message);
    return undefined;
  }
  const incoming = [];
  for (const tx of txs) {
    if ((tx.to || "").toLowerCase() !== address || tx.isError === "1") continue;
    let value = 0n;
    try {
      value = BigInt(tx.value || "0");
    } catch {
      continue;
    }
    if (value < dust) continue;
    incoming.push({
      from: tx.from.toLowerCase(),
      value,
      time: Number(tx.timeStamp),
      hash: tx.hash,
      block: Number(tx.blockNumber),
    });
  }
  if (!incoming.length) return null;
  incoming.sort((a, b) => a.time - b.time);
  const allowed = (from) => rivals.has(from) || creators.has(from);
  if (!allowed(incoming[0].from)) return null;
  const payment = incoming.find((tx) => allowed(tx.from) && tx.value >= minWei && tx.value <= maxWei);
  if (!payment) return null;
  const rival = rivals.get(payment.from);
  const parent = creators.get(payment.from);
  const competitorId = rival ? rival.id : parent.competitor_id;
  const label = rival ? rival.label : parent.label;
  recordFunding({
    competitorId,
    deployer: address,
    funder: payment.from,
    txHash: payment.hash,
    blockNumber: payment.block,
    timestamp: payment.time,
    valueWei: payment.value.toString(),
    kind: rival ? "direct" : "forward",
  });
  return { address, label, competitor_id: competitorId };
}

export async function relateToken(address) {
  const token = String(address || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(token)) return null;
  if ((tokenMissUntil.get(token) || 0) > Date.now()) return null;
  const existing = getToken(token);
  if (existing?.deployer) {
    const known = await relateDeployer(existing.deployer);
    if (known) return known;
  }
  let creator = "";
  let createdTx = "";
  try {
    const rows = await contractCreations([token]);
    const row = rows[0] || {};
    creator = String(row.contractCreator || row.contract_creator || "").toLowerCase();
    createdTx = String(row.txHash || row.tx_hash || row.transactionHash || "");
  } catch (error) {
    console.error("fast creator", error.message);
    return null;
  }
  if (!creator || creator === token) {
    tokenMissUntil.set(token, Date.now() + 2 * 60 * 1000);
    return null;
  }
  const related = await relateDeployer(creator);
  if (!related) {
    tokenMissUntil.set(token, Date.now() + 10 * 60 * 1000);
    return null;
  }
  tokenMissUntil.delete(token);
  return { ...related, createdTx };
}

export async function ensureRivalToken(address, related, hints = {}) {
  const token = String(address || "").toLowerCase();
  if (tokenExists(token)) return true;
  let meta = null;
  try {
    meta = await readTokenMeta(token);
  } catch (error) {
    console.error("fast token", error.message);
  }
  const name = meta?.name || hints.name || "";
  const symbol = meta?.symbol || hints.symbol || "";
  if (!name || !symbol) return false;
  const createdTx = hints.createdTx || related.createdTx || "";
  const launch = await transactionLaunch(createdTx).catch(() => null);
  const createdAt = launch?.createdAt || Number(hints.createdAt) || 0;
  const createdBlock = launch?.createdBlock || Number(hints.createdBlock) || 0;
  if (!createdAt) return false;
  upsertToken({
    address: token,
    deployer: related.deployer,
    name,
    symbol,
    decimals: meta?.decimals ?? hints.decimals ?? 18,
    createdAt,
    createdTx: launch?.createdTx || createdTx,
    createdBlock,
  });
  watchNarrative({ name, symbol, createdAt });
  return true;
}

export async function repairTokenLaunches() {
  const rows = listTokensMissingLaunch();
  for (const row of rows) {
    try {
      let tx = String(row.created_tx || "");
      const created = await contractCreations([row.address]);
      const official = String(created[0]?.txHash || created[0]?.tx_hash || "");
      if (official) tx = official;
      const launch = await transactionLaunch(tx);
      if (launch) setTokenLaunch(row.address, launch);
    } catch (error) {
      console.error("launch time", row.address, error.message);
    }
    await sleep(200);
  }
}
