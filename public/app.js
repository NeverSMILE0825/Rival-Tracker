const state = {
  data: null,
  route: location.hash.replace("#/", "") || "overview",
  tokenStatus: "all",
  walletStatus: "waiting",
  rival: "all",
  query: "",
  modal: null,
  drawer: null,
  etherscanMode: "type",
  etherscanDraft: "",
  etherscanFileName: "",
  scanRangeMode: "",
  settingsDraft: null,
  settingsTab: "scan",
  picker: null,
  pageSize: 50,
  pages: { waiting: 1, tokens: 1, buyers: 1, realBuyers: 1 },
  buyerFilter: "all",
  mainV4: true,
  paidOnly: false,
  sort: { tokens: { key: "launched", dir: "desc" }, buyers: { key: "time", dir: "desc" }, realBuyers: { key: "time", dir: "desc" }, trends: { key: "count", dir: "desc" } },
  trendWindow: "1h",
  trendMin: "",
  trendOpen: "",
  trends: null,
  realBuyers: null,
  buyerChart: null,
  realPageSize: 25,
  realSpan: { from: "", fromUnit: "m", to: "", toUnit: "h" },
  tradeFilter: { address: "", side: "all", minEth: "", maxEth: "" },
  chartAxis: "mcap",
  walletChart: null,
  walletAxis: "amount",
  walletFilter: { side: "all", minEth: "", maxEth: "", start: "", end: "", query: "" },
  walletPicker: null,
};

const TITLES = {
  overview: ["Overview", "Waiting wallets, latest launches, and recent activity."],
  waiting: ["Waiting to launch", "Fresh wallets that received ETH from a rival and have not deployed a token."],
  tokens: ["Tokens", "Tokens deployed by those funded wallets, with pool, liquidity, and Dextools."],
  rivals: ["Rivals", "Add, rename, or remove the wallets you want to follow."],
  buyers: ["Buyers", "Wallets to follow when they buy or sell a rival token. Tracking runs on its own and does not wait on launch detection."],
  trends: ["Trends", "Every ETH and WETH pair on Dextools live, grouped by the name or ticker they share."],
  settings: ["Settings", "Scan, funding, Etherscan, Telegram, buyers, and trends."],
};

