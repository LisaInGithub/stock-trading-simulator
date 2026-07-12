/* ---------- constants ---------- */
const STORAGE_KEY = 'stw_state_v1';
const REMOTE_DATA_URL = 'data/decisions.json';
const { COMMISSION_RATE, DEFAULT_INITIAL_CAPITAL, MAX_LEVERAGE, computePortfolio: computePortfolioPure, computeMetrics } = window.Portfolio;

/* ---------- state ---------- */
// state.decisions is the AI-generated canonical log fetched from data/decisions.json
// (committed by the GitHub Actions daily-trade workflow). localState.decisions is an
// optional local-only sandbox layer (manual form below) that only exists in this browser.
function loadLocalState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* corrupted, fall through */ }
  return { decisions: [] };
}

function saveLocalState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(localState));
}

let remoteState = { initialCapital: DEFAULT_INITIAL_CAPITAL, decisions: [] };
let localState = loadLocalState();
let sandboxMode = false; // becomes true once the user adds a manual local entry

function activeState() {
  if (!sandboxMode) return remoteState;
  return {
    initialCapital: remoteState.initialCapital,
    decisions: [...remoteState.decisions, ...localState.decisions]
  };
}

function computePortfolio() {
  return computePortfolioPure(activeState());
}

/* ---------- helpers ---------- */
const fmtMoney = n => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = n => (n >= 0 ? '+' : '') + (n * 100).toFixed(2) + '%';
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

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
  renderLog();
  renderMarkTickerOptions(pf);
  renderSandboxBanner();
}

function renderSandboxBanner() {
  let el = document.getElementById('sandboxBanner');
  if (!sandboxMode) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.id = 'sandboxBanner';
    el.className = 'sandbox-banner';
    document.querySelector('.app').insertBefore(el, document.querySelector('.summary-grid'));
  }
  el.textContent = '⚠ 目前顯示包含本機測試決策（不會出現在其他裝置或正式部署上）。可在下方「本機測試」區塊清除。';
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

  ctx.strokeStyle = 'rgba(147,161,199,0.35)';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(pad, y(pf.initialCapital));
  ctx.lineTo(cssWidth - pad, y(pf.initialCapital));
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = '#4f7cff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((p, i) => {
    const px = x(i), py = y(p.equity);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
  ctx.stroke();

  const grad = ctx.createLinearGradient(0, 0, 0, cssHeight);
  grad.addColorStop(0, 'rgba(79,124,255,0.25)');
  grad.addColorStop(1, 'rgba(79,124,255,0)');
  ctx.lineTo(x(points.length - 1), cssHeight - pad);
  ctx.lineTo(x(0), cssHeight - pad);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  const lastI = points.length - 1;
  ctx.fillStyle = '#4f7cff';
  ctx.beginPath();
  ctx.arc(x(lastI), y(points[lastI].equity), 3.5, 0, Math.PI * 2);
  ctx.fill();

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

