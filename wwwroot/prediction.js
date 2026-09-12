/* =========================================================
   Long-only stock prediction module
   Trend-following signal with ATR risk levels and historical hit rate.
   ========================================================= */

window.StockPrediction = (function () {
  "use strict";

  const activeLines = {};
  const barsCache = {};
  const timeframeAnalyses = {};
  let lastAnalysis = null;
  let analysisViewMode = null;

  function analyze(bars, minimumBars = 60) {
    if (!Array.isArray(bars) || bars.length < minimumBars) return null;
    const closes = bars.map((bar) => bar.close);
    const current = bars[bars.length - 1].close;
    const sma5 = movingAverage(closes, 5);
    const sma20 = average(closes.slice(-20));
    const sma50 = average(closes.slice(-50));
    const sma200 = movingAverage(closes, 200);
    const atr = average(bars.slice(-14).map((bar) => bar.high - bar.low));
    const rsi = calculateRsi(closes, 14);
    const momentum = closes.length > 20 ? ((current / closes[closes.length - 21]) - 1) * 100 : 0;
    const trendScore = scoreTrend(current, sma20, sma50, rsi, momentum);
    const entry = current;
    const riskDistance = Math.max(atr * 1.5, entry * 0.005);
    const stop = Math.max(0, entry - riskDistance);
    const risk = entry - stop;
    const target = entry + risk * 2;
    const probability = estimateHitRate(bars, atr);
    const rewardRisk = risk > 0 ? (target - entry) / risk : 0;
    const signal = trendScore >= 4 ? "BUY / HOLD" : trendScore >= 2 ? "WATCH" : "AVOID";
    const direction = trendScore >= 2 ? "up" : trendScore <= 0 ? "down" : "flat";

    return {
      current, entry, stop, target, atr, sma5, sma20, sma50, sma200, rsi, momentum,
      trendScore, signal, direction, probability, rewardRisk,
      horizon: "next 10 trading days",
      asOf: bars[bars.length - 1].time
    };
  }

  function scoreTrend(current, sma20, sma50, rsi, momentum) {
    let score = 0;
    if (current > sma20) score++;
    if (sma20 > sma50) score++;
    if (rsi >= 50 && rsi <= 72) score++;
    if (momentum > 0) score++;
    if (current > sma50) score++;
    return score;
  }

  function calculateRsi(values, period) {
    if (values.length <= period) return 50;
    let gains = 0, losses = 0;
    for (let index = values.length - period; index < values.length; index++) {
      const diff = values[index] - values[index - 1];
      if (diff >= 0) gains += diff; else losses -= diff;
    }
    if (losses === 0) return 100;
    return 100 - (100 / (1 + (gains / period) / (losses / period)));
  }

  // Walks forward through recent history and counts whether target or stop wins first.
  function estimateHitRate(bars, atr) {
    const horizon = Math.min(10, Math.max(3, Math.floor(bars.length / 4)));
    const lookback = Math.min(100, bars.length - horizon - 1);
    if (lookback < 3) return null;
    let wins = 0, samples = 0;
    for (let index = bars.length - lookback - 1; index < bars.length - horizon; index++) {
      const entry = bars[index].close;
      const localAtr = average(bars.slice(Math.max(0, index - 13), index + 1).map((bar) => bar.high - bar.low)) || atr;
      const target = entry + localAtr * 3;
      const stop = entry - localAtr * 1.5;
      let result = null;
      for (let forward = index + 1; forward <= Math.min(index + horizon, bars.length - 1); forward++) {
        if (bars[forward].low <= stop) { result = false; break; }
        if (bars[forward].high >= target) { result = true; break; }
      }
      if (result !== null) { samples++; if (result) wins++; }
    }
    return samples >= 3 ? Math.round((wins / samples) * 100) : null;
  }

  function average(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  }

  function movingAverage(values, period) {
    return values.length >= period ? average(values.slice(-period)) : null;
  }

  function money(value) {
    return Number.isFinite(value) ? value.toFixed(value < 100 ? 2 : 0) : "—";
  }

  function percent(value) {
    return Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(1)}%` : "—";
  }

  function targetPercent(analysis) {
    return Number.isFinite(analysis.entry) && analysis.entry > 0
      ? ((analysis.target - analysis.entry) / analysis.entry) * 100
      : null;
  }

  function stopPercent(analysis) {
    return Number.isFinite(analysis.entry) && analysis.entry > 0
      ? ((analysis.stop - analysis.entry) / analysis.entry) * 100
      : null;
  }

  function clearLines(tfKey, chartInfo) {
    (activeLines[tfKey] || []).forEach((line) => {
      try { chartInfo.series.removePriceLine(line); } catch (error) { /* chart may have been recreated */ }
    });
    activeLines[tfKey] = [];
    if (chartInfo) chartInfo.levelPrices = [];
    const labels = chartInfo && chartInfo.levelsHost ? chartInfo.levelsHost : null;
    if (labels) labels.innerHTML = "";
  }

  function drawLevels(tfKey, chartInfo, analysis) {
    if (!chartInfo) return;
    clearLines(tfKey, chartInfo);
    if (!analysis) return;
    const lines = [
      { price: analysis.entry, color: "#2563eb", title: "ENTRY" },
      { price: analysis.target, color: "#1b8f7c", title: "TARGET" },
      { price: analysis.stop, color: "#d8393d", title: "STOP" }
    ];
    chartInfo.levelPrices = lines.map((line) => line.price).filter(Number.isFinite);
    activeLines[tfKey] = lines.map((line) => chartInfo.series.createPriceLine({
      price: line.price, color: line.color, lineWidth: 2,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: true, title: line.title
    }));
    if (chartInfo.levelsHost) {
      const labels = chartInfo.levelsHost;
      if (labels) {
        const levels = lines.map((line) => {
          const delta = ((line.price - analysis.entry) / analysis.entry) * 100;
          const icon = line.title === "ENTRY" ? "●" : line.title === "TARGET" ? "▲" : "▼";
          const deltaText = `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`;
          const description = line.title === "ENTRY"
            ? `${line.title} level at ${money(line.price)}, 0.0% reference`
            : `${line.title} level at ${money(line.price)}, ${deltaText} ${line.title === "TARGET" ? "profit" : "loss"}`;
          const visibleDelta = line.title === "ENTRY" ? "" : `<small>[${deltaText}]</small>`;
          return `<div class="prediction-level ${line.title.toLowerCase()}" title="${description}" aria-label="${description}"><b aria-hidden="true">${icon}</b><span>${money(line.price)}</span>${visibleDelta}</div>`;
        }).join("");
        const winRate = Number.isFinite(analysis.probability) ? `${analysis.probability}%${analysis.provisional ? "*" : ""}` : "—";
        const winRateDescription = `Winning rate: ${winRate.replace("*", "")}. Historical target-hit estimate from recent samples.`;
        labels.innerHTML = `${levels}<div class="prediction-winrate" title="${winRateDescription}" aria-label="${winRateDescription}"><b aria-hidden="true">◎</b><span>${winRate}</span><small>WIN</small></div>`;
      }
    }
  }

  function quoteFor(stock, quoteMap) {
    return quoteMap[stock.s] || quoteMap[stock.s.toUpperCase()] || quoteMap[stock.s.toLowerCase()] || {};
  }

  function provisionalAnalysis(quote) {
    const current = Number(quote.price);
    if (!Number.isFinite(current) || current <= 0) return null;
    const move = Number.isFinite(quote.changePct) ? quote.changePct : 0;
    const range = Math.max(current * 0.03, Math.abs(move) * current / 100);
    const stop = Math.max(0, current - range * 1.5);
    return {
      current, entry: current, stop, target: current + range * 2,
      probability: 50, trendScore: move > 0 ? 3 : move < 0 ? 1 : 2,
      signal: move > 0 ? "WATCH" : "AVOID", direction: move > 0 ? "up" : move < 0 ? "down" : "flat",
      momentum: move, rsi: null, provisional: true
    };
  }

  function renderCollection(stocks, quoteMap, selectedStock, selectedQuote) {
    const list = Array.isArray(stocks) ? stocks : [];
    const selected = selectedStock || {};
    const selectedAnalysis = barsCache[selected.s] ? analyze(barsCache[selected.s]) : lastAnalysis;
    const tableState = captureDataTableState();
    $("#analysisTitle").text(`${list.length} filtered stocks${selected.s ? ` · selected ${selected.s}` : ""}`);
    if (!list.length) {
      $("#predictionPanel").html('<div class="analysis-empty">No stocks match the current filter.</div>');
      return;
    }
    const detail = selectedAnalysis && selectedQuote ? `<div class="analysis-fundamentals"><span>Selected fundamentals</span><b>Market cap ${formatFundamental(selectedQuote.marketCap)}</b><b>P/E ${formatFundamental(selectedQuote.trailingPE)}</b><b>EPS ${formatFundamental(selectedQuote.epsTrailingTwelveMonths)}</b><b>Yield ${selectedQuote.dividendYield == null ? "—" : `${(selectedQuote.dividendYield * 100).toFixed(2)}%`}</b></div>` : "";
    const summary = buildAnalysisSummary(list, quoteMap, selectedQuote, selected);
    const panel = document.getElementById("predictionPanel");
    panel.innerHTML = `<div class="analysis-kicker">LONG-ONLY TREND SETUPS · FILTERED UNIVERSE</div>${detail}${summary}`;
    panel.appendChild(buildPredictionTable(list, quoteMap, selected));
    const note = document.createElement("p");
    note.className = "analysis-note";
    note.textContent = "Winning rate is the historical target-hit estimate for the model's recent samples, expressed from 0–100%. Trend score is a separate 0–5 technical alignment score, not a winning rate. Rows marked * are provisional until that stock's daily history has been synced. This stock-only model does not evaluate options or futures.";
    panel.appendChild(note);
    initializeDataTable(tableState);
  }

  function buildAnalysisSummary(stocks, quoteMap, selectedQuote, selectedStock) {
    const counts = { total: stocks.length, buyHold: 0, watch: 0, avoid: 0, advances: 0, declines: 0, unchanged: 0 };
    stocks.forEach((stock) => {
      const analysis = barsCache[stock.s] ? analyze(barsCache[stock.s]) : provisionalAnalysis(quoteFor(stock, quoteMap));
      if (analysis && analysis.signal === "BUY / HOLD") counts.buyHold++;
      else if (analysis && analysis.signal === "WATCH") counts.watch++;
      else if (analysis && analysis.signal === "AVOID") counts.avoid++;

      const quote = quoteFor(stock, quoteMap);
      const changePct = Number.isFinite(quote.changePct)
        ? quote.changePct
        : stock.s === selectedStock.s && selectedQuote && Number.isFinite(selectedQuote.regularMarketChangePercent)
          ? selectedQuote.regularMarketChangePercent
          : null;
      if (changePct == null || Math.abs(changePct) < 0.01) counts.unchanged++;
      else if (changePct > 0) counts.advances++;
      else counts.declines++;
    });
    const cards = [
      ["Total", counts.total, "total"],
      ["BUY / HOLD", counts.buyHold, "buy"],
      ["WATCH", counts.watch, "watch"],
      ["AVOID", counts.avoid, "avoid"],
      ["Advances", counts.advances, "advance"],
      ["Declines", counts.declines, "decline"],
      ["Unchanged", counts.unchanged, "unchanged"]
    ];
    return `<div class="analysis-summary-strip" aria-label="Analysis summary">${cards.map(([label, value, tone]) => `<div class="analysis-summary-card ${tone}"><span>${label}</span><b>${value}</b></div>`).join("")}</div>`;
  }

  function buildPredictionTable(stocks, quoteMap, selected) {
    const headers = ["◫ Stock", "◆ Signal", "◎ Win rates", "• Entry", "▲ Target", "↗ Target %", "▼ Stop loss", "↘ Loss %", "✦ Trend score", "∿ Momentum", "⌁ SMA alignment"];
    const wrapper = document.createElement("div");
    wrapper.className = "analysis-table-wrap";
    const toolbar = document.createElement("div");
    toolbar.className = "prediction-table-toolbar";
    const filterLabel = document.createElement("label");
    filterLabel.htmlFor = "signalFilter";
    filterLabel.textContent = "Signal";
    const signalFilter = document.createElement("select");
    signalFilter.id = "signalFilter";
    signalFilter.className = "signal-filter";
    ["All signals", "BUY / HOLD", "WATCH", "AVOID"].forEach((signal) => {
      const option = document.createElement("option");
      option.value = signal === "All signals" ? "" : signal;
      option.textContent = signal;
      signalFilter.appendChild(option);
    });
    toolbar.append(filterLabel, signalFilter);
    const viewToggle = document.createElement("div");
    viewToggle.className = "prediction-view-toggle";
    viewToggle.setAttribute("aria-label", "Analysis layout");
    ["table", "cards"].forEach((mode) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "view-mode-btn";
      button.dataset.viewMode = mode;
      button.textContent = mode === "table" ? "Table" : "Cards";
      button.setAttribute("aria-pressed", String(getTableViewMode() === mode));
      button.addEventListener("click", () => setTableViewMode(wrapper, mode));
      viewToggle.appendChild(button);
    });
    toolbar.appendChild(viewToggle);
    wrapper.classList.toggle("card-mode", getTableViewMode() === "cards");
    wrapper.appendChild(toolbar);
    const table = document.createElement("table");
    table.id = "predictionTable";
    table.className = "prediction-grid";
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    headers.forEach((header) => {
      const cell = document.createElement("th");
      cell.textContent = header;
      headerRow.appendChild(cell);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    stocks.forEach((stock) => {
      const analysis = barsCache[stock.s] ? analyze(barsCache[stock.s]) : provisionalAnalysis(quoteFor(stock, quoteMap));
      const row = document.createElement("tr");
      if (stock.s === selected.s) row.className = "selected-prediction";
      const status = stock.syncStatus || "pending";
      const failedStatus = status === "error" || status === "not-found";
      if (failedStatus) row.classList.add("analysis-failed");
      else if (!analysis || analysis.provisional) row.classList.add("analysis-pending");
      if (!analysis) {
        appendStockCell(row, stock);
        appendCell(row, failedStatus ? "Daily data unavailable" : "Loading daily data");
        for (let index = 2; index < headers.length; index++) appendCell(row, "—");
        tbody.appendChild(row);
        return;
      }

      const targetDelta = targetPercent(analysis);
      const stopDelta = stopPercent(analysis);
      const winRates = formatWinRates(stock.s, analysis);
      appendStockCell(row, stock);
      appendCell(row, analysis.signal, false, `signal-${analysis.direction}`);
      appendCell(row, winRates.text, false, "", "", analysis.probability);
      appendCell(row, money(analysis.current));
      appendCell(row, money(analysis.target), false, "value-up");
      appendCell(row, percent(targetDelta), false, "value-up", "", targetDelta);
      appendCell(row, money(analysis.stop), false, "value-down");
      appendCell(row, percent(stopDelta), false, "value-down", "", stopDelta);
      appendCell(row, `${analysis.trendScore}/5`, false, "", "", analysis.trendScore);
      appendCell(row, analysis.momentum == null ? "—" : percent(analysis.momentum));
      appendSmaCell(row, analysis);
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    wrapper.appendChild(table);
    return wrapper;
  }

  function formatWinRates(symbol, dailyAnalysis) {
    const analyses = { D: dailyAnalysis, W: timeframeAnalyses[symbol] && timeframeAnalyses[symbol].W, M: timeframeAnalyses[symbol] && timeframeAnalyses[symbol].M };
    const parts = ["D", "W", "M"].map((timeframe) => {
      const analysis = analyses[timeframe];
      const probability = analysis && !analysis.provisional && Number.isFinite(analysis.probability) ? `${analysis.probability}%` : "—";
      return `${timeframe}:${probability}`;
    });
    return {
      text: parts.join("|"),
      tooltip: "Winning rate by timeframe: Daily|Weekly|Monthly"
    };
  }

  function getTableViewMode() {
    if (analysisViewMode === "table" || analysisViewMode === "cards") return analysisViewMode;
    try {
      const saved = localStorage.getItem("nseCharts.analysisViewMode");
      if (saved === "table" || saved === "cards") {
        analysisViewMode = saved;
        return analysisViewMode;
      }
    } catch (error) { /* use the responsive default */ }
    analysisViewMode = window.matchMedia && window.matchMedia("(max-width: 760px)").matches ? "cards" : "table";
    return analysisViewMode;
  }

  function setTableViewMode(wrapper, mode) {
    analysisViewMode = mode === "cards" ? "cards" : "table";
    try { localStorage.setItem("nseCharts.analysisViewMode", analysisViewMode); } catch (error) { /* preference is optional */ }
    wrapper.classList.toggle("card-mode", analysisViewMode === "cards");
    wrapper.querySelectorAll(".view-mode-btn").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.viewMode === analysisViewMode));
    });
  }

  function appendSmaCell(row, analysis) {
    const cell = document.createElement("td");
    cell.className = "sma-alignment";
    const entries = [
      ["5SMA", analysis.sma5],
      ["20SMA", analysis.sma20],
      ["50SMA", analysis.sma50],
      ["200SMA", analysis.sma200]
    ];
    entries.forEach((entry, index) => {
      if (index > 0) {
        const separator = document.createElement("span");
        separator.className = "sma-connector";
        separator.textContent = "›";
        separator.setAttribute("aria-hidden", "true");
        cell.appendChild(separator);
      }
      const icon = document.createElement("span");
      const positive = entry[1] != null && analysis.current >= entry[1];
      const statusClass = positive ? "positive" : entry[1] == null ? "neutral" : "negative";
      const item = document.createElement("span");
      item.className = `sma-item sma-${statusClass}`;
      icon.className = `sma-icon sma-${statusClass}`;
      icon.textContent = entry[1] == null ? "•" : positive ? "▲" : "▼";
      icon.title = `${entry[0]}: ${entry[1] == null ? "not enough history" : positive ? "positive, price above average" : "negative, price below average"}`;
      icon.setAttribute("aria-label", icon.title);
      const label = document.createElement("small");
      label.textContent = entry[0].replace("SMA", "");
      label.setAttribute("aria-hidden", "true");
      item.append(label, icon);
      cell.appendChild(item);
    });
    row.appendChild(cell);
  }

  function appendStockCell(row, stock) {
    const cell = document.createElement("td");
    cell.className = "prediction-stock-cell";
    cell.dataset.symbol = stock.s;
    cell.tabIndex = 0;
    cell.title = `Show ${stock.s} chart`;
    const symbol = document.createElement("b");
    symbol.textContent = stock.s;
    const name = document.createElement("small");
    name.textContent = stock.n || "";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "row-chart-btn";
    button.dataset.symbol = stock.s;
    button.title = `Show ${stock.s} chart`;
    button.setAttribute("aria-label", `Show ${stock.s} chart`);
    button.textContent = "↗";
    cell.append(symbol, button, name);
    row.appendChild(cell);
  }

  function appendCell(row, value, bold, className, secondary, order) {
    const cell = document.createElement("td");
    if (className) cell.className = className;
    if (order !== undefined && order !== null && order !== "") cell.dataset.order = order;
    const valueNode = bold ? document.createElement("b") : document.createElement("span");
    valueNode.textContent = value;
    cell.appendChild(valueNode);
    if (secondary) {
      const detail = document.createElement("small");
      detail.textContent = secondary;
      cell.appendChild(detail);
    }
    row.appendChild(cell);
  }

  function captureDataTableState() {
    const table = document.getElementById("predictionTable");
    if (!table || !window.jQuery || !jQuery.fn.dataTable || !jQuery.fn.dataTable.isDataTable(table)) return null;
    const api = jQuery(table).DataTable();
    const info = api.page.info();
    const signalFilter = document.getElementById("signalFilter");
    const state = {
      page: info.page,
      length: info.length,
      search: api.search(),
      order: api.order(),
      signal: signalFilter ? signalFilter.value : ""
    };
    api.destroy(true);
    return state;
  }

  function initializeDataTable(previousState) {
    const table = document.getElementById("predictionTable");
    if (!table || !window.jQuery || !jQuery.fn.DataTable) return;
    const state = previousState || {};
    const length = state.length || 25;
    jQuery(table).DataTable({
      pageLength: length,
      displayStart: (state.page || 0) * length,
      lengthMenu: [[10, 25, 50, -1], [10, 25, 50, "All"]],
      order: state.order || [[2, "desc"]],
      search: { search: state.search || "" },
      searchCols: [null, { search: state.signal ? `^${state.signal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$` : "" }],
      autoWidth: false,
      language: { search: "Filter stocks:", emptyTable: "No stock predictions available" },
      initComplete: function () {
        const tableApi = this.api();
        const signalFilter = document.getElementById("signalFilter");
        if (signalFilter) {
          signalFilter.value = state.signal || "";
          signalFilter.addEventListener("change", function () {
            const value = this.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            tableApi.column(1).search(value ? `^${value}$` : "", true, false).draw();
          });
        }
      }
    });
  }

  function formatFundamental(value) {
    if (!Number.isFinite(Number(value))) return "—";
    const number = Number(value);
    return number >= 1e9 ? `${(number / 1e9).toFixed(2)}B` : number >= 1e6 ? `${(number / 1e6).toFixed(2)}M` : number.toFixed(2);
  }

  async function update(stock, bars, chartInfo, tfKey, stocks, quoteMap) {
    const analysis = analyze(bars, tfKey === "D" ? 60 : 20);
    lastAnalysis = analysis;
    if (stock && stock.s && analysis) {
      if (!timeframeAnalyses[stock.s]) timeframeAnalyses[stock.s] = {};
      timeframeAnalyses[stock.s][tfKey] = analysis;
    }
    if (analysis) {
      drawLevels(tfKey, chartInfo, analysis);
      if (tfKey === "D") cacheBars(stock.s, bars);
    }
    const analysisStocks = stocks && stocks.length ? stocks : stock && stock.i === "Custom" ? [stock] : [];
    renderCollection(analysisStocks, quoteMap || {}, stock, null);
    if (!stock || !stock.s) return analysis;
    try {
      const symbol = stock.s.startsWith("^") || stock.s.includes(".") ? stock.s : `${stock.s}.NS`;
      const response = await fetch(`/api/quote-data?symbols=${encodeURIComponent(symbol)}`, { cache: "no-store" });
      if (!response.ok) return analysis;
      const json = await response.json();
      const quote = json && json.quoteResponse && json.quoteResponse.result && json.quoteResponse.result[0];
      renderCollection(analysisStocks, quoteMap || {}, stock, quote || null);
    } catch (error) {
      // Chart-derived analysis remains useful when quote fundamentals are unavailable.
    }
    return analysis;
  }

  function getLastAnalysis() { return lastAnalysis; }

  function cacheBars(symbol, bars) {
    if (symbol && Array.isArray(bars) && bars.length) barsCache[symbol] = bars;
  }

  function renderUniverse(stocks, quoteMap, selectedStock) {
    const list = Array.isArray(stocks) ? stocks.slice() : [];
    if (selectedStock && selectedStock.i === "Custom" && !list.some((stock) => stock.s === selectedStock.s)) {
      list.unshift(selectedStock);
    }
    renderCollection(list, quoteMap, selectedStock, null);
  }

  function hasBars(symbol) {
    return !!(symbol && barsCache[symbol] && barsCache[symbol].length);
  }

  return { update, analyze, cacheBars, hasBars, renderUniverse, getLastAnalysis };
})();