const COLORS = ["#d6f25c", "#ffb020", "#8eb6ff", "#c9a6ff", "#79e3d6", "#ff8f70", "#ffd6e0", "#ffffff"];

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function shortAddr(value) {
  if (!value) return "";
  if (value.length <= 16) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function copyIcon(value) {
  return `<button type="button" class="icon-btn copy-icon" data-act="copy" data-value="${esc(value)}" aria-label="Copy address" title="Copy address"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="none" stroke="currentColor" stroke-width="1.8" d="M6 16H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>`;
}

const ACTION_ICONS = {
  add: `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M12 5v14M5 12h14"/></svg>`,
  edit: `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M13.5 6.5l3 3"/></svg>`,
  delete: `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13M10 11v6M14 11v6"/></svg>`,
  chart: `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M4 19V5M4 19h16"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M7 15l4-5 3 3 5-7"/></svg>`,
};

function iconAction({ kind, label, act = "", id = "", type = "button", extra = "" }) {
  const tone = kind === "delete" ? " danger" : kind === "add" ? " primary" : "";
  const actAttr = act ? ` data-act="${esc(act)}"` : "";
  const idAttr = id !== "" && id != null ? ` data-id="${esc(id)}"` : "";
  return `<button type="${type}" class="btn icon-act${tone}"${actAttr}${idAttr}${extra} aria-label="${esc(label)}" title="${esc(label)}">${ACTION_ICONS[kind]}</button>`;
}

function formatEth(wei) {
  if (wei == null || wei === "") return "—";
  const value = BigInt(wei);
  const whole = value / 10n ** 18n;
  const frac = (value % 10n ** 18n).toString().padStart(18, "0").slice(0, 4).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

function zoneOffset() {
  const offset = Number(state.data?.settings?.timezoneOffset ?? 9);
  return Number.isInteger(offset) && offset >= -12 && offset <= 14 ? offset : 9;
}

function zoneLabel() {
  const offset = zoneOffset();
  if (offset === 0) return "UTC";
  return `UTC${offset > 0 ? "+" : ""}${offset}`;
}

function activeZoneOffset() {
  const raw = document.querySelector("[name=timezoneOffset]")?.value;
  const offset = Number(raw);
  if (Number.isInteger(offset) && offset >= -12 && offset <= 14) return offset;
  return zoneOffset();
}

function zonedNowParts() {
  const shifted = new Date(Date.now() + activeZoneOffset() * 3600 * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return {
    scanEndDate: `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`,
    scanEndHour: pad(shifted.getUTCHours()),
    scanEndMinute: pad(shifted.getUTCMinutes()),
    scanEndSecond: pad(shifted.getUTCSeconds()),
  };
}

function formatKst(unix) {
  if (!unix) return "—";
  const date = new Date((Number(unix) + zoneOffset() * 3600) * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function formatAge(unix) {
  if (!unix) return "—";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - Number(unix));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

function exactUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "";
  return `$${number.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  if (number >= 1e9) return `$${(number / 1e9).toFixed(2)}B`;
  if (number >= 1e6) return `$${(number / 1e6).toFixed(2)}M`;
  if (number >= 1e3) return `$${(number / 1e3).toFixed(1)}K`;
  if (number >= 1) return `$${number.toFixed(2)}`;
  if (number === 0) return "$0";
  return `$${number.toPrecision(2)}`;
}

function formatPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  if (number >= 1000) return `$${number.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  if (number >= 1) return `$${number.toFixed(2)}`;
  if (number >= 0.01) return `$${number.toFixed(4)}`;
  if (number >= 0.0001) return `$${number.toFixed(6)}`;
  if (number === 0) return "$0";
  if (number < 1e-10) return `$${number.toExponential(2)}`;
  return `$${number.toFixed(10).replace(/0+$/, "")}`;
}

function formatChange(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  const sign = number > 0 ? "+" : "";
  if (Math.abs(number) >= 1000) return `${sign}${(number / 1000).toFixed(1)}k%`;
  return `${sign}${number.toFixed(1)}%`;
}

function formatCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return Math.round(number).toLocaleString();
}

function launchedAt(token) {
  return launchStamp(token.created_at, token.created_block, token.pair_created_at);
}

function launchStamp(createdAt, createdBlock, pairAt) {
  const created = Number(createdAt) || 0;
  const pair = Number(pairAt) || 0;
  if (created && Number(createdBlock) > 0) return created;
  if (created && (!pair || created <= pair)) return created;
  return pair || created || null;
}

function rivalsOf(fundings) {
  const map = new Map();
  for (const funding of fundings || []) map.set(funding.competitor_id, funding);
  return [...map.values()];
}

function rivalLabel(fundings) {
  return rivalsOf(fundings).map((funding) => funding.label).join(", ") || "—";
}

function toast(message) {
  const node = document.getElementById("toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => node.classList.remove("show"), 1800);
}

async function api(url, options) {
  const response = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...options,
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}

async function load(options = {}) {
  state.data = await api("/api/snapshot");
  state.forceView = Boolean(options.fresh);
  paint();
  state.forceView = false;
}

function scanning() {
  return Boolean(state.data?.scan?.running);
}

function paint() {
  const data = state.data;
  if (!data) return;
  if (!document.getElementById("view")) {
    document.getElementById("app").innerHTML = `
      <div class="shell">
        <aside class="side">
          <div class="brand"><div class="mark">R</div><div><h1>Rival Tracker</h1><p>Ethereum</p></div></div>
          <nav class="nav" id="nav"></nav>
          <p class="hint">Funded wallets, the tokens they launch, and paid promotions.</p>
        </aside>
        <main class="main">
          <div class="top">
            <div><h2 id="title"></h2><p class="sub" id="sub"></p></div>
            <div class="actions" id="actions"></div>
          </div>
          <div class="scanline" id="scanline"></div>
          <div id="view"></div>
        </main>
      </div>`;
    if (!document.documentElement.dataset.bound) {
      document.body.addEventListener("click", onClick);
      document.body.addEventListener("mouseover", onChartHover);
      window.addEventListener("wheel", onChartWheel, { passive: false, capture: true });
      window.addEventListener("pointerdown", onChartPointerDown, true);
      window.addEventListener("pointermove", onChartPointerMove, true);
      window.addEventListener("pointerup", onChartPointerUp, true);
      window.addEventListener("pointercancel", onChartPointerUp, true);
      document.body.addEventListener("submit", onSubmit);
      document.body.addEventListener("input", onInput);
      document.body.addEventListener("change", onKeyFile);
      document.documentElement.dataset.bound = "1";
    }
  }
  paintNav();
  paintActions();
  paintScan();
  const view = document.getElementById("view");
  const field = document.activeElement;
  const typing = field && view?.contains(field) && field.matches("input, textarea");
  const typingName = typing && field.name ? field.name : "";
  const typingAct = typing ? field.dataset.act || "" : "";
  const caret = typing ? field.selectionStart : null;
  const caretEnd = typing ? field.selectionEnd : null;
  if (!state.modal) paintView();
  const focusQuery = typingName ? `[name="${CSS.escape(typingName)}"]` : typingAct ? `[data-act="${CSS.escape(typingAct)}"]` : "";
  if (focusQuery) {
    const next = view.querySelector(focusQuery);
    if (next && document.activeElement !== next) {
      next.focus();
      if (caret != null && next.setSelectionRange) next.setSelectionRange(caret, caretEnd);
    }
  }
  paintRivalProgress();
  paintModal();
  paintDrawer();
  paintRealBuyers();
  paintBuyerChart();
  paintWalletChart();
  if (state.route === "trends") ensureTrends();
}

function paintNav() {
  const counts = state.data.counts;
  const items = [
    ["overview", "Overview", ""],
    ["waiting", "Waiting", counts.waiting],
    ["tokens", "Tokens", counts.tokens],
    ["rivals", "Rivals", counts.rivals],
    ["buyers", "Buyers", counts.buyers || 0],
    ["trends", "Trends", ""],
    ["settings", "Settings", ""],
  ];
  const html = items
    .map(
      ([id, label, count]) =>
        `<button data-act="route" data-route="${id}" class="${state.route === id ? "active" : ""}"><span>${label}</span>${
          count !== "" ? `<b class="count">${count}</b>` : ""
        }</button>`,
    )
    .join("");
  const node = document.getElementById("nav");
  if (node.dataset.sig === html) return;
  node.dataset.sig = html;
  node.innerHTML = html;
}

function paintActions() {
  const running = scanning();
  const live = state.data.settings.live === "1";
  const fast = state.data.settings.fastMode === "1";
  const html = `
    <button class="btn live-toggle ${live ? "on" : ""}" data-act="live" aria-pressed="${live ? "true" : "false"}"><span class="dot ${live ? "live" : ""}"></span>Live</button>
    <button class="btn live-toggle ${fast ? "on" : ""}" data-act="fast" aria-pressed="${fast ? "true" : "false"}"><span class="dot ${fast ? "live" : ""}"></span>Fast Mode</button>
    <button class="btn" data-act="refresh-prices">Refresh prices</button>
    ${running ? `<button class="btn danger" data-act="stop">Stop scan</button>` : `<button class="btn primary" data-act="scan-all">Scan all</button>`}
  `;
  const node = document.getElementById("actions");
  if (node.dataset.sig === html) return;
  node.dataset.sig = html;
  node.innerHTML = html;
}

function paintRivalProgress() {
  if (state.route !== "rivals" || !state.data) return;
  for (const rival of state.data.competitors) {
    const card = document.querySelector(`[data-rival-card="${rival.id}"]`);
    if (!card) continue;
    const percent = scanPercentOf(rival);
    const meter = card.querySelector(".scan-meter");
    const fill = card.querySelector(".scan-fill");
    const label = card.querySelector(".scan-pct");
    const detail = card.querySelector(".scan-detail");
    const note = card.querySelector(".scan-note");
    if (meter) meter.setAttribute("aria-valuenow", String(percent));
    if (fill) {
      fill.style.width = `${percent}%`;
      fill.classList.toggle("done", percent >= 100);
    }
    if (label) label.textContent = `${percent}%`;
    const eta = card.querySelector(".scan-eta");
    if (eta) eta.textContent = rival.scan_eta || "";
    if (detail) detail.textContent = rival.scan_detail || "";
    if (note) note.textContent = scanNote(rival);
  }
}

function paintScan() {
  const scan = state.data.scan;
  const running = scan.running;
  const text = running
    ? `${scan.label || "Rival"} · ${scan.note || "Working"}`
    : scan.note || "Idle. Scan a rival to pull funded wallets and their tokens.";
  const html = `<span class="dot ${running ? "run" : "live"}"></span><span>${esc(text)}</span>`;
  const node = document.getElementById("scanline");
  if (node.dataset.sig === html) return;
  node.dataset.sig = html;
  node.innerHTML = html;
}

function paintView() {
  const [title, fallbackSub] = TITLES[state.route] || TITLES.overview;
  const sub = state.route === "settings" ? settingsTabMeta()[2] : fallbackSub;
  document.getElementById("title").textContent = title;
  document.getElementById("sub").textContent = sub;
  captureSettingsDraft();
  const view = document.getElementById("view");
  const scroller = view.querySelector(".table-scroll");
  const scrollTop = scroller ? scroller.scrollTop : 0;
  const scrollLeft = scroller ? scroller.scrollLeft : 0;
  const html = {
    overview: viewOverview,
    waiting: viewWallets,
    tokens: viewTokens,
    rivals: viewRivals,
    buyers: viewBuyers,
    trends: viewTrends,
    settings: viewSettings,
  }[state.route]();
  const key = [
    state.route,
    state.query,
    state.tokenStatus,
    state.walletStatus,
    state.rival,
    state.etherscanMode,
    state.etherscanFileName,
    state.scanRangeMode || state.data?.settings?.scanRangeMode || "date",
    settingsTabId(),
    state.pageSize,
    state.pages[state.route] || 1,
    state.mainV4 ? "main" : "allpairs",
    state.paidOnly ? "paid" : "any",
    state.sort[state.route]?.key || "",
    state.sort[state.route]?.dir || "",
    state.trendWindow,
    state.trendMin,
    state.trendOpen,
    state.trends?.window || "",
    state.trends?.pairs || 0,
    state.trends?.rows?.length || 0,
    state.trends?.rows?.[0]?.count || 0,
    state.trends?.coverage?.oldest || 0,
    state.trends?.loading ? "loading" : "ready",
    state.trends?.at || 0,
    state.buyerFilter,
    (state.data.buyers || []).map((buyer) => `${buyer.id}:${buyer.label}:${buyer.address}`).join(","),
    state.data.buyerTrades?.[0]?.id || 0,
    (state.data.buyerTrades || []).length,
    (state.data.telegramChats || []).map((chat) => `${chat.name}:${chat.username || ""}`).join(","),
  ].join("|");
  const y = window.scrollY;
  const previous = view.dataset.key;
  if (!state.forceView && previous === key && Date.now() - Number(view.dataset.at || 0) < 8000) return;
  view.dataset.key = key;
  view.dataset.at = String(Date.now());
  view.innerHTML = html;
  window.scrollTo(0, y);
  const nextScroller = view.querySelector(".table-scroll");
  if (nextScroller && previous === key) {
    nextScroller.scrollTop = scrollTop;
    nextScroller.scrollLeft = scrollLeft;
  }
  placeOpenPicker();
}

function viewOverview() {
  const counts = state.data.counts;
  const waiting = state.data.deployers
    .filter((wallet) => wallet.status === "waiting")
    .sort((a, b) => Number(b.first_funded_at) - Number(a.first_funded_at))
    .slice(0, 8);
  const tokens = [...state.data.tokens].sort((a, b) => Number(launchedAt(b)) - Number(launchedAt(a))).slice(0, 8);
  const events = state.data.events || [];
  return `
    <div class="overview">
      <section class="stats">
        ${stat("Waiting", counts.waiting)}
        ${stat("Live", counts.live)}
        ${stat("Rugged", counts.rugged)}
        ${stat("Liquidity", formatUsd(counts.liquidity))}
        ${stat("Checking", counts.queued)}
      </section>
      <div class="overview-board">
        <section class="card">
          <div class="panel-head">
            <h3>Fresh wallets</h3>
            <button class="panel-link" type="button" data-act="route" data-route="waiting">Open</button>
          </div>
          <div class="ov-scroll">
            ${waiting.length ? waiting.map(walletLine).join("") : `<p class="muted">No wallets are waiting.</p>`}
          </div>
        </section>
        <section class="card">
          <div class="panel-head">
            <h3>Latest tokens</h3>
            <button class="panel-link" type="button" data-act="route" data-route="tokens">Open</button>
          </div>
          <div class="ov-scroll">
            ${tokens.length ? tokens.map(tokenLine).join("") : `<p class="muted">No tokens yet.</p>`}
          </div>
        </section>
        <section class="card">
          <div class="panel-head">
            <h3>Activity${counts.unseen ? ` <span class="pill live">${esc(counts.unseen)}</span>` : ""}</h3>
            <button class="panel-link" type="button" data-act="read">Mark read</button>
          </div>
          <div class="ov-scroll">
            ${
              events.length
                ? events
                    .map(
                      (event) =>
                        `<div class="ov-event ${event.seen ? "" : "unseen"}"><b>${esc(event.kind)}</b><span>${esc(event.message)}</span><small>${esc(formatAge(event.created_at))}</small></div>`,
                    )
                    .join("")
                : `<p class="muted">Scans write a line here when a wallet is funded or a token launches.</p>`
            }
          </div>
        </section>
      </div>
    </div>`;
}

function stat(label, value) {
  return `<div class="stat"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
}

function walletLine(wallet) {
  const funding = wallet.fundings[0];
  const fresh = Number(wallet.first_funded_at) > Date.now() / 1000 - 3600;
  return `<button class="ov-row" data-act="drawer-wallet" data-address="${esc(wallet.address)}">
    <i class="swatch" style="background:${esc(funding?.color || "#d6f25c")}"></i>
    <span class="ov-main"><b>${esc(shortAddr(wallet.address))}</b><span>${esc(funding?.label || "Rival")} · ${esc(formatEth(funding?.value_wei))} ETH</span></span>
    <span class="ov-time ${fresh ? "hot" : ""}">${esc(formatAge(wallet.first_funded_at))}</span>
  </button>`;
}

function tokenLine(token) {
  const funding = token.fundings[0];
  return `<button class="ov-row" data-act="drawer-token" data-address="${esc(token.address)}">
    <i class="swatch" style="background:${esc(funding?.color || "#d6f25c")}"></i>
    <span class="ov-main"><b>${esc(token.symbol || "—")}</b><span>${esc(rivalLabel(token.fundings))} · ${esc(formatKst(launchedAt(token)))}</span></span>
    <span class="pill ${esc(token.status)}">${esc(token.status)}</span>
  </button>`;
}

function rivalOptions() {
  return `<option value="all">All rivals</option>${state.data.competitors
    .map((rival) => `<option value="${rival.id}" ${String(state.rival) === String(rival.id) ? "selected" : ""}>${esc(rival.label)}</option>`)
    .join("")}`;
}

function viewWallets() {
  const rows = filteredWallets();
  return `
    <div class="toolbar">
      <div class="chips">
        ${chip("walletStatus", "waiting", `Waiting ${state.data.counts.waiting}`)}
        ${chip("walletStatus", "queued", `Checking ${state.data.counts.queued}`)}
        ${chip("walletStatus", "drained", `Drained ${state.data.counts.drained}`)}
        ${chip("walletStatus", "launched", "Launched")}
      </div>
      <select class="search" data-act="rival" style="width:180px">${rivalOptions()}</select>
      <input class="search" data-act="query" placeholder="Search wallet or rival" value="${esc(state.query)}" />
    </div>
    ${dataTable(
      ["Status", "Wallet", "Rival", "Funded", "Balance", `When (${zoneLabel()})`, "Age", ""],
      rows,
      walletRow,
      "Nothing in this view",
      "Change the filter, or scan a rival to find funded wallets.",
    )}`;
}

function walletRow(wallet) {
  const funding = wallet.fundings[0];
  const via = funding && funding.funder !== funding.competitor_address ? ` via ${shortAddr(funding.funder)}` : "";
  const ageClass = wallet.status === "waiting" && Number(wallet.first_funded_at) > Date.now() / 1000 - 3600 ? "hot" : "";
  return `<tr class="clickable" data-act="drawer-wallet" data-address="${esc(wallet.address)}">
    <td><span class="pill ${esc(wallet.status)}">${esc(wallet.status)}</span></td>
    <td class="addr">${esc(shortAddr(wallet.address))}</td>
    <td>${esc(rivalLabel(wallet.fundings))}</td>
    <td>${esc(formatEth(sumWei(wallet.fundings)))} ETH<small class="muted">${esc(via)}</small></td>
    <td>${esc(formatEth(wallet.eth_balance_wei))}</td>
    <td>${esc(formatKst(wallet.first_funded_at))}</td>
    <td class="${ageClass}">${esc(formatAge(wallet.first_funded_at))}</td>
    <td><a class="link-pill" href="https://etherscan.io/address/${esc(wallet.address)}" target="_blank" rel="noreferrer">Etherscan</a></td>
  </tr>`;
}

function sumWei(fundings) {
  return (fundings || []).reduce((total, funding) => total + BigInt(funding.value_wei || 0), 0n).toString();
}

function viewTokens() {
  return `
    <div class="toolbar">
      <div class="chips">
        ${chip("tokenStatus", "all", "All")}
        ${chip("tokenStatus", "live", `Live ${state.data.counts.live}`)}
        ${chip("tokenStatus", "thin", `Thin ${state.data.counts.thin}`)}
        ${chip("tokenStatus", "rugged", `Rugged ${state.data.counts.rugged}`)}
        ${chip("tokenStatus", "unlisted", `No pool ${state.data.counts.unlisted}`)}
      </div>
      <select class="search" data-act="rival" style="width:180px">${rivalOptions()}</select>
      <input class="search" data-act="query" placeholder="Search name, symbol, address" value="${esc(state.query)}" />
      <label class="check"><input type="checkbox" data-act="paid-only" ${state.paidOnly ? "checked" : ""}/> Paid tokens</label>
      <label class="check table-check"><input type="checkbox" data-act="main-v4" ${state.mainV4 ? "checked" : ""}/> Show main pair in V4</label>
    </div>
    ${dataTable(
      [
        { label: "Status", key: "status", type: "text" },
        { label: "Token", key: "symbol", type: "text" },
        { label: "Rival", key: "rival", type: "text" },
        { label: `Launched (${zoneLabel()})`, key: "launched", type: "number" },
        { label: "Liquidity", key: "liquidity", type: "number", align: "right" },
        { label: "MCap", key: "mcap", type: "number", align: "right" },
        { label: "ATH", key: "ath", type: "number", align: "right" },
        { label: "Profit", key: "profit", type: "number", align: "right" },
        { label: "24h", key: "change", type: "number", align: "right" },
        { label: "Total tx", key: "txTotal", type: "number", align: "right" },
        { label: "24h tx", key: "tx24h", type: "number", align: "right" },
        { label: "Paid Status", key: "paid", type: "number" },
      ],
      displayTokenRows(),
      tokenRow,
      "No tokens in this view",
      "Live, thin, rugged, and unlisted tokens from funded creators land here.",
    )}`;
}

function isPoolId(value) {
  const pair = String(value || "");
  return /^0x[a-fA-F0-9]{40}$/.test(pair) || /^0x[a-fA-F0-9]{64}$/.test(pair);
}

function dextoolsHref(token) {
  const pair = String(token.pairAddress || token.pair_address || "").trim();
  const tokenAddress = String(token.address || "").toLowerCase();
  if (isPoolId(pair) && pair.toLowerCase() !== tokenAddress) return `https://www.dextools.io/app/ether/pair-explorer/${pair}`;
  const stored = String(token.dextools_url || "").match(/pair-explorer\/(0x[a-fA-F0-9]{40}|0x[a-fA-F0-9]{64})(?:$|[/?#])/i);
  if (stored && isPoolId(stored[1]) && stored[1].toLowerCase() !== tokenAddress) {
    return `https://www.dextools.io/app/ether/pair-explorer/${stored[1]}`;
  }
  return "";
}

function dexscreenerHref(token) {
  const address = String(token.address || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(address)) return "";
  return `https://dexscreener.com/ethereum/${address}`;
}

function gmgnHref(token) {
  const address = String(token.address || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(address)) return "";
  return `https://gmgn.ai/eth/token/${address}`;
}

function formatBannerAge(unix) {
  if (!unix) return "";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - Number(unix));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days >= 1) return `${days}d`;
  if (hours >= 1) return `${hours}h`;
  if (minutes >= 1) return `${minutes}m`;
  return `${Math.max(1, seconds)}s`;
}

function exchangeTitle(dex, label) {
  const raw = String(dex || "").toLowerCase();
  const known = {
    uniswap: "Uniswap",
    sushiswap: "SushiSwap",
    pancakeswap: "PancakeSwap",
    curve: "Curve",
    balancer: "Balancer",
  };
  const name = known[raw] || (raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "");
  const version = /^v\d/i.test(String(label || "")) ? String(label).toLowerCase() : "";
  if (name && version) return `${name} ${version}`;
  return name || version || String(label || "");
}

function bannerIsIcon(url) {
  return /\/tokens\/ethereum\/0x[a-f0-9]{40}\.png/i.test(String(url || ""));
}

function tokenThumb(token) {
  if (!token.banner) return "";
  const icon = bannerIsIcon(token.banner) ? " is-icon" : "";
  return `<img class="token-thumb${icon}" src="${esc(token.banner)}" alt="" onerror="this.remove()" />`;
}

function tokenBanner(token) {
  if (!token.banner) return "";
  const quote = token.quote || "ETH";
  const age = formatBannerAge(token.launched);
  const exchange = exchangeTitle(token.dex, token.label);
  const rank = Number(token.rank) > 0
    ? `<span class="banner-rank"><svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1.2c.4 1.6-.2 2.7-1.1 3.6-.7.7-1.4 1.5-1.2 2.7.1.8.7 1.4 1.1 2 .5.7.6 1.5.3 2.3 1.2-.7 2.2-1.8 2.5-3.2.2 1 .9 1.8 1.8 2.2.4-1.3 0-2.4-.7-3.3 1.3.2 2.3-.4 2.8-1.5-1 .6-1.8.5-2.6 0 .8-1.2 1-2.6.9-4.1-.9.8-1.6 1.9-2 3.2-.3-1.5-.8-2.8-1.8-3.9Z"/></svg>#${Number(token.rank)}</span>`
    : "";
  return `<div class="token-banner">
    <div class="token-banner-top">
      <span class="token-banner-name"><span class="token-check">✓</span>${esc(token.symbol)} / ${esc(quote)}</span>
      <span class="token-banner-stats">${age ? `<span class="banner-age">${esc(age)}</span>` : ""}${rank}</span>
    </div>
    <div class="token-banner-pills"><span>Ethereum</span>${exchange ? `<span>${esc(exchange)}</span>` : ""}</div>
    <img class="${bannerIsIcon(token.banner) ? "is-icon" : ""}" src="${esc(token.banner)}" alt="" onerror="this.closest('.token-banner').remove()" />
  </div>`;
}

function paidBadge(payment) {
  const kind = String(payment.kind || "");
  if (payment.source === "dextools" && kind === "nitro") return { label: "nitro", tone: "nitro" };
  if (payment.source === "dextools") return { label: "Dextools", tone: "thin" };
  if (kind === "boost") return { label: "boost", tone: "boost" };
  return { label: "Dexscreener", tone: "live" };
}

function paidCell(payments, compact = false) {
  const rows = [...(payments || [])].sort((a, b) => (Number(b.paid_at) || 0) - (Number(a.paid_at) || 0));
  if (!rows.length) return `<span class="muted">—</span>`;
  if (compact) {
    const order = ["Dexscreener", "Dextools", "boost", "nitro"];
    const seen = new Map();
    for (const payment of rows) {
      const badge = paidBadge(payment);
      if (!seen.has(badge.label)) seen.set(badge.label, badge);
    }
    const badges = order.filter((label) => seen.has(label)).map((label) => seen.get(label));
    return `<div class="paid-badges">${badges.map((badge) => `<span class="pill ${badge.tone}">${badge.label}</span>`).join("")}</div>`;
  }
  return `<div class="paid-list">${rows
    .map((payment) => {
      const badge = paidBadge(payment);
      return `<div class="paid-card"><div class="paid-card-top"><span class="pill ${badge.tone}">${esc(badge.label)}</span><span class="muted">${esc(formatKst(payment.paid_at))} ${zoneLabel()}</span></div><b>${esc(payment.detail || "Promotion")}</b></div>`;
    })
    .join("")}</div>`;
}

function changeCell(value) {
  const number = Number(value);
  const text = formatChange(value);
  if (!Number.isFinite(number) || number === 0) return `<span class="chg">${esc(text)}</span>`;
  return `<span class="chg ${number > 0 ? "up" : "down"}">${esc(text)}</span>`;
}

function metric(label, value, tone = "") {
  return `<div class="metric"><span>${esc(label)}</span><strong class="${tone}">${esc(value)}</strong></div>`;
}

function countWord(count, singular, plural) {
  return `${Number(count) || 0} ${Number(count) === 1 ? singular : plural}`;
}

function profitCell(token) {
  if (!token.profitReady) return `<span class="muted" title="Profit is still being counted">…</span>`;
  let value = 0n;
  try {
    value = BigInt(token.profitWei || "0");
  } catch {
    value = 0n;
  }
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 10n ** 18n;
  const fullFrac = (abs % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  const exact = `${negative ? "-" : ""}${whole}${fullFrac ? `.${fullFrac}` : ""} ETH`;
  const shown = `${negative ? "-" : ""}${formatEth(abs.toString())} ETH (${countWord(token.profitBuys, "buy", "buys")} + ${countWord(token.profitSells, "sell", "sells")})`;
  const tone = value > 0n ? "up" : value < 0n ? "down" : "";
  return `<span class="chg ${tone}" title="${esc(exact)}">${esc(shown)}</span>`;
}

function tokenRow(token) {
  const exchange = token.label ? `<span class="exch">${esc([token.label, token.quote].filter(Boolean).join(" "))}</span>` : "";
  return `<tr class="clickable" data-act="drawer-token" data-address="${esc(token.address)}">
    <td><span class="pill ${esc(token.status)}">${esc(token.status)}</span></td>
    <td class="token-cell"><span class="token-line">${tokenThumb(token)}<span class="token-name"><b>${esc(token.symbol)}</b> <span class="muted">(${esc(token.name)})</span>${exchange}</span></span></td>
    <td>${esc(token.rival)}</td>
    <td>${esc(formatKst(token.launched))}</td>
    <td class="num">${esc(formatUsd(token.liquidity))}</td>
    <td class="num">${esc(formatUsd(token.mcap))}</td>
    <td class="num" title="${esc(exactUsd(token.ath))}">${esc(formatUsd(token.ath))}</td>
    <td class="num">${profitCell(token)}</td>
    <td class="num">${changeCell(token.change)}</td>
    <td class="num">${esc(formatCount(token.txTotal))}</td>
    <td class="num">${esc(formatCount(token.tx24h))}</td>
    <td class="paid-cell">${paidCell(token.payments, true)}</td>
  </tr>`;
}

function fallbackPair(token) {
  const dex = String(token.dex || "");
  return {
    status: token.status,
    label: /^v\d/i.test(dex) ? dex.toLowerCase() : dex.toLowerCase(),
    pair_created_at: token.pair_created_at,
    liquidity_usd: token.liquidity_usd,
    market_cap: token.market_cap,
    price_change_24h: token.price_change_24h,
    txns_24h: token.txns_24h,
    pair_address: token.pair_address,
    dextools_url: token.dextools_url,
    dexscreener_url: token.dexscreener_url,
  };
}

function displayTokenRows() {
  const rows = [];
  for (const token of filteredTokens()) {
    const pairs = token.pairs && token.pairs.length ? token.pairs : [fallbackPair(token)];
    for (const pair of pairs) {
      rows.push({
        address: token.address,
        symbol: token.symbol || "",
        name: token.name || "",
        status: pair.status || token.status,
        label: String(pair.label || "").toLowerCase(),
        dex: pair.dex || token.dex || "",
        quote: pair.quote_symbol || "",
        banner: token.banner_url || "",
        rival: rivalLabel(token.fundings),
        launched: launchStamp(token.created_at, token.created_block, pair.pair_created_at || token.pair_created_at),
        liquidity: numberOrNull(pair.liquidity_usd),
        mcap: numberOrNull(pair.market_cap),
        ath: numberOrNull(token.ath_market_cap),
        profit: token.profit_checked_at ? Number(token.profit_wei || 0) / 1e18 : null,
        profitWei: token.profit_wei,
        profitBuys: token.profit_buys,
        profitSells: token.profit_sells,
        profitReady: Boolean(token.profit_checked_at),
        change: numberOrNull(pair.price_change_24h),
        tx24h: numberOrNull(pair.txns_24h),
        txTotal: pairTxTotal(pair, token),
        isMain: Number(pair.is_main) === 1,
        payments: token.payments || [],
        paid: (token.payments || []).reduce((latest, payment) => Math.max(latest, Number(payment.paid_at) || 0), 0) || null,
        pairAddress: pair.pair_address || token.pair_address || "",
        dextools_url: dextoolsHref({
          address: token.address,
          pair_address: pair.pair_address || token.pair_address,
          dextools_url: pair.dextools_url || token.dextools_url,
        }),
        dexscreener_url: pair.dexscreener_url || token.dexscreener_url,
      });
    }
  }
  return sortTokenRows(collapseMainV4(rows));
}

function collapseMainV4(rows) {
  if (!state.mainV4) return rows;
  const best = new Map();
  for (const row of rows) {
    if (row.label !== "v4") continue;
    const current = best.get(row.address);
    if (!current || preferMain(row, current)) best.set(row.address, row);
  }
  return rows.filter((row) => {
    if (row.label !== "v4") return true;
    const winner = best.get(row.address);
    return !winner || winner.pairAddress === row.pairAddress;
  });
}

function preferMain(row, current) {
  if (row.isMain !== current.isMain) return row.isMain;
  return (Number(row.txTotal) || 0) > (Number(current.txTotal) || 0);
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function pairTxTotal(pair, token) {
  if (String(pair.label || "").toLowerCase() === "v4") {
    if (pair.txns_total != null && pair.txns_total !== "") return numberOrNull(pair.txns_total);
    return numberOrNull(pair.txns_24h);
  }
  return countedTx(token);
}

function countedTx(token) {
  const pairs = (token.pairs || []).filter((pair) => String(pair.label || "").toLowerCase() !== "v4");
  const recent = pairs.reduce((sum, pair) => sum + (Number(pair.txns_24h) || 0), 0);
  const total = Math.max(Number(token.txns_total) || 0, Number(token.txns_24h) || 0, recent);
  return total > 0 ? total : null;
}

function sortValue(row, key) {
  if (key === "status") return row.status || "";
  if (key === "symbol") return row.symbol || "";
  if (key === "rival") return row.rival || "";
  if (key === "launched") return numberOrNull(row.launched);
  if (key === "liquidity") return row.liquidity;
  if (key === "mcap") return row.mcap;
  if (key === "ath") return row.ath;
  if (key === "profit") return row.profit;
  if (key === "change") return row.change;
  if (key === "txTotal") return row.txTotal;
  if (key === "tx24h") return row.tx24h;
  if (key === "paid") return row.paid;
  return "";
}

function compareSort(a, b, factor) {
  const emptyA = a == null || a === "";
  const emptyB = b == null || b === "";
  if (emptyA && emptyB) return 0;
  if (emptyA) return 1;
  if (emptyB) return -1;
  if (typeof a === "number" && typeof b === "number") return (a - b) * factor;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" }) * factor;
}

function sortTokenRows(rows) {
  const sort = state.sort.tokens || { key: "launched", dir: "desc" };
  const factor = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => compareSort(sortValue(a, sort.key), sortValue(b, sort.key), factor));
}

function dataTable(columns, rows, render, emptyTitle, emptyBody) {
  const defs = columns.map((column) => (typeof column === "string" ? { label: column } : column));
  const page = paged(rows);
  if (!page.count) {
    return `<div class="table-panel">
      <div class="table-scroll"><table><thead><tr>${defs.map(headerCell).join("")}</tr></thead></table></div>
      <div class="empty"><h3>${esc(emptyTitle)}</h3><p>${esc(emptyBody)}</p></div>
    </div>`;
  }
  return `<div class="table-panel">
    <div class="table-scroll">
      <table>
        <thead><tr>${defs.map(headerCell).join("")}</tr></thead>
        <tbody>${page.rows.map(render).join("")}</tbody>
      </table>
    </div>
    ${pager(page)}
  </div>`;
}

function headerCell(column) {
  if (!column.key) return "<th></th>";
  const sort = state.sort[state.route];
  const active = sort && sort.key === column.key;
  const mark = active ? (sort.dir === "asc" ? "↑" : "↓") : "";
  const align = column.align === "right" ? "num" : "";
  return `<th class="${align}"><button type="button" class="sort ${active ? "on" : ""}" data-act="sort" data-key="${esc(column.key)}" data-type="${esc(column.type || "text")}">${esc(column.label)}${mark ? `<span>${mark}</span>` : ""}</button></th>`;
}

function paged(rows) {
  const size = state.pageSize;
  const pages = Math.max(1, Math.ceil(rows.length / size) || 1);
  let page = state.pages[state.route] || 1;
  if (page > pages) page = pages;
  if (page < 1) page = 1;
  state.pages[state.route] = page;
  const start = (page - 1) * size;
  return { rows: rows.slice(start, start + size), page, pages, start, count: rows.length, size };
}

function pager(page) {
  const from = page.start + 1;
  const to = page.start + page.rows.length;
  const buttons = pageButtons(page.page, page.pages)
    .map((item) => {
      if (item === "…") return `<span class="pager-gap" aria-hidden="true">…</span>`;
      const current = item === page.page;
      return `<button type="button" class="page-btn ${current ? "on" : ""}" data-act="page" data-page="${item}" ${current ? 'aria-current="page"' : ""}>${item}</button>`;
    })
    .join("");
  return `<footer class="pager">
    <p class="pager-meta">Showing <b>${from.toLocaleString()}–${to.toLocaleString()}</b> of <b>${page.count.toLocaleString()}</b></p>
    <nav class="pager-pages" aria-label="Table pages">
      <button type="button" class="page-btn" data-act="page" data-page="1" ${page.page === 1 ? "disabled" : ""} aria-label="First page">«</button>
      <button type="button" class="page-btn" data-act="page" data-page="${page.page - 1}" ${page.page === 1 ? "disabled" : ""} aria-label="Previous page">‹</button>
      ${buttons}
      <button type="button" class="page-btn" data-act="page" data-page="${page.page + 1}" ${page.page === page.pages ? "disabled" : ""} aria-label="Next page">›</button>
      <button type="button" class="page-btn" data-act="page" data-page="${page.pages}" ${page.page === page.pages ? "disabled" : ""} aria-label="Last page">»</button>
    </nav>
    <label class="pager-size">Rows
      <select data-act="page-size" aria-label="Rows per page">
        ${[25, 50, 100].map((size) => `<option value="${size}" ${size === page.size ? "selected" : ""}>${size}</option>`).join("")}
      </select>
    </label>
  </footer>`;
}

function pageButtons(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const keep = new Set([1, total, current - 1, current, current + 1]);
  if (current <= 3) {
    keep.add(2);
    keep.add(3);
    keep.add(4);
  }
  if (current >= total - 2) {
    keep.add(total - 1);
    keep.add(total - 2);
    keep.add(total - 3);
  }
  const sorted = [...keep].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  const items = [];
  for (const page of sorted) {
    if (items.length && page - items[items.length - 1] > 1) items.push("…");
    items.push(page);
  }
  return items;
}

function resetPage() {
  state.pages[state.route] = 1;
}

function chip(key, value, label) {
  return `<button class="chip ${state[key] === value ? "on" : ""}" data-act="chip" data-key="${key}" data-value="${value}">${esc(label)}</button>`;
}

function filteredWallets() {
  const query = state.query.trim().toLowerCase();
  return state.data.deployers
    .filter((wallet) => wallet.status === state.walletStatus)
    .filter((wallet) => state.rival === "all" || wallet.fundings.some((funding) => String(funding.competitor_id) === String(state.rival)))
    .filter((wallet) => {
      if (!query) return true;
      const blob = `${wallet.address} ${rivalLabel(wallet.fundings)}`.toLowerCase();
      return blob.includes(query);
    });
}

function filteredTokens() {
  const query = state.query.trim().toLowerCase();
  return state.data.tokens
    .filter((token) => state.tokenStatus === "all" || token.status === state.tokenStatus)
    .filter((token) => !state.paidOnly || (token.payments && token.payments.length))
    .filter((token) => state.rival === "all" || token.fundings.some((funding) => String(funding.competitor_id) === String(state.rival)))
    .filter((token) => {
      if (!query) return true;
      const blob = `${token.name} ${token.symbol} ${token.address} ${rivalLabel(token.fundings)}`.toLowerCase();
      return blob.includes(query);
    });
}

function swapAmountLabel(trade) {
  if (!trade.amount_wei) return formatAmount(trade.amount);
  let value;
  try {
    value = BigInt(trade.amount_wei);
  } catch {
    return "—";
  }
  if (value <= 0n) return "—";
  const units = value / 10n ** 14n;
  const whole = value / 10n ** 18n;
  const frac = (value % 10n ** 18n).toString().padStart(18, "0").slice(0, 4).replace(/0+$/, "");
  const eth = units === 0n ? "<0.0001" : frac ? `${whole}.${frac}` : String(whole);
  const usd = Number(trade.amount_usd);
  const usdText = Number.isFinite(usd) && usd > 0 ? ` ($${usd.toFixed(2)})` : "";
  return `${eth} ETH${usdText}`;
}

function exactSwapTitle(trade) {
  if (!trade.amount_wei) return String(trade.amount ?? "");
  let value;
  try {
    value = BigInt(trade.amount_wei);
  } catch {
    return "";
  }
  const whole = value / 10n ** 18n;
  const frac = (value % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  const eth = frac ? `${whole}.${frac}` : String(whole);
  const usd = Number(trade.amount_usd);
  return Number.isFinite(usd) && usd > 0 ? `${eth} ETH ($${usd.toFixed(2)})` : `${eth} ETH`;
}

function formatAmount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "—";
  if (number >= 1e9) return `${(number / 1e9).toFixed(2)}B`;
  if (number >= 1e6) return `${(number / 1e6).toFixed(2)}M`;
  if (number >= 1e3) return `${(number / 1e3).toFixed(2)}K`;
  if (number >= 1) return number.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (number >= 0.0001) return number.toFixed(4);
  return number.toPrecision(2);
}

function buyerName(buyer) {
  return buyer.label || "No label";
}

function viewBuyers() {
  const buyers = state.data.buyers || [];
  const options = [`<option value="all">All buyers</option>`]
    .concat(buyers.map((buyer) => `<option value="${buyer.id}" ${String(state.buyerFilter) === String(buyer.id) ? "selected" : ""}>${esc(buyerName(buyer))}</option>`))
    .join("");
  return `
    <div class="toolbar">
      <button class="btn primary" data-act="manage-buyers">Manage Buyers</button>
      <select class="search" data-act="buyer-filter" style="width:180px">${options}</select>
      <input class="search" data-act="query" placeholder="Search token, buyer, transaction" value="${esc(state.query)}" />
    </div>
    <div class="section-label section-gap">Trades</div>
    ${dataTable(
      [
        { label: `Time (${zoneLabel()})`, key: "time", type: "number" },
        { label: "Type", key: "type", type: "text" },
        { label: "MCap", key: "mcap", type: "number", align: "right" },
        { label: "Amount", key: "amount", type: "number", align: "right" },
        { label: "Token", key: "token", type: "text" },
        { label: "Buyer", key: "buyer", type: "text" },
        { label: "Transaction", key: "tx", type: "text" },
      ],
      sortBuyerTrades(filteredBuyerTrades()),
      buyerTradeRow,
      "No trades yet",
      "Buys and sells of rival tokens show up here as new blocks arrive.",
    )}`;
}

function filteredBuyerTrades() {
  const query = state.query.trim().toLowerCase();
  return (state.data.buyerTrades || []).filter((trade) => {
    if (state.buyerFilter !== "all" && String(trade.buyer_id) !== String(state.buyerFilter)) return false;
    if (!query) return true;
    const blob = `${trade.token_symbol || ""} ${trade.token_name || ""} ${trade.token_address} ${trade.buyer_label || ""} ${trade.buyer_address} ${trade.tx_hash} ${trade.side}`.toLowerCase();
    return blob.includes(query);
  });
}

function buyerTradeSortValue(row, key) {
  if (key === "time") return numberOrNull(row.timestamp);
  if (key === "type") return row.side || "";
  if (key === "mcap") return numberOrNull(row.market_cap);
  if (key === "amount") return numberOrNull(row.amount);
  if (key === "token") return row.token_symbol || row.token_name || "";
  if (key === "buyer") return row.buyer_label || row.buyer_address || "";
  if (key === "tx") return row.tx_hash || "";
  return "";
}

function sortBuyerTrades(rows) {
  const sort = state.sort.buyers || { key: "time", dir: "desc" };
  const factor = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => compareSort(buyerTradeSortValue(a, sort.key), buyerTradeSortValue(b, sort.key), factor));
}

function buyerTradeRow(trade) {
  const token = trade.token_symbol || trade.token_name || shortAddr(trade.token_address);
  const name = trade.token_name && trade.token_symbol ? ` <span class="muted">(${esc(trade.token_name)})</span>` : "";
  return `<tr>
    <td>${esc(formatKst(trade.timestamp))}</td>
    <td><span class="pill ${trade.side === "buy" ? "live" : "rugged"}">${esc(trade.side)}</span></td>
    <td class="num">${esc(formatUsd(trade.market_cap))}</td>
    <td class="num" title="${esc(exactSwapTitle(trade))}">${esc(swapAmountLabel(trade))}</td>
    <td><b>${esc(token)}</b>${name}</td>
    <td>${esc(trade.buyer_label || shortAddr(trade.buyer_address))}</td>
    <td class="links"><a class="link-pill" href="https://etherscan.io/tx/${esc(trade.tx_hash)}" target="_blank" rel="noreferrer">Etherscan</a></td>
  </tr>`;
}

const TREND_WINDOWS = [
  ["1h", "1h"],
  ["6h", "6h"],
  ["12h", "12h"],
  ["24h", "24h"],
  ["3d", "3d"],
  ["7d", "7d"],
];

function trendSortValue(row, key) {
  if (key === "count" || key === "latest") return Number(row[key]) || 0;
  if (key === "name") return row.name || row.key || "";
  if (key === "ticker") return row.key || "";
  return "";
}

function sortTrendRows(rows) {
  const sort = state.sort.trends || { key: "count", dir: "desc" };
  const factor = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => compareSort(trendSortValue(a, sort.key), trendSortValue(b, sort.key), factor));
}

function trendPairRows(row) {
  const body = row.pairs
    .map(
      (pair) => `<tr>
        <td>${esc(formatKst(pair.createdAt))}</td>
        <td><b>${esc(pair.symbol || "—")}</b></td>
        <td>${esc(pair.name || "—")}</td>
        <td>${esc(pair.quote || "—")}</td>
        <td class="links"><a class="link-pill" href="https://www.dextools.io/app/ether/pair-explorer/${esc(pair.pair)}" target="_blank" rel="noreferrer">Dextools</a></td>
      </tr>`,
    )
    .join("");
  const hidden = row.pairs.length < row.count ? `<p class="muted trend-more">Showing the latest ${row.pairs.length} of ${row.count} pairs.</p>` : "";
  return `<tr class="trend-detail"><td colspan="4">
    ${hidden}
    <table class="trend-pairs">
      <thead><tr><th>Time (${esc(zoneLabel())})</th><th>Ticker</th><th>Name</th><th>Quote</th><th></th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  </td></tr>`;
}

function trendRow(row) {
  const open = state.trendOpen === row.key;
  return `<tr class="clickable" data-act="trend-open" data-key="${esc(row.key)}">
    <td class="token-cell"><span class="token-name"><b>$${esc(row.key)}</b> <span class="muted">${esc(row.name || "")}</span></span></td>
    <td class="num">${esc(row.count)}</td>
    <td>${esc(formatKst(row.latest))}</td>
    <td class="muted">${open ? "Hide pairs" : "Show pairs"}</td>
  </tr>${open ? trendPairRows(row) : ""}`;
}

function trendMinimum() {
  const raw = String(state.trendMin ?? "").trim();
  if (!raw) return 1;
  const value = Math.floor(Number(raw));
  if (!Number.isFinite(value) || value < 1) return 1;
  return value;
}

function viewTrends() {
  const board = state.trends;
  const query = state.query.trim().toLowerCase();
  const minimum = trendMinimum();
  const rows = sortTrendRows(
    (board?.rows || []).filter((row) => {
      if ((Number(row.count) || 0) < minimum) return false;
      if (!query) return true;
      return `${row.key} ${row.name}`.toLowerCase().includes(query);
    }),
  );
  const coverage = board?.coverage;
  const waiting = !board || (board.loading && !board.pairs);
  const listed = minimum <= 1 ? "Showing every name and ticker." : `Showing names and tickers with a count of ${minimum} or more.`;
  const status = !board
    ? "Reading Dextools live pairs."
    : `${board.pairs || 0} ETH and WETH pairs in this window. ${listed}${coverage && !coverage.ready ? ` Older pairs are still loading${coverage.oldest ? `, back to ${formatKst(coverage.oldest)}` : ""}.` : ""}`;
  return `
    <div class="toolbar">
      <div class="chips">
        ${TREND_WINDOWS.map(([id, label]) => chip("trendWindow", id, label)).join("")}
      </div>
      <label class="min-count">Min Count
        <input data-act="trend-min" inputmode="numeric" min="1" step="1" placeholder="1" value="${esc(state.trendMin)}" />
      </label>
      <input class="search" data-act="query" placeholder="Search name or ticker" value="${esc(state.query)}" />
    </div>
    <p class="muted trend-status">${esc(status)}</p>
    ${dataTable(
      [
        { label: "Name / ticker", key: "ticker" },
        { label: "Count", key: "count", type: "number", align: "right" },
        { label: `Latest (${zoneLabel()})`, key: "latest", type: "number" },
        { label: "Pairs" },
      ],
      rows,
      trendRow,
      waiting ? "Reading live pairs" : minimum <= 1 ? "No pairs in this window" : "No name reached that count",
      waiting
        ? "ETH and WETH pairs from Dextools live are being saved."
        : minimum <= 1
          ? "ETH and WETH pairs from Dextools live show up here."
          : `ETH and WETH pairs show up here once the same name or ticker appears ${minimum} or more times.`,
    )}`;
}

function ensureTrends() {
  const windowId = state.trendWindow || "1h";
  const current = state.trends;
  const fresh = current && current.window === windowId && !current.loading && Date.now() - Number(current.at || 0) < 8000;
  if (fresh || (current?.loading && current.window === windowId)) return;
  const keep = current?.window === windowId ? current : null;
  state.trends = {
    window: windowId,
    loading: true,
    at: keep?.at || 0,
    rows: keep?.rows || [],
    pairs: keep?.pairs || 0,
    coverage: keep?.coverage || null,
    error: "",
  };
  fetch(`/api/trends?window=${encodeURIComponent(windowId)}`)
    .then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Trends could not be loaded.");
      return body;
    })
    .then((body) => {
      if ((state.trendWindow || "1h") !== windowId) return;
      state.trends = { ...body, window: windowId, loading: false, at: Date.now(), error: "" };
      paint();
    })
    .catch((error) => {
      if ((state.trendWindow || "1h") !== windowId) return;
      state.trends = { window: windowId, loading: false, at: Date.now(), rows: keep?.rows || [], pairs: keep?.pairs || 0, coverage: keep?.coverage || null, error: error.message };
      paint();
    });
}

function viewRivals() {
  return `
    <div class="toolbar">${iconAction({ kind: "add", label: "Add rival", act: "add" })}</div>
    <div class="rivals">
      ${state.data.competitors.map(rivalCard).join("")}
    </div>`;
}

function rivalCard(rival) {
  const percent = scanPercentOf(rival);
  return `<article class="card rival">
    <i class="swatch" style="background:${esc(rival.color)}"></i>
    <div>
      <div class="name">${esc(rival.label)} ${rival.enabled ? "" : `<span class="pill drained">paused</span>`}</div>
      <div class="addr">${esc(rival.address)} ${copyIcon(rival.address)}</div>
      ${rival.notes ? `<div class="muted" style="margin-top:6px;white-space:normal">${esc(rival.notes)}</div>` : ""}
    </div>
    <div><b>${rival.waiting}</b><div class="muted">waiting</div></div>
    <div><b>${rival.live}</b><div class="muted">live</div></div>
    <div><b>${rival.tokens}</b><div class="muted">tokens</div></div>
    <div class="mini-actions">
      <button class="btn" data-act="scan" data-id="${rival.id}" ${scanning() ? "disabled" : ""}>Scan</button>
      ${iconAction({ kind: "edit", label: "Edit", act: "edit", id: rival.id })}
      ${iconAction({ kind: "delete", label: "Delete", act: "remove", id: rival.id })}
    </div>
    <div class="scan-cell" data-rival-card="${rival.id}">
      <div class="scan-row">
        <div class="scan-meter" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" aria-label="${esc(rival.label)} scan progress">
          <div class="scan-fill ${percent >= 100 ? "done" : ""}" style="width:${percent}%"></div>
        </div>
        <b class="scan-pct">${percent}%</b>
        <span class="scan-eta">${esc(rival.scan_eta || "")}</span>
      </div>
      <div class="scan-detail">${esc(rival.scan_detail || "")}</div>
      <div class="muted scan-note">${esc(scanNote(rival))}</div>
    </div>
  </article>`;
}

function scanPercentOf(rival) {
  const value = Number(rival.scan_percent);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function scanNote(rival) {
  const text =
    rival.scan_status === "running"
      ? rival.scan_note
        ? `Scanning · ${rival.scan_note}`
        : "Scanning"
      : rival.scan_note || (rival.last_scan_at ? `Last scan ${formatAge(rival.last_scan_at)} ago` : "Not scanned");
  return rival.scan_error ? `${text} · ${rival.scan_error}` : text;
}

function rangeMode() {
  return state.scanRangeMode || state.data.settings.scanRangeMode || "date";
}

const SETTINGS_TABS = [
  ["scan", "Scan", "Set the scan window and how often rivals are checked."],
  ["funding", "Funding", "How much ETH counts as funding, and which wallets stay on the list."],
  ["etherscan", "Etherscan", "Add the API keys used to read wallet history."],
  ["telegram", "Telegram", "Launch and paid-promotion alerts for the launch bot."],
  ["buyers", "Buyers", "Buy and sell alerts for Buyer Tracker."],
  ["trends", "Trends", "When a shared name counts as rising, trending, exploding, or the whole market."],
];
const SETTING_CHECKS = ["fastMode", "telegramAlerts", "buyerAlerts", "trendAlerts", "autoScan", "requireFirstFunder"];

function settingsTabId() {
  return SETTINGS_TABS.some(([id]) => id === state.settingsTab) ? state.settingsTab : "scan";
}

function settingsTabMeta() {
  return SETTINGS_TABS.find(([id]) => id === settingsTabId()) || SETTINGS_TABS[0];
}

function captureSettingsDraft() {
  const form = document.getElementById("settings");
  if (!form) return;
  const data = Object.fromEntries(new FormData(form).entries());
  for (const name of SETTING_CHECKS) {
    const input = form.elements.namedItem(name);
    if (input) data[name] = input.checked ? "1" : "0";
  }
  state.settingsDraft = { ...(state.settingsDraft || {}), ...data };
}

function fieldValue(name) {
  const draft = state.settingsDraft || {};
  if (draft[name] != null && String(draft[name]) !== "") return draft[name];
  return state.data.settings[name] ?? "";
}

function checkedSetting(name) {
  const draft = state.settingsDraft || {};
  if (draft[name] === "1" || draft[name] === "0") return draft[name] === "1";
  const settings = state.data.settings;
  if (name === "trendAlerts") return settings.trendAlerts !== "0";
  return settings[name] === "1";
}

const ZONES = [
  [-12, "Baker Island"],
  [-11, "Pago Pago"],
  [-10, "Honolulu"],
  [-9, "Anchorage"],
  [-8, "Los Angeles"],
  [-7, "Denver"],
  [-6, "Chicago"],
  [-5, "New York"],
  [-4, "Santiago"],
  [-3, "São Paulo"],
  [-2, "South Georgia"],
  [-1, "Azores"],
  [0, "London"],
  [1, "Berlin"],
  [2, "Cairo"],
  [3, "Moscow"],
  [4, "Dubai"],
  [5, "Karachi"],
  [6, "Dhaka"],
  [7, "Bangkok"],
  [8, "Singapore"],
  [9, "Tokyo"],
  [10, "Sydney"],
  [11, "Noumea"],
  [12, "Auckland"],
  [13, "Apia"],
  [14, "Kiritimati"],
];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad2(value) {
  const n = Number(value);
  if (!Number.isInteger(n)) return "00";
  return String(Math.max(0, n)).padStart(2, "0");
}

function draftZoneOffset() {
  const offset = Number(fieldValue("timezoneOffset") || 9);
  return Number.isInteger(offset) && offset >= -12 && offset <= 14 ? offset : 9;
}

function zoneText(offset) {
  const value = Number.isInteger(Number(offset)) ? Number(offset) : 9;
  const city = ZONES.find(([item]) => item === value)?.[1] || "Tokyo";
  const sign = value === 0 ? "UTC" : `UTC${value > 0 ? "+" : ""}${value}`;
  return { value, city, sign };
}

function dateText(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!match) return "Choose a date";
  return `${MONTHS_SHORT[Number(match[2]) - 1]} ${Number(match[3])}, ${match[1]}`;
}

function timeText(prefix) {
  return `${pad2(fieldValue(`${prefix}Hour`) || "0")}:${pad2(fieldValue(`${prefix}Minute`) || "0")}:${pad2(fieldValue(`${prefix}Second`) || "0")}`;
}

function zonedToday() {
  const shifted = new Date(Date.now() + draftZoneOffset() * 3600 * 1000);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

function shiftMonth(month, delta) {
  const [year, part] = String(month || "").split("-").map(Number);
  const date = new Date(Date.UTC(year || 2026, (part || 1) - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`;
}

function calendarCells(month, selected) {
  const [year, part] = String(month).split("-").map(Number);
  const lead = new Date(Date.UTC(year, part - 1, 1)).getUTCDay();
  const start = Date.UTC(year, part - 1, 1 - lead);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start + index * 86400000);
    const iso = `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
    return { iso, day: date.getUTCDate(), outside: date.getUTCMonth() !== part - 1 };
  }).map((cell) => ({ ...cell, selected: cell.iso === selected }));
}

function placeOpenPicker() {
  const pop = document.querySelector(".picker.open .picker-pop");
  if (!pop) return;
  pop.classList.remove("up");
  const rect = pop.getBoundingClientRect();
  if (rect.bottom > window.innerHeight - 12) pop.classList.add("up");
  const menu = pop.querySelector(".zone-menu");
  const selected = menu?.querySelector(".on");
  if (menu && selected) menu.scrollTop = Math.max(0, selected.offsetTop - menu.clientHeight / 2 + selected.clientHeight / 2);
}

function zonePicker() {
  const zone = zoneText(draftZoneOffset());
  const open = state.picker?.type === "zone";
  const query = open ? String(state.picker.query || "") : "";
  const needle = query.trim().toLowerCase();
  const options = ZONES.map(([value, city]) => {
    const text = zoneText(value);
    const blob = `${text.sign} ${city} ${value}`.toLowerCase();
    const hidden = needle && !blob.includes(needle) ? " hidden" : "";
    return `<button type="button" class="zone-option ${value === zone.value ? "on" : ""}" data-act="picker-zone" data-offset="${value}" data-find="${esc(blob)}"${hidden}><span>${esc(city)}</span><b>${esc(text.sign)}</b></button>`;
  }).join("");
  return `<div class="picker ${open ? "open" : ""}">
    <button type="button" class="picker-value" data-act="open-picker" data-picker="zone" aria-haspopup="listbox" aria-expanded="${open ? "true" : "false"}">
      <b>${esc(zone.sign)}</b><span>${esc(zone.city)}</span>
      <svg class="picker-chevron" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>
    </button>
    <input type="hidden" name="timezoneOffset" value="${esc(zone.value)}" />
    <div class="picker-pop" role="listbox" aria-label="Timezone"${open ? "" : " hidden"}>
      <input class="zone-search" data-act="zone-search" value="${esc(query)}" placeholder="Search city or UTC offset" spellcheck="false" />
      <div class="zone-menu">${options}</div>
    </div>
  </div>`;
}

function whenPicker(label, dateName, prefix, action) {
  const date = fieldValue(dateName);
  const time = timeText(prefix);
  const open = state.picker?.type === "when" && state.picker.prefix === prefix;
  const month = open ? state.picker.month : String(date || zonedToday()).slice(0, 7);
  const [year, part] = month.split("-").map(Number);
  const today = zonedToday();
  const cells = calendarCells(month, date);
  const days = cells
    .map((cell) => {
      const classes = ["cal-day", cell.outside ? "out" : "", cell.iso === today ? "today" : "", cell.selected ? "on" : ""].filter(Boolean).join(" ");
      return `<button type="button" class="${classes}" data-act="picker-day" data-date="${esc(dateName)}" data-day="${esc(cell.iso)}" data-prefix="${esc(prefix)}">${cell.day}</button>`;
    })
    .join("");
  const now = action ? `<button class="btn" type="button" data-act="${esc(action.act)}">${esc(action.label)}</button>` : "";
  return `<div class="field wide"><label>${esc(label)}</label><div class="when"><div class="picker ${open ? "open" : ""}">
    <button type="button" class="picker-value" data-act="open-picker" data-picker="when" data-prefix="${esc(prefix)}" data-date="${esc(dateName)}" aria-haspopup="dialog" aria-expanded="${open ? "true" : "false"}">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M3 10h18M8 3v4M16 3v4"/></svg>
      <b>${esc(dateText(date))}</b><span class="picker-clock-label">${esc(time)}</span>
    </button>
    <input type="hidden" name="${esc(dateName)}" value="${esc(date)}" />
    <div class="picker-pop" role="dialog" aria-label="${esc(label)}"${open ? "" : " hidden"}>
      <div class="picker-head">
        <button type="button" class="icon-btn" data-act="picker-month" data-prefix="${esc(prefix)}" data-delta="-1" aria-label="Previous month">‹</button>
        <b>${esc(MONTHS[part - 1] || "")} ${esc(year || "")}</b>
        <button type="button" class="icon-btn" data-act="picker-month" data-prefix="${esc(prefix)}" data-delta="1" aria-label="Next month">›</button>
      </div>
      <div class="cal-grid">${["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => `<span class="cal-dow">${day}</span>`).join("")}</div>
      <div class="cal-grid">${days}</div>
      <div class="picker-clock">
        <label>Hour<input name="${esc(prefix)}Hour" data-act="picker-part" data-max="23" inputmode="numeric" maxlength="2" value="${esc(pad2(fieldValue(`${prefix}Hour`) || "0"))}" /></label>
        <span>:</span>
        <label>Min<input name="${esc(prefix)}Minute" data-act="picker-part" data-max="59" inputmode="numeric" maxlength="2" value="${esc(pad2(fieldValue(`${prefix}Minute`) || "0"))}" /></label>
        <span>:</span>
        <label>Sec<input name="${esc(prefix)}Second" data-act="picker-part" data-max="59" inputmode="numeric" maxlength="2" value="${esc(pad2(fieldValue(`${prefix}Second`) || "0"))}" /></label>
      </div>
      <div class="picker-foot"><span>${esc(dateText(date))} ${esc(time)}</span></div>
    </div>
  </div>${now}</div></div>`;
}

function scanRangeFields() {
  const mode = rangeMode();
  if (mode === "block") {
    return `<div class="field"><label>Start block</label><input name="scanStartBlock" inputmode="numeric" value="${esc(fieldValue("scanStartBlock"))}" placeholder="26200000" /></div>
      <div class="field"><label>End block</label><div class="end-block"><input name="scanEndBlock" inputmode="numeric" value="${esc(fieldValue("scanEndBlock"))}" placeholder="Latest block" /><button class="btn" type="button" data-act="latest-block">Latest block</button></div></div>`;
  }
  return `${whenPicker("Start", "scanStartDate", "scanStart")}
    ${whenPicker("End", "scanEndDate", "scanEnd", { act: "current-time", label: "Now" })}`;
}

function telegramAudience() {
  const chats = state.data.telegramChats || [];
  if (!chats.length) return "Nobody else has pressed Start yet.";
  return chats
    .map((chat) => (chat.username ? `${chat.name} (@${chat.username})` : chat.name))
    .join(", ");
}

function buyerAudience() {
  const chats = state.data.buyerChats || [];
  if (!chats.length) return "Nobody else has pressed Start on Buyer Tracker yet.";
  return chats
    .map((chat) => (chat.username ? `${chat.name} (@${chat.username})` : chat.name))
    .join(", ");
}

function settingsPanel(id, body) {
  const hidden = settingsTabId() === id ? "" : " hidden";
  return `<div class="settings-panel" data-panel="${id}"${hidden}>${body}</div>`;
}

function viewSettings() {
  const settings = state.data.settings;
  const mode = rangeMode();
  const tabs = SETTINGS_TABS.map(
    ([id, label]) => `<button type="button" class="chip ${settingsTabId() === id ? "on" : ""}" data-act="settings-tab" data-tab="${id}" role="tab" aria-selected="${settingsTabId() === id ? "true" : "false"}">${label}</button>`,
  ).join("");
  const scan = settingsPanel(
    "scan",
    `<div class="settings">
      <div class="field wide">
        <label>Scan range</label>
        <div class="chips key-modes">
          <button type="button" class="chip ${mode === "date" ? "on" : ""}" data-act="range-mode" data-mode="date">Start and end time</button>
          <button type="button" class="chip ${mode === "block" ? "on" : ""}" data-act="range-mode" data-mode="block">Start and end block</button>
        </div>
        <p class="keys-note">Saved wallets and tokens stay. A time scan runs from the start through the end in the timezone below. Blocks already saved are skipped.</p>
      </div>
      <div class="field wide"><label>Timezone</label>${zonePicker()}</div>
      ${scanRangeFields()}
      <div class="field"><label>Auto scan every (minutes)</label><input name="scanIntervalMin" value="${esc(fieldValue("scanIntervalMin"))}" /></div>
      <div class="field"><label>Pages per pass</label><input name="maxPages" value="${esc(fieldValue("maxPages"))}" /></div>
    </div>
    <label class="check"><input type="checkbox" name="fastMode" ${checkedSetting("fastMode") ? "checked" : ""}/> Fast Mode: watch Dextools live pairs and paid boards, and alert only when the token is tied to a rival</label>
    <label class="check"><input type="checkbox" name="autoScan" ${checkedSetting("autoScan") ? "checked" : ""}/> Keep scanning enabled rivals on a timer</label>`,
  );
  const funding = settingsPanel(
    "funding",
    `<div class="settings">
      <div class="field"><label>Minimum funding (ETH)</label><input name="minFundingEth" value="${esc(fieldValue("minFundingEth"))}" /></div>
      <div class="field"><label>Maximum funding (ETH)</label><input name="maxFundingEth" value="${esc(fieldValue("maxFundingEth"))}" /></div>
      <div class="field"><label>Ignore incoming dust (ETH)</label><input name="dustEth" value="${esc(fieldValue("dustEth"))}" /></div>
      <div class="field"><label>Live liquidity floor (USD)</label><input name="rugLiquidityUsd" value="${esc(fieldValue("rugLiquidityUsd"))}" /></div>
    </div>
    <label class="check"><input type="checkbox" name="requireFirstFunder" ${checkedSetting("requireFirstFunder") ? "checked" : ""}/> Only keep a wallet when this rival is its first real ETH source</label>
    <p class="muted">Sample launches are funded with well under 1 ETH, so the maximum keeps treasury-sized transfers out of the waiting list. A wallet stays on the list when this rival is the first wallet that sent it real ETH. ${state.data.counts.ignored} wallets are hidden by that rule.</p>
    <div class="actions"><button class="btn" type="button" data-act="recheck">Re-check hidden wallets</button></div>`,
  );
  const etherscan = settingsPanel(
    "etherscan",
    `<div class="settings">
      <div class="field wide">
        <label>Etherscan API keys</label>
        <div class="chips key-modes">
          <button type="button" class="chip ${state.etherscanMode === "type" ? "on" : ""}" data-act="key-mode" data-mode="type">Type keys</button>
          <button type="button" class="chip ${state.etherscanMode === "file" ? "on" : ""}" data-act="key-mode" data-mode="file">Load from file</button>
        </div>
        <p class="keys-note">${etherscanStatus(settings)}</p>
        ${
          state.etherscanMode === "type"
            ? `<textarea data-act="etherscan-draft" rows="6" spellcheck="false" autocomplete="off" placeholder="One key per line. Paste as many as you have.">${esc(state.etherscanDraft)}</textarea>`
            : `<div class="actions">
                <button class="btn" type="button" data-act="pick-keys">Choose a text file</button>
                <span class="muted">${
                  state.etherscanFileName
                    ? `${esc(state.etherscanFileName)} · ${readKeys(state.etherscanDraft).length} keys ready to save`
                    : "Use a file like Etherscan APIs.txt, one key per line."
                }</span>
              </div>
              <input id="key-file" type="file" accept=".txt,text/plain,.csv" hidden />`
        }
      </div>
    </div>
    <div class="actions"><button class="btn" type="button" data-act="clear-key">Remove Etherscan keys</button></div>`,
  );
  const telegram = settingsPanel(
    "telegram",
    `<div class="settings">
      <div class="field wide">
        <label>Telegram alerts</label>
        <p class="keys-note">Leave Live on in the header so new transactions keep getting read. Fast Mode switches launch alerts to new Dextools pairs and paid alerts to the Dextools and Dexscreener boards. Alerts cover events from the moment you turn them on.</p>
        <p class="keys-note">Anyone who presses Start in the bot gets the same alerts. ${telegramAudience()}</p>
        <p class="keys-note">${settings.telegramBotTokenSet ? "Bot token saved. Paste a new one only if you want to replace it." : "No bot token saved yet."}</p>
        <input name="telegramBotToken" type="password" autocomplete="off" spellcheck="false" placeholder="Bot token from @BotFather" />
        <input name="telegramChatId" autocomplete="off" spellcheck="false" placeholder="Chat id" value="${esc(fieldValue("telegramChatId"))}" />
      </div>
    </div>
    <label class="check"><input type="checkbox" name="telegramAlerts" ${checkedSetting("telegramAlerts") ? "checked" : ""}/> Send a Telegram card for each new launch and paid promotion</label>
    <div class="actions">
      <button class="btn" type="button" data-act="telegram-test">Send test message</button>
      <button class="btn" type="button" data-act="clear-telegram">Remove Telegram token</button>
    </div>`,
  );
  const buyers = settingsPanel(
    "buyers",
    `<div class="settings">
      <div class="field wide">
        <label>Buyer Tracker</label>
        <p class="keys-note">Name: Buyer Tracker · @ETHBuyerTrackerBot. This bot only sends buyer buys and sells. Launch alerts stay on the other bot.</p>
        <p class="keys-note">Every person who presses Start in @ETHBuyerTrackerBot gets the same buy and sell alerts. The saved chat is included too. ${buyerAudience()}</p>
        <p class="keys-note">${settings.buyerBotTokenSet ? "@ETHBuyerTrackerBot token saved. Paste a new one only if you want to replace it." : "Paste the @ETHBuyerTrackerBot token from @BotFather."}</p>
        <input name="buyerBotToken" type="password" autocomplete="off" spellcheck="false" placeholder="@ETHBuyerTrackerBot token from @BotFather" />
        <input name="buyerChatId" autocomplete="off" spellcheck="false" placeholder="Chat id" value="${esc(fieldValue("buyerChatId"))}" />
      </div>
    </div>
    <label class="check"><input type="checkbox" name="buyerAlerts" ${checkedSetting("buyerAlerts") ? "checked" : ""}/> Send a Buyer Tracker message for each buy or sell</label>
    <div class="actions">
      <button class="btn" type="button" data-act="buyer-test">Send buyer test</button>
      <button class="btn" type="button" data-act="clear-buyer-token">Remove Buyer Tracker token</button>
    </div>`,
  );
  const trends = settingsPanel(
    "trends",
    `<div class="settings">
      <div class="field wide">
        <label>Narrative trends</label>
        <p class="keys-note">Counts every ETH and WETH pair on Dextools live that shares a name or ticker inside the window. Rival tokens are not required. Rising is the start. Trending means it has caught on. Exploding means it is running. The last count means the whole market is on that name. Alerts go out on the launch bot. The Trends page can show 1h, 6h, 12h, 24h, 3d, and 7d.</p>
      </div>
      <div class="field"><label>Window (minutes)</label><input name="trendWindowMin" type="number" min="5" max="1440" step="1" value="${esc(fieldValue("trendWindowMin") || "60")}" /></div>
      <div class="field"><label>Rising count</label><input name="trendRising" type="number" min="2" max="500" step="1" value="${esc(fieldValue("trendRising") || "3")}" /></div>
      <div class="field"><label>Trending count</label><input name="trendTrending" type="number" min="2" max="500" step="1" value="${esc(fieldValue("trendTrending") || "5")}" /></div>
      <div class="field"><label>Exploding count</label><input name="trendExploding" type="number" min="2" max="500" step="1" value="${esc(fieldValue("trendExploding") || "7")}" /></div>
      <div class="field"><label>Whole market count</label><input name="trendMarket" type="number" min="2" max="500" step="1" value="${esc(fieldValue("trendMarket") || "10")}" /></div>
    </div>
    <label class="check"><input type="checkbox" name="trendAlerts" ${checkedSetting("trendAlerts") ? "checked" : ""}/> Send a trend alert when a name starts rising, trends, explodes, or takes the market</label>
    <div class="actions"><button class="btn" type="button" data-act="trend-samples">Show trend messages</button></div>`,
  );
  return `<form id="settings" class="card">
    <div class="settings-tabs" role="tablist">${tabs}</div>
    ${scan}${funding}${etherscan}${telegram}${buyers}${trends}
    <div class="err" id="settings-err"></div>
    <div class="actions"><button class="btn primary" type="submit">Save settings</button></div>
  </form>`;
}

function manageBuyerTable(modal) {
  const buyers = state.data?.buyers || [];
  if (!buyers.length) return `<tr><td colspan="3" class="muted">No buyers yet.</td></tr>`;
  return buyers.map((buyer) => {
    const name = buyerName(buyer);
    if (modal.confirmId === buyer.id) {
      return `<tr>
        <td>${esc(name)}</td>
        <td class="addr">${esc(buyer.address)} ${copyIcon(buyer.address)}</td>
        <td class="manage-confirm">
          <span>Delete ${esc(name)}? Saved trades for this wallet are removed.</span>
          <button type="button" class="btn danger" data-act="buyer-delete-yes" data-id="${buyer.id}">Delete</button>
          <button type="button" class="btn" data-act="buyer-delete-no">Cancel</button>
        </td>
      </tr>`;
    }
    return `<tr class="${modal.editing === buyer.id ? "on" : ""}">
      <td>${esc(name)}</td>
      <td class="addr">${esc(buyer.address)} ${copyIcon(buyer.address)}</td>
      <td class="mini-actions">
        ${iconAction({ kind: "chart", label: "Chart", act: "wallet-chart", id: buyer.id })}
        ${iconAction({ kind: "edit", label: "Edit", act: "edit-buyer", id: buyer.id })}
        ${iconAction({ kind: "delete", label: "Delete", act: "remove-buyer", id: buyer.id })}
      </td>
    </tr>`;
  }).join("");
}

function captureBuyerDraft() {
  const form = document.getElementById("buyer-manage");
  if (!form || state.modal?.mode !== "manage-buyers") return;
  state.modal.draft = { label: form.label.value, address: form.address.value };
}

function paintManageBuyers(root) {
  const modal = state.modal;
  const signature = JSON.stringify({
    buyers: (state.data?.buyers || []).map((buyer) => [buyer.id, buyer.label, buyer.address]),
    editing: modal.editing || 0,
    confirmId: modal.confirmId || 0,
    error: modal.error || "",
    draft: modal.draft || { label: "", address: "" },
  });
  if (root.dataset.mode === "manage-buyers" && root.dataset.sig === signature) return;
  const field = document.activeElement;
  const typing = field && root.contains(field) && field.matches("input");
  const typingName = typing ? field.name || "" : "";
  const caret = typing && typeof field.selectionStart === "number" ? field.selectionStart : null;
  const caretEnd = typing && typeof field.selectionEnd === "number" ? field.selectionEnd : null;
  const draft = modal.draft || { label: "", address: "" };
  root.dataset.mode = "manage-buyers";
  root.dataset.id = "";
  root.dataset.sig = signature;
  root.innerHTML = `<div class="modal-back"><section class="modal manage" role="dialog" aria-modal="true" aria-label="Manage Buyers">
    <div class="manage-head">
      <div><h3>Manage Buyers</h3><p class="muted">Add, edit, or delete a watched wallet.</p></div>
      <button class="icon-close" type="button" data-act="close" aria-label="Close">×</button>
    </div>
    <form id="buyer-manage" class="manage-form">
      <div class="field"><label>Label <span class="muted">(optional)</span></label><input name="label" value="${esc(draft.label || "")}" /></div>
      <div class="field"><label>Address</label><input name="address" value="${esc(draft.address || "")}" required spellcheck="false" /></div>
      <div class="actions">
        ${modal.editing ? `<button class="btn" type="button" data-act="buyer-cancel">Cancel</button>` : ""}
        ${modal.editing ? `<button class="btn primary" type="submit">Save</button>` : iconAction({ kind: "add", label: "Add buyer", type: "submit" })}
      </div>
    </form>
    <div class="err" id="form-err">${esc(modal.error || "")}</div>
    <div class="manage-table">
      <table>
        <thead><tr><th>Label</th><th>Address</th><th></th></tr></thead>
        <tbody>${manageBuyerTable(modal)}</tbody>
      </table>
    </div>
  </section></div>`;
  if (typingName) {
    const next = root.querySelector(`[name="${CSS.escape(typingName)}"]`);
    if (next) {
      next.focus();
      if (caret != null && next.setSelectionRange) next.setSelectionRange(caret, caretEnd ?? caret);
    }
  } else if (modal.editing) {
    const address = root.querySelector("[name=address]");
    address?.focus();
    if (address?.setSelectionRange) address.setSelectionRange(address.value.length, address.value.length);
  }
}

function paintModal() {
  const root = document.getElementById("modal");
  if (!state.modal) {
    root.innerHTML = "";
    root.dataset.mode = "";
    root.dataset.id = "";
    root.dataset.sig = "";
    return;
  }
  if (state.modal.mode === "manage-buyers") {
    paintManageBuyers(root);
    return;
  }
  if (root.dataset.mode === state.modal.mode && root.dataset.id === String(state.modal.id || "")) return;
  const modal = state.modal;
  if (modal.mode === "buyer-add" || modal.mode === "buyer-edit") {
    const buyer = modal.buyer || { label: "", address: "" };
    root.innerHTML = `<div class="modal-back"><form class="modal" id="buyer-form">
      <h3>${modal.mode === "buyer-edit" ? "Edit buyer" : "Add buyer"}</h3>
      <div class="field"><label>Label <span class="muted">(optional)</span></label><input name="label" value="${esc(buyer.label || "")}" /></div>
      <div class="field"><label>Address</label><input name="address" value="${esc(buyer.address || "")}" required spellcheck="false" /></div>
      <div class="err" id="form-err"></div>
      <div class="actions"><button class="btn" type="button" data-act="close">Cancel</button><button class="btn primary" type="submit">Save</button></div>
    </form></div>`;
  } else if (modal.mode === "confirm") {
    root.innerHTML = `<div class="modal-back"><form class="modal" id="confirm">
      <h3>${esc(modal.title)}</h3>
      <p class="muted">${esc(modal.body)}</p>
      <div class="actions"><button class="btn" type="button" data-act="close">Cancel</button><button class="btn danger" type="submit">${esc(modal.confirm || "Delete")}</button></div>
    </form></div>`;
  } else {
    const rival = modal.rival || { label: "", address: "", notes: "", color: COLORS[0], enabled: 1 };
    root.innerHTML = `<div class="modal-back"><form class="modal" id="rival-form">
      <h3>${modal.mode === "edit" ? "Edit rival" : "Add rival"}</h3>
      <div class="field"><label>Name</label><input name="label" value="${esc(rival.label)}" required /></div>
      <div class="field"><label>Address</label><input name="address" value="${esc(rival.address)}" required spellcheck="false" /></div>
      <div class="field"><label>Notes</label><textarea name="notes" rows="3">${esc(rival.notes || "")}</textarea></div>
      <div class="field"><label>Color</label><div class="colors">${COLORS.map((color) => `<button type="button" data-act="color" data-color="${color}" class="${rival.color === color ? "on" : ""}" style="background:${color}"></button>`).join("")}</div></div>
      ${modal.mode === "edit" ? `<label class="check"><input type="checkbox" name="enabled" ${rival.enabled ? "checked" : ""}/> Include in Scan all</label>` : ""}
      <div class="err" id="form-err"></div>
      <div class="actions"><button class="btn" type="button" data-act="close">Cancel</button><button class="btn primary" type="submit">Save</button></div>
    </form></div>`;
  }
  root.dataset.mode = modal.mode;
  root.dataset.id = String(modal.id || "");
}

function preferredPair(token) {
  const pairs = token.pairs || [];
  return (
    pairs.find((pair) => Number(pair.is_main) === 1) ||
    pairs.slice().sort((a, b) => (Number(b.txns_total) || 0) - (Number(a.txns_total) || 0) || (Number(b.liquidity_usd) || 0) - (Number(a.liquidity_usd) || 0))[0] ||
    {}
  );
}

function formatExact(unix) {
  if (!unix) return "—";
  const date = new Date((Number(unix) + zoneOffset() * 3600) * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function realSortValue(row, key) {
  if (key === "no") return row.no;
  if (key === "time") return row.time;
  if (key === "type") return row.type || "";
  if (key === "mcap") return row.mcap;
  if (key === "amount") return row.amountWei || null;
  if (key === "count") return row.count;
  if (key === "maker") return row.maker || "";
  if (key === "tx") return row.tx || "";
  return "";
}

function sortedRealRows(rows) {
  const sort = state.sort.realBuyers || { key: "time", dir: "desc" };
  const factor = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => compareSort(realSortValue(a, sort.key), realSortValue(b, sort.key), factor));
}

function realHeader(column) {
  const sort = state.sort.realBuyers || {};
  const active = sort.key === column.key;
  const mark = active ? (sort.dir === "asc" ? "↑" : "↓") : "";
  const align = column.align === "right" ? "num" : "";
  return `<th class="${align}"><button type="button" class="sort ${active ? "on" : ""}" data-act="real-sort" data-key="${esc(column.key)}" data-type="${esc(column.type)}">${esc(column.label)}${mark ? `<span>${mark}</span>` : ""}</button></th>`;
}

function realPager(page) {
  const from = page.count ? page.start + 1 : 0;
  const to = page.start + page.rows.length;
  const buttons = pageButtons(page.page, page.pages)
    .map((item) => {
      if (item === "…") return `<span class="pager-gap" aria-hidden="true">…</span>`;
      const current = item === page.page;
      return `<button type="button" class="page-btn ${current ? "on" : ""}" data-act="real-page" data-page="${item}" ${current ? 'aria-current="page"' : ""}>${item}</button>`;
    })
    .join("");
  return `<footer class="pager">
    <p class="pager-meta">Showing <b>${from.toLocaleString()}–${to.toLocaleString()}</b> of <b>${page.count.toLocaleString()}</b></p>
    <nav class="pager-pages" aria-label="Real buyer pages">
      <button type="button" class="page-btn" data-act="real-page" data-page="1" ${page.page === 1 ? "disabled" : ""} aria-label="First page">«</button>
      <button type="button" class="page-btn" data-act="real-page" data-page="${page.page - 1}" ${page.page === 1 ? "disabled" : ""} aria-label="Previous page">‹</button>
      ${buttons}
      <button type="button" class="page-btn" data-act="real-page" data-page="${page.page + 1}" ${page.page === page.pages ? "disabled" : ""} aria-label="Next page">›</button>
      <button type="button" class="page-btn" data-act="real-page" data-page="${page.pages}" ${page.page === page.pages ? "disabled" : ""} aria-label="Last page">»</button>
    </nav>
    <label class="pager-size">Rows
      <select data-act="real-page-size" aria-label="Rows per page">
        ${[25, 50, 100].map((size) => `<option value="${size}" ${size === page.size ? "selected" : ""}>${size}</option>`).join("")}
      </select>
    </label>
  </footer>`;
}

const REAL_WINDOWS = [
  ["5m", "First 5m", 5 * 60],
  ["15m", "First 15m", 15 * 60],
  ["30m", "First 30m", 30 * 60],
  ["1h", "First 1h", 60 * 60],
  ["6h", "First 6h", 6 * 60 * 60],
  ["12h", "First 12h", 12 * 60 * 60],
  ["24h", "First 24h", 24 * 60 * 60],
];

function ethToWeiFilter(value) {
  const text = String(value ?? "").trim();
  if (!text || text === ".") return null;
  if (!/^\d*\.?\d*$/.test(text)) return null;
  const [whole = "0", frac = ""] = text.split(".");
  if (!whole && !frac) return null;
  const digits = `${whole || "0"}${frac.padEnd(18, "0").slice(0, 18)}`.replace(/^0+/, "") || "0";
  try {
    return BigInt(digits);
  } catch {
    return null;
  }
}

function rowAmountWei(row) {
  try {
    return BigInt(row.amountWei || "0");
  } catch {
    return 0n;
  }
}

function filterRangeError() {
  const min = ethToWeiFilter(state.tradeFilter.minEth);
  const max = ethToWeiFilter(state.tradeFilter.maxEth);
  if (min != null && max != null && min > max) return "Min amount must be less than or equal to max amount.";
  return "";
}

function tradeMatches(row) {
  const filter = state.tradeFilter;
  const address = filter.address.trim().toLowerCase();
  if (address && !String(row.maker || "").toLowerCase().includes(address)) return false;
  if (filter.side === "buy" && row.type !== "buy") return false;
  if (filter.side === "sell" && row.type !== "sell") return false;
  const min = ethToWeiFilter(filter.minEth);
  const max = ethToWeiFilter(filter.maxEth);
  if (min != null && max != null && min > max) return false;
  const wei = rowAmountWei(row);
  if (min != null && wei < min) return false;
  if (max != null && wei > max) return false;
  return true;
}

function filteredTrades(rows) {
  return (rows || []).filter((row) => tradeMatches(row));
}

function resetTradeView() {
  state.pages.realBuyers = 1;
  if (state.buyerChart) state.buyerChart.view = null;
}

function tradeFilterBar(rows, { axis = false } = {}) {
  const filter = state.tradeFilter;
  const side = (id, label) => `<button type="button" class="chip ${filter.side === id ? "on" : ""}" data-act="trade-side" data-side="${id}">${label}</button>`;
  const matched = filterRangeError() ? 0 : filteredTrades(rows).length;
  const axisMode = state.chartAxis === "amount" ? "amount" : "mcap";
  const axisField = axis
    ? `<div class="trade-field"><span>Y axis</span><div class="chips">
        <button type="button" class="chip ${axisMode === "mcap" ? "on" : ""}" data-act="chart-axis" data-axis="mcap">M. Cap</button>
        <button type="button" class="chip ${axisMode === "amount" ? "on" : ""}" data-act="chart-axis" data-axis="amount">Amount</button>
      </div></div>`
    : "";
  const selected = filter.address.trim().toLowerCase();
  const buyers = state.data?.buyers || [];
  const buyerOptions = [`<option value="">Any buyer</option>`]
    .concat(
      buyers.map((buyer) => {
        const address = buyer.address || "";
        const name = buyer.label || shortAddr(address);
        const on = selected && selected === address.toLowerCase() ? " selected" : "";
        return `<option value="${esc(address)}"${on}>${esc(name)}</option>`;
      }),
    )
    .join("");
  const note = filterRangeError() || `${matched.toLocaleString()} of ${(rows || []).length.toLocaleString()} trades`;
  return `<div class="trade-filters">
    <label class="trade-field"><span>Buyer</span><select data-act="trade-buyer">${buyerOptions}</select></label>
    <label class="trade-field trade-address"><span>Address</span><input data-act="trade-address" placeholder="Maker address" spellcheck="false" value="${esc(filter.address)}" /></label>
    <div class="trade-field"><span>Side</span><div class="chips">${side("all", "All")}${side("buy", "Only buy")}${side("sell", "Only sell")}</div></div>
    <label class="trade-field"><span>Min amount</span><input data-act="trade-min" inputmode="decimal" placeholder="ETH" value="${esc(filter.minEth)}" /></label>
    <label class="trade-field"><span>Max amount</span><input data-act="trade-max" inputmode="decimal" placeholder="ETH" value="${esc(filter.maxEth)}" /></label>
    ${axisField}
    <p class="muted trade-note">${esc(note)}</p>
  </div>`;
}

function realLaunch(ledger) {
  const token = (state.data?.tokens || []).find((item) => item.address === ledger.address);
  return Number(token?.created_at) || Number(ledger.launchedAt) || 0;
}

function spanSeconds(value, unit) {
  if (value === "" || value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return number * (unit === "h" ? 3600 : 60);
}

function profitInSpan(rows, start, end) {
  let buy = 0n;
  let sell = 0n;
  let buys = 0;
  let sells = 0;
  for (const row of rows) {
    const time = Number(row.time) || 0;
    if (!time || time < start || (end != null && time >= end)) continue;
    let wei = 0n;
    try {
      wei = BigInt(row.amountWei || "0");
    } catch {
      wei = 0n;
    }
    if (row.type === "sell") {
      sell += wei;
      sells += 1;
    } else {
      buy += wei;
      buys += 1;
    }
  }
  return { wei: buy - sell, buys, sells };
}

function profitText(result) {
  const wei = result.wei;
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const whole = abs / 10n ** 18n;
  const fullFrac = (abs % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  const exact = `${negative ? "-" : ""}${whole}${fullFrac ? `.${fullFrac}` : ""} ETH`;
  const shown = `${negative ? "-" : ""}${formatEth(abs.toString())} ETH`;
  const counts = `${countWord(result.buys, "buy", "buys")} + ${countWord(result.sells, "sell", "sells")}`;
  const tone = wei > 0n ? "up" : wei < 0n ? "down" : "";
  return `<span class="chg ${tone}" title="${esc(exact)}">${esc(shown)}</span><small>${esc(counts)}</small>`;
}

function spanLabel(seconds) {
  if (seconds == null) return "";
  if (seconds === 0) return "launch";
  const hours = seconds / 3600;
  if (Number.isInteger(hours)) return `${hours}h`;
  const minutes = seconds / 60;
  if (Number.isInteger(minutes)) return `${minutes}m`;
  return `${Math.round(minutes * 10) / 10}m`;
}

function customProfitCard(rows, launch) {
  const span = state.realSpan;
  const from = spanSeconds(span.from, span.fromUnit);
  const to = spanSeconds(span.to, span.toUnit);
  const invalid = from != null && to != null && to <= from;
  const start = launch + (from || 0);
  const end = to == null ? null : launch + to;
  const fromText = from == null ? "launch" : spanLabel(from);
  const toText = to == null ? "latest" : spanLabel(to);
  const result = invalid ? "" : profitText(profitInSpan(rows, start, end));
  const unit = (name, value) => `<select data-act="${name}" aria-label="${name.includes("from") ? "From unit" : "To unit"}">
    <option value="m" ${value === "h" ? "" : "selected"}>min</option>
    <option value="h" ${value === "h" ? "selected" : ""}>hour</option>
  </select>`;
  return `<article class="profit-window profit-custom">
    <b>Custom</b>
    <label class="span-row">From <input data-act="real-from" inputmode="decimal" aria-label="Custom start" value="${esc(span.from)}" />${unit("real-from-unit", span.fromUnit)}</label>
    <label class="span-row">To <input data-act="real-to" inputmode="decimal" aria-label="Custom end" value="${esc(span.to)}" />${unit("real-to-unit", span.toUnit)}</label>
    <small>${invalid ? "End must be after the start." : esc(`${fromText} to ${toText}`)}</small>
    ${invalid ? "" : result}
  </article>`;
}

function realProfitBar(rows, launch) {
  if (!launch) return `<p class="buyers-note">Launch time is not known yet, so the time windows cannot be measured.</p>`;
  const cards = REAL_WINDOWS.map(([, label, seconds]) => {
    const result = profitInSpan(rows, launch, launch + seconds);
    return `<article class="profit-window"><b>${esc(label)}</b>${profitText(result)}</article>`;
  }).join("");
  return `<div class="profit-windows" aria-label="Profit after launch">${cards}${customProfitCard(rows, launch)}</div>`;
}

function realBuyerTable(rows, emptyText = "No real buyer trades yet.") {
  const columns = [
    { label: "No", key: "no", type: "number" },
    { label: `Time (${zoneLabel()})`, key: "time", type: "number" },
    { label: "Type", key: "type", type: "text" },
    { label: "M. Cap", key: "mcap", type: "number", align: "right" },
    { label: "Amount", key: "amount", type: "number", align: "right" },
    { label: "Count", key: "count", type: "number", align: "right" },
    { label: "Maker", key: "maker", type: "text" },
    { label: "Tx", key: "tx", type: "text" },
  ];
  const sorted = sortedRealRows(rows);
  const size = [25, 50, 100].includes(state.realPageSize) ? state.realPageSize : 25;
  const pages = Math.max(1, Math.ceil(sorted.length / size) || 1);
  let page = state.pages.realBuyers || 1;
  if (page > pages) page = pages;
  if (page < 1) page = 1;
  state.pages.realBuyers = page;
  const start = (page - 1) * size;
  const slice = sorted.slice(start, start + size);
  const body = slice
    .map((row) => {
      const maker = row.maker
        ? `<a class="addr" href="https://etherscan.io/address/${esc(row.maker)}" target="_blank" rel="noreferrer" title="${esc(row.maker)}">${esc(row.maker)}</a>`
        : "—";
      return `<tr>
        <td class="num">${esc(row.no)}</td>
        <td>${esc(formatExact(row.time))}</td>
        <td><span class="pill ${row.type === "buy" ? "live" : "rugged"}">${row.type === "buy" ? "Buy" : "Sell"}</span></td>
        <td class="num">${esc(row.mcap == null ? "—" : exactUsd(row.mcap))}</td>
        <td class="num">${esc(row.amountWei ? `${formatEth(row.amountWei)} ETH` : "—")}</td>
        <td class="num">${esc(row.count == null ? "—" : row.count)}</td>
        <td class="maker-cell">${maker}</td>
        <td class="links"><a class="link-pill" href="https://etherscan.io/tx/${esc(row.tx)}" target="_blank" rel="noreferrer">Etherscan</a></td>
      </tr>`;
    })
    .join("");
  return `<div class="table-panel">
    <div class="table-scroll">
      <table>
        <thead><tr>${columns.map(realHeader).join("")}</tr></thead>
        <tbody>${body || `<tr><td colspan="8" class="muted">${esc(emptyText)}</td></tr>`}</tbody>
      </table>
    </div>
    ${realPager({ rows: slice, page, pages, start, count: sorted.length, size })}
  </div>`;
}

function fetchProgress(percent, label) {
  const value = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  const text = label || "Fetching pool trades";
  return `<div class="fetch-panel"><div class="fetch-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${value}" aria-label="${esc(text)}">
    <div class="fetch-progress-top"><span>${esc(text)}</span><b>${value}%</b></div>
    <div class="fetch-progress-track"><span style="width:${value}%"></span></div>
  </div></div>`;
}

function watchBuyerProgress(address, apply) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const response = await fetch(`/api/tokens/${address}/real-buyers/progress`);
      const body = await response.json();
      if (!stopped) apply(Number(body.percent) || 0, body.label || "Fetching pool trades");
    } catch {
      // The next tick tries again.
    }
  };
  tick();
  const timer = setInterval(tick, 400);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function realBuyerSignature(ledger) {
  return JSON.stringify({
    address: ledger.address,
    loading: ledger.loading,
    error: ledger.error || "",
    ready: ledger.ready,
    progress: ledger.progress || 0,
    progressLabel: ledger.progressLabel || "",
    rows: ledger.rows || [],
    launch: realLaunch(ledger),
    span: state.realSpan,
    filter: state.tradeFilter,
    sort: state.sort.realBuyers,
    page: state.pages.realBuyers,
    size: state.realPageSize,
  });
}

function buyerChartSignature(chart) {
  return JSON.stringify({
    address: chart.address,
    loading: chart.loading,
    error: chart.error || "",
    ready: chart.ready,
    rows: chart.rows || [],
    candles: chart.candles || [],
    progress: chart.progress || 0,
    progressLabel: chart.progressLabel || "",
    view: chart.view || null,
    filter: state.tradeFilter,
    axis: chartAxis(),
  });
}

function syncTradeResults() {
  const error = filterRangeError();
  document.querySelectorAll("#real-buyers .trade-note, #buyer-chart .trade-note").forEach((note) => {
    const rows = note.closest("#buyer-chart") ? state.buyerChart?.rows || [] : state.realBuyers?.rows || [];
    const matched = error ? 0 : filteredTrades(rows).length;
    note.textContent = error || `${matched.toLocaleString()} of ${rows.length.toLocaleString()} trades`;
  });
  const results = document.getElementById("real-buyer-results");
  const ledger = state.realBuyers;
  if (results && ledger && !ledger.loading && !ledger.error) {
    const source = ledger.rows || [];
    const matched = error ? [] : filteredTrades(source);
    const emptyText = error || (source.length ? "No trades match these filters." : "No real buyer trades yet.");
    const waiting = !ledger.ready && !source.length;
    results.innerHTML = waiting ? "" : `${realProfitBar(matched, realLaunch(ledger))}${realBuyerTable(matched, emptyText)}`;
  }
  const stage = document.querySelector("#buyer-chart .chart-stage");
  const chart = state.buyerChart;
  if (stage && chart && !chart.loading && !chart.error) {
    const matched = error ? [] : filteredTrades(chart.rows || []);
    const svg = buyerChartSvg(matched, chart.view || null, chart.candles || []);
    const existing = stage.querySelector(".buyer-chart");
    if (existing) existing.outerHTML = svg;
    else stage.insertAdjacentHTML("afterbegin", svg);
  }
  const address = state.tradeFilter.address;
  document.querySelectorAll("[data-act='trade-address']").forEach((input) => {
    if (input === document.activeElement || input.value === address) return;
    input.value = address;
  });
  const selected = address.trim().toLowerCase();
  document.querySelectorAll("[data-act='trade-buyer']").forEach((select) => {
    if (select === document.activeElement) return;
    const match = [...select.options].find((option) => option.value && option.value.toLowerCase() === selected);
    select.value = match ? match.value : "";
  });
  document.querySelectorAll("#real-buyers .trade-filters [data-act='trade-side'], #buyer-chart .trade-filters [data-act='trade-side']").forEach((button) => {
    button.classList.toggle("on", button.dataset.side === state.tradeFilter.side);
  });
  const realRoot = document.getElementById("real-buyers");
  if (realRoot && ledger) realRoot.dataset.sig = realBuyerSignature(ledger);
  const chartRoot = document.getElementById("buyer-chart");
  if (chartRoot && chart) chartRoot.dataset.sig = buyerChartSignature(chart);
}

function paintRealBuyers() {
  let root = document.getElementById("real-buyers");
  const ledger = state.realBuyers;
  if (!ledger) {
    root?.remove();
    return;
  }
  const signature = realBuyerSignature(ledger);
  if (!root) {
    root = document.createElement("div");
    root.id = "real-buyers";
    document.body.appendChild(root);
  }
  if (root.dataset.sig === signature) return;
  const field = document.activeElement;
  const typing = field && root.contains(field) && field.matches("input, select");
  const typingAct = typing ? field.dataset.act || "" : "";
  const caret = typing && typeof field.selectionStart === "number" ? field.selectionStart : null;
  const caretEnd = typing && typeof field.selectionEnd === "number" ? field.selectionEnd : null;
  root.dataset.sig = signature;
  const token = (state.data?.tokens || []).find((item) => item.address === ledger.address);
  const title = token?.symbol || ledger.symbol || "Token";
  const waiting = !ledger.loading && !ledger.error && !ledger.ready && !(ledger.rows || []).length;
  const partial = !ledger.loading && !ledger.error && !ledger.ready && (ledger.rows || []).length > 0;
  const note = ledger.error
    ? `<p class="muted buyers-note">${esc(ledger.error)}</p>`
    : waiting
      ? `<p class="muted buyers-note">Real buyer trades are still being counted.</p>`
      : partial
        ? `<p class="muted buyers-note">Some trades are still being counted. The rows below are the ones finished so far.</p>`
        : "";
  const source = ledger.rows || [];
  const matched = filterRangeError() ? [] : filteredTrades(source);
  const emptyText = filterRangeError() || (source.length ? "No trades match these filters." : "No real buyer trades yet.");
  const table = ledger.loading || ledger.error || waiting ? "" : realBuyerTable(matched, emptyText);
  const windows = ledger.loading || ledger.error || waiting ? "" : realProfitBar(matched, realLaunch(ledger));
  const filters = ledger.loading || ledger.error || waiting ? "" : tradeFilterBar(source);
  const body = ledger.loading ? fetchProgress(ledger.progress, ledger.progressLabel) : `${note}${filters}<div id="real-buyer-results">${windows}${table}</div>`;
  root.innerHTML = `<div class="buyers-back"><section class="buyers-modal" role="dialog" aria-modal="true" aria-label="Real buyers">
    <div class="buyers-head">
      <div><h3>Real buyers · ${esc(title)}</h3><p class="muted">Every buy and sell that is not a team transaction. Filters apply to the table and the profit windows.</p></div>
      <button class="icon-close" data-act="close-real" aria-label="Close">×</button>
    </div>
    ${body}
  </section></div>`;
  if (typingAct) {
    const next = root.querySelector(`[data-act="${CSS.escape(typingAct)}"]`);
    if (next) {
      next.focus();
      if (caret != null && next.matches("input") && next.setSelectionRange) next.setSelectionRange(caret, caretEnd ?? caret);
    }
  }
}

async function fetchRealBuyerPayload(address) {
  let best = null;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`/api/tokens/${address}/real-buyers${attempt ? "?fresh=1" : ""}`);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Real buyers could not be loaded.");
      best = body;
      if (body.complete !== false) return body;
    } catch (error) {
      lastError = error;
    }
  }
  if (best) return best;
  throw lastError || new Error("Real buyers could not be loaded.");
}

async function loadRealBuyers(address) {
  const stop = watchBuyerProgress(address, (percent, label) => {
    if (!state.realBuyers || state.realBuyers.address !== address || !state.realBuyers.loading) return;
    if (state.realBuyers.progress === percent && state.realBuyers.progressLabel === label) return;
    state.realBuyers.progress = percent;
    state.realBuyers.progressLabel = label;
    paintRealBuyers();
  });
  try {
    const body = await fetchRealBuyerPayload(address);
    if (!state.realBuyers || state.realBuyers.address !== address) return;
    const ordered = [...(body.rows || [])].sort((a, b) => (Number(a.time) || Number(a.block) || 0) - (Number(b.time) || Number(b.block) || 0) || String(a.tx).localeCompare(String(b.tx)));
    const known = (state.data?.tokens || []).find((item) => item.address === address);
    state.realBuyers = {
      address,
      loading: false,
      ready: Boolean(body.ready),
      symbol: body.symbol || "",
      launchedAt: Number(known?.created_at) || 0,
      error: "",
      rows: ordered.map((row, index) => ({
        no: index + 1,
        time: Number(row.time) || null,
        type: row.type === "sell" ? "sell" : "buy",
        mcap: row.mcap == null ? null : Number(row.mcap),
        amount: row.amountWei ? Number(row.amountWei) / 1e18 : null,
        amountWei: row.amountWei || "",
        amountUsd: row.amountUsd == null ? null : Number(row.amountUsd),
        count: row.count == null ? null : Number(row.count),
        maker: row.maker || "",
        tx: row.tx || "",
      })),
    };
  } catch (error) {
    if (!state.realBuyers || state.realBuyers.address !== address) return;
    state.realBuyers = { address, loading: false, ready: false, error: error.message, rows: [] };
  } finally {
    stop();
  }
  const root = document.getElementById("real-buyers");
  if (root) root.dataset.sig = "";
  paintRealBuyers();
}

const BUYER_ANIMALS = [
  { id: "flea", label: "Flea", range: "≤ $1", color: "#bf8c00", w: 576, h: 512, path: "M164.5 107.4l33.4-73.5c5.5-12.1 .1-26.3-11.9-31.8s-26.3-.1-31.8 11.9L128 71.7 101.9 14.1C96.4 2 82.1-3.3 70.1 2.1S52.7 21.9 58.1 33.9l33.4 73.5c-10.2 7.1-18.2 17-22.9 28.6l-17 0-4.1-20.7c-2.6-13-15.2-21.4-28.2-18.8S-2.1 111.7 .5 124.7l8 40C10.7 175.9 20.6 184 32 184l32 0 0 23.3-37.8 9.5c-9.5 2.4-16.6 10.2-17.9 19.9l-8 56c-1.9 13.1 7.2 25.3 20.4 27.2s25.3-7.2 27.2-20.4l5.7-40 18.4-4.6C82.7 274.6 103.8 288 128 288s45.3-13.4 56.1-33.2l18.4 4.6 5.7 40c1.9 13.1 14 22.2 27.2 20.4s22.2-14 20.4-27.2l-8-56c-1.4-9.7-8.5-17.5-17.9-19.9L192 207.3l0-23.3 32 0c11.4 0 21.3-8.1 23.5-19.3l8-40c2.6-13-5.8-25.6-18.8-28.2s-25.6 5.8-28.2 18.8L204.3 136l-17 0c-4.7-11.6-12.7-21.5-22.9-28.6zM496 286.5l65.6-47c10.8-7.7 13.3-22.7 5.6-33.5s-22.7-13.3-33.5-5.6l-51.4 36.8 6.1-62.9c1.3-13.2-8.4-24.9-21.6-26.2s-24.9 8.4-26.2 21.6L432.8 250c-12.3 1-24.2 5.6-34.1 13.3L384 254.8l6.8-20c4.2-12.6-2.5-26.2-15-30.4s-26.2 2.5-30.4 15l-13.1 38.6c-3.7 10.8 .8 22.8 10.7 28.5l27.7 16L359 322.7 321.5 312c-9.4-2.7-19.5 .6-25.5 8.3l-34.9 44.5c-8.2 10.4-6.4 25.5 4.1 33.7s25.5 6.4 33.7-4.1l25-31.8 18.2 5.2c-.5 22.6 11 44.7 32 56.8s45.9 11 65.2-.7l13.6 13.2-15.1 37.5c-4.9 12.3 1 26.3 13.3 31.2s26.3-1 31.2-13.3L503.5 440c3.6-9.1 1.4-19.4-5.6-26.2l-28-27.1 11.6-20.1 27.7 16c9.9 5.7 22.5 3.7 30-4.9L566.2 347c8.7-10 7.8-25.1-2.2-33.9s-25.1-7.8-33.9 2.2l-13.9 15.9-14.7-8.5c1.7-12.4-.2-25-5.5-36.2z" },
  { id: "shrimp", label: "Shrimp", range: "≤ $1,000", color: "#fa8e42", w: 512, h: 512, path: "M64 32C28.7 32 0 60.7 0 96s28.7 64 64 64l1 0c3.7 88.9 77 160 167 160l56 0 0-192-24 0L88.8 128 64 128c-17.7 0-32-14.3-32-32s14.3-32 32-32l400 0c8.8 0 16-7.2 16-16s-7.2-16-16-16L64 32zM224 456c0 13.3 10.7 24 24 24l72 0 0-72.2-64.1-22.4c-12.5-4.4-26.2 2.2-30.6 14.7s2.2 26.2 14.7 30.6l4.5 1.6C233 433.9 224 443.9 224 456zm128 23.3c36.4-3.3 69.5-17.6 96.1-39.6l-86.5-34.6c-3 1.8-6.2 3.2-9.6 4.3l0 69.9zM472.6 415c24.6-30.3 39.4-68.9 39.4-111c0-12.3-1.3-24.3-3.7-35.9L382.8 355.1c.8 3.4 1.2 7 1.2 10.6c0 4.6-.7 9-1.9 13.1L472.6 415zM336 128l-16 0 0 192 18.3 0c9.9 0 19.1 3.2 26.6 8.5l133.5-92.4C471.8 172.6 409.1 128 336 128zM168 192a24 24 0 1 1 48 0 24 24 0 1 1 -48 0z" },
  { id: "fish", label: "Fish", range: "≤ $3,000", color: "#8183f4", w: 576, h: 512, path: "M275.2 38.4c-10.6-8-25-8.5-36.3-1.5S222 57.3 224.6 70.3l9.7 48.6c-19.4 9-36.9 19.9-52.4 31.5c-15.3 11.5-29 23.9-40.7 36.3L48.1 132.4c-12.5-7.3-28.4-5.3-38.6 4.9S-3 163.3 4.2 175.9L50 256 4.2 336.1c-7.2 12.6-5 28.4 5.3 38.6s26.1 12.2 38.6 4.9l93.1-54.3c11.8 12.3 25.4 24.8 40.7 36.3c15.5 11.6 33 22.5 52.4 31.5l-9.7 48.6c-2.6 13 3.1 26.3 14.3 33.3s25.6 6.5 36.3-1.5l77.6-58.2c54.9-4 101.5-27 137.2-53.8c39.2-29.4 67.2-64.7 81.6-89.5c5.8-9.9 5.8-22.2 0-32.1c-14.4-24.8-42.5-60.1-81.6-89.5c-35.8-26.8-82.3-49.8-137.2-53.8L275.2 38.4zM384 256a32 32 0 1 1 64 0 32 32 0 1 1 -64 0z" },
  { id: "dolphin", label: "Dolphin", range: "≤ $10,000", color: "#818ea1", w: 512, h: 512, path: "M477.3 24.9c3.5-5.3 3.6-12.2 .1-17.6S467.7-.8 461.4 .2c-16.7 2.8-43.1 8.6-68.8 17C378 22 362.5 28 349 35.3C306.5 12.8 258 0 206.5 0L176 0C96.5 0 32 64.5 32 144c0 18.6 3.5 36.4 10 52.7L20.5 209.6C7.8 217.2 0 231 0 245.8C0 269.1 18.9 288 42.2 288L176 288l16 0 11.2 0 92 61.3c4.9 3.3 11.2 3.6 16.4 .8s8.5-8.2 8.5-14.1l0-48 6.6 0c31.7 0 57.4 25.7 57.4 57.4c0 30.6-24 55.8-54.5 57.3l-53.4 2.7c-20.2-33-56.3-53.4-95.4-53.4l-4.7 0c-5.5 0-10.7 2.9-13.6 7.6s-3.2 10.6-.7 15.6L190.1 432l-28.4 56.8c-2.5 5-2.2 10.8 .7 15.6s8.1 7.6 13.6 7.6l4.7 0c35.9 0 69.2-17.2 90.1-45.4l68 3.8c94.1 5.2 173.3-70 173.3-164.3c0-80.8-31.4-154.5-82.7-209.3l48-72zM176 120a24 24 0 1 1 0 48 24 24 0 1 1 0-48z" },
  { id: "whale", label: "Whale", range: "> $10,000", color: "#35c4dc", w: 640, h: 512, path: "M175.8 13.4c-1-5.9-5.2-10.8-10.9-12.6s-12-.3-16.2 3.9L108 45.4C89.7 63.7 81.4 89.6 85.6 115.1l7.9 47.4L43.6 212.4C15.7 240.3 0 278.2 0 317.6C0 407.3 72.7 480 162.4 480L544 480c53 0 96-43 96-96l0-111.9C640 192.5 575.5 128 495.9 128c-82.5 0-162.4 29.5-225 83.2L156.4 309.4c-8 6.8-18.1 10.6-28.6 10.6l-1.1 0c-18.3 0-34.5-11.7-40.3-29c-4-12-2.4-25.2 4.3-35.9l37.6-60.1 44.7 7.5c25.5 4.2 51.5-4.1 69.7-22.3l40.7-40.7c4.2-4.2 5.8-10.5 3.9-16.2s-6.7-9.9-12.6-10.9L189.9 98.1 175.8 13.4zM400 280a24 24 0 1 1 0 48 24 24 0 1 1 0-48z" },
];

function buyerAnimal(usd) {
  const value = Number(usd);
  if (!Number.isFinite(value) || value <= 1) return BUYER_ANIMALS[0];
  if (value <= 1000) return BUYER_ANIMALS[1];
  if (value <= 3000) return BUYER_ANIMALS[2];
  if (value <= 10000) return BUYER_ANIMALS[3];
  return BUYER_ANIMALS[4];
}

function animalMark(animal, height) {
  const width = height * (animal.w / animal.h);
  return `<svg viewBox="0 0 ${animal.w} ${animal.h}" width="${width.toFixed(1)}" height="${height}" aria-hidden="true"><path fill="currentColor" d="${animal.path}"/></svg>`;
}

function chartTipHtml(row) {
  const animal = buyerAnimal(row.amountUsd);
  const type = row.type === "sell" ? "Sell" : "Buy";
  const tx = String(row.tx || "");
  return `<div class="chart-tip-title" style="color:${animal.color}">${animalMark(animal, 16)}<span>${esc(animal.label)}</span><span class="pill ${row.type === "buy" ? "live" : "rugged"}">${type}</span></div>
    <dl>
      <dt>No</dt><dd>${esc(row.no)}</dd>
      <dt>Time</dt><dd>${esc(formatExact(row.time))}</dd>
      <dt>M. Cap</dt><dd>${esc(row.mcap == null ? "—" : exactUsd(row.mcap))}</dd>
      <dt>Amount</dt><dd>${esc(row.amountWei ? `${formatEth(row.amountWei)} ETH` : "—")}</dd>
      <dt>Count</dt><dd>${esc(row.count == null ? "—" : row.count)}</dd>
      <dt>Maker</dt><dd class="addr">${esc(row.maker || "—")}</dd>
      <dt>Tx</dt><dd class="addr">${tx ? `<a href="https://etherscan.io/tx/${esc(tx)}" target="_blank" rel="noreferrer">${esc(shortHash(tx))}</a>` : "—"}</dd>
    </dl>`;
}

function shortHash(value) {
  const text = String(value || "");
  if (text.length <= 18) return text;
  return `${text.slice(0, 10)}…${text.slice(-8)}`;
}

let chartTipTimer = 0;

function chartTipEl() {
  let tip = document.getElementById("chart-tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "chart-tip";
    tip.className = "chart-tip";
    tip.hidden = true;
    document.body.appendChild(tip);
  }
  return tip;
}

function hideChartTip() {
  clearTimeout(chartTipTimer);
  const tip = document.getElementById("chart-tip");
  if (tip) tip.hidden = true;
}

function hideChartTipSoon() {
  clearTimeout(chartTipTimer);
  chartTipTimer = setTimeout(() => {
    const tip = document.getElementById("chart-tip");
    if (tip && !tip.matches(":hover")) tip.hidden = true;
  }, 280);
}

function showChartTip(html, anchor) {
  clearTimeout(chartTipTimer);
  const tip = chartTipEl();
  tip.innerHTML = html;
  tip.hidden = false;
  const box = anchor.getBoundingClientRect();
  const tipBox = tip.getBoundingClientRect();
  const gap = 14;
  let left = box.right + gap;
  if (left + tipBox.width > window.innerWidth - 10) left = box.left - tipBox.width - gap;
  if (left < 10) left = 10;
  const above = box.top - gap - tipBox.height;
  const beside = box.top + box.height / 2 - tipBox.height / 2;
  let top = beside;
  if (beside < 10 || beside + tipBox.height > window.innerHeight - 16) top = above >= 10 ? above : Math.max(10, window.innerHeight - tipBox.height - 10);
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

const CHART = { width: 1000, height: 520, pad: { l: 78, r: 46, t: 16, b: 46 } };

function chartAxis() {
  return state.chartAxis === "amount" ? "amount" : "mcap";
}

function chartPad() {
  return chartAxis() === "amount" ? { l: 96, r: 46, t: 16, b: 46 } : CHART.pad;
}

function chartYValue(row) {
  if (chartAxis() === "amount") {
    const wei = rowAmountWei(row);
    if (wei <= 0n) return 0;
    return Number(wei) / 1e18;
  }
  return Number(row.mcap) > 0 ? Number(row.mcap) : 0;
}

function chartPlotted(rows) {
  const plotted = [];
  rows.forEach((row, index) => {
    const y = chartYValue(row);
    if (!row.time || !(y > 0)) return;
    plotted.push({ row, index, y });
  });
  return plotted;
}

function chartExtent(rows, candles = []) {
  const times = [];
  const caps = [];
  for (const item of chartPlotted(rows)) {
    times.push(item.row.time);
    caps.push(item.y);
  }
  if (chartAxis() !== "amount") {
    for (const candle of candles) {
      const time = Number(candle.time);
      const mcap = Number(candle.mcap);
      if (time > 0 && mcap > 0) {
        times.push(time);
        caps.push(mcap);
        if (Number(candle.high) > 0) caps.push(Number(candle.high));
        if (Number(candle.low) > 0) caps.push(Number(candle.low));
      }
    }
  }
  if (!times.length) return null;
  let minT = Math.min(...times);
  let maxT = Math.max(...times);
  let minY = Math.min(...caps);
  let maxY = Math.max(...caps);
  if (minT === maxT) {
    minT -= 60;
    maxT += 60;
  }
  const ySpan = maxY - minY || maxY || 1;
  minY = Math.max(0, minY - ySpan * 0.12);
  maxY += ySpan * 0.12;
  return { minT, maxT, minY, maxY };
}

function chartView(view, extent) {
  if (!view) return extent;
  return {
    minT: Math.min(Math.max(view.minT, extent.minT), extent.maxT),
    maxT: Math.max(Math.min(view.maxT, extent.maxT), extent.minT),
    minY: Math.min(Math.max(view.minY, extent.minY), extent.maxY),
    maxY: Math.max(Math.min(view.maxY, extent.maxY), extent.minY),
  };
}

function clampSpan(min, max, anchor, factor, fullMin, fullMax, minSpan) {
  const full = Math.max(fullMax - fullMin, 0);
  const current = Math.max(max - min, 0);
  let span = current * factor;
  const floor = Math.min(full || span, Math.max(minSpan, 0));
  if (full) span = Math.min(Math.max(span, floor), full);
  const weight = current ? (anchor - min) / current : 0.5;
  let lo = anchor - weight * span;
  let hi = lo + span;
  if (lo < fullMin) {
    hi += fullMin - lo;
    lo = fullMin;
  }
  if (hi > fullMax) {
    lo -= hi - fullMax;
    hi = fullMax;
  }
  lo = Math.max(fullMin, lo);
  hi = Math.min(fullMax, hi);
  if (!(hi > lo)) return [fullMin, fullMax];
  return [lo, hi];
}

function shiftSpan(min, max, delta, fullMin, fullMax) {
  const span = max - min;
  let lo = min + delta;
  let hi = max + delta;
  if (lo < fullMin) {
    lo = fullMin;
    hi = fullMin + span;
  }
  if (hi > fullMax) {
    hi = fullMax;
    lo = fullMax - span;
  }
  lo = Math.max(fullMin, lo);
  hi = Math.min(fullMax, hi);
  if (!(hi > lo)) return [fullMin, fullMax];
  return [lo, hi];
}

function sameRange(view, extent) {
  const spanT = extent.maxT - extent.minT || 1;
  const spanY = extent.maxY - extent.minY || 1;
  return Math.abs(view.minT - extent.minT) < spanT * 0.004
    && Math.abs(view.maxT - extent.maxT) < spanT * 0.004
    && Math.abs(view.minY - extent.minY) < spanY * 0.004
    && Math.abs(view.maxY - extent.maxY) < spanY * 0.004;
}

function svgPoint(event, svg) {
  const rect = svg.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * CHART.width,
    y: ((event.clientY - rect.top) / rect.height) * CHART.height,
  };
}

function wheelPixels(event) {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 480 : 1;
  let delta = Number(event.deltaY) * unit;
  if (!delta && event.wheelDeltaY) delta = -Number(event.wheelDeltaY);
  else if (!delta && event.wheelDelta) delta = -Number(event.wheelDelta);
  if (Math.abs(Number(event.deltaX)) > Math.abs(Number(event.deltaY))) delta = Number(event.deltaX) * unit;
  return Number.isFinite(delta) ? delta : 0;
}

function chartYLabel(value, span) {
  if (chartAxis() === "amount") {
    const digits = span < 0.05 ? 4 : span < 1 ? 3 : span < 20 ? 2 : 1;
    return `${Number(value).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 })}`;
  }
  return chartUsd(value, span);
}

function chartUsd(value, span) {
  if (span >= 1000) return formatUsd(value);
  const digits = span < 20 ? 2 : span < 200 ? 1 : 0;
  return `$${Number(value).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits })}`;
}

function chartTimeLabel(unix, span) {
  const full = formatExact(unix);
  if (span <= 6 * 3600) return full.slice(5, 19);
  return full.slice(5, 16);
}

function tokenChartPaths(candles, xOf, yOf) {
  const points = (candles || []).filter((candle) => Number(candle.time) > 0 && Number(candle.mcap) > 0);
  if (points.length < 2) return "";
  const line = points
    .map((point, index) => `${index ? "L" : "M"}${xOf(point.time).toFixed(2)},${yOf(point.mcap).toFixed(2)}`)
    .join("");
  const upper = points
    .map((point, index) => `${index ? "L" : "M"}${xOf(point.time).toFixed(2)},${yOf(Number(point.high) > 0 ? point.high : point.mcap).toFixed(2)}`)
    .join("");
  const lower = [...points]
    .reverse()
    .map((point) => `L${xOf(point.time).toFixed(2)},${yOf(Number(point.low) > 0 ? point.low : point.mcap).toFixed(2)}`)
    .join("");
  return `<path d="${upper}${lower}Z" class="chart-area"/><path d="${line}" class="chart-line"/>`;
}

function buyerChartSvg(rows, view, candles = []) {
  const width = CHART.width;
  const height = CHART.height;
  const pad = chartPad();
  const amount = chartAxis() === "amount";
  const plotted = chartPlotted(rows);
  const extent = chartExtent(rows, candles);
  if (!extent) {
    const why = amount ? "No matching trade has a time and an ETH amount yet." : "No matching trade has a time and a market cap yet.";
    return `<p class="muted buyers-note">${why}</p>`;
  }
  const domain = chartView(view, extent);
  let { minT, maxT, minY, maxY } = domain;
  if (!(maxT > minT)) {
    minT = extent.minT;
    maxT = extent.maxT;
  }
  if (!(maxY > minY)) {
    minY = extent.minY;
    maxY = extent.maxY;
  }
  const xOf = (time) => pad.l + ((time - minT) / (maxT - minT)) * (width - pad.l - pad.r);
  const yOf = (value) => pad.t + (1 - (value - minY) / (maxY - minY)) * (height - pad.t - pad.b);
  const yTicks = [0, 1, 2, 3, 4].map((step) => minY + ((maxY - minY) * step) / 4);
  const xTicks = [0, 1, 2, 3].map((step) => minT + ((maxT - minT) * step) / 3);
  const ySpan = maxY - minY;
  const tSpan = maxT - minT;
  const grid = yTicks
    .map((tick) => {
      const y = yOf(tick);
      return `<line x1="${pad.l}" y1="${y}" x2="${width - pad.r}" y2="${y}" class="chart-grid"/><text x="${pad.l - 8}" y="${y + 4}" text-anchor="end" class="chart-label">${esc(chartYLabel(tick, ySpan))}</text>`;
    })
    .join("");
  const xLabels = xTicks
    .map((tick, index) => {
      const anchor = index === 0 ? "start" : index === xTicks.length - 1 ? "end" : "middle";
      const x = index === 0 ? pad.l : index === xTicks.length - 1 ? width - pad.r : xOf(tick);
      return `<text x="${x}" y="${height - 16}" text-anchor="${anchor}" class="chart-label">${esc(chartTimeLabel(tick, tSpan))}</text>`;
    })
    .join("");
  const symbols = BUYER_ANIMALS.map((animal) => `<symbol id="buyer-${animal.id}" viewBox="0 0 ${animal.w} ${animal.h}"><path fill="currentColor" d="${animal.path}"/></symbol>`).join("");
  const rank = { flea: 0, shrimp: 1, fish: 2, dolphin: 3, whale: 4 };
  const marks = plotted
    .map((item) => ({ ...item, animal: buyerAnimal(item.row.amountUsd) }))
    .sort((a, b) => rank[a.animal.id] - rank[b.animal.id])
    .map((item) => {
      const animal = item.animal;
      const heightPx = 22;
      const widthPx = heightPx * (animal.w / animal.h);
      const cx = xOf(item.row.time);
      const cy = yOf(item.y);
      const side = item.row.type === "sell" ? "sell" : "buy";
      return `<g class="chart-point" data-index="${item.index}">
        <circle class="chart-ring ${side}" cx="${cx}" cy="${cy}" r="16.5"/>
        <use href="#buyer-${animal.id}" x="${cx - widthPx / 2}" y="${cy - heightPx / 2}" width="${widthPx}" height="${heightPx}" style="color:${animal.color};pointer-events:none"/>
      </g>`;
    })
    .join("");
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const axisName = amount ? "Amount (ETH)" : "M. Cap";
  const line = amount ? "" : tokenChartPaths(candles, xOf, yOf);
  return `<svg class="buyer-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Real buyer trades by time and ${amount ? "amount" : "market cap"}">
    <defs>${symbols}<clipPath id="chart-plot"><rect x="${pad.l}" y="${pad.t}" width="${plotW}" height="${plotH}"/></clipPath></defs>
    <rect class="chart-zoom-y" x="0" y="0" width="${pad.l - 8}" height="${height}"/>
    <rect class="chart-zoom-x" x="${pad.l - 8}" y="0" width="${width - pad.l + 8}" height="${height}"/>
    ${grid}
    ${xLabels}
    <text x="${(pad.l + width - pad.r) / 2}" y="${height - 2}" text-anchor="middle" class="chart-axis">Time (${esc(zoneLabel())})</text>
    <text x="16" y="${(pad.t + height - pad.b) / 2}" text-anchor="middle" class="chart-axis" transform="rotate(-90 16 ${(pad.t + height - pad.b) / 2})">${esc(axisName)}</text>
    <line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${height - pad.b}" class="chart-axis-line"/>
    <line x1="${pad.l}" y1="${height - pad.b}" x2="${width - pad.r}" y2="${height - pad.b}" class="chart-axis-line"/>
    <g clip-path="url(#chart-plot)">${line}${marks}</g>
  </svg>`;
}

let chartPaintFrame = 0;
let chartDrag = null;

function scheduleChartPaint() {
  if (chartPaintFrame) return;
  chartPaintFrame = requestAnimationFrame(() => {
    chartPaintFrame = 0;
    hideChartTip();
    const root = document.getElementById("buyer-chart");
    if (root) root.dataset.sig = "";
    paintBuyerChart();
    if (chartDrag?.moved) document.querySelector("#buyer-chart .buyer-chart")?.classList.add("is-panning");
  });
}

function onChartWheel(event) {
  if (event.target.closest?.("#wallet-chart")) return onWalletWheel(event);
  const chartRoot = event.target.closest?.("#buyer-chart");
  const svg = chartRoot?.querySelector(".buyer-chart");
  const overPlot = event.target.closest?.(".chart-stage, .buyer-chart");
  if (!svg || !overPlot || !state.buyerChart?.rows?.length) return;
  const rows = filteredTrades(state.buyerChart.rows);
  const extent = chartExtent(rows, state.buyerChart.candles || []);
  if (!extent) return;
  const pixels = wheelPixels(event);
  if (!pixels) return;
  event.preventDefault();
  event.stopPropagation();
  const factor = Math.exp(Math.max(-1600, Math.min(1600, pixels)) * 0.0048);
  const current = chartView(state.buyerChart.view, extent);
  const point = svgPoint(event, svg);
  const next = { ...current };
  const pad = chartPad();
  const onPrice = point.x < pad.l - 8;
  const onTime = !onPrice && point.y > CHART.height - pad.b;
  if (!onTime) {
    const span = current.maxY - current.minY || 1;
    const ratio = Math.min(1, Math.max(0, (point.y - pad.t) / (CHART.height - pad.t - pad.b)));
    const anchor = current.maxY - ratio * span;
    const floor = chartAxis() === "amount" ? 0.0001 : 1;
    const minSpan = Math.min(extent.maxY - extent.minY, Math.max((extent.maxY - extent.minY) * 0.02, floor));
    [next.minY, next.maxY] = clampSpan(current.minY, current.maxY, anchor, factor, extent.minY, extent.maxY, minSpan);
  }
  if (!onPrice) {
    const span = current.maxT - current.minT || 1;
    const ratio = Math.min(1, Math.max(0, (point.x - pad.l) / (CHART.width - pad.l - pad.r)));
    const anchor = current.minT + ratio * span;
    const minSpan = Math.min(extent.maxT - extent.minT, 45);
    [next.minT, next.maxT] = clampSpan(current.minT, current.maxT, anchor, factor, extent.minT, extent.maxT, minSpan);
  }
  state.buyerChart.view = sameRange(next, extent) ? null : next;
  scheduleChartPaint();
}

function onChartPointerDown(event) {
  if (event.target.closest?.("#wallet-chart")) return onWalletPointerDown(event);
  if (event.button !== 0 || chartDrag) return;
  if (event.target.closest?.("input, textarea, select, button, a, .trade-filters, .chart-legend, .buyers-head")) return;
  const chartRoot = event.target.closest?.("#buyer-chart");
  const svg = chartRoot?.querySelector(".buyer-chart");
  if (!svg || !event.target.closest?.(".chart-stage, .buyer-chart") || !state.buyerChart?.rows?.length) return;
  const extent = chartExtent(filteredTrades(state.buyerChart.rows), state.buyerChart.candles || []);
  if (!extent) return;
  const point = svgPoint(event, svg);
  const pad = chartPad();
  const onPrice = point.x < pad.l - 8;
  const onTime = point.y > CHART.height - pad.b && !onPrice;
  chartDrag = {
    pointerId: event.pointerId,
    x: point.x,
    y: point.y,
    view: { ...chartView(state.buyerChart.view, extent) },
    axis: onPrice ? "y" : onTime ? "x" : "both",
    moved: false,
  };
  event.preventDefault();
}

function onChartPointerMove(event) {
  if (walletDrag) return onWalletPointerMove(event);
  if (!chartDrag || event.pointerId !== chartDrag.pointerId || !state.buyerChart) return;
  const svg = document.querySelector("#buyer-chart .buyer-chart");
  if (!svg) return;
  const extent = chartExtent(filteredTrades(state.buyerChart.rows), state.buyerChart.candles || []);
  if (!extent) return;
  const point = svgPoint(event, svg);
  const dx = point.x - chartDrag.x;
  const dy = point.y - chartDrag.y;
  if (!chartDrag.moved && Math.hypot(dx, dy) < 3) return;
  chartDrag.moved = true;
  event.preventDefault();
  const base = chartDrag.view;
  const next = { ...base };
  const pad = chartPad();
  const plotW = CHART.width - pad.l - pad.r;
  const plotH = CHART.height - pad.t - pad.b;
  if (chartDrag.axis !== "y") {
    const timePerPx = (base.maxT - base.minT) / plotW;
    [next.minT, next.maxT] = shiftSpan(base.minT, base.maxT, -dx * timePerPx, extent.minT, extent.maxT);
  }
  if (chartDrag.axis !== "x") {
    const capPerPx = (base.maxY - base.minY) / plotH;
    [next.minY, next.maxY] = shiftSpan(base.minY, base.maxY, dy * capPerPx, extent.minY, extent.maxY);
  }
  state.buyerChart.view = sameRange(next, extent) ? null : next;
  document.body.classList.add("chart-panning");
  scheduleChartPaint();
}

function onChartPointerUp(event) {
  if (walletDrag) return onWalletPointerUp(event);
  if (!chartDrag || event.pointerId !== chartDrag.pointerId) return;
  chartDrag = null;
  document.body.classList.remove("chart-panning");
  document.querySelector("#buyer-chart .buyer-chart")?.classList.remove("is-panning");
}

const WALLET_PAD = { l: 88, r: 36, t: 18, b: 46 };
let walletDrag = null;
let walletPaintFrame = 0;

function emptyWalletFilter() {
  return { side: "all", minEth: "", maxEth: "", start: "", end: "", query: "" };
}

function unixParts(unix) {
  if (!unix) return null;
  const date = new Date((Number(unix) + zoneOffset() * 3600) * 1000);
  return {
    date: `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`,
    h: date.getUTCHours(),
    m: date.getUTCMinutes(),
    s: date.getUTCSeconds(),
  };
}

function partsToUnix(date, hour, minute, second) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
  if (!match) return "";
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(hour) || 0, Number(minute) || 0, Number(second) || 0);
  return Math.floor(utc / 1000) - zoneOffset() * 3600;
}

