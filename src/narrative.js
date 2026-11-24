import {
  clearNarrativeAlert,
  getSettings,
  listLivePairsSince,
  markNarrativeAlert,
  narrativeAlertLevels,
} from "./db.js";
import { sendTelegram } from "./telegram.js";
import { nowSec } from "./util.js";

const STOP = new Set([
  "the", "and", "for", "with", "from", "this", "that", "coin", "token", "inu", "erc", "erc20",
  "eth", "weth", "ethereum", "official", "real", "ceo", "nft", "meme", "club", "finance", "dao",
  "labs", "protocol", "swap", "chain", "network", "crypto", "defi", "web3", "sol", "solana",
  "base", "bsc", "usd", "usdt", "usdc", "dai",
]);

const LEVELS = [
  { id: "rising", setting: "trendRising", fallback: 3 },
  { id: "trending", setting: "trendTrending", fallback: 5 },
  { id: "exploding", setting: "trendExploding", fallback: 7 },
  { id: "market", setting: "trendMarket", fallback: 10 },
];

function whole(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) return fallback;
  return number;
}

export function trendConfig(settings = getSettings()) {
  return {
    enabled: settings.trendAlerts === "1",
    minutes: whole(settings.trendWindowMin, 60, 5, 1440),
    levels: LEVELS.map((level) => ({
      id: level.id,
      count: whole(settings[level.setting], level.fallback, 2, 500),
    })),
  };
}

function words(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/\$/g, " ")
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

function stem(word) {
  const stripped = word.replace(/\d+$/g, "");
  return stripped.length >= 3 ? stripped : word;
}

export function narrativeKeys(name, symbol) {
  const keys = new Set();
  const ticker = words(symbol).join("");
  if (ticker.length >= 2 && !STOP.has(ticker.toLowerCase())) keys.add(ticker);
  for (const word of [...words(name), ...words(symbol)]) {
    const key = stem(word);
    if (key.length >= 3 && !STOP.has(key.toLowerCase())) keys.add(key);
  }
  return [...keys];
}

function windowPhrase(minutes) {
  if (minutes === 60) return "the last hour";
  if (minutes % 60 === 0) return `the last ${minutes / 60} hours`;
  return `the last ${minutes} minutes`;
}

function symbolLine(symbols) {
  const unique = [];
  for (const symbol of symbols) {
    const shown = `$${String(symbol || "").replace(/^\$+/, "").trim()}`;
    if (shown.length < 2 || unique.includes(shown)) continue;
    unique.push(shown);
    if (unique.length === 6) break;
  }
  return unique.length ? `🪙 ${unique.join(" · ")}` : "";
}

export function trendText({ level, label, count, minutes, symbols = [], sample = false }) {
  const span = windowPhrase(minutes);
  const coins = symbolLine(symbols);
  const sampleLine = sample ? "ℹ️ <b>SAMPLE</b>\n" : "";
  const tail = coins ? `\n${coins}` : "";
  if (level === "rising") {
    return [
      `${sampleLine}📈 <b>${label} is rising..</b>`,
      "",
      "🌱 This name is at the start of a trend.",
      `👀 ${count} tokens in ${span} share ${label}.${tail}`,
    ].join("\n");
  }
  if (level === "trending") {
    return [
      `${sampleLine}🔥 <b>${label} is trending now..</b>`,
      "",
      "📊 This name has become a live trend.",
      `👀 ${count} tokens in ${span} share ${label}.${tail}`,
    ].join("\n");
  }
  if (level === "exploding") {
    return [
      `${sampleLine}💥 <b>${label} is exploding now..</b>`,
      "",
      "🚀 The name is running. Attention is piling in.",
      `👀 ${count} tokens in ${span} share ${label}.${tail}`,
    ].join("\n");
  }
  return [
    `${sampleLine}🌐🚨 <b>ALL MARKETS ARE ON ${label}</b>`,
    "",
    "📢 The whole board is printing this one name.",
    `👀 ${count} tokens in ${span} carry ${label}.`,
    `🌊 There is no second story. The market is ${label}.${tail}`,
  ].join("\n");
}

function labelFor(key) {
  return `${key}/$${key}`;
}

function collect(token) {
  const settings = getSettings();
  const config = trendConfig(settings);
  if (!config.enabled) return [];
  const createdAt = Number(token.createdAt) || 0;
  const since = nowSec() - config.minutes * 60;
  if (!createdAt || createdAt < since) return [];
  const keys = narrativeKeys(token.name, token.symbol);
  if (!keys.length) return [];
  const recent = listLivePairsSince(since);
  const pending = [];
  for (const key of keys) {
    const matches = recent.filter((row) => narrativeKeys(row.name, row.symbol).includes(key));
    const count = matches.length;
    const sent = narrativeAlertLevels(key);
    for (const level of config.levels) {
      if (count < level.count && sent.has(level.id)) clearNarrativeAlert(key, level.id);
    }
    const open = narrativeAlertLevels(key);
    for (const level of config.levels) {
      if (count < level.count || open.has(level.id)) continue;
      markNarrativeAlert(key, level.id);
      pending.push({
        level: level.id,
        label: labelFor(key),
        count,
        minutes: config.minutes,
        symbols: matches.map((row) => row.symbol),
      });
    }
  }
  return pending;
}

async function deliver(pending) {
  for (const item of pending) {
    await sendTelegram(trendText(item), { buttons: { inline_keyboard: [] } });
  }
}

export function watchNarrative(token) {
  try {
    const pending = collect(token);
    if (!pending.length) return;
    deliver(pending).catch((error) => console.error("narrative", error.message));
  } catch (error) {
    console.error("narrative", error.message);
  }
}

export async function sendTrendSamples() {
  const config = trendConfig();
  const samples = [
    { level: "rising", count: config.levels[0].count, symbols: ["JIMMY"] },
    { level: "trending", count: config.levels[1].count, symbols: ["JIMMY"] },
    { level: "exploding", count: config.levels[2].count, symbols: ["JIMMY"] },
    { level: "market", count: config.levels[3].count, symbols: ["JIMMY", "JIMMY", "JIMMYINU"] },
  ];
  for (const sample of samples) {
    await sendTelegram(
      trendText({
        ...sample,
        label: "JIMMY/$JIMMY",
        minutes: config.minutes,
        sample: true,
      }),
      { buttons: { inline_keyboard: [] } },
    );
  }
}
