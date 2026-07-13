export function buildUserPrompt({ date, pf, marketData, news, fundamentals }) {
  const equity = pf.equityHistory.length ? pf.equityHistory[pf.equityHistory.length - 1].equity : pf.initialCapital;

  const positionLines = Object.keys(pf.positions).length
    ? Object.entries(pf.positions).map(([ticker, p]) => {
        const mark = pf.markPrices[ticker] ?? p.avgPrice;
        const unrealized = p.side === 'long' ? (mark - p.avgPrice) * p.shares : (p.avgPrice - mark) * p.shares;
        return `- ${ticker}: ${p.side.toUpperCase()} ${p.shares} shares @ avg $${p.avgPrice.toFixed(2)}, leverage ${p.leverage}x, last mark $${mark.toFixed(2)}, unrealized P&L $${unrealized.toFixed(2)}`;
      }).join('\n')
    : '(none — 100% cash)';

  const marketLines = marketData.map(d => {
    if (d.error) return `- ${d.ticker}: data unavailable (${d.error})`;
    const headlines = news?.[d.ticker]?.length
      ? '\n  News: ' + news[d.ticker].map(h => `"${h.title}"${h.pubDate ? ` (${h.pubDate})` : ''}`).join('; ')
      : '\n  News: (none found)';
    const f = fundamentals?.find(x => x.ticker === d.ticker);
    const fundamentalsLine = f && !f.error
      ? `\n  Fundamentals (SEC EDGAR, latest quarter ending ${f.fiscalPeriodEnd}): revenue $${fmtLarge(f.revenue)} (YoY ${fmtPct(f.revenueYoY)}), net income $${fmtLarge(f.netIncome)} (YoY ${fmtPct(f.netIncomeYoY)}), diluted EPS $${f.epsDiluted ?? 'N/A'}`
      : `\n  Fundamentals: unavailable (${f?.error || 'not found'})`;
    return `- ${d.ticker}: close $${d.close} (as of ${d.asOfDate}), 1d ${fmtPct(d.change1d)}, 5d ${fmtPct(d.change5d)}, 20d ${fmtPct(d.change20d)}, SMA20 ${d.sma20 ?? 'N/A'}, SMA50 ${d.sma50 ?? 'N/A'}, RSI14 ${d.rsi14 ?? 'N/A'}, MACD ${d.macd ?? 'N/A'}/signal ${d.macdSignal ?? 'N/A'}/hist ${d.macdHistogram ?? 'N/A'}, Bollinger(20,2) ${d.bbLower ?? 'N/A'}-${d.bbMid ?? 'N/A'}-${d.bbUpper ?? 'N/A'}, ATR14 ${d.atr14 ?? 'N/A'}, 20d range $${d.low20d}-$${d.high20d}, volume ${d.volume ?? 'N/A'} (avg20d ${d.avgVolume20d ?? 'N/A'})${headlines}${fundamentalsLine}`;
  }).join('\n');

  return `CURRENT DECISION DATE: ${date}

CURRENT PORTFOLIO STATE:
- Cash: $${pf.cash.toFixed(2)}
- Total Equity (cash + margin + unrealized P&L): $${equity.toFixed(2)}
- Initial Capital: $${pf.initialCapital.toFixed(2)}
- Open Positions:
${positionLines}

MARKET DATA (most recent completed daily session, recent news headlines, and latest quarterly SEC EDGAR fundamentals — no intraday/real-time prices, no analyst ratings, no forward guidance beyond this):
${marketLines}

You may only trade tickers from the market data list above, or choose HOLD. Use only the information given above and in the system prompt — the news headlines are unverified third-party summaries, not confirmed facts, so weigh them accordingly.

DECISION PROCESS (internal reasoning, inspired by the TradingAgents multi-agent debate framework — do this thinking silently, then output only the final fixed-format decision(s)):
1. Identify the 1-3 most interesting candidates across the whole watchlist (or conclude none qualify). You are not limited to a single ticker today — if multiple independent candidates each clear the bar on their own merits, you may act on more than one.
2. For each candidate, argue the BULL case (why this could work) and the BEAR case (why it could fail) using the technical/fundamental/news data above — steelman both sides honestly rather than picking a side first and rationalizing it.
3. Reconcile each candidate's debate into a single view: does the bull or bear case win, and by how much conviction?
4. Risk-manager check, run across ALL candidates you intend to act on together: verify each resulting trade respects the 2% max risk per trade, and that the combined risk/margin usage across every trade today does not violate the daily risk limit or exceed available buying power — if any single trade fails this check, downgrade that one to HOLD regardless of how compelling its bull case was, independent of the others.
5. Only then write the final decision(s) in the exact Output Format specified in the system prompt (one block per ticker acted on, separated by a ⸻ line if there is more than one), with no extra commentary before, between, or after them. Each REASONING section's four bullets should reflect the strongest points from that ticker's internal debate, not a fresh restatement.`;
}

function fmtPct(n) {
  if (n === null || n === undefined) return 'N/A';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

function fmtLarge(n) {
  if (n === null || n === undefined) return 'N/A';
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  return n.toFixed(0);
}
