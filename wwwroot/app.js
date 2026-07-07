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

  const NIFTY_STOCK = { s: "^NSEI", n: "Nifty 50 Index", i: "Index" };

  const SETTINGS_KEY = "nseCharts.settings";
  const DEFAULT_SETTINGS = {
    theme: "light",
    density: "compact",
    barCount: 60,
    priceDecimals: 0,
    smaEnabled: true,
    rsiEnabled: true,
    macdEnabled: true,
    autoLoadNifty: true,
    sortMode: "change", // "change" | "symbol" | "sector"
    dataSource: "yahoo", // see datasources.js — the only currently-functional free source
    useProxy: false, // Using controller proxy, so this is always false
    visible: { M: true, W: true, D: true, H: true }
  };

  /* ---------------------------------------------------------
     1. State
     --------------------------------------------------------- */

  let STOCKS = [];
  let filtered = [];
  let activeIndex = -1;
  let quoteCache = {};
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
    const data = window.STOCKS_DATA || [];
    $("#sortSelect").val(SETTINGS.sortMode || "change");
    if (!data.length) {
      $("#stockList").html(
        `<div class="empty-hint">Stock list not found.<br>Make sure stocks.js is loaded before app.js in index.html.</div>`
      );
    } else {
      STOCKS = data;
      filtered = applySort(data);
      renderList(filtered);
      $("#listMeta").text(`${data.length} symbols`);
      loadChangeDataForList(data);
    }

    if (SETTINGS.autoLoadNifty) selectNifty();
  });

  /* ---------------------------------------------------------
     3. Sidebar list
     --------------------------------------------------------- */

  function renderList(list, query) {
    const $list = $("#stockList");
    if (!list.length) {
      $list.html(
        query
          ? `<div class="empty-hint">No match for <b>${escapeHtml(query)}</b>.<br>Press <kbd>Enter</kbd> to fetch it directly as a ticker symbol.</div>`
          : `<div class="empty-hint">No symbols match your search.</div>`
      );
      return;
    }
    const rows = list.map((s, i) => rowHtml(s, i));
    $list.html(rows.join(""));
  }

  function rowHtml(s, i) {
    const meta = getQuoteMeta(s);
    const badge = meta && Number.isFinite(meta.changePct)
      ? `<span class="move-pill ${meta.changePct > 0 ? "up" : meta.changePct < 0 ? "down" : "flat"}">${fmtPercent(meta.changePct)}</span>`
      : "";
    return (
      `<div class="stock-row" data-idx="${i}" data-sym="${s.s}">` +
      `<span class="sym-wrap">` +
      `<span class="sym">${s.s}</span>` +
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

  // Re-sorts whatever's currently filtered (keeps the active search intact),
  // re-renders, and keeps the currently-loaded symbol's highlight/position
  // in sync since its index within `filtered` may have moved.
  function resortList() {
    const currentSym = activeIndex >= 0 && filtered[activeIndex] ? filtered[activeIndex].s : null;
    filtered = applySort(filtered);
    renderList(filtered, $("#searchInput").val().trim());
    activeIndex = currentSym ? filtered.findIndex((s) => s.s === currentSym) : -1;
    highlightActiveRow();
    updateNavButtons();
  }

  function escapeHtml(str) {
    return $("<div>").text(str || "").html();
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
      filtered = !q
        ? STOCKS
        : STOCKS.filter(
            (s) => s.s.toUpperCase().includes(q) || s.n.toUpperCase().includes(q)
          );
      filtered = applySort(filtered);
      renderList(filtered, q);
      highlightActiveRow();
    }, 120);
  });

  $("#sortSelect").on("change", function () {
    SETTINGS.sortMode = $(this).val();
    saveSettings();
    resortList();
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

  /* ---------------------------------------------------------
     4. Selecting a symbol (click, next/prev, keyboard, pinned/custom)
     --------------------------------------------------------- */

  function selectByFilteredIndex(idx) {
    if (idx < 0 || idx >= filtered.length) return;
    activeIndex = idx;
    const stock = filtered[idx];
    highlightActiveRow();
    loadSymbol(stock);
    updateNavButtons();
  }

  function selectNifty() {
    activeIndex = -1;
    $(".stock-row, .pinned-row").removeClass("active");
    $("#pinnedNifty").addClass("active");
    loadSymbol(NIFTY_STOCK);
    updateNavButtons();
  }

  function loadCustomSymbol(q) {
    activeIndex = -1;
    $(".stock-row, .pinned-row").removeClass("active");
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

  $("#gridWrap").on("wheel", function (e) {
    if (!e.shiftKey) return;
    e.preventDefault();
    if (e.originalEvent.deltaY > 0) selectByFilteredIndex(activeIndex + 1 < 0 ? 0 : activeIndex + 1);
    else selectByFilteredIndex(activeIndex - 1);
  });

  $("#refreshBtn").on("click", function () {
    if (currentStock) loadSymbol(currentStock);
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
        `<div class="panel-ohlc" id="ohlc-${tf.key}"></div>` +
        `</div>` +
        `<div class="chart-area">` +
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

      charts[tf.key] = { chart, series, volSeries, smaSeries, rsiSeries, macdLine, macdSignal, macdHist };
      applyPaneLayout(tf.key);
      setPanelVisible(tf.key, SETTINGS.visible[tf.key]);
      bindCrosshairTooltip(tf.key, host, chart, series, smaSeries);
    });

    resizeObserver = new ResizeObserver(() => {
      TIMEFRAMES.forEach((tf) => {
        const h = document.getElementById(`host-${tf.key}`);
        const c = charts[tf.key];
        if (h && c && h.clientWidth > 0) {
          c.chart.applyOptions({ width: h.clientWidth, height: h.clientHeight });
        }
      });
    });
    TIMEFRAMES.forEach((tf) => resizeObserver.observe(document.getElementById(`host-${tf.key}`)));
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // Hover tooltip: shows OHLC + SMA5 for whatever bar the crosshair is over,
  // positioned near the cursor and clamped inside the chart area.
  function bindCrosshairTooltip(tfKey, host, chart, series, smaSeries) {
    const $tip = $(`#tooltip-${tfKey}`);
    chart.subscribeCrosshairMove((param) => {
      if (!param.point || !param.time || param.point.x < 0 || param.point.y < 0 || !param.seriesData) {
        $tip.hide();
        return;
      }
      const ohlc = param.seriesData.get(series);
      if (!ohlc) { $tip.hide(); return; }
      const smaPt = param.seriesData.get(smaSeries);

      let html = `O <b>${fmt(ohlc.open)}</b> H <b>${fmt(ohlc.high)}</b> L <b>${fmt(ohlc.low)}</b> C <b>${fmt(ohlc.close)}</b>`;
      if (smaPt && smaPt.value != null) html += `<br><span class="sma">SMA5 ${fmt(smaPt.value)}</span>`;
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
    const up = cssVar("--up");
    const down = cssVar("--down");
    return {
      upColor: up, downColor: down,
      borderUpColor: up, borderDownColor: down,
      wickUpColor: up, wickDownColor: down,
      priceFormat: priceFormatForDecimals(SETTINGS.priceDecimals)
    };
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
        fontSize: isMobile ? 9 : 11
      },
      grid: { vertLines: { color: border }, horzLines: { color: border } },
      rightPriceScale: { borderColor: border, scaleMargins: { top: 0.05, bottom: 0.05 } },
      leftPriceScale: { visible: false },
      timeScale: { borderColor: border, timeVisible: true, secondsVisible: false, tickMarkFormatter: (time) => { if (!time) return ""; const d = new Date(time * 1000); return isMobile ? `${d.getMonth() + 1}/${d.getDate()}` : d.toLocaleDateString(); } },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      autoSize: false,
      handleScroll: true,
      handleScale: true,
      localization: { priceFormatter: (price) => { if (price == null || Number.isNaN(price)) return "—"; return price.toFixed(SETTINGS.priceDecimals || 0); } }
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
    const cols = visibleCount <= 1 ? 1 : 2;
    const rows = Math.ceil(visibleCount / cols);
    $("#chartGrid").css({
      "grid-template-columns": `repeat(${cols}, 1fr)`,
      "grid-template-rows": `repeat(${rows}, 1fr)`
    });
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
    $("#barCountInput").val(SETTINGS.barCount);
    $("#decimalsSelect").val(String(SETTINGS.priceDecimals));
    $("#smaToggle").prop("checked", SETTINGS.smaEnabled);
    $("#rsiToggle").prop("checked", SETTINGS.rsiEnabled);
    $("#macdToggle").prop("checked", SETTINGS.macdEnabled);
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

    $("#decimalsSelect").on("change", function () {
      SETTINGS.priceDecimals = parseInt($(this).val(), 10) || 0;
      saveSettings();
      TIMEFRAMES.forEach((tf) => {
        charts[tf.key].series.applyOptions({ priceFormat: priceFormatForDecimals(SETTINGS.priceDecimals) });
      });
    });

    $("#smaToggle").on("change", function () {
      SETTINGS.smaEnabled = $(this).is(":checked");
      saveSettings();
      TIMEFRAMES.forEach((tf) => charts[tf.key].smaSeries.applyOptions({ visible: SETTINGS.smaEnabled }));
    });

    $("#rsiToggle").on("change", function () {
      SETTINGS.rsiEnabled = $(this).is(":checked");
      saveSettings();
      TIMEFRAMES.forEach((tf) => applyPaneLayout(tf.key));
      rerenderAllFromCache();
    });

    $("#macdToggle").on("change", function () {
      SETTINGS.macdEnabled = $(this).is(":checked");
      saveSettings();
      TIMEFRAMES.forEach((tf) => applyPaneLayout(tf.key));
      rerenderAllFromCache();
    });

    $("#niftyToggle").on("change", function () {
      SETTINGS.autoLoadNifty = $(this).is(":checked");
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
      setPanelVisible(tfKey, checked);
      updateGridLayout();

      // Panel just got shown — if it was skipped while hidden (no cached
      // data yet), fetch it now for whatever symbol is currently loaded.
      // If it already has cached data, just redraw instead of re-fetching.
      if (checked && currentStock) {
        if (candleCache[tfKey]) renderChartData(tfKey);
        else loadTimeframe(currentStock, tfKey);
      }
    });
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
      c.rsiSeries.applyOptions({ color: cssVar("--rsi-line") });
      c.macdLine.applyOptions({ color: cssVar("--macd-line") });
      c.macdSignal.applyOptions({ color: cssVar("--macd-signal") });
    });
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

  function loadSymbol(stock) {
    currentStock = stock;
    $("#placeholder").hide();
    $("#topbarInfo").show();
    $(".big-sym .symtext").text(stock.s.replace(/^\^/, ""));
    $(".company-name").text(stock.n);
    $(".company-meta").text(stock.i || "—");
    $("#priceBlock").html("");
    Object.keys(candleCache).forEach((k) => delete candleCache[k]);
    Object.keys(candleCacheRange).forEach((k) => delete candleCacheRange[k]);

    // Hidden panels (unchecked in Settings) are skipped entirely — no fetch
    // is sent for a chart the user can't currently see. If it's shown again
    // later, the panel-toggle handler fetches it on demand at that point.
    TIMEFRAMES.forEach((tf) => {
      if (SETTINGS.visible[tf.key]) loadTimeframe(stock, tf.key);
    });
  }

  function loadTimeframe(stock, tfKey) {
    const tf = TIMEFRAMES.find((t) => t.key === tfKey);
    setPanelState(tfKey, "loading", `Fetching ${tf.label.toLowerCase()}…`);

    // Cancel whatever was still in flight for this panel — otherwise rapid
    // symbol switching (next/prev, arrow keys, Shift+scroll) piles up
    // requests on the free proxies and everything slows down together.
    if (activeFetches[tfKey]) {
      activeFetches[tfKey].controllers.forEach((c) => c.abort());
    }

    // All provider-specific knowledge (symbol format, interval/range
    // syntax, response shape) lives behind this one call — loadTimeframe
    // itself has no idea which source it's talking to.
    const source = DataSources.get(SETTINGS.dataSource);
    const symbol = source.resolveSymbol(stock);
    const interval = source.mapInterval(tfKey);
    const range = source.mapRange(tfKey, SETTINGS.barCount);

    // Build controller proxy URL with parameters
    const proxyUrl = `${CONTROLLER_PROXY}?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;

    const { promise, controllers } = fetchWithControllerProxy(proxyUrl);
    activeFetches[tfKey] = { controllers };

    promise
      .then((json) => {
        if (activeFetches[tfKey] && activeFetches[tfKey].controllers !== controllers) return; // superseded
        const candles = source.parseCandles(json);
        if (!candles.length) {
          setPanelState(tfKey, "empty", "No candles returned — check the symbol");
          return;
        }
        candleCache[tfKey] = candles;
        candleCacheRange[tfKey] = range;
        candleMetaCache[tfKey] = extractMeta(json);
        renderChartData(tfKey);
      })
      .catch((err) => {
        if (activeFetches[tfKey] && activeFetches[tfKey].controllers !== controllers) return; // superseded, ignore
        if (err && err.name === "AbortError") return; // cancelled on purpose, not a real failure
        console.error(`[${stock.s}/${tfKey}]`, err);
        setPanelState(tfKey, "error", "Fetch failed");
      });
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

    c.series.setData(bars);

    const volUp = cssVar("--vol-up"), volDown = cssVar("--vol-down");
    c.volSeries.setData(
      bars.map((b) => ({ time: b.time, value: b.volume || 0, color: b.close >= b.open ? volUp : volDown }))
    );

    const smaWin = sliceToWindow(computeSMA(full, SMA_PERIOD), windowStart);
    c.smaSeries.setData(smaWin);

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

    const last = bars[bars.length - 1];
    const prev = bars.length > 1 ? bars[bars.length - 2] : last;
    const change = last.close - prev.close;
    const pct = prev.close ? (change / prev.close) * 100 : 0;
    const dir = change > 0 ? "up" : change < 0 ? "down" : "flat";
    const changeText = `${change > 0 ? "+" : change < 0 ? "-" : ""}${fmt(Math.abs(change))} (${pct >= 0 ? "+" : "-"}${fmt(Math.abs(pct))}%)`;
    let headline = `<span class="panel-change ${dir}">Δ ${changeText}</span>`;
    if (SETTINGS.rsiEnabled && rsiWin.length) headline += ` <span>RSI ${fmt(rsiWin[rsiWin.length - 1].value)}</span>`;
    if (SETTINGS.macdEnabled && macdWin.length && sigWin.length) {
      headline += ` <span>MACD ${fmt(macdWin[macdWin.length - 1].value)}/${fmt(sigWin[sigWin.length - 1].value)}</span>`;
    }
    $(`#ohlc-${tfKey}`).html(headline);

    if (tfKey === "D") updateTopbarPrice(last, prev, candleMetaCache[tfKey]);
  }

  function sliceToWindow(series, startTime) {
    return series.filter((p) => p.time >= startTime);
  }

  function rerenderAllFromCache() {
    TIMEFRAMES.forEach((tf) => { if (candleCache[tf.key]) renderChartData(tf.key); });
  }

  // Changing the bar count doesn't always need a re-fetch: if the cached
  // data was already pulled with a wide-enough range, just re-slice it
  // (instant, no network). Only when the new count needs MORE history than
  // what's cached does this go back to the network for that one panel.
  function applyBarCountChange() {
    const source = DataSources.get(SETTINGS.dataSource);
    TIMEFRAMES.forEach((tf) => {
      if (!SETTINGS.visible[tf.key] || !candleCache[tf.key]) return;
      const needed = source.mapRange(tf.key, SETTINGS.barCount);
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

  function loadChangeDataForList(stocks) {
    const source = DataSources.get(SETTINGS.dataSource);
    const queue = stocks.slice();
    const concurrency = 6;
    let index = 0;

    const worker = async () => {
      while (index < queue.length) {
        const currentIndex = index++;
        const stock = queue[currentIndex];
        if (!stock) continue;
        try {
          const symbol = source.resolveSymbol(stock);
          const interval = source.mapInterval("D");
          const range = source.mapRange("D", SETTINGS.barCount);
          const proxyUrl = `${CONTROLLER_PROXY}?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;
          const { promise } = fetchWithControllerProxy(proxyUrl);
          const json = await promise;
          const candles = source.parseCandles(json);
          if (!candles.length) continue;
          const bars = candles.slice(-SETTINGS.barCount > 0 ? SETTINGS.barCount : candles.length);
          const last = bars[bars.length - 1];
          const prev = bars.length > 1 ? bars[bars.length - 2] : last;
          const change = last.close - prev.close;
          const changePct = prev.close ? (change / prev.close) * 100 : 0;
          const meta = extractMeta(json);
          const payload = {
            price: last.close,
            change,
            changePct,
            fiftyTwoWeekHigh: meta && Number.isFinite(meta.fiftyTwoWeekHigh) ? meta.fiftyTwoWeekHigh : null
          };
          quoteCache[stock.s] = payload;
          quoteCache[stock.s.toUpperCase()] = payload;
          quoteCache[stock.s.toLowerCase()] = payload;
          quoteCache[source.resolveSymbol(stock)] = payload;
          quoteCache[source.resolveSymbol(stock).toUpperCase()] = payload;
          quoteCache[source.resolveSymbol(stock).toLowerCase()] = payload;

          if (filtered.some((item) => item.s === stock.s)) {
            filtered = applySort(filtered);
            renderList(filtered, $("#searchInput").val().trim());
            highlightActiveRow();
          }
        } catch (err) {
          console.warn(`[${stock.s}] change load failed`, err);
        }
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => worker());
    return Promise.allSettled(workers).then(() => {
      filtered = applySort(filtered);
      renderList(filtered, $("#searchInput").val().trim());
      highlightActiveRow();
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
      $("#sidebar").addClass("open");
      $("#scrim").addClass("show");
    });
    $("#scrim").on("click", closeSidebarOnMobile);
  }

  function closeSidebarOnMobile() {
    $("#sidebar").removeClass("open");
    $("#scrim").removeClass("show");
  }
})();
