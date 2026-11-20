import {
  addEvent,
  countQueued,
  countTokensForDeployer,
  dueDeployers,
  getCompetitor,
  getSettings,
  hasEvent,
  listCompetitors,
  listFundingsForDeployer,
  listLiveDeployers,
  markDeployer,
  queuedDeployers,
  pruneLargeFundings,
  purgeCompetitorResults,
  recordFunding,
  resetCursor,
  saveSettings,
  setBackfill,
  setHistoryFrom,
  setInternalBackfill,
  setInternalCursor,
  setInternalFrom,
  setScanState,
  upsertToken,
} from "./db.js";
import {
  blockBefore,
  blockByTime,
  contractCreations,
  getBalance,
  getReceipt,
  headBlock,
  inLiveLane,
  internalTransfers,
  transactionCounts,
  internalTxs,
  isDeploymentTx,
  mintedTokens,
  normalTxs,
  plainEthTransfer,
  readTokenMeta,
} from "./chain.js";
import { refreshMarkets } from "./market.js";
import { watchPaid } from "./paid.js";
import { notifyLaunch } from "./telegram.js";
import { ethToWei, formatEth, formatKst, normalizeAddress, nowSec, sleep, timezoneLabel, zonedUnix } from "./util.js";

const HISTORY_OFFSET = 1000;
const HISTORY_WINDOW_PAGES = 10;
const WALLET_POOL = 12;
const WALLET_TX_LIMIT = 1000;

const job = {
  running: false,
  stop: false,
  competitorId: null,
  label: "",
  note: "",
  queue: [],
};
const queuedOptions = new Map();
let scanRange = null;

export function getJob() {
  return { ...job, queue: [...job.queue] };
}

export function cachedScanRange() {
  return scanRange ? { start: scanRange.start, end: scanRange.end } : null;
}

function blockCoverage(from, cursor, backfill, start, end) {
  const span = end - start + 1;
  if (span <= 0) return 0;
  const origin = Number(from) || 0;
  const high = Number(cursor) || 0;
  const fill = Number(backfill) || 0;
  let covered = 0;
  if (origin > 0 && high >= origin) {
    const low = Math.max(origin, start);
    const top = Math.min(high, end);
    if (top >= low) covered += top - low + 1;
    if (origin > start && fill >= start) {
      const backTop = Math.min(fill, origin - 1, end);
      if (backTop >= start) covered += backTop - start + 1;
    }
  } else if (high > 0) {
    const top = Math.min(high, end);
    if (top >= start) covered += top - start + 1;
  }
  return Math.min(covered / span, 1);
}

export function scanProgress(competitor, range) {
  if (!range || !(range.end >= range.start)) return { scan_percent: 0, scan_detail: "Waiting for the scan range" };
  const normal = blockCoverage(competitor.history_from_block, competitor.cursor_block, competitor.backfill_block, range.start, range.end);
  const internal = blockCoverage(
    competitor.internal_from_block,
    competitor.internal_cursor_block,
    competitor.internal_backfill_block,
    range.start,
    range.end,
  );
  const tracked = Number(competitor.tracked) || 0;
  const queued = Number(competitor.queued) || 0;
  const wallets = tracked === 0 ? 1 : Math.max(0, tracked - queued) / tracked;
  const historyDone = normal >= 0.995;
  const internalDone = internal >= 0.995;
  const finished = historyDone && internalDone && queued === 0;
  let fraction;
  let detail;
  if (finished) {
    fraction = 1;
    detail = "Caught up";
  } else if (tracked > 0) {
    fraction = Math.min(0.99, wallets);
    const left = `${queued.toLocaleString()} wallet${queued === 1 ? "" : "s"} left`;
    if (!historyDone) detail = `${left} · block range still open`;
    else if (!internalDone) detail = `${left} · internal transfers still open`;
    else detail = left;
  } else if (!historyDone) {
    fraction = normal;
    detail = "Block range still open";
  } else {
    fraction = 0.99;
    detail = "Internal transfers still open";
  }
  return { scan_percent: Math.round(fraction * 100), scan_detail: detail };
}

const WALLET_SECONDS = 0.45;
const CHUNK_SECONDS = 6;
const BLOCKS_PER_CHUNK = 3500;
const paceByRival = new Map();
const paceAll = freshPace();

function freshPace() {
  return { walletSec: null, walletN: 0, normalSec: null, normalBlocks: null, normalN: 0, internalSec: null, internalBlocks: null, internalN: 0 };
}

function blend(previous, next, samples) {
  if (previous == null) return next;
  const keep = samples < 4 ? 0.5 : 0.75;
  return previous * keep + next * (1 - keep);
}

function rememberPace(id, kind, seconds, amount = 0) {
  if (!(seconds >= 0.2)) return;
  if (!paceByRival.has(id)) paceByRival.set(id, freshPace());
  for (const bucket of [paceByRival.get(id), paceAll]) {
    if (kind === "wallet") {
      bucket.walletN += 1;
      bucket.walletSec = blend(bucket.walletSec, seconds, bucket.walletN);
      continue;
    }
    const internal = kind === "internal";
    const secKey = internal ? "internalSec" : "normalSec";
    const blockKey = internal ? "internalBlocks" : "normalBlocks";
    const countKey = internal ? "internalN" : "normalN";
    bucket[countKey] += 1;
    bucket[secKey] = blend(bucket[secKey], seconds, bucket[countKey]);
    if (amount >= 1) bucket[blockKey] = blend(bucket[blockKey], amount, bucket[countKey]);
  }
}

function rateFor(id) {
  const own = paceByRival.get(id) || freshPace();
  const walletSec = own.walletN > 0 ? own.walletSec : paceAll.walletN > 0 ? paceAll.walletSec : WALLET_SECONDS;
  const normalSec = own.normalN > 0 ? own.normalSec : paceAll.normalN > 0 ? paceAll.normalSec : CHUNK_SECONDS;
  const normalBlocks = own.normalBlocks || paceAll.normalBlocks || BLOCKS_PER_CHUNK;
  const internalSec = own.internalN > 0 ? own.internalSec : paceAll.internalN > 0 ? paceAll.internalSec : normalSec;
  const internalBlocks = own.internalBlocks || paceAll.internalBlocks || normalBlocks;
  return { walletSec, normalSec, normalBlocks, internalSec, internalBlocks };
}

