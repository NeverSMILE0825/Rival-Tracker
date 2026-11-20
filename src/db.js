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
  paidBaseline: "",
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

const pairColumns = db.prepare("PRAGMA table_info(token_pairs)").all();
if (!pairColumns.some((column) => column.name === "quote_symbol")) {
  db.exec("ALTER TABLE token_pairs ADD COLUMN quote_symbol TEXT");
}

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
       decimals = excluded.decimals`,
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
        silent ? 1 : 0,
        nowSec(),
      );
    return Number(result.changes) > 0 && !silent;
  }
  const same =
    Number(existing.paid_at) === paidAt &&
    existing.detail === event.detail &&
    Number(existing.amount || 0) === Number(amount || 0);
  if (same) return false;
  db.prepare("UPDATE token_paid SET amount = ?, paid_at = ?, detail = ?, alerted = ? WHERE fingerprint = ?").run(
    amount,
    paidAt || null,
    event.detail,
    silent ? existing.alerted : 0,
    event.fingerprint,
  );
  return !silent;
}

export function listUnalertedPaid() {
  return db
    .prepare(
      `SELECT p.fingerprint, p.token_address, p.source, p.kind, p.amount, p.paid_at, p.detail,
              t.symbol, t.name, t.deployer, t.pair_address, t.dextools_url, t.dexscreener_url, t.banner_url
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
         volume_24h, price_change_24h, txns_24h, pair_created_at, status, dextools_url, dexscreener_url, updated_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

export function snapshot() {
  const competitors = listCompetitors().map((competitor) => {
    const waiting = Number(
      db.prepare(
        `SELECT COUNT(DISTINCT f.deployer) AS n
         FROM fundings f JOIN deployers d ON d.address = f.deployer
         WHERE f.competitor_id = ? AND d.status = 'waiting'`,
      ).get(competitor.id).n,
    );
    const queued = Number(
      db.prepare(
        `SELECT COUNT(DISTINCT f.deployer) AS n
         FROM fundings f JOIN deployers d ON d.address = f.deployer
         WHERE f.competitor_id = ? AND d.status = 'queued'`,
      ).get(competitor.id).n,
    );
    const live = Number(
      db.prepare(
        `SELECT COUNT(DISTINCT t.address) AS n
         FROM fundings f JOIN tokens t ON t.deployer = f.deployer
         WHERE f.competitor_id = ? AND t.status = 'live'`,
      ).get(competitor.id).n,
    );
    const rugged = Number(
      db.prepare(
        `SELECT COUNT(DISTINCT t.address) AS n
         FROM fundings f JOIN tokens t ON t.deployer = f.deployer
         WHERE f.competitor_id = ? AND t.status = 'rugged'`,
      ).get(competitor.id).n,
    );
    const tokens = Number(
      db.prepare(
        `SELECT COUNT(DISTINCT t.address) AS n
         FROM fundings f JOIN tokens t ON t.deployer = f.deployer
         WHERE f.competitor_id = ?`,
      ).get(competitor.id).n,
    );
    const tracked = Number(
      db.prepare("SELECT COUNT(DISTINCT deployer) AS n FROM fundings WHERE competitor_id = ?").get(competitor.id).n,
    );
    return { ...competitor, waiting, queued, live, rugged, tokens, tracked };
  });

  const fundings = db
    .prepare(
      `SELECT f.*, c.label, c.color, c.address AS competitor_address
       FROM fundings f JOIN competitors c ON c.id = f.competitor_id
       ORDER BY f.timestamp ASC`,
    )
    .all();
  const fundingByDeployer = new Map();
  for (const funding of fundings) {
    const list = fundingByDeployer.get(funding.deployer) || [];
    list.push(funding);
    fundingByDeployer.set(funding.deployer, list);
  }

  const deployers = db
    .prepare(
      `SELECT * FROM deployers
       WHERE status != 'ignored'
       ORDER BY CASE status WHEN 'waiting' THEN 0 WHEN 'queued' THEN 1 WHEN 'launched' THEN 2 ELSE 3 END,
                first_funded_at DESC
       LIMIT 2000`,
    )
    .all()
    .map((deployer) => ({
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

  const tokens = db
    .prepare("SELECT * FROM tokens ORDER BY COALESCE(pair_created_at, created_at) DESC LIMIT 2000")
    .all()
    .map((token) => ({
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
    liquidity: Number(db.prepare("SELECT COALESCE(SUM(liquidity_usd), 0) AS n FROM tokens WHERE status = 'live'").get().n),
    unseen,
  };

  const settings = getSettings();
  const etherscanKeys = parseApiKeys(settings.etherscanApiKey);
  const preview = etherscanKeys.slice(0, 4).map((key) => `${key.slice(0, 3)}…${key.slice(-4)}`);
  const extra = etherscanKeys.length > preview.length ? ` +${etherscanKeys.length - preview.length} more` : "";
  return {
    competitors,
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
    },
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
