/* Shared ledger engine — used by both the browser dashboard (app.js) and the
   Node.js daily-trade script (scripts/run-daily.mjs). Pure functions only,
   no DOM / no Node-only APIs, so the same file works in both environments. */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else {
    root.Portfolio = mod;
  }
})(typeof self !== 'undefined' ? self : this, function () {

  const COMMISSION_RATE = 0.0005; // 0.05%
  const SLIPPAGE_RATE = 0.0005;   // 0.05%
  const DEFAULT_INITIAL_CAPITAL = 1000;
  const MAX_LEVERAGE = 10;

  function diffDays(d1, d2) {
    const a = new Date(d1 + 'T00:00:00');
    const b = new Date(d2 + 'T00:00:00');
    return Math.max(0, Math.round((b - a) / 86400000));
  }

  function computePortfolio(state) {
    const initialCapital = state.initialCapital || DEFAULT_INITIAL_CAPITAL;
    const decisions = [...state.decisions].sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (a.seq || 0) - (b.seq || 0);
    });

    let cash = initialCapital;
    const positions = {};
    const markPrices = {};
    const equityHistory = [];
    const trades = [];

    function currentEquity() {
      let eq = cash;
      for (const t in positions) {
        const p = positions[t];
        const mp = markPrices[t] ?? p.avgPrice;
        const unreal = p.side === 'long' ? (mp - p.avgPrice) * p.shares : (p.avgPrice - mp) * p.shares;
        eq += p.marginUsed + unreal;
      }
      return eq;
    }

    for (const d of decisions) {
      const ticker = (d.ticker || '').toUpperCase().trim();
      const leverage = Math.min(MAX_LEVERAGE, Math.max(1, Number(d.leverage) || 1));

      if (d.action === 'MARK') {
        if (ticker) markPrices[ticker] = Number(d.entryPrice) || markPrices[ticker];
      } else if (d.action === 'HOLD') {
        if (ticker && d.entryPrice) markPrices[ticker] = Number(d.entryPrice);
      } else if (d.action === 'BUY') {
        const entry = Number(d.entryPrice) || 0;
        const size = Number(d.positionSize) || 0;
        const effPrice = entry * (1 + SLIPPAGE_RATE);
        const notional = size * effPrice;
        const commission = notional * COMMISSION_RATE;
        const margin = notional / leverage;
        cash -= (margin + commission);
        const pos = positions[ticker] || { side: 'long', shares: 0, avgPrice: 0, leverage, marginUsed: 0, openDate: d.date };
        const totalShares = pos.shares + size;
        pos.avgPrice = totalShares > 0 ? (pos.avgPrice * pos.shares + effPrice * size) / totalShares : effPrice;
        pos.shares = totalShares;
        pos.leverage = leverage;
        pos.marginUsed += margin;
        positions[ticker] = pos;
        markPrices[ticker] = entry;
      } else if (d.action === 'SHORT') {
        const entry = Number(d.entryPrice) || 0;
        const size = Number(d.positionSize) || 0;
        const effPrice = entry * (1 - SLIPPAGE_RATE);
        const notional = size * effPrice;
        const commission = notional * COMMISSION_RATE;
        const margin = notional / leverage;
        cash -= (margin + commission);
        const pos = positions[ticker] || { side: 'short', shares: 0, avgPrice: 0, leverage, marginUsed: 0, openDate: d.date };
        const totalShares = pos.shares + size;
        pos.avgPrice = totalShares > 0 ? (pos.avgPrice * pos.shares + effPrice * size) / totalShares : effPrice;
        pos.shares = totalShares;
        pos.leverage = leverage;
        pos.marginUsed += margin;
        positions[ticker] = pos;
        markPrices[ticker] = entry;
      } else if (d.action === 'SELL') {
        const pos = positions[ticker];
        if (pos && pos.side === 'long' && pos.shares > 0) {
          const entry = Number(d.entryPrice) || 0;
          const closeShares = Math.min(Number(d.positionSize) || 0, pos.shares);
          const effPrice = entry * (1 - SLIPPAGE_RATE);
          const proceeds = closeShares * effPrice;
          const commission = proceeds * COMMISSION_RATE;
          const marginReleased = (pos.avgPrice * closeShares) / pos.leverage;
          const pnl = (effPrice - pos.avgPrice) * closeShares;
          cash += marginReleased + pnl - commission;
          trades.push({ ticker, side: 'long', openDate: pos.openDate, closeDate: d.date, shares: closeShares, pnl, holdingDays: diffDays(pos.openDate, d.date) });
          pos.shares -= closeShares;
          pos.marginUsed -= marginReleased;
          if (pos.shares <= 1e-6) delete positions[ticker]; else positions[ticker] = pos;
          markPrices[ticker] = entry;
        }
      } else if (d.action === 'COVER') {
        const pos = positions[ticker];
        if (pos && pos.side === 'short' && pos.shares > 0) {
          const entry = Number(d.entryPrice) || 0;
          const closeShares = Math.min(Number(d.positionSize) || 0, pos.shares);
          const effPrice = entry * (1 + SLIPPAGE_RATE);
          const cost = closeShares * effPrice;
          const commission = cost * COMMISSION_RATE;
          const marginReleased = (pos.avgPrice * closeShares) / pos.leverage;
          const pnl = (pos.avgPrice - effPrice) * closeShares;
          cash += marginReleased + pnl - commission;
          trades.push({ ticker, side: 'short', openDate: pos.openDate, closeDate: d.date, shares: closeShares, pnl, holdingDays: diffDays(pos.openDate, d.date) });
          pos.shares -= closeShares;
          pos.marginUsed -= marginReleased;
          if (pos.shares <= 1e-6) delete positions[ticker]; else positions[ticker] = pos;
          markPrices[ticker] = entry;
        }
      }

      equityHistory.push({ date: d.date, equity: currentEquity(), cash });
    }

    return { initialCapital, cash, positions, markPrices, equityHistory, trades };
  }

  function computeMetrics(pf) {
    const equity = pf.equityHistory.length ? pf.equityHistory[pf.equityHistory.length - 1].equity : pf.initialCapital;
    const totalReturn = (equity - pf.initialCapital) / pf.initialCapital;

    let peak = pf.initialCapital, mdd = 0;
    for (const pt of pf.equityHistory) {
      peak = Math.max(peak, pt.equity);
      mdd = Math.max(mdd, (peak - pt.equity) / peak);
    }

    let sharpe = null;
    if (pf.equityHistory.length > 2) {
      const rets = [];
      for (let i = 1; i < pf.equityHistory.length; i++) {
        const prev = pf.equityHistory[i - 1].equity;
        if (prev > 0) rets.push(pf.equityHistory[i].equity / prev - 1);
      }
      if (rets.length > 1) {
        const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
        const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
        const std = Math.sqrt(variance);
        sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : null;
      }
    }

    const wins = pf.trades.filter(t => t.pnl > 0);
    const losses = pf.trades.filter(t => t.pnl <= 0);
    const winRate = pf.trades.length ? (wins.length / pf.trades.length) * 100 : null;
    const avgWin = wins.length ? wins.reduce((a, b) => a + b.pnl, 0) / wins.length : null;
    const avgLoss = losses.length ? losses.reduce((a, b) => a + b.pnl, 0) / losses.length : null;
    const grossWin = wins.reduce((a, b) => a + b.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((a, b) => a + b.pnl, 0));
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null);
    const avgHold = pf.trades.length ? pf.trades.reduce((a, b) => a + b.holdingDays, 0) / pf.trades.length : null;

    let monthlyReturn = null;
    if (pf.equityHistory.length > 1) {
      const firstDate = pf.equityHistory[0].date;
      const lastDate = pf.equityHistory[pf.equityHistory.length - 1].date;
      const days = Math.max(1, diffDays(firstDate, lastDate));
      monthlyReturn = Math.pow(1 + totalReturn, 30 / days) - 1;
    }

    return {
      equity, totalReturn, mdd, sharpe, winRate, avgWin, avgLoss, profitFactor,
      numberOfTrades: pf.trades.length, avgHold, monthlyReturn
    };
  }

  return {
    COMMISSION_RATE, SLIPPAGE_RATE, DEFAULT_INITIAL_CAPITAL, MAX_LEVERAGE,
    diffDays, computePortfolio, computeMetrics
  };
});