function uncoveredBlocks(from, cursor, backfill, start, end) {
  const span = end - start + 1;
  if (span <= 0) return { coverage: 1, blocks: 0 };
  const coverage = blockCoverage(from, cursor, backfill, start, end);
  return { coverage, blocks: Math.max(0, Math.round(span * (1 - coverage))) };
}

function historyChunks(coverage, blocks, perChunk) {
  if (coverage >= 0.995) return 0;
  const size = Math.max(1, Number(perChunk) || BLOCKS_PER_CHUNK);
  return Math.min(3000, Math.max(1, Math.ceil(Math.max(blocks, 1) / size)));
}

function formatEta(seconds, running) {
  if (!(seconds >= 0)) return "";
  const phrase = (body) => (running ? `about ${body} left` : `about ${body} if scanning`);
  if (seconds < 50) return running ? "under a minute left" : "under a minute if scanning";
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return phrase(`${minutes} min`);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return phrase(rest >= 10 ? `${hours} hr ${rest} min` : `${hours} hr`);
  const days = Math.max(2, Math.round(hours / 24));
  return phrase(`${days} days`);
}

function takeScanStep(item) {
  const historyWaiting = item.normalChunks > 0 || item.internalChunks > 0;
  if (item.wallets > 0 && (item.prefer !== "history" || !historyWaiting)) {
    const count = Math.min(24, item.wallets);
    item.wallets -= count;
    item.prefer = "history";
    return Math.ceil(count / WALLET_POOL) * item.walletSec;
  }
  if (item.normalChunks > 0) {
    item.normalChunks -= 1;
    item.prefer = "wallet";
    return item.normalSec;
  }
  if (item.internalChunks > 0) {
    item.internalChunks -= 1;
    item.prefer = "wallet";
    return item.internalSec;
  }
  if (item.wallets > 0) {
    const count = Math.min(24, item.wallets);
    item.wallets -= count;
    item.prefer = "history";
    return Math.ceil(count / WALLET_POOL) * item.walletSec;
  }
  return 0;
}

function activeRivalIds(competitors, job) {
  if (!job?.running) return competitors.filter((rival) => rival.enabled !== 0).map((rival) => rival.id);
  const ids = [job.competitorId, ...(job.queue || [])].filter((id) => Number.isInteger(Number(id)) && Number(id) > 0);
  const set = new Set(ids.map(Number));
  for (const rival of competitors) {
    if (rival.scan_status === "running") set.add(rival.id);
  }
  return [...set];
}

export function decorateScan(competitors, range, job) {
  const active = new Set(activeRivalIds(competitors, job));
  const items = [];
  for (const rival of competitors) {
    const progress = scanProgress(rival, range);
    rival.scan_percent = progress.scan_percent;
    rival.scan_detail = progress.scan_detail;
    rival.scan_eta = "";
    if (!active.has(rival.id)) continue;
    const rate = rateFor(rival.id);
    const normal = range
      ? uncoveredBlocks(rival.history_from_block, rival.cursor_block, rival.backfill_block, range.start, range.end)
      : { coverage: 1, blocks: 0 };
    const internal = range
      ? uncoveredBlocks(rival.internal_from_block, rival.internal_cursor_block, rival.internal_backfill_block, range.start, range.end)
      : { coverage: 1, blocks: 0 };
    const queued = Number(rival.queued) || 0;
    const normalChunks = historyChunks(normal.coverage, normal.blocks, rate.normalBlocks);
    const internalChunks = historyChunks(internal.coverage, internal.blocks, rate.internalBlocks);
    if (queued === 0 && normalChunks === 0 && internalChunks === 0) continue;
    items.push({
      id: rival.id,
      wallets: queued,
      normalChunks,
      internalChunks,
      walletSec: rate.walletSec,
      normalSec: rate.normalSec,
      internalSec: rate.internalSec,
      prefer: queued > 0 ? "wallet" : "history",
    });
  }
  const waits = new Map();
  let clock = 0;
  let guard = 0;
  while (items.some((item) => !waits.has(item.id)) && guard < 250000) {
    guard += 1;
    let moved = false;
    for (const item of items) {
      if (waits.has(item.id)) continue;
      const step = takeScanStep(item);
      if (step > 0) {
        clock += step;
        moved = true;
      }
      if (item.wallets <= 0 && item.normalChunks <= 0 && item.internalChunks <= 0) waits.set(item.id, clock);
    }
    if (!moved) break;
  }
  const running = Boolean(job?.running);
  for (const rival of competitors) {
    if (!waits.has(rival.id)) continue;
    rival.scan_eta = formatEta(waits.get(rival.id), running);
  }
}

export function stopScan() {
  job.stop = true;
  job.note = "Stopping after the current step";
}

export function enqueueScan(ids, options = {}) {
  const unique = [...new Set(ids.map(Number))].filter((id) => Number.isInteger(id) && id > 0);
  if (!unique.length) return getJob();
  for (const id of unique) {
    queuedOptions.set(id, { ...(queuedOptions.get(id) || {}), ...options });
    if (options.purge || options.rewind) queuedOptions.get(id).prepared = false;
    if (job.competitorId !== id && !job.queue.includes(id)) job.queue.push(id);
    if (job.competitorId === id && !job.queue.includes(id)) job.queue.push(id);
    const existing = getCompetitor(id);
    if (existing && existing.scan_status !== "running") {
      const kept = options.fromStart
        ? "Starting from the selected start"
        : existing.scan_note && !existing.scan_note.startsWith("Stopped")
          ? existing.scan_note
          : "Waiting to scan";
      setScanState(id, { status: "running", note: kept });
    }
  }
  if (!job.running) {
    job.stop = false;
    runLoop().catch((error) => {
      console.error(error);
      job.running = false;
      job.note = error.message;
    });
  }
  return getJob();
}

