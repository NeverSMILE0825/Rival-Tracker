import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBuyer,
  createCompetitor,
  deleteBuyer,
  deleteCompetitor,
  deployerDetail,
  getBuyer,
  getCompetitor,
  getSettings,
  listCompetitors,
  listTokenAddresses,
  markEventsSeen,
  requeueIgnored,
  saveSettings,
  snapshot,
  updateBuyer,
  updateCompetitor,
} from "./db.js";
import { refreshMarkets, startLiveMarkets } from "./market.js";
import { startBuyerWatch } from "./buyers.js";
import { startFastWatch } from "./fast.js";
import { startAthWatch } from "./gmgn.js";
import { startPaidWatch } from "./paid.js";
import { startProfitWatch } from "./profit.js";
import { autoScanTick, cachedScanRange, decorateScan, enqueueScan, getJob, refreshOne, startLiveTail, stopScan, warmScanRange } from "./scanner.js";
import { headBlock } from "./chain.js";
import { repairTokenLaunches } from "./relate.js";
import { sendTrendSamples } from "./narrative.js";
import { startTrendWatch, trendBoard } from "./trends.js";
import { sendBuyerTest, sendTelegram, startBuyerInbox, startTelegramInbox } from "./telegram.js";
import { realBuyerProgress, realBuyerTrades } from "./realbuyers.js";
import { ethToWei, normalizeAddress, nowSec, parseApiKeys, zonedUnix } from "./util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(express.static(path.join(__dirname, "..", "public")));

function publicSnapshot() {
  const data = snapshot();
  const scan = getJob();
  decorateScan(data.competitors, cachedScanRange(), scan);
  return { ...data, scan };
}

app.get("/api/snapshot", (_req, res) => {
  res.json(publicSnapshot());
});

app.get("/api/tokens/:address/real-buyers/progress", (req, res) => {
  const address = normalizeAddress(req.params.address);
  if (!address) return res.status(400).json({ error: "Enter a valid token address." });
  res.json(realBuyerProgress(address));
});

app.get("/api/tokens/:address/real-buyers", async (req, res) => {
  const address = normalizeAddress(req.params.address);
  if (!address) return res.status(400).json({ error: "Enter a valid token address." });
  try {
    const trades = await realBuyerTrades(address);
    if (!trades) return res.status(404).json({ error: "That token is not in the tracker yet." });
    res.json(trades);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/head", async (_req, res) => {
  try {
    res.json({ block: await headBlock() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/deployers/:address", (req, res) => {
  const address = normalizeAddress(req.params.address);
  if (!address) return res.status(400).json({ error: "Enter a valid wallet address." });
  const detail = deployerDetail(address);
  if (!detail) return res.status(404).json({ error: "That wallet is not in the tracker yet." });
  res.json(detail);
});

app.post("/api/competitors", (req, res) => {
  const address = normalizeAddress(req.body.address);
  const label = String(req.body.label || "").trim();
  if (!address) return res.status(400).json({ error: "Enter a valid Ethereum address." });
  if (!label) return res.status(400).json({ error: "Give this rival a name." });
  try {
    const competitor = createCompetitor({
      address,
      label,
      notes: String(req.body.notes || "").trim(),
      color: String(req.body.color || "#d6f25c"),
    });
    res.status(201).json(competitor);
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "That address is already in the list." });
    }
    res.status(500).json({ error: error.message });
  }
});

app.patch("/api/competitors/:id", (req, res) => {
  const id = Number(req.params.id);
  const current = getCompetitor(id);
  if (!current) return res.status(404).json({ error: "Rival not found." });
  const fields = {};
  if (req.body.address != null) {
    const address = normalizeAddress(req.body.address);
    if (!address) return res.status(400).json({ error: "Enter a valid Ethereum address." });
    fields.address = address;
  }
  if (req.body.label != null) {
    const label = String(req.body.label).trim();
    if (!label) return res.status(400).json({ error: "Give this rival a name." });
    fields.label = label;
  }
  if (req.body.notes != null) fields.notes = String(req.body.notes);
  if (req.body.color != null) fields.color = String(req.body.color);
  if (req.body.enabled != null) fields.enabled = req.body.enabled ? 1 : 0;
  try {
    res.json(updateCompetitor(id, fields));
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "That address is already in the list." });
    }
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/buyers", (req, res) => {
  const address = normalizeAddress(req.body.address);
  const label = String(req.body.label || "").trim();
  if (!address) return res.status(400).json({ error: "Enter a valid Ethereum address." });
  try {
    res.status(201).json(createBuyer({ address, label }));
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "That address is already in the buyer list." });
    }
    res.status(500).json({ error: error.message });
  }
});

