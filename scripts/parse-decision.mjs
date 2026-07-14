// Parses the model's fixed-format reply (defined in prompt/system-prompt.txt's
// "Output Format" section, v2 — Multi-Role Internal Deliberation) into one or
// more structured decision objects. We deliberately do NOT trust the model's
// own "PORTFOLIO AFTER EXECUTION" arithmetic — the ledger in scripts/portfolio.js
// recomputes cash/positions from scratch, so only the trade instruction fields
// (ACTION/TICKER/prices/sizing/reasoning) are extracted here.
//
// v2 allows up to 10 ticker blocks per day, separated by a line containing
// only "⸻", each with its own TICKER/ACTION/.../REASONING. DATE (once, at
// the top) and PORTFOLIO AFTER EXECUTION (once, at the end) are not
// per-block — see parseDecisions() for how blocks are split out.

const LABELS = [
  'DATE', 'ACTION', 'TICKER', 'ENTRY PRICE', 'POSITION SIZE', 'LEVERAGE',
  'STOP LOSS', 'TAKE PROFIT', 'EXPECTED RISK (%)', 'EXPECTED REWARD (%)',
  'RISK-REWARD RATIO', 'CONFIDENCE (0-100)', 'RISK LEVEL', 'REASONING',
  'PORTFOLIO AFTER EXECUTION'
];

function buildLabelRegex(label) {
  // Escape regex special chars in label, then match "LABEL" optionally
  // followed by ":" at the start of a line. Deliberately NOT anchored to the
  // end of the line — v2's template sometimes puts the value inline on the
  // same line as the label ("ACTION: BUY"), sometimes on the next line
  // ("ENTRY PRICE:\n317.31"). Not requiring an end-of-line match lets both
  // conventions fall out of the same slice-between-labels logic below.
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^[ \\t]*${escaped}[ \\t]*:?`, 'im');
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
  const reasoning = (sections['REASONING'] || '').trim();

  // Safety net: the system prompt says a Risk Manager VETO must already force
  // ACTION to HOLD in the model's own output, but don't rely on the model
  // getting that self-consistency right — detect it directly and let
  // run-daily.mjs's validator downgrade regardless of the stated ACTION.
  const riskManagerVetoed = /risk manager sign-?off[^\n]*:\s*[^\n]*vetoed/i.test(reasoning)
    || /\bvetoed\b/i.test(reasoning);

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
    confidence: toNumber(sections['CONFIDENCE (0-100)']),
    riskLevel: (() => {
      const l = firstLine(sections['RISK LEVEL']);
      if (/high/i.test(l)) return 'High';
      if (/medium/i.test(l)) return 'Medium';
      if (/low/i.test(l)) return 'Low';
      return '';
    })(),
    reasoning,
    riskManagerVetoed,
    rawResponse: rawText
  };
}

// Splits a raw model reply into one or more decision blocks. Multiple
// same-day decisions (multi-ticker days) are separated by a line containing
// only "⸻" (see prompt/system-prompt.txt Output Format). A single-decision
// reply has no separator and is returned as one block.
function splitBlocks(rawText) {
  const blocks = rawText
    .split(/^[ \t]*⸻[ \t]*$/m)
    .map(b => b.trim())
    .filter(Boolean);
  // Guard against a stray leading/trailing divider producing an empty
  // block, and against blocks that don't actually contain a decision
  // (e.g. the DATE preamble alone, or a trailing PORTFOLIO AFTER EXECUTION
  // section with no ticker content) by requiring an ACTION label.
  return blocks.filter(b => buildLabelRegex('ACTION').test(b));
}

// Parses a raw model reply that may contain one or more ⸻-separated
// decision blocks (multi-ticker days) into an array of decision objects.
export function parseDecisions(rawText) {
  const blocks = splitBlocks(rawText);
  if (blocks.length === 0) return [parseDecision(rawText)];
  return blocks.map(parseDecision);
}
