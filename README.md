# 虛擬美股交易平台（AI Paper Trading Desk）

一個由 AI（Claude）每日自動操作的虛擬美股交易系統。GitHub Actions 每個交易日收盤後自動抓取市場資料、餵給 Claude 依照 [prompt/system-prompt.txt](prompt/system-prompt.txt) 的交易員系統提示做出唯一一筆決策，寫回 `data/decisions.json`；純前端網頁負責顯示投資組合、權益曲線與績效指標。

## 架構

```
GitHub Actions（每日排程，目前已暫停，見下方「目前狀態」）
  └─ scripts/run-daily.mjs
       ├─ scripts/fetch-market-data.mjs   抓 Yahoo Finance 免費日線資料（收盤價/SMA/RSI/MACD/布林通道/ATR/20日高低）
       ├─ scripts/fetch-news.mjs          抓 Google News RSS 免費新聞標題（近3天，每檔最多4則）
       ├─ scripts/fetch-fundamentals.mjs  抓 SEC EDGAR 官方財報數據（營收/淨利/EPS，含年增率）
       ├─ scripts/portfolio.js            重播 decisions.json，算出目前現金/持倉/權益（前端也共用這份邏輯）
       ├─ scripts/build-prompt.mjs        組合「系統提示 + 目前投組 + 市場資料 + 新聞 + 基本面」給 Claude
       ├─ scripts/call-claude.mjs         呼叫 Anthropic API
       └─ scripts/parse-decision.mjs      解析 Claude 輸出的固定格式，驗證後寫回 data/decisions.json
  └─ git commit + push（自動提交 data/decisions.json 與 data/logs/*.json）

index.html + app.js（GitHub Pages 靜態網頁）
  └─ fetch('data/decisions.json') 讀取正式紀錄 → 用 scripts/portfolio.js 重新計算並顯示
```

**安全機制**：Claude 回覆的價格不會被直接信任 —— 一律用 `fetch-market-data.mjs` 實際抓到的收盤價覆蓋；若 ACTION 與目前持倉方向衝突（例如已持有 SHORT 卻輸出 BUY）、代號不在觀察名單、或股數超過可平倉數量，會自動降級為 HOLD 並記錄原因於 reasoning 欄位。新聞標題明確標示為「未經查證的第三方摘要」，提示模型不要照單全收。

## 目前狀態：手動模式

目前還沒有設定 `ANTHROPIC_API_KEY`（未開通 Anthropic 帳單），`.github/workflows/daily-trade.yml` 的每日排程已註解關閉，只保留手動觸發（`workflow_dispatch`）。每日決策改由 Claude Code 在對話中直接分析、手動寫入 `data/decisions.json`（格式與自動化管線完全相同）。之後設定好 API Key，只要取消排程那幾行的註解即可切回全自動。

## 設定步驟

1. 到 repo 的 GitHub 網頁 → Settings → Secrets and variables → Actions → New repository secret，新增：
   - Name: `ANTHROPIC_API_KEY`
   - Value: 你的 Anthropic API Key（[console.anthropic.com](https://console.anthropic.com) 申請）

   或用終端機執行（會提示你貼上金鑰，不會顯示在畫面上）：
   ```bash
   gh secret set ANTHROPIC_API_KEY --repo <你的帳號>/stock-trading-simulator
   ```
2. 設定好之後，工作流程會在每個週一到週五 21:30 UTC（美股收盤後）自動執行一次，也可以到 GitHub 網頁的 Actions 分頁手動點 "Run workflow" 立即測試。
3. 觀察名單在 [scripts/watchlist.json](scripts/watchlist.json)，目前是 12 檔大型股/ETF；要調整標的直接編輯這個檔案即可。

## 特色

- 初始資金 $1000、最高槓桿 10x
- 支援 BUY / SELL / SHORT / COVER / HOLD 五種動作
- 自動計算 0.05% 手續費 + 0.05% 滑點
- 權益曲線、目前持倉、未實現損益
- 績效指標：總報酬率、月報酬率、勝率、平均獲利/虧損、獲利因子、最大回撤、Sharpe Ratio、交易次數、平均持有天數
- 每日的 Claude 完整回覆與市場資料快照都存在 `data/logs/YYYY-MM-DD.json`，方便事後追蹤 AI 當時的推理過程

## 本機測試表單

網頁下方有兩個「本機測試」表單（手動新增決策 / 標記市價），資料只存在你瀏覽器的 localStorage，用來離線測試介面或計算邏輯，**不會**影響 `data/decisions.json` 這份正式紀錄，也不會同步到其他裝置。

## 使用方式

直接用瀏覽器開啟 `index.html`（部分瀏覽器需透過本機伺服器如 `python3 -m http.server` 才能 fetch 本地 JSON），或部署到 GitHub Pages 後用手機/電腦瀏覽器造訪。

## 技術

前端：純 HTML + CSS + JavaScript（無框架），圖表用 Canvas 手繪。
自動化：Node.js（原生 fetch，無額外套件依賴）+ GitHub Actions。

## 注意

這是紙上交易（paper trading）系統，不連接任何真實券商帳戶或真實資金；市場資料為 Yahoo Finance 免費日線資料，僅到前一個交易日收盤，無即時報價、新聞或財報。