function walletEth(trade) {
  const amount = Number(trade.amount);
  if (Number.isFinite(amount) && amount > 0) return amount;
  if (trade.amount_wei) {
    const value = Number(trade.amount_wei) / 1e18;
    return Number.isFinite(value) && value > 0 ? value : 0;
  }
  return 0;
}

function walletY(trade) {
  if (state.walletAxis === "mcap") return Number(trade.market_cap) > 0 ? Number(trade.market_cap) : 0;
  return walletEth(trade);
}

function walletRangeError() {
  const filter = state.walletFilter;
  const min = filter.minEth.trim();
  const max = filter.maxEth.trim();
  if (min !== "" && max !== "" && Number(min) > Number(max)) return "Min amount is above max amount.";
  if (filter.start && filter.end && Number(filter.end) < Number(filter.start)) return "End time is before the start time.";
  return "";
}

function walletMatches(trade) {
  const filter = state.walletFilter;
  if ((filter.side === "buy" || filter.side === "sell") && trade.side !== filter.side) return false;
  const eth = walletEth(trade);
  if (filter.minEth.trim() !== "" && !(eth >= Number(filter.minEth))) return false;
  if (filter.maxEth.trim() !== "" && !(eth <= Number(filter.maxEth))) return false;
  const time = Number(trade.timestamp) || 0;
  if (filter.start && time < Number(filter.start)) return false;
  if (filter.end && time > Number(filter.end)) return false;
  const query = filter.query.trim().toLowerCase();
  if (!query) return true;
  const blob = `${trade.token_symbol || ""} ${trade.token_name || ""} ${trade.token_address || ""}`.toLowerCase();
  return blob.includes(query);
}

