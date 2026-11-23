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
  pageSize: 50,
  pages: { waiting: 1, tokens: 1, buyers: 1 },
  buyerFilter: "all",
  mainV4: true,
  paidOnly: false,
  sort: { tokens: { key: "launched", dir: "desc" }, buyers: { key: "time", dir: "desc" } },
};

const TITLES = {
  overview: ["Overview", "Funded wallets that have not launched yet, and the tokens that already have."],
  waiting: ["Waiting to launch", "Fresh wallets that received ETH from a rival and have not deployed a token."],
  tokens: ["Tokens", "Tokens deployed by those funded wallets, with pool, liquidity, and Dextools."],
  rivals: ["Rivals", "Add, rename, or remove the wallets you want to follow."],
  buyers: ["Buyers", "Wallets to follow when they buy or sell a rival token. Tracking runs on its own and does not wait on launch detection."],
  settings: ["Settings", "Choose the start and end time, or a block range, how much ETH counts as funding, and when a pool counts as rugged."],
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
  return token.pair_created_at || token.created_at;
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
      document.body.addEventListener("submit", onSubmit);
      document.body.addEventListener("input", onInput);
      document.body.addEventListener("change", onKeyFile);
      document.documentElement.dataset.bound = "1";
    }
  }
  paintNav();
  paintActions();
  paintScan();
  const typing = document.activeElement && document.getElementById("view")?.contains(document.activeElement);
  if (!state.modal && (state.forceView || !typing)) paintView();
  paintRivalProgress();
  paintModal();
  paintDrawer();
}

function paintNav() {
  const counts = state.data.counts;
  const items = [
    ["overview", "Overview", ""],
    ["waiting", "Waiting", counts.waiting],
    ["tokens", "Tokens", counts.tokens],
    ["rivals", "Rivals", counts.rivals],
    ["buyers", "Buyers", counts.buyers || 0],
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
  const [title, sub] = TITLES[state.route] || TITLES.overview;
  document.getElementById("title").textContent = title;
  document.getElementById("sub").textContent = sub;
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
    state.pageSize,
    state.pages[state.route] || 1,
    state.mainV4 ? "main" : "allpairs",
    state.paidOnly ? "paid" : "any",
    state.sort[state.route]?.key || "",
    state.sort[state.route]?.dir || "",
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
}

function viewOverview() {
  const counts = state.data.counts;
  const waiting = filteredWallets().filter((wallet) => wallet.status === "waiting").slice(0, 6);
  const tokens = filteredTokens().slice(0, 6);
  return `
    <section class="stats">
      ${stat("Waiting", counts.waiting)}
      ${stat("Live tokens", counts.live)}
      ${stat("Rugged", counts.rugged)}
      ${stat("Live liquidity", formatUsd(counts.liquidity))}
      ${stat("Still checking", counts.queued)}
    </section>
    <div class="grid-2">
      <section class="card">
        <h3>Fresh wallets</h3>
        ${waiting.length ? `<div class="list">${waiting.map(walletLine).join("")}</div>` : `<div class="empty"><h3>No wallets waiting</h3><p>Scan a rival. Funded wallets that have not deployed show up here.</p></div>`}
      </section>
      <section class="card">
        <h3>Latest tokens</h3>
        ${tokens.length ? `<div class="list">${tokens.map(tokenLine).join("")}</div>` : `<div class="empty"><h3>No tokens yet</h3><p>Launches appear after a funded wallet deploys a contract.</p></div>`}
      </section>
    </div>
    <section class="card" style="margin-top:12px">
      <div class="panel-head">
        <h3>Activity</h3>
        <button class="btn" data-act="read">Mark read</button>
      </div>
      <div class="activity">
        ${
          state.data.events.length
            ? state.data.events
                .map(
                  (event) =>
                    `<div class="event ${event.seen ? "" : "unseen"}"><div><b>${esc(event.kind)}</b> ${esc(event.message)}</div><small class="muted">${esc(formatAge(event.created_at))}</small></div>`,
                )
                .join("")
            : `<p class="muted">Scans write a line here when a wallet is funded or a token launches.</p>`
        }
      </div>
    </section>`;
}

function stat(label, value) {
  return `<div class="stat"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
}

function walletLine(wallet) {
  const funding = wallet.fundings[0];
  const age = formatAge(wallet.first_funded_at);
  return `<button class="rowish" data-act="drawer-wallet" data-address="${esc(wallet.address)}" style="width:100%;border:0;text-align:left">
    <i class="swatch" style="background:${esc(funding?.color || "#d6f25c")}"></i>
    <span><b>${esc(shortAddr(wallet.address))}</b><br><small>${esc(funding?.label || "")} · ${esc(formatEth(funding?.value_wei))} ETH</small></span>
    <span class="${Number(wallet.first_funded_at) > Date.now() / 1000 - 3600 ? "hot" : ""}">${esc(age)}</span>
  </button>`;
}

function tokenLine(token) {
  const funding = token.fundings[0];
  return `<button class="rowish" data-act="drawer-token" data-address="${esc(token.address)}" style="width:100%;border:0;text-align:left">
    <i class="swatch" style="background:${esc(funding?.color || "#d6f25c")}"></i>
    <span><b>${esc(token.symbol)}</b> ${esc(token.name)}<br><small>${esc(rivalLabel(token.fundings))} · ${esc(formatKst(launchedAt(token)))} ${zoneLabel()}</small></span>
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
        { label: "24h", key: "change", type: "number", align: "right" },
        { label: "Total tx", key: "txTotal", type: "number", align: "right" },
        { label: "24h tx", key: "tx24h", type: "number", align: "right" },
        { label: "Paid Status", key: "paid", type: "number" },
        { label: "" },
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

function tokenRow(token) {
  const exchange = token.label ? `<span class="exch">${esc(token.label)}</span>` : "";
  return `<tr class="clickable" data-act="drawer-token" data-address="${esc(token.address)}">
    <td><span class="pill ${esc(token.status)}">${esc(token.status)}</span></td>
    <td class="token-cell"><span class="token-line">${tokenThumb(token)}<span class="token-name"><b>${esc(token.symbol)}</b> <span class="muted">(${esc(token.name)})</span>${exchange}</span></span></td>
    <td>${esc(token.rival)}</td>
    <td>${esc(formatKst(token.launched))}</td>
    <td class="num">${esc(formatUsd(token.liquidity))}</td>
    <td class="num">${esc(formatUsd(token.mcap))}</td>
    <td class="num" title="${esc(exactUsd(token.ath))}">${esc(formatUsd(token.ath))}</td>
    <td class="num">${changeCell(token.change)}</td>
    <td class="num">${esc(formatCount(token.txTotal))}</td>
    <td class="num">${esc(formatCount(token.tx24h))}</td>
    <td class="paid-cell">${paidCell(token.payments, true)}</td>
    <td class="links">
      ${dextoolsHref(token) ? `<a class="link-pill" href="${esc(dextoolsHref(token))}" target="_blank" rel="noreferrer">Dextools</a>` : ""}
      ${dexscreenerHref(token) ? `<a class="link-pill" href="${esc(dexscreenerHref(token))}" target="_blank" rel="noreferrer">Dexscreener</a>` : ""}
    </td>
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
        launched: pair.pair_created_at || token.pair_created_at || token.created_at || null,
        liquidity: numberOrNull(pair.liquidity_usd),
        mcap: numberOrNull(pair.market_cap),
        ath: numberOrNull(token.ath_market_cap),
        change: numberOrNull(pair.price_change_24h),
        tx24h: numberOrNull(pair.txns_24h),
        txTotal: countedTx(token),
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
    const liquidity = Number(row.liquidity) || 0;
    if (!current || liquidity > current.liquidity) best.set(row.address, { liquidity, pair: row.pairAddress });
  }
  return rows.filter((row) => {
    if (row.label !== "v4") return true;
    const winner = best.get(row.address);
    return !winner || winner.pair === row.pairAddress;
  });
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function countedTx(token) {
  const pairs = token.pairs || [];
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
      <button class="btn primary" data-act="add-buyer">Add buyer</button>
      <select class="search" data-act="buyer-filter" style="width:180px">${options}</select>
      <input class="search" data-act="query" placeholder="Search token, buyer, transaction" value="${esc(state.query)}" />
    </div>
    <div class="rivals">
      ${buyers.length ? buyers.map(buyerCard).join("") : `<div class="card empty"><h3>No buyers yet</h3><p>Add a wallet to record when it buys or sells a rival token.</p></div>`}
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

function buyerCard(buyer) {
  return `<article class="card buyer">
    <div>
      <div class="name">${esc(buyerName(buyer))}</div>
      <div class="addr">${esc(buyer.address)} <button class="icon-btn" data-act="copy" data-value="${esc(buyer.address)}">copy</button></div>
    </div>
    <div class="mini-actions">
      <button class="btn" data-act="edit-buyer" data-id="${buyer.id}">Edit</button>
      <button class="btn danger" data-act="remove-buyer" data-id="${buyer.id}">Delete</button>
    </div>
  </article>`;
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
    <td class="num" title="${esc(trade.amount)}">${esc(formatAmount(trade.amount))}</td>
    <td><b>${esc(token)}</b>${name}</td>
    <td>${esc(trade.buyer_label || shortAddr(trade.buyer_address))}</td>
    <td class="links"><a class="link-pill" href="https://etherscan.io/tx/${esc(trade.tx_hash)}" target="_blank" rel="noreferrer">Etherscan</a></td>
  </tr>`;
}

function viewRivals() {
  return `
    <div class="toolbar"><button class="btn primary" data-act="add">Add rival</button></div>
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
      <div class="addr">${esc(rival.address)} <button class="icon-btn" data-act="copy" data-value="${esc(rival.address)}">copy</button></div>
      ${rival.notes ? `<div class="muted" style="margin-top:6px;white-space:normal">${esc(rival.notes)}</div>` : ""}
    </div>
    <div><b>${rival.waiting}</b><div class="muted">waiting</div></div>
    <div><b>${rival.live}</b><div class="muted">live</div></div>
    <div><b>${rival.tokens}</b><div class="muted">tokens</div></div>
    <div class="mini-actions">
      <button class="btn" data-act="scan" data-id="${rival.id}" ${scanning() ? "disabled" : ""}>Scan</button>
      <button class="btn" data-act="edit" data-id="${rival.id}">Edit</button>
      <button class="btn danger" data-act="remove" data-id="${rival.id}">Delete</button>
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

function fieldValue(name) {
  const draft = state.settingsDraft || {};
  if (draft[name] != null && String(draft[name]) !== "") return draft[name];
  return state.data.settings[name] ?? "";
}

function clockInputs(prefix) {
  return `<div class="clock"><input name="${prefix}Hour" inputmode="numeric" maxlength="2" placeholder="HH" value="${esc(fieldValue(`${prefix}Hour`) || "0")}" /><span>:</span><input name="${prefix}Minute" inputmode="numeric" maxlength="2" placeholder="MM" value="${esc(fieldValue(`${prefix}Minute`) || "0")}" /><span>:</span><input name="${prefix}Second" inputmode="numeric" maxlength="2" placeholder="SS" value="${esc(fieldValue(`${prefix}Second`) || "0")}" /></div>`;
}

function whenField(label, dateName, prefix, action) {
  const button = action
    ? `<button class="btn" type="button" data-act="${esc(action.act)}">${esc(action.label)}</button>`
    : "";
  return `<div class="field wide"><label>${label} (${zoneLabel()})</label><div class="when"><input type="date" name="${dateName}" value="${esc(fieldValue(dateName))}" />${clockInputs(prefix)}${button}</div></div>`;
}

function scanRangeFields() {
  const mode = rangeMode();
  if (mode === "block") {
    return `<div class="field"><label>Start block</label><input name="scanStartBlock" inputmode="numeric" value="${esc(fieldValue("scanStartBlock"))}" placeholder="26200000" /></div>
      <div class="field"><label>End block</label><div class="end-block"><input name="scanEndBlock" inputmode="numeric" value="${esc(fieldValue("scanEndBlock"))}" placeholder="Latest block" /><button class="btn" type="button" data-act="latest-block">Latest block</button></div></div>`;
  }
  return `${whenField("Start", "scanStartDate", "scanStart")}
    ${whenField("End", "scanEndDate", "scanEnd", { act: "current-time", label: "Current time" })}`;
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

function viewSettings() {
  const settings = state.data.settings;
  const mode = rangeMode();
  return `<form id="settings" class="card">
    <div class="settings">
      <div class="field wide">
        <label>Scan range</label>
        <div class="chips key-modes">
          <button type="button" class="chip ${mode === "date" ? "on" : ""}" data-act="range-mode" data-mode="date">Start and end time</button>
          <button type="button" class="chip ${mode === "block" ? "on" : ""}" data-act="range-mode" data-mode="block">Start and end block</button>
        </div>
        <p class="keys-note">Saved wallets and tokens stay. A time scan runs from the start through the end in the timezone below. Blocks already saved are skipped.</p>
      </div>
      <div class="field"><label>Timezone</label><div class="clock"><span>UTC</span><input name="timezoneOffset" inputmode="numeric" maxlength="3" placeholder="9" value="${esc(fieldValue("timezoneOffset") || "9")}" /></div></div>
      ${scanRangeFields()}
      <div class="field"><label>Minimum funding (ETH)</label><input name="minFundingEth" value="${esc(fieldValue("minFundingEth"))}" /></div>
      <div class="field"><label>Maximum funding (ETH)</label><input name="maxFundingEth" value="${esc(fieldValue("maxFundingEth"))}" /></div>
      <div class="field"><label>Ignore incoming dust (ETH)</label><input name="dustEth" value="${esc(fieldValue("dustEth"))}" /></div>
      <div class="field"><label>Live liquidity floor (USD)</label><input name="rugLiquidityUsd" value="${esc(fieldValue("rugLiquidityUsd"))}" /></div>
      <div class="field"><label>Auto scan every (minutes)</label><input name="scanIntervalMin" value="${esc(fieldValue("scanIntervalMin"))}" /></div>
      <div class="field"><label>Pages per pass</label><input name="maxPages" value="${esc(fieldValue("maxPages"))}" /></div>
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
      <div class="field wide">
        <label>Telegram alerts</label>
        <p class="keys-note">Leave Live on in the header so new transactions keep getting read. Fast Mode switches launch alerts to new Dextools pairs and paid alerts to the Dextools and Dexscreener boards. Alerts cover events from the moment you turn them on.</p>
        <p class="keys-note">Anyone who presses Start in the bot gets the same alerts. ${telegramAudience()}</p>
        <p class="keys-note">${settings.telegramBotTokenSet ? "Bot token saved. Paste a new one only if you want to replace it." : "No bot token saved yet."}</p>
        <input name="telegramBotToken" type="password" autocomplete="off" spellcheck="false" placeholder="Bot token from @BotFather" />
        <input name="telegramChatId" autocomplete="off" spellcheck="false" placeholder="Chat id" value="${esc(fieldValue("telegramChatId"))}" />
      </div>
      <div class="field wide">
        <label>Buyer Tracker</label>
        <p class="keys-note">Name: Buyer Tracker · @ETHBuyerTrackerBot. This bot only sends buyer buys and sells. Launch alerts stay on the other bot.</p>
        <p class="keys-note">Anyone who presses Start in @ETHBuyerTrackerBot gets the same trade alerts. ${buyerAudience()}</p>
        <p class="keys-note">${settings.buyerBotTokenSet ? "@ETHBuyerTrackerBot token saved. Paste a new one only if you want to replace it." : "Paste the @ETHBuyerTrackerBot token from @BotFather."}</p>
        <input name="buyerBotToken" type="password" autocomplete="off" spellcheck="false" placeholder="@ETHBuyerTrackerBot token from @BotFather" />
        <input name="buyerChatId" autocomplete="off" spellcheck="false" placeholder="Chat id" value="${esc(fieldValue("buyerChatId"))}" />
      </div>
    </div>
    <label class="check"><input type="checkbox" name="fastMode" ${settings.fastMode === "1" ? "checked" : ""}/> Fast Mode: watch Dextools live pairs and paid boards, and alert only when the token is tied to a rival</label>
    <label class="check"><input type="checkbox" name="telegramAlerts" ${settings.telegramAlerts === "1" ? "checked" : ""}/> Send a Telegram card for each new launch and paid promotion</label>
    <label class="check"><input type="checkbox" name="buyerAlerts" ${settings.buyerAlerts === "1" ? "checked" : ""}/> Send a Buyer Tracker message for each buy or sell</label>
    <label class="check"><input type="checkbox" name="autoScan" ${settings.autoScan === "1" ? "checked" : ""}/> Keep scanning enabled rivals on a timer</label>
    <label class="check"><input type="checkbox" name="requireFirstFunder" ${settings.requireFirstFunder === "1" ? "checked" : ""}/> Only keep a wallet when this rival is its first real ETH source</label>
      <p class="muted">Sample launches are funded with well under 1 ETH, so the maximum keeps treasury-sized transfers out of the waiting list. A wallet stays on the list when this rival is the first wallet that sent it real ETH. ${state.data.counts.ignored} wallets are hidden by that rule.</p>
    <div class="err" id="settings-err"></div>
    <div class="actions">
      <button class="btn primary" type="submit">Save settings</button>
      <button class="btn" type="button" data-act="telegram-test">Send test message</button>
      <button class="btn" type="button" data-act="buyer-test">Send buyer test</button>
      <button class="btn" type="button" data-act="clear-key">Remove Etherscan keys</button>
      <button class="btn" type="button" data-act="clear-telegram">Remove Telegram token</button>
      <button class="btn" type="button" data-act="clear-buyer-token">Remove Buyer Tracker token</button>
      <button class="btn" type="button" data-act="recheck">Re-check hidden wallets</button>
    </div>
  </form>`;
}

function paintModal() {
  const root = document.getElementById("modal");
  if (!state.modal) {
    root.innerHTML = "";
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
    const pair = (token.pairs || []).slice().sort((a, b) => Number(b.liquidity_usd) - Number(a.liquidity_usd))[0] || {};
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
        ${/^0x[a-f0-9]{40}$/.test(String(token.address || "")) ? `<a class="action" href="https://etherscan.io/token/${esc(token.address)}" target="_blank" rel="noreferrer">Etherscan</a>` : ""}
        <button class="action" data-act="copy" data-value="${esc(token.address)}">Copy</button>
        <button class="action" data-act="drawer-wallet" data-address="${esc(token.deployer)}">Creator</button>
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
  if (form.id === "buyer-form") return saveBuyer(form);
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
  try {
    if (state.modal.mode === "buyer-edit") {
      await api(`/api/buyers/${state.modal.id}`, { method: "PATCH", body: data });
    } else {
      await api("/api/buyers", { method: "POST", body: data });
    }
    state.modal = null;
    document.getElementById("modal").dataset.mode = "";
    toast("Buyer saved");
    await load({ fresh: true });
  } catch (error) {
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
  if (event.target.classList?.contains("drawer-back") || event.target.classList?.contains("modal-back")) {
    state.drawer = null;
    state.modal = null;
    const modal = document.getElementById("modal");
    if (modal) modal.dataset.mode = "";
    paintModal();
    paintDrawer();
    return;
  }
  if (event.target.closest("a") && !event.target.closest("a").dataset.act) return;
  const button = event.target.closest("[data-act]");
  if (!button) return;
  const act = button.dataset.act;
  if (act === "route") {
    state.route = button.dataset.route;
    state.query = "";
    location.hash = `/${state.route}`;
    paint();
    return;
  }
  if (act === "chip") {
    state[button.dataset.key] = button.dataset.value;
    resetPage();
    paintView();
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
    toast(`End time ${parts.scanEndDate} ${parts.scanEndHour}:${parts.scanEndMinute}:${parts.scanEndSecond}`);
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
    if (!buyer) return;
    state.modal = { mode: "buyer-edit", id: buyer.id, buyer };
    paintModal();
    return;
  }
  if (act === "remove-buyer") {
    const buyer = (state.data.buyers || []).find((item) => item.id === Number(button.dataset.id));
    if (!buyer) return;
    state.modal = {
      mode: "confirm",
      kind: "delete-buyer",
      id: buyer.id,
      title: `Delete ${buyerName(buyer)}?`,
      body: "The wallet leaves the list, and the trades saved for it are removed.",
      confirm: "Delete",
    };
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
    document.getElementById("modal").dataset.mode = "";
    paintModal();
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

window.addEventListener("hashchange", () => {
  state.route = location.hash.replace("#/", "") || "overview";
  paint();
});

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
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
