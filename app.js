/* ---------- constants ---------- */
const STORAGE_KEY = 'stw_state_v1';
const COMMISSION_RATE = 0.0005; // 0.05%
const SLIPPAGE_RATE = 0.0005;   // 0.05%
const DEFAULT_INITIAL_CAPITAL = 1000;

/* ---------- state ---------- */
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* corrupted, fall through */ }
  return { initialCapital: DEFAULT_INITIAL_CAPITAL, decisions: [] };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

let state = loadState();

/* ---------- helpers ---------- */
const fmtMoney = n => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = n => (n >= 0 ? '+' : '') + (n * 100).toFixed(2) + '%';
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function diffDays(d1, d2) {
  const a = new Date(d1 + 'T00:00:00');
  const b = new Date(d2 + 'T00:00:00');
  return Math.max(0, Math.round((b - a) / 86400000));
}

/* ---------- core replay engine ---------- */
function computePortfolio() {
  const initialCapital = state.initialCapital || DEFAULT_INITIAL_CAPITAL;
  const decisions = [...state.decisions].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.seq - b.seq;
  });

  let cash = initialCapital;
  const positions = {};   // ticker -> {side, shares, avgPrice, leverage, marginUsed, openDate}
  const markPrices = {};  // ticker -> last known price
  const equityHistory = []; // {date, equity, cash}
  const trades = [];         // realized closes

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
    const leverage = Math.min(10, Math.max(1, Number(d.leverage) || 1));

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

/* ---------- metrics ---------- */
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

/* ---------- rendering ---------- */
function render() {
  const pf = computePortfolio();
  const m = computeMetrics(pf);

  document.getElementById('statEquity').textContent = fmtMoney(m.equity);
  const delta = document.getElementById('statEquityDelta');
  delta.textContent = fmtPct(m.totalReturn) + ' 相對初始資金';
  delta.className = 'delta ' + (m.totalReturn > 0 ? 'up' : m.totalReturn < 0 ? 'down' : 'muted');

  document.getElementById('statCash').textContent = fmtMoney(pf.cash);
  document.getElementById('statTotalReturn').textContent = fmtPct(m.totalReturn);
  document.getElementById('statInitial').textContent = '初始資金 ' + fmtMoney(pf.initialCapital);
  document.getElementById('statMDD').textContent = '-' + (m.mdd * 100).toFixed(2) + '%';

  renderChart(pf);
  renderPositions(pf);
  renderMetrics(m);
  renderLog(pf);
  renderMarkTickerOptions(pf);
}

