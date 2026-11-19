import { getSettings } from "./db.js";
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
    const text = [
      `New launch · ${title}`,
      `Rival: ${launch.rival || "unknown"}`,
      `Launched: ${formatKst(launchedAt, settings.timezoneOffset)} ${zone}`,
      `Creator: ${launch.deployer || ""}`,
      `Token: ${launch.address}`,
      `https://www.dextools.io/app/ether/token/${launch.address}`,
      `https://dexscreener.com/ethereum/${launch.address}`,
    ].join("\n");
    await sendTelegram(text);
  } catch (error) {
    console.error("telegram", error.message);
  }
}

export async function sendTelegram(text, override = {}) {
  const settings = getSettings();
  const token = String(override.token || settings.telegramBotToken || "").trim();
  const chatId = String(override.chatId || settings.telegramChatId || "").trim();
  if (!token || !chatId) throw new Error("Add a bot token and a chat id first.");
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
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