async function runLoop() {
  job.running = true;
  job.stop = false;
  const failures = new Map();
  while (job.queue.length && !job.stop) {
    const id = job.queue.shift();
    const competitor = getCompetitor(id);
    if (!competitor || !competitor.enabled) {
      queuedOptions.delete(id);
      continue;
    }
    job.competitorId = id;
    job.label = competitor.label;
    const options = queuedOptions.get(id) || {};
    const rotate = job.queue.length > 0;
    try {
      const finished = await scanCompetitor(competitor, options, rotate);
      failures.delete(id);
      if (finished || job.stop) queuedOptions.delete(id);
      else job.queue.push(id);
    } catch (error) {
      console.error(`scan failed for ${competitor.label}`, error);
      const count = (failures.get(id) || 0) + 1;
      failures.set(id, count);
      setScanState(id, {
        status: "error",
        error: error.message,
        note: `Stopped: ${error.message}`,
      });
      if (count < 8 && !job.stop) job.queue.push(id);
      else queuedOptions.delete(id);
    }
  }
  if (job.stop) {
    for (const id of job.queue) {
      const pending = countQueued(id);
      setScanState(id, {
        status: "idle",
        note: pending
          ? `Stopped with ${pending} funded wallets still unchecked. Scan again to continue.`
          : "Stopped. Scan again to continue from this block.",
        scanned: true,
      });
    }
  }
  job.running = false;
  job.competitorId = null;
  job.label = "";
  job.note = job.stop ? "Scan stopped" : job.note || "Idle";
  job.queue = [];
}

function note(competitor, text) {
  job.note = text;
  setScanState(competitor.id, { status: "running", note: text, error: "" });
}

async function scanCompetitor(competitor, options, rotate) {
  const settings = getSettings();
  if (!options.prepared) {
    pruneLargeFundings(ethToWei(settings.maxFundingEth || "20"));
    if (options.purge) purgeCompetitorResults(competitor.id);
    if (options.rewind || options.purge || options.fromStart) resetCursor(competitor.id);
    if (options.fromStart) {
      const range = await resolveScanRange(settings);
      setScanState(competitor.id, {
        status: "running",
        note: `Starting at block ${range.start.toLocaleString()}`,
        error: "",
      });
      options.historyTurn = true;
    }
    options.prepared = true;
  }
  while (!job.stop) {
    const current = getCompetitor(competitor.id);
    if (countQueued(competitor.id) > 0 && !options.historyTurn) {
      await drainDeployers(current, settings, rotate ? 20 : Infinity);
      options.historyTurn = true;
      if (job.stop) return finishStopped(competitor.id);
      if (countQueued(competitor.id) > 0) {
        if (rotate) return false;
        continue;
      }
    }
    options.historyTurn = false;
    note(current, "Reading transfer history");
    const walk = await advanceHistory(current, settings);
    if (job.stop) return finishStopped(competitor.id);
    if (!walk.done || countQueued(competitor.id) > 0) {
      if (rotate) return false;
      continue;
    }
    await recheckSettled(competitor, settings);
    const range = await resolveScanRange(settings);
    setScanState(competitor.id, {
      status: "idle",
      note: `Caught up from block ${range.start.toLocaleString()} through ${range.end.toLocaleString()}. Saved results are kept.`,
      error: "",
      scanned: true,
    });
    job.note = `${competitor.label} caught up`;
    return true;
  }
  return finishStopped(competitor.id);
}

function finishStopped(id) {
  const pending = countQueued(id);
  setScanState(id, {
    status: "idle",
    note: pending
      ? `Stopped with ${pending} funded wallets still unchecked. Scan again to continue.`
      : "Stopped. Scan again to continue from this block.",
    scanned: true,
  });
  return true;
}

function zonedStamp(unix) {
  const settings = getSettings();
  return `${formatKst(unix, settings.timezoneOffset)} ${timezoneLabel(settings.timezoneOffset)}`;
}

async function resolveScanRange(settings) {
  const head = await headBlock();
  const live = settings.live === "1";
  if ((settings.scanRangeMode || "date") === "block") {
    const start = Number(settings.scanStartBlock);
    const end = Number(settings.scanEndBlock);
    if (!Number.isInteger(start) || start < 1) throw new Error("Set a start block before scanning.");
    if (!Number.isInteger(end) || end < start) throw new Error("Set an end block at or after the start block.");
    scanRange = { start, end: live ? Math.max(start, head) : Math.min(end, head) };
    return scanRange;
  }
  const startUnix = zonedUnix(
    settings.scanStartDate,
    settings.scanStartHour,
    settings.scanStartMinute,
    settings.scanStartSecond,
    settings.timezoneOffset,
  );
  const endUnix = zonedUnix(
    settings.scanEndDate,
    settings.scanEndHour,
    settings.scanEndMinute,
    settings.scanEndSecond,
    settings.timezoneOffset,
  );
  if (startUnix == null || endUnix == null || endUnix < startUnix) {
    throw new Error("Set a start and an end, with the end at or after the start.");
  }
  const start = await blockByTime(startUnix, "after");
  const end = Math.min(await blockByTime(endUnix, "before"), head);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) {
    throw new Error("That date range has no blocks yet.");
  }
  if (live) {
    scanRange = { start, end: Math.max(start, head) };
    return scanRange;
  }
  scanRange = { start, end };
  return scanRange;
}

export async function warmScanRange() {
  scanRange = await resolveScanRange(getSettings());
  return scanRange;
}

async function ensureKnownCoverage(competitor, settings) {
  let current = competitor;
  if (!current.history_from_block && current.cursor_block > 0) {
    const lookback = await blockBefore(Math.max(1, Number(settings.lookbackDays) || 30));
    setHistoryFrom(current.id, Math.min(lookback, current.cursor_block));
    current = getCompetitor(current.id);
  }
  if (!current.internal_from_block && current.internal_cursor_block > 0) {
    const lookback = await blockBefore(Math.max(1, Number(settings.lookbackDays) || 30));
    setInternalFrom(current.id, Math.min(lookback, current.internal_cursor_block));
    current = getCompetitor(current.id);
  }
  return current;
}

