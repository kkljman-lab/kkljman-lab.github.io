// 對應桌面版 stock_holdings.py 的手機離線版本。
import { AccountingValidationError } from "/offline/accounting.js";
import { uuid5, NAMESPACE_DNS } from "/offline/categories.js";

export function listStockHoldings(db) {
  const rows = db.all("SELECT id, ticker, name, quantity, broker_account, active, dividend_lookup_json FROM stock_holdings WHERE active=1 ORDER BY created_at");
  return rows.map((row) => {
    const { dividend_lookup_json, ...rest } = row;
    let dividendLookup = null;
    if (dividend_lookup_json) {
      try {
        dividendLookup = JSON.parse(dividend_lookup_json);
      } catch {
        dividendLookup = null;
      }
    }
    return { ...rest, dividend_lookup: dividendLookup };
  });
}

// 對應桌面版 save_dividend_lookup()——把「查詢股利」的結果存起來，下次打開股票
// 持股畫面能直接顯示上次查到的結果，不用每次都重新查一次（見 PROJECT_SPEC.md
// 13.65／13.69）。result 傳 null 代表清掉之前存的結果。
export function saveDividendLookup(db, holdingId, result) {
  db.run("UPDATE stock_holdings SET dividend_lookup_json=? WHERE id=?", [result != null ? JSON.stringify(result) : null, holdingId]);
}

export async function createStockHolding(db, ticker, name, quantity, brokerAccount = null) {
  ticker = ticker.trim();
  name = name.trim();
  brokerAccount = brokerAccount ? brokerAccount.trim() : null;
  if (!ticker || ticker.length > 20) throw new AccountingValidationError("股票代號需為 1 到 20 個字元");
  if (!name || name.length > 80) throw new AccountingValidationError("股票名稱需為 1 到 80 個字元");
  if (brokerAccount && brokerAccount.length > 80) throw new AccountingValidationError("證券戶名稱最長 80 個字元");
  quantity = Number(quantity);
  if (!Number.isInteger(quantity) || quantity <= 0) throw new AccountingValidationError("股數必須是正整數");
  const existing = db.one("SELECT id, active FROM stock_holdings WHERE ticker=? LIMIT 1", [ticker]);
  if (existing) {
    db.run("UPDATE stock_holdings SET active=1, name=?, quantity=?, broker_account=? WHERE id=?", [name, quantity, brokerAccount, existing.id]);
    return existing.id;
  }
  const holdingId = await uuid5(NAMESPACE_DNS, `personal-accounting.local/stock-holding/${ticker}`);
  db.run("INSERT INTO stock_holdings(id, ticker, name, quantity, broker_account, active) VALUES (?, ?, ?, ?, ?, 1)", [holdingId, ticker, name, quantity, brokerAccount]);
  return holdingId;
}

export function updateStockHolding(db, holdingId, name, quantity, brokerAccount = null) {
  name = name.trim();
  brokerAccount = brokerAccount ? brokerAccount.trim() : null;
  if (!name || name.length > 80) throw new AccountingValidationError("股票名稱需為 1 到 80 個字元");
  if (brokerAccount && brokerAccount.length > 80) throw new AccountingValidationError("證券戶名稱最長 80 個字元");
  quantity = Number(quantity);
  if (!Number.isInteger(quantity) || quantity <= 0) throw new AccountingValidationError("股數必須是正整數");
  const existing = db.one("SELECT 1 AS n FROM stock_holdings WHERE id=? AND active=1", [holdingId]);
  if (!existing) throw new AccountingValidationError("找不到這筆持股");
  db.run("UPDATE stock_holdings SET name=?, quantity=?, broker_account=? WHERE id=?", [name, quantity, brokerAccount, holdingId]);
}

export function deactivateStockHolding(db, holdingId) {
  const existing = db.one("SELECT 1 AS n FROM stock_holdings WHERE id=? AND active=1", [holdingId]);
  if (!existing) throw new AccountingValidationError("找不到這筆持股");
  db.run("UPDATE stock_holdings SET active=0 WHERE id=?", [holdingId]);
}

// 股票代號→簡稱對照表，來源見 stock-names.json 旁邊的 STOCK_NAMES_SOURCE.md，
// 是抓取當天的靜態快照。第一次用到時才 fetch，之後留在記憶體裡重複使用。
let stockNamesPromise = null;
function loadStockNames() {
  if (!stockNamesPromise) stockNamesPromise = fetch("/offline/stock-names.json").then((response) => response.json());
  return stockNamesPromise;
}

export async function lookupStockName(ticker) {
  const names = await loadStockNames();
  return names[ticker.trim()] || null;
}

// 名稱→代號是反過來查同一份對照表；這份快照裡沒有重複的簡稱對到不同代號，
// 直接反轉成一份新物件查就好。
let stockTickersPromise = null;
async function loadStockTickers() {
  if (!stockTickersPromise) {
    stockTickersPromise = loadStockNames().then((names) => {
      const reversed = {};
      for (const [ticker, name] of Object.entries(names)) reversed[name] = ticker;
      return reversed;
    });
  }
  return stockTickersPromise;
}

export async function lookupStockTicker(name) {
  const tickers = await loadStockTickers();
  return tickers[name.trim()] || null;
}
