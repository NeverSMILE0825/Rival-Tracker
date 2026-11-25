import {
  buyerTokenPosition,
  getSettings,
  listBuyerChats,
  listCompetitors,
  listFundingsForDeployer,
  listTelegramChats,
  removeBuyerChat,
  removeTelegramChat,
  saveBuyerChat,
  saveSettings,
  saveTelegramChat,
} from "./db.js";
import { lookupLaunchMarket } from "./market.js";
import { renderAlertCard } from "./card.js";
import { formatEth, formatKst, formatSwapAmount, nowSec, sleep } from "./util.js";

const CLOCK_SKEW_SEC = 120;

function within(work, ms) {
  return Promise.race([work, sleep(ms).then(() => null)]);
}

export async function notifyLaunch(launch) {
  try {
    const settings = getSettings();
    if (settings.telegramAlerts !== "1") return;
    const since = Number(settings.telegramSince) || 0;
    const launchedAt = Number(launch.launchedAt) || 0;
    if (settings.fastMode === "1" && !launch.fast) return;
    if (!since || launchedAt + CLOCK_SKEW_SEC < since) return;
    const detectedAt = Number(launch.detectedAt) || nowSec();
    if (launchedAt && detectedAt - launchedAt > 15 * 60) return;
    const market = launch.market || (await within(lookupLaunchMarket(launch.address).catch(() => null), 700));
    const links = tokenLinks(launch.address, launch.deployer, market);
    const when = launchedAt || market?.pairCreatedAt || 0;
    const text = caption({
      emoji: "🚀",
      title: "NEW LAUNCH",
      symbol: launch.symbol,
      name: launch.name,
      market,
      age: ageLabel(when),
      eventAt: when,
      detectedAt,
      rank: market?.rank,
      rival: launch.rival || "unknown",
      address: launch.address,
      links,
    });
    const photoBuffer = await within(
      cardImage({
        symbol: launch.symbol,
        name: launch.name,
        bannerUrl: market?.imageUrl || "",
        logoUrl: market?.logoUrl || logoUrl(launch.address),
        marketCap: market?.marketCap,
        liquidityUsd: market?.liquidityUsd,
        volume24h: market?.volume24h,
        priceChange24h: market?.priceChange24h,
        ageLabel: ageLabel(when),
        createdLabel: eventStamp(when),
        rank: market?.rank,
      }).catch(() => null),
      1200,
    );
    await sendTelegram(text, {
      photo: photoBuffer ? market?.imageUrl || "" : "",
      photoBuffer,
      buttons: linkButtons(links),
    });
  } catch (error) {
    console.error("telegram", error.message);
  }
}

export async function notifyPaid(payment) {
  const settings = getSettings();
  if (settings.telegramAlerts !== "1") return false;
  const fundings = listFundingsForDeployer(payment.deployer);
  const rival = fundings[0]?.label || rivalLabel(payment.deployer);
  let pairAddress = payment.pair_address || "";
  let dextoolsUrl = payment.dextools_url || "";
  let dexscreenerUrl = payment.dexscreener_url || "";
  let looked = null;
  if (!pairAddress) {
    looked = await within(lookupLaunchMarket(payment.token_address).catch(() => null), 700);
    pairAddress = looked?.pairAddress || "";
    dextoolsUrl = looked?.dextoolsUrl || dextoolsUrl;
    dexscreenerUrl = looked?.dexscreenerUrl || dexscreenerUrl;
  }
  const links = tokenLinks(payment.token_address, payment.deployer, {
    pairAddress,
    dextoolsUrl,
    dexscreenerUrl,
    website: looked?.website || "",
    twitter: looked?.twitter || "",
  });
  const kind = paidKind(payment);
  const when = Number(payment.paid_at) || Number(payment.pair_created_at) || Number(payment.created_at) || 0;
  const detectedAt = Number(payment.detected_at) || nowSec();
  const text = caption({
    emoji: kind.emoji,
    title: kind.title,
    detail: payment.detail,
    symbol: payment.symbol,
    name: payment.name,
    market: looked
      ? {
          ...payment,
          marketCap: looked.marketCap ?? payment.market_cap,
          liquidityUsd: looked.liquidityUsd ?? payment.liquidity_usd,
          volume24h: looked.volume24h ?? payment.volume_24h,
          priceChange24h: looked.priceChange24h ?? payment.price_change_24h,
        }
      : payment,
    age: ageLabel(when),
    eventAt: when,
    detectedAt,
    rank: payment.rank,
    rival,
    address: payment.token_address,
    links,
  });
  const photoBuffer = await within(
    cardImage({
      symbol: payment.symbol,
      name: payment.name,
      bannerUrl: looked?.imageUrl || payment.banner_url || "",
      logoUrl: logoUrl(payment.token_address),
      marketCap: looked?.marketCap ?? payment.market_cap,
      liquidityUsd: looked?.liquidityUsd ?? payment.liquidity_usd,
      volume24h: looked?.volume24h ?? payment.volume_24h,
      priceChange24h: looked?.priceChange24h ?? payment.price_change_24h,
      ageLabel: ageLabel(when),
      createdLabel: eventStamp(when),
      rank: payment.rank,
    }).catch(() => null),
    1200,
  );
  const photo = photoBuffer ? looked?.imageUrl || payment.banner_url || "" : "";
  await sendTelegram(text, { photo, photoBuffer, buttons: linkButtons(links) });
  return true;
}