function nextSpan(from, high, backfill, start, end) {
  if (high <= 0) return { kind: "forward", resume: start, start, end };
  if (start < from) {
    const resume = backfill > start && backfill < from ? backfill : start;
    if (resume <= from - 1) return { kind: "backfill", resume, start, end: from - 1 };
  }
  if (high < end) return { kind: "forward", resume: Math.max(high, start), start: Math.max(high, start), end };
  return null;
}

async function advanceHistory(competitor, settings) {
  const range = await resolveScanRange(settings);
  let current = await ensureKnownCoverage(competitor, settings);
  const normal = nextSpan(current.history_from_block, current.cursor_block, current.backfill_block, range.start, range.end);
  if (normal) return timedHistory(current, settings, normal, "normal");
  current = getCompetitor(competitor.id);
  const internal = nextSpan(
    current.internal_from_block,
    current.internal_cursor_block,
    current.internal_backfill_block,
    range.start,
    range.end,
  );
  if (internal) return timedHistory(current, settings, internal, "internal");
  return { done: true };
}

async function timedHistory(competitor, settings, span, kind) {
  const before = kind === "internal" ? Number(competitor.internal_cursor_block) || 0 : Number(competitor.cursor_block) || 0;
  const started = Date.now();
  try {
    return kind === "internal" ? await walkInternalChunk(competitor, settings, span) : await walkChunk(competitor, settings, span);
  } finally {
    const current = getCompetitor(competitor.id);
    const after = kind === "internal" ? Number(current?.internal_cursor_block) || 0 : Number(current?.cursor_block) || 0;
    rememberPace(competitor.id, kind, (Date.now() - started) / 1000, Math.max(0, after - before));
  }
}

function reachedLimit(lastBlock, limit) {
  return Number.isFinite(lastBlock) && lastBlock >= limit - 30;
}

function completeSpan(competitor, span, label) {
  if (span.kind === "backfill") {
    if (label === "normal") {
      setHistoryFrom(competitor.id, span.start);
      setBackfill(competitor.id, 0);
    } else {
      setInternalFrom(competitor.id, span.start);
      setInternalBackfill(competitor.id, 0);
    }
    note(competitor, `Saved earlier blocks through ${span.end.toLocaleString()}`);
    return;
  }
  if (label === "normal") {
    setScanState(competitor.id, {
      status: "running",
      cursor: span.end,
      note: `Transaction history saved through block ${span.end.toLocaleString()}`,
    });
    if (!competitor.history_from_block || competitor.history_from_block > span.start) setHistoryFrom(competitor.id, span.start);
    return;
  }
  setInternalCursor(competitor.id, span.end);
  if (!competitor.internal_from_block || competitor.internal_from_block > span.start) setInternalFrom(competitor.id, span.start);
  note(competitor, `Internal transfers saved through block ${span.end.toLocaleString()}`);
}

function rememberPlace(competitor, span, block, label, text) {
  if (span.kind === "backfill") {
    if (label === "normal") setBackfill(competitor.id, block);
    else setInternalBackfill(competitor.id, block);
    note(competitor, text);
    return;
  }
  if (label === "normal") {
    setScanState(competitor.id, { status: "running", cursor: block, note: text });
    return;
  }
  setInternalCursor(competitor.id, block);
  note(competitor, text);
}

async function walkChunk(competitor, settings, span) {
  let block = span.resume;
  let page = 1;
  let pages = 0;
  const pageCap = Math.max(5, Number(settings.maxPages) || 40);
  const minWei = ethToWei(settings.minFundingEth || "0.01");
  const maxWei = ethToWei(settings.maxFundingEth || "20");
  const newTokens = [];
  let previousTail = "";

  while (!job.stop && pages < pageCap) {
    if (block > span.end) {
      completeSpan(competitor, span, "normal");
      if (newTokens.length) await refreshMarkets(newTokens);
      return { done: true, pages };
    }
    note(competitor, `Reading transactions from block ${block.toLocaleString()}`);
    const batch = await normalTxs(competitor.address, block, page, HISTORY_OFFSET, span.end);
    pages += 1;
    const inRange = batch.filter((tx) => Number(tx.blockNumber) <= span.end);
    const tail = inRange[inRange.length - 1]?.hash || "";
    const last = Number(inRange[inRange.length - 1]?.blockNumber);
    const first = Number(inRange[0]?.blockNumber);
    const passedEnd = batch.some((tx) => Number(tx.blockNumber) > span.end);
    if (!inRange.length || (tail && tail === previousTail && (reachedLimit(last, span.end) || passedEnd))) {
      completeSpan(competitor, span, "normal");
      if (newTokens.length) await refreshMarkets(newTokens);
      return { done: true, pages };
    }
    if (tail && tail === previousTail) {
      block = (Number.isFinite(last) ? last : block) + 1;
      page = 1;
      previousTail = "";
      rememberPlace(competitor, span, block, "normal", `Read through block ${Math.min(block, span.end).toLocaleString()}`);
      continue;
    }
    previousTail = tail;

    for (const tx of inRange) {
      if (job.stop) {
        if (newTokens.length) await refreshMarkets(newTokens);
        return { done: false, pages };
      }
      const created = await handleCompetitorTx(competitor, tx, minWei, maxWei);
      if (created?.length) newTokens.push(...created);
    }

    if (passedEnd || (inRange.length < HISTORY_OFFSET && reachedLimit(last, span.end))) {
      completeSpan(competitor, span, "normal");
      if (newTokens.length) await refreshMarkets(newTokens);
      return { done: true, pages };
    }
    if (inRange.length < HISTORY_OFFSET) {
      block = Number.isFinite(last) ? last : block + 1;
      page = 1;
      rememberPlace(competitor, span, block, "normal", `Read through block ${block.toLocaleString()}`);
      continue;
    }
    if (first === last) {
      page += 1;
      if (page > HISTORY_WINDOW_PAGES) {
        block = last + 1;
        page = 1;
      }
    } else {
      block = last;
      page = 1;
    }
    rememberPlace(competitor, span, block, "normal", `Read through block ${block.toLocaleString()}`);
  }

  if (newTokens.length) await refreshMarkets(newTokens);
  return { done: false, pages };
}

