/* =========================================================
   datasources.js — pluggable market-data source registry
   =========================================================

   Why this file exists (SOLID rationale):

   - Single Responsibility: this file's only job is "given a stock and a
     timeframe, get candle data." app.js's job is UI/state — it no longer
     knows or cares about Yahoo's URL shape, range syntax, or JSON layout.

   - Open/Closed: adding a new data source (a real one, when one exists)
     means adding a new object to SOURCES below and nothing else. No
     existing function needs to change to support it.

   - Liskov Substitution: every entry in SOURCES exposes the exact same
     shape (resolveSymbol / mapInterval / mapRange / rangeRank / buildUrl /
     parseCandles), so app.js can call whichever one is active without
     knowing which it is.

   - Interface Segregation: the shape above is the minimum a caller needs
     for candle fetching — nothing UI-related leaks into it.

   - Dependency Inversion: app.js depends on DataSources.get(id) — an
     abstraction — rather than importing Yahoo-specific functions
     directly. Swapping the active source is a one-line settings change.
*/

window.DataSources = (function () {
  "use strict";

  /* ---------------------------------------------------------
     Yahoo Finance — the only source that's actually usable here.
     Unofficial endpoint, free, no key, but no CORS header of its own
     (routed through the proxy layer in app.js) and occasionally rate-
     limited. Still the best free option available for NSE candle data.
     --------------------------------------------------------- */
  const YahooSource = {
    id: "yahoo",
    label: "Yahoo Finance",
    available: true,

    resolveSymbol(stock) {
      // Indices (^NSEI) and symbols that already carry an exchange suffix
      // (e.g. AAPL.US, RELIANCE.BO) are used as-is; everything else is
      // assumed to be a plain NSE equity symbol.
      if (stock.s.startsWith("^") || stock.s.includes(".")) return stock.s;
      return stock.s + ".NS";
    },

    mapInterval(tfKey) {
      return { M: "1mo", W: "1wk", D: "1d", H: "60m" }[tfKey];
    },

    // How much history to request depends on how many bars are configured
    // to show, smallest bucket that comfortably covers it (with headroom
    // for holidays/gaps) wins — see the bar-count feature for why.
    _rangeBuckets: {
      M: [[12, "1y"], [24, "2y"], [60, "5y"], [120, "10y"], [Infinity, "max"]],
      W: [[52, "1y"], [104, "2y"], [260, "5y"], [520, "10y"], [Infinity, "max"]],
      D: [[63, "3mo"], [126, "6mo"], [252, "1y"], [504, "2y"], [1260, "5y"], [Infinity, "10y"]],
      H: [[31, "5d"], [131, "1mo"], [394, "3mo"], [788, "6mo"], [Infinity, "730d"]]
    },

    mapRange(tfKey, barCount) {
      const n = Math.max(20, barCount || 80);
      const buckets = this._rangeBuckets[tfKey];
      for (let i = 0; i < buckets.length; i++) {
        if (n <= buckets[i][0]) return buckets[i][1];
      }
      return buckets[buckets.length - 1][1];
    },

    // Used to decide "does the cached range already cover a new, larger
    // bar-count setting, or do we need to re-fetch?" — higher rank = wider.
    rangeRank(tfKey, range) {
      return this._rangeBuckets[tfKey].findIndex((b) => b[1] === range);
    },

    buildUrl(symbol, interval, range) {
      // symbol is NOT pre-encoded here on purpose: this full URL gets
      // encoded exactly once, either by the proxy wrapper (as its `quest=`
      // value) or by fetch() itself for a direct call. Encoding here too
      // would double-encode special characters — e.g. ^NSEI's "^" would
      // become %5E here, then %255E once wrapped, which breaks the request.
      return `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}` +
        `?interval=${interval}&range=${range}&includePrePost=false`;
    },

    parseCandles(json) {
      const result = json && json.chart && json.chart.result && json.chart.result[0];
      if (!result || !result.timestamp) return [];
      const ts = result.timestamp;
      const q = result.indicators.quote[0];
      const out = [];
      for (let i = 0; i < ts.length; i++) {
        if (q.open[i] == null || q.high[i] == null || q.low[i] == null || q.close[i] == null) continue;
        out.push({
          time: ts[i],
          open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i],
          volume: q.volume && q.volume[i] != null ? q.volume[i] : 0
        });
      }
      return out;
    }
  };

  // Google Finance was considered and deliberately left out: Google shut
  // down its public Finance API in 2012 and never replaced it. The
  // GOOGLEFINANCE() function only runs inside a Google Sheets cell — not
  // callable from a web page — and even there it has no intraday data and
  // spotty non-US coverage. If a real free endpoint ever surfaces, it
  // drops into REGISTRY below with the exact same shape as YahooSource
  // and nothing else in the app needs to change.

  const REGISTRY = [YahooSource];

  function get(id) {
    const found = REGISTRY.find((s) => s.id === id && s.available);
    return found || YahooSource; // always fall back to the one that actually works
  }

  function list() {
    return REGISTRY.slice();
  }

  return { get, list };
})();
