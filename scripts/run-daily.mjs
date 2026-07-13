import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMarketData } from './fetch-market-data.mjs';
import { getNewsForTickers } from './fetch-news.mjs';
import { getFundamentals } from './fetch-fundamentals.mjs';
import { buildUserPrompt } from './build-prompt.mjs';
import { callClaude } from './call-claude.mjs';
import { parseDecisions } from './parse-decision.mjs';

const require = createRequire(import.meta.url);
const Portfolio = require('./portfolio.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DECISIONS_PATH = path.join(ROOT, 'data', 'decisions.json');
const WATCHLIST_PATH = path.join(ROOT, 'scripts', 'watchlist.json');
const SYSTEM_PROMPT_PATH = path.join(ROOT, 'prompt', 'system-prompt.txt');
const LOGS_DIR = path.join(ROOT, 'data', 'logs');

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

async function loadJson(p, fallback) {
  try {
    return JSON.parse(await readFile(p, 'utf-8'));
  } catch (e) {
    return fallback;
  }
}

function validateAndNormalize(parsed, pf, marketData, watchlist) {
  const notes = [];
  let { action, ticker, entryPrice, positionSize, leverage, stopLoss, takeProfit } = parsed;

  if (action === 'HOLD') {
    return { action: 'HOLD', ticker: ticker || '', entryPrice: null, positionSize: null, leverage: 1, stopLoss: null, takeProfit: null, notes };
  }

  if (!ticker || !watchlist.includes(ticker)) {
    notes.push(`Ticker "${ticker}" not in tradable watchlist — downgraded to HOLD.`);
    return { action: 'HOLD', ticker: '', entryPrice: null, positionSize: null, leverage: 1, stopLoss: null, takeProfit: null, notes };
  }

  const marketEntry = marketData.find(d => d.ticker === ticker && !d.error);
  if (!marketEntry) {
    notes.push(`No market data available for ${ticker} — downgraded to HOLD.`);
    return { action: 'HOLD', ticker: '', entryPrice: null, positionSize: null, leverage: 1, stopLoss: null, takeProfit: null, notes };
  }

  // Never trust the model's stated price — always use the actual fetched close.
  if (entryPrice != null && Math.abs(entryPrice - marketEntry.close) / marketEntry.close > 0.02) {
    notes.push(`Model-stated entry price $${entryPrice} deviated >2% from fetched close $${marketEntry.close}; using fetched close.`);
  }
  entryPrice = marketEntry.close;

  leverage = Math.min(Portfolio.MAX_LEVERAGE, Math.max(1, Number(leverage) || 1));

  if (!positionSize || positionSize <= 0) {
    notes.push('Missing/invalid position size — downgraded to HOLD.');
    return { action: 'HOLD', ticker: '', entryPrice: null, positionSize: null, leverage: 1, stopLoss: null, takeProfit: null, notes };
  }

  const existing = pf.positions[ticker];
  if (action === 'BUY' && existing && existing.side === 'short') {
    notes.push(`${ticker} currently SHORT — cannot BUY without COVER first. Downgraded to HOLD.`);
    return { action: 'HOLD', ticker: '', entryPrice: null, positionSize: null, leverage: 1, stopLoss: null, takeProfit: null, notes };
  }
  if (action === 'SHORT' && existing && existing.side === 'long') {
    notes.push(`${ticker} currently LONG — cannot SHORT without SELL first. Downgraded to HOLD.`);
    return { action: 'HOLD', ticker: '', entryPrice: null, positionSize: null, leverage: 1, stopLoss: null, takeProfit: null, notes };
  }
  if (action === 'BUY' || action === 'SHORT') {
    // Never trust the model's own cash bookkeeping — re-derive the cost of
    // opening/adding to this position against the actually replayed cash
    // balance, since a multi-ticker day can compound margin usage across
    // several sequential trades against the same starting cash pool.
    const slip = action === 'BUY' ? (1 + Portfolio.SLIPPAGE_RATE) : (1 - Portfolio.SLIPPAGE_RATE);
    const effPrice = entryPrice * slip;
    const notional = positionSize * effPrice;
    const commission = notional * Portfolio.COMMISSION_RATE;
    const margin = notional / leverage;
    const cost = margin + commission;
    if (cost > pf.cash + 1e-6) {
      notes.push(`${action} ${ticker} requires $${cost.toFixed(2)} but only $${pf.cash.toFixed(2)} cash is available — downgraded to HOLD.`);
      return { action: 'HOLD', ticker: '', entryPrice: null, positionSize: null, leverage: 1, stopLoss: null, takeProfit: null, notes };
    }
  }
  if (action === 'SELL') {
    if (!existing || existing.side !== 'long') {
      notes.push(`No LONG position in ${ticker} to SELL. Downgraded to HOLD.`);
      return { action: 'HOLD', ticker: '', entryPrice: null, positionSize: null, leverage: 1, stopLoss: null, takeProfit: null, notes };
    }
    if (positionSize > existing.shares + 1e-6) {
      notes.push(`Requested SELL size ${positionSize} exceeds held ${existing.shares}; capped.`);
      positionSize = existing.shares;
    }
  }
  if (action === 'COVER') {
    if (!existing || existing.side !== 'short') {
      notes.push(`No SHORT position in ${ticker} to COVER. Downgraded to HOLD.`);
      return { action: 'HOLD', ticker: '', entryPrice: null, positionSize: null, leverage: 1, stopLoss: null, takeProfit: null, notes };
    }
    if (positionSize > existing.shares + 1e-6) {
      notes.push(`Requested COVER size ${positionSize} exceeds held ${existing.shares}; capped.`);
      positionSize = existing.shares;
    }
  }

  return { action, ticker, entryPrice, positionSize, leverage, stopLoss, takeProfit, notes };
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY environment variable is not set.');

  const watchlist = await loadJson(WATCHLIST_PATH, []);
  const state = await loadJson(DECISIONS_PATH, { initialCapital: Portfolio.DEFAULT_INITIAL_CAPITAL, decisions: [] });
  const pf = Portfolio.computePortfolio(state);

  const marketData = await getMarketData(watchlist);
  const dataAsOfDates = marketData.filter(d => !d.error).map(d => d.asOfDate);
  const latestDataDate = dataAsOfDates.length ? dataAsOfDates.sort().slice(-1)[0] : null;

  const lastDecision = [...state.decisions].sort((a, b) => (a.seq || 0) - (b.seq || 0)).slice(-1)[0];
  const date = todayStr();

  if (lastDecision && lastDecision._dataAsOf && latestDataDate && lastDecision._dataAsOf === latestDataDate) {
    console.log(`Market data unchanged since last run (asOf ${latestDataDate}) — skipping, logging HOLD.`);
    const decision = {
      id: `auto-${date}`,
      seq: state.decisions.length,
      date,
      action: 'HOLD',
      ticker: '',
      entryPrice: '', positionSize: '', leverage: 1, stopLoss: '', takeProfit: '',
      confidence: '', riskLevel: '',
      reasoning: 'No new market data since last run (likely a non-trading day). Auto-HOLD, no Claude API call made.',
      _dataAsOf: latestDataDate
    };
    state.decisions.push(decision);
    await writeFile(DECISIONS_PATH, JSON.stringify(state, null, 2) + '\n');
    return;
  }

  const tradableTickers = watchlist.filter(t => marketData.find(d => d.ticker === t && !d.error));
  const news = await getNewsForTickers(tradableTickers);
  const fundamentals = await getFundamentals(tradableTickers);

  const systemPrompt = await readFile(SYSTEM_PROMPT_PATH, 'utf-8');
  const userPrompt = buildUserPrompt({ date, pf, marketData, news, fundamentals });

  console.log('--- USER PROMPT ---\n' + userPrompt);

  const rawResponse = await callClaude({ systemPrompt, userPrompt, apiKey });
  console.log('--- CLAUDE RESPONSE ---\n' + rawResponse);

  // A single reply may contain multiple ⸻-separated decision blocks (one
  // per ticker) on a multi-stock day. Validate them in order against the
  // portfolio state as it would exist after each prior decision in the
  // same batch, so e.g. a second BUY correctly sees the cash already
  // committed by the first.
  const allParsed = parseDecisions(rawResponse);
  let holdOnly = allParsed.length === 1 && allParsed[0].action === 'HOLD';
  const entries = [];
  let runningState = { initialCapital: state.initialCapital || Portfolio.DEFAULT_INITIAL_CAPITAL, decisions: [...state.decisions] };

  for (const parsed of allParsed) {
    const runningPf = Portfolio.computePortfolio(runningState);
    const normalized = validateAndNormalize(parsed, runningPf, marketData, watchlist);
    if (normalized.action === 'HOLD' && !normalized.ticker && normalized.notes.length === 0 && !holdOnly) {
      // A model-issued HOLD block alongside real trades in the same batch
      // carries no ledger effect — skip it rather than logging a no-op row.
      continue;
    }

    const decision = {
      id: `auto-${date}-${entries.length}`,
      seq: runningState.decisions.length,
      date,
      action: normalized.action,
      ticker: normalized.ticker,
      entryPrice: normalized.entryPrice ?? '',
      positionSize: normalized.positionSize ?? '',
      leverage: normalized.leverage ?? 1,
      stopLoss: normalized.stopLoss ?? '',
      takeProfit: normalized.takeProfit ?? '',
      confidence: parsed.confidence ?? '',
      riskLevel: parsed.riskLevel || '',
      reasoning: [parsed.reasoning, ...normalized.notes].filter(Boolean).join('\n\n[System note] '),
      _dataAsOf: latestDataDate
    };
    entries.push(decision);
    runningState.decisions.push(decision);
  }

  if (entries.length === 0) {
    // Every block collapsed to a no-op HOLD — still record one HOLD row
    // so the log has continuity for this trading day.
    entries.push({
      id: `auto-${date}-0`,
      seq: runningState.decisions.length,
      date,
      action: 'HOLD',
      ticker: '', entryPrice: '', positionSize: '', leverage: 1, stopLoss: '', takeProfit: '',
      confidence: '', riskLevel: '',
      reasoning: allParsed[0]?.reasoning || '',
      _dataAsOf: latestDataDate
    });
  }

  state.decisions.push(...entries);
  state.initialCapital = state.initialCapital || Portfolio.DEFAULT_INITIAL_CAPITAL;
  await writeFile(DECISIONS_PATH, JSON.stringify(state, null, 2) + '\n');

  await mkdir(LOGS_DIR, { recursive: true });
  await writeFile(
    path.join(LOGS_DIR, `${date}.json`),
    JSON.stringify({ date, marketData, news, fundamentals, userPrompt, rawResponse, parsed: allParsed, entries }, null, 2) + '\n'
  );

  console.log(`Logged ${entries.length} decision(s): ` + entries.map(d => `${d.action} ${d.ticker || ''}`.trim()).join(', '));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