async function walkInternalChunk(competitor, settings, span) {
  let block = span.resume;
  let page = 1;
  let pages = 0;
  const pageCap = Math.max(5, Number(settings.maxPages) || 40);
  const minWei = ethToWei(settings.minFundingEth || "0.01");
  const maxWei = ethToWei(settings.maxFundingEth || "20");
  let previousTail = "";

  while (!job.stop && pages < pageCap) {
    if (block > span.end) {
      completeSpan(competitor, span, "internal");
      return { done: true, pages };
    }
    note(competitor, `Reading internal transfers from block ${block.toLocaleString()}`);
    const batch = await internalTxs(competitor.address, block, page, HISTORY_OFFSET, span.end);
    pages += 1;
    const inRange = batch.filter((tx) => Number(tx.blockNumber) <= span.end);
    const tail = inRange[inRange.length - 1]?.hash || "";
    const last = Number(inRange[inRange.length - 1]?.blockNumber);
    const first = Number(inRange[0]?.blockNumber);
    const passedEnd = batch.some((tx) => Number(tx.blockNumber) > span.end);
    if (!inRange.length || (tail && tail === previousTail && (reachedLimit(last, span.end) || passedEnd))) {
      completeSpan(competitor, span, "internal");
      return { done: true, pages };
    }
    if (tail && tail === previousTail) {
      block = (Number.isFinite(last) ? last : block) + 1;
      page = 1;
      previousTail = "";
      rememberPlace(competitor, span, block, "internal", `Read internal transfers through block ${Math.min(block, span.end).toLocaleString()}`);
      continue;
    }
    previousTail = tail;

    for (const tx of inRange) {
      if (job.stop) return { done: false, pages };
      recordOutgoingInternal(competitor, tx, minWei, maxWei);
    }

    if (passedEnd || (inRange.length < HISTORY_OFFSET && reachedLimit(last, span.end))) {
      completeSpan(competitor, span, "internal");
      return { done: true, pages };
    }
    if (inRange.length < HISTORY_OFFSET) {
      block = Number.isFinite(last) ? last : block + 1;
      page = 1;
      rememberPlace(competitor, span, block, "internal", `Read internal transfers through block ${block.toLocaleString()}`);
      continue;
    }
    if (first === last) {
      page += 1;
      if (page > HISTORY_WINDOW_PAGES) {
        block = last + 1;
        page = 1;
      }
    } else {
      block = last;
      page = 1;
    }
    rememberPlace(competitor, span, block, "internal", `Read internal transfers through block ${block.toLocaleString()}`);
  }

  return { done: false, pages };
}

function recordOutgoingInternal(competitor, tx, minWei, maxWei) {
  if ((tx.from || "").toLowerCase() !== competitor.address) return;
  if (tx.isError === "1") return;
  const kind = (tx.type || "call").toLowerCase();
  if (kind !== "call") return;
  const deployer = normalizeAddress(tx.to);
  if (!deployer || deployer === competitor.address) return;
  const value = BigInt(tx.value || "0");
  if (value < minWei || value > maxWei) return;
  recordFunding({
    competitorId: competitor.id,
    deployer,
    funder: competitor.address,
    txHash: tx.hash,
    blockNumber: Number(tx.blockNumber),
    timestamp: Number(tx.timeStamp),
    valueWei: value.toString(),
    kind: "internal",
  });
}

function isCreateTx(tx) {
  if (!tx.to) return true;
  const contract = (tx.contractAddress || "").toLowerCase();
  const to = (tx.to || "").toLowerCase();
  if (contract && to === contract) return true;
  const input = tx.input || "";
  return input.startsWith("0x60806040") || input.startsWith("0x60e06040");
}

async function handleCompetitorTx(competitor, tx, minWei, maxWei) {
  if ((tx.from || "").toLowerCase() !== competitor.address) return [];
  if (tx.isError === "1") return [];
  const value = BigInt(tx.value || "0");
  const tokens = [];
  const direct = normalizeAddress(tx.to);
  const created = (tx.contractAddress || "").toLowerCase();
  if (direct && direct !== competitor.address && direct !== created && value >= minWei && value <= maxWei) {
    recordFunding({
      competitorId: competitor.id,
      deployer: direct,
      funder: competitor.address,
      txHash: tx.hash,
      blockNumber: Number(tx.blockNumber),
      timestamp: Number(tx.timeStamp),
      valueWei: value.toString(),
      kind: "direct",
    });
  }
  if (plainEthTransfer(tx)) return tokens;
  if (isCreateTx(tx) || (value >= minWei && value <= maxWei)) {
    tokens.push(...(await traceFundingTx(competitor, tx, minWei, maxWei)));
  }
  return tokens;
}

async function traceFundingTx(competitor, tx, minWei, maxWei) {
  const tokens = [];
  let receipt = null;
  try {
    receipt = await getReceipt(tx.hash);
  } catch (error) {
    console.error("receipt failed", tx.hash, error.message);
  }
  if (receipt && isDeploymentTx(tx, receipt)) {
    tokens.push(...(await saveMints(competitor, tx, receipt)));
  }

  let internals = [];
  try {
    internals = await internalTransfers(tx.hash);
  } catch (error) {
    throw new Error(`Could not read internal transfers for ${tx.hash.slice(0, 10)}: ${error.message}`);
  }
  const created = (receipt?.contractAddress || tx.contractAddress || "").toLowerCase();
  for (const item of internals) {
    if (!item.success || item.error) continue;
    if (item.type && item.type !== "call") continue;
    const to = item.to?.hash?.toLowerCase();
    const from = item.from?.hash?.toLowerCase();
    if (!to || !from) continue;
    if (to === competitor.address || to === created) continue;
    let value = 0n;
    try {
      value = BigInt(item.value || "0");
    } catch {
      continue;
    }
    if (value < minWei || value > maxWei) continue;
    recordFunding({
      competitorId: competitor.id,
      deployer: to,
      funder: from,
      txHash: tx.hash,
      blockNumber: Number(tx.blockNumber),
      timestamp: Number(tx.timeStamp),
      valueWei: value.toString(),
      kind: "internal",
    });
  }
  return tokens;
}