export async function sendTelegram(text, override = {}) {
  const settings = getSettings();
  const token = String(override.token || settings.telegramBotToken || "").trim();
  const explicit = String(override.chatId || "").trim();
  const chatIds = explicit ? [explicit] : destinationChats(settings);
  if (!token || !chatIds.length) throw new Error("Add a bot token and a chat id first.");
  const buttons = override.buttons || sampleButtons();
  const captionText = captionWithinLimit(text);
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

export function notifyBuyerTrades(trades) {
  const job = sendBuyerTrades(trades);
  job.catch((error) => console.error("buyer telegram", error.message));
}

async function sendBuyerTrades(trades) {
  const settings = getSettings();
  if (settings.buyerAlerts !== "1") return;
  const token = String(settings.buyerBotToken || "").trim();
  const chatIds = buyerDestinationChats(settings);
  if (!token || !chatIds.length || !trades?.length) return;
  const zone = buyerZone(settings);
  for (const trade of trades) {
    if (trade.buyerId && trade.tokenAddress) {
      trade.position = buyerTokenPosition(trade.buyerId, trade.tokenAddress, trade.txHash);
    }
    const { text, buttons } = buyerMessage(trade, zone);
    await deliverBuyerMessage(token, chatIds, text, buttons);
  }
}

export async function sendBuyerTest(override = {}) {
  const settings = getSettings();
  const token = String(override.token || settings.buyerBotToken || "").trim();
  const chatIds = buyerDestinationChats(settings, override.chatId);
  if (!token || !chatIds.length) throw new Error("Add a Buyer Tracker token and a chat id first.");
  const zone = buyerZone(settings);
  const when = nowSec() - 8;
  const { text, buttons } = buyerMessage(
    {
      side: "buy",
      tokenSymbol: "SYMBOL",
      tokenName: "Token name",
      buyerLabel: "Wallet label",
      marketCap: 120000,
      amountWei: "4358370533764617",
      amountUsd: 7.45,
      timestamp: when,
      tokenCreatedAt: when - 54 * 60,
      position: { buys: 12, sells: 5, netWei: "277100000000000000" },
      sample: true,
    },
    zone,
  );
  const { sent, lastError } = await deliverBuyerMessage(token, chatIds, text, buttons);
  if (!sent) throw lastError || new Error("Could not reach Telegram.");
}

function afterCreation(delta) {
  const seconds = Math.floor(Number(delta) || 0);
  if (seconds < -30) return "before creation";
  const value = Math.max(0, seconds);
  if (value < 60) return `${value}s after creation`;
  const minutes = Math.floor(value / 60);
  const remain = value % 60;
  if (minutes < 60) return remain ? `${minutes}m ${remain}s after creation` : `${minutes}m after creation`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 48) return mins ? `${hours}h ${mins}m after creation` : `${hours}h after creation`;
  const days = Math.floor(hours / 24);
  const hrs = hours % 24;
  return hrs ? `${days}d ${hrs}h after creation` : `${days}d after creation`;
}

function buyerZone(settings) {
  const offset = Number(settings.timezoneOffset);
  return Number.isFinite(offset) ? offset : 9;
}

function signedEth(wei) {
  let value = 0n;
  try {
    value = BigInt(wei || 0);
  } catch {
    return "0";
  }
  const sign = value < 0n ? "-" : "";
  return `${sign}${formatEth(value < 0n ? -value : value)}`;
}

function positionLine(position) {
  if (!position) return "";
  const buys = Number(position.buys) || 0;
  const sells = Number(position.sells) || 0;
  if (!buys && !sells) return "";
  const buyLabel = `${buys} ${buys === 1 ? "buy" : "buys"}`;
  const sellLabel = `${sells} ${sells === 1 ? "sell" : "sells"}`;
  return `📊 ${esc(signedEth(position.netWei))} ETH (${esc(buyLabel)} + ${esc(sellLabel)})`;
}