app.patch("/api/buyers/:id", (req, res) => {
  const id = Number(req.params.id);
  const current = getBuyer(id);
  if (!current) return res.status(404).json({ error: "Buyer not found." });
  const fields = {};
  if (req.body.address != null) {
    const address = normalizeAddress(req.body.address);
    if (!address) return res.status(400).json({ error: "Enter a valid Ethereum address." });
    fields.address = address;
  }
  if (req.body.label != null) fields.label = String(req.body.label).trim();
  try {
    res.json(updateBuyer(id, fields));
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "That address is already in the buyer list." });
    }
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/buyers/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!getBuyer(id)) return res.status(404).json({ error: "Buyer not found." });
  deleteBuyer(id);
  res.json({ ok: true });
});

app.delete("/api/competitors/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!getCompetitor(id)) return res.status(404).json({ error: "Rival not found." });
  deleteCompetitor(id);
  res.json({ ok: true });
});

app.post("/api/scan", (req, res) => {
  const body = req.body || {};
  let ids = [];
  if (body.id) ids = [Number(body.id)];
  else ids = listCompetitors().filter((competitor) => competitor.enabled).map((competitor) => competitor.id);
  if (!ids.length) return res.status(400).json({ error: "Add an enabled rival before scanning." });
  res.json(enqueueScan(ids, { rewind: Boolean(body.rewind), purge: Boolean(body.purge), fromStart: body.fromStart !== false }));
});

app.post("/api/scan/stop", (_req, res) => {
  if (getSettings().live === "1") saveSettings({ live: "0" });
  stopScan();
  res.json(getJob());
});

app.post("/api/fast", (req, res) => {
  const on = Boolean(req.body?.on);
  const current = getSettings();
  const next = { fastMode: on ? "1" : "0" };
  if (on && current.fastMode !== "1") next.fastSince = String(nowSec());
  saveSettings(next);
  res.json({ fastMode: on });
});

app.post("/api/live", (req, res) => {
  const on = Boolean(req.body?.on);
  saveSettings({ live: on ? "1" : "0" });
  if (on) {
    const ids = listCompetitors()
      .filter((competitor) => competitor.enabled)
      .map((competitor) => competitor.id);
    if (!ids.length) return res.status(400).json({ error: "Add an enabled rival before turning Live on." });
    enqueueScan(ids, { fromStart: false });
    startLiveMarkets();
    startLiveTail();
  } else {
    stopScan();
  }
  res.json({ live: on });
});

