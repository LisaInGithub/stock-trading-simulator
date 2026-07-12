// Parses the model's fixed-format reply (defined in prompt/system-prompt.txt's
// "Output Format" section) into a structured decision object. We deliberately
// do NOT trust the model's own "PORTFOLIO AFTER EXECUTION" arithmetic — the
// ledger in scripts/portfolio.js recomputes cash/positions from scratch, so
// only the trade instruction fields (ACTION/TICKER/prices/sizing/reasoning)
// are extracted here.

const LABELS = [
  'DATE', 'ACTION', 'TICKER', 'ENTRY PRICE', 'POSITION SIZE', 'LEVERAGE',
  'STOP LOSS', 'TAKE PROFIT', 'EXPECTED RISK (%)', 'EXPECTED REWARD (%)',
  'RISK-REWARD RATIO', 'CONFIDENCE', 'RISK LEVEL', 'REASONING',
  'PORTFOLIO AFTER EXECUTION'
];

function buildLabelRegex(label) {
  // escape regex special chars in label, then match "LABEL" optionally
  // followed by ":" at the start of a line
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${escaped}\\s*:?\\s*$`, 'im');
}

function extractSections(text) {
  const positions = [];
  for (const label of LABELS) {
    const re = buildLabelRegex(label);
    const m = re.exec(text);
    if (m) positions.push({ label, index: m.index, end: m.index + m[0].length });
  }
  positions.sort((a, b) => a.index - b.index);

  const sections = {};
  for (let i = 0; i < positions.length; i++) {
    const cur = positions[i];
    const next = positions[i + 1];
    const raw = text.slice(cur.end, next ? next.index : text.length);
    sections[cur.label] = raw.trim();
  }
  return sections;
}

function firstLine(s) {
  if (!s) return '';
  return s.split('\n')[0].trim();
}

function toNumber(s) {
  if (!s) return null;
  const m = String(s).replace(/[, $%]/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

export function parseDecision(rawText) {
  const sections = extractSections(rawText);

  const action = firstLine(sections['ACTION']).toUpperCase().replace(/[^A-Z]/g, '');
  const validActions = ['BUY', 'SELL', 'SHORT', 'COVER', 'HOLD'];
  const safeAction = validActions.includes(action) ? action : 'HOLD';

  const ticker = firstLine(sections['TICKER']).toUpperCase().replace(/[^A-Z.]/g, '');

  return {
    action: safeAction,
    ticker: safeAction === 'HOLD' ? (ticker || '') : ticker,
    entryPrice: toNumber(sections['ENTRY PRICE']),
    positionSize: toNumber(sections['POSITION SIZE']),
    leverage: toNumber(sections['LEVERAGE']) || 1,
    stopLoss: toNumber(sections['STOP LOSS']),
    takeProfit: toNumber(sections['TAKE PROFIT']),
    expectedRisk: toNumber(sections['EXPECTED RISK (%)']),
    expectedReward: toNumber(sections['EXPECTED REWARD (%)']),
    riskRewardRatio: sections['RISK-REWARD RATIO'] ? firstLine(sections['RISK-REWARD RATIO']) : '',
    confidence: toNumber(sections['CONFIDENCE']),
    riskLevel: (() => {
      const l = firstLine(sections['RISK LEVEL']);
      if (/high/i.test(l)) return 'High';
      if (/medium/i.test(l)) return 'Medium';
      if (/low/i.test(l)) return 'Low';
      return '';
    })(),
    reasoning: (sections['REASONING'] || '').trim(),
    rawResponse: rawText
  };
}
