# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An AI-driven virtual US stock paper-trading system. An LLM (Claude), constrained by the trading-agent system prompt in `prompt/system-prompt.txt` (v2 — Multi-Role Internal Deliberation), makes one or more BUY/SELL/SHORT/COVER/HOLD decisions per day (up to 10 tickers, one decision block each) against a $1000 virtual account. A static dashboard (deployed to GitHub Pages) displays the resulting portfolio, equity curve, and performance metrics. This repo is unrelated to any other project on this machine — it is a standalone git repo with its own remote (`github.com/LisaInGithub/stock-trading-simulator`).

## Commands

No build step, no package manager dependencies, no test suite — plain HTML/CSS/JS + Node scripts using only built-ins (`fetch`, `fs/promises`).

- **Run the dashboard locally**: `python3 -m http.server 8080` from the repo root, then open `http://localhost:8080/index.html`. Opening `index.html` directly via `file://` breaks the `fetch('data/decisions.json')` call — a local server is required.
- **Run one daily trading decision by hand** (calls the real Anthropic API, requires `ANTHROPIC_API_KEY` in the environment): `node scripts/run-daily.mjs`
- **Fetch market data only** (no API key needed, useful for debugging): `node -e "import('./scripts/fetch-market-data.mjs').then(m => m.getMarketData(['AAPL']).then(console.log))"`

## Architecture

### Decision flow (either automated or manual)

1. `scripts/fetch-market-data.mjs` pulls free daily OHLCV from Yahoo Finance's public chart endpoint (no key) for every ticker in `scripts/watchlist.json`, and derives SMA20/50, RSI14, MACD, Bollinger Bands, ATR14, 20-day range, and % change. `scripts/fetch-news.mjs` adds free Google News RSS headlines per ticker (no key). `scripts/fetch-fundamentals.mjs` adds free SEC EDGAR XBRL fundamentals (revenue/net income/diluted EPS with YoY%, no key) — see the file's comments for why it evaluates multiple revenue tag candidates and keeps the one with the freshest reporting period rather than the first match.
2. `scripts/portfolio.js` replays `data/decisions.json` from scratch to get the current cash/positions/equity (see below — this is the single source of truth for ledger math, shared by both Node and the browser).
3. `scripts/build-prompt.mjs` combines the portfolio state + market data + news + fundamentals into a user prompt appended to the system prompt, and instructs the model to run the system prompt's internal multi-role deliberation (Technical Analyst → Fundamentals Analyst → News/Sentiment Analyst → Bull Researcher → Bear Researcher → Trader synthesis → Risk Manager sign-off) independently per candidate ticker, silently, before outputting only the final decision block(s).
4. `scripts/call-claude.mjs` calls the Anthropic Messages API (`claude-sonnet-5`).
5. `scripts/parse-decision.mjs` parses the model's fixed-format reply into one or more structured decisions — `parseDecisions()` splits a multi-ticker reply on `⸻`-only divider lines (per the Output Format section of the system prompt) and parses each block independently via `parseDecision()`; a reply with no divider is treated as a single decision. Label matching tolerates both "LABEL:\nvalue" and "LABEL: value" (v2's template mixes both conventions across fields). It also flags `riskManagerVetoed` if the REASONING text's Risk Manager Sign-off line contains "VETOED".
6. `scripts/run-daily.mjs` (the orchestrator) validates each parsed decision, in order, before persisting it — **it never trusts the model's stated price** (always substitutes the actual fetched close), downgrades to `HOLD` on any invalid state transition (e.g. `BUY` into an existing `SHORT`, closing more shares than held, an untradable ticker, a vetoed sign-off, or insufficient cash), and re-derives the cash cost of every `BUY`/`SHORT` against the portfolio state as it would exist after the prior decisions in the same batch — so a second or third trade on the same day can't spend cash already committed by an earlier one that day. It then appends all resulting decisions (same `date`, incrementing `seq`) to `data/decisions.json` and writes a full audit snapshot (market data + news + fundamentals + raw model reply + all parsed entries) to `data/logs/<date>.json`.

**Automation is currently paused.** `.github/workflows/daily-trade.yml` has its `schedule:` trigger commented out because no `ANTHROPIC_API_KEY` secret is configured (billing not set up). Until it's re-enabled, daily decisions are added by Claude Code manually: reasoning through the same system prompt live — including the 7-role deliberation process described above, across every candidate worth considering that day, not just one — then writing the decision object(s) directly into `data/decisions.json` (and a matching `data/logs/<date>.json`) in the same shape `run-daily.mjs` would have produced. A single trading day may legitimately produce more than one decision object (one per ticker traded), all sharing the same `date` with distinct, monotonically increasing `seq` values. When editing `data/decisions.json` by hand, always re-validate the JSON parses and keep `seq` monotonically increasing. When presenting analysis to the user in chat, label which source each figure came from (Yahoo Finance / Google News / SEC EDGAR) — the user has asked for this explicitly. The `reasoning` field of each decision is shown verbatim on the dashboard (`app.js`'s log table) — per user request, write it directly in Traditional Chinese (tickers, prices, dates, and percentages stay in Latin/numeral form as usual) so the dashboard is easy to read; this applies to new decisions going forward, and all prior decisions' `reasoning` fields have already been translated.

### `scripts/portfolio.js` is the one file every consumer shares

It's a UMD module — plain CommonJS export for Node (`require('./portfolio.js')`, used by `run-daily.mjs`) *and* a classic global `<script>` include for the browser (`window.Portfolio`, used by `app.js`). This is why `package.json` deliberately has **no** `"type": "module"` — that would make Node treat this `.js` file as ESM and break `require()`/`module.exports`. All other Node-only scripts use the `.mjs` extension instead, which is unambiguous ESM regardless of `package.json`.

`computePortfolio(state)` never mutates incrementally — it replays the full `decisions` array (sorted by `date`, then `seq`) from `initialCapital` every time, applying commission (0.05%) and slippage (0.05%) per trade. This is deliberate: it makes `data/decisions.json` an append-only ledger that can be fully reconstructed/audited, and lets the frontend recompute state after loading fresh data without any separate persistence layer.

### Frontend data flow: remote canonical state + local sandbox

`app.js` fetches `data/decisions.json` on load and treats it as canonical (`remoteState`). The manual "本機測試" (local test) form at the bottom of the page writes to a **separate** `localState` in `localStorage`, tagged with `_local: true`, and is only merged into `activeState()` when `sandboxMode` is on. This keeps ad-hoc UI testing from ever being confused with — or accidentally committed as — real AI-generated trading history. Local-only entries render with a "本機" badge and a dismissible warning banner; only they get a delete button in the log table.

### Trust boundary for AI-generated trades

Everything in `validateAndNormalize()` (inside `scripts/run-daily.mjs`) exists because the model's raw output is not trusted for anything that touches money math — only its *decision intent* (action/ticker/reasoning) is trusted. Price, leverage (clamped 1–10 via `Portfolio.MAX_LEVERAGE`), and position-size legality are all independently re-derived or checked against the replayed portfolio state before being written to disk.