function buyerMessage(trade, zone) {
  const side = trade.side === "sell" ? "SELL" : "BUY";
  const symbol = trade.tokenSymbol || "TOKEN";
  const name = String(trade.tokenName || "").trim();
  const who = trade.buyerLabel || trade.buyerAddress || "Buyer";
  const when = Number(trade.timestamp) || 0;
  const created = Number(trade.tokenCreatedAt) || 0;
  const zoneLabel = `UTC${zone >= 0 ? "+" : ""}${zone}`;
  const lag = lagLabel(when, nowSec());
  const tx = String(trade.txHash || "").toLowerCase();
  const token = String(trade.tokenAddress || "").toLowerCase();
  const txUrl = /^0x[a-f0-9]{64}$/.test(tx) ? `https://etherscan.io/tx/${tx}` : "";
  const chartUrl = isAddress(token) ? `https://dexscreener.com/ethereum/${token}` : "";
  const lines = [
    trade.sample ? "ℹ️ <b>SAMPLE ALERT</b>" : "",
    `${side === "BUY" ? "🟢" : "🔴"} <b>${side}</b> · $${bold(symbol)}${name ? ` — ${esc(name)}` : ""}`,
    `💰 MCap ${money(trade.marketCap)} · 📦 ${esc(trade.amountLabel || formatSwapAmount(trade.amountWei, trade.amountUsd))}`,
    positionLine(trade.position),
    when ? `🕐 ${esc(formatKst(when, zone))} ${zoneLabel}` : "",
    created ? `🆕 Created ${esc(formatKst(created, zone))} ${zoneLabel}` : "",
    created && when ? `⏱ ${side === "SELL" ? "Sell" : "Buy"} ${afterCreation(when - created)}` : "",
    lag ? `⚡️ Detected in ${esc(lag)}` : "",
    `👤 ${esc(who)}`,
    trade.buyerAddress ? `<code>${esc(trade.buyerAddress)}</code>` : "",
  ].filter(Boolean);
  const buttons = [
    txUrl ? { text: "🔗 Transaction", url: txUrl } : null,
    chartUrl ? { text: "📈 DexScreener", url: chartUrl } : null,
    trade.sample ? { text: "🔗 Transaction", url: "https://etherscan.io" } : null,
  ].filter(Boolean);
  return {
    text: lines.join("\n"),
    buttons: { inline_keyboard: buttons.length ? [buttons] : [] },
  };
}

async function deliverBuyerMessage(token, chatIds, text, buttons) {
  let sent = 0;
  let lastError = null;
  for (const chatId of chatIds) {
    try {
      await postTelegram(token, "sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: buttons,
      });
      sent += 1;
    } catch (error) {
      lastError = error;
      if (/blocked|deactivated|chat not found/i.test(error.message)) removeBuyerChat(chatId);
      console.error("buyer telegram", error.message);
    }
  }
  return { sent, lastError };
}

function buyerDestinationChats(settings, extra = "") {
  const ids = new Set();
  if (settings.buyerChatId) ids.add(String(settings.buyerChatId));
  if (extra) ids.add(String(extra));
  for (const chat of listBuyerChats()) ids.add(String(chat.chat_id));
  return [...ids];
}

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

let buyerInboxStarted = false;

export function startBuyerInbox() {
  if (buyerInboxStarted) return;
  buyerInboxStarted = true;
  console.log("Buyer Tracker is watching for teammates who press Start");
  const loop = async () => {
    while (true) {
      try {
        await readBuyerStarts();
      } catch (error) {
        console.error("buyer inbox", error.message);
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

async function readBuyerStarts() {
  const settings = getSettings();
  const token = String(settings.buyerBotToken || "").trim();
  if (!token) {
    await sleep(5000);
    return;
  }
  const offset = Number(settings.buyerUpdateOffset) || 0;
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        offset: offset || undefined,
        timeout: 20,
        allowed_updates: ["message", "my_chat_member"],
      }),
      signal: AbortSignal.timeout(25000),
    });
  } catch {
    await sleep(3000);
    return;
  }
  const data = await response.json().catch(() => ({}));
  if (!data.ok) {
    console.error("buyer inbox", data.description || response.status);
    await sleep(5000);
    return;
  }
  let next = offset;
  for (const update of data.result || []) {
    next = update.update_id + 1;
    const started = buyerStartFromUpdate(update);
    if (!started) continue;
    const already = listBuyerChats().some((chat) => String(chat.chat_id) === String(started.chatId));
    saveBuyerChat(started);
    console.log("Buyer Tracker subscriber added");
    if (already) continue;
    await postTelegram(token, "sendMessage", {
      chat_id: started.chatId,
      text: [
        "👋 <b>Buyer Tracker</b>",
        "",
        "You're subscribed. Every buy and sell from the watched wallets will arrive in this chat.",
        "",
        "🟢 Buy  ·  🔴 Sell",
        "💰 Market cap  ·  📦 Amount  ·  🕐 UTC+9",
      ].join("\n"),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }).catch((error) => console.error("buyer welcome", error.message));
  }
  if (next !== offset) saveSettings({ buyerUpdateOffset: String(next) });
}