function walletRows() {
  return walletRangeError() ? [] : (state.walletChart?.trades || []).filter(walletMatches);
}

function walletPlotted(rows) {
  const plotted = [];
  rows.forEach((trade) => {
    const y = walletY(trade);
    if (Number(trade.timestamp) > 0 && y > 0) plotted.push({ trade, y });
  });
  return plotted;
}

function walletExtent(rows) {
  const plotted = walletPlotted(rows);
  if (!plotted.length) return null;
  let minT = Math.min(...plotted.map((item) => Number(item.trade.timestamp)));
  let maxT = Math.max(...plotted.map((item) => Number(item.trade.timestamp)));
  let minY = Math.min(...plotted.map((item) => item.y));
  let maxY = Math.max(...plotted.map((item) => item.y));
  if (minT === maxT) {
    minT -= 1800;
    maxT += 1800;
  }
  const ySpan = maxY - minY || maxY || 1;
  minY = Math.max(0, minY - ySpan * 0.14);
  maxY += ySpan * 0.16;
  return { minT, maxT, minY, maxY };
}

function walletYLabel(value, span) {
  if (state.walletAxis === "mcap") return chartUsd(value, span);
  const digits = span < 0.05 ? 4 : span < 1 ? 3 : span < 20 ? 2 : 1;
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: digits });
}

