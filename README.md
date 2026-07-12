# 虛擬美股交易平台（Paper Trading Desk）

一個純前端的靜態網頁，用來記錄每日虛擬美股交易決策、自動計算現金／持倉／權益曲線與績效指標。設計上對應「US Stock Trading Agent」系統提示的固定輸出格式（DATE / ACTION / TICKER / ENTRY PRICE / POSITION SIZE / LEVERAGE / STOP LOSS / TAKE PROFIT / CONFIDENCE / RISK LEVEL / REASONING）。

## 特色

- 初始資金 $1000、最高槓桿 10x
- 支援 BUY / SELL / SHORT / COVER / HOLD 五種動作
- 自動計算 0.05% 手續費 + 0.05% 滑點
- 權益曲線、目前持倉、未實現損益
- 績效指標：總報酬率、月報酬率、勝率、平均獲利/虧損、獲利因子、最大回撤、Sharpe Ratio、交易次數、平均持有天數
- 送出前即時預覽風險（是否超過 2% 單筆風險上限）與風險報酬比
- 沒有交易的日子可用「標記市價」更新未實現損益，不影響現金
- 所有資料存在瀏覽器 localStorage，可匯出/匯入 JSON 備份

## 使用方式

直接用瀏覽器開啟 `index.html`，或部署到 GitHub Pages 後用手機/電腦瀏覽器造訪。

## 技術

純 HTML + CSS + JavaScript（無框架、無外部依賴），圖表用 Canvas 手繪。

## 注意

這是紙上交易（paper trading）記錄工具，不連接任何真實券商帳戶或即時報價，所有價格皆由使用者手動輸入。
