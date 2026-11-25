import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { kstDateString, normalizeAddress, nowSec, parseApiKeys } from "./util.js";

const dataDir = path.join(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, "tracker.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS competitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '#d6f25c',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    cursor_block INTEGER NOT NULL DEFAULT 0,
    last_scan_at INTEGER,
    scan_status TEXT NOT NULL DEFAULT 'idle',
    scan_error TEXT NOT NULL DEFAULT '',
    scan_note TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS fundings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competitor_id INTEGER NOT NULL,
    deployer TEXT NOT NULL,
    funder TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    block_number INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    value_wei TEXT NOT NULL,
    kind TEXT NOT NULL,
    UNIQUE(competitor_id, tx_hash, deployer)
  );

  CREATE TABLE IF NOT EXISTS deployers (
    address TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    eth_balance_wei TEXT,
    balance_at INTEGER,
    tx_count INTEGER NOT NULL DEFAULT 0,
    first_funded_at INTEGER,
    last_checked_at INTEGER,
    note TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS tokens (
    address TEXT PRIMARY KEY,
    deployer TEXT NOT NULL,
    name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    decimals INTEGER,
    created_at INTEGER,
    created_tx TEXT,
    created_block INTEGER,
    pair_address TEXT,
    dex TEXT,
    price_usd REAL,
    liquidity_usd REAL,
    market_cap REAL,
    fdv REAL,
    volume_24h REAL,
    price_change_24h REAL,
    txns_24h INTEGER,
    peak_liquidity_usd REAL NOT NULL DEFAULT 0,
    pair_created_at INTEGER,
    status TEXT NOT NULL DEFAULT 'unlisted',
    dextools_url TEXT,
    dexscreener_url TEXT,
    market_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    competitor_id INTEGER,
    address TEXT,
    created_at INTEGER NOT NULL,
    seen INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_fundings_comp ON fundings(competitor_id);
  CREATE INDEX IF NOT EXISTS idx_fundings_dep ON fundings(deployer);
  CREATE INDEX IF NOT EXISTS idx_fundings_comp_dep ON fundings(competitor_id, deployer);
  CREATE TABLE IF NOT EXISTS token_pairs (
    pair_address TEXT PRIMARY KEY,
    token_address TEXT NOT NULL,
    dex TEXT,
    label TEXT,
    price_usd REAL,
    liquidity_usd REAL,
    market_cap REAL,
    volume_24h REAL,
    price_change_24h REAL,
    txns_24h INTEGER,
    pair_created_at INTEGER,
    status TEXT,
    dextools_url TEXT,
    dexscreener_url TEXT,
    updated_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_tokens_dep ON tokens(deployer);
  CREATE INDEX IF NOT EXISTS idx_tokens_status ON tokens(status);
  CREATE INDEX IF NOT EXISTS idx_token_pairs_token ON token_pairs(token_address);
  CREATE INDEX IF NOT EXISTS idx_deployers_status ON deployers(status);

  CREATE TABLE IF NOT EXISTS buyers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS buyer_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    buyer_id INTEGER NOT NULL,
    token_address TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    block_number INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    side TEXT NOT NULL,
    amount REAL,
    amount_usd REAL,
    amount_wei TEXT,
    market_cap REAL,
    UNIQUE(buyer_id, token_address, tx_hash)
  );

  CREATE INDEX IF NOT EXISTS idx_buyer_trades_time ON buyer_trades(timestamp DESC);
`);

const DEFAULTS = {
  minFundingEth: "0.01",
  dustEth: "0.005",
  lookbackDays: "30",
  rugLiquidityUsd: "1500",
  maxFundingEth: "20",
  autoScan: "0",
  live: "0",
  scanIntervalMin: "5",
  marketIntervalSec: "90",
  maxPages: "40",
  requireFirstFunder: "1",
  etherscanApiKey: "",
  scanRangeMode: "date",
  scanStartDate: "",
  scanEndDate: "",
  scanStartHour: "0",
  scanStartMinute: "0",
  scanStartSecond: "0",
  scanEndHour: "23",
  scanEndMinute: "59",
  scanEndSecond: "59",
  timezoneOffset: "9",
  scanStartBlock: "",
  scanEndBlock: "",
  telegramBotToken: "",
  telegramChatId: "",
  telegramAlerts: "0",
  telegramSince: "",
  telegramUpdateOffset: "0",
  paidBaseline: "",
  liveSeenBlock: "",
  launchSeenBlock: "",
  fastMode: "1",
  fastSince: "",
  buyerSeenBlock: "",
  buyerBotToken: "",
  buyerChatId: "",
  buyerAlerts: "0",
  buyerUpdateOffset: "0",
  trendAlerts: "1",
  trendWindowMin: "60",
  trendRising: "3",
  trendTrending: "5",
  trendExploding: "7",
  trendMarket: "10",
};

const SEED = [
  ["0x39F6a6C85d39d5ABAd8A398310c52E7c374F2bA3", "Rival 1", "", "#d6f25c"],
  ["0x6b3aedbd16b6894d7255aab02133b30e8c8c5b72", "Rival 2", "", "#ffb020"],
  ["0xa1abfa21f80ecf401bd41365adbb6fef6fefdf09", "Rival 3", "", "#8eb6ff"],
  ["0xA9D1e08C7793af67e9d92fe308d5697FB81d3E43", "Rival 4", "", "#c9a6ff"],
  ["0xD9188A1F280D81558ec2C9879800163dFc02aa51", "Rival 5", "", "#79e3d6"],
  [
    "0xBA006C66a47fE33550F79D5Bff5328BBB4c1D251",
    "Rival 6",
    "This wallet funds creators through a contract it deploys. The app follows those internal ETH transfers.",
    "#ff8f70",
  ],
];

function seed() {
  const count = Number(db.prepare("SELECT COUNT(*) AS n FROM competitors").get().n);
  if (count > 0) return;
  const insert = db.prepare(
    `INSERT INTO competitors(address, label, notes, color, enabled, created_at, updated_at)
     VALUES(?, ?, ?, ?, 1, ?, ?)`,
  );
  const ts = nowSec();
  for (const [address, label, notes, color] of SEED) {
    insert.run(address.toLowerCase(), label, notes, color, ts, ts);
  }
  const settings = db.prepare("INSERT INTO settings(key, value) VALUES(?, ?)");
  for (const [key, value] of Object.entries(DEFAULTS)) settings.run(key, value);
}

seed();

export function getSettings() {
  const rows = db.prepare("SELECT key, value FROM settings").all();
  const settings = { ...DEFAULTS };
  for (const row of rows) settings[row.key] = row.value;
  const lookback = Math.max(1, Number(settings.lookbackDays) || 30);
  if (!settings.scanStartDate) settings.scanStartDate = kstDateString(-lookback, settings.timezoneOffset);
  if (!settings.scanEndDate) settings.scanEndDate = kstDateString(0, settings.timezoneOffset);
  return settings;
}

export function saveSettings(partial) {
  const update = db.prepare(
    "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  for (const [key, value] of Object.entries(partial)) {
    if (!(key in DEFAULTS)) continue;
    update.run(key, String(value));
  }
  return getSettings();
}

export function saveTelegramChat({ chatId, name, username }) {
  db.prepare(
    `INSERT INTO telegram_chats(chat_id, name, username, started_at)
     VALUES(?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET name = excluded.name, username = excluded.username`,
  ).run(String(chatId), String(name || ""), String(username || ""), nowSec());
}

export function listTelegramChats() {
  return db.prepare("SELECT chat_id, name, username, started_at FROM telegram_chats ORDER BY started_at").all();
}

export function removeTelegramChat(chatId) {
  db.prepare("DELETE FROM telegram_chats WHERE chat_id = ?").run(String(chatId));
}

export function saveBuyerChat({ chatId, name, username }) {
  db.prepare(
    `INSERT INTO buyer_chats(chat_id, name, username, started_at)
     VALUES(?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET name = excluded.name, username = excluded.username`,
  ).run(String(chatId), String(name || ""), String(username || ""), nowSec());
}

export function listBuyerChats() {
  return db.prepare("SELECT chat_id, name, username, started_at FROM buyer_chats ORDER BY started_at").all();
}

export function removeBuyerChat(chatId) {
  db.prepare("DELETE FROM buyer_chats WHERE chat_id = ?").run(String(chatId));
}

export function listTokensSince(since) {
  return db
    .prepare(
      `SELECT address, name, symbol, created_at
       FROM tokens
       WHERE created_at >= ?
       ORDER BY created_at ASC`,
    )
    .all(since);
}

export function readTrendState(key) {
  return db.prepare("SELECT value FROM trend_state WHERE key = ?").get(key)?.value || "";
}

export function writeTrendState(key, value) {
  db.prepare(
    "INSERT INTO trend_state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, String(value));
}

export function saveLivePair(pair) {
  const found = db.prepare("SELECT 1 AS ok FROM live_pairs WHERE pair_address = ?").get(pair.pair);
  db.prepare(
    `INSERT INTO live_pairs(pair_address, token_address, name, symbol, quote_symbol, created_at)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(pair_address) DO UPDATE SET
       name = excluded.name,
       symbol = excluded.symbol,
       quote_symbol = excluded.quote_symbol`,
  ).run(pair.pair, pair.token, pair.name, pair.symbol, pair.quote, pair.createdAt);
  return !found;
}

export function listLivePairsSince(since) {
  return db
    .prepare(
      `SELECT pair_address AS pair, token_address AS token, name, symbol, quote_symbol AS quote, created_at AS createdAt
       FROM live_pairs
       WHERE created_at >= ?
       ORDER BY created_at ASC`,
    )
    .all(since);
}

export function livePairCoverage() {
  const row = db.prepare("SELECT MIN(created_at) AS oldest, MAX(created_at) AS newest, COUNT(*) AS n FROM live_pairs").get();
  return {
    oldest: Number(row?.oldest) || 0,
    newest: Number(row?.newest) || 0,
    stored: Number(row?.n) || 0,
  };
}

export function pruneLivePairs(before) {
  db.prepare("DELETE FROM live_pairs WHERE created_at < ?").run(before);
}

export function narrativeAlertLevels(key) {
  return new Set(
    db
      .prepare("SELECT level FROM narrative_alerts WHERE narrative_key = ?")
      .all(key)
      .map((row) => row.level),
  );
}

export function markNarrativeAlert(key, level) {
  db.prepare(
    `INSERT INTO narrative_alerts(narrative_key, level, alerted_at)
     VALUES(?, ?, ?)
     ON CONFLICT(narrative_key, level) DO UPDATE SET alerted_at = excluded.alerted_at`,
  ).run(key, level, nowSec());
}

export function clearNarrativeAlert(key, level) {
  db.prepare("DELETE FROM narrative_alerts WHERE narrative_key = ? AND level = ?").run(key, level);
}

export function listBuyers() {
  return db.prepare("SELECT * FROM buyers ORDER BY id").all();
}

export function getBuyer(id) {
  return db.prepare("SELECT * FROM buyers WHERE id = ?").get(id);
}

export function createBuyer({ address, label }) {
  const ts = nowSec();
  const result = db
    .prepare("INSERT INTO buyers(address, label, created_at, updated_at) VALUES(?, ?, ?, ?)")
    .run(address, label || "", ts, ts);
  return getBuyer(Number(result.lastInsertRowid));
}

export function updateBuyer(id, fields) {
  const current = getBuyer(id);
  if (!current) return null;
  db.prepare("UPDATE buyers SET address = ?, label = ?, updated_at = ? WHERE id = ?").run(
    fields.address || current.address,
    fields.label != null ? fields.label : current.label,
    nowSec(),
    id,
  );
  return getBuyer(id);
}

export function deleteBuyer(id) {
  db.prepare("DELETE FROM buyer_trades WHERE buyer_id = ?").run(id);
  db.prepare("DELETE FROM buyers WHERE id = ?").run(id);
}

export function listTrackedTokens() {
  return db.prepare("SELECT address, symbol, name, decimals, market_cap, created_at FROM tokens").all();
}

export function saveBuyerTrades(rows) {
  if (!rows.length) return [];
  const insert = db.prepare(
    `INSERT OR IGNORE INTO buyer_trades(
       buyer_id, token_address, tx_hash, block_number, timestamp, side, amount, amount_usd, amount_wei, market_cap
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const saved = [];
  db.exec("BEGIN");
  try {
    for (const row of rows) {
      const result = insert.run(
        row.buyerId,
        row.tokenAddress,
        row.txHash,
        row.blockNumber,
        row.timestamp,
        row.side,
        row.amount,
        row.amountUsd,
        row.amountWei,
        row.marketCap,
      );
      if (Number(result.changes) > 0) saved.push(row);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return saved;
}

const BUYER_TRADE_SELECT = `SELECT t.id, t.buyer_id, t.token_address, t.tx_hash, t.block_number, t.timestamp, t.side, t.amount, t.amount_usd, t.amount_wei, t.market_cap,
              b.address AS buyer_address, b.label AS buyer_label,
              k.symbol AS token_symbol, k.name AS token_name
       FROM buyer_trades t
       JOIN buyers b ON b.id = t.buyer_id
       LEFT JOIN tokens k ON k.address = t.token_address`;

export function listBuyerTrades(limit = 1000) {
  return db.prepare(`${BUYER_TRADE_SELECT} ORDER BY t.timestamp DESC, t.id DESC LIMIT ?`).all(limit);
}

export function listBuyerTradesByBuyer(buyerId) {
  return db.prepare(`${BUYER_TRADE_SELECT} WHERE t.buyer_id = ? ORDER BY t.timestamp ASC, t.id ASC`).all(buyerId);
}

export function listCompetitors() {
  return db.prepare("SELECT * FROM competitors ORDER BY id").all();
}

export function getCompetitor(id) {
  return db.prepare("SELECT * FROM competitors WHERE id = ?").get(id);
}

export function getCompetitorByAddress(address) {
  return db.prepare("SELECT * FROM competitors WHERE address = ?").get(address);
}

export function createCompetitor({ address, label, notes, color }) {
  const ts = nowSec();
  const result = db
    .prepare(
      `INSERT INTO competitors(address, label, notes, color, enabled, created_at, updated_at)
       VALUES(?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(address, label, notes || "", color || "#d6f25c", ts, ts);
  return getCompetitor(Number(result.lastInsertRowid));
}

export function updateCompetitor(id, fields) {
  const current = getCompetitor(id);
  if (!current) return null;
  const address = fields.address || current.address;
  const addressChanged = address !== current.address;
  if (addressChanged) {
    purgeCompetitorResults(id);
    db.prepare("UPDATE competitors SET cursor_block = 0 WHERE id = ?").run(id);
  }
  db.prepare(
    `UPDATE competitors
     SET address = ?, label = ?, notes = ?, color = ?, enabled = ?, updated_at = ?,
         scan_note = CASE WHEN ? = 1 THEN '' ELSE scan_note END,
         scan_error = CASE WHEN ? = 1 THEN '' ELSE scan_error END
     WHERE id = ?`,
  ).run(
    address,
    fields.label ?? current.label,
    fields.notes ?? current.notes,
    fields.color ?? current.color,
    fields.enabled ?? current.enabled,
    nowSec(),
    addressChanged ? 1 : 0,
    addressChanged ? 1 : 0,
    id,
  );
  return getCompetitor(id);
}

export function deleteCompetitor(id) {
  purgeCompetitorResults(id);
  db.prepare("DELETE FROM events WHERE competitor_id = ?").run(id);
  db.prepare("DELETE FROM competitors WHERE id = ?").run(id);
}

export function purgeCompetitorResults(id) {
  const deployers = db.prepare("SELECT DISTINCT deployer FROM fundings WHERE competitor_id = ?").all(id);
  db.prepare("DELETE FROM fundings WHERE competitor_id = ?").run(id);
  for (const row of deployers) {
    const left = Number(db.prepare("SELECT COUNT(*) AS n FROM fundings WHERE deployer = ?").get(row.deployer).n);
    if (left === 0) {
      db.prepare("DELETE FROM token_swaps WHERE token_address IN (SELECT address FROM tokens WHERE deployer = ?)").run(row.deployer);
      db.prepare("DELETE FROM token_pairs WHERE token_address IN (SELECT address FROM tokens WHERE deployer = ?)").run(row.deployer);
      db.prepare("DELETE FROM tokens WHERE deployer = ?").run(row.deployer);
      db.prepare("DELETE FROM deployers WHERE address = ?").run(row.deployer);
    }
  }
}

const competitorColumns = db.prepare("PRAGMA table_info(competitors)").all();
for (const [name, definition] of [
  ["internal_cursor_block", "INTEGER NOT NULL DEFAULT 0"],
  ["history_from_block", "INTEGER NOT NULL DEFAULT 0"],
  ["backfill_block", "INTEGER NOT NULL DEFAULT 0"],
  ["internal_from_block", "INTEGER NOT NULL DEFAULT 0"],
  ["internal_backfill_block", "INTEGER NOT NULL DEFAULT 0"],
]) {
  if (!competitorColumns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE competitors ADD COLUMN ${name} ${definition}`);
  }
}

const tokenColumns = db.prepare("PRAGMA table_info(tokens)").all();
if (!tokenColumns.some((column) => column.name === "txns_total")) {
  db.exec("ALTER TABLE tokens ADD COLUMN txns_total INTEGER");
}
if (!tokenColumns.some((column) => column.name === "logo_url")) {
  db.exec("ALTER TABLE tokens ADD COLUMN logo_url TEXT");
}
if (!tokenColumns.some((column) => column.name === "banner_url")) {
  db.exec("ALTER TABLE tokens ADD COLUMN banner_url TEXT");
}
if (!tokenColumns.some((column) => column.name === "ath_market_cap")) {
  db.exec("ALTER TABLE tokens ADD COLUMN ath_market_cap REAL");
}
if (!tokenColumns.some((column) => column.name === "ath_checked_at")) {
  db.exec("ALTER TABLE tokens ADD COLUMN ath_checked_at INTEGER");
}
for (const [name, definition] of [
  ["profit_wei", "TEXT"],
  ["profit_buys", "INTEGER"],
  ["profit_sells", "INTEGER"],
  ["profit_block", "INTEGER"],
  ["profit_checked_at", "INTEGER"],
  ["launch_checked_at", "INTEGER"],
]) {
  if (!tokenColumns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE tokens ADD COLUMN ${name} ${definition}`);
  }
}

const swapColumns = db.prepare("PRAGMA table_info(token_swaps)").all();
if (!swapColumns.some((column) => column.name === "setup_checked")) {
  db.exec("ALTER TABLE token_swaps ADD COLUMN setup_checked INTEGER NOT NULL DEFAULT 0");
}

const buyerTradeColumns = db.prepare("PRAGMA table_info(buyer_trades)").all();
if (!buyerTradeColumns.some((column) => column.name === "amount_usd")) {
  db.exec("ALTER TABLE buyer_trades ADD COLUMN amount_usd REAL");
}
if (!buyerTradeColumns.some((column) => column.name === "amount_wei")) {
  db.exec("ALTER TABLE buyer_trades ADD COLUMN amount_wei TEXT");
}

const pairColumns = db.prepare("PRAGMA table_info(token_pairs)").all();
if (!pairColumns.some((column) => column.name === "quote_symbol")) {
  db.exec("ALTER TABLE token_pairs ADD COLUMN quote_symbol TEXT");
}
if (!pairColumns.some((column) => column.name === "txns_total")) {
  db.exec("ALTER TABLE token_pairs ADD COLUMN txns_total INTEGER");
}
if (!pairColumns.some((column) => column.name === "is_main")) {
  db.exec("ALTER TABLE token_pairs ADD COLUMN is_main INTEGER NOT NULL DEFAULT 0");
}

db.exec(`
  CREATE TABLE IF NOT EXISTS telegram_chats (
    chat_id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL DEFAULT '',
    started_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS buyer_chats (
    chat_id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL DEFAULT '',
    started_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS narrative_alerts (
    narrative_key TEXT NOT NULL,
    level TEXT NOT NULL,
    alerted_at INTEGER NOT NULL,
    PRIMARY KEY (narrative_key, level)
  );

  CREATE INDEX IF NOT EXISTS idx_tokens_created ON tokens(created_at);

  CREATE TABLE IF NOT EXISTS token_swaps (
    token_address TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    block_number INTEGER NOT NULL,
    tx_to TEXT,
    side TEXT NOT NULL DEFAULT '',
    amount_wei TEXT NOT NULL DEFAULT '0',
    measured INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (token_address, tx_hash)
  );

  CREATE INDEX IF NOT EXISTS idx_token_swaps_token ON token_swaps(token_address, measured);

  CREATE TABLE IF NOT EXISTS live_pairs (
    pair_address TEXT PRIMARY KEY,
    token_address TEXT NOT NULL,
    name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    quote_symbol TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_live_pairs_created ON live_pairs(created_at);

  CREATE TABLE IF NOT EXISTS trend_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

db.exec(`
  UPDATE tokens
  SET txns_total = txns_24h
  WHERE COALESCE(txns_24h, 0) > COALESCE(txns_total, 0)
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS token_paid (
    fingerprint TEXT PRIMARY KEY,
    token_address TEXT NOT NULL,
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    amount INTEGER,
    paid_at INTEGER,
    detail TEXT NOT NULL,
    alerted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_token_paid_token ON token_paid(token_address);
  CREATE INDEX IF NOT EXISTS idx_token_paid_alerted ON token_paid(alerted);
`);

export function resetCursor(id) {
  db.prepare(
    `UPDATE competitors
     SET cursor_block = 0, internal_cursor_block = 0, history_from_block = 0, backfill_block = 0,
         internal_from_block = 0, internal_backfill_block = 0, scan_note = '', scan_error = ''
     WHERE id = ?`,
  ).run(id);
}

export function setHistoryFrom(id, block) {
  db.prepare("UPDATE competitors SET history_from_block = ?, updated_at = ? WHERE id = ?").run(block, nowSec(), id);
}

export function setBackfill(id, block) {
  db.prepare("UPDATE competitors SET backfill_block = ?, updated_at = ? WHERE id = ?").run(block, nowSec(), id);
}

export function setInternalFrom(id, block) {
  db.prepare("UPDATE competitors SET internal_from_block = ?, updated_at = ? WHERE id = ?").run(block, nowSec(), id);
}

export function setInternalBackfill(id, block) {
  db.prepare("UPDATE competitors SET internal_backfill_block = ?, updated_at = ? WHERE id = ?").run(block, nowSec(), id);
}

export function setInternalCursor(id, block) {
  db.prepare("UPDATE competitors SET internal_cursor_block = ?, updated_at = ? WHERE id = ?").run(block, nowSec(), id);
}

export function setScanState(id, { status, note, error, cursor, scanned }) {
  const current = getCompetitor(id);
  if (!current) return;
  db.prepare(
    `UPDATE competitors
     SET scan_status = ?, scan_note = ?, scan_error = ?, cursor_block = ?, last_scan_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    status ?? current.scan_status,
    note ?? current.scan_note,
    error ?? current.scan_error,
    cursor ?? current.cursor_block,
    scanned ? nowSec() : current.last_scan_at,
    nowSec(),
    id,
  );
}

export function recordFunding({ competitorId, deployer, funder, txHash, blockNumber, timestamp, valueWei, kind }) {
  db.prepare(
    `INSERT INTO fundings(competitor_id, deployer, funder, tx_hash, block_number, timestamp, value_wei, kind)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(competitor_id, tx_hash, deployer) DO NOTHING`,
  ).run(competitorId, deployer, funder, txHash, blockNumber, timestamp, valueWei, kind);

  const existing = db.prepare("SELECT status, first_funded_at FROM deployers WHERE address = ?").get(deployer);
  if (!existing) {
    db.prepare(
      `INSERT INTO deployers(address, status, first_funded_at, note)
       VALUES(?, 'queued', ?, '')`,
    ).run(deployer, timestamp);
    return { created: true };
  }
  if (existing.first_funded_at == null || timestamp < existing.first_funded_at) {
    db.prepare("UPDATE deployers SET first_funded_at = ? WHERE address = ?").run(timestamp, deployer);
  }
  if (existing.status === "ignored") {
    db.prepare("UPDATE deployers SET status = 'queued', last_checked_at = NULL, note = '' WHERE address = ?").run(deployer);
  }
  return { created: false };
}

export function listLaunchWatchers() {
  return db
    .prepare(
      `SELECT d.address, c.label, c.id AS competitor_id
       FROM deployers d
       JOIN fundings f ON f.deployer = d.address
       JOIN competitors c ON c.id = f.competitor_id AND c.enabled = 1
       WHERE d.status IN ('waiting', 'queued', 'launched')
       GROUP BY d.address`,
    )
    .all();
}

export function listRivalCreators() {
  return db
    .prepare(
      `SELECT d.address, c.label, c.id AS competitor_id, c.address AS competitor_address, MIN(f.timestamp) AS funded_at
       FROM deployers d
       JOIN fundings f ON f.deployer = d.address
       JOIN competitors c ON c.id = f.competitor_id AND c.enabled = 1
       WHERE d.status != 'ignored'
       GROUP BY d.address`,
    )
    .all();
}

export function listFundingsForDeployer(address) {
  return db
    .prepare(
      `SELECT f.*, c.address AS competitor_address, c.label, c.color
       FROM fundings f JOIN competitors c ON c.id = f.competitor_id
       WHERE f.deployer = ?
       ORDER BY f.timestamp ASC`,
    )
    .all(address);
}

export function queuedDeployers(competitorId, limit) {
  return db
    .prepare(
      `SELECT d.*
       FROM deployers d
       WHERE d.status = 'queued'
         AND d.address IN (SELECT deployer FROM fundings WHERE competitor_id = ?)
       ORDER BY d.first_funded_at DESC
       LIMIT ?`,
    )
    .all(competitorId, limit);
}

export function countQueued(competitorId) {
  return Number(
    db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM deployers d
         WHERE d.status = 'queued'
           AND d.address IN (SELECT deployer FROM fundings WHERE competitor_id = ?)`,
      )
      .get(competitorId).n,
  );
}

export function listLiveDeployers() {
  return db
    .prepare(
      `SELECT address, status, first_funded_at, tx_count
       FROM deployers
       WHERE status IN ('waiting', 'queued', 'drained')
       ORDER BY first_funded_at DESC`,
    )
    .all();
}

export function listDeployerPage({ since = 0, before = 0, limit = 400, offset = 0 } = {}) {
  const clauses = ["status IN ('waiting', 'queued', 'drained')"];
  const params = [];
  if (since) {
    clauses.push("first_funded_at >= ?");
    params.push(since);
  }
  if (before) {
    clauses.push("first_funded_at < ?");
    params.push(before);
  }
  params.push(Math.max(1, Number(limit) || 1), Math.max(0, Number(offset) || 0));
  return db
    .prepare(
      `SELECT address, status, first_funded_at, tx_count
       FROM deployers
       WHERE ${clauses.join(" AND ")}
       ORDER BY first_funded_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params);
}

export function listHotDeployers(seconds, limit) {
  const since = nowSec() - Math.max(60, Number(seconds) || 0);
  return db
    .prepare(
      `SELECT address, status, first_funded_at, tx_count
       FROM deployers
       WHERE status IN ('waiting', 'queued', 'drained')
         AND first_funded_at > ?
       ORDER BY first_funded_at DESC
       LIMIT ?`,
    )
    .all(since, Math.max(1, Number(limit) || 1));
}

export function dueDeployers(competitorId, limit) {
  const now = nowSec();
  return db
    .prepare(
      `SELECT d.*
       FROM deployers d
       WHERE d.address IN (SELECT deployer FROM fundings WHERE competitor_id = ?)
         AND (
           d.status = 'queued'
           OR (d.status = 'waiting' AND (d.last_checked_at IS NULL OR d.last_checked_at < ?))
           OR (d.status = 'drained' AND (d.last_checked_at IS NULL OR d.last_checked_at < ?))
           OR (d.status = 'launched' AND (d.last_checked_at IS NULL OR d.last_checked_at < ?))
         )
       ORDER BY CASE d.status WHEN 'queued' THEN 0 WHEN 'waiting' THEN 1 WHEN 'drained' THEN 2 ELSE 3 END,
                d.first_funded_at DESC
       LIMIT ?`,
    )
    .all(competitorId, now - 30, now - 3 * 3600, now - 12 * 3600, limit);
}

export function markDeployer(address, fields) {
  const current = db.prepare("SELECT * FROM deployers WHERE address = ?").get(address);
  if (!current) return;
  db.prepare(
    `UPDATE deployers
     SET status = ?, eth_balance_wei = ?, balance_at = ?, tx_count = ?, last_checked_at = ?, note = ?
     WHERE address = ?`,
  ).run(
    fields.status ?? current.status,
    fields.ethBalanceWei ?? current.eth_balance_wei,
    fields.balanceAt ?? current.balance_at,
    fields.txCount ?? current.tx_count,
    fields.lastCheckedAt ?? nowSec(),
    fields.note ?? current.note,
    address,
  );
}

export function getDeployer(address) {
  return db.prepare("SELECT * FROM deployers WHERE address = ?").get(address);
}

export function tokenExists(address) {
  return db.prepare("SELECT address FROM tokens WHERE address = ?").get(address);
}

export function upsertToken(token) {
  const existing = tokenExists(token.address);
  db.prepare(
    `INSERT INTO tokens(address, deployer, name, symbol, decimals, created_at, created_tx, created_block, status, peak_liquidity_usd)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'unlisted', 0)
     ON CONFLICT(address) DO UPDATE SET
       deployer = excluded.deployer,
       name = excluded.name,
       symbol = excluded.symbol,
       decimals = excluded.decimals,
       created_at = CASE WHEN tokens.created_block = 0 AND excluded.created_block > 0 THEN excluded.created_at ELSE tokens.created_at END,
       created_tx = CASE WHEN tokens.created_block = 0 AND excluded.created_tx != '' THEN excluded.created_tx ELSE tokens.created_tx END,
       created_block = CASE WHEN tokens.created_block = 0 AND excluded.created_block > 0 THEN excluded.created_block ELSE tokens.created_block END`,
  ).run(
    token.address,
    token.deployer,
    token.name,
    token.symbol,
    token.decimals,
    token.createdAt,
    token.createdTx,
    token.createdBlock,
  );
  return { created: !existing };
}

export function listTokensForLaunchCheck() {
  return db
    .prepare(
      `SELECT address, created_tx, created_at, created_block
       FROM tokens
       WHERE IFNULL(launch_checked_at, 0) = 0
       ORDER BY created_at DESC`,
    )
    .all();
}

export function setTokenLaunch(address, launch) {
  const createdAt = Number(launch.createdAt) || 0;
  const block = Number(launch.createdBlock) || 0;
  const tx = String(launch.createdTx || "");
  const confirmed = launch.confirmed ? 1 : 0;
  db.prepare(
    `UPDATE tokens
     SET created_at = ?,
         created_block = CASE
           WHEN ? > 0 THEN ?
           WHEN ? = 1 AND ABS(IFNULL(created_at, 0) - ?) > 180 THEN 0
           ELSE created_block
         END,
         created_tx = CASE
           WHEN ? != '' THEN ?
           WHEN ? = 1 AND ABS(IFNULL(created_at, 0) - ?) > 180 THEN ''
           ELSE created_tx
         END,
         launch_checked_at = CASE WHEN ? = 1 THEN ? ELSE 0 END
     WHERE address = ?`,
  ).run(
    createdAt,
    block,
    block,
    confirmed,
    createdAt,
    tx,
    tx,
    confirmed,
    createdAt,
    confirmed,
    confirmed ? nowSec() : 0,
    String(address || "").toLowerCase(),
  );
}

export function listTokenAddresses(whereSql = "", params = []) {
  return db.prepare(`SELECT address FROM tokens ${whereSql}`).all(...params).map((row) => row.address);
}

export function listPaidBannerTargets() {
  return db
    .prepare(
      `SELECT t.address, IFNULL(t.banner_url, '') AS banner_url
       FROM tokens t
       JOIN token_paid p ON p.token_address = t.address
       GROUP BY t.address`,
    )
    .all();
}

export function listTokensForAth(limit = 20) {
  const now = nowSec();
  return db
    .prepare(
      `SELECT address FROM tokens
       WHERE ath_checked_at IS NULL
          OR (COALESCE(created_at, 0) >= ? AND ath_checked_at < ?)
          OR ath_checked_at < ?
       ORDER BY CASE WHEN ath_checked_at IS NULL THEN 0 ELSE 1 END,
                COALESCE(created_at, 0) DESC
       LIMIT ?`,
    )
    .all(now - 6 * 3600, now - 10 * 60, now - 6 * 3600, limit)
    .map((row) => row.address);
}

export function nextProfitToken(now) {
  return db
    .prepare(
      `SELECT address, symbol, created_at, created_block, profit_block, profit_checked_at
       FROM tokens
       WHERE profit_checked_at IS NULL
          OR (COALESCE(created_at, 0) >= ? AND profit_checked_at < ?)
          OR profit_checked_at < ?
       ORDER BY CASE WHEN profit_checked_at IS NULL THEN 0 ELSE 1 END,
                CASE WHEN profit_checked_at IS NULL THEN -COALESCE(created_at, 0) ELSE profit_checked_at END
       LIMIT 1`,
    )
    .get(now - 24 * 3600, now - 3 * 60, now - 15 * 60);
}

export function listProfitPairs(token) {
  return db
    .prepare("SELECT pair_address FROM token_pairs WHERE token_address = ?")
    .all(token)
    .map((row) => String(row.pair_address || "").toLowerCase())
    .filter((pair) => /^0x[a-f0-9]{40}$/.test(pair));
}

export function rememberSwapTxs(token, rows) {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO token_swaps(token_address, tx_hash, block_number) VALUES(?, ?, ?)",
  );
  db.exec("BEGIN");
  try {
    for (const row of rows) insert.run(token, row.hash, row.block);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function setProfitBlock(token, block) {
  db.prepare("UPDATE tokens SET profit_block = ? WHERE address = ?").run(block, token);
}

export function missingSwapTargets(token, limit) {
  return db
    .prepare(
      `SELECT tx_hash FROM token_swaps
       WHERE token_address = ? AND tx_to IS NULL
       ORDER BY block_number
       LIMIT ?`,
    )
    .all(token, limit)
    .map((row) => row.tx_hash);
}

export function saveSwapTarget(token, hash, to) {
  db.prepare("UPDATE token_swaps SET tx_to = ? WHERE token_address = ? AND tx_hash = ?").run(to, token, hash);
}

export function swapTargetCounts(token) {
  return db
    .prepare(
      `SELECT tx_to AS dest, COUNT(*) AS n
       FROM token_swaps
       WHERE token_address = ? AND tx_to IS NOT NULL AND tx_to != ''
       GROUP BY tx_to`,
    )
    .all(token);
}

export function listCreationSwaps() {
  return db
    .prepare(
      `SELECT s.token_address, s.tx_hash
       FROM token_swaps s
       JOIN tokens t ON t.address = s.token_address
       WHERE s.measured = 1 AND s.side IN ('buy', 'sell') AND IFNULL(s.tx_to, '') = ''
         AND NOT (IFNULL(t.created_block, 0) > 0 AND s.block_number = t.created_block)`,
    )
    .all();
}

export function nextUnmeasuredSwap(token, team) {
  const excluded = team.length ? team : ["__none__"];
  const marks = excluded.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT s.tx_hash, s.attempts
       FROM token_swaps s
       JOIN tokens t ON t.address = s.token_address
       WHERE s.token_address = ? AND s.measured = 0 AND IFNULL(s.tx_to, '') NOT IN (${marks})
         AND NOT (IFNULL(t.created_block, 0) > 0 AND s.block_number = t.created_block)
       ORDER BY s.attempts, s.block_number
       LIMIT 1`,
    )
    .get(token, ...excluded);
}

export function saveSwapMeasure(token, hash, side, wei) {
  db.prepare(
    `UPDATE token_swaps
     SET side = ?, amount_wei = ?, measured = 1, setup_checked = 1
     WHERE token_address = ? AND tx_hash = ?`,
  ).run(side, wei, token, hash);
}

export function nextSetupSwap() {
  return db
    .prepare(
      `SELECT s.token_address, s.tx_hash
       FROM token_swaps s
       JOIN tokens t ON t.address = s.token_address
       WHERE s.measured = 1 AND s.side IN ('buy', 'sell') AND IFNULL(s.setup_checked, 0) = 0
         AND NOT (IFNULL(t.created_block, 0) > 0 AND s.block_number = t.created_block)
       ORDER BY s.block_number DESC
       LIMIT 1`,
    )
    .get();
}

export function markSetupChecked(token, hash) {
  db.prepare("UPDATE token_swaps SET setup_checked = 1 WHERE token_address = ? AND tx_hash = ?").run(token, hash);
}

export function noteSwapAttempt(token, hash) {
  db.prepare("UPDATE token_swaps SET attempts = attempts + 1 WHERE token_address = ? AND tx_hash = ?").run(token, hash);
}

export function profitTotals(token, team) {
  const excluded = team.length ? team : ["__none__"];
  const marks = excluded.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT s.side, s.amount_wei
       FROM token_swaps s
       JOIN tokens t ON t.address = s.token_address
       WHERE s.token_address = ?
         AND s.measured = 1
         AND s.side IN ('buy', 'sell')
         AND IFNULL(s.tx_to, '') NOT IN (${marks})
         AND NOT (IFNULL(t.created_block, 0) > 0 AND s.block_number = t.created_block)`,
    )
    .all(token, ...excluded);
}

export function listStoredProfits() {
  return db
    .prepare(
      `SELECT address, symbol, profit_block, profit_checked_at
       FROM tokens
       WHERE profit_wei IS NOT NULL`,
    )
    .all();
}

export function saveTokenProfit(token, fields) {
  db.prepare(
    `UPDATE tokens
     SET profit_wei = ?, profit_buys = ?, profit_sells = ?, profit_block = ?, profit_checked_at = ?
     WHERE address = ?`,
  ).run(fields.wei, fields.buys, fields.sells, fields.block, fields.checkedAt, token);
}

export function saveTokenAth(address, ath) {
  const value = Number(ath);
  db.prepare("UPDATE tokens SET ath_market_cap = ?, ath_checked_at = ? WHERE address = ?").run(
    Number.isFinite(value) && value > 0 ? value : null,
    nowSec(),
    String(address).toLowerCase(),
  );
}

export function updateTokenMarket(address, fields) {
  const current = db.prepare("SELECT peak_liquidity_usd FROM tokens WHERE address = ?").get(address);
  if (!current) return;
  const peak = Math.max(Number(current.peak_liquidity_usd) || 0, Number(fields.peakLiquidityUsd) || 0);
  db.prepare(
    `UPDATE tokens SET
       pair_address = ?, dex = ?, price_usd = ?, liquidity_usd = ?, market_cap = ?, fdv = ?,
       volume_24h = ?, price_change_24h = ?, txns_24h = ?, txns_total = COALESCE(?, txns_total), peak_liquidity_usd = ?,
       pair_created_at = ?, status = ?, dextools_url = ?, dexscreener_url = ?, market_at = ?
     WHERE address = ?`,
  ).run(
    fields.pairAddress,
    fields.dex,
    fields.priceUsd,
    fields.liquidityUsd,
    fields.marketCap,
    fields.fdv,
    fields.volume24h,
    fields.priceChange24h,
    fields.txns24h,
    fields.txnsTotal == null ? null : fields.txnsTotal,
    peak,
    fields.pairCreatedAt,
    fields.status,
    fields.dextoolsUrl,
    fields.dexscreenerUrl,
    nowSec(),
    address,
  );
}

export function getToken(address) {
  return db.prepare("SELECT * FROM tokens WHERE address = ?").get(address);
}

export function listTokenSwaps(token) {
  return db
    .prepare(
      `SELECT tx_hash, block_number, tx_to, side, amount_wei, measured
       FROM token_swaps WHERE token_address = ?`,
    )
    .all(String(token || "").toLowerCase());
}

export function listTokenPairAddresses(token) {
  return listBuyerPairs(token).map((pair) => pair.address);
}

export function listBuyerPairs(token) {
  return db
    .prepare(
      `SELECT pair_address, IFNULL(txns_total, 0) AS txns_total
       FROM token_pairs WHERE token_address = ?`,
    )
    .all(String(token || "").toLowerCase())
    .map((row) => ({
      address: String(row.pair_address || "").toLowerCase(),
      txns: Number(row.txns_total) || 0,
    }))
    .filter((pair) => /^0x[a-f0-9]{40}$/.test(pair.address) || /^0x[a-f0-9]{64}$/.test(pair.address));
}

export function mainTokenPair(token) {
  const address = String(token || "").toLowerCase();
  const row = db
    .prepare(
      `SELECT pair_address FROM token_pairs
       WHERE token_address = ? AND IFNULL(pair_address, '') != ''
       ORDER BY is_main DESC, IFNULL(txns_total, 0) DESC, IFNULL(liquidity_usd, 0) DESC
       LIMIT 1`,
    )
    .get(address);
  const pair = String(row?.pair_address || "").toLowerCase();
  if (/^0x[a-f0-9]{40}$/.test(pair) || /^0x[a-f0-9]{64}$/.test(pair)) return pair;
  const saved = getToken(address);
  const fallback = String(saved?.pair_address || "").toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(fallback) || /^0x[a-f0-9]{64}$/.test(fallback) ? fallback : "";
}

export function setTokenLogo(address, url) {
  const logo = String(url || "").trim();
  if (!logo.startsWith("https://")) return;
  const current = db.prepare("SELECT logo_url FROM tokens WHERE address = ?").get(String(address).toLowerCase());
  if (!current) return;
  const existing = current.logo_url || "";
  if (existing.includes("cdn.dexscreener.com")) return;
  if (existing && !logo.includes("cdn.dexscreener.com")) return;
  if (existing === logo) return;
  db.prepare("UPDATE tokens SET logo_url = ? WHERE address = ?").run(logo, String(address).toLowerCase());
}

export function setTokenBanner(address, url) {
  const banner = String(url || "").trim();
  if (!banner.startsWith("https://")) return;
  const current = db.prepare("SELECT banner_url FROM tokens WHERE address = ?").get(String(address).toLowerCase());
  if (!current || current.banner_url === banner) return;
  db.prepare("UPDATE tokens SET banner_url = ? WHERE address = ?").run(banner, String(address).toLowerCase());
}

export function savePaid(event) {
  const paidAt = Number(event.paidAt) || 0;
  const amount = event.amount == null ? null : Number(event.amount);
  const silent = paidAt > 0 && paidAt < Number(event.baseline);
  const stale = paidAt > 0 && nowSec() - paidAt > 180;
  const hold = silent || stale;
  const existing = db
    .prepare("SELECT paid_at, detail, amount, alerted FROM token_paid WHERE fingerprint = ?")
    .get(event.fingerprint);
  if (!existing) {
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO token_paid(
           fingerprint, token_address, source, kind, amount, paid_at, detail, alerted, created_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.fingerprint,
        String(event.tokenAddress).toLowerCase(),
        event.source,
        event.kind,
        amount,
        paidAt || null,
        event.detail,
        hold ? 1 : 0,
        nowSec(),
      );
    return Number(result.changes) > 0 && !hold;
  }
  const same =
    Number(existing.paid_at) === paidAt &&
    existing.detail === event.detail &&
    Number(existing.amount || 0) === Number(amount || 0);
  if (same) {
    if (hold && !existing.alerted) {
      db.prepare("UPDATE token_paid SET alerted = 1 WHERE fingerprint = ?").run(event.fingerprint);
    }
    return false;
  }
  db.prepare("UPDATE token_paid SET amount = ?, paid_at = ?, detail = ?, alerted = ? WHERE fingerprint = ?").run(
    amount,
    paidAt || null,
    event.detail,
    hold ? 1 : 0,
    event.fingerprint,
  );
  return !hold;
}

export function listUnalertedPaid() {
  return db
    .prepare(
      `SELECT p.fingerprint, p.token_address, p.source, p.kind, p.amount, p.paid_at, p.detail,
              t.symbol, t.name, t.deployer, t.pair_address, t.dextools_url, t.dexscreener_url, t.banner_url,
              t.liquidity_usd, t.market_cap, t.volume_24h, t.price_change_24h, t.created_at, t.pair_created_at,
              p.created_at AS detected_at
       FROM token_paid p JOIN tokens t ON t.address = p.token_address
       WHERE p.alerted = 0
       ORDER BY p.paid_at ASC`,
    )
    .all();
}

export function markPaidAlerted(fingerprint) {
  db.prepare("UPDATE token_paid SET alerted = 1 WHERE fingerprint = ?").run(fingerprint);
}

export function replaceTokenPairs(tokenAddress, pairs) {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM token_pairs WHERE token_address = ?").run(tokenAddress);
    const insert = db.prepare(
      `INSERT INTO token_pairs(
         pair_address, token_address, dex, label, quote_symbol, price_usd, liquidity_usd, market_cap,
         volume_24h, price_change_24h, txns_24h, txns_total, is_main, pair_created_at, status, dextools_url, dexscreener_url, updated_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const seen = new Set();
    for (const pair of pairs) {
      const key = String(pair.pairAddress || "").toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      insert.run(
        pair.pairAddress,
        tokenAddress,
        pair.dex,
        pair.label,
        pair.quoteSymbol,
        pair.priceUsd,
        pair.liquidityUsd,
        pair.marketCap,
        pair.volume24h,
        pair.priceChange24h,
        pair.txns24h,
        pair.txnsTotal ?? null,
        pair.isMain ? 1 : 0,
        pair.pairCreatedAt,
        pair.status,
        pair.dextoolsUrl,
        pair.dexscreenerUrl,
        nowSec(),
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function countTokensForDeployer(address) {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM tokens WHERE deployer = ?").get(address).n);
}

export function pruneLargeFundings(maxWei) {
  const limit = BigInt(maxWei);
  const rows = db.prepare("SELECT id, deployer, value_wei FROM fundings").all();
  const remove = db.prepare("DELETE FROM fundings WHERE id = ?");
  for (const row of rows) {
    if (BigInt(row.value_wei) <= limit) continue;
    if (countTokensForDeployer(row.deployer) === 0) remove.run(row.id);
  }
  const orphans = db
    .prepare(
      `SELECT address FROM deployers
       WHERE address NOT IN (SELECT deployer FROM fundings)
         AND address NOT IN (SELECT deployer FROM tokens)`,
    )
    .all();
  const removeDeployer = db.prepare("DELETE FROM deployers WHERE address = ?");
  for (const row of orphans) removeDeployer.run(row.address);
}

export function addEvent({ kind, message, competitorId, address }) {
  db.prepare(
    `INSERT INTO events(kind, message, competitor_id, address, created_at, seen) VALUES(?, ?, ?, ?, ?, 0)`,
  ).run(kind, message, competitorId ?? null, address ?? null, nowSec());
}

export function markEventsSeen() {
  db.prepare("UPDATE events SET seen = 1 WHERE seen = 0").run();
}

export function hasEvent(kind, address) {
  return Boolean(db.prepare("SELECT id FROM events WHERE kind = ? AND address = ? LIMIT 1").get(kind, address));
}

export function requeueIgnored() {
  const result = db
    .prepare("UPDATE deployers SET status = 'queued', last_checked_at = NULL, note = '' WHERE status = 'ignored'")
    .run();
  return Number(result.changes);
}

function rowsByKey(rows, key) {
  const grouped = new Map();
  for (const row of rows) {
    const bag = grouped.get(row[key]) || {};
    bag[row.status] = Number(row.n);
    grouped.set(row[key], bag);
  }
  return grouped;
}

function fundingsFor(addresses) {
  const grouped = new Map();
  const unique = [...new Set(addresses.filter(Boolean))];
  for (let index = 0; index < unique.length; index += 400) {
    const chunk = unique.slice(index, index + 400);
    const marks = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT f.*, c.label, c.color, c.address AS competitor_address
         FROM fundings f JOIN competitors c ON c.id = f.competitor_id
         WHERE f.deployer IN (${marks})
         ORDER BY f.timestamp ASC`,
      )
      .all(...chunk);
    for (const funding of rows) {
      const list = grouped.get(funding.deployer) || [];
      list.push(funding);
      grouped.set(funding.deployer, list);
    }
  }
  return grouped;
}

let snapshotCountCache = null;

function loadSnapshotCounts() {
  if (snapshotCountCache && Date.now() - snapshotCountCache.at < 20000) return snapshotCountCache;
  const deployerStatus = rowsByKey(
    db
      .prepare(
        `SELECT competitor_id, status, COUNT(*) AS n
         FROM (
           SELECT f.competitor_id, d.address, d.status
           FROM fundings f JOIN deployers d ON d.address = f.deployer
           GROUP BY f.competitor_id, d.address
         )
         GROUP BY competitor_id, status`,
      )
      .all(),
    "competitor_id",
  );
  const tokenStatus = rowsByKey(
    db
      .prepare(
        `SELECT f.competitor_id, t.status, COUNT(DISTINCT t.address) AS n
         FROM fundings f JOIN tokens t ON t.deployer = f.deployer
         GROUP BY f.competitor_id, t.status`,
      )
      .all(),
    "competitor_id",
  );
  const trackedByRival = new Map(
    db
      .prepare("SELECT competitor_id, COUNT(DISTINCT deployer) AS n FROM fundings GROUP BY competitor_id")
      .all()
      .map((row) => [row.competitor_id, Number(row.n)]),
  );
  snapshotCountCache = { at: Date.now(), deployerStatus, tokenStatus, trackedByRival };
  return snapshotCountCache;
}

export function snapshot() {
  const { deployerStatus, tokenStatus, trackedByRival } = loadSnapshotCounts();
  const competitors = listCompetitors().map((competitor) => {
    const wallets = deployerStatus.get(competitor.id) || {};
    const launched = tokenStatus.get(competitor.id) || {};
    const tokens = Object.values(launched).reduce((sum, count) => sum + count, 0);
    return {
      ...competitor,
      waiting: wallets.waiting || 0,
      queued: wallets.queued || 0,
      live: launched.live || 0,
      rugged: launched.rugged || 0,
      tokens,
      tracked: trackedByRival.get(competitor.id) || 0,
    };
  });

  const deployerRows = db
    .prepare(
      `SELECT * FROM deployers
       WHERE status != 'ignored'
       ORDER BY CASE status WHEN 'waiting' THEN 0 WHEN 'queued' THEN 1 WHEN 'launched' THEN 2 ELSE 3 END,
                first_funded_at DESC
       LIMIT 2000`,
    )
    .all();
  const tokenRows = db
    .prepare("SELECT * FROM tokens ORDER BY COALESCE(pair_created_at, created_at) DESC LIMIT 2000")
    .all();
  const fundingByDeployer = fundingsFor([
    ...deployerRows.map((deployer) => deployer.address),
    ...tokenRows.map((token) => token.deployer),
  ]);
  const deployers = deployerRows.map((deployer) => ({
    ...deployer,
    fundings: fundingByDeployer.get(deployer.address) || [],
  }));

  const pairRows = db.prepare("SELECT * FROM token_pairs").all();
  const pairsByToken = new Map();
  for (const pair of pairRows) {
    const list = pairsByToken.get(pair.token_address) || [];
    list.push(pair);
    pairsByToken.set(pair.token_address, list);
  }

  const paidRows = db.prepare("SELECT * FROM token_paid ORDER BY paid_at DESC").all();
  const paidByToken = new Map();
  for (const payment of paidRows) {
    const list = paidByToken.get(payment.token_address) || [];
    list.push(payment);
    paidByToken.set(payment.token_address, list);
  }

  const tokens = tokenRows.map((token) => ({
    ...token,
    fundings: fundingByDeployer.get(token.deployer) || [],
    pairs: pairsByToken.get(token.address) || [],
    payments: paidByToken.get(token.address) || [],
  }));

  const events = db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT 40").all();
  const unseen = Number(db.prepare("SELECT COUNT(*) AS n FROM events WHERE seen = 0").get().n);
  const counts = {
    rivals: competitors.length,
    waiting: Number(db.prepare("SELECT COUNT(*) AS n FROM deployers WHERE status = 'waiting'").get().n),
    queued: Number(db.prepare("SELECT COUNT(*) AS n FROM deployers WHERE status = 'queued'").get().n),
    drained: Number(db.prepare("SELECT COUNT(*) AS n FROM deployers WHERE status = 'drained'").get().n),
    ignored: Number(db.prepare("SELECT COUNT(*) AS n FROM deployers WHERE status = 'ignored'").get().n),
    live: Number(db.prepare("SELECT COUNT(*) AS n FROM tokens WHERE status = 'live'").get().n),
    thin: Number(db.prepare("SELECT COUNT(*) AS n FROM tokens WHERE status = 'thin'").get().n),
    rugged: Number(db.prepare("SELECT COUNT(*) AS n FROM tokens WHERE status = 'rugged'").get().n),
    unlisted: Number(db.prepare("SELECT COUNT(*) AS n FROM tokens WHERE status = 'unlisted'").get().n),
    tokens: Number(db.prepare("SELECT COUNT(*) AS n FROM tokens").get().n),
    buyers: Number(db.prepare("SELECT COUNT(*) AS n FROM buyers").get().n),
    liquidity: Number(db.prepare("SELECT COALESCE(SUM(liquidity_usd), 0) AS n FROM tokens WHERE status = 'live'").get().n),
    unseen,
  };

  const settings = getSettings();
  const etherscanKeys = parseApiKeys(settings.etherscanApiKey);
  const preview = etherscanKeys.slice(0, 4).map((key) => `${key.slice(0, 3)}…${key.slice(-4)}`);
  const extra = etherscanKeys.length > preview.length ? ` +${etherscanKeys.length - preview.length} more` : "";
  return {
    competitors,
    buyers: listBuyers(),
    buyerTrades: listBuyerTrades(),
    deployers,
    tokens,
    events,
    counts,
    settings: {
      ...settings,
      etherscanApiKey: "",
      etherscanKeyCount: etherscanKeys.length,
      etherscanApiKeySet: etherscanKeys.length > 0,
      etherscanApiKeyHint: preview.length ? `${preview.join(", ")}${extra}` : "",
      telegramBotToken: "",
      telegramBotTokenSet: Boolean(settings.telegramBotToken),
      telegramUpdateOffset: undefined,
      buyerBotToken: "",
      buyerBotTokenSet: Boolean(settings.buyerBotToken),
      buyerUpdateOffset: undefined,
      liveSeenBlock: undefined,
    },
    telegramChats: listTelegramChats().map((chat) => ({
      name: chat.name || chat.username || "Teammate",
      username: chat.username,
    })),
    buyerChats: listBuyerChats().map((chat) => ({
      name: chat.name || chat.username || "Teammate",
      username: chat.username,
    })),
  };
}

export function deployerDetail(address) {
  const deployer = getDeployer(address);
  if (!deployer) return null;
  const fundings = listFundingsForDeployer(address);
  const tokens = db.prepare("SELECT * FROM tokens WHERE deployer = ? ORDER BY created_at DESC").all(address);
  return { deployer, fundings, tokens };
}

export { normalizeAddress };
