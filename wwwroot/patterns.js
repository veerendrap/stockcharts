/* =========================================================
   Candlestick Pattern Detector
   Detects classic single / dual / triple candle patterns and marks
   the pattern candles with a small up arrow (above a bullish candle)
   or down arrow (below a bearish candle). Only patterns whose
   direction is confirmed by the next candle are shown; the candle
   name is revealed in the hover/OHLC tooltip, so nothing else is
   drawn on the chart and candles stay readable.
   ========================================================= */

window.CandlePatternDetector = (function () {
  "use strict";

  const SMALL_BODY_FACTOR = 0.1;
  const LONG_WICK_FACTOR = 2;
  const TREND_LOOKBACK = 3;
  const MAX_POINTS = 400;   // cap on detected items per timeframe
  const MAX_MARKERS = 20;   // cap on highlighted candles (most recent first)

  const PATTERN_INFO = {
    "Morning Star": "Bullish reversal: big down candle, indecision, strong up close.",
    "Evening Star": "Bearish reversal: big up candle, indecision, strong down close.",
    "3 White Soldiers": "Three consecutive strong bullish closes near their highs.",
    "3 Black Crows": "Three consecutive strong bearish closes near their lows.",
    "Bullish Engulfing": "Small down candle fully engulfed by a larger up candle.",
    "Bearish Engulfing": "Small up candle fully engulfed by a larger down candle.",
    "Bullish Harami": "Small up candle inside the body of a prior big down candle.",
    "Bearish Harami": "Small down candle inside the body of a prior big up candle.",
    "Hammer": "Long lower wick after a downtrend; possible bullish reversal.",
    "Hanging Man": "Hammer shape after an uptrend; possible bearish reversal.",
    "Inverted Hammer": "Long upper wick after a downtrend; possible bullish reversal.",
    "Shooting Star": "Long upper wick after an uptrend; possible bearish reversal.",
    "Bullish Marubozu": "Strong close with almost no wicks.",
    "Bearish Marubozu": "Strong sell-off with almost no wicks.",
    "Dragonfly Doji": "Open/close at the top of the range; possible bullish reversal.",
    "Gravestone Doji": "Open/close at the bottom of the range; possible bearish reversal.",
    "Doji": "Open and close nearly equal; indecision."
  };

  const states = {}; // tfKey -> { chart, series, host, points, container, raf, activeLabel }

  /* ---------- candle math helpers ---------- */

  function rangeOf(bar) { return bar.high - bar.low; }
  function bodyOf(bar) { return Math.abs(bar.close - bar.open); }
  function upperWick(bar) { return bar.high - Math.max(bar.open, bar.close); }
  function lowerWick(bar) { return Math.min(bar.open, bar.close) - bar.low; }
  function isBull(bar) { return bar.close > bar.open; }
  function isBear(bar) { return bar.close < bar.open; }
  function midpoint(bar) { return (bar.high + bar.low) / 2; }

  function average(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  }

  function recentValues(bars, index, count, pick) {
    const start = Math.max(0, index - count);
    const values = [];
    for (let i = start; i < index; i++) values.push(pick(bars[i]));
    return values;
  }

  function isDowntrend(bars, index) {
    const closes = recentValues(bars, index, TREND_LOOKBACK, (bar) => bar.close);
    return closes.length > 0 && bars[index].close < average(closes);
  }

  function isUptrend(bars, index) {
    const closes = recentValues(bars, index, TREND_LOOKBACK, (bar) => bar.close);
    return closes.length > 0 && bars[index].close > average(closes);
  }

  function averageRange(bars, index, count) {
    return average(recentValues(bars, index, count, (bar) => bar.high - bar.low));
  }

  /* ---------- pattern detection ---------- */

  // Returns `null` or `{ name, dir, price }` for the candle at `index`.
  // `price` is the anchor used to dock the label (above a bullish candle's
  // high, below a bearish candle's low, centred for neutral ones).
  function classify(bars, index) {
    const bar = bars[index];
    const range = rangeOf(bar);
    if (range <= 0) return null;

    const bod = bodyOf(bar);
    const up = upperWick(bar);
    const lo = lowerWick(bar);
    const bull = isBull(bar);
    const bear = isBear(bar);
    const doji = bod <= range * SMALL_BODY_FACTOR;
    const prev = index > 0 ? bars[index - 1] : null;
    const prev2 = index > 1 ? bars[index - 2] : null;

    // Morning / Evening Star — downtrend, indecision candle, strong reversal.
    if (prev2 && prev) {
      const prevRange = rangeOf(prev);
      const prevBod = bodyOf(prev);
      const indecision = prevRange > 0 && prevBod <= prevRange * 0.5;
      if (isBear(prev2) && !isBear(prev) && indecision && bull &&
          prev.close < prev2.close && bar.close > midpoint(prev2)) {
        return { name: "Morning Star", dir: "bullish", price: bar.high };
      }
      if (isBull(prev2) && !isBull(prev) && indecision && bear &&
          prev.close > prev2.close && bar.close < midpoint(prev2)) {
        return { name: "Evening Star", dir: "bearish", price: bar.low };
      }
    }

    // Three White Soldiers / Three Black Crows.
    if (prev2 && prev) {
      if (isBull(prev2) && isBull(prev) && bull &&
          bar.close > prev.close && prev.close > prev2.close &&
          up <= range * 0.2 && upperWick(prev) <= rangeOf(prev) * 0.2) {
        return { name: "3 White Soldiers", dir: "bullish", price: bar.high };
      }
      if (isBear(prev2) && isBear(prev) && bear &&
          bar.close < prev.close && prev.close < prev2.close &&
          lo <= range * 0.2 && lowerWick(prev) <= rangeOf(prev) * 0.2) {
        return { name: "3 Black Crows", dir: "bearish", price: bar.low };
      }
    }

    // Bullish / Bearish Engulfing.
    if (prev) {
      const prevBod = bodyOf(prev);
      if (bull && isBear(prev) && bod > prevBod &&
          bar.open <= prev.close && bar.close >= prev.open && prevBod > 0) {
        return { name: "Bullish Engulfing", dir: "bullish", price: bar.high };
      }
      if (bear && isBull(prev) && bod > prevBod &&
          bar.open >= prev.close && bar.close <= prev.open && prevBod > 0) {
        return { name: "Bearish Engulfing", dir: "bearish", price: bar.low };
      }
    }

    // Bullish / Bearish Harami.
    if (prev) {
      const prevBod = bodyOf(prev);
      const inside =
        Math.max(bar.open, bar.close) <= Math.max(prev.open, prev.close) &&
        Math.min(bar.open, bar.close) >= Math.min(prev.open, prev.close);
      if (isBear(prev) && bull && bod < prevBod && inside && isDowntrend(bars, index)) {
        return { name: "Bullish Harami", dir: "bullish", price: bar.high };
      }
      if (isBull(prev) && bear && bod < prevBod && inside && isUptrend(bars, index)) {
        return { name: "Bearish Harami", dir: "bearish", price: bar.low };
      }
    }

    // Long lower wick — Hammer (after downtrend) / Hanging Man (after uptrend).
    if (lo >= Math.max(bod * LONG_WICK_FACTOR, range * 0.4) && up <= range * 0.2 && bod > 0 && !doji) {
      return isUptrend(bars, index) && !isDowntrend(bars, index)
        ? { name: "Hanging Man", dir: "bearish", price: bar.low }
        : { name: "Hammer", dir: "bullish", price: bar.high };
    }

    // Long upper wick — Shooting Star (after uptrend) / Inverted Hammer (after downtrend).
    if (up >= Math.max(bod * LONG_WICK_FACTOR, range * 0.4) && lo <= range * 0.2 && bod > 0 && !doji) {
      return isDowntrend(bars, index) && !isUptrend(bars, index)
        ? { name: "Inverted Hammer", dir: "bullish", price: bar.high }
        : { name: "Shooting Star", dir: "bearish", price: bar.low };
    }

    // Marubozu — strong close near both extremes, no real wicks.
    if (bod >= range * 0.8 && up <= range * 0.02 && lo <= range * 0.02) {
      return bull
        ? { name: "Bullish Marubozu", dir: "bullish", price: bar.high }
        : { name: "Bearish Marubozu", dir: "bearish", price: bar.low };
    }

    // Doji family.
    if (doji) {
      if (lo >= range * 0.6 && up <= range * 0.2) return { name: "Dragonfly Doji", dir: "bullish", price: bar.low };
      if (up >= range * 0.6 && lo <= range * 0.2) return { name: "Gravestone Doji", dir: "bearish", price: bar.high };
      return { name: "Doji", dir: "neutral", price: midpoint(bar) };
    }

    return null;
  }

  function detect(bars) {
    const points = [];
    if (!Array.isArray(bars) || bars.length < 4) return points;
    for (let index = 0; index < bars.length && points.length < MAX_POINTS; index++) {
      const bar = bars[index];
      const next = bars[index + 1];
      if (!next) break; // the last candle has no following confirmation
      const result = classify(bars, index);
      if (!result || result.dir === "neutral") continue; // no direction to confirm
      const confirmed = result.dir === "bullish" ? next.close > bar.close : next.close < bar.close;
      if (!confirmed) continue;
      points.push({ time: bar.time, name: result.name, dir: result.dir, high: bar.high, low: bar.low });
    }
    return points;
  }

  /* ---------- box highlight overlay + hover tooltip lookup ---------- */

  // Registers a timeframe's chart/series/host and the detected points.
  // Confirmed pattern candles are marked with an up/down arrow, and the
  // candle's name is looked up via getNameAt() by the hover tooltip.
  function render(tfKey, chart, series, host, points) {
    let state = states[tfKey];
    if (!state) {
      state = { chart, series, host, points: [], container: null, raf: null };
      states[tfKey] = state;
      state.container = document.createElement("div");
      state.container.className = "pattern-layer";
      state.container.setAttribute("aria-hidden", "true");
      host.appendChild(state.container);
      state.chart = chart;
      state.chart.timeScale().subscribeVisibleLogicalRangeChange(function () {
        if (states[tfKey]) schedulePosition(tfKey);
      });
    }
    state.chart = chart;
    state.series = series;
    state.host = host;
    state.points = points;
    schedulePosition(tfKey);
  }

  // Returns `{ name, dir }` for the confirmed pattern at `time`, or null.
  function getNameAt(tfKey, time) {
    const state = states[tfKey];
    if (!state) return null;
    const point = state.points.find((p) => p.time === time);
    return point ? { name: point.name, dir: point.dir } : null;
  }

  function redraw(tfKey) {
    if (states[tfKey]) schedulePosition(tfKey);
  }

  function schedulePosition(tfKey) {
    const state = states[tfKey];
    if (!state || state.raf) return;
    state.raf = requestAnimationFrame(function () {
      state.raf = null;
      position(tfKey);
    });
  }

  function position(tfKey) {
    const state = states[tfKey];
    if (!state || !state.chart || !state.series || !state.container) return;
    state.container.innerHTML = "";
    const points = state.points;

    // Mark every confirmed pattern candle within the visible range: an up
    // arrow above a bullish candle, a down arrow below a bearish one.
    if (points && points.length) {
      const start = Math.max(0, points.length - MAX_MARKERS);
      for (let i = start; i < points.length; i++) {
        const point = points[i];
        const x = state.chart.timeScale().timeToCoordinate(point.time);
        if (x === null || x === undefined) continue;
        const bullish = point.dir === "bullish";
        const y = state.series.priceToCoordinate(bullish ? point.high : point.low);
        if (y === null || y === undefined) continue;
        const marker = document.createElement("div");
        marker.className = "pattern-marker " + point.dir;
        marker.textContent = bullish ? "▲" : "▼";
        marker.style.left = x + "px";
        marker.style.top = (bullish ? y - 4 : y + 4) + "px";
        state.container.appendChild(marker);
      }
    }
  }

  return { detect, render, getNameAt, redraw, clear: function (tfKey) {
    if (states[tfKey]) states[tfKey].points = [];
  } };
})();