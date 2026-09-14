/* =========================================================
   NSE 500 Charts — app.js
   Pure jQuery + Lightweight Charts. No build step required.
   ========================================================= */

(function () {
  "use strict";

  /* ---------------------------------------------------------
     0. Config
     --------------------------------------------------------- */

  // Chart data and quote metadata are fetched through the HomeController
  // proxy endpoint, which calls Yahoo Finance server-side and avoids CORS.
  const CONTROLLER_PROXY = "/api/chart-data";
  const QUOTE_PROXY = "/api/quote-data";

  // Timeframes are generic keys — what interval/range string each maps to
  // is entirely up to the active data source (see datasources.js), not
  // hardcoded here. This is the app depending on an abstraction rather
  // than a specific provider's API shape.
  const TIMEFRAMES = [
    { key: "D", label: "Daily" },
    { key: "W", label: "Weekly" },
    { key: "M", label: "Monthly" },
    { key: "H", label: "1 Hour" }
  ];

  const SMA_PERIOD = 5;
  const RSI_PERIOD = 14;
  const MACD_FAST = 12, MACD_SLOW = 26, MACD_SIGNAL = 9;
  const SUPER_TREND_MULTIPLIER = 3;

  const NIFTY_STOCK = { s: "^NSEI", n: "Nifty 50 Index", i: "Index" };

  const SETTINGS_KEY = "nseCharts.settings";
  const INVALID_SYMBOLS = new Set(["DUMMYHEG"]);
  const SYNC_STORE_KEY = "nseCharts.symbolSync";
  const DEFAULT_SETTINGS = {
    theme: "light",
    density: "compact",
    barCount: 60,
    priceDecimals: 0,
    axisMode: "percent", // "percent" (default: right axis shows % change) | "price"
    percentBase: "current", // % axis base: "current" (last close = 0%) | "first" (first visible bar = 0%)
    analysisPoints: 150, // history depth used for win-rate/analysis (display still shows barCount)
    smaEnabled: true,
    rsiEnabled: false,
    macdEnabled: false,
    supertrendEnabled: false,
    supertrendPeriod: 5,
    patternsEnabled: true,
    chartColumns: 0, // "0" = responsive (web 2 / mobile 1) | "1".."4" = forced columns
    autoLoadNifty: true,
    rememberSelectedSymbol: true,
    sortMode: "change", // "change" | "momentum" | "symbol" | "sector"
    filterMode: "all", // "all" | "positive" | "negative" | "nearHigh" | "above5sma"
    signalMode: "all", // "all" | "signalBuy" | "signalWatch" | "signalAvoid"
    dataSource: "yahoo", // see datasources.js — the only currently-functional free source
    useProxy: false, // Using controller proxy, so this is always false
    visible: { M: true, W: true, D: true, H: false },
    lastSelectedSymbol: null
  };

  /* ---------------------------------------------------------
     1. State
     --------------------------------------------------------- */

  let STOCKS = [];
  let filtered = [];
  let activeIndex = -1;
  let quoteCache = {};
  let syncStore = loadSyncStore();
  let syncInProgress = false;
  let syncStopRequested = false;
  const syncAbortControllers = new Set();
  const charts = {};       // tfKey -> { chart, series, volSeries, smaSeries, rsiSeries, macdLine, macdSignal, macdHist }
  const candleCache = {};  // tfKey -> full (unsliced) candle array for the current symbol
  const candleCacheRange = {}; // tfKey -> Yahoo range string used to fetch the current candleCache
  const candleMetaCache = {}; // tfKey -> Yahoo meta info for the current symbol
  const activeFetches = {}; // tfKey -> { controllers, symbol } for the in-flight request, so it can be cancelled
  let currentStock = null; // the stock object currently loaded across all panels
  let SETTINGS = loadSettings();
  let resizeObserver = null;

  /* ---------------------------------------------------------
     2. Boot
     --------------------------------------------------------- */

  $(function () {
    applyTheme(SETTINGS.theme);
    applyDensity(SETTINGS.density);
    buildChartPanels();
    bindSettingsUI();
    bindGlobalUI();
    updateGridLayout();

    // Stock list is embedded via stocks.js (window.STOCKS_DATA) rather than
    // fetched with AJAX, so this works straight off disk (file://) with no
    // local server required.
    $("#sortSelect").val(SETTINGS.sortMode || "change");
    $("#filterSelect").val(SETTINGS.filterMode || "all");
    $("#signalSelect").val(SETTINGS.signalMode || "all");
    $("#chartColumnsSelect").val(String(SETTINGS.chartColumns || 0));
    const fallbackData = window.STOCKS_DATA || [];
    try {
      if (!window.matchMedia("(max-width: 760px)").matches &&
          localStorage.getItem("sc.sidebarHidden") === "1") {
        $("#app").addClass("sidebar-hidden");
      }
    } catch (err) { /* storage may be unavailable */ }
    loadStockList(fallbackData);
  });

  async function loadStockList(fallbackData) {
    let data = fallbackData;
    try {
      const response = await fetch("/api/nifty500-symbols", { cache: "no-store" });
      if (response.ok) {
        const current = await response.json();
        if (Array.isArray(current) && current.length) data = current;
      }
    } catch (e) {
      // The embedded list keeps the standalone file:// version usable.
    }

    if (!data.length) {
      $("#stockList").html(
        `<div class="empty-hint">Stock list not found.<br>Make sure stocks.js is loaded before app.js in index.html.</div>`
      );
      if (SETTINGS.autoLoadNifty) selectNifty();
      return;
    }

    STOCKS = data.filter((stock) => stock && !INVALID_SYMBOLS.has(String(stock.s || "").trim().toUpperCase()));
    renderList(STOCKS, "");
    refreshFilteredList();
    syncPendingSymbols(data);

    if (SETTINGS.rememberSelectedSymbol && SETTINGS.lastSelectedSymbol) {
      restoreSavedSelection();
    } else if (SETTINGS.autoLoadNifty) {
      selectNifty();
    }
  }

  /* ---------------------------------------------------------
     3. Sidebar list
     --------------------------------------------------------- */

  function renderList(list, query) {
    const $list = $("#stockList");
    $("#addSymbolBtn").toggleClass("visible", !!query && !list.length);
    if (!list.length) {
      $list.html(
        query
          ? `<div class="empty-hint">No match for <b>${escapeHtml(query)}</b>.<br>Click <b class="add-glyph">+</b> to add it as a ticker symbol.</div>`
          : `<div class="empty-hint">No symbols match your search.</div>`
      );
      return;
    }
    const rows = list.map((s, i) => rowHtml(s, i));
    $list.html(rows.join(""));
  }

  function rowHtml(s, i) {
    const meta = getQuoteMeta(s);
    const syncStatus = getSyncStatus(s.s);
    const badge = syncStatus === "not-found"
      ? `<span class="not-found-mark" title="Symbol not found">X</span>`
      : meta && Number.isFinite(meta.changePct)
      ? `<span class="move-pill ${meta.changePct > 0 ? "up" : meta.changePct < 0 ? "down" : "flat"}">${fmtPercent(meta.changePct)}</span>`
      : "";
    return (
      `<div class="stock-row" data-idx="${i}" data-sym="${s.s}">` +
      `<span class="sym-wrap">` +
      `<span class="sym sync-${syncStatus}">${s.s}</span>` +
      `${badge}` +
      `</span>` +
      `<span class="sector">${escapeHtml(s.i)}</span>` +
      `</div>`
    );
  }

  function getQuoteMeta(stock) {
    if (!stock) return null;
    return quoteCache[stock.s] || quoteCache[stock.s.toUpperCase()] || quoteCache[stock.s.toLowerCase()] || null;
  }

  function applySort(list) {
    const mode = SETTINGS.sortMode || "change";
    const arr = list.slice();
    if (mode === "sector") {
      arr.sort((a, b) => a.i.localeCompare(b.i) || a.s.localeCompare(b.s));
    } else if (mode === "momentum") {
      arr.sort((a, b) => {
        const aM = stockMomentum(a);
        const bM = stockMomentum(b);
        if (aM !== null && bM !== null && aM !== bM) return bM - aM;
        if (aM === null && bM !== null) return 1;
        if (aM !== null && bM === null) return -1;
        return a.s.localeCompare(b.s);
      });
    } else if (mode === "change") {
      arr.sort((a, b) => {
        const aMeta = getQuoteMeta(a);
        const bMeta = getQuoteMeta(b);
        const aPct = aMeta && Number.isFinite(aMeta.changePct) ? aMeta.changePct : Number.NEGATIVE_INFINITY;
        const bPct = bMeta && Number.isFinite(bMeta.changePct) ? bMeta.changePct : Number.NEGATIVE_INFINITY;
        if (aPct !== bPct) return bPct - aPct;
        return a.s.localeCompare(b.s);
      });
    } else {
      arr.sort((a, b) => a.s.localeCompare(b.s)); // symbol (ticker), alphabetical
    }
    return arr;
  }

  // Strikes a balance between responsiveness and freshness: momentum comes
  // from the cached daily analysis, with the quote's daily change as a
  // fallback so rows stay reasonably ordered even before sync finishes.
  function stockMomentum(stock) {
    if (!window.StockPrediction || typeof StockPrediction.getMomentum !== "function") return null;
    return StockPrediction.getMomentum(stock.s, quoteCache);
  }

  // Re-sorts whatever's currently filtered (keeps the active search intact),
  // re-renders, and keeps the currently-loaded symbol's highlight/position
  // in sync since its index within `filtered` may have moved.
  function resortList() {
    const currentSym = activeIndex >= 0 && filtered[activeIndex] ? filtered[activeIndex].s : null;
    filtered = applySort(filtered);
    renderList(filtered, $("#searchInput").val().trim());
    updateListMeta();
    activeIndex = currentSym ? filtered.findIndex((s) => s.s === currentSym) : -1;
    highlightActiveRow();
    updateNavButtons();
  }

  function escapeHtml(str) {
    return $("<div>").text(str || "").html();
  }

  function getFilterMode() {
    return $("#filterSelect").val() || SETTINGS.filterMode || "all";
  }

  function getSignalMode() {
    return $("#signalSelect").val() || SETTINGS.signalMode || "all";
  }

  function updateListMeta() {
    const total = STOCKS.length;
    const query = $("#searchInput").val().trim();
    const mode = getFilterMode();
    const signal = getSignalMode();
    const hasCriteria = query.length > 0 || mode !== "all" || signal !== "all";
    $("#listMeta").text(hasCriteria ? `${filtered.length} of ${total}` : `${total} symbols`);
    updateSyncSummary();
  }

  function getWorkingDayKey(date) {
    const day = new Date(date);
    const weekday = day.getDay();
    if (weekday === 6) day.setDate(day.getDate() - 1);
    if (weekday === 0) day.setDate(day.getDate() - 2);
    return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  }

  function loadSyncStore() {
    const today = getWorkingDayKey(new Date());
    try {
      const saved = JSON.parse(localStorage.getItem(SYNC_STORE_KEY) || "null");
      if (saved && saved.workingDay === today) {
        quoteCache = saved.quotes || {};
        return { workingDay: today, symbols: saved.symbols || {}, quotes: quoteCache };
      }
    } catch (e) { /* storage unavailable or invalid — start a fresh day */ }
    return { workingDay: today, symbols: {}, quotes: {} };
  }

  function saveSyncStore() {
    syncStore.quotes = quoteCache;
    try { localStorage.setItem(SYNC_STORE_KEY, JSON.stringify(syncStore)); }
    catch (e) { /* storage unavailable — syncing still works for this session */ }
  }

  function getSyncStatus(symbol) {
    ensureCurrentWorkingDay();
    return (syncStore.symbols[String(symbol).toUpperCase()] || {}).status || "pending";
  }

  function ensureCurrentWorkingDay() {
    const today = getWorkingDayKey(new Date());
    if (syncStore.workingDay === today) return;
    quoteCache = {};
    syncStore = { workingDay: today, symbols: {}, quotes: quoteCache };
    saveSyncStore();
  }

  function updateSyncSummary() {
    const total = STOCKS.length;
    const synced = STOCKS.filter((stock) => getSyncStatus(stock.s) === "synced").length;
    $("#syncSummary").text(total ? `${synced}/${total} synced` : "");
    $("#syncNowBtn, #syncPendingBtn").prop("disabled", syncInProgress || !total);
    $("#stopSyncBtn").prop("disabled", !syncInProgress);
  }

  function setSyncStatus(symbol, status, error) {
    syncStore.symbols[String(symbol).toUpperCase()] = {
      status,
      syncedAt: status === "synced" ? new Date().toISOString() : null,
      error: error || null
    };
    saveSyncStore();
  }

  // During a sync run the list is NOT re-rendered per symbol (that rebuilds
  // the whole table plus the analysis universe and starves the proxy queue).
  // Instead just flip the status class on the visible row so feedback stays
  // live; the full refresh happens once when the sync finishes.
  function updateRowSyncBadge(symbol, status) {
    const $sym = $(`.stock-row[data-sym="${symbol}"] .sym`);
    if (!$sym.length) return;
    $sym.attr("class", `sym sync-${status}`);
  }

  function matchesFilter(stock, mode) {
    const meta = getQuoteMeta(stock);
    if (!meta) return false;

    if (mode === "positive") return Number.isFinite(meta.changePct) && meta.changePct > 0;
    if (mode === "negative") return Number.isFinite(meta.changePct) && meta.changePct < 0;
    if (mode === "nearHigh") {
      const high = meta.fiftyTwoWeekHigh;
      const price = meta.price;
      if (!Number.isFinite(high) || high <= 0 || !Number.isFinite(price) || price <= 0) return false;
      return price >= high * 0.9;
    }
    if (mode === "above5sma") {
      return meta.aboveSma5 === true;
    }
    return true;
  }

  function matchesSignal(stock, signal) {
    if (!signal || signal === "all") return true;
    if (!window.StockPrediction || typeof StockPrediction.getSignal !== "function") return false;
    const expected = signal === "signalBuy" ? "BUY / HOLD" : signal === "signalWatch" ? "WATCH" : "AVOID";
    return StockPrediction.getSignal(stock.s, quoteCache) === expected;
  }

  function refreshFilteredList() {
    const q = $("#searchInput").val().trim().toUpperCase();
    let mode = getFilterMode();
    let signal = getSignalMode();

    // Old saved settings kept signal modes inside filterMode; migrate them.
    if (mode && mode.indexOf("signal") === 0) {
      if (signal === "all") signal = mode;
      mode = "all";
    }

    let next = STOCKS;

    if (q) {
      next = next.filter((s) => s.s.toUpperCase().includes(q) || s.n.toUpperCase().includes(q));
    }

    if (mode !== "all") {
      next = next.filter((s) => matchesFilter(s, mode));
    }

    if (signal !== "all") {
      next = next.filter((s) => matchesSignal(s, signal));
    }

    filtered = applySort(next);
    filtered.forEach((stock) => { stock.syncStatus = getSyncStatus(stock.s); });
    renderList(filtered, q);
    updateListMeta();

    if (currentStock && filtered.some((s) => s.s === currentStock.s)) {
      activeIndex = filtered.findIndex((s) => s.s === currentStock.s);
    } else {
      activeIndex = -1;
    }

    highlightActiveRow();
    updateNavButtons();
    if (window.StockPrediction) StockPrediction.renderUniverse(filtered, quoteCache, currentStock);
  }

  $(document).on("click", ".stock-row", function () {
    const idx = parseInt($(this).data("idx"), 10);
    selectByFilteredIndex(idx);
    closeSidebarOnMobile();
  });

  let searchTimer = null;
  $("#searchInput").on("input", function () {
    const q = $(this).val().trim().toUpperCase();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      refreshFilteredList();
    }, 120);
  });

  $("#sortSelect").on("change", function () {
    SETTINGS.sortMode = $(this).val();
    saveSettings();
    resortList();
  });

  $("#filterSelect").on("change", function () {
    SETTINGS.filterMode = $(this).val() || "all";
    saveSettings();
    refreshFilteredList();
  });

  $("#signalSelect").on("change", function () {
    SETTINGS.signalMode = $(this).val() || "all";
    saveSettings();
    refreshFilteredList();
  });

  // Enter: jump to the first match, or — if nothing matches the NSE 500
  // list — fetch whatever was typed directly as a raw ticker symbol.
  $("#searchInput").on("keydown", function (e) {
    if (e.key !== "Enter") return;
    const q = $(this).val().trim().toUpperCase();
    if (!q) return;
    if (filtered.length > 0) {
      selectByFilteredIndex(0);
    } else {
      loadCustomSymbol(q);
    }
  });

  // The editorial "+" shown only when the typed symbol isn't in the list:
  // clicking it adds the query as a raw ticker and loads its charts + analysis.
  $("#addSymbolBtn").on("click", function () {
    const q = $("#searchInput").val().trim().toUpperCase();
    if (!q) return;
    loadCustomSymbol(q);
    $(this).removeClass("visible");
  });

  /* ---------------------------------------------------------
     4. Selecting a symbol (click, next/prev, keyboard, pinned/custom)
     --------------------------------------------------------- */

  function selectByFilteredIndex(idx) {
    if (idx < 0 || idx >= filtered.length) return;
    activeIndex = idx;
    const stock = filtered[idx];
    setAnalysisView(false);
    highlightActiveRow();
    loadSymbol(stock);
    updateNavButtons();
  }

  function selectNifty() {
    activeIndex = -1;
    $(".stock-row, .pinned-row").removeClass("active");
    $("#pinnedNifty").addClass("active");
    setAnalysisView(false);
    loadSymbol(NIFTY_STOCK);
    updateNavButtons();
  }

  function loadCustomSymbol(q) {
    if (INVALID_SYMBOLS.has(String(q || "").trim().toUpperCase())) return;
    activeIndex = -1;
    $(".stock-row, .pinned-row").removeClass("active");
    setAnalysisView(false);
    loadSymbol({ s: q, n: q, i: "Custom" });
    updateNavButtons();
  }

  $("#pinnedNifty").on("click", function () {
    selectNifty();
    closeSidebarOnMobile();
  });

  function highlightActiveRow() {
    $(".stock-row, .pinned-row").removeClass("active");
    if (activeIndex >= 0 && filtered[activeIndex]) {
      const $row = $(`.stock-row[data-sym="${filtered[activeIndex].s}"]`);
      $row.addClass("active");
      if ($row.length) {
        const $list = $("#stockList");
        const rowTop = $row.position().top + $list.scrollTop();
        const rowBottom = rowTop + $row.outerHeight();
        if (rowTop < $list.scrollTop() || rowBottom > $list.scrollTop() + $list.height()) {
          $list.scrollTop(rowTop - 40);
        }
      }
    }
  }

  function updateNavButtons() {
    $("#prevBtn").prop("disabled", activeIndex <= 0);
    $("#nextBtn").prop("disabled", activeIndex < 0 || activeIndex >= filtered.length - 1);
  }

  $("#nextBtn").on("click", () => selectByFilteredIndex(activeIndex + 1));
  $("#prevBtn").on("click", () => selectByFilteredIndex(activeIndex - 1));

  $(document).on("keydown", function (e) {
    if ($(e.target).is("input, textarea, select")) return;
    if (e.key === "ArrowDown") { e.preventDefault(); selectByFilteredIndex(activeIndex + 1 < 0 ? 0 : activeIndex + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); selectByFilteredIndex(activeIndex - 1); }
  });

  function restoreSavedSelection() {
    const saved = SETTINGS.lastSelectedSymbol;
    if (!saved || !saved.s) {
      if (SETTINGS.autoLoadNifty) selectNifty();
      return;
    }

    const savedSym = String(saved.s).toUpperCase();
    const match = STOCKS.find((stock) => String(stock.s).toUpperCase() === savedSym);
    if (match) {
      activeIndex = filtered.findIndex((stock) => String(stock.s).toUpperCase() === savedSym);
      loadSymbol(match);
      highlightActiveRow();
      updateNavButtons();
      return;
    }

    if (saved.s === "^NSEI" || saved.s === "NSEI") {
      selectNifty();
      return;
    }

    loadSymbol({ s: saved.s, n: saved.n || saved.s, i: saved.i || "Custom" });
    highlightActiveRow();
    updateNavButtons();
  }

  function rememberSelectedSymbol(stock) {
    if (!SETTINGS.rememberSelectedSymbol || !stock) return;
    SETTINGS.lastSelectedSymbol = { s: stock.s, n: stock.n, i: stock.i || "" };
    saveSettings();
  }

  $("#gridWrap").on("wheel", function (e) {
    if (!e.shiftKey) return;
    e.preventDefault();
    if (e.originalEvent.deltaY > 0) selectByFilteredIndex(activeIndex + 1 < 0 ? 0 : activeIndex + 1);
    else selectByFilteredIndex(activeIndex - 1);
  });

  $("#refreshBtn").on("click", function () {
    resetChartLayout();
    if (currentStock) {
      setSyncStatus(currentStock.s, "pending");
      syncSymbols([currentStock]).then(() => loadSymbol(currentStock));
    }
  });

  $("#chartColumnsSelect").on("change", function () {
    SETTINGS.chartColumns = parseInt($(this).val(), 10) || 0;
    saveSettings();
    updateGridLayout();
  });

  $("#syncNowBtn").on("click", function () { syncSymbols(STOCKS); });
  $("#syncPendingBtn").on("click", function () { syncPendingSymbols(STOCKS); });
  $("#stopSyncBtn").on("click", function () {
    if (!syncInProgress) return;
    syncStopRequested = true;
    syncAbortControllers.forEach((controller) => controller.abort());
  });

  /* ---------------------------------------------------------
     5. Chart panel scaffolding (built once)
     --------------------------------------------------------- */

  function buildChartPanels() {
    const $grid = $("#chartGrid");
    TIMEFRAMES.forEach((tf) => {
      const panel = $(
        `<div class="chart-panel" data-tf="${tf.key}">` +
        `<div class="panel-head">` +
        `<div class="panel-head-left">` +
        `<span class="tf-chip ${tf.key}">${tf.key}</span>` +
        `<span class="panel-label">${tf.label}</span>` +
        `</div>` +
        `<div class="prediction-levels" aria-label="Entry, target, and stop-loss levels"></div>` +
        `</div>` +
        `<div class="chart-area">` +
        `<div class="chart-chip chip-price" id="chip-price-${tf.key}"></div>` +
        `<div class="chart-chip chip-rsi" id="chip-rsi-${tf.key}"></div>` +
        `<div class="chart-chip chip-macd" id="chip-macd-${tf.key}"></div>` +
        `<div class="chart-canvas-host" id="host-${tf.key}"></div>` +
        `<div class="chart-tooltip" id="tooltip-${tf.key}"></div>` +
        `<div class="panel-state" id="state-${tf.key}">` +
        `<div class="spinner"></div><span>Select a symbol</span>` +
        `</div>` +
        `</div>` +
        `</div>`
      );
      $grid.append(panel);

      const host = document.getElementById(`host-${tf.key}`);
      const levelsHost = panel[0].querySelector(".prediction-levels");
      const chart = LightweightCharts.createChart(host, chartOptions());

      const series = chart.addCandlestickSeries(candleColors());

      const volSeries = chart.addHistogramSeries({
        priceFormat: { type: "volume" },
        priceScaleId: "" // implicit overlay scale, no visible axis
      });

      const smaSeries = chart.addLineSeries({
        color: cssVar("--sma"), lineWidth: 1,
        priceLineVisible: false, lastValueVisible: false
      });

      const stSeries = chart.addLineSeries({
        color: cssVar("--candle-up"), lineWidth: 2,
        priceLineVisible: false, lastValueVisible: false
      });

      const rsiSeries = chart.addLineSeries({
        color: cssVar("--rsi-line"), lineWidth: 2,
        priceScaleId: "rsi",
        priceLineVisible: false, lastValueVisible: false
      });
      rsiSeries.createPriceLine({ price: 70, color: cssVar("--text-faint"), lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: false, title: "" });
      rsiSeries.createPriceLine({ price: 30, color: cssVar("--text-faint"), lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: false, title: "" });

      const macdHist = chart.addHistogramSeries({ priceScaleId: "macd", priceFormat: { type: "price", precision: 2, minMove: 0.01 } });
      const macdLine = chart.addLineSeries({
        color: cssVar("--macd-line"), lineWidth: 2, priceScaleId: "macd",
        priceLineVisible: false, lastValueVisible: false
      });
      const macdSignal = chart.addLineSeries({
        color: cssVar("--macd-signal"), lineWidth: 2, priceScaleId: "macd",
        priceLineVisible: false, lastValueVisible: false
      });

      charts[tf.key] = { chart, series, volSeries, smaSeries, stSeries, rsiSeries, macdLine, macdSignal, macdHist, host, levelsHost, levelPrices: [] };
      series.applyOptions({
        autoscaleInfoProvider: (originalProvider) => {
          const info = originalProvider();
          const prices = charts[tf.key].levelPrices.filter(Number.isFinite);
          if (!info || !prices.length) return info;
          info.priceRange.minValue = Math.min(info.priceRange.minValue, ...prices);
          info.priceRange.maxValue = Math.max(info.priceRange.maxValue, ...prices);
          return info;
        }
      });
      applyPaneLayout(tf.key);
      setPanelVisible(tf.key, SETTINGS.visible[tf.key]);
      bindCrosshairTooltip(tf.key, host, chart, series);
    });

    applyAxisMode();
    applyStoredLayoutState();

    resizeObserver = new ResizeObserver(() => {
      TIMEFRAMES.forEach((tf) => {
        const h = document.getElementById(`host-${tf.key}`);
        const c = charts[tf.key];
        if (h && c && h.clientWidth > 0) {
          c.chart.applyOptions({ width: h.clientWidth, height: h.clientHeight });
          if (window.CandlePatternDetector) CandlePatternDetector.redraw(tf.key);
        }
      });
    });
    TIMEFRAMES.forEach((tf) => resizeObserver.observe(document.getElementById(`host-${tf.key}`)));
  }

  function cssVar(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback || "";
  }

  // Hover tooltip: shows OHLC + SMA5 for whatever bar the crosshair is over,
  // positioned near the cursor and clamped inside the chart area.
  function bindCrosshairTooltip(tfKey, host, chart, series) {
    const $tip = $(`#tooltip-${tfKey}`);
    chart.subscribeCrosshairMove((param) => {
      if (!param.point || !param.time || param.point.x < 0 || param.point.y < 0 || !param.seriesData) {
        $tip.hide();
        return;
      }
      const ohlc = param.seriesData.get(series);
      if (!ohlc) { $tip.hide(); return; }

      // In the "current price = 0%" mode the series data is % deviations, so
      // restore the raw prices for display (layout/shape is unaffected).
      const st = charts[tfKey] && charts[tfKey].pctTx;
      const rO = st ? st.C + ohlc.open / st.k : ohlc.open;
      const rH = st ? st.C + ohlc.high / st.k : ohlc.high;
      const rL = st ? st.C + ohlc.low / st.k : ohlc.low;
      const rC = st ? st.C + ohlc.close / st.k : ohlc.close;

      let html = `O <b>${fmt(rO)}</b> H <b>${fmt(rH)}</b> L <b>${fmt(rL)}</b> C <b>${fmt(rC)}</b>`;
      if (rO != null && rC != null && rO !== 0) {
        const pct = ((rC - rO) / rO) * 100;
        const cls = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
        html += `<br><span class="change-pct ${cls}">Δ ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%</span>`;
      }
      if (window.CandlePatternDetector) {
        const pattern = CandlePatternDetector.getNameAt(tfKey, param.time);
        if (pattern) html += `<br><span class="pattern-badge ${pattern.dir}">${pattern.name}</span>`;
      }
      $tip.html(html).show();

      const w = host.clientWidth, h = host.clientHeight;
      const tipW = $tip.outerWidth(), tipH = $tip.outerHeight();
      let left = param.point.x + 14;
      let top = param.point.y + 14;
      if (left + tipW > w) left = param.point.x - tipW - 14;
      if (top + tipH > h) top = param.point.y - tipH - 14;
      $tip.css({ left: Math.max(2, left) + "px", top: Math.max(2, top) + "px" });
    });
  }

