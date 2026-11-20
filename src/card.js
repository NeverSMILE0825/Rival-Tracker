import sharp from "sharp";
import { Resvg } from "@resvg/resvg-js";

const WIDTH = 1200;
const HEIGHT = 520;
const FONTS = ["C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/arialbd.ttf"];

export async function renderAlertCard(card) {
  const bannerUrl = isIcon(card.bannerUrl) ? "" : card.bannerUrl;
  const logoUrl = card.logoUrl || (isIcon(card.bannerUrl) ? card.bannerUrl : "");
  const [banner, logo] = await Promise.all([cover(bannerUrl), square(logoUrl, 96)]);
  const base = banner || (await sharp({
    create: { width: WIDTH, height: HEIGHT, channels: 3, background: "#10141c" },
  }).png().toBuffer());
  const overlay = renderOverlay(card, logo);
  return sharp(base).composite([{ input: overlay, top: 0, left: 0 }]).jpeg({ quality: 88 }).toBuffer();
}

function renderOverlay(card, logo) {
  const symbol = clip(card.symbol || "TOKEN", 14);
  const name = clip(card.name || "", 28);
  const created = clip(card.createdLabel || "", 28);
  const age = clip(card.ageLabel || "", 16);
  const rank = Number(card.rank) > 0 ? `#${Number(card.rank)}` : "";
  const cap = money(card.marketCap);
  const volume = money(card.volume24h);
  const liquidity = money(card.liquidityUsd);
  const move = change(card.priceChange24h);
  const initial = xml((symbol.replace(/[^A-Za-z0-9]/g, "")[0] || "T").toUpperCase());
  const logoImage = logo
    ? `<image href="data:image/png;base64,${logo.toString("base64")}" x="30" y="382" width="96" height="96" preserveAspectRatio="xMidYMid slice" clip-path="url(#logoClip)"/>`
    : `<text x="78" y="444" text-anchor="middle" font-family="Arial" font-size="32" font-weight="700" fill="#ffffff">${initial}</text>`;
  const svg = `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="top" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#000000" stop-opacity="0.72"/>
        <stop offset="1" stop-color="#000000" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="bot" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#000000" stop-opacity="0"/>
        <stop offset="0.42" stop-color="#000000" stop-opacity="0.78"/>
        <stop offset="1" stop-color="#000000" stop-opacity="0.94"/>
      </linearGradient>
      <clipPath id="logoClip"><circle cx="78" cy="430" r="46"/></clipPath>
    </defs>
    <rect x="0" y="0" width="${WIDTH}" height="110" fill="url(#top)"/>
    <rect x="0" y="250" width="${WIDTH}" height="270" fill="url(#bot)"/>
    <text x="1164" y="50" text-anchor="end" font-family="Arial" font-size="26" font-weight="700" fill="#3dd68c">${xml(age)}</text>
    <text x="1164" y="84" text-anchor="end" font-family="Arial" font-size="26" font-weight="700" fill="#ffb020">${xml(rank)}</text>
    <circle cx="78" cy="430" r="48" fill="#17202b"/>
    ${logoImage}
    <circle cx="78" cy="430" r="48" fill="none" stroke="#ffffff" stroke-width="3"/>
    <text x="150" y="412" font-family="Arial" font-size="34" font-weight="700" fill="#ffffff">${xml(symbol)}</text>
    <text x="150" y="444" font-family="Arial" font-size="18" fill="#d5dde8">${xml(name)}</text>
    <text x="150" y="472" font-family="Arial" font-size="15" fill="#9fb0c3">${xml(created)}</text>
    <text x="620" y="404" font-family="Arial" font-size="13" font-weight="700" fill="#b7c3d4" letter-spacing="1.4">MCAP</text>
    <text x="620" y="440" font-family="Arial" font-size="28" font-weight="700" fill="#ffffff">${xml(cap)}</text>
    <text x="620" y="470" font-family="Arial" font-size="16" font-weight="700" fill="${move.color}">${xml(move.text)}</text>
    <text x="830" y="404" font-family="Arial" font-size="13" font-weight="700" fill="#b7c3d4" letter-spacing="1.4">24H VOL</text>
    <text x="830" y="440" font-family="Arial" font-size="28" font-weight="700" fill="#ffffff">${xml(volume)}</text>
    <text x="1030" y="404" font-family="Arial" font-size="13" font-weight="700" fill="#b7c3d4" letter-spacing="1.4">LIQUIDITY</text>
    <text x="1030" y="440" font-family="Arial" font-size="28" font-weight="700" fill="#ffffff">${xml(liquidity)}</text>
  </svg>`;
  return new Resvg(svg, {
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: "Arial" },
  }).render().asPng();
}

async function cover(url) {
  const bytes = await loadBytes(url);
  if (!bytes) return null;
  try {
    return await sharp(bytes).resize(WIDTH, HEIGHT, { fit: "cover", position: "centre" }).png().toBuffer();
  } catch {
    return null;
  }
}

async function square(url, size) {
  const bytes = await loadBytes(url);
  if (!bytes) return null;
  try {
    return await sharp(bytes).resize(size, size, { fit: "cover" }).png().toBuffer();
  } catch {
    return null;
  }
}

async function loadBytes(url) {
  if (!/^https?:\/\//i.test(String(url || ""))) return null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const type = response.headers.get("content-type") || "";
    if (!type.startsWith("image/")) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  }
}

function isIcon(url) {
  return /\/tokens\/ethereum\/0x[a-f0-9]{40}\.png/i.test(String(url || ""));
}

function clip(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
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

function change(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return { text: "", color: "#ffffff" };
  const sign = number > 0 ? "+" : "";
  const text = Math.abs(number) >= 1000 ? `${sign}${(number / 1000).toFixed(1)}k%` : `${sign}${number.toFixed(2)}%`;
  return { text, color: number > 0 ? "#3dd68c" : number < 0 ? "#ff5d73" : "#d5dde8" };
}

function xml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  })[char]);
}