async function saveMints(competitor, tx, receipt) {
  const created = [];
  for (const token of await tokensCreatedByTx(tx, receipt)) {
    const result = upsertToken({
      address: token.address,
      deployer: competitor.address,
      name: token.meta.name,
      symbol: token.meta.symbol,
      decimals: token.meta.decimals,
      createdAt: Number(tx.timeStamp),
      createdTx: tx.hash,
      createdBlock: Number(tx.blockNumber),
    });
    if (result.created) {
      addEvent({
        kind: "launch",
        competitorId: competitor.id,
        address: token.address,
        message: `${token.meta.symbol} launched by ${competitor.label} · ${zonedStamp(Number(tx.timeStamp))}`,
      });
      notifyLaunch({
        symbol: token.meta.symbol,
        name: token.meta.name,
        address: token.address,
        deployer: competitor.address,
        rival: competitor.label,
        launchedAt: Number(tx.timeStamp),
      });
      watchPaid(token.address);
      created.push(token.address);
    }
  }
  return created;
}

async function tokensCreatedByTx(tx, receipt) {
  if (!receipt || (receipt.status && BigInt(receipt.status) === 0n)) return [];
  const candidates = new Set(mintedTokens(receipt));
  if (receipt.contractAddress) candidates.add(receipt.contractAddress.toLowerCase());
  const createdHere = new Set();
  if (receipt.contractAddress) createdHere.add(receipt.contractAddress.toLowerCase());
  if (candidates.size) {
    const creations = await contractCreations([...candidates]);
    for (const row of creations) {
      const address = (row.contractAddress || row.contract_address || "").toLowerCase();
      const txHash = (row.txHash || row.tx_hash || row.transactionHash || "").toLowerCase();
      if (address && txHash === tx.hash.toLowerCase()) createdHere.add(address);
    }
  }
  const found = [];
  const seen = new Set();
  const accept = async (address) => {
    if (!address || seen.has(address)) return;
    seen.add(address);
    const meta = await readTokenMeta(address);
    if (!meta) return;
    found.push({ address, meta });
  };
  for (const address of createdHere) await accept(address);
  if (!found.length && isDeploymentTx(tx, receipt)) {
    let internals = [];
    try {
      internals = await internalTransfers(tx.hash);
    } catch (error) {
      console.error(`internal lookup skipped for ${tx.hash}`, error.message);
      return found;
    }
    for (const item of internals) {
      if (item.type !== "create") continue;
      const address = (
        item.created_contract?.hash ||
        item.created_contract_address ||
        item.createdContract?.hash ||
        ""
      ).toLowerCase();
      await accept(address);
    }
  }
  return found;
}

async function runPool(items, worker) {
  if (!items.length) return;
  let next = 0;
  const width = Math.min(WALLET_POOL, items.length);
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (!job.stop) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        await worker(items[index]);
      }
    }),
  );
}

async function drainDeployers(competitor, settings, maxChecks = Infinity) {
  const failed = new Set();
  const freshTokens = [];
  let checked = 0;
  while (!job.stop && checked < maxChecks) {
    const room = Math.min(24, maxChecks - checked);
    const rows = queuedDeployers(competitor.id, room + failed.size)
      .filter((row) => !failed.has(row.address))
      .slice(0, room);
    if (!rows.length) break;
    checked += rows.length;
    await runPool(rows, async (deployer) => {
      if (job.stop) return;
      const left = countQueued(competitor.id);
      note(competitor, `Checking funded wallet ${checked} · ${left} still queued · ${deployer.address.slice(0, 8)}`);
      const started = Date.now();
      try {
        freshTokens.push(...(await inspectDeployer(deployer.address, settings)));
      } catch (error) {
        console.error("inspect failed", deployer.address, error.message);
        failed.add(deployer.address);
        markDeployer(deployer.address, {
          status: "queued",
          note: "Check failed, scan again",
          lastCheckedAt: Math.floor(Date.now() / 1000),
        });
      } finally {
        rememberPace(competitor.id, "wallet", (Date.now() - started) / 1000, 1);
      }
    });
    if (freshTokens.length) await refreshMarkets(freshTokens.splice(0, freshTokens.length));
  }
  return failed.size;
}

async function recheckSettled(competitor, settings) {
  const rows = dueDeployers(competitor.id, 40).filter((row) => row.status !== "queued");
  const freshTokens = [];
  await runPool(rows, async (deployer) => {
    note(competitor, `Rechecking ${deployer.status} wallet ${deployer.address.slice(0, 8)}`);
    try {
      freshTokens.push(...(await inspectDeployer(deployer.address, settings)));
    } catch (error) {
      console.error("recheck failed", deployer.address, error.message);
    }
  });
  if (freshTokens.length) await refreshMarkets(freshTokens);
}

