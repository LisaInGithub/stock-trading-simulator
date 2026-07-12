export function buildUserPrompt({ date, pf, marketData, news }) {
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
    return `- ${d.ticker}: close $${d.close} (as of ${d.asOfDate}), 1d ${fmtPct(d.change1d)}, 5d ${fmtPct(d.change5d)}, 20d ${fmtPct(d.change20d)}, SMA20 ${d.sma20 ?? 'N/A'}, SMA50 ${d.sma50 ?? 'N/A'}, RSI14 ${d.rsi14 ?? 'N/A'}, MACD ${d.macd ?? 'N/A'}/signal ${d.macdSignal ?? 'N/A'}/hist ${d.macdHistogram ?? 'N/A'}, Bollinger(20,2) ${d.bbLower ?? 'N/A'}-${d.bbMid ?? 'N/A'}-${d.bbUpper ?? 'N/A'}, ATR14 ${d.atr14 ?? 'N/A'}, 20d range $${d.low20d}-$${d.high20d}, volume ${d.volume ?? 'N/A'} (avg20d ${d.avgVolume20d ?? 'N/A'})${headlines}`;
  }).join('\n');

  return `CURRENT DECISION DATE: ${date}

CURRENT PORTFOLIO STATE:
- Cash: $${pf.cash.toFixed(2)}
- Total Equity (cash + margin + unrealized P&L): $${equity.toFixed(2)}
- Initial Capital: $${pf.initialCapital.toFixed(2)}
- Open Positions:
${positionLines}

MARKET DATA (most recent completed daily session only, plus recent news headlines — no intraday/real-time prices, no financial statements or earnings data available beyond this):
${marketLines}

You may only trade tickers from the market data list above, or choose HOLD. Use only the information given above and in the system prompt — the news headlines are unverified third-party summaries, not confirmed facts, so weigh them accordingly. Now produce today's single trading decision in the exact Output Format specified in the system prompt, with no extra commentary before or after it.`;
}

function fmtPct(n) {
  if (n === null || n === undefined) return 'N/A';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}