function renderLog() {
  const tbody = document.querySelector('#logTable tbody');
  tbody.innerHTML = '';
  const all = activeState().decisions;
  const sorted = [...all].sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : (b.seq || 0) - (a.seq || 0)));
  document.getElementById('logEmpty').style.display = sorted.length ? 'none' : 'block';

  for (const d of sorted) {
    const isLocal = !!d._local;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${d.date}${isLocal ? ' <span class="pill" style="background:rgba(147,161,199,0.15);color:var(--text-dim)">本機</span>' : ''}</td>
      <td><span class="pill ${d.action}">${d.action}</span></td>
      <td>${d.ticker || '-'}</td>
      <td>${d.entryPrice ? fmtMoney(Number(d.entryPrice)) : '-'}</td>
      <td>${d.positionSize || '-'}</td>
      <td>${d.leverage ? d.leverage + 'x' : '-'}</td>
      <td>${d.confidence ?? '-'}</td>
      <td>${d.riskLevel ? `<span class="pill ${d.riskLevel}">${d.riskLevel}</span>` : '-'}</td>
      <td class="wrap">${d.reasoning ? escapeHtml(d.reasoning) : ''}</td>
      <td>${isLocal ? `<button class="icon-btn" data-id="${d.id}" title="刪除">✕</button>` : ''}</td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('.icon-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm('確定要刪除這筆本機測試決策嗎？')) return;
      localState.decisions = localState.decisions.filter(d => d.id !== btn.dataset.id);
      saveLocalState();
      sandboxMode = localState.decisions.length > 0;
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

/* ---------- form: decision (local sandbox only) ---------- */
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
  const leverage = Math.min(MAX_LEVERAGE, Math.max(1, Number(fd.get('leverage')) || 1));
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
    seq: 100000 + localState.decisions.length, // keep local entries ordered after remote ones on same date
    date: fd.get('date'),
    action,
    ticker,
    entryPrice: fd.get('entryPrice') || '',
    positionSize: fd.get('positionSize') || '',
    leverage: Math.min(MAX_LEVERAGE, Math.max(1, Number(fd.get('leverage')) || 1)),
    stopLoss: fd.get('stopLoss') || '',
    takeProfit: fd.get('takeProfit') || '',
    confidence: fd.get('confidence') || '',
    riskLevel: fd.get('riskLevel') || '',
    reasoning: fd.get('reasoning') || '',
    _local: true
  };

  localState.decisions.push(decision);
  saveLocalState();
  sandboxMode = true;
  decisionForm.reset();
  decisionForm.querySelector('[name="date"]').value = todayStr();
  decisionForm.querySelector('[name="leverage"]').value = 1;
  formError.textContent = '';
  calcPreview.textContent = '';
  calcPreview.className = 'calc-preview';
  render();
});

/* ---------- form: mark price (local sandbox only) ---------- */
const markForm = document.getElementById('markForm');
markForm.addEventListener('submit', e => {
  e.preventDefault();
  const fd = new FormData(markForm);
  const ticker = fd.get('ticker');
  if (!ticker) return;
  localState.decisions.push({
    id: uid(),
    seq: 100000 + localState.decisions.length,
    date: fd.get('date'),
    action: 'MARK',
    ticker,
    entryPrice: fd.get('price'),
    positionSize: '', leverage: '', stopLoss: '', takeProfit: '',
    confidence: '', riskLevel: '', reasoning: '(市價標記)',
    _local: true
  });
  saveLocalState();
  sandboxMode = true;
  markForm.reset();
  markForm.querySelector('[name="date"]').value = todayStr();
  render();
});

/* ---------- export / import / reset ---------- */
document.getElementById('btnExport').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(activeState(), null, 2)], { type: 'application/json' });
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
      localState = { decisions: parsed.decisions.map(d => ({ ...d, _local: true })) };
      saveLocalState();
      sandboxMode = localState.decisions.length > 0;
      render();
      alert('已匯入為本機測試資料。');
    } catch (err) {
      alert('檔案格式錯誤，無法匯入。');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

document.getElementById('btnReset').addEventListener('click', () => {
  if (!confirm('這會清除本機測試決策（不影響 AI 正式交易紀錄），確定嗎？')) return;
  localState = { decisions: [] };
  saveLocalState();
  sandboxMode = false;
  render();
});

/* ---------- init ---------- */
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

window.addEventListener('resize', () => render());

decisionForm.querySelector('[name="date"]').value = todayStr();
markForm.querySelector('[name="date"]').value = todayStr();

fetch(REMOTE_DATA_URL, { cache: 'no-store' })
  .then(r => (r.ok ? r.json() : null))
  .then(data => {
    if (data && Array.isArray(data.decisions)) {
      remoteState = { initialCapital: Number(data.initialCapital) || DEFAULT_INITIAL_CAPITAL, decisions: data.decisions };
    }
  })
  .catch(() => { /* offline / file:// — fall back to defaults */ })
  .finally(render);
