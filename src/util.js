export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export function timezoneOffsetHours(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < -12 || number > 14) return 9;
  return number;
}

export function timezoneLabel(value) {
  const offset = timezoneOffsetHours(value);
  if (offset === 0) return "UTC";
  return `UTC${offset > 0 ? "+" : ""}${offset}`;
}

export function kstDateString(offsetDays = 0, offsetHours = 9) {
  const offset = timezoneOffsetHours(offsetHours);
  const shifted = new Date(Date.now() + (offset * 3600 + offsetDays * 86400) * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

export function zonedUnix(dateStr, hour, minute, second, offsetHours = 9) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ""));
  const h = Number(hour);
  const m = Number(minute);
  const s = Number(second);
  if (!match || !Number.isInteger(h) || !Number.isInteger(m) || !Number.isInteger(s)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59 || s < 0 || s > 59) return null;
  const offset = timezoneOffsetHours(offsetHours);
  const utcMidnight = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 1000;
  return utcMidnight - offset * 3600 + h * 3600 + m * 60 + s;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseApiKeys(input) {
  const text = Array.isArray(input) ? input.join("\n") : String(input || "");
  const seen = new Set();
  const keys = [];
  for (const part of text.split(/[\s,;]+/)) {
    const key = part.trim();
    if (!/^[A-Za-z0-9]{20,80}$/.test(key)) continue;
    const id = key.toUpperCase();
    if (seen.has(id)) continue;
    seen.add(id);
    keys.push(key);
  }
  return keys;
}

export function normalizeAddress(input) {
  const value = String(input || "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) return null;
  return value.toLowerCase();
}

export function ethToWei(amount) {
  const value = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error("Enter an ETH amount like 0.03");
  }
  const [whole, fraction = ""] = value.split(".");
  const frac = (fraction + "0".repeat(18)).slice(0, 18);
  return BigInt(whole) * 10n ** 18n + BigInt(frac);
}

export function formatEth(wei) {
  const value = BigInt(wei || 0);
  const whole = value / 10n ** 18n;
  const frac = (value % 10n ** 18n).toString().padStart(18, "0").slice(0, 4).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

export function formatKst(unixSeconds, offsetHours = 9) {
  if (!unixSeconds) return "";
  const date = new Date((Number(unixSeconds) + timezoneOffsetHours(offsetHours) * 3600) * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

export function decodeAbiString(hex) {
  if (!hex || hex === "0x") return null;
  const data = hex.slice(2);
  if (data.length === 64) {
    const text = Buffer.from(data, "hex").toString("utf8").replace(/\0/g, "").trim();
    return text || null;
  }
  if (data.length < 128) return null;
  let length;
  try {
    length = Number(BigInt(`0x${data.slice(64, 128)}`));
  } catch {
    return null;
  }
  if (!Number.isInteger(length) || length <= 0 || length > 64) return null;
  const start = 128;
  const raw = data.slice(start, start + length * 2);
  if (raw.length < length * 2) return null;
  const text = Buffer.from(raw, "hex").toString("utf8").replace(/\0/g, "").trim();
  if (!text) return null;
  return text;
}

export function isRetryableMessage(message) {
  const text = String(message || "").toLowerCase();
  return (
    text.includes("rate limit") ||
    text.includes("too many requests") ||
    text.includes("timeout") ||
    text.includes("temporar") ||
    text.includes("429") ||
    text.includes("500") ||
    text.includes("503") ||
    text.includes("502") ||
    text.includes("fetch failed") ||
    text.includes("network") ||
    text.includes("econnreset") ||
    text.includes("socket")
  );
}
