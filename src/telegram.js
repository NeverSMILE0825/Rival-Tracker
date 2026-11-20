import { getSettings, listFundingsForDeployer } from "./db.js";
import { lookupLaunchMarket } from "./market.js";
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
    const text = [
      `<b>NEW LAUNCH</b>  ·  $${bold(launch.symbol || "TOKEN")}`,
      nameLine(launch.name),
      "",
      marketBlock(market),
      "",
      metaLine("Rival", launch.rival || "unknown"),
      metaLine("Launched", stamp(launchedAt, settings)),
      metaLine("Creator", shortAddr(launch.deployer)),
      "",
      linkLine(links),
    ]
      .filter((line) => line != null)
      .join("\n");
    await sendTelegram(text, { photo: market?.imageUrl || "", buttons: linkButtons(links) });
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
  const text = [
    `<b>${paidTitle(payment)}</b>  ·  $${bold(payment.symbol || "TOKEN")}`,
    nameLine(payment.name),
    "",
    esc(payment.detail || "Promotion"),
    "",
    marketBlock(payment),
    "",
    metaLine("Paid", stamp(payment.paid_at, settings)),
    metaLine("Rival", rival),
    "",
    linkLine(links),
  ]
    .filter((line) => line != null)
    .join("\n");
  await sendTelegram(text, { photo: payment.banner_url || "", buttons: linkButtons(links) });
  return true;
}

export async function sendTelegram(text, override = {}) {
  const settings = getSettings();
  const token = String(override.token || settings.telegramBotToken || "").trim();
  const chatId = String(override.chatId || settings.telegramChatId || "").trim();
  if (!token || !chatId) throw new Error("Add a bot token and a chat id first.");
  const buttons = override.buttons || sampleButtons();
  const photo = String(override.photo || "").trim();
  const caption = String(text || "").slice(0, 1000);
  if (photo) {
    try {
      await postTelegram(token, "sendPhoto", {
        chat_id: chatId,
        photo,
        caption,
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
    text: caption,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: buttons,
  });
}

function sampleButtons() {
  return linkButtons({
    dexscreener: "https://dexscreener.com/ethereum",
    dextools: "https://www.dextools.io/app/en/ether/pairs",
  });
}

function tokenLinks(address, creator, market = {}) {
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
    ["Dexscreener", links.dexscreener],
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
  const parts = [
    ["Dexscreener", links.dexscreener],
    ["Dextools", links.dextools],
    ["Etherscan", links.etherscan],
    ["Website", links.website],
    ["X", links.twitter],
  ]
    .filter(([, url]) => /^https?:\/\//i.test(String(url || "")))
    .map(([label, url]) => `<a href="${esc(url)}">${label}</a>`);
  return parts.join("  ·  ");
}

function paidTitle(payment) {
  if (payment.source === "dextools" && payment.kind === "nitro") return "NITRO";
  if (payment.source === "dextools") return "DEXTOOLS UPDATE";
  if (payment.kind === "boost") return "BOOST";
  return "DEX PAID";
}

function marketBlock(market) {
  if (!market) return "Pool not listed yet";
  const cap = money(market.marketCap ?? market.market_cap);
  const liq = money(market.liquidityUsd ?? market.liquidity_usd);
  const vol = money(market.volume24h ?? market.volume_24h);
  const move = signedChange(market.priceChange24h ?? market.price_change_24h);
  if (cap === "—" && liq === "—" && vol === "—") return "Pool not listed yet";
  return [
    `<b>MCAP</b>  ${cap}${move ? `    ${move}` : ""}`,
    `<b>LIQ</b>  ${liq}`,
    `<b>24H VOL</b>  ${vol}`,
  ].join("\n");
}

function nameLine(name) {
  const text = String(name || "").trim();
  return text ? esc(text) : null;
}

function metaLine(label, value) {
  const text = String(value || "").trim();
  if (!text) return null;
  return `${label}  ${esc(text)}`;
}

function stamp(unix, settings) {
  if (!unix) return "";
  return `${formatKst(unix, settings.timezoneOffset)} ${timezoneLabel(settings.timezoneOffset)}`;
}

function bold(value) {
  return `<b>${esc(value)}</b>`;
}

function shortAddr(value) {
  const text = String(value || "");
  if (text.length < 12) return text;
  return `${text.slice(0, 6)}…${text.slice(-4)}`;
}

function money(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "—";
  if (number >= 1e9) return `$${(number / 1e9).toFixed(2)}B`;
  if (number >= 1e6) return `$${(number / 1e6).toFixed(2)}M`;
  if (number >= 1e3) return `$${(number / 1e3).toFixed(1)}K`;
  if (number >= 1) return `$${number.toFixed(2)}`;
  return `$${number.toPrecision(2)}`;
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
