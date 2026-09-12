/* =========================================================
   Long-only stock prediction module
   Trend-following signal with ATR risk levels and historical hit rate.
   ========================================================= */

window.StockPrediction = (function () {
  "use strict";

  const activeLines = {};
  const barsCache = {};
  let lastAnalysis = null;

  function analyze(bars) {
    if (!Array.isArray(bars) || bars.length < 60) return null;
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
    const stop = Math.max(0, entry - atr * 1.5);
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
    const lookback = Math.min(100, bars.length - 31);
    let wins = 0, samples = 0;
    for (let index = bars.length - lookback - 1; index < bars.length - 10; index++) {
      const entry = bars[index].close;
      const localAtr = average(bars.slice(Math.max(0, index - 13), index + 1).map((bar) => bar.high - bar.low)) || atr;
      const target = entry + localAtr * 3;
      const stop = entry - localAtr * 1.5;
      let result = null;
      for (let forward = index + 1; forward <= Math.min(index + 10, bars.length - 1); forward++) {
        if (bars[forward].low <= stop) { result = false; break; }
        if (bars[forward].high >= target) { result = true; break; }
      }
      if (result !== null) { samples++; if (result) wins++; }
    }
    return samples >= 8 ? Math.round((wins / samples) * 100) : 50;
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
    activeLines[tfKey] = lines.map((line) => chartInfo.series.createPriceLine({
      price: line.price, color: line.color, lineWidth: 2,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: true, title: ""
    }));
    if (chartInfo.levelsHost) {
      const labels = chartInfo.levelsHost;
      if (labels) {
        labels.innerHTML = lines.map((line) => {
          const delta = ((line.price - analysis.entry) / analysis.entry) * 100;
          const icon = line.title === "ENTRY" ? "●" : line.title === "TARGET" ? "▲" : "▼";
          const bracket = line.title === "ENTRY"
            ? "0.0%"
            : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}% ${line.title === "TARGET" ? "profit" : "loss"}`;
          const description = `${line.title} level at ${money(line.price)}, ${bracket}`;
          return `<div class="prediction-level ${line.title.toLowerCase()}" title="${description}" aria-label="${description}"><b aria-hidden="true">${icon}</b><span>${money(line.price)}</span><small>[${bracket}]</small></div>`;
        }).join("");
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
    $("#analysisTitle").text(`${list.length} filtered stocks${selected.s ? ` · selected ${selected.s}` : ""}`);
    if (!list.length) {
      $("#predictionPanel").html('<div class="analysis-empty">No stocks match the current filter.</div>');
      return;
    }
    const detail = selectedAnalysis && selectedQuote ? `<div class="analysis-fundamentals"><span>Selected fundamentals</span><b>Market cap ${formatFundamental(selectedQuote.marketCap)}</b><b>P/E ${formatFundamental(selectedQuote.trailingPE)}</b><b>EPS ${formatFundamental(selectedQuote.epsTrailingTwelveMonths)}</b><b>Yield ${selectedQuote.dividendYield == null ? "—" : `${(selectedQuote.dividendYield * 100).toFixed(2)}%`}</b></div>` : "";
    const panel = document.getElementById("predictionPanel");
    panel.innerHTML = `<div class="analysis-kicker">LONG-ONLY TREND SETUPS · FILTERED UNIVERSE</div>${detail}`;
    panel.appendChild(buildPredictionTable(list, quoteMap, selected));
    const note = document.createElement("p");
    note.className = "analysis-note";
    note.textContent = "Winning rate is the historical target-hit estimate for the model's recent samples, expressed from 0–100%. Trend score is a separate 0–5 technical alignment score, not a winning rate. Rows marked * are provisional until that stock's daily history has been synced. This stock-only model does not evaluate options or futures.";
    panel.appendChild(note);
    initializeDataTable();
  }

  function buildPredictionTable(stocks, quoteMap, selected) {
    const headers = ["Stock", "Signal", "Entry", "Target", "Target %", "Stop loss", "Loss %", "Winning rate", "Trend score", "Momentum", "SMA alignment"];
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
      if (!analysis) {
        appendCell(row, stock.s, true);
        appendCell(row, "Waiting for daily data");
        for (let index = 2; index < headers.length; index++) appendCell(row, "—");
        tbody.appendChild(row);
        return;
      }

      const targetDelta = targetPercent(analysis);
      const stopDelta = stopPercent(analysis);
      appendStockCell(row, stock);
      appendCell(row, analysis.signal, false, `signal-${analysis.direction}`);
      appendCell(row, money(analysis.current));
      appendCell(row, money(analysis.target), false, "value-up", analysis.provisional ? "quote estimate" : "");
      appendCell(row, percent(targetDelta), false, "value-up", "", targetDelta);
      appendCell(row, money(analysis.stop), false, "value-down");
      appendCell(row, percent(stopDelta), false, "value-down", "", stopDelta);
      appendCell(row, `${analysis.probability}%${analysis.provisional ? "*" : ""}`, false, "", "", analysis.probability);
      appendCell(row, `${analysis.trendScore}/5`, false, "", "", analysis.trendScore);
      appendCell(row, analysis.momentum == null ? "—" : percent(analysis.momentum));
      appendSmaCell(row, analysis);
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    wrapper.appendChild(table);
    return wrapper;
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
        separator.className = "sma-separator";
        separator.textContent = " - ";
        separator.setAttribute("aria-hidden", "true");
        cell.appendChild(separator);
      }
      const icon = document.createElement("span");
      const positive = entry[1] != null && analysis.current >= entry[1];
      icon.className = positive ? "sma-positive" : entry[1] == null ? "sma-neutral" : "sma-negative";
      icon.textContent = entry[1] == null ? "•" : positive ? "▲" : "▼";
      icon.title = `${entry[0]}: ${entry[1] == null ? "not enough history" : positive ? "positive, price above average" : "negative, price below average"}`;
      icon.setAttribute("aria-label", icon.title);
      cell.appendChild(icon);
    });
    row.appendChild(cell);
  }

  function appendStockCell(row, stock) {
    const cell = document.createElement("td");
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
    button.textContent = "▥";
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

  function initializeDataTable() {
    const table = document.getElementById("predictionTable");
    if (!table || !window.jQuery || !jQuery.fn.DataTable) return;
    jQuery(table).DataTable({
      pageLength: 25,
      lengthMenu: [[10, 25, 50, -1], [10, 25, 50, "All"]],
      order: [[7, "desc"]],
      autoWidth: false,
      language: { search: "Filter stocks:", emptyTable: "No stock predictions available" },
      initComplete: function () {
        const tableApi = this.api();
        const signalFilter = document.getElementById("signalFilter");
        if (signalFilter) {
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
    const analysis = analyze(bars);
    lastAnalysis = analysis;
    if (analysis) {
      drawLevels(tfKey, chartInfo, analysis);
      if (tfKey === "D") cacheBars(stock.s, bars);
    }
    renderCollection(stocks || [stock], quoteMap || {}, stock, null);
    if (!stock || !stock.s) return analysis;
    try {
      const symbol = stock.s.startsWith("^") || stock.s.includes(".") ? stock.s : `${stock.s}.NS`;
      const response = await fetch(`/api/quote-data?symbols=${encodeURIComponent(symbol)}`, { cache: "no-store" });
      if (!response.ok) return analysis;
      const json = await response.json();
      const quote = json && json.quoteResponse && json.quoteResponse.result && json.quoteResponse.result[0];
      renderCollection(stocks || [stock], quoteMap || {}, stock, quote || null);
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
    renderCollection(stocks, quoteMap, selectedStock, null);
  }

  function hasBars(symbol) {
    return !!(symbol && barsCache[symbol] && barsCache[symbol].length);
  }

  return { update, analyze, cacheBars, hasBars, renderUniverse, getLastAnalysis };
})();
