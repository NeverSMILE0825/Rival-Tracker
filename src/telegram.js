import { getSettings, listFundingsForDeployer, listTelegramChats, removeTelegramChat, saveSettings, saveTelegramChat } from "./db.js";
import { lookupLaunchMarket } from "./market.js";
import { renderAlertCard } from "./card.js";
import { formatKst, sleep, timezoneLabel } from "./util.js";

const CLOCK_SKEW_SEC = 120;

export async function notifyLaunch(launch) {
  try {
    const settings = getSettings();
    if (settings.telegramAlerts !== "1") return;
    const since = Number(settings.telegramSince) || 0;
    const launchedAt = Number(launch.launchedAt) || 0;
    if (!since || launchedAt + CLOCK_SKEW_SEC < since) return;
    const marketPromise = lookupLaunchMarket(launch.address);
    const market = await Promise.race([marketPromise, sleep(1200).then(() => null)]).catch(() => null);
    const links = tokenLinks(launch.address, launch.deployer, market);
    const when = launchedAt || market?.pairCreatedAt || 0;
    const text = caption({
      emoji: "🚀",
      title: "NEW LAUNCH",
      symbol: launch.symbol,
      name: launch.name,
      market,
      age: ageLabel(when),
      rank: market?.rank,
      rival: launch.rival || "unknown",
      address: launch.address,
      links,
    });
    const photoBuffer = await cardImage({
      symbol: launch.symbol,
      name: launch.name,
      bannerUrl: market?.imageUrl || "",
      logoUrl: market?.logoUrl || logoUrl(launch.address),
      marketCap: market?.marketCap,
      liquidityUsd: market?.liquidityUsd,
      volume24h: market?.volume24h,
      priceChange24h: market?.priceChange24h,
      ageLabel: ageLabel(when),
      createdLabel: stamp(when, settings),
      rank: market?.rank,
    });
    await sendTelegram(text, { photo: market?.imageUrl || "", photoBuffer, buttons: linkButtons(links) });
  } catch (error) {
    console.error("telegram", error.message);
  }
}

export async function notifyPaid(payment) {
  const settings = getSettings();
  if (settings.telegramAlerts !== "1") return false;
  const fundings = listFundingsForDeployer(payment.deployer);
  const rival = fundings[0]?.label || "unknown";
  const links = tokenLinks(payment.token_address, payment.deployer, {
    pairAddress: payment.pair_address,
    dextoolsUrl: payment.dextools_url,
    dexscreenerUrl: payment.dexscreener_url,
  });
  const kind = paidKind(payment);
  const when = Number(payment.pair_created_at) || Number(payment.created_at) || Number(payment.paid_at) || 0;
  const text = caption({
    emoji: kind.emoji,
    title: kind.title,
    detail: payment.detail,
    symbol: payment.symbol,
    name: payment.name,
    market: payment,
    age: ageLabel(when),
    rank: payment.rank,
    rival,
    address: payment.token_address,
    links,
  });
  const photoBuffer = await cardImage({
    symbol: payment.symbol,
    name: payment.name,
    bannerUrl: payment.banner_url || "",
    logoUrl: logoUrl(payment.token_address),
    marketCap: payment.market_cap,
    liquidityUsd: payment.liquidity_usd,
    volume24h: payment.volume_24h,
    priceChange24h: payment.price_change_24h,
    ageLabel: ageLabel(when),
    createdLabel: stamp(when, settings),
    rank: payment.rank,
  });
  await sendTelegram(text, { photo: payment.banner_url || "", photoBuffer, buttons: linkButtons(links) });
  return true;
}

export async function sendTelegram(text, override = {}) {
  const settings = getSettings();
  const token = String(override.token || settings.telegramBotToken || "").trim();
  const explicit = String(override.chatId || "").trim();
  const chatIds = explicit ? [explicit] : destinationChats(settings);
  if (!token || !chatIds.length) throw new Error("Add a bot token and a chat id first.");
  const buttons = override.buttons || sampleButtons();
  const captionText = String(text || "").slice(0, 1000);
  let sent = 0;
  let lastError = null;
  for (const chatId of chatIds) {
    try {
      await deliverTelegram(token, chatId, captionText, { ...override, buttons });
      sent += 1;
    } catch (error) {
      lastError = error;
      if (/blocked|deactivated|chat not found/i.test(error.message)) removeTelegramChat(chatId);
      console.error("telegram", error.message);
    }
  }
  if (!sent) throw lastError || new Error("Could not reach Telegram.");
}