async function inspectDeployer(address, settings) {
  const fundings = listFundingsForDeployer(address);
  if (!fundings.length) {
    markDeployer(address, { status: "ignored", note: "No tracked funding", lastCheckedAt: Math.floor(Date.now() / 1000) });
    return [];
  }
  const loaded = await loadDeployerTxs(address);
  const txs = loaded.rows;
  const outgoing = txs.filter((tx) => (tx.from || "").toLowerCase() === address && tx.isError !== "1");
  const requireFirst = settings.requireFirstFunder !== "0";
  if (requireFirst && !passesFirstFunder(address, txs, fundings, settings)) {
    markDeployer(address, {
      status: "ignored",
      txCount: outgoing.length,
      note: "First ETH came from a different wallet",
      lastCheckedAt: Math.floor(Date.now() / 1000),
    });
    return [];
  }

  const balance = await getBalance(address).catch(() => null);
  const found = [];
  const candidates = selectDeployerTxs(outgoing);
  for (let index = 0; index < candidates.length && !job.stop; index += 4) {
    const slice = candidates.slice(index, index + 4);
    const groups = await Promise.all(
      slice.map(async (tx) => ({ tx, tokens: await tokensCreatedByTx(tx, await receiptFor(tx.hash)) })),
    );
    for (const { tx, tokens } of groups) {
      for (const token of tokens) {
        const result = upsertToken({
          address: token.address,
          deployer: address,
          name: token.meta.name,
          symbol: token.meta.symbol,
          decimals: token.meta.decimals,
          createdAt: Number(tx.timeStamp),
          createdTx: tx.hash,
          createdBlock: Number(tx.blockNumber),
        });
        if (result.created) {
          const rival = fundings[0];
          addEvent({
            kind: "launch",
            competitorId: rival.competitor_id,
            address: token.address,
            message: `${token.meta.symbol} launched · ${rival.label} · ${zonedStamp(Number(tx.timeStamp))}`,
          });
          notifyLaunch({
            symbol: token.meta.symbol,
            name: token.meta.name,
            address: token.address,
            deployer: address,
            rival: rival.label,
            launchedAt: Number(tx.timeStamp),
          });
          watchPaid(token.address);
          found.push(token.address);
        }
      }
    }
  }

  const tokenCount = countTokensForDeployer(address);
  let status = "waiting";
  if (tokenCount > 0) status = "launched";
  else if (balance != null && BigInt(balance) < ethToWei("0.004")) status = "drained";

  markDeployer(address, {
    status,
    ethBalanceWei: balance,
    balanceAt: Math.floor(Date.now() / 1000),
    txCount: outgoing.length,
    note: loaded.truncated
      ? "Checked the earliest 1000 transactions"
      : status === "waiting"
        ? "Funded, no token yet"
        : "",
    lastCheckedAt: Math.floor(Date.now() / 1000),
  });

  if (status === "waiting" && !hasEvent("waiting", address)) {
    const earliest = fundings[0];
    addEvent({
      kind: "waiting",
      competitorId: earliest.competitor_id,
      address,
      message: `${formatEth(earliest.value_wei)} ETH waiting · ${earliest.label} · ${zonedStamp(earliest.timestamp)}`,
    });
  }

  if (status !== "launched" && outgoing.length <= 12) {
    forwardOnce(address, outgoing, fundings, settings);
  }
  return found;
}

function passesFirstFunder(address, txs, fundings, settings) {
  const dust = ethToWei(settings.dustEth || "0.005");
  const candidates = [];
  for (const tx of txs) {
    if ((tx.to || "").toLowerCase() !== address) continue;
    if (tx.isError === "1") continue;
    const value = BigInt(tx.value || "0");
    if (value < dust) continue;
    candidates.push({ from: tx.from.toLowerCase(), time: Number(tx.timeStamp) });
  }
  for (const funding of fundings) {
    if (BigInt(funding.value_wei) < dust) continue;
    candidates.push({ from: funding.funder.toLowerCase(), time: Number(funding.timestamp) });
  }
  if (!candidates.length) return false;
  candidates.sort((a, b) => a.time - b.time);
  const allowed = new Set();
  for (const funding of fundings) {
    allowed.add(funding.funder.toLowerCase());
    allowed.add(funding.competitor_address.toLowerCase());
  }
  return allowed.has(candidates[0].from);
}

async function receiptFor(hash) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const receipt = await getReceipt(hash);
    if (receipt) return receipt;
    await sleep(350 * attempt);
  }
  throw new Error(`Missing receipt ${hash}`);
}

function selectDeployerTxs(outgoing) {
  const creates = [];
  const calls = [];
  for (const tx of outgoing) {
    const input = (tx.input || "").toLowerCase();
    if (!tx.to || tx.contractAddress || input.startsWith("0x60806040") || input.startsWith("0x60e06040")) creates.push(tx);
    else if (input && input !== "0x" && input !== "0x0") calls.push(tx);
  }
  if (creates.length + calls.length <= 80) return [...creates, ...calls];
  const picked = [...creates, ...calls.slice(0, 60), ...calls.slice(-20)];
  const seen = new Set();
  return picked.filter((tx) => {
    if (seen.has(tx.hash)) return false;
    seen.add(tx.hash);
    return true;
  });
}

async function loadDeployerTxs(address) {
  const rows = await normalTxs(address, 0, 1, WALLET_TX_LIMIT);
  return { rows, truncated: rows.length >= WALLET_TX_LIMIT };
}

function forwardOnce(address, outgoing, fundings, settings) {
  const minWei = ethToWei(settings.minFundingEth || "0.01");
  const parent = fundings[0];
  if (!parent || parent.kind === "forward") return;
  const windowEnd = Number(parent.timestamp) + 6 * 3600;
  const half = BigInt(parent.value_wei) / 2n;
  const floor = half > minWei ? half : minWei;
  const forwards = outgoing
    .filter((tx) => plainEthTransfer(tx) && BigInt(tx.value || "0") >= floor && Number(tx.timeStamp) <= windowEnd)
    .slice(0, 2);
  for (const tx of forwards) {
    const deployer = normalizeAddress(tx.to);
    if (!deployer || deployer === address || deployer === parent.competitor_address.toLowerCase()) continue;
    recordFunding({
      competitorId: parent.competitor_id,
      deployer,
      funder: address,
      txHash: tx.hash,
      blockNumber: Number(tx.blockNumber),
      timestamp: Number(tx.timeStamp),
      valueWei: BigInt(tx.value).toString(),
      kind: "forward",
    });
  }
}

export async function refreshOne(address) {
  const settings = getSettings();
  markDeployer(address, { status: "queued", lastCheckedAt: null, note: "" });
  const tokens = await inspectDeployer(address, settings);
  if (tokens.length) await refreshMarkets(tokens);
  return tokens;
}

const LIVE_TAIL_MS = 2_000;
const TIP_BLOCKS = 25;
const NONCE_CHUNK = 60;
const INSPECT_LIMIT = 4;
const liveNonces = new Map();
const liveRetryAt = new Map();
const liveInFlight = new Set();
const seenLiveTx = new Set();
let liveTailStarted = false;
let inspecting = 0;
let backlogInspects = 0;
let nonceCursor = 0;

async function pageWindow(loadPage, maxPages = 5) {
  const rows = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await loadPage(page);
    rows.push(...batch);
    if (batch.length < 100) break;
  }
  return rows;
}

function highestBlock(rows) {
  let block = 0;
  for (const tx of rows) block = Math.max(block, Number(tx.blockNumber) || 0);
  return block;
}