function renderChart(pf) {
  const canvas = document.getElementById('equityChart');
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.parentElement.clientWidth;
  const cssHeight = 220;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  canvas.style.width = cssWidth + 'px';
  canvas.style.height = cssHeight + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const points = pf.equityHistory.length
    ? pf.equityHistory
    : [{ date: 'start', equity: pf.initialCapital }];

  const values = points.map(p => p.equity).concat([pf.initialCapital]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = 28;
  const spanY = (max - min) || 1;

  const x = i => points.length > 1 ? pad + (i / (points.length - 1)) * (cssWidth - pad * 2) : cssWidth / 2;
  const y = v => cssHeight - pad - ((v - min) / spanY) * (cssHeight - pad * 2);

  // baseline (initial capital)
  ctx.strokeStyle = 'rgba(147,161,199,0.35)';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(pad, y(pf.initialCapital));
  ctx.lineTo(cssWidth - pad, y(pf.initialCapital));
  ctx.stroke();
  ctx.setLineDash([]);

  // equity line
  ctx.strokeStyle = '#4f7cff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((p, i) => {
    const px = x(i), py = y(p.equity);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
  ctx.stroke();

  // fill
  const grad = ctx.createLinearGradient(0, 0, 0, cssHeight);
  grad.addColorStop(0, 'rgba(79,124,255,0.25)');
  grad.addColorStop(1, 'rgba(79,124,255,0)');
  ctx.lineTo(x(points.length - 1), cssHeight - pad);
  ctx.lineTo(x(0), cssHeight - pad);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // last point dot
  const lastI = points.length - 1;
  ctx.fillStyle = '#4f7cff';
  ctx.beginPath();
  ctx.arc(x(lastI), y(points[lastI].equity), 3.5, 0, Math.PI * 2);
  ctx.fill();

  // labels
  ctx.fillStyle = '#93a1c7';
  ctx.font = '11px -apple-system, sans-serif';
  ctx.fillText(fmtMoney(max), 4, 12);
  ctx.fillText(fmtMoney(min), 4, cssHeight - 18);
  if (points.length && points[0].date !== 'start') {
    ctx.fillText(points[0].date, pad, cssHeight - 4);
    ctx.textAlign = 'right';
    ctx.fillText(points[lastI].date, cssWidth - pad, cssHeight - 4);
    ctx.textAlign = 'left';
  }
}

function renderPositions(pf) {
  const tbody = document.querySelector('#positionsTable tbody');
  tbody.innerHTML = '';
  const tickers = Object.keys(pf.positions);
  document.getElementById('positionsEmpty').style.display = tickers.length ? 'none' : 'block';

  for (const t of tickers) {
    const p = pf.positions[t];
    const mp = pf.markPrices[t] ?? p.avgPrice;
    const unreal = p.side === 'long' ? (mp - p.avgPrice) * p.shares : (p.avgPrice - mp) * p.shares;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${t}</td>
      <td><span class="pill ${p.side}">${p.side === 'long' ? 'LONG' : 'SHORT'}</span></td>
      <td>${p.shares.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
      <td>${fmtMoney(p.avgPrice)}</td>
      <td>${p.leverage}x</td>
      <td>${fmtMoney(mp)}</td>
      <td class="${unreal >= 0 ? 'pos' : 'neg'}">${fmtMoney(unreal)}</td>
      <td>${fmtMoney(p.marginUsed)}</td>
      <td></td>
    `;
    tbody.appendChild(tr);
  }
}

function metricBlock(label, value) {
  return `<div class="metric"><span class="label">${label}</span><span class="value">${value}</span></div>`;
}

function renderMetrics(m) {
  const grid = document.getElementById('metricsGrid');
  grid.innerHTML = [
    metricBlock('總報酬率', fmtPct(m.totalReturn)),
    metricBlock('估計月報酬率', m.monthlyReturn === null ? 'N/A' : fmtPct(m.monthlyReturn)),
    metricBlock('勝率 Win Rate', m.winRate === null ? 'N/A' : m.winRate.toFixed(1) + '%'),
    metricBlock('平均獲利', m.avgWin === null ? 'N/A' : fmtMoney(m.avgWin)),
    metricBlock('平均虧損', m.avgLoss === null ? 'N/A' : fmtMoney(m.avgLoss)),
    metricBlock('獲利因子 Profit Factor', m.profitFactor === null ? 'N/A' : (m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2))),
    metricBlock('最大回撤 MDD', '-' + (m.mdd * 100).toFixed(2) + '%'),
    metricBlock('Sharpe Ratio', m.sharpe === null ? 'N/A' : m.sharpe.toFixed(2)),
    metricBlock('交易次數', m.numberOfTrades),
    metricBlock('平均持有天數', m.avgHold === null ? 'N/A' : m.avgHold.toFixed(1) + ' 天')
  ].join('');
}

function renderLog(pf) {
  const tbody = document.querySelector('#logTable tbody');
  tbody.innerHTML = '';
  const sorted = [...state.decisions].sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : b.seq - a.seq));
  document.getElementById('logEmpty').style.display = sorted.length ? 'none' : 'block';

  for (const d of sorted) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${d.date}</td>
      <td><span class="pill ${d.action}">${d.action}</span></td>
      <td>${d.ticker || '-'}</td>
      <td>${d.entryPrice ? fmtMoney(Number(d.entryPrice)) : '-'}</td>
      <td>${d.positionSize || '-'}</td>
      <td>${d.leverage ? d.leverage + 'x' : '-'}</td>
      <td>${d.confidence ?? '-'}</td>
      <td>${d.riskLevel ? `<span class="pill ${d.riskLevel}">${d.riskLevel}</span>` : '-'}</td>
      <td class="wrap">${d.reasoning ? escapeHtml(d.reasoning) : ''}</td>
      <td><button class="icon-btn" data-id="${d.id}" title="刪除">✕</button></td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('.icon-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm('確定要刪除這筆決策紀錄嗎？此動作會重新計算整個投資組合。')) return;
      state.decisions = state.decisions.filter(d => d.id !== btn.dataset.id);
      saveState();
      render();
    });
  });
}

function renderMarkTickerOptions(pf) {
  const sel = document.getElementById('markTickerSelect');
  const current = sel.value;
  const tickers = Object.keys(pf.positions);
  sel.innerHTML = tickers.length
    ? tickers.map(t => `<option value="${t}">${t}</option>`).join('')
    : '<option value="">（無持倉）</option>';
  if (tickers.includes(current)) sel.value = current;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- form: decision ---------- */
const decisionForm = document.getElementById('decisionForm');
const calcPreview = document.getElementById('calcPreview');
const formError = document.getElementById('formError');

function getExistingPosition(ticker) {
  const pf = computePortfolio();
  return pf.positions[(ticker || '').toUpperCase().trim()];
}

function updateCalcPreview() {
  const fd = new FormData(decisionForm);
  const action = fd.get('action');
  const ticker = (fd.get('ticker') || '').toUpperCase().trim();
  const entryPrice = Number(fd.get('entryPrice')) || 0;
  const positionSize = Number(fd.get('positionSize')) || 0;
  const leverage = Math.min(10, Math.max(1, Number(fd.get('leverage')) || 1));
  const stopLoss = Number(fd.get('stopLoss')) || 0;
  const takeProfit = Number(fd.get('takeProfit')) || 0;

  formError.textContent = '';

  if (action === 'HOLD') {
    calcPreview.className = 'calc-preview';
    calcPreview.textContent = 'HOLD：不會變動現金或持倉，只記錄當日決策理由。';
    return;
  }

  if (!ticker) {
    calcPreview.className = 'calc-preview';
    calcPreview.textContent = '請輸入股票代號以預覽計算結果。';
    return;
  }

  const existing = getExistingPosition(ticker);
  let conflict = '';
  if (action === 'BUY' && existing && existing.side === 'short') conflict = `${ticker} 目前是 SHORT 部位，請先送出 COVER 再 BUY。`;
  if (action === 'SHORT' && existing && existing.side === 'long') conflict = `${ticker} 目前是 LONG 部位，請先送出 SELL 再 SHORT。`;
  if (action === 'SELL' && (!existing || existing.side !== 'long')) conflict = `${ticker} 目前沒有 LONG 部位可供 SELL。`;
  if (action === 'COVER' && (!existing || existing.side !== 'short')) conflict = `${ticker} 目前沒有 SHORT 部位可供 COVER。`;
  if ((action === 'SELL' || action === 'COVER') && existing && positionSize > existing.shares + 1e-6) {
    conflict = `數量超過目前持倉（最多 ${existing.shares}股）。`;
  }

  if (conflict) {
    calcPreview.className = 'calc-preview err';
    calcPreview.textContent = conflict;
    return;
  }

  const pf = computePortfolio();
  const equityNow = pf.equityHistory.length ? pf.equityHistory[pf.equityHistory.length - 1].equity : pf.initialCapital;

  const notional = positionSize * entryPrice;
  const commission = notional * COMMISSION_RATE;
  const margin = notional / leverage;

  let riskPct = null, rr = null;
  if ((action === 'BUY' || action === 'SHORT') && stopLoss > 0 && entryPrice > 0) {
    const riskPerShare = action === 'BUY' ? (entryPrice - stopLoss) : (stopLoss - entryPrice);
    const riskDollar = riskPerShare * positionSize;
    riskPct = equityNow > 0 ? (riskDollar / equityNow) * 100 : null;
    if (takeProfit > 0) {
      const rewardPerShare = action === 'BUY' ? (takeProfit - entryPrice) : (entryPrice - takeProfit);
      rr = riskPerShare > 0 ? (rewardPerShare / riskPerShare) : null;
    }
  }

  let text = `交易金額 ${fmtMoney(notional)} ・ 預估手續費+滑點 ${fmtMoney(commission)} ・ 佔用保證金 ${fmtMoney(margin)}（槓桿 ${leverage}x）`;
  if (riskPct !== null) {
    text += ` ・ 預估風險 ${riskPct.toFixed(2)}% of equity`;
    if (riskPct > 2) text += '（超過建議的 2% 上限）';
  }
  if (rr !== null) text += ` ・ 風險報酬比 1:${rr.toFixed(2)}`;

  calcPreview.className = 'calc-preview' + (riskPct !== null && riskPct > 2 ? ' err' : '');
  calcPreview.textContent = text;
}

decisionForm.addEventListener('input', updateCalcPreview);
decisionForm.querySelector('[name="action"]').addEventListener('change', updateCalcPreview);

decisionForm.addEventListener('submit', e => {
  e.preventDefault();
  const fd = new FormData(decisionForm);
  const action = fd.get('action');
  const ticker = (fd.get('ticker') || '').toUpperCase().trim();

  if (action !== 'HOLD' && !ticker) {
    formError.textContent = '此動作需要輸入股票代號。';
    return;
  }
  if (action !== 'HOLD' && (!fd.get('entryPrice') || !fd.get('positionSize'))) {
    formError.textContent = '請填寫進場價與部位大小。';
    return;
  }
  if (calcPreview.classList.contains('err') && ['BUY', 'SELL', 'SHORT', 'COVER'].includes(action)) {
    const existing = getExistingPosition(ticker);
    const blocking =
      (action === 'BUY' && existing && existing.side === 'short') ||
      (action === 'SHORT' && existing && existing.side === 'long') ||
      (action === 'SELL' && (!existing || existing.side !== 'long')) ||
      (action === 'COVER' && (!existing || existing.side !== 'short'));
    if (blocking) {
      formError.textContent = '請先解決上方顯示的部位衝突再送出。';
      return;
    }
  }

  const decision = {
    id: uid(),
    seq: state.decisions.length,
    date: fd.get('date'),
    action,
    ticker,
    entryPrice: fd.get('entryPrice') || '',
    positionSize: fd.get('positionSize') || '',
    leverage: Math.min(10, Math.max(1, Number(fd.get('leverage')) || 1)),
    stopLoss: fd.get('stopLoss') || '',
    takeProfit: fd.get('takeProfit') || '',
    confidence: fd.get('confidence') || '',
    riskLevel: fd.get('riskLevel') || '',
    reasoning: fd.get('reasoning') || ''
  };

  state.decisions.push(decision);
  saveState();
  decisionForm.reset();
  decisionForm.querySelector('[name="date"]').value = todayStr();
  decisionForm.querySelector('[name="leverage"]').value = 1;
  formError.textContent = '';
  calcPreview.textContent = '';
  calcPreview.className = 'calc-preview';
  render();
});

/* ---------- form: mark price ---------- */
const markForm = document.getElementById('markForm');
markForm.addEventListener('submit', e => {
  e.preventDefault();
  const fd = new FormData(markForm);
  const ticker = fd.get('ticker');
  if (!ticker) return;
  state.decisions.push({
    id: uid(),
    seq: state.decisions.length,
    date: fd.get('date'),
    action: 'MARK',
    ticker,
    entryPrice: fd.get('price'),
    positionSize: '', leverage: '', stopLoss: '', takeProfit: '',
    confidence: '', riskLevel: '', reasoning: '(市價標記)'
  });
  saveState();
  markForm.reset();
  markForm.querySelector('[name="date"]').value = todayStr();
  render();
});

/* ---------- export / import / reset ---------- */
document.getElementById('btnExport').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `stock-trading-backup-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('btnImport').addEventListener('click', () => {
  document.getElementById('fileImport').click();
});

document.getElementById('fileImport').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!Array.isArray(parsed.decisions)) throw new Error('invalid');
      state = { initialCapital: Number(parsed.initialCapital) || DEFAULT_INITIAL_CAPITAL, decisions: parsed.decisions };
      saveState();
      render();
      alert('匯入成功。');
    } catch (err) {
      alert('檔案格式錯誤，無法匯入。');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

document.getElementById('btnReset').addEventListener('click', () => {
  if (!confirm('這會清空所有交易紀錄並重設為初始資金 $1000，確定嗎？建議先匯出備份。')) return;
  state = { initialCapital: DEFAULT_INITIAL_CAPITAL, decisions: [] };
  saveState();
  render();
});

/* ---------- init ---------- */
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

window.addEventListener('resize', () => render());

decisionForm.querySelector('[name="date"]').value = todayStr();
markForm.querySelector('[name="date"]').value = todayStr();
render();
