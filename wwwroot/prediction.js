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
    const sma20 = average(closes.slice(-20));
    const sma50 = average(closes.slice(-50));
    const current = bars[bars.length - 1].close;
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
      current, entry, stop, target, atr, sma20, sma50, rsi, momentum,
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

  function money(value) {
    return Number.isFinite(value) ? value.toFixed(value < 100 ? 2 : 0) : "—";
  }

  function percent(value) {
    return Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(1)}%` : "—";
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
    const rows = list.map((stock) => {
      const analysis = barsCache[stock.s] ? analyze(barsCache[stock.s]) : provisionalAnalysis(quoteFor(stock, quoteMap));
      if (!analysis) return `<tr><td>${stock.s}</td><td colspan="7">Waiting for daily data</td></tr>`;
      const cls = `signal-${analysis.direction}`;
      return `<tr class="${stock.s === selected.s ? "selected-prediction" : ""}"><td><b>${stock.s}</b><small>${stock.n || ""}</small></td><td class="${cls}">${analysis.signal}</td><td>${money(analysis.current)}</td><td class="value-up">${money(analysis.target)}<small>${analysis.provisional ? "quote estimate" : ""}</small></td><td class="value-down">${money(analysis.stop)}</td><td><b>${analysis.probability}%</b>${analysis.provisional ? "*" : ""}</td><td>${analysis.trendScore}/5</td><td>${analysis.momentum == null ? "—" : percent(analysis.momentum)}</td></tr>`;
    }).join("");
    const detail = selectedAnalysis && selectedQuote ? `<div class="analysis-fundamentals"><span>Selected fundamentals</span><b>Market cap ${formatFundamental(selectedQuote.marketCap)}</b><b>P/E ${formatFundamental(selectedQuote.trailingPE)}</b><b>EPS ${formatFundamental(selectedQuote.epsTrailingTwelveMonths)}</b><b>Yield ${selectedQuote.dividendYield == null ? "—" : `${(selectedQuote.dividendYield * 100).toFixed(2)}%`}</b></div>` : "";
    $("#predictionPanel").html(`<div class="analysis-kicker">LONG-ONLY TREND SETUPS · FILTERED UNIVERSE</div>${detail}<div class="analysis-table-wrap"><table class="prediction-grid"><thead><tr><th>Stock</th><th>Signal</th><th>Entry</th><th>Target</th><th>Stop loss</th><th>Probability</th><th>Score</th><th>Momentum</th></tr></thead><tbody>${rows}</tbody></table></div><p class="analysis-note">Probability is a historical estimate from available daily candles. Rows marked * are provisional until that stock's daily history has been synced. This stock-only model does not evaluate options or futures.</p>`);
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

  return { update, analyze, cacheBars, renderUniverse, getLastAnalysis };
})();