function walletTimeLabel(unix, span) {
  const date = new Date((Number(unix) + zoneOffset() * 3600) * 1000);
  if (span >= 86400 * 2) return `${MONTHS_SHORT[date.getUTCMonth()]} ${date.getUTCDate()}`;
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function formatEthNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  const abs = Math.abs(number);
  const digits = abs >= 100 ? 2 : abs >= 1 ? 3 : abs >= 0.01 ? 4 : abs >= 0.0001 ? 6 : 8;
  return number.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function walletChartSvg(rows, view) {
  const width = CHART.width;
  const height = CHART.height;
  const pad = WALLET_PAD;
  const extent = walletExtent(rows);
  const frame = extent ? chartView(view, extent) : null;
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const xOf = (time) => pad.l + ((time - frame.minT) / (frame.maxT - frame.minT || 1)) * plotW;
  const yOf = (value) => pad.t + (1 - (value - frame.minY) / (frame.maxY - frame.minY || 1)) * plotH;
  const axisName = state.walletAxis === "mcap" ? "M. Cap" : "Amount (ETH)";
  if (!frame) {
    return `<svg class="buyer-chart wallet-plot" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">
      <text x="${width / 2}" y="${height / 2}" text-anchor="middle" class="chart-label">${esc(walletRangeError() || "No trades in this view")}</text>
    </svg>`;
  }
  const grid = [];
  const yLabels = [];
  for (let step = 0; step <= 4; step += 1) {
    const value = frame.minY + ((frame.maxY - frame.minY) * step) / 4;
    const y = yOf(value);
    grid.push(`<line x1="${pad.l}" y1="${y}" x2="${width - pad.r}" y2="${y}" class="chart-grid"/>`);
    yLabels.push(`<text x="${pad.l - 10}" y="${y + 4}" text-anchor="end" class="chart-label">${esc(walletYLabel(value, frame.maxY - frame.minY))}</text>`);
  }
  const xLabels = [];
  const span = frame.maxT - frame.minT;
  for (let step = 0; step <= 4; step += 1) {
    const time = frame.minT + (span * step) / 4;
    const x = xOf(time);
    grid.push(`<line x1="${x}" y1="${pad.t}" x2="${x}" y2="${height - pad.b}" class="chart-grid"/>`);
    xLabels.push(`<text x="${x}" y="${height - pad.b + 20}" text-anchor="middle" class="chart-label">${esc(walletTimeLabel(time, span))}</text>`);
  }
  const marks = walletPlotted(rows)
    .filter((item) => {
      const time = Number(item.trade.timestamp);
      return time >= frame.minT && time <= frame.maxT && item.y >= frame.minY && item.y <= frame.maxY;
    })
    .map((item) => {
      const buy = item.trade.side !== "sell";
      const color = buy ? "#3dd68c" : "#ff5d73";
      const cx = xOf(Number(item.trade.timestamp));
      const cy = yOf(item.y);
      return `<g class="chart-point wallet-point" data-id="${esc(item.trade.id)}">
        <circle cx="${cx}" cy="${cy}" r="16" fill="transparent"/>
        <circle cx="${cx}" cy="${cy}" r="8" fill="${color}" opacity="0.18" pointer-events="none"/>
        <circle cx="${cx}" cy="${cy}" r="4.5" fill="${color}" stroke="#0c1016" stroke-width="1.4" pointer-events="none"/>
      </g>`;
    })
    .join("");
  return `<svg class="buyer-chart wallet-plot" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(axisName)} over time">
    <rect class="chart-zoom-x" x="${pad.l}" y="${pad.t}" width="${plotW}" height="${plotH}"/>
    ${grid.join("")}
    ${yLabels.join("")}
    ${xLabels.join("")}
    <text x="${(pad.l + width - pad.r) / 2}" y="${height - 4}" text-anchor="middle" class="chart-axis">Time (${esc(zoneLabel())})</text>
    <text x="16" y="${(pad.t + height - pad.b) / 2}" text-anchor="middle" class="chart-axis" transform="rotate(-90 16 ${(pad.t + height - pad.b) / 2})">${esc(axisName)}</text>
    <line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${height - pad.b}" class="chart-axis-line"/>
    <line x1="${pad.l}" y1="${height - pad.b}" x2="${width - pad.r}" y2="${height - pad.b}" class="chart-axis-line"/>
    ${marks}
  </svg>`;
}

function walletTipHtml(trade) {
  const side = trade.side === "sell" ? "Sell" : "Buy";
  const token = trade.token_symbol || shortAddr(trade.token_address);
  const name = trade.token_name && trade.token_name !== token ? trade.token_name : "";
  const usd = Number(trade.amount_usd);
  const amount = `${formatEthNumber(walletEth(trade))} ETH${Number.isFinite(usd) && usd > 0 ? ` · ${exactUsd(usd)}` : ""}`;
  const tx = String(trade.tx_hash || "");
  return `<div class="chart-tip-kicker">Tx info</div>
    <div class="chart-tip-title"><span class="pill ${trade.side === "buy" ? "live" : "rugged"}">${side}</span><b>${esc(token)}</b></div>
    ${name ? `<p class="chart-tip-name">${esc(name)}</p>` : ""}
    <dl>
      <dt>Time</dt><dd>${esc(formatExact(trade.timestamp))}</dd>
      <dt>Amount</dt><dd>${esc(amount)}</dd>
      <dt>M. Cap</dt><dd>${esc(trade.market_cap ? exactUsd(trade.market_cap) : "—")}</dd>
      <dt>Contract</dt><dd class="addr">${esc(trade.token_address || "—")}</dd>
      <dt>Tx</dt><dd class="addr">${tx ? `<a href="https://etherscan.io/tx/${esc(tx)}" target="_blank" rel="noreferrer">${esc(shortHash(tx))}</a>` : "—"}</dd>
    </dl>`;
}

function walletStatsHtml(rows) {
  const buys = rows.filter((trade) => trade.side !== "sell");
  const sells = rows.filter((trade) => trade.side === "sell");
  const buyEth = buys.reduce((sum, trade) => sum + walletEth(trade), 0);
  const sellEth = sells.reduce((sum, trade) => sum + walletEth(trade), 0);
  const card = (label, count, eth, tone) => `<div class="wallet-stat"><span>${label}</span><b class="${tone}">${count.toLocaleString()}</b><em>${esc(formatEthNumber(eth))} ETH</em></div>`;
  return `${card("Buys", buys.length, buyEth, "up")}${card("Sells", sells.length, sellEth, "down")}<div class="wallet-stat"><span>Net</span><b class="${buyEth - sellEth >= 0 ? "up" : "down"}">${esc(formatEthNumber(buyEth - sellEth))}</b><em>ETH</em></div>`;
}

function walletWhen(key, label) {
  const unix = state.walletFilter[key];
  const parts = unixParts(unix);
  const open = state.walletPicker?.key === key;
  const month = open ? state.walletPicker.month : String(parts?.date || zonedToday()).slice(0, 7);
  const [year, part] = month.split("-").map(Number);
  const today = zonedToday();
  const cells = calendarCells(month, parts?.date || "");
  const days = cells
    .map((cell) => {
      const classes = ["cal-day", cell.outside ? "out" : "", cell.iso === today ? "today" : "", cell.selected ? "on" : ""].filter(Boolean).join(" ");
      return `<button type="button" class="${classes}" data-act="wallet-day" data-key="${key}" data-day="${esc(cell.iso)}">${cell.day}</button>`;
    })
    .join("");
  const clock = parts ? `${pad2(parts.h)}:${pad2(parts.m)}:${pad2(parts.s)}` : "00:00:00";
  const shown = parts ? `${dateText(parts.date)}` : "Any time";
  const clear = `<button type="button" class="btn" data-act="wallet-clear" data-key="${key}">Clear</button>`;
  const now = key === "end" ? `<button type="button" class="btn" data-act="wallet-now">Now</button>` : "";
  return `<div class="trade-field wallet-when"><span>${esc(label)}</span><div class="when"><div class="picker ${open ? "open" : ""}" data-key="${key}">
    <button type="button" class="picker-value" data-act="wallet-open" data-key="${key}">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M3 10h18M8 3v4M16 3v4"/></svg>
      <b>${esc(shown)}</b><span class="picker-clock-label">${esc(parts ? clock : "")}</span>
    </button>
    <div class="picker-pop" role="dialog" aria-label="${esc(label)}"${open ? "" : " hidden"}>
      <div class="picker-head">
        <button type="button" class="icon-btn" data-act="wallet-month" data-key="${key}" data-delta="-1" aria-label="Previous month">‹</button>
        <b>${esc(MONTHS[part - 1] || "")} ${esc(year || "")}</b>
        <button type="button" class="icon-btn" data-act="wallet-month" data-key="${key}" data-delta="1" aria-label="Next month">›</button>
      </div>
      <div class="cal-grid">${["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => `<span class="cal-dow">${day}</span>`).join("")}</div>
      <div class="cal-grid">${days}</div>
      <div class="picker-clock">
        <label>Hour<input data-act="wallet-part" data-key="${key}" data-max="23" inputmode="numeric" maxlength="2" value="${esc(pad2(parts?.h || 0))}" /></label>
        <span>:</span>
        <label>Min<input data-act="wallet-part" data-key="${key}" data-max="59" inputmode="numeric" maxlength="2" value="${esc(pad2(parts?.m || 0))}" /></label>
        <span>:</span>
        <label>Sec<input data-act="wallet-part" data-key="${key}" data-max="59" inputmode="numeric" maxlength="2" value="${esc(pad2(parts?.s || 0))}" /></label>
      </div>
      <div class="picker-foot">${clear}${now}</div>
    </div>
  </div></div></div>`;
}

function walletFilterBar(total) {
  const filter = state.walletFilter;
  const side = (id, label) => `<button type="button" class="chip ${filter.side === id ? "on" : ""}" data-act="wallet-side" data-side="${id}">${label}</button>`;
  const axis = state.walletAxis === "mcap" ? "mcap" : "amount";
  const matched = walletRows().length;
  const note = walletRangeError() || `${matched.toLocaleString()} of ${total.toLocaleString()} trades`;
  return `<div class="trade-filters">
    <div class="trade-field"><span>Side</span><div class="chips">${side("all", "All")}${side("buy", "Only buy")}${side("sell", "Only sell")}</div></div>
    <label class="trade-field"><span>Min amount</span><input data-act="wallet-min" inputmode="decimal" placeholder="ETH" value="${esc(filter.minEth)}" /></label>
    <label class="trade-field"><span>Max amount</span><input data-act="wallet-max" inputmode="decimal" placeholder="ETH" value="${esc(filter.maxEth)}" /></label>
    ${walletWhen("start", "Start")}
    ${walletWhen("end", "End")}
    <label class="trade-field wallet-token"><span>Token</span><input data-act="wallet-query" placeholder="Name, ticker, or CA" spellcheck="false" value="${esc(filter.query)}" /></label>
    <div class="trade-field"><span>Y axis</span><div class="chips">
      <button type="button" class="chip ${axis === "amount" ? "on" : ""}" data-act="wallet-axis" data-axis="amount">Amount</button>
      <button type="button" class="chip ${axis === "mcap" ? "on" : ""}" data-act="wallet-axis" data-axis="mcap">M. Cap</button>
    </div></div>
    <p class="muted trade-note">${esc(note)}</p>
  </div>`;
}

function walletSignature() {
  const chart = state.walletChart;
  const trades = chart?.trades || [];
  const last = trades[trades.length - 1];
  return JSON.stringify({
    id: chart?.buyer?.id || 0,
    loading: Boolean(chart?.loading),
    error: chart?.error || "",
    count: trades.length,
    last: last?.id || 0,
    filter: state.walletFilter,
    axis: state.walletAxis,
    view: chart?.view || null,
    picker: state.walletPicker ? { key: state.walletPicker.key, month: state.walletPicker.month } : null,
  });
}

function syncWalletChart() {
  const root = document.getElementById("wallet-chart");
  const chart = state.walletChart;
  if (!root || !chart || chart.loading || chart.error) return;
  const rows = walletRows();
  const note = root.querySelector(".trade-note");
  if (note) note.textContent = walletRangeError() || `${rows.length.toLocaleString()} of ${(chart.trades || []).length.toLocaleString()} trades`;
  const stats = root.querySelector(".wallet-stats");
  if (stats) stats.innerHTML = walletStatsHtml(rows);
  const stage = root.querySelector(".chart-stage");
  if (stage) {
    const svg = walletChartSvg(rows, chart.view || null);
    const existing = stage.querySelector("svg");
    if (existing) existing.outerHTML = svg;
    else stage.insertAdjacentHTML("afterbegin", svg);
  }
  root.querySelectorAll("[data-act='wallet-side']").forEach((button) => button.classList.toggle("on", button.dataset.side === state.walletFilter.side));
  root.querySelectorAll("[data-act='wallet-axis']").forEach((button) => button.classList.toggle("on", button.dataset.axis === (state.walletAxis === "mcap" ? "mcap" : "amount")));
  const legend = root.querySelector(".chart-legend");
  if (legend) legend.innerHTML = walletLegend();
  root.dataset.sig = walletSignature();
}

function walletLegend() {
  const amount = state.walletAxis !== "mcap";
  return `<span class="chart-key"><i class="wallet-dot buy"></i><b>Buy</b></span><span class="chart-key"><i class="wallet-dot sell"></i><b>Sell</b></span><span class="chart-key"><span>${amount ? "Point height is the ETH amount" : "Point height is the market cap saved with the trade"}</span></span>`;
}

function paintWalletChart() {
  let root = document.getElementById("wallet-chart");
  const chart = state.walletChart;
  if (!chart) {
    root?.remove();
    if (!state.buyerChart) hideChartTip();
    return;
  }
  const signature = walletSignature();
  if (!root) {
    root = document.createElement("div");
    root.id = "wallet-chart";
    document.body.appendChild(root);
  }
  if (root.dataset.sig === signature) return;
  const field = document.activeElement;
  const typing = field && root.contains(field) && field.matches("input");
  const typingAct = typing ? field.dataset.act || "" : "";
  const typingKey = typing ? field.dataset.key || "" : "";
  const caret = typing && typeof field.selectionStart === "number" ? field.selectionStart : null;
  root.dataset.sig = signature;
  const name = chart.buyer?.label || "Buyer";
  const address = chart.buyer?.address || "";
  const rows = chart.trades || [];
  const matched = chart.loading || chart.error ? [] : walletRows();
  const blurb = state.walletAxis === "mcap"
    ? "Each point is one trade. Height is the market cap saved with that trade. Drag the plot to move it. Scroll to zoom."
    : "Each point is one trade. Height is the ETH amount. Drag the plot to move it. Scroll to zoom.";
  const body = chart.loading
    ? `<p class="muted buyers-note">Loading this wallet's trades.</p>`
    : chart.error
      ? `<p class="muted buyers-note">${esc(chart.error)}</p>`
      : `${walletFilterBar(rows.length)}<div class="wallet-stats">${walletStatsHtml(matched)}</div><div class="chart-legend">${walletLegend()}</div><div class="chart-stage">${walletChartSvg(matched, chart.view || null)}</div>`;
  root.innerHTML = `<div class="chart-back wallet-back"><section class="buyers-modal chart-modal wallet-modal" role="dialog" aria-modal="true" aria-label="Buyer chart">
    <div class="buyers-head">
      <div><h3>Buyer chart · ${esc(name)}</h3><p class="muted">${esc(address)} · ${blurb}</p></div>
      <button class="icon-close" data-act="close-wallet" aria-label="Close">×</button>
    </div>
    ${body}
  </section></div>`;
  if (typingAct) {
    const next = [...root.querySelectorAll(`[data-act="${CSS.escape(typingAct)}"]`)].find((node) => !typingKey || node.dataset.key === typingKey);
    if (next) {
      next.focus();
      if (caret != null && next.setSelectionRange) next.setSelectionRange(caret, caret);
    }
  }
  placeOpenPicker();
}

function scheduleWalletPaint() {
  if (walletPaintFrame) return;
  walletPaintFrame = requestAnimationFrame(() => {
    walletPaintFrame = 0;
    hideChartTip();
    syncWalletChart();
    if (walletDrag?.moved) document.querySelector("#wallet-chart .wallet-plot")?.classList.add("is-panning");
  });
}

function onWalletWheel(event) {
  const svg = event.target.closest?.("#wallet-chart")?.querySelector(".wallet-plot");
  if (!svg || !event.target.closest?.(".chart-stage, .wallet-plot") || !state.walletChart?.trades?.length) return;
  const rows = walletRows();
  const extent = walletExtent(rows);
  if (!extent) return;
  const pixels = wheelPixels(event);
  if (!pixels) return;
  event.preventDefault();
  event.stopPropagation();
  const factor = Math.exp(Math.max(-1600, Math.min(1600, pixels)) * 0.0048);
  const current = chartView(state.walletChart.view, extent);
  const point = svgPoint(event, svg);
  const next = { ...current };
  const pad = WALLET_PAD;
  const onPrice = point.x < pad.l - 8;
  const onTime = !onPrice && point.y > CHART.height - pad.b;
  if (!onTime) {
    const span = current.maxY - current.minY || 1;
    const ratio = Math.min(1, Math.max(0, (point.y - pad.t) / (CHART.height - pad.t - pad.b)));
    const anchor = current.maxY - ratio * span;
    const floor = state.walletAxis === "mcap" ? 1 : 0.0001;
    const minSpan = Math.min(extent.maxY - extent.minY, Math.max((extent.maxY - extent.minY) * 0.02, floor));
    [next.minY, next.maxY] = clampSpan(current.minY, current.maxY, anchor, factor, extent.minY, extent.maxY, minSpan);
  }
  if (!onPrice) {
    const span = current.maxT - current.minT || 1;
    const ratio = Math.min(1, Math.max(0, (point.x - pad.l) / (CHART.width - pad.l - pad.r)));
    const anchor = current.minT + ratio * span;
    const minSpan = Math.min(extent.maxT - extent.minT, 45);
    [next.minT, next.maxT] = clampSpan(current.minT, current.maxT, anchor, factor, extent.minT, extent.maxT, minSpan);
  }
  state.walletChart.view = sameRange(next, extent) ? null : next;
  scheduleWalletPaint();
}

function onWalletPointerDown(event) {
  if (event.button !== 0 || walletDrag) return;
  if (event.target.closest?.("input, textarea, select, button, a, .trade-filters, .chart-legend, .buyers-head, .wallet-stats")) return;
  const svg = event.target.closest?.("#wallet-chart")?.querySelector(".wallet-plot");
  if (!svg || !event.target.closest?.(".chart-stage, .wallet-plot") || !state.walletChart?.trades?.length) return;
  const extent = walletExtent(walletRows());
  if (!extent) return;
  const point = svgPoint(event, svg);
  const pad = WALLET_PAD;
  const onPrice = point.x < pad.l - 8;
  const onTime = point.y > CHART.height - pad.b && !onPrice;
  walletDrag = {
    pointerId: event.pointerId,
    x: point.x,
    y: point.y,
    view: { ...chartView(state.walletChart.view, extent) },
    axis: onPrice ? "y" : onTime ? "x" : "both",
    moved: false,
  };
  event.preventDefault();
}

function onWalletPointerMove(event) {
  if (!walletDrag || event.pointerId !== walletDrag.pointerId || !state.walletChart) return;
  const svg = document.querySelector("#wallet-chart .wallet-plot");
  if (!svg) return;
  const extent = walletExtent(walletRows());
  if (!extent) return;
  const point = svgPoint(event, svg);
  const dx = point.x - walletDrag.x;
  const dy = point.y - walletDrag.y;
  if (!walletDrag.moved && Math.hypot(dx, dy) < 3) return;
  walletDrag.moved = true;
  event.preventDefault();
  const base = walletDrag.view;
  const next = { ...base };
  const pad = WALLET_PAD;
  const plotW = CHART.width - pad.l - pad.r;
  const plotH = CHART.height - pad.t - pad.b;
  if (walletDrag.axis !== "y") {
    const timePerPx = (base.maxT - base.minT) / plotW;
    [next.minT, next.maxT] = shiftSpan(base.minT, base.maxT, -dx * timePerPx, extent.minT, extent.maxT);
  }
  if (walletDrag.axis !== "x") {
    const capPerPx = (base.maxY - base.minY) / plotH;
    [next.minY, next.maxY] = shiftSpan(base.minY, base.maxY, dy * capPerPx, extent.minY, extent.maxY);
  }
  state.walletChart.view = sameRange(next, extent) ? null : next;
  document.body.classList.add("chart-panning");
  scheduleWalletPaint();
}

function onWalletPointerUp(event) {
  if (!walletDrag || event.pointerId !== walletDrag.pointerId) return;
  walletDrag = null;
  document.body.classList.remove("chart-panning");
  document.querySelector("#wallet-chart .wallet-plot")?.classList.remove("is-panning");
}

function onWalletHover(event) {
  if (walletDrag?.moved) {
    hideChartTip();
    return;
  }
  const point = event.target.closest?.(".wallet-point");
  if (!point) {
    hideChartTipSoon();
    return;
  }
  const trade = (state.walletChart?.trades || []).find((item) => String(item.id) === String(point.dataset.id));
  if (!trade) return;
  showChartTip(walletTipHtml(trade), point);
}

async function loadWalletChart(id) {
  try {
    const body = await api(`/api/buyers/${id}/trades`);
    if (!state.walletChart || String(state.walletChart.buyer?.id) !== String(id)) return;
    state.walletChart = { buyer: body.buyer, trades: body.trades || [], loading: false, error: "", view: null };
    paintWalletChart();
  } catch (error) {
    if (!state.walletChart || String(state.walletChart.buyer?.id) !== String(id)) return;
    state.walletChart = { buyer: state.walletChart.buyer, trades: [], loading: false, error: error.message, view: null };
    paintWalletChart();
  }
}

function paintBuyerChart() {
  let root = document.getElementById("buyer-chart");
  const chart = state.buyerChart;
  if (!chart) {
    root?.remove();
    if (!state.walletChart) hideChartTip();
    return;
  }
  const signature = buyerChartSignature(chart);
  if (!root) {
    root = document.createElement("div");
    root.id = "buyer-chart";
    document.body.appendChild(root);
  }
  if (root.dataset.sig === signature) return;
  const field = document.activeElement;
  const typing = field && root.contains(field) && field.matches("input");
  const typingAct = typing ? field.dataset.act || "" : "";
  const caret = typing && typeof field.selectionStart === "number" ? field.selectionStart : null;
  const caretEnd = typing && typeof field.selectionEnd === "number" ? field.selectionEnd : null;
  root.dataset.sig = signature;
  const token = (state.data?.tokens || []).find((item) => item.address === chart.address);
  const title = token?.symbol || chart.symbol || "Token";
  const amount = chartAxis() === "amount";
  const legend = `${amount ? "" : `<span class="chart-key chart-token-key"><i></i><b>Token</b><span>M. Cap</span></span>`}${BUYER_ANIMALS.map((animal) => `<span class="chart-key" style="color:${animal.color}">${animalMark(animal, 15)}<b>${esc(animal.label)}</b><span>${esc(animal.range)}</span></span>`).join("")}`;
  const note = chart.error
    ? `<p class="muted buyers-note">${esc(chart.error)}</p>`
    : !chart.ready && !chart.loading
      ? `<p class="muted buyers-note">Some trades are still being counted. The chart shows the ones finished so far.</p>`
      : "";
  const rows = chart.rows || [];
  const matched = filterRangeError() ? [] : filteredTrades(rows);
  const plot = chart.loading || chart.error ? "" : buyerChartSvg(matched, chart.view || null, chart.candles || []);
  const filters = chart.loading || chart.error ? "" : tradeFilterBar(rows, { axis: true });
  const body = chart.loading
    ? fetchProgress(chart.progress, chart.progressLabel)
    : `${note}<div class="chart-stage">${plot}</div>`;
  const blurb = amount
    ? "Each icon sits at that trade's ETH amount. A green circle is a buy and a red circle is a sell. Drag the chart to move it. Scroll up to zoom in and down to zoom out."
    : "The line is the token market cap. Each icon is a real buyer trade: a green circle is a buy and a red circle is a sell. Drag the chart to move it. Scroll up to zoom in and down to zoom out.";
  root.innerHTML = `<div class="chart-back"><section class="buyers-modal chart-modal" role="dialog" aria-modal="true" aria-label="Buyer chart">
    <div class="buyers-head">
      <div><h3>Buyer chart · ${esc(title)}</h3><p class="muted">${blurb}</p></div>
      <button class="icon-close" data-act="close-chart" aria-label="Close">×</button>
    </div>
    ${filters}
    <div class="chart-legend">${legend}</div>
    ${body}
  </section></div>`;
  if (typingAct) {
    const next = root.querySelector(`[data-act="${CSS.escape(typingAct)}"]`);
    if (next) {
      next.focus();
      if (caret != null && next.setSelectionRange) next.setSelectionRange(caret, caretEnd ?? caret);
    }
  }
}

async function loadBuyerChart(address) {
  const stop = watchBuyerProgress(address, (percent, label) => {
    if (!state.buyerChart || state.buyerChart.address !== address || !state.buyerChart.loading) return;
    if (state.buyerChart.progress === percent && state.buyerChart.progressLabel === label) return;
    state.buyerChart.progress = percent;
    state.buyerChart.progressLabel = label;
    paintBuyerChart();
  });
  try {
    const body = await fetchRealBuyerPayload(address);
    if (!state.buyerChart || state.buyerChart.address !== address) return;
    const ordered = [...(body.rows || [])].sort((a, b) => (Number(a.time) || Number(a.block) || 0) - (Number(b.time) || Number(b.block) || 0) || String(a.tx).localeCompare(String(b.tx)));
    state.buyerChart = {
      address,
      loading: false,
      ready: Boolean(body.ready),
      symbol: body.symbol || "",
      error: "",
      rows: ordered.map((row, index) => ({
        no: index + 1,
        time: Number(row.time) || null,
        type: row.type === "sell" ? "sell" : "buy",
        mcap: row.mcap == null ? null : Number(row.mcap),
        amountWei: row.amountWei || "",
        amountUsd: row.amountUsd == null ? null : Number(row.amountUsd),
        count: row.count == null ? null : Number(row.count),
        maker: row.maker || "",
        tx: row.tx || "",
      })),
      candles: (body.chart || [])
        .map((point) => ({
          time: Number(point.time) || 0,
          mcap: Number(point.mcap) || 0,
          high: Number(point.high) || Number(point.mcap) || 0,
          low: Number(point.low) || Number(point.mcap) || 0,
        }))
        .filter((point) => point.time > 0 && point.mcap > 0),
    };
  } catch (error) {
    if (!state.buyerChart || state.buyerChart.address !== address) return;
    state.buyerChart = { address, loading: false, ready: false, error: error.message, rows: [], candles: [] };
  } finally {
    stop();
  }
  const root = document.getElementById("buyer-chart");
  if (root) root.dataset.sig = "";
  paintBuyerChart();
}

function onChartHover(event) {
  if (event.target.closest?.("#chart-tip")) {
    clearTimeout(chartTipTimer);
    return;
  }
  if (event.target.closest?.("#wallet-chart")) return onWalletHover(event);
  if (!state.buyerChart?.rows || chartDrag?.moved || !event.target.closest?.("#buyer-chart")) {
    if (chartDrag?.moved) hideChartTip();
    else if (!event.target.closest?.("#wallet-chart")) hideChartTipSoon();
    return;
  }
  const point = event.target.closest?.(".chart-point");
  if (!point) {
    hideChartTipSoon();
    return;
  }
  const row = filteredTrades(state.buyerChart.rows)[Number(point.dataset.index)];
  if (!row) return;
  showChartTip(chartTipHtml(row), point);
}

function paintDrawer() {
  let root = document.getElementById("drawer-root");
  if (!state.drawer) {
    root?.remove();
    return;
  }
  if (!root) {
    root = document.createElement("div");
    root.id = "drawer-root";
    document.body.appendChild(root);
  }
  const payload = state.drawer.type === "wallet"
    ? state.data.deployers.find((item) => item.address === state.drawer.address)
    : state.data.tokens.find((item) => item.address === state.drawer.address);
  const signature = JSON.stringify(state.drawer) + JSON.stringify(payload || null);
  if (root.dataset.sig === signature) return;
  root.dataset.sig = signature;
  const drawer = state.drawer;
  if (drawer.type === "wallet") {
    const wallet = state.data.deployers.find((item) => item.address === drawer.address);
    if (!wallet) return;
    const funding = wallet.fundings[0];
    root.innerHTML = `<div class="drawer-back"><aside class="drawer">
      <div class="drawer-head"><span class="drawer-kicker">Wallet</span><button class="icon-close" data-act="close-drawer" aria-label="Close">×</button></div>
      <div class="token-title"><div><h3>${esc(shortAddr(wallet.address))}</h3><p>${esc(wallet.note || "Creator wallet")}</p></div><span class="pill ${esc(wallet.status)}">${esc(wallet.status)}</span></div>
      <div class="metrics">
        ${metric("Balance", `${formatEth(wallet.eth_balance_wei)} ETH`)}
        ${metric("Funded", `${formatEth(funding?.value_wei)} ETH`)}
        ${metric("Rival", rivalLabel(wallet.fundings))}
        ${metric("Age", formatAge(wallet.first_funded_at))}
      </div>
      <div class="action-row">
        <a class="action" href="https://etherscan.io/address/${esc(wallet.address)}" target="_blank" rel="noreferrer">Etherscan</a>
        ${funding ? `<a class="action" href="https://etherscan.io/tx/${esc(funding.tx_hash)}" target="_blank" rel="noreferrer">Funding tx</a>` : ""}
        <button class="action" data-act="copy" data-value="${esc(wallet.address)}">Copy address</button>
        <button class="action" data-act="recheck-wallet" data-address="${esc(wallet.address)}">Check again</button>
      </div>
      <div class="kv">
        <span>Funded</span><div>${esc(formatKst(funding?.timestamp))} ${zoneLabel()}</div>
        <span>Source</span><div class="addr">${esc(funding?.funder || "—")}</div>
        <span>Txs seen</span><div>${esc(wallet.tx_count)}</div>
      </div>
      <div class="section-label">Tokens</div>
      ${tokensForDeployer(wallet.address)}
    </aside></div>`;
  } else {
    const token = state.data.tokens.find((item) => item.address === drawer.address);
    if (!token) return;
    const pair = preferredPair(token);
    const move = Number(token.price_change_24h);
    const moveTone = move > 0 ? "chg up" : move < 0 ? "chg down" : "";
    root.innerHTML = `<div class="drawer-back"><aside class="drawer">
      <div class="drawer-head"><span class="drawer-kicker">Token</span><button class="icon-close" data-act="close-drawer" aria-label="Close">×</button></div>
      ${tokenBanner({
        banner: token.banner_url,
        symbol: token.symbol,
        quote: pair.quote_symbol || "",
        launched: launchedAt(token),
        dex: token.dex,
        label: pair.label || "",
      })}
      <div class="token-title">
        <div><h3>$${esc(token.symbol || "—")}</h3><p>${esc(token.name || "Unnamed token")}</p></div>
        <span class="pill ${esc(token.status)}">${esc(token.status)}</span>
      </div>
      <div class="metrics">
        ${metric("Price", formatPrice(token.price_usd))}
        ${metric("MCap", formatUsd(token.market_cap))}
        ${metric("ATH", formatUsd(token.ath_market_cap))}
        ${metric("Liquidity", formatUsd(token.liquidity_usd))}
        ${metric("24h", formatChange(token.price_change_24h), moveTone)}
      </div>
      <div class="action-row">
        ${dexscreenerHref(token) ? `<a class="action" href="${esc(dexscreenerHref(token))}" target="_blank" rel="noreferrer">Dexscreener</a>` : ""}
        ${dextoolsHref(token) ? `<a class="action" href="${esc(dextoolsHref(token))}" target="_blank" rel="noreferrer">Dextools</a>` : ""}
        ${gmgnHref(token) ? `<a class="action" href="${esc(gmgnHref(token))}" target="_blank" rel="noreferrer">GMGN</a>` : ""}
        ${/^0x[a-f0-9]{40}$/.test(String(token.address || "")) ? `<a class="action" href="https://etherscan.io/token/${esc(token.address)}" target="_blank" rel="noreferrer">Etherscan</a>` : ""}
        <button class="action" data-act="copy" data-value="${esc(token.address)}">Copy</button>
        <button class="action" data-act="drawer-wallet" data-address="${esc(token.deployer)}">Creator</button>
        <button class="action" data-act="real-buyers" data-address="${esc(token.address)}">Show Real Buyers</button>
        <button class="action" data-act="buyer-chart" data-address="${esc(token.address)}">Show Buyer Chart</button>
      </div>
      <div class="section-label">Paid</div>
      ${paidCell(token.payments)}
      <div class="section-label">Details</div>
      <div class="kv">
        <span>24h volume</span><div>${esc(formatUsd(token.volume_24h))}</div>
        <span>Launched</span><div>${esc(formatKst(launchedAt(token)))} ${zoneLabel()}</div>
        <span>Contract</span><div>${esc(formatKst(token.created_at))} ${zoneLabel()}</div>
        <span>Rival</span><div>${esc(rivalLabel(token.fundings))}</div>
        <span>Creator</span><div class="addr">${esc(token.deployer)}</div>
        <span>Token</span><div class="addr">${esc(token.address)}</div>
      </div>
    </aside></div>`;
  }
}

function tokensForDeployer(address) {
  const tokens = state.data.tokens.filter((token) => token.deployer === address);
  if (!tokens.length) return `<p class="muted">No token from this wallet yet.</p>`;
  return `<div class="list">${tokens
    .map(
      (token) =>
        `<button class="rowish" data-act="drawer-token" data-address="${esc(token.address)}" style="width:100%;border:0;text-align:left"><i class="swatch"></i><span><b>${esc(token.symbol)}</b><br><small>${esc(formatKst(launchedAt(token)))} ${zoneLabel()}</small></span><span class="pill ${esc(token.status)}">${esc(token.status)}</span></button>`,
    )
    .join("")}</div>`;
}

function readKeys(text) {
  const seen = new Set();
  const keys = [];
  for (const part of String(text || "").split(/[\s,;]+/)) {
    const key = part.trim();
    if (!/^[A-Za-z0-9]{20,80}$/.test(key)) continue;
    const id = key.toUpperCase();
    if (seen.has(id)) continue;
    seen.add(id);
    keys.push(key);
  }
  return keys;
}

function etherscanStatus(settings) {
  if (!settings.etherscanKeyCount) return "No keys saved. History is read through the public backup until you add keys.";
  const hint = settings.etherscanApiKeyHint ? ` · ${settings.etherscanApiKeyHint}` : "";
  return `${settings.etherscanKeyCount} keys saved. Calls rotate across them.${hint}`;
}

function onInput(event) {
  if (event.target.dataset.act === "zone-search") {
    if (state.picker?.type !== "zone") return;
    state.picker.query = event.target.value;
    const needle = event.target.value.trim().toLowerCase();
    for (const option of document.querySelectorAll(".zone-option")) {
      option.hidden = Boolean(needle) && !option.dataset.find.includes(needle);
    }
    return;
  }
  if (event.target.dataset.act === "picker-part") {
    const input = event.target;
    const max = Number(input.dataset.max) || 59;
    const digits = input.value.replace(/\D/g, "").slice(0, 2);
    input.value = digits && Number(digits) > max ? String(max) : digits;
    const picker = input.closest(".picker");
    const hour = picker?.querySelector("[data-max='23']")?.value || "0";
    const parts = [...(picker?.querySelectorAll("[data-act=picker-part]") || [])].map((node) => pad2(node.value || "0"));
    const label = picker?.querySelector(".picker-clock-label");
    const foot = picker?.querySelector(".picker-foot span");
    const clock = parts.length === 3 ? parts.join(":") : `${pad2(hour)}:00:00`;
    if (label) label.textContent = clock;
    if (foot) {
      const date = picker.querySelector("input[type=hidden]")?.value || "";
      foot.textContent = `${dateText(date)} ${clock}`;
    }
    return;
  }
  if (event.target.dataset.act === "etherscan-draft") {
    state.etherscanDraft = event.target.value;
    return;
  }
  if (event.target.dataset.act === "query") {
    state.query = event.target.value;
    resetPage();
    paintView();
    const input = document.querySelector("[data-act=query]");
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
  if (event.target.dataset.act === "trend-min") {
    state.trendMin = event.target.value.replace(/[^\d]/g, "");
    paintView();
    const input = document.querySelector("[data-act=trend-min]");
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
  if (event.target.dataset.act === "buyer-filter") {
    state.buyerFilter = event.target.value;
    resetPage();
    paintView();
  }
  if (event.target.dataset.act === "rival") {
    state.rival = event.target.value;
    resetPage();
    paintView();
  }
  if (event.target.dataset.act === "paid-only") {
    state.paidOnly = event.target.checked;
    resetPage();
    paintView();
    return;
  }
  if (event.target.dataset.act === "main-v4") {
    state.mainV4 = event.target.checked;
    resetPage();
    paintView();
    return;
  }
  if (event.target.dataset.act === "real-from" || event.target.dataset.act === "real-to") {
    const key = event.target.dataset.act === "real-from" ? "from" : "to";
    state.realSpan[key] = event.target.value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");
    paintRealBuyers();
    return;
  }
  if (event.target.dataset.act === "real-from-unit" || event.target.dataset.act === "real-to-unit") {
    const key = event.target.dataset.act === "real-from-unit" ? "fromUnit" : "toUnit";
    state.realSpan[key] = event.target.value === "h" ? "h" : "m";
    paintRealBuyers();
    return;
  }
  if (event.target.dataset.act === "real-page-size") {
    const size = Number(event.target.value);
    state.realPageSize = [25, 50, 100].includes(size) ? size : 25;
    state.pages.realBuyers = 1;
    paintRealBuyers();
    return;
  }
  if (event.target.dataset.act === "wallet-part") {
    const input = event.target;
    const max = Number(input.dataset.max) || 59;
    const digits = input.value.replace(/\D/g, "").slice(0, 2);
    input.value = digits && Number(digits) > max ? String(max) : digits;
    const picker = input.closest(".picker");
    const key = picker?.dataset.key === "end" ? "end" : "start";
    const parts = [...(picker?.querySelectorAll("[data-act=wallet-part]") || [])].map((node) => Number(node.value) || 0);
    const selected = unixParts(state.walletFilter[key]);
    const date = selected?.date || "";
    const clock = parts.map((part) => pad2(part)).join(":");
    const label = picker?.querySelector(".picker-clock-label");
    if (label && date) label.textContent = clock;
    if (date) {
      state.walletFilter[key] = partsToUnix(date, parts[0], parts[1], parts[2]);
      if (state.walletChart) state.walletChart.view = null;
      syncWalletChart();
    }
    return;
  }
  if (event.target.dataset.act === "wallet-query" || event.target.dataset.act === "wallet-min" || event.target.dataset.act === "wallet-max") {
    const act = event.target.dataset.act;
    const key = act === "wallet-query" ? "query" : act === "wallet-min" ? "minEth" : "maxEth";
    let value = event.target.value;
    if (key !== "query") value = value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");
    state.walletFilter[key] = value;
    if (value !== event.target.value) event.target.value = value;
    if (state.walletChart) state.walletChart.view = null;
    syncWalletChart();
    return;
  }
  if (event.target.dataset.act === "trade-buyer") {
    state.tradeFilter.address = event.target.value.trim();
    resetTradeView();
    syncTradeResults();
    return;
  }
  if (event.target.dataset.act === "trade-address" || event.target.dataset.act === "trade-min" || event.target.dataset.act === "trade-max") {
    const act = event.target.dataset.act;
    const key = act === "trade-address" ? "address" : act === "trade-min" ? "minEth" : "maxEth";
    let value = event.target.value;
    if (key !== "address") value = value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");
    state.tradeFilter[key] = value;
    if (value !== event.target.value) event.target.value = value;
    resetTradeView();
    syncTradeResults();
    return;
  }
  if (event.target.dataset.act === "page-size") {
    const size = Number(event.target.value);
    state.pageSize = [25, 50, 100].includes(size) ? size : 50;
    resetPage();
    paintView();
  }
}

async function onSubmit(event) {
  event.preventDefault();
  const form = event.target;
  if (form.id === "settings") return saveSettings(form);
  if (form.id === "rival-form") return saveRival(form);
  if (form.id === "buyer-form" || form.id === "buyer-manage") return saveBuyer(form);
  if (form.id === "confirm") return runConfirm();
}

async function onKeyFile(event) {
  const input = event.target;
  if (input.id !== "key-file") return;
  const file = input.files && input.files[0];
  input.value = "";
  if (!file) return;
  try {
    state.etherscanDraft = await file.text();
    state.etherscanFileName = file.name;
    state.etherscanMode = "file";
    const count = readKeys(state.etherscanDraft).length;
    state.forceView = true;
    paintView();
    state.forceView = false;
    toast(count ? `${count} keys read from ${file.name}` : "No keys found in that file");
  } catch {
    toast("Could not read that file");
  }
}

async function saveSettings(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  data.autoScan = form.autoScan.checked;
  data.fastMode = form.fastMode.checked;
  data.requireFirstFunder = form.requireFirstFunder.checked;
  data.telegramAlerts = form.telegramAlerts.checked;
  data.buyerAlerts = form.buyerAlerts.checked;
  data.trendAlerts = form.trendAlerts.checked;
  const settings = state.data.settings;
  data.scanRangeMode = rangeMode();
  if (!data.scanEndDate) data.scanEndDate = settings.scanEndDate;
  if (!data.scanStartBlock) data.scanStartBlock = settings.scanStartBlock;
  if (!data.scanEndBlock) data.scanEndBlock = settings.scanEndBlock;
  const err = document.getElementById("settings-err");
  if (state.etherscanDraft.trim()) {
    const keys = readKeys(state.etherscanDraft);
    if (!keys.length) {
      if (err) err.textContent = "No API keys found. Put one key on each line.";
      return;
    }
    data.etherscanApiKey = keys.join("\n");
  }
  try {
    await api("/api/settings", { method: "PUT", body: data });
    state.etherscanDraft = "";
    state.etherscanFileName = "";
    state.settingsDraft = null;
    toast("Settings saved");
    await load({ fresh: true });
  } catch (error) {
    if (err) err.textContent = error.message;
  }
}

async function saveBuyer(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  const managing = state.modal?.mode === "manage-buyers";
  const editing = managing ? state.modal.editing : state.modal?.mode === "buyer-edit" ? state.modal.id : null;
  try {
    if (editing) await api(`/api/buyers/${editing}`, { method: "PATCH", body: data });
    else await api("/api/buyers", { method: "POST", body: data });
    toast(editing ? "Buyer updated" : "Buyer added");
    if (managing) {
      state.modal.editing = null;
      state.modal.confirmId = null;
      state.modal.error = "";
      state.modal.draft = { label: "", address: "" };
      await load({ fresh: true });
      return;
    }
    state.modal = null;
    document.getElementById("modal").dataset.mode = "";
    await load({ fresh: true });
  } catch (error) {
    if (managing) {
      state.modal.error = error.message;
      state.modal.draft = { label: data.label || "", address: data.address || "" };
      paintModal();
      return;
    }
    const node = document.getElementById("form-err");
    if (node) node.textContent = error.message;
  }
}

async function saveRival(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  data.color = state.modal.color || state.modal.rival?.color || COLORS[0];
  if (form.enabled) data.enabled = form.enabled.checked;
  try {
    if (state.modal.mode === "edit") {
      await api(`/api/competitors/${state.modal.id}`, { method: "PATCH", body: data });
    } else {
      await api("/api/competitors", { method: "POST", body: data });
    }
    state.modal = null;
    document.getElementById("modal").dataset.mode = "";
    toast("Rival saved");
    await load({ fresh: true });
  } catch (error) {
    const node = document.getElementById("form-err");
    if (node) node.textContent = error.message;
  }
}

async function runConfirm() {
  const modal = state.modal;
  try {
    if (modal.kind === "delete") await api(`/api/competitors/${modal.id}`, { method: "DELETE" });
    if (modal.kind === "delete-buyer") await api(`/api/buyers/${modal.id}`, { method: "DELETE" });
    if (modal.kind === "purge") await api("/api/scan", { method: "POST", body: { id: modal.id, purge: true, rewind: true } });
    state.modal = null;
    document.getElementById("modal").dataset.mode = "";
    toast(modal.kind === "delete" ? "Rival deleted" : modal.kind === "delete-buyer" ? "Buyer deleted" : "Rescan started");
    await load({ fresh: true });
  } catch (error) {
    toast(error.message);
  }
}

async function onClick(event) {
  if (event.target.classList?.contains("wallet-back")) {
    state.walletChart = null;
    state.walletPicker = null;
    paintWalletChart();
    return;
  }
  if (event.target.classList?.contains("chart-back")) {
    state.buyerChart = null;
    paintBuyerChart();
    return;
  }
  if (event.target.classList?.contains("buyers-back")) {
    state.realBuyers = null;
    paintRealBuyers();
    return;
  }
  if (event.target.classList?.contains("drawer-back") || event.target.classList?.contains("modal-back")) {
    state.drawer = null;
    state.modal = null;
    const modal = document.getElementById("modal");
    if (modal) modal.dataset.mode = "";
    paintModal();
    paintDrawer();
    paintView();
    return;
  }
  if (event.target.closest("a") && !event.target.closest("a").dataset.act) return;
  const button = event.target.closest("[data-act]");
  if (state.picker && !event.target.closest(".picker")) {
    state.picker = null;
    if (!button || button.dataset.act === "route") {
      state.forceView = true;
      paintView();
      state.forceView = false;
    }
  }
  if (state.walletPicker && !event.target.closest("#wallet-chart .picker")) {
    state.walletPicker = null;
    paintWalletChart();
  }
  if (!button) return;
  const act = button.dataset.act;
  if (act === "real-from" || act === "real-to" || act === "real-from-unit" || act === "real-to-unit") return;
  if (act === "trade-address" || act === "trade-min" || act === "trade-max" || act === "trade-buyer") return;
  if (act === "wallet-query" || act === "wallet-min" || act === "wallet-max" || act === "wallet-part") return;
  if (act === "trade-side") {
    const side = button.dataset.side;
    state.tradeFilter.side = side === "buy" || side === "sell" ? side : "all";
    resetTradeView();
    syncTradeResults();
    return;
  }
  if (act === "chart-axis") {
    state.chartAxis = button.dataset.axis === "amount" ? "amount" : "mcap";
    if (state.buyerChart) state.buyerChart.view = null;
    paintBuyerChart();
    return;
  }
  if (act === "route") {
    enterRoute(button.dataset.route);
    state.query = "";
    location.hash = `/${state.route}`;
    paint();
    return;
  }
  if (act === "chip") {
    state[button.dataset.key] = button.dataset.value;
    resetPage();
    if (button.dataset.key === "trendWindow") {
      state.trendOpen = "";
      state.trends = null;
      paint();
      return;
    }
    paintView();
    return;
  }
  if (act === "trend-open") {
    const key = button.dataset.key;
    state.trendOpen = state.trendOpen === key ? "" : key;
    paintView();
    return;
  }
  if (act === "close-chart") {
    state.buyerChart = null;
    paintBuyerChart();
    return;
  }
  if (act === "close-wallet") {
    state.walletChart = null;
    state.walletPicker = null;
    paintWalletChart();
    return;
  }
  if (act === "wallet-chart") {
    const buyer = (state.data?.buyers || []).find((item) => String(item.id) === String(button.dataset.id));
    if (!buyer) return;
    state.walletFilter = emptyWalletFilter();
    state.walletAxis = "amount";
    state.walletPicker = null;
    state.walletChart = { buyer, trades: [], loading: true, error: "", view: null };
    paintWalletChart();
    loadWalletChart(buyer.id);
    return;
  }
  if (act === "wallet-side") {
    const side = button.dataset.side;
    state.walletFilter.side = side === "buy" || side === "sell" ? side : "all";
    if (state.walletChart) state.walletChart.view = null;
    syncWalletChart();
    return;
  }
  if (act === "wallet-axis") {
    state.walletAxis = button.dataset.axis === "mcap" ? "mcap" : "amount";
    if (state.walletChart) state.walletChart.view = null;
    paintWalletChart();
    return;
  }
  if (act === "wallet-open") {
    const key = button.dataset.key === "end" ? "end" : "start";
    const same = state.walletPicker?.key === key;
    if (same) state.walletPicker = null;
    else {
      const parts = unixParts(state.walletFilter[key]);
      state.walletPicker = { key, month: String(parts?.date || zonedToday()).slice(0, 7) };
    }
    paintWalletChart();
    return;
  }
  if (act === "wallet-month") {
    if (state.walletPicker?.key !== button.dataset.key) return;
    state.walletPicker.month = shiftMonth(state.walletPicker.month, Number(button.dataset.delta) || 0);
    paintWalletChart();
    return;
  }
  if (act === "wallet-day") {
    const key = button.dataset.key === "end" ? "end" : "start";
    const picker = button.closest(".picker");
    const parts = [...(picker?.querySelectorAll("[data-act=wallet-part]") || [])].map((node) => Number(node.value) || 0);
    state.walletFilter[key] = partsToUnix(button.dataset.day, parts[0], parts[1], parts[2]);
    if (state.walletChart) state.walletChart.view = null;
    paintWalletChart();
    return;
  }
  if (act === "wallet-clear") {
    const key = button.dataset.key === "end" ? "end" : "start";
    state.walletFilter[key] = "";
    if (state.walletChart) state.walletChart.view = null;
    paintWalletChart();
    return;
  }
  if (act === "wallet-now") {
    state.walletFilter.end = Math.floor(Date.now() / 1000);
    if (state.walletChart) state.walletChart.view = null;
    const parts = unixParts(state.walletFilter.end);
    state.walletPicker = { key: "end", month: String(parts.date).slice(0, 7) };
    paintWalletChart();
    return;
  }
  if (act === "buyer-chart") {
    const address = button.dataset.address;
    state.tradeFilter = { address: "", side: "all", minEth: "", maxEth: "" };
    state.buyerChart = { address, loading: true, ready: false, error: "", rows: [], progress: 0, progressLabel: "Fetching pool trades" };
    paintBuyerChart();
    loadBuyerChart(address);
    return;
  }
  if (act === "close-real") {
    state.realBuyers = null;
    paintRealBuyers();
    return;
  }
  if (act === "real-buyers") {
    const address = button.dataset.address;
    state.tradeFilter = { address: "", side: "all", minEth: "", maxEth: "" };
    state.realBuyers = { address, loading: true, ready: false, error: "", rows: [], progress: 0, progressLabel: "Fetching pool trades" };
    state.sort.realBuyers = { key: "time", dir: "desc" };
    state.pages.realBuyers = 1;
    paintRealBuyers();
    loadRealBuyers(address);
    return;
  }
  if (act === "real-sort") {
    const key = button.dataset.key;
    const current = state.sort.realBuyers || {};
    const dir = current.key !== key ? (button.dataset.type === "number" ? "desc" : "asc") : current.dir === "asc" ? "desc" : "asc";
    state.sort.realBuyers = { key, dir };
    state.pages.realBuyers = 1;
    paintRealBuyers();
    return;
  }
  if (act === "real-page") {
    const page = Number(button.dataset.page);
    if (!page || button.disabled) return;
    state.pages.realBuyers = page;
    paintRealBuyers();
    return;
  }
  if (act === "sort") {
    const key = button.dataset.key;
    const current = state.sort[state.route] || {};
    const dir = current.key !== key ? (button.dataset.type === "number" ? "desc" : "asc") : current.dir === "asc" ? "desc" : "asc";
    state.sort[state.route] = { key, dir };
    resetPage();
    paintView();
    return;
  }
  if (act === "page") {
    const page = Number(button.dataset.page);
    if (!page || button.disabled) return;
    state.pages[state.route] = page;
    paintView();
    return;
  }
  if (act === "open-picker") {
    const type = button.dataset.picker === "zone" ? "zone" : "when";
    const prefix = button.dataset.prefix || "";
    const same = state.picker?.type === type && (type === "zone" || state.picker.prefix === prefix);
    if (same) state.picker = null;
    else if (type === "zone") state.picker = { type: "zone", query: "" };
    else {
      const date = document.querySelector(`[name="${button.dataset.date}"]`)?.value || fieldValue(button.dataset.date);
      state.picker = { type: "when", prefix, dateName: button.dataset.date, month: String(date || zonedToday()).slice(0, 7) };
    }
    state.forceView = true;
    paintView();
    state.forceView = false;
    return;
  }
  if (act === "picker-month") {
    if (state.picker?.type !== "when" || state.picker.prefix !== button.dataset.prefix) return;
    state.picker.month = shiftMonth(state.picker.month, Number(button.dataset.delta) || 0);
    state.forceView = true;
    paintView();
    state.forceView = false;
    return;
  }
  if (act === "picker-day") {
    const input = document.querySelector(`[name="${button.dataset.date}"]`);
    if (input) input.value = button.dataset.day;
    if (state.picker?.type === "when") state.picker.month = String(button.dataset.day || "").slice(0, 7);
    captureSettingsDraft();
    state.forceView = true;
    paintView();
    state.forceView = false;
    return;
  }
  if (act === "picker-zone") {
    const input = document.querySelector("[name=timezoneOffset]");
    if (input) input.value = button.dataset.offset;
    state.picker = null;
    captureSettingsDraft();
    state.forceView = true;
    paintView();
    state.forceView = false;
    return;
  }
  if (act === "settings-tab") {
    const tab = button.dataset.tab;
    if (!SETTINGS_TABS.some(([id]) => id === tab) || tab === settingsTabId()) return;
    state.settingsTab = tab;
    state.forceView = true;
    paintView();
    state.forceView = false;
    return;
  }
  if (act === "range-mode") {
    const form = document.getElementById("settings");
    if (form) state.settingsDraft = { ...(state.settingsDraft || {}), ...Object.fromEntries(new FormData(form).entries()) };
    state.scanRangeMode = button.dataset.mode === "block" ? "block" : "date";
    state.forceView = true;
    paintView();
    state.forceView = false;
    return;
  }
  if (act === "current-time") {
    event.preventDefault();
    const parts = zonedNowParts();
    const form = document.getElementById("settings");
    const current = form ? Object.fromEntries(new FormData(form).entries()) : {};
    state.settingsDraft = { ...(state.settingsDraft || {}), ...current, ...parts };
    for (const [name, value] of Object.entries(parts)) {
      const input = document.querySelector(`[name="${name}"]`);
      if (input) input.value = value;
    }
    state.forceView = true;
    paintView();
    state.forceView = false;
    toast("End time set to now");
    return;
  }
  if (act === "latest-block") {
    event.preventDefault();
    const result = await api("/api/head");
    const input = document.querySelector("[name=scanEndBlock]");
    if (input) input.value = String(result.block);
    if (state.settingsDraft) state.settingsDraft.scanEndBlock = String(result.block);
    toast(`Latest block ${Number(result.block).toLocaleString()}`);
    return;
  }
  if (act === "key-mode") {
    state.etherscanMode = button.dataset.mode === "file" ? "file" : "type";
    state.forceView = true;
    paintView();
    state.forceView = false;
    return;
  }
  if (act === "pick-keys") {
    document.getElementById("key-file")?.click();
    return;
  }
  if (act === "copy") {
    await navigator.clipboard.writeText(button.dataset.value);
    toast("Copied");
    return;
  }
  if (act === "add-buyer") {
    state.modal = { mode: "buyer-add" };
    paintModal();
    return;
  }
  if (act === "edit-buyer") {
    const buyer = (state.data.buyers || []).find((item) => item.id === Number(button.dataset.id));
    if (!buyer || state.modal?.mode !== "manage-buyers") return;
    state.modal.editing = buyer.id;
    state.modal.confirmId = null;
    state.modal.error = "";
    state.modal.draft = { label: buyer.label || "", address: buyer.address || "" };
    paintModal();
    return;
  }
  if (act === "remove-buyer") {
    const buyer = (state.data.buyers || []).find((item) => item.id === Number(button.dataset.id));
    if (!buyer || state.modal?.mode !== "manage-buyers") return;
    captureBuyerDraft();
    state.modal.confirmId = buyer.id;
    state.modal.error = "";
    paintModal();
    return;
  }
  if (act === "add") {
    state.modal = { mode: "add", color: COLORS[0] };
    paintModal();
    return;
  }
  if (act === "edit") {
    const rival = state.data.competitors.find((item) => item.id === Number(button.dataset.id));
    state.modal = { mode: "edit", id: rival.id, rival, color: rival.color };
    paintModal();
    return;
  }
  if (act === "color") {
    const form = document.getElementById("rival-form");
    state.modal.color = button.dataset.color;
    if (form) {
      state.modal.rival = {
        ...(state.modal.rival || {}),
        label: form.label.value,
        address: form.address.value,
        notes: form.notes.value,
        enabled: form.enabled ? form.enabled.checked : 1,
        color: button.dataset.color,
      };
    }
    document.getElementById("modal").dataset.mode = "";
    paintModal();
    return;
  }
  if (act === "close") {
    state.modal = null;
    paint();
    return;
  }
  if (act === "manage-buyers") {
    state.modal = { mode: "manage-buyers", editing: null, confirmId: null, error: "", draft: { label: "", address: "" } };
    paintModal();
    return;
  }
  if (act === "buyer-cancel" || act === "buyer-delete-no") {
    if (state.modal?.mode === "manage-buyers") {
      state.modal.editing = null;
      state.modal.confirmId = null;
      state.modal.error = "";
      state.modal.draft = { label: "", address: "" };
      paintModal();
    }
    return;
  }
  if (act === "buyer-delete-yes") {
    const id = Number(button.dataset.id);
    try {
      await api(`/api/buyers/${id}`, { method: "DELETE" });
      if (state.modal?.mode === "manage-buyers") {
        if (state.modal.editing === id) {
          state.modal.editing = null;
          state.modal.draft = { label: "", address: "" };
        }
        state.modal.confirmId = null;
        state.modal.error = "";
      }
      toast("Buyer deleted");
      await load({ fresh: true });
    } catch (error) {
      if (state.modal?.mode === "manage-buyers") {
        state.modal.error = error.message;
        paintModal();
      } else toast(error.message);
    }
    return;
  }
  if (act === "close-drawer") {
    state.drawer = null;
    paintDrawer();
    return;
  }
  if (act === "drawer-wallet") {
    event.preventDefault();
    state.drawer = { type: "wallet", address: button.dataset.address };
    paintDrawer();
    return;
  }
  if (act === "drawer-token") {
    event.preventDefault();
    state.drawer = { type: "token", address: button.dataset.address };
    paintDrawer();
    return;
  }
  if (act === "fast") {
    const on = state.data.settings.fastMode !== "1";
    try {
      await api("/api/fast", { method: "POST", body: { on } });
      toast(on ? "Fast Mode on" : "Fast Mode off");
      await load({ fresh: true });
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  if (act === "live") {
    const on = state.data.settings.live !== "1";
    try {
      await api("/api/live", { method: "POST", body: { on } });
      toast(on ? "Live tracking on" : "Live tracking off");
      await load({ fresh: true });
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  if (act === "scan-all") return actScan();
  if (act === "scan") return actScan(Number(button.dataset.id));
  if (act === "stop") {
    await api("/api/scan/stop", { method: "POST", body: {} });
    toast("Stopping");
    await load({ fresh: true });
    return;
  }
  if (act === "remove") {
    const rival = state.data.competitors.find((item) => item.id === Number(button.dataset.id));
    state.modal = {
      mode: "confirm",
      kind: "delete",
      id: rival.id,
      title: `Delete ${rival.label}?`,
      body: "Funded wallets and tokens that belong only to this rival are removed.",
      confirm: "Delete",
    };
    paintModal();
    return;
  }
  if (act === "refresh-prices") {
    toast("Refreshing prices");
    await api("/api/markets/refresh", { method: "POST", body: {} });
    await load({ fresh: true });
    return;
  }
  if (act === "read") {
    await api("/api/events/read", { method: "POST", body: {} });
    await load({ fresh: true });
    return;
  }
  if (act === "telegram-test") {
    const form = document.getElementById("settings");
    const data = form ? Object.fromEntries(new FormData(form).entries()) : {};
    try {
      await api("/api/telegram/test", {
        method: "POST",
        body: {
          telegramBotToken: data.telegramBotToken || "",
          telegramChatId: data.telegramChatId || "",
        },
      });
      toast("Test message sent");
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  if (act === "clear-telegram") {
    await api("/api/settings", { method: "PUT", body: { clearTelegramToken: true, telegramAlerts: false } });
    toast("Telegram token removed");
    await load({ fresh: true });
    return;
  }
  if (act === "trend-samples") {
    try {
      await api("/api/telegram/trend-samples", { method: "POST", body: {} });
      toast("Four trend messages sent");
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  if (act === "buyer-test") {
    const form = document.getElementById("settings");
    const data = form ? Object.fromEntries(new FormData(form).entries()) : {};
    try {
      await api("/api/telegram/buyer-test", {
        method: "POST",
        body: {
          buyerBotToken: data.buyerBotToken || "",
          buyerChatId: data.buyerChatId || "",
        },
      });
      toast("Buyer test sent");
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  if (act === "clear-buyer-token") {
    await api("/api/settings", { method: "PUT", body: { clearBuyerToken: true, buyerAlerts: false } });
    toast("Buyer Tracker token removed");
    await load({ fresh: true });
    return;
  }
  if (act === "clear-key") {
    state.etherscanDraft = "";
    state.etherscanFileName = "";
    await api("/api/settings", { method: "PUT", body: { clearEtherscanKey: true } });
    toast("Keys removed");
    await load({ fresh: true });
    return;
  }
  if (act === "recheck") {
    const result = await api("/api/recheck-hidden", { method: "POST", body: {} });
    toast(`${result.updated} wallets queued`);
    await load({ fresh: true });
    return;
  }
  if (act === "recheck-wallet") {
    toast("Checking wallet");
    await api(`/api/deployers/${button.dataset.address}/refresh`, { method: "POST", body: {} });
    await load({ fresh: true });
  }
}

async function actScan(id, extra = {}) {
  try {
    await api("/api/scan", { method: "POST", body: { id, ...extra } });
    toast("Scan started");
    await load({ fresh: true });
  } catch (error) {
    toast(error.message);
  }
}

function enterRoute(route) {
  if (route === "trends" && state.route !== "trends") {
    state.trendWindow = "1h";
    state.trendOpen = "";
    state.trends = null;
  }
  state.route = route;
}

window.addEventListener("hashchange", () => {
  enterRoute(location.hash.replace("#/", "") || "overview");
  paint();
});

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (state.walletPicker) {
    state.walletPicker = null;
    paintWalletChart();
    return;
  }
  if (state.walletChart) {
    state.walletChart = null;
    paintWalletChart();
    return;
  }
  if (state.picker) {
    state.picker = null;
    state.forceView = true;
    paintView();
    state.forceView = false;
    return;
  }
  if (state.buyerChart) {
    state.buyerChart = null;
    paintBuyerChart();
    return;
  }
  if (state.realBuyers) {
    state.realBuyers = null;
    paintRealBuyers();
    return;
  }
  if (!state.drawer && !state.modal) return;
  state.drawer = null;
  state.modal = null;
  const modal = document.getElementById("modal");
  if (modal) modal.dataset.mode = "";
  paintModal();
  paintDrawer();
});

load().catch((error) => {
  document.getElementById("app").innerHTML = `<div class="empty"><h3>Could not load the tracker</h3><p>${esc(error.message)}</p></div>`;
});

setInterval(() => {
  if (document.hidden) return;
  load().catch(() => {});
}, 4000);