function candleColors() {
    const up = cssVar("--candle-up") || cssVar("--up", "#0EB07C");
    const down = cssVar("--candle-down") || cssVar("--down", "#F0434E");
    return {
      upColor: up, downColor: down,
      borderUpColor: up, borderDownColor: down,
      wickUpColor: up, wickDownColor: down,
      priceFormat: candleSeriesFormat()
    };
  }

  function axisDecimals() {
    return Math.max(0, Math.min(4, parseInt(SETTINGS.priceDecimals, 10) || 0));
  }

  // When "% Change" axis is anchored at the current price (percentBase =
  // "current"), the price-pane data is fed to Lightweight Charts as literal
  // % deviations from the last close ((price - close) / close * 100) on a
  // NORMAL scale — LC only knows how to compute percentages relative to a
  // series' FIRST value, so this linear transform is the only way to put 0%
  // on the last candle.
  function percentTxActive() {
    return SETTINGS.axisMode === "percent" && SETTINGS.percentBase === "current";
  }

  // Right-axis format: "% change" by default (configurable to raw price).
  function candleSeriesFormat() {
    return SETTINGS.axisMode === "price"
      ? priceFormatForDecimals(SETTINGS.priceDecimals)
      : { type: "percent", precision: 2, minMove: 0.01 };
  }

  function applyAxisMode() {
    const d = axisDecimals();
    const tx = percentTxActive();
    TIMEFRAMES.forEach((tf) => {
      const c = charts[tf.key];
      if (!c) return;
      const mode = SETTINGS.axisMode === "price" || tx
        ? LightweightCharts.PriceScaleMode.Normal
        : LightweightCharts.PriceScaleMode.Percentage;
      // v4.1.3 reads priceScale.%_options — localization.percentageFormatter /
      // localization.priceFormatter are read live on every format call, so this
      // makes the axis honor the decimals setting (the built-in % formatter is
      // fixed at 2dp). In the transform mode the data is already % deviations,
      // so the NORMAL scale's tick formatter appends the '%' instead.
      c.series.applyOptions({
        priceFormat: tx || SETTINGS.axisMode === "price"
          ? priceFormatForDecimals(SETTINGS.priceDecimals)
          : candleSeriesFormat()
      });
      c.chart.applyOptions({
        localization: tx
          ? { priceFormatter: (v) => `${v.toFixed(d)}%` }
          : { percentageFormatter: (v) => `${v.toFixed(d)}%` }
      });
      c.series.priceScale().applyOptions({ mode });
    });
  }

  function priceFormatForDecimals(n) {
    const precision = Math.max(0, Math.min(4, parseInt(n, 10) || 0));
    return { type: "price", precision, minMove: 1 / Math.pow(10, precision) };
  }

  function chartOptions() {
    const border = cssVar("--border");
    const isMobile = window.innerWidth <= 760;
    return {
      layout: {
        background: { type: "solid", color: cssVar("--panel") },
        textColor: cssVar("--text-dim"),
        fontFamily: "IBM Plex Mono, monospace",
        fontSize: isMobile ? 8 : 9
      },
      grid: { vertLines: { color: border, visible: false }, horzLines: { color: border, visible: false } },
      rightPriceScale: { borderColor: border, scaleMargins: { top: 0.05, bottom: 0.05 } },
      leftPriceScale: { visible: false },
      timeScale: {
        borderColor: border,
        timeVisible: true,
        secondsVisible: false,
        barSpacing: 4,
        tickMarkPadding: 2,
        tickMarkFormatter: (time) => { if (!time) return ""; const d = new Date(time * 1000); return isMobile ? `${d.getMonth() + 1}/${d.getDate()}` : d.toLocaleDateString(); }
      },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      autoSize: false,
      handleScroll: true,
      handleScale: true
    };
  }

  // RSI/MACD live inside the same chart as extra price scales, stacked
  // into vertical bands via scaleMargins — this avoids needing separate
  // chart instances (and the time-scale syncing that would require).
  function computeLayout(rsiOn, macdOn) {
    if (rsiOn && macdOn) {
      return {
        price: { top: 0.03, bottom: 0.55 },
        vol:   { top: 0.47, bottom: 0.45 },
        rsi:   { top: 0.58, bottom: 0.22 },
        macd:  { top: 0.80, bottom: 0.0 }
      };
    }
    if (rsiOn && !macdOn) {
      return {
        price: { top: 0.03, bottom: 0.42 },
        vol:   { top: 0.60, bottom: 0.32 },
        rsi:   { top: 0.70, bottom: 0.0 },
        macd:  { top: 1, bottom: 0 }
      };
    }
    if (!rsiOn && macdOn) {
      return {
        price: { top: 0.03, bottom: 0.42 },
        vol:   { top: 0.60, bottom: 0.32 },
        rsi:   { top: 1, bottom: 0 },
        macd:  { top: 0.70, bottom: 0.0 }
      };
    }
    return {
      price: { top: 0.05, bottom: 0.22 },
      vol:   { top: 0.82, bottom: 0.0 },
      rsi:   { top: 1, bottom: 0 },
      macd:  { top: 1, bottom: 0 }
    };
  }

  function applyPaneLayout(tfKey) {
    const c = charts[tfKey];
    const layout = computeLayout(SETTINGS.rsiEnabled, SETTINGS.macdEnabled);
    c.series.priceScale().applyOptions({ scaleMargins: layout.price });
    c.volSeries.priceScale().applyOptions({ scaleMargins: layout.vol });
    c.rsiSeries.priceScale().applyOptions({ scaleMargins: layout.rsi });
    c.macdLine.priceScale().applyOptions({ scaleMargins: layout.macd });
    c.rsiSeries.applyOptions({ visible: SETTINGS.rsiEnabled });
    [c.macdLine, c.macdSignal, c.macdHist].forEach((s) => s.applyOptions({ visible: SETTINGS.macdEnabled }));

    // Top-left value chips ride along with each pane's vertical band so they
    // keep lining up with the price, RSI, and MACD plots regardless of layout.
    const chip = (id, m) => $(`#${id}-${tfKey}`).css("top", `${Math.round(m.top * 100)}%`);
    chip("chip-price", layout.price);
    chip("chip-rsi", layout.rsi);
    chip("chip-macd", layout.macd);
  }

  function setPanelState(tfKey, mode, message) {
    const $state = $(`#state-${tfKey}`);
    if (mode === "hidden") { $state.addClass("hidden"); return; }
    $state.removeClass("hidden err");
    if (mode === "loading") {
      $state.html(`<div class="spinner"></div><span>${message || "Loading…"}</span>`);
    } else if (mode === "error") {
      $state.addClass("err").html(
        `<span>⚠ ${message || "Failed to load"}</span>` +
        `<button class="retry" data-tf="${tfKey}">Retry</button>`
      );
    } else if (mode === "empty") {
      $state.html(`<span>${message || "No data"}</span>`);
    }
  }

  $(document).on("click", ".retry", function () {
    const tfKey = $(this).data("tf");
    if (currentStock) loadTimeframe(currentStock, tfKey);
  });

  /* ---------------------------------------------------------
     6. Panel visibility (show/hide charts) + grid layout
     --------------------------------------------------------- */

  function setPanelVisible(tfKey, visible) {
    $(`.chart-panel[data-tf="${tfKey}"]`).toggleClass("hidden-panel", !visible);
    if (visible) {
      requestAnimationFrame(() => {
        const h = document.getElementById(`host-${tfKey}`);
        const c = charts[tfKey];
        if (h && c && h.clientWidth > 0) {
          c.chart.applyOptions({ width: h.clientWidth, height: h.clientHeight });
          c.chart.timeScale().fitContent();
        }
      });
    }
  }

  function updateGridLayout() {
    const visibleCount = TIMEFRAMES.filter((tf) => SETTINGS.visible[tf.key]).length || 1;
    const chosen = SETTINGS.chartColumns || 0;
    const cols = chosen > 0 ? Math.min(chosen, visibleCount) : visibleCount <= 1 ? 1 : 2;
    const rows = Math.ceil(visibleCount / cols);
    const gridStyle = $("#chartGrid")[0].style;
    if (chosen > 0) {
      // Forced layout must beat the responsive single-column media query.
      gridStyle.setProperty("grid-template-columns", `repeat(${cols}, 1fr)`, "important");
      gridStyle.setProperty("grid-template-rows", `repeat(${rows}, 1fr)`, "important");
    } else {
      gridStyle.removeProperty("grid-template-columns");
      gridStyle.removeProperty("grid-template-rows");
      $("#chartGrid").css({
        "grid-template-columns": `repeat(${cols}, 1fr)`,
        "grid-template-rows": `repeat(${rows}, 1fr)`
      });
    }
  }

  /* ---------------------------------------------------------
     7. Settings
     --------------------------------------------------------- */

  function loadSettings() {
    let saved = null;
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      saved = raw ? JSON.parse(raw) : null;
    } catch (e) { saved = null; }
    const merged = Object.assign({}, DEFAULT_SETTINGS, saved || {});
    merged.visible = Object.assign({}, DEFAULT_SETTINGS.visible, (saved && saved.visible) || {});
    return merged;
  }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(SETTINGS)); }
    catch (e) { /* privacy mode / storage disabled — settings still work for this session */ }
  }

  function bindSettingsUI() {
    setSegActive("#themeSeg", SETTINGS.theme);
    setSegActive("#densitySeg", SETTINGS.density);
    setSegActive("#axisModeSeg", SETTINGS.axisMode);
    $("#barCountInput").val(SETTINGS.barCount);
    $("#analysisPointsInput").val(SETTINGS.analysisPoints);
    $("#rememberSymbolToggle").prop("checked", !!SETTINGS.rememberSelectedSymbol);
    $("#decimalsSelect").val(String(SETTINGS.priceDecimals));
    $("#percentBaseSelect").val(SETTINGS.percentBase);
    $("#smaToggle").prop("checked", SETTINGS.smaEnabled);
    $("#supertrendToggle").prop("checked", SETTINGS.supertrendEnabled);
    $("#supertrendPeriodInput").val(SETTINGS.supertrendPeriod);
    $("#rsiToggle").prop("checked", SETTINGS.rsiEnabled);
    $("#macdToggle").prop("checked", SETTINGS.macdEnabled);
    $("#patternsToggle").prop("checked", SETTINGS.patternsEnabled);
    $("#niftyToggle").prop("checked", SETTINGS.autoLoadNifty);
    $("#proxyToggle").prop("checked", SETTINGS.useProxy);
    TIMEFRAMES.forEach((tf) => {
      $(`.panel-toggle[data-tf="${tf.key}"]`).prop("checked", !!SETTINGS.visible[tf.key]);
    });

    buildSourcePicker();

    $("#settingsBtn").on("click", () => $("#settingsScrim").addClass("show"));
    $("#settingsClose").on("click", () => $("#settingsScrim").removeClass("show"));
    $("#settingsScrim").on("click", function (e) {
      if (e.target.id === "settingsScrim") $(this).removeClass("show");
    });

    $("#themeSeg button").on("click", function () {
      const val = $(this).data("val");
      setSegActive("#themeSeg", val);
      SETTINGS.theme = val;
      saveSettings();
      applyTheme(val);
    });

    $("#densitySeg button").on("click", function () {
      const val = $(this).data("val");
      setSegActive("#densitySeg", val);
      SETTINGS.density = val;
      saveSettings();
      applyDensity(val);
    });

    let barTimer = null;
    $("#barCountInput").on("input", function () {
      clearTimeout(barTimer);
      barTimer = setTimeout(() => {
        let n = parseInt($("#barCountInput").val(), 10);
        if (isNaN(n) || n < 10) n = 10;
        if (n > 5000) n = 5000;
        SETTINGS.barCount = n;
        saveSettings();
        applyBarCountChange();
      }, 350);
    });

    let analysisTimer = null;
    $("#analysisPointsInput").on("input", function () {
      clearTimeout(analysisTimer);
      analysisTimer = setTimeout(() => {
        let n = parseInt($("#analysisPointsInput").val(), 10);
        if (isNaN(n) || n < 20) n = 20;
        if (n > 5000) n = 5000;
        SETTINGS.analysisPoints = n;
        saveSettings();
        applyBarCountChange();
      }, 350);
    });

    $("#axisModeSeg button").on("click", function () {
      const val = $(this).data("val");
      setSegActive("#axisModeSeg", val);
      SETTINGS.axisMode = val;
      saveSettings();
      applyAxisMode();
      rerenderAllFromCache(); // the "current" base feeds transformed data
    });

    $("#percentBaseSelect").on("change", function () {
      SETTINGS.percentBase = $(this).val() === "first" ? "first" : "current";
      saveSettings();
      applyAxisMode();
      rerenderAllFromCache();
    });

    $("#decimalsSelect").on("change", function () {
      SETTINGS.priceDecimals = parseInt($(this).val(), 10) || 0;
      saveSettings();
      applyAxisMode();
    });

    $("#smaToggle").on("change", function () {
      SETTINGS.smaEnabled = $(this).is(":checked");
      saveSettings();
      TIMEFRAMES.forEach((tf) => charts[tf.key].smaSeries.applyOptions({ visible: SETTINGS.smaEnabled }));
    });

    $("#supertrendToggle").on("change", function () {
      SETTINGS.supertrendEnabled = $(this).is(":checked");
      saveSettings();
      rerenderAllFromCache();
    });

    let stPeriodTimer = null;
    $("#supertrendPeriodInput").on("input", function () {
      clearTimeout(stPeriodTimer);
      stPeriodTimer = setTimeout(() => {
        let p = parseInt($(this).val(), 10);
        if (isNaN(p) || p < 1) p = 1;
        if (p > 50) p = 50;
        SETTINGS.supertrendPeriod = p;
        saveSettings();
        rerenderAllFromCache();
      }, 300);
    });

    $("#rsiToggle").on("change", function () {
      SETTINGS.rsiEnabled = $(this).is(":checked");
      saveSettings();
      applyStoredLayoutState();
      rerenderAllFromCache();
    });

    $("#macdToggle").on("change", function () {
      SETTINGS.macdEnabled = $(this).is(":checked");
      saveSettings();
      applyStoredLayoutState();
      rerenderAllFromCache();
    });

    $("#patternsToggle").on("change", function () {
      SETTINGS.patternsEnabled = $(this).is(":checked");
      saveSettings();
      rerenderAllFromCache();
    });

    $("#niftyToggle").on("change", function () {
      SETTINGS.autoLoadNifty = $(this).is(":checked");
      saveSettings();
    });

    $("#rememberSymbolToggle").on("change", function () {
      SETTINGS.rememberSelectedSymbol = $(this).is(":checked");
      if (!SETTINGS.rememberSelectedSymbol) {
        SETTINGS.lastSelectedSymbol = null;
      }
      saveSettings();
    });

    $("#proxyToggle").on("change", function () {
      SETTINGS.useProxy = $(this).is(":checked");
      saveSettings();
      // Cached data doesn't need to change, but any in-flight requests were
      // started under the old mode — cleanest to just re-fetch fresh.
      if (currentStock) loadSymbol(currentStock);
    });

    $(".panel-toggle").on("change", function () {
      const tfKey = $(this).data("tf");
      const checked = $(this).is(":checked");
      const stillVisible = TIMEFRAMES.filter((tf) => (tf.key === tfKey ? checked : SETTINGS.visible[tf.key]));
      if (!checked && stillVisible.length === 0) {
        $(this).prop("checked", true); // keep at least one panel visible
        return;
      }
      SETTINGS.visible[tfKey] = checked;
      saveSettings();
      applyStoredLayoutState();

      // Panel just got shown — if it was skipped while hidden (no cached
      // data yet), fetch it now for whatever symbol is currently loaded.
      // If it already has cached data, just redraw instead of re-fetching.
      if (checked && currentStock) {
        if (candleCache[tfKey]) renderChartData(tfKey);
        else loadTimeframe(currentStock, tfKey);
      }
    });
  }

  function applyStoredLayoutState() {
    TIMEFRAMES.forEach((tf) => {
      setPanelVisible(tf.key, !!SETTINGS.visible[tf.key]);
      applyPaneLayout(tf.key);
    });
    updateGridLayout();
  }

  function setSegActive(containerSel, val) {
    $(`${containerSel} button`).removeClass("active");
    $(`${containerSel} button[data-val="${val}"]`).addClass("active");
  }

  // Renders one button per entry in DataSources.list(). Unavailable
  // sources (e.g. Google Finance) still show up — disabled, with a title
  // tooltip explaining why — rather than being silently hidden, so the
  // picker is honest about what actually works instead of pretending
  // there's no other option.
  function buildSourcePicker() {
    const sources = DataSources.list();
    if (sources.length <= 1) {
      $("#dataSourceSection").hide(); // nothing to actually choose between right now
      return;
    }
    const $seg = $("#sourceSeg").empty();
    sources.forEach((src) => {
      const $btn = $("<button>")
        .attr("data-val", src.id)
        .text(src.label)
        .prop("disabled", !src.available);
      if (!src.available) $btn.attr("title", src.unavailableReason || "Not available");
      $seg.append($btn);
    });
    setSegActive("#sourceSeg", SETTINGS.dataSource);

    $seg.find("button:not(:disabled)").on("click", function () {
      const val = $(this).data("val");
      setSegActive("#sourceSeg", val);
      SETTINGS.dataSource = val;
      saveSettings();
      // Cached data came from whichever source was active before — safest
      // to drop it and re-fetch fresh under the newly selected source.
      Object.keys(candleCache).forEach((k) => delete candleCache[k]);
      Object.keys(candleCacheRange).forEach((k) => delete candleCacheRange[k]);
      if (currentStock) loadSymbol(currentStock);
    });
  }

  function applyTheme(theme) {
    if (theme === "dark") document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");

    TIMEFRAMES.forEach((tf) => {
      const c = charts[tf.key];
      if (!c) return;
      c.chart.applyOptions(chartOptions());
      c.series.applyOptions(candleColors());
      c.smaSeries.applyOptions({ color: cssVar("--sma") });
      c.stSeries.applyOptions({ color: cssVar("--candle-up") });
      c.rsiSeries.applyOptions({ color: cssVar("--rsi-line") });
      c.macdLine.applyOptions({ color: cssVar("--macd-line") });
      c.macdSignal.applyOptions({ color: cssVar("--macd-signal") });
    });
    applyAxisMode();
    rerenderAllFromCache();
  }

  function applyDensity(density) {
    if (density === "spacious") document.documentElement.setAttribute("data-density", "spacious");
    else document.documentElement.removeAttribute("data-density");
    requestAnimationFrame(() => {
      TIMEFRAMES.forEach((tf) => {
        const h = document.getElementById(`host-${tf.key}`);
        const c = charts[tf.key];
        if (h && c && h.clientWidth > 0) c.chart.applyOptions({ width: h.clientWidth, height: h.clientHeight });
      });
    });
  }

  /* ---------------------------------------------------------
     8. Loading a symbol into all four charts
     --------------------------------------------------------- */

  function resetChartLayout() {
    TIMEFRAMES.forEach((tf) => {
      SETTINGS.visible[tf.key] = !!DEFAULT_SETTINGS.visible[tf.key];
      $(`.panel-toggle[data-tf="${tf.key}"]`).prop("checked", SETTINGS.visible[tf.key]);
      setPanelVisible(tf.key, SETTINGS.visible[tf.key]);
    });
    updateGridLayout();
    saveSettings();
  }

  function loadSymbol(stock) {
    currentStock = stock;
    rememberSelectedSymbol(stock);
    $("#placeholder").hide();
    $("#topbarInfo").show();
    $(".big-sym .symtext").text(stock.s.replace(/^\^/, ""));
    $(".sector-name").text(stock.i || "—");
    $(".company-name").text(stock.n);
    $(".company-meta").text(stock.i ? `Sector • ${stock.i}` : "—");
    $("#priceBlock").html("");
    Object.keys(candleCache).forEach((k) => delete candleCache[k]);
    Object.keys(candleCacheRange).forEach((k) => delete candleCacheRange[k]);

    if (getSyncStatus(stock.s) === "not-found") {
      TIMEFRAMES.forEach((tf) => {
        if (SETTINGS.visible[tf.key]) setPanelState(tf.key, "empty", "Symbol not found");
      });
      return;
    }

    // Hidden panels (unchecked in Settings) are skipped entirely — no fetch
    // is sent for a chart the user can't currently see. If it's shown again
    // later, the panel-toggle handler fetches it on demand at that point.
    TIMEFRAMES.forEach((tf) => {
      if (SETTINGS.visible[tf.key]) loadTimeframe(stock, tf.key);
    });
  }

  function buildSymbolCandidates(stock, source) {
    if (source && typeof source.resolveSymbolCandidates === "function") {
      return source.resolveSymbolCandidates(stock);
    }
    const raw = String(stock && (stock.s || stock) ? (stock.s || stock) : "").trim();
    if (!raw) return [];
    if (raw.startsWith("^") || raw.includes(".") || raw.includes(":")) return [raw];
    return [source.resolveSymbol(stock), raw].filter(Boolean);
  }

  async function loadTimeframe(stock, tfKey) {
    const tf = TIMEFRAMES.find((t) => t.key === tfKey);
    setPanelState(tfKey, "loading", `Fetching ${tf.label.toLowerCase()}…`);

    // Cancel whatever was still in flight for this panel — otherwise rapid
    // symbol switching (next/prev, arrow keys, Shift+scroll) piles up
    // requests on the free proxies and everything slows down together.
    if (activeFetches[tfKey]) {
      activeFetches[tfKey].controllers.forEach((c) => c.abort());
    }

    const source = DataSources.get(SETTINGS.dataSource);
    const interval = source.mapInterval(tfKey);
    const range = source.mapRange(tfKey, historyPointsNeeded());
    const candidates = buildSymbolCandidates(stock, source);

    let lastErr = null;
    for (const symbol of candidates) {
      const proxyUrl = `${CONTROLLER_PROXY}?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;
      const { promise, controllers } = fetchWithControllerProxy(proxyUrl);
      activeFetches[tfKey] = { controllers };

      try {
        const json = await promise;
        if (activeFetches[tfKey] && activeFetches[tfKey].controllers !== controllers) return; // superseded
        const candles = source.parseCandles(json);
        if (!candles.length) {
          lastErr = new Error(extractYahooError(json) || "No candles returned");
          continue;
        }
        candleCache[tfKey] = candles;
        candleCacheRange[tfKey] = range;
        candleMetaCache[tfKey] = extractMeta(json);
        renderChartData(tfKey);
        return;
      } catch (err) {
        if (activeFetches[tfKey] && activeFetches[tfKey].controllers !== controllers) return; // superseded, ignore
        if (err && err.name === "AbortError") return; // cancelled on purpose, not a real failure
        lastErr = err;
      }
    }

    console.warn(`[${stock.s}/${tfKey}]`, lastErr || new Error("No data"));
    const msg = lastErr && /no data found|not found|delisted/i.test(lastErr.message)
      ? "No Yahoo data available for this symbol"
      : "No data available for this symbol";
    setPanelState(tfKey, "empty", msg);
  }

  // Re-draws a timeframe's chart from candleCache using current settings —
  // no network call needed. Indicators are computed on the FULL cached
  // history first, then windowed to the visible bar range, so they're
  // already "warmed up" instead of showing blank for their lead-in period.
  function renderChartData(tfKey) {
    const full = candleCache[tfKey];
    if (!full || !full.length) return;

    const n = SETTINGS.barCount > 0 ? SETTINGS.barCount : full.length;
    const bars = full.slice(-n);
    if (!bars.length) { setPanelState(tfKey, "empty", "No candles in range"); return; }

    setPanelState(tfKey, "hidden");
    const c = charts[tfKey];
    const windowStart = bars[0].time;

    // When the % axis is anchored at the current price, map every raw price-pane
    // value to its % deviation from the last close ahead of setData(). Overlay
    // (volume) and sub-panels (RSI/MACD) keep their own scales and stay raw.
    const lastFull = full[full.length - 1];
    const tx = percentTxActive() && lastFull && lastFull.close
      ? { C: lastFull.close, k: 100 / lastFull.close }
      : null;
    c.pctTx = tx;
    const X = tx ? (v) => (v - tx.C) * tx.k : (v) => v;

    c.series.setData(bars.map((b) => ({
      time: b.time,
      open: X(b.open), high: X(b.high), low: X(b.low), close: X(b.close)
    })));

    const volUp = cssVar("--vol-up"), volDown = cssVar("--vol-down");
    c.volSeries.setData(
      bars.map((b) => ({ time: b.time, value: b.volume || 0, color: b.close >= b.open ? volUp : volDown }))
    );

    const smaWin = sliceToWindow(computeSMA(full, SMA_PERIOD), windowStart)
      .map((p) => ({ time: p.time, value: X(p.value) }));
    c.smaSeries.setData(smaWin);

    if (SETTINGS.supertrendEnabled) {
      const stWin = sliceToWindow(computeSuperTrend(full, SETTINGS.supertrendPeriod, SUPER_TREND_MULTIPLIER), windowStart)
        .map((p) => ({ time: p.time, value: X(p.value), color: p.color }));
      c.stSeries.setData(stWin);
    } else {
      c.stSeries.setData([]);
    }

    let rsiWin = [];
    if (SETTINGS.rsiEnabled) {
      rsiWin = sliceToWindow(computeRSI(full, RSI_PERIOD), windowStart);
      c.rsiSeries.setData(rsiWin);
    } else {
      c.rsiSeries.setData([]);
    }

    let macdWin = [], sigWin = [], histWin = [];
    if (SETTINGS.macdEnabled) {
      const macdRes = computeMACD(full, MACD_FAST, MACD_SLOW, MACD_SIGNAL);
      macdWin = sliceToWindow(macdRes.macd, windowStart);
      sigWin = sliceToWindow(macdRes.signal, windowStart);
      histWin = sliceToWindow(macdRes.hist, windowStart);
      const up = cssVar("--up"), down = cssVar("--down");
      c.macdLine.setData(macdWin);
      c.macdSignal.setData(sigWin);
      c.macdHist.setData(histWin.map((p) => ({ time: p.time, value: p.value, color: p.value >= 0 ? up : down })));
    } else {
      c.macdLine.setData([]); c.macdSignal.setData([]); c.macdHist.setData([]);
    }

    c.chart.timeScale().fitContent();

    if (window.CandlePatternDetector) {
      CandlePatternDetector.render(
        tfKey,
        c.chart,
        c.series,
        c.host,
        SETTINGS.patternsEnabled ? CandlePatternDetector.detect(bars) : []
      );
    }

    if (["M", "W", "D"].includes(tfKey) && window.StockPrediction) {
      const analysisDepth = Number(SETTINGS.analysisPoints) || 0;
      const analysisWin = analysisDepth > 0 ? full.slice(-analysisDepth) : full;
      StockPrediction.update(currentStock, analysisWin, c, tfKey, filtered, quoteCache);
    }

    const last = bars[bars.length - 1];
    const prev = bars.length > 1 ? bars[bars.length - 2] : last;
    const change = last.close - prev.close;
    const pct = prev.close ? (change / prev.close) * 100 : 0;
    const dir = change > 0 ? "up" : change < 0 ? "down" : "flat";
    const changeText = fmtPercent(pct);
    $(`#chip-price-${tfKey}`).html(
      `<b>${fmt(last.close)}</b> <span class="chip-dir ${dir}">Δ ${changeText}</span>`
    );

    const $chipRsi = $(`#chip-rsi-${tfKey}`);
    if (SETTINGS.rsiEnabled && rsiWin.length) {
      $chipRsi.html(`RSI ${fmt(rsiWin[rsiWin.length - 1].value)}`).css("display", "");
    } else {
      $chipRsi.empty().css("display", "none");
    }

    const $chipMacd = $(`#chip-macd-${tfKey}`);
    if (SETTINGS.macdEnabled && macdWin.length && sigWin.length) {
      $chipMacd.html(`MACD ${fmt(macdWin[macdWin.length - 1].value)}/${fmt(sigWin[sigWin.length - 1].value)}`).css("display", "");
    } else {
      $chipMacd.empty().css("display", "none");
    }

    if (tfKey === "D") updateTopbarPrice(last, prev, candleMetaCache[tfKey]);
  }

  function sliceToWindow(series, startTime) {
    return series.filter((p) => p.time >= startTime);
  }

  function rerenderAllFromCache() {
    TIMEFRAMES.forEach((tf) => { if (candleCache[tf.key]) renderChartData(tf.key); });
  }

  // How much history to pull: enough for both the visible bar window and
  // the analysis depth (win-rate estimation needs more candles than are shown),
  // plus a small warm-up buffer so the SMA5 line starts exactly ON the first
  // visible candle instead of missing its first few bars.
  function historyPointsNeeded() {
    return (Math.max(Number(SETTINGS.barCount) || 0, Number(SETTINGS.analysisPoints) || 0) || 80) + 4;
  }

  // Changing the bar count doesn't always need a re-fetch: if the cached
  // data was already pulled with a wide-enough range, just re-slice it
  // (instant, no network). Only when the new count needs MORE history than
  // what's cached does this go back to the network for that one panel.
  function applyBarCountChange() {
    const source = DataSources.get(SETTINGS.dataSource);
    TIMEFRAMES.forEach((tf) => {
      if (!SETTINGS.visible[tf.key] || !candleCache[tf.key]) return;
      const needed = source.mapRange(tf.key, historyPointsNeeded());
      const have = candleCacheRange[tf.key];
      if (have && source.rangeRank(tf.key, needed) > source.rangeRank(tf.key, have)) {
        if (currentStock) loadTimeframe(currentStock, tf.key);
      } else {
        renderChartData(tf.key);
      }
    });
  }

  /* ---------------------------------------------------------
     Indicator math (pure functions — see conversation for unit tests)
     --------------------------------------------------------- */

  function computeSMA(bars, period) {
    if (bars.length < period) return [];
    const out = [];
    let sum = 0;
    for (let i = 0; i < bars.length; i++) {
      sum += bars[i].close;
      if (i >= period) sum -= bars[i - period].close;
      if (i >= period - 1) out.push({ time: bars[i].time, value: sum / period });
    }
    return out;
  }

  // Wilder-smoothed ATR — TR series first, then the same running average
  // scheme used for RSI. atr[i] holds the raw TR before smoothing starts.
  function computeATR(bars, period) {
    const n = bars.length;
    const tr = new Array(n).fill(0);
    if (!n) return tr;
    tr[0] = bars[0].high - bars[0].low;
    for (let i = 1; i < n; i++) {
      const b = bars[i];
      const prevClose = bars[i - 1].close;
      tr[i] = Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
    }
    if (n <= period) return tr;
    let sum = 0;
    for (let i = 1; i <= period; i++) sum += tr[i];
    tr[period] = sum / period;
    for (let i = period + 1; i < n; i++) {
      tr[i] = (tr[i - 1] * (period - 1) + tr[i]) / period;
    }
    return tr;
  }

  // SuperTrend: a trailing stop that hugs price and flips sides on
  // breakout. Emitted as a single line whose per-point color shows the
  // current trend (green = following the up-side lower band, red = the
  // down-side upper band). Canonical ATR-period implementation.
  function computeSuperTrend(bars, period, multiplier) {
    const n = bars.length;
    if (n <= period) return [];
    const atr = computeATR(bars, period);
    const hl2 = bars.map((b) => (b.high + b.low) / 2);
    const basicUpper = [], basicLower = [], finalUpper = [], finalLower = [];
    for (let i = 0; i < n; i++) {
      basicUpper[i] = hl2[i] + multiplier * atr[i];
      basicLower[i] = hl2[i] - multiplier * atr[i];
      if (i === 0) {
        finalUpper[0] = basicUpper[0];
        finalLower[0] = basicLower[0];
      } else {
        finalUpper[i] = (basicUpper[i] < finalUpper[i - 1] || bars[i - 1].close > finalUpper[i - 1])
          ? basicUpper[i] : finalUpper[i - 1];
        finalLower[i] = (basicLower[i] > finalLower[i - 1] || bars[i - 1].close < finalLower[i - 1])
          ? basicLower[i] : finalLower[i - 1];
      }
    }
    const up = cssVar("--candle-up") || "#0EB07C";
    const down = cssVar("--candle-down") || "#F0434E";
    const out = [];
    let dir = 1;
    for (let i = period; i < n; i++) {
      if (i === period) {
        dir = bars[i].close > finalUpper[i] ? 1 : -1;
      } else if (dir === 1) {
        if (bars[i].close < finalLower[i]) dir = -1;
      } else {
        if (bars[i].close > finalUpper[i]) dir = 1;
      }
      out.push({
        time: bars[i].time,
        value: dir === 1 ? finalLower[i] : finalUpper[i],
        color: dir === 1 ? up : down
      });
    }
    return out;
  }

  function ema(seriesData, period) {
    if (seriesData.length < period) return [];
    const k = 2 / (period + 1);
    let sum = 0;
    for (let i = 0; i < period; i++) sum += seriesData[i].value;
    let prev = sum / period;
    const out = [{ time: seriesData[period - 1].time, value: prev }];
    for (let i = period; i < seriesData.length; i++) {
      prev = seriesData[i].value * k + prev * (1 - k);
      out.push({ time: seriesData[i].time, value: prev });
    }
    return out;
  }

  function computeMACD(bars, fast, slow, signalPeriod) {
    const closeSeries = bars.map((b) => ({ time: b.time, value: b.close }));
    const emaFast = ema(closeSeries, fast);
    const emaSlow = ema(closeSeries, slow);
    if (!emaSlow.length) return { macd: [], signal: [], hist: [] };
    const fastMap = new Map(emaFast.map((p) => [p.time, p.value]));
    const macdLine = emaSlow.filter((p) => fastMap.has(p.time)).map((p) => ({ time: p.time, value: fastMap.get(p.time) - p.value }));
    const signal = ema(macdLine, signalPeriod);
    const signalMap = new Map(signal.map((p) => [p.time, p.value]));
    const macdAligned = macdLine.filter((p) => signalMap.has(p.time));
    const hist = macdAligned.map((p) => ({ time: p.time, value: p.value - signalMap.get(p.time) }));
    return { macd: macdAligned, signal, hist };
  }

  function computeRSI(bars, period) {
    if (bars.length < period + 1) return [];
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const diff = bars[i].close - bars[i - 1].close;
      if (diff >= 0) gains += diff; else losses -= diff;
    }
    let avgGain = gains / period, avgLoss = losses / period;
    const out = [rsiPoint(bars[period].time, avgGain, avgLoss)];
    for (let i = period + 1; i < bars.length; i++) {
      const diff = bars[i].close - bars[i - 1].close;
      const gain = diff > 0 ? diff : 0, loss = diff < 0 ? -diff : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out.push(rsiPoint(bars[i].time, avgGain, avgLoss));
    }
    return out;
  }

  function rsiPoint(time, avgGain, avgLoss) {
    if (avgLoss === 0) return { time, value: 100 };
    const rs = avgGain / avgLoss;
    return { time, value: 100 - 100 / (1 + rs) };
  }

  /* ---------------------------------------------------------
     Topbar price + generic formatting
     --------------------------------------------------------- */

  function updateTopbarPrice(last, prev, meta) {
    const change = last.close - prev.close;
    const pct = prev.close ? (change / prev.close) * 100 : 0;
    const dir = change > 0 ? "up" : change < 0 ? "down" : "flat";
    const arrow = change > 0 ? "▲" : change < 0 ? "▼" : "•";
    const high = meta && Number.isFinite(meta.fiftyTwoWeekHigh) ? meta.fiftyTwoWeekHigh : null;
    const highGap = high && high > 0 ? ((last.close - high) / high) * 100 : null;
    const gapHtml = highGap == null
      ? ""
      : `<div class="price-meta ${highGap < 0 ? "down" : highGap > 0 ? "up" : "flat"}">${highGap < 0 ? "↓" : highGap > 0 ? "↑" : "•"} ${fmtPercent(Math.abs(highGap))} 52W</div>`;
    $("#priceBlock").html(gapHtml || `<div class="price-meta flat">—</div>`);
  }

  function fmtPercent(n) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    return `${n >= 0 ? "+" : "-"}${Math.abs(n).toFixed(2)}%`;
  }

  function fmt(n) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    return n.toFixed(n < 10 ? 3 : 2);
  }

  /* ---------------------------------------------------------
     9. Fetch helpers — race all CORS proxies at once, take the winner
     --------------------------------------------------------- */

  // Previously these were tried one at a time: if the first proxy was slow,
  // every load waited out its full timeout before even trying the next one.
  // Now all proxies are requested simultaneously and whichever responds
  // Fetch data through the controller proxy endpoint
  // The controller handles all server-side requests to Yahoo Finance, eliminating CORS issues
  const FETCH_TIMEOUT_MS = 15000;

  function extractMeta(json) {
    const result = json && json.chart && json.chart.result && json.chart.result[0];
    return result && result.meta ? result.meta : null;
  }

  function extractYahooError(json) {
    const err = json && json.chart && json.chart.error;
    if (!err) return null;
    return err.description || err.code || null;
  }

  function syncPendingSymbols(stocks) {
    const pending = stocks.filter((stock) => {
      if (getSyncStatus(stock.s) === "not-found") return false;
      return !window.StockPrediction || !StockPrediction.hasBars(stock.s);
    });
    return syncSymbols(pending);
  }

  function syncSymbols(stocks) {
    if (syncInProgress || !stocks.length) return Promise.resolve();
    syncInProgress = true;
    syncStopRequested = false;
    updateSyncSummary();
    stocks.forEach((stock) => {
      setSyncStatus(stock.s, "syncing");
      updateRowSyncBadge(stock.s, "syncing");
    });
    renderList(filtered, $("#searchInput").val().trim());

    const source = DataSources.get(SETTINGS.dataSource);
    const queue = stocks.slice();
    const concurrency = 6;
    let index = 0;

    const worker = async () => {
      while (index < queue.length && !syncStopRequested) {
        const currentIndex = index++;
        const stock = queue[currentIndex];
        if (!stock) continue;
        try {
          const interval = source.mapInterval("D");
          const range = source.mapRange("D", historyPointsNeeded());
          const candidates = buildSymbolCandidates(stock, source);
          let payload = null;
          let notFound = false;

          for (const symbol of candidates) {
            const proxyUrl = `${CONTROLLER_PROXY}?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;
            try {
              const request = fetchWithControllerProxy(proxyUrl);
              syncAbortControllers.add(request.controllers[0]);
              const { promise } = request;
              const json = await promise;
              syncAbortControllers.delete(request.controllers[0]);
              if (extractYahooError(json)) {
                notFound = true;
                continue;
              }
              const candles = source.parseCandles(json);
              if (!candles.length) {
                notFound = true;
                continue;
              }
              const barCount = Number(SETTINGS.barCount);
              const bars = barCount > 0 ? candles.slice(-barCount) : candles;
              if (window.StockPrediction) StockPrediction.cacheBars(stock.s, candles);
              const last = bars[bars.length - 1];
              const prev = bars.length > 1 ? bars[bars.length - 2] : last;
              const change = last.close - prev.close;
              const changePct = prev.close ? (change / prev.close) * 100 : 0;
              const smaSeries = computeSMA(bars, 5);
              const sma5 = smaSeries.length ? smaSeries[smaSeries.length - 1].value : null;
              const aboveSma5 = sma5 != null && last.close > sma5;
              const meta = extractMeta(json);
              payload = {
                price: last.close,
                change,
                changePct,
                aboveSma5,
                sma5,
                fiftyTwoWeekHigh: meta && Number.isFinite(meta.fiftyTwoWeekHigh) ? meta.fiftyTwoWeekHigh : null
              };
              break;
            } catch (err) {
              if (err && err.name === "AbortError") break;
              // Try the next symbol candidate if this one fails.
            }
          }

          if (!payload) {
            setSyncStatus(stock.s, notFound ? "not-found" : "error", notFound ? "Symbol not found" : "No data returned");
            updateRowSyncBadge(stock.s, notFound ? "not-found" : "error");
            continue;
          }

          quoteCache[stock.s] = payload;
          quoteCache[stock.s.toUpperCase()] = payload;
          quoteCache[stock.s.toLowerCase()] = payload;
          const resolved = source.resolveSymbol(stock);
          quoteCache[resolved] = payload;
          quoteCache[resolved.toUpperCase()] = payload;
          quoteCache[resolved.toLowerCase()] = payload;
          setSyncStatus(stock.s, "synced");
          updateRowSyncBadge(stock.s, "synced");
        } catch (err) {
          setSyncStatus(stock.s, "error", err && err.message ? err.message : "Sync failed");
          console.warn(`[${stock.s}] change load failed`, err);
        }
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => worker());
    return Promise.allSettled(workers).then(() => {
      syncAbortControllers.clear();
      if (syncStopRequested) {
        stocks.forEach((stock) => {
          if (getSyncStatus(stock.s) === "syncing") setSyncStatus(stock.s, "pending");
        });
      }
      syncInProgress = false;
      saveSyncStore();
      refreshFilteredList();
      updateSyncSummary();
      if (window.StockPrediction) StockPrediction.renderUniverse(filtered, quoteCache, currentStock);
    });
  }

  function fetchWithControllerProxy(proxyUrl) {
    const controller = new AbortController();
    const promise = fetchWithTimeout(proxyUrl, FETCH_TIMEOUT_MS, controller);
    return { promise, controllers: [controller] };
  }

  function fetchWithTimeout(url, ms, controller) {
    const timer = setTimeout(() => controller.abort(), ms);
    return fetch(url, { cache: "no-store", signal: controller.signal })
      .then((r) => {
        clearTimeout(timer);
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .catch((err) => { clearTimeout(timer); throw err; });
  }

  /* ---------------------------------------------------------
     10. Misc UI: mobile sidebar toggle
     --------------------------------------------------------- */

  function bindGlobalUI() {
    $("#menuToggle").on("click", function () {
      const mobile = window.matchMedia("(max-width: 760px)").matches;
      if (mobile) {
        $("#sidebar").addClass("open");
        $("#scrim").addClass("show");
      } else {
        const hidden = $("#app").toggleClass("sidebar-hidden").hasClass("sidebar-hidden");
        try { localStorage.setItem("sc.sidebarHidden", hidden ? "1" : ""); } catch (err) { /* storage may be unavailable */ }
      }
    });
    $("#scrim").on("click", closeSidebarOnMobile);
    $("#analysisBtn").on("click", function () {
      const showingAnalysis = $("#analysisView").hasClass("show");
      setAnalysisView(!showingAnalysis);
      if (!showingAnalysis && window.StockPrediction) {
        if (currentStock && candleCache.D) {
          StockPrediction.update(currentStock, candleCache.D, charts.D, "D", filtered, quoteCache);
        } else {
          StockPrediction.renderUniverse(filtered, quoteCache, currentStock);
        }
      }
    });
    $("#columnInfoBtn").on("click", function (event) {
      event.stopPropagation();
      $("#columnInfoPopover").toggleClass("show");
    });
    $("#columnInfoPopover").on("click", function (event) {
      event.stopPropagation();
    });
    $(document).on("click", function () {
      $("#columnInfoPopover").removeClass("show");
    });
    $(document).on("click", ".row-chart-btn", function (event) {
      event.preventDefault();
      event.stopPropagation();
      const symbol = String($(this).data("symbol") || "");
      openChartForSymbol(symbol);
    });
    $(document).on("click", ".prediction-stock-cell", function (event) {
      if ($(event.target).closest(".row-chart-btn").length) return;
      openChartForSymbol(String($(this).data("symbol") || ""));
    });
    $(document).on("keydown", ".prediction-stock-cell", function (event) {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openChartForSymbol(String($(this).data("symbol") || ""));
    });

    function openChartForSymbol(symbol) {
      const index = filtered.findIndex((stock) => stock.s === symbol);
      if (index >= 0) selectByFilteredIndex(index);
      setAnalysisView(false);
    }
  }

  function setAnalysisView(showAnalysis) {
    $("#chartGrid").toggle(!showAnalysis);
    $("#analysisView").toggleClass("show", showAnalysis);
    $("#analysisBtn").toggleClass("active", showAnalysis).attr({
      "aria-pressed": String(showAnalysis),
      title: showAnalysis ? "Show charts" : "Show analysis table",
      "aria-label": showAnalysis ? "Show charts" : "Show analysis table"
    });
  }

  function closeSidebarOnMobile() {
    $("#sidebar").removeClass("open");
    $("#scrim").removeClass("show");
  }
})();