function destinationChats(settings) {
  const ids = new Set();
  if (settings.telegramChatId) ids.add(String(settings.telegramChatId));
  for (const chat of listTelegramChats()) ids.add(String(chat.chat_id));
  return [...ids];
}

async function deliverTelegram(token, chatId, captionText, override) {
  const buttons = override.buttons || sampleButtons();
  if (override.photoBuffer) {
    try {
      await postTelegramPhoto(token, chatId, override.photoBuffer, captionText, buttons);
      return;
    } catch (error) {
      console.error("telegram card", error.message);
    }
  }
  const photo = String(override.photo || "").trim();
  if (photo) {
    try {
      await postTelegram(token, "sendPhoto", {
        chat_id: chatId,
        photo,
        caption: captionText,
        parse_mode: "HTML",
        reply_markup: buttons,
      });
      return;
    } catch (error) {
      console.error("telegram photo", error.message);
    }
  }
  await postTelegram(token, "sendMessage", {
    chat_id: chatId,
    text: captionText,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: buttons,
  });
}

let inboxStarted = false;

export function startTelegramInbox() {
  if (inboxStarted) return;
  inboxStarted = true;
  console.log("Telegram is watching for teammates who press Start");
  const loop = async () => {
    while (true) {
      try {
        await readTelegramStarts();
      } catch (error) {
        console.error("telegram inbox", error.message);
        await sleep(5000);
      }
    }
  };
  loop();
}

async function readTelegramStarts() {
  const settings = getSettings();
  const token = String(settings.telegramBotToken || "").trim();
  if (!token) {
    await sleep(5000);
    return;
  }
  const offset = Number(settings.telegramUpdateOffset) || 0;
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        offset: offset || undefined,
        timeout: 20,
        allowed_updates: ["message"],
      }),
      signal: AbortSignal.timeout(25000),
    });
  } catch {
    await sleep(3000);
    return;
  }
  const data = await response.json().catch(() => ({}));
  if (!data.ok) {
    console.error("telegram inbox", data.description || response.status);
    await sleep(5000);
    return;
  }
  let next = offset;
  for (const update of data.result || []) {
    next = update.update_id + 1;
    const message = update.message;
    const text = String(message?.text || "");
    if (!message?.chat?.id || !text.startsWith("/start")) continue;
    const name = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ");
    saveTelegramChat({
      chatId: message.chat.id,
      name,
      username: message.from?.username || "",
    });
    console.log("Telegram subscriber added");
    await postTelegram(token, "sendMessage", {
      chat_id: message.chat.id,
      text: "You're on the Rival Tracker list. New launches and paid alerts will show up in this chat.",
    }).catch((error) => console.error("telegram welcome", error.message));
  }
  if (next !== offset) saveSettings({ telegramUpdateOffset: String(next) });
}

async function cardImage(card) {
  try {
    return await Promise.race([renderAlertCard(card), sleep(8000).then(() => null)]);
  } catch (error) {
    console.error("alert card", error.message);
    return null;
  }
}

function caption(info) {
  const symbol = info.symbol || "TOKEN";
  const name = String(info.name || "").trim();
  const head = [
    `${info.emoji} <b>${esc(info.title)}</b>`,
    info.detail ? esc(info.detail) : "",
    `$${bold(symbol)}${name ? ` — ${esc(name)}` : ""}`,
  ].filter(Boolean).join(" · ");
  const cap = money(info.market?.marketCap ?? info.market?.market_cap);
  const liq = money(info.market?.liquidityUsd ?? info.market?.liquidity_usd);
  const move = signedChange(info.market?.priceChange24h ?? info.market?.price_change_24h);
  const rank = Number(info.rank) > 0 ? `🔥 #${Number(info.rank)}` : "";
  const lines = [
    head,
    `MC ${cap} · Liq ${liq}${info.age ? ` · 🕐 ${esc(info.age)}` : ""}`,
    [move ? `24h: ${move}` : "", rank].filter(Boolean).join(" · "),
    info.rival ? `👤 ${esc(info.rival)}` : "",
    info.address ? `<code>${esc(info.address)}</code>` : "",
    linkLine(info.links),
  ];
  return lines.filter(Boolean).join("\n");
}