function queueInspect(address, settings, nonce, liveChange) {
  const key = String(address || "").toLowerCase();
  if (!key || liveInFlight.has(key)) return false;
  if (liveChange) {
    if (inspecting >= INSPECT_LIMIT) return false;
  } else if (backlogInspects >= 1 || inspecting >= INSPECT_LIMIT) {
    return false;
  }
  inspecting += 1;
  if (!liveChange) backlogInspects += 1;
  liveInFlight.add(key);
  inspectDeployer(key, settings)
    .then(async (tokens) => {
      if (nonce != null) liveNonces.set(key, nonce);
      if (tokens?.length) await refreshMarkets(tokens);
    })
    .catch((error) => {
      console.error("live wallet", key, error.message);
      liveRetryAt.set(key, Date.now() + 30_000);
    })
    .finally(() => {
      inspecting -= 1;
      if (!liveChange) backlogInspects -= 1;
      liveInFlight.delete(key);
    });
  return true;
}

async function watchWaitingWallets(settings) {
  const rows = listLiveDeployers();
  if (!rows.length) return;
  const started = Date.now();
  let scanned = 0;
  while (scanned < rows.length && Date.now() - started < 35_000) {
    if (getSettings().live !== "1") return;
    const start = nonceCursor % rows.length;
    const part = [];
    for (let index = 0; index < NONCE_CHUNK && scanned < rows.length; index += 1) {
      part.push(rows[(start + index) % rows.length]);
      scanned += 1;
    }
    nonceCursor = (start + part.length) % rows.length;
    let counts;
    try {
      counts = await transactionCounts(part.map((row) => row.address));
    } catch (error) {
      console.error("live nonce", error.message);
      continue;
    }
    for (const row of part) {
      const address = row.address.toLowerCase();
      const nonce = counts.get(address);
      if (nonce == null) continue;
      const previous = liveNonces.get(address);
      const known = Number(row.tx_count) || 0;
      if (previous == null) {
        const gap = nonce - known;
        const recent = Number(row.first_funded_at) > nowSec() - 36 * 3600;
        if (gap > 0 && (recent || gap <= 2) && (liveRetryAt.get(address) || 0) <= Date.now()) {
          if (!queueInspect(address, settings, nonce, true)) continue;
        } else {
          liveNonces.set(address, nonce);
        }
        continue;
      }
      if (nonce > previous && (liveRetryAt.get(address) || 0) <= Date.now()) queueInspect(address, settings, nonce, true);
      else liveNonces.set(address, nonce);
    }
  }
}

async function liveTailOnce() {
  const settings = getSettings();
  if (settings.live !== "1") return;
  const head = await headBlock();
  const saved = Number(settings.liveSeenBlock) || 0;
  const from = saved > 0 ? Math.max(1, saved - 2) : Math.max(1, head - 30);
  const to = Math.min(head, from + TIP_BLOCKS - 1);
  const minWei = ethToWei(settings.minFundingEth || "0.01");
  const maxWei = ethToWei(settings.maxFundingEth || "20");
  const rivals = listCompetitors().filter((competitor) => competitor.enabled);
  let failed = false;
  let coveredTo = to;
  if (from <= to) {
    for (const rival of rivals) {
      if (getSettings().live !== "1") return;
      try {
        const normal = await pageWindow((page) => normalTxs(rival.address, from, page, 100, to), 8);
        for (const tx of normal) {
          if (!tx.hash || seenLiveTx.has(tx.hash)) continue;
          seenLiveTx.add(tx.hash);
          try {
            await handleCompetitorTx(rival, tx, minWei, maxWei);
          } catch (error) {
            console.error("live tx", error.message);
          }
        }
        const internal = await pageWindow((page) => internalTxs(rival.address, from, page, 100, to), 8);
        for (const tx of internal) {
          const key = `i:${tx.hash}:${tx.to}`;
          if (seenLiveTx.has(key)) continue;
          seenLiveTx.add(key);
          recordOutgoingInternal(rival, tx, minWei, maxWei);
        }
        if (normal.length >= 800) coveredTo = Math.min(coveredTo, Math.max(from + 1, highestBlock(normal) || from));
        if (internal.length >= 800) coveredTo = Math.min(coveredTo, Math.max(from + 1, highestBlock(internal) || from));
        const fresh = queuedDeployers(rival.id, 20).filter((deployer) => Number(deployer.first_funded_at) > nowSec() - 20 * 60);
        for (const deployer of fresh) queueInspect(deployer.address, settings, null, true);
      } catch (error) {
        failed = true;
        console.error("live tip", rival.label, error.message);
      }
    }
  }
  if (seenLiveTx.size > 8000) {
    for (const key of seenLiveTx) {
      seenLiveTx.delete(key);
      if (seenLiveTx.size <= 4000) break;
    }
  }
  if (!failed && to > 0) {
    const next = coveredTo >= head ? Math.max(1, head - 2) : Math.max(from, coveredTo);
    saveSettings({ liveSeenBlock: String(next) });
  }
  await watchWaitingWallets(settings);
}

export function startLiveTail() {
  if (liveTailStarted) return;
  liveTailStarted = true;
  const loop = async () => {
    console.log("Live launch watch is checking new launches every few seconds");
    while (getSettings().live === "1") {
      try {
        await inLiveLane(() => liveTailOnce());
      } catch (error) {
        console.error("live tail", error.message);
      }
      await sleep(LIVE_TAIL_MS);
    }
    liveTailStarted = false;
  };
  loop();
}

export function autoScanTick() {
  if (job.running) return;
  const settings = getSettings();
  if (settings.live === "1") {
    const ids = listCompetitors()
      .filter((competitor) => competitor.enabled)
      .map((competitor) => competitor.id);
    if (ids.length) enqueueScan(ids, { fromStart: false });
    return;
  }
  if (settings.autoScan !== "1") return;
  const interval = Math.max(1, Number(settings.scanIntervalMin) || 5) * 60;
  const now = Math.floor(Date.now() / 1000);
  const due = listCompetitors().filter((competitor) => {
    if (!competitor.enabled) return false;
    if (!competitor.last_scan_at) return true;
    return now - competitor.last_scan_at >= interval;
  });
  if (due.length) enqueueScan(due.map((competitor) => competitor.id));
}
