import { getSettings } from "./db.js";
import { lookupLaunchMarket } from "./market.js";
import { formatKst, timezoneLabel } from "./util.js";

const CLOCK_SKEW_SEC = 120;

export async function notifyLaunch(launch) {
  try {
    const settings = getSettings();
    if (settings.telegramAlerts !== "1") return;
    const since = Number(settings.telegramSince) || 0;
    const launchedAt = Number(launch.launchedAt) || 0;
    if (!since || launchedAt + CLOCK_SKEW_SEC < since) return;
    const zone = timezoneLabel(settings.timezoneOffset);
    const title = launch.name ? `${launch.symbol} (${launch.name})` : launch.symbol || "token";
    const market = await lookupLaunchMarket(launch.address);
    const text = [
      `New launch · ${title}`,
      `Rival: ${launch.rival || "unknown"}`,
      `Launched: ${formatKst(launchedAt, settings.timezoneOffset)} ${zone}`,
      `Creator: ${launch.deployer || ""}`,
      `Token: ${launch.address}`,
      market.dextoolsUrl,
      market.dexscreenerUrl,
    ].join("\n");
    await sendTelegram(text, { photo: market.imageUrl });
  } catch (error) {
    console.error("telegram", error.message);
  }
}

export async function sendTelegram(text, override = {}) {
  const settings = getSettings();
  const token = String(override.token || settings.telegramBotToken || "").trim();
  const chatId = String(override.chatId || settings.telegramChatId || "").trim();
  if (!token || !chatId) throw new Error("Add a bot token and a chat id first.");
  const photo = String(override.photo || "").trim();
  if (photo) {
    try {
      await postTelegram(token, "sendPhoto", { chat_id: chatId, photo, caption: text });
      return;
    } catch (error) {
      console.error("telegram photo", error.message);
    }
  }
  await postTelegram(token, "sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
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