function buyerStartFromUpdate(update) {
  const message = update.message;
  const text = String(message?.text || "");
  if (message?.chat?.id && text.startsWith("/start")) {
    return buyerPerson(message.chat.id, message.from);
  }
  const member = update.my_chat_member;
  const status = member?.new_chat_member?.status;
  if (!member?.chat?.id) return null;
  if (status === "kicked" || status === "left") {
    removeBuyerChat(member.chat.id);
    return null;
  }
  if (status === "member" || status === "administrator") return buyerPerson(member.chat.id, member.from);
  return null;
}

function buyerPerson(chatId, from) {
  return {
    chatId,
    name: [from?.first_name, from?.last_name].filter(Boolean).join(" "),
    username: from?.username || "",
  };
}

async function cardImage(card) {
  try {
    return await Promise.race([renderAlertCard(card), sleep(8000).then(() => null)]);
  } catch (error) {
    console.error("alert card", error.message);
    return null;
  }
}

function captionWithinLimit(text) {
  const full = String(text || "");
  if (full.length <= 1000) return full;
  const kept = full.split("\n").filter((line) => !line.includes("<a href="));
  return kept.join("\n").slice(0, 1000);
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
  const clock = eventStamp(info.eventAt);
  const lag = lagLabel(info.eventAt, info.detectedAt);
  const lines = [
    head,
    `MC ${cap} · Liq ${liq}${info.age ? ` · 🕐 ${esc(info.age)}` : ""}`,
    [move ? `24h: ${move}` : "", rank].filter(Boolean).join(" · "),
    clock ? `Event ${esc(clock)}` : "",
    lag ? `Detected in ${esc(lag)}` : "",
    info.rival ? `👤 ${esc(info.rival)}` : "",
    info.address ? `<code>${esc(info.address)}</code>` : "",
    linkLine(info.links),
  ];
  return lines.filter(Boolean).join("\n");
}

function eventStamp(unix) {
  if (!unix) return "";
  return `${formatKst(unix, -5)} UTC-5`;
}

function lagLabel(eventUnix, detectedUnix) {
  const event = Number(eventUnix);
  const detected = Number(detectedUnix);
  if (!event || !detected) return "";
  const seconds = Math.max(0, Math.floor(detected - event));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remain = seconds % 60;
  if (minutes < 60) return remain ? `${minutes}m ${remain}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

function rivalLabel(deployer) {
  const key = String(deployer || "").toLowerCase();
  const match = listCompetitors().find((competitor) => competitor.address === key);
  return match?.label || "unknown";
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

function isAddress(value) {
  return /^0x[a-f0-9]{40}$/.test(String(value || ""));
}

function isPoolId(value) {
  const pair = String(value || "");
  return /^0x[a-fA-F0-9]{40}$/.test(pair) || /^0x[a-fA-F0-9]{64}$/.test(pair);
}

function tokenLinks(address, creator, market = {}) {
  market = market || {};
  const token = String(address || "").toLowerCase();
  const dev = String(creator || "").toLowerCase();
  const storedPair = String(market.dextoolsUrl || "").match(/pair-explorer\/(0x[a-fA-F0-9]{40}|0x[a-fA-F0-9]{64})(?:$|[/?#])/i);
  const candidate = isPoolId(market.pairAddress) ? String(market.pairAddress) : storedPair?.[1] || "";
  const pair = candidate.toLowerCase() === token ? "" : candidate;
  return {
    dexscreener: isAddress(token) ? `https://dexscreener.com/ethereum/${token}` : "",
    dextools: isPoolId(pair) ? `https://www.dextools.io/app/ether/pair-explorer/${pair}` : "",
    etherscan: isAddress(token) ? `https://etherscan.io/token/${token}` : "",
    creator: isAddress(dev) && dev !== token ? `https://etherscan.io/address/${dev}` : "",
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