app.post("/api/markets/refresh", async (_req, res) => {
  try {
    const updated = await refreshMarkets(listTokenAddresses());
    res.json({ updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/deployers/:address/refresh", async (req, res) => {
  const address = normalizeAddress(req.params.address);
  if (!address) return res.status(400).json({ error: "Enter a valid wallet address." });
  try {
    await refreshOne(address);
    res.json(deployerDetail(address));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/events/read", (_req, res) => {
  markEventsSeen();
  res.json({ ok: true });
});

app.post("/api/recheck-hidden", (_req, res) => {
  res.json({ updated: requeueIgnored() });
});

app.put("/api/settings", (req, res) => {
  const body = req.body || {};
  const next = {};
  if (body.minFundingEth != null) {
    try {
      ethToWei(body.minFundingEth);
    } catch {
      return res.status(400).json({ error: "Minimum funding must look like 0.03" });
    }
    next.minFundingEth = String(body.minFundingEth);
  }
  if (body.maxFundingEth != null) {
    try {
      ethToWei(body.maxFundingEth);
    } catch {
      return res.status(400).json({ error: "Maximum funding must look like 5" });
    }
    next.maxFundingEth = String(body.maxFundingEth);
  }
  if (body.dustEth != null) {
    try {
      ethToWei(body.dustEth);
    } catch {
      return res.status(400).json({ error: "Dust amount must look like 0.005" });
    }
    next.dustEth = String(body.dustEth);
  }
  if (body.lookbackDays != null) {
    const days = Number(body.lookbackDays);
    if (!Number.isFinite(days) || days < 1 || days > 3650) {
      return res.status(400).json({ error: "Lookback must be between 1 and 3650 days." });
    }
    next.lookbackDays = String(Math.floor(days));
  }
  if (body.timezoneOffset != null && body.timezoneOffset !== "") {
    const offset = Number(body.timezoneOffset);
    if (!Number.isInteger(offset) || offset < -12 || offset > 14) {
      return res.status(400).json({ error: "Timezone must be a whole number of hours from -12 to 14. 9 means UTC+9." });
    }
    next.timezoneOffset = String(offset);
  }
  if (body.scanRangeMode != null || body.scanStartDate != null || body.scanEndDate != null || body.scanStartBlock != null || body.scanEndBlock != null || body.scanStartHour != null || body.scanEndHour != null) {
    const mode = body.scanRangeMode === "block" ? "block" : "date";
    next.scanRangeMode = mode;
    if (mode === "date") {
      const offset = next.timezoneOffset ?? body.timezoneOffset ?? 9;
      const startUnix = zonedUnix(body.scanStartDate, body.scanStartHour, body.scanStartMinute, body.scanStartSecond, offset);
      const endUnix = zonedUnix(body.scanEndDate, body.scanEndHour, body.scanEndMinute, body.scanEndSecond, offset);
      if (startUnix == null || endUnix == null || endUnix < startUnix) {
        return res.status(400).json({ error: "Set a start and an end. The end must be at or after the start. Hours are 0–23, and minutes and seconds are 0–59." });
      }
      next.scanStartDate = String(body.scanStartDate);
      next.scanStartHour = String(Number(body.scanStartHour));
      next.scanStartMinute = String(Number(body.scanStartMinute));
      next.scanStartSecond = String(Number(body.scanStartSecond));
      next.scanEndDate = String(body.scanEndDate);
      next.scanEndHour = String(Number(body.scanEndHour));
      next.scanEndMinute = String(Number(body.scanEndMinute));
      next.scanEndSecond = String(Number(body.scanEndSecond));
    } else {
      const start = Number(body.scanStartBlock);
      const end = Number(body.scanEndBlock);
      if (!Number.isInteger(start) || start < 1 || !Number.isInteger(end) || end < start || end > 500000000) {
        return res.status(400).json({ error: "Set a start block and an end block, with the end on or after the start." });
      }
      next.scanStartBlock = String(start);
      next.scanEndBlock = String(end);
    }
    if (body.scanEndDate && /^\d{4}-\d{2}-\d{2}$/.test(String(body.scanEndDate))) next.scanEndDate = String(body.scanEndDate);
    if (body.scanStartBlock && Number.isInteger(Number(body.scanStartBlock))) next.scanStartBlock = String(Number(body.scanStartBlock));
    if (body.scanEndBlock && Number.isInteger(Number(body.scanEndBlock))) next.scanEndBlock = String(Number(body.scanEndBlock));
  }
  if (body.rugLiquidityUsd != null) {
    const value = Number(body.rugLiquidityUsd);
    if (!Number.isFinite(value) || value < 0) return res.status(400).json({ error: "Enter a liquidity floor in USD." });
    next.rugLiquidityUsd = String(value);
  }
  if (body.scanIntervalMin != null) {
    const value = Number(body.scanIntervalMin);
    if (!Number.isFinite(value) || value < 1 || value > 1440) {
      return res.status(400).json({ error: "Scan interval must be between 1 and 1440 minutes." });
    }
    next.scanIntervalMin = String(Math.floor(value));
  }
  if (body.maxPages != null) {
    const value = Number(body.maxPages);
    if (!Number.isFinite(value) || value < 5 || value > 500) {
      return res.status(400).json({ error: "Page budget must be between 5 and 500." });
    }
    next.maxPages = String(Math.floor(value));
  }
  if (body.autoScan != null) next.autoScan = body.autoScan ? "1" : "0";
  if (body.fastMode != null) {
    next.fastMode = body.fastMode ? "1" : "0";
    if (next.fastMode === "1" && getSettings().fastMode !== "1") next.fastSince = String(nowSec());
  }
  if (body.requireFirstFunder != null) next.requireFirstFunder = body.requireFirstFunder ? "1" : "0";
  if (body.telegramChatId != null) {
    const chat = String(body.telegramChatId).trim();
    if (chat && !/^-?\d{1,20}$/.test(chat)) {
      return res.status(400).json({ error: "Chat id must be the number from your Telegram chat." });
    }
    next.telegramChatId = chat;
  }
  if (body.clearTelegramToken) next.telegramBotToken = "";
  else if (typeof body.telegramBotToken === "string" && body.telegramBotToken.trim()) {
    const token = body.telegramBotToken.trim();
    if (!/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(token)) {
      return res.status(400).json({ error: "That does not look like a bot token from @BotFather." });
    }
    next.telegramBotToken = token;
  }
  if (body.telegramAlerts != null) next.telegramAlerts = body.telegramAlerts ? "1" : "0";
  if (next.telegramAlerts === "1") {
    const current = getSettings();
    const token = next.telegramBotToken ?? current.telegramBotToken;
    const chat = next.telegramChatId ?? current.telegramChatId;
    if (!token || !chat) {
      return res.status(400).json({ error: "Add a bot token and a chat id before turning alerts on." });
    }
    if (current.telegramAlerts !== "1") next.telegramSince = String(nowSec());
  }
  if (body.buyerChatId != null) {
    const chat = String(body.buyerChatId).trim();
    if (chat && !/^-?\d{1,20}$/.test(chat)) {
      return res.status(400).json({ error: "Buyer Tracker chat id must be the number from your Telegram chat." });
    }
    next.buyerChatId = chat;
  }
  if (body.clearBuyerToken) next.buyerBotToken = "";
  else if (typeof body.buyerBotToken === "string" && body.buyerBotToken.trim()) {
    const token = body.buyerBotToken.trim();
    if (!/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(token)) {
      return res.status(400).json({ error: "That does not look like a Buyer Tracker token from @BotFather." });
    }
    next.buyerBotToken = token;
  }
  if (body.buyerAlerts != null) next.buyerAlerts = body.buyerAlerts ? "1" : "0";
  if (body.trendAlerts != null) next.trendAlerts = body.trendAlerts ? "1" : "0";
  if (body.trendWindowMin != null || body.trendRising != null || body.trendTrending != null || body.trendExploding != null || body.trendMarket != null) {
    const current = getSettings();
    const windowMin = Number(body.trendWindowMin ?? current.trendWindowMin ?? 60);
    const rising = Number(body.trendRising ?? current.trendRising ?? 3);
    const trending = Number(body.trendTrending ?? current.trendTrending ?? 5);
    const exploding = Number(body.trendExploding ?? current.trendExploding ?? 7);
    const market = Number(body.trendMarket ?? current.trendMarket ?? 10);
    const counts = [rising, trending, exploding, market];
    if (!Number.isInteger(windowMin) || windowMin < 5 || windowMin > 1440) {
      return res.status(400).json({ error: "Trend window must be a whole number of minutes from 5 to 1440." });
    }
    if (counts.some((count) => !Number.isInteger(count) || count < 2 || count > 500)) {
      return res.status(400).json({ error: "Trend counts must be whole numbers from 2 to 500." });
    }
    if (!(rising < trending && trending < exploding && exploding < market)) {
      return res.status(400).json({ error: "Each trend count must be higher than the one before it." });
    }
    next.trendWindowMin = String(windowMin);
    next.trendRising = String(rising);
    next.trendTrending = String(trending);
    next.trendExploding = String(exploding);
    next.trendMarket = String(market);
  }
  if (next.buyerAlerts === "1") {
    const current = getSettings();
    const token = next.buyerBotToken ?? current.buyerBotToken;
    const chat = next.buyerChatId ?? current.buyerChatId;
    if (!token || !chat) {
      return res.status(400).json({ error: "Add a Buyer Tracker token and a chat id before turning buyer alerts on." });
    }
  }
  if (body.clearEtherscanKey) next.etherscanApiKey = "";
  else if (typeof body.etherscanApiKey === "string" && body.etherscanApiKey.trim()) {
    const keys = parseApiKeys(body.etherscanApiKey);
    if (!keys.length) {
      return res.status(400).json({ error: "No API keys found. Put one key on each line." });
    }
    if (keys.length > 100) return res.status(400).json({ error: "Save 100 keys or fewer." });
    next.etherscanApiKey = keys.join("\n");
  }
  const saved = saveSettings(next);
  saved.telegramBotToken = "";
  saved.buyerBotToken = "";
  saved.etherscanApiKey = "";
  res.json(saved);
});

app.get("/api/trends", (req, res) => {
  res.json(trendBoard(String(req.query.window || "1h")));
});

app.post("/api/telegram/trend-samples", async (_req, res) => {
  try {
    await sendTrendSamples();
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/telegram/buyer-test", async (req, res) => {
  const body = req.body || {};
  const token = typeof body.buyerBotToken === "string" ? body.buyerBotToken.trim() : "";
  const chatId = typeof body.buyerChatId === "string" ? body.buyerChatId.trim() : "";
  if (token && !/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(token)) {
    return res.status(400).json({ error: "That does not look like a Buyer Tracker token from @BotFather." });
  }
  if (chatId && !/^-?\d{1,20}$/.test(chatId)) {
    return res.status(400).json({ error: "Buyer Tracker chat id must be the number from your Telegram chat." });
  }
  try {
    await sendBuyerTest({ token, chatId });
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/telegram/test", async (req, res) => {
  const body = req.body || {};
  const token = typeof body.telegramBotToken === "string" ? body.telegramBotToken.trim() : "";
  const chatId = typeof body.telegramChatId === "string" ? body.telegramChatId.trim() : "";
  if (token && !/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(token)) {
    return res.status(400).json({ error: "That does not look like a bot token from @BotFather." });
  }
  if (chatId && !/^-?\d{1,20}$/.test(chatId)) {
    return res.status(400).json({ error: "Chat id must be the number from your Telegram chat." });
  }
  try {
    await sendTelegram(
      [
        "🚀 <b>NEW LAUNCH</b> · $<b>SYMBOL</b> — Token name",
        "MC $63K · Liq $17.2K · 🕐 42m",
        "24h: +119%",
        "👤 Rival",
        "DexScreener · Dextools · Etherscan",
      ].join("\n"),
      { token, chatId },
    );
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

const port = Number(process.env.PORT) || 4177;
app.listen(port, "127.0.0.1", () => {
  console.log(`Rival Tracker running at http://127.0.0.1:${port}`);
  startPaidWatch();
  startFastWatch();
  startAthWatch();
  startBuyerWatch();
  startProfitWatch();
  startTrendWatch();
  repairTokenLaunches().catch((error) => console.error("launch time", error.message));
  startTelegramInbox();
  startBuyerInbox();
  warmScanRange().catch((error) => console.error("scan range", error.message));
  if (getSettings().live === "1") {
    const ids = listCompetitors()
      .filter((competitor) => competitor.enabled)
      .map((competitor) => competitor.id);
    if (ids.length) enqueueScan(ids, { fromStart: false });
    startLiveMarkets();
    startLiveTail();
  }
});

setInterval(() => {
  try {
    autoScanTick();
  } catch (error) {
    console.error(error);
  }
}, 30000);

setInterval(() => {
  if (getSettings().live === "1") return;
  refreshMarkets().catch((error) => console.error("market", error.message));
}, Math.max(30, Number(getSettings().marketIntervalSec) || 90) * 1000);
