# stock-names.json 資料來源

股票代號→簡稱對照表，用來讓「股票持股」畫面輸入代號時自動帶出名稱。

- **上市股票／ETF**：`https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL`（證交所 OpenAPI，公開免登入）
- **上櫃公司**：`https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O`（櫃買中心 OpenAPI，公開免登入）
- **下載日期**：2026-09-02
- 共 2267 筆（代號重複時以上市資料優先）

這是抓取當天的靜態快照，不會自動更新——之後有新股票上市/上櫃、或代號變更，需要重新抓一次覆蓋這個檔案。找不到的代號，使用者可以直接手動輸入股票名稱，不影響功能使用。