function paidKind(payment) {
  if (payment.source === "dextools" && payment.kind === "nitro") return { emoji: "⚡", title: "NITRO" };
  if (payment.source === "dextools") return { emoji: "🟣", title: "DEXTOOLS" };
  if (payment.kind === "boost") return { emoji: "🟢", title: "BOOST" };
  return { emoji: "🟢", title: "DEX PAID" };
}

function logoUrl(address) {
  const token = String(address || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(token)) return "";
  return `https://dd.dexscreener.com/ds-data/tokens/ethereum/${token}.png?size=lg`;
}

function sampleButtons() {
  return linkButtons({
    dexscreener: "https://dexscreener.com/ethereum",
    dextools: "https://www.dextools.io/app/en/ether/pairs",
  });
}

function tokenLinks(address, creator, market = {}) {
  market = market || {};
  const token = String(address || "").toLowerCase();
  const pair = String(market.pairAddress || "");
  const dextools = market.dextoolsUrl
    || (pair ? `https://www.dextools.io/app/ether/pair-explorer/${pair}` : `https://www.dextools.io/app/ether/token/${token}`);
  return {
    dexscreener: market.dexscreenerUrl || `https://dexscreener.com/ethereum/${token}`,
    dextools,
    etherscan: token ? `https://etherscan.io/token/${token}` : "",
    creator: creator ? `https://etherscan.io/address/${creator}` : "",
    website: market.website || "",
    twitter: market.twitter || "",
  };
}

function linkButtons(links) {
  const items = [
    ["DexScreener", links.dexscreener],
    ["Dextools", links.dextools],
    ["Etherscan", links.etherscan],
    ["Creator", links.creator],
    ["Website", links.website],
    ["X", links.twitter],
  ].filter(([, url]) => /^https?:\/\//i.test(String(url || "")));
  const rows = [];
  for (let index = 0; index < items.length; index += 2) {
    rows.push(items.slice(index, index + 2).map(([text, url]) => ({ text, url })));
  }
  return { inline_keyboard: rows };
}

function linkLine(links) {
  if (!links) return "";
  const parts = [
    ["DexScreener", links.dexscreener],
    ["Dextools", links.dextools],
    ["Etherscan", links.etherscan],
    ["Website", links.website],
    ["X", links.twitter],
  ]
    .filter(([, url]) => /^https?:\/\//i.test(String(url || "")))
    .map(([label, url]) => `<a href="${esc(url)}">${label}</a>`);
  return parts.join(" · ");
}

function stamp(unix, settings) {
  if (!unix) return "";
  return `${formatKst(unix, settings.timezoneOffset)} ${timezoneLabel(settings.timezoneOffset)}`;
}

function ageLabel(unix) {
  const at = Number(unix);
  if (!at) return "";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - at);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days >= 365) return `${Math.floor(days / 365)}y`;
  if (days >= 1) return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
  if (hours >= 1) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  if (minutes >= 1) return `${minutes}m`;
  return `${Math.max(1, seconds)}s`;
}

function bold(value) {
  return `<b>${esc(value)}</b>`;
}

function money(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "—";
  if (number >= 1e9) return `$${trimNumber(number / 1e9)}B`;
  if (number >= 1e6) return `$${trimNumber(number / 1e6)}M`;
  if (number >= 1e3) return `$${trimNumber(number / 1e3)}K`;
  if (number >= 1) return `$${number.toFixed(2)}`;
  return `$${number.toPrecision(2)}`;
}

function trimNumber(value) {
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function signedChange(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  const sign = number > 0 ? "+" : "";
  const text = Math.abs(number) >= 1000 ? `${sign}${(number / 1000).toFixed(1)}k%` : `${sign}${number.toFixed(2)}%`;
  return esc(text);
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  })[char]);
}

async function postTelegramPhoto(token, chatId, png, captionText, buttons) {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", captionText);
  form.append("parse_mode", "HTML");
  form.append("reply_markup", JSON.stringify(buttons));
  form.append("photo", new Blob([png], { type: "image/jpeg" }), "alert.jpg");
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Error("Could not reach Telegram.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.description || `Telegram rejected the photo (${response.status})`);
  }
}

async function postTelegram(token, method, body) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error("Could not reach Telegram.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.description || `Telegram rejected the message (${response.status})`);
  }
}
