// Free, no-key market data via Yahoo Finance's public chart endpoint.
// Only historical daily OHLCV up to the most recent completed session — no
// intraday/real-time feed, no news, no fundamentals (matches the trading
// agent's "Available Information" constraints: user/script-supplied data only).

const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/';

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  const recent = values.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < recent.length; i++) {
    const diff = recent[i] - recent[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function pctChange(values, lookback) {
  if (values.length <= lookback) return null;
  const now = values[values.length - 1];
  const then = values[values.length - 1 - lookback];
  if (!then) return null;
  return (now - then) / then;
}

async function fetchOne(ticker) {
  const url = `${YAHOO_CHART_URL}${encodeURIComponent(ticker)}?range=6mo&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Yahoo fetch failed for ${ticker}: HTTP ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`No chart data for ${ticker}`);

  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const dates = [], closes = [], highs = [], lows = [], volumes = [];

  for (let i = 0; i < timestamps.length; i++) {
    const c = quote.close?.[i];
    if (c == null) continue; // skip non-trading / missing bars
    dates.push(new Date(timestamps[i] * 1000).toISOString().slice(0, 10));
    closes.push(c);
    highs.push(quote.high?.[i] ?? c);
    lows.push(quote.low?.[i] ?? c);
    volumes.push(quote.volume?.[i] ?? null);
  }

  if (!closes.length) throw new Error(`No usable bars for ${ticker}`);

  const last = closes.length - 1;
  const closePrice = closes[last];
  const avgVol20 = sma(volumes.filter(v => v != null), 20);

  return {
    ticker,
    asOfDate: dates[last],
    close: round(closePrice),
    change1d: pctChangeRound(closes, 1),
    change5d: pctChangeRound(closes, 5),
    change20d: pctChangeRound(closes, 20),
    sma20: roundOrNull(sma(closes, 20)),
    sma50: roundOrNull(sma(closes, 50)),
    rsi14: roundOrNull(rsi(closes, 14)),
    high20d: round(Math.max(...highs.slice(-20))),
    low20d: round(Math.min(...lows.slice(-20))),
    volume: volumes[last],
    avgVolume20d: avgVol20 ? Math.round(avgVol20) : null
  };
}

function round(n) { return Math.round(n * 100) / 100; }
function roundOrNull(n) { return n === null ? null : round(n); }
function pctChangeRound(values, lookback) {
  const p = pctChange(values, lookback);
  return p === null ? null : Math.round(p * 10000) / 100; // percent, 2dp
}

export async function getMarketData(tickers) {
  const out = [];
  for (const ticker of tickers) {
    try {
      out.push(await fetchOne(ticker));
    } catch (err) {
      out.push({ ticker, error: String(err.message || err) });
    }
  }
  return out;
}
