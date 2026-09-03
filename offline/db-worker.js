// 手機離線引擎的核心 Worker：在瀏覽器裡用 OPFS 開一份跟桌面版格式相同的 SQLite 資料庫，
// 灌入跟桌面版共用的 schema.sql，並透過 postMessage 提供一個模仿 web.py 路由形狀的
// api 介面（{method, path, query, body} → {status, body}），讓將來攔截 fetch('/api/...')
// 的那一層可以幾乎照搬 web.py 的 if/elif 分派邏輯。見 PROJECT_SPEC.md 13.3 第 2、3 項。
import sqlite3InitModule from "/vendor/sqlite-wasm/index.mjs";
import { AccountingValidationError, accountBalances, annualReport, createTransaction, listSyncConflicts, monthlyReport, resolveSyncConflict, transactionDetail, updateTransaction, voidTransaction } from "/offline/accounting.js";
import { addShortcut, createBankAccount, createCategory, deactivateCategory, listBankAccounts, listCategories, listCategoryManagement, moveCategory, removeShortcut, renameCategory, reorderCategories, seedStarterLedger } from "/offline/categories.js";
import { createRecurringRule, deactivateRecurringRule, listRecurringRules, processRecurringRules, updateRecurringRule } from "/offline/recurring.js";
import { createStockHolding, deactivateStockHolding, listStockHoldings, lookupStockName, lookupStockTicker, saveDividendLookup, updateStockHolding } from "/offline/stock_holdings.js";
import { ImportValidationError, importCsv } from "/offline/importer.js";
import { exportCsv } from "/offline/exporter.js";
import { SyncError, autoSyncSettings, deviceId, deviceName, driveEncryptionKey, drivePull, drivePush, driveStatus, driveSyncNow, exportSnapshot, mergeRemoteSnapshot, resolveClientCredentials, resolveDriveCredentials, setAutoSyncSettings, setDeviceName, setDriveEncryptionKey, setDriveRefreshToken, shouldAutoSyncNow } from "/offline/sync.js";
import { exchangeCode } from "/offline/drive.js";
// 見備忘：官方 README 範例（sqlite3.oo1.OpfsDb）在目前 vendor 的版本會靜默失敗，
// 一定要用 installOpfsSAHPoolVfs()，見 static/offline/opfs-test-worker.js 的註解。

const DB_NAME = "/personal-accounting.sqlite3";
let statePromise = null;

function makeDbFacade(sqlite3Db) {
  return {
    all(sql, params = []) {
      const rows = [];
      sqlite3Db.exec({ sql, bind: params.length ? params : undefined, rowMode: "object", callback: (row) => rows.push(row) });
      return rows;
    },
    one(sql, params = []) {
      return this.all(sql, params)[0];
    },
    run(sql, params = []) {
      sqlite3Db.exec({ sql, bind: params.length ? params : undefined });
    },
    transaction(fn) {
      sqlite3Db.exec("BEGIN IMMEDIATE");
      try {
        fn();
        sqlite3Db.exec("COMMIT");
      } catch (error) {
        sqlite3Db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

async function openState() {
  const sqlite3 = await sqlite3InitModule();
  const poolUtil = await sqlite3.installOpfsSAHPoolVfs({ name: "personal-accounting-pool" });
  const sqlite3Db = new poolUtil.OpfsSAHPoolDb(DB_NAME);
  sqlite3Db.exec("PRAGMA foreign_keys = ON");
  // schema.sql 全部是 CREATE TABLE/INDEX IF NOT EXISTS、DROP VIEW+CREATE VIEW、INSERT OR IGNORE，
  // 對既有資料庫重跑一次是安全的（跟桌面版 db.py 的 migrate() 每次啟動都整份重跑一樣）。
  // 這樣以後 schema.sql 新增資料表，離線引擎不用另外補一段判斷欄位／資料表存不存在的搬遷邏輯。
  const schema = await fetch("/offline/schema.sql", { cache: "no-store" }).then((response) => response.text());
  sqlite3Db.exec(schema);
  // 上面重跑 schema.sql 只會建立「原本不存在」的資料表／索引，既有的 accounts 表格不會自動補上
  // 後來才加的欄位（CREATE TABLE IF NOT EXISTS 對已存在的表格完全不做事），所以欄位還是要用
  // ALTER TABLE 個別補，跟桌面版 db.py 的 migrate() 對 revision_of_id 的處理方式一樣。
  const accountColumns = makeDbFacade(sqlite3Db).all("PRAGMA table_info(accounts)").map((row) => row.name);
  if (!accountColumns.includes("child_order")) sqlite3Db.exec("ALTER TABLE accounts ADD COLUMN child_order INTEGER");
  if (!accountColumns.includes("icon")) sqlite3Db.exec("ALTER TABLE accounts ADD COLUMN icon TEXT");
  const stockHoldingColumns = makeDbFacade(sqlite3Db).all("PRAGMA table_info(stock_holdings)").map((row) => row.name);
  if (!stockHoldingColumns.includes("broker_account")) sqlite3Db.exec("ALTER TABLE stock_holdings ADD COLUMN broker_account TEXT");
  if (!stockHoldingColumns.includes("dividend_lookup_json")) sqlite3Db.exec("ALTER TABLE stock_holdings ADD COLUMN dividend_lookup_json TEXT");
  const db = makeDbFacade(sqlite3Db);
  // 真正空白的帳本（沒有匯入過 CSV，也還沒跟其他裝置同步過，例如朋友第一次用
  // kkljman-lab.github.io 那份離線版本）預先建立一個「現金」帳戶跟使用者實際
  // 在用的分類結構，讓一開始就有東西可以選，不用每一個分類都自己手動新增。
  // 只在完全沒有任何帳戶時才會灌入，之後裝置真的同步到別人的資料庫時，這些
  // 分類本來就是用固定 uuid5 算出來的 id，跟真正的資料合併時不會產生重複。
  const hasAnyAccount = db.one("SELECT 1 AS n FROM accounts LIMIT 1");
  if (!hasAnyAccount) await seedStarterLedger(db);
  return { sqlite3, sqlite3Db, poolUtil, db };
}

function getState() {
  if (!statePromise) statePromise = openState();
  return statePromise;
}

const EXCHANGE_RATE_URL = "https://open.er-api.com/v6/latest/TWD";
const EXCHANGE_RATE_SUPPORTED = { JPY: "日幣", CNY: "人民幣", USD: "美金" };

function formatRate(rate) {
  const fixed = rate.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return fixed || "0";
}

// 桌面版（exchange_rates.py）原本還會先試臺灣銀行牌告匯率頁面，但那個頁面現在會
// 回一個需要執行 JavaScript 的驗證挑戰頁，單純發 HTTP 請求永遠解析不到匯率，
// 離線引擎這裡就不重複那段一定會失敗的嘗試，直接呼叫這個支援瀏覽器端 CORS 的
// 公開參考匯率 API（跟桌面版的備援來源相同）。
async function fetchExchangeRate(db, currencyRaw) {
  const currency = String(currencyRaw || "").toUpperCase();
  if (!(currency in EXCHANGE_RATE_SUPPORTED)) {
    return { status: 422, body: { error: "幣別必須是 JPY、CNY 或 USD" } };
  }
  const cached = db.one(
    "SELECT * FROM exchange_rate_snapshots WHERE currency=? AND fetched_at>=datetime('now','-10 minutes') ORDER BY id DESC LIMIT 1",
    [currency],
  );
  if (cached) return { status: 200, body: { ...cached, cached: true } };
  try {
    const response = await fetch(EXCHANGE_RATE_URL);
    if (!response.ok) throw new Error("無法取得匯率");
    const payload = await response.json();
    const foreignPerTwd = Number(payload.rates && payload.rates[currency]);
    if (!(foreignPerTwd > 0)) throw new Error("匯率不正確");
    const rate = formatRate(1 / foreignPerTwd);
    const quotedAt = payload.time_last_update_utc || null;
    db.run(
      "INSERT INTO exchange_rate_snapshots(currency,twd_rate,rate_kind,source_name,source_url,quoted_at) VALUES (?,?,?,?,?,?)",
      [currency, rate, "reference", "ExchangeRate-API 參考匯率", EXCHANGE_RATE_URL, quotedAt],
    );
    const row = db.one("SELECT * FROM exchange_rate_snapshots WHERE currency=? ORDER BY id DESC LIMIT 1", [currency]);
    return { status: 200, body: { ...row, cached: false } };
  } catch (error) {
    const previous = db.one("SELECT * FROM exchange_rate_snapshots WHERE currency=? ORDER BY id DESC LIMIT 1", [currency]);
    if (previous) return { status: 200, body: { ...previous, cached: true, stale: true } };
    return { status: 502, body: { error: "目前無法取得匯率，請確認網路連線後重試" } };
  }
}

// 模仿 web.py 的 do_GET/do_POST/do_PUT/do_DELETE 分派——同一個 (method, path) 形狀，
// 方便將來對照 web.py 補齊其餘路由時，可以照著同一份清單一項一項核對。
async function handleApi(db, poolUtil, { method, path, query, body, headers }) {
  if (method === "POST" && path === "/api/import") {
    if (!(body instanceof Blob)) throw new ImportValidationError("CSV 上傳格式不正確");
    const filename = decodeURIComponent((headers && headers["x-filename"]) || "import.csv");
    if (!filename.toLowerCase().endsWith(".csv")) throw new ImportValidationError("請選擇 .csv 檔案");
    const bytes = new Uint8Array(await body.arrayBuffer());
    if (bytes.length === 0 || bytes.length > 25 * 1024 * 1024) throw new ImportValidationError("CSV 檔案大小不正確或超過 25 MB");
    const summary = await importCsv(db, bytes, filename);
    return { status: 201, body: summary };
  }
  if (method === "GET" && path === "/api/summary") {
    const row = db.one(
      `SELECT count(*) AS transaction_count,
              coalesce(sum(CASE WHEN status='legacy_unbalanced' THEN 1 ELSE 0 END), 0) AS unbalanced_count,
              coalesce(sum(CASE WHEN status='legacy_zero_amount' THEN 1 ELSE 0 END), 0) AS zero_count,
              min(transaction_date) AS date_min, max(transaction_date) AS date_max
       FROM current_transactions`,
    );
    const accounts = db.one("SELECT count(*) AS n FROM accounts WHERE active=1").n;
    return { status: 200, body: { ...row, active_accounts: accounts } };
  }
  if (method === "GET" && path === "/api/accounts") {
    processRecurringRules(db);
    return { status: 200, body: db.all("SELECT id, name, account_type, source_type, parent_name, active, icon FROM accounts ORDER BY source_row_number") };
  }
  if (method === "GET" && path === "/api/recurring") {
    return { status: 200, body: listRecurringRules(db) };
  }
  if (method === "POST" && path === "/api/recurring") {
    const ruleId = createRecurringRule(
      db,
      String(body.name || ""),
      String(body.account_type || ""),
      String(body.category_account_id || ""),
      String(body.counterpart_account_id || ""),
      Number(body.amount_minor || 0),
      String(body.frequency || ""),
      Number(body.day_of_month || 0),
      body.month_of_year ? Number(body.month_of_year) : null,
      String(body.start_date || ""),
      body.end_date ? String(body.end_date) : null,
    );
    return { status: 201, body: { id: ruleId } };
  }
  const recurringMatch = path.match(/^\/api\/recurring\/([^/]+)$/);
  if (method === "PUT" && recurringMatch) {
    updateRecurringRule(
      db,
      recurringMatch[1],
      String(body.name || ""),
      String(body.account_type || ""),
      String(body.category_account_id || ""),
      String(body.counterpart_account_id || ""),
      Number(body.amount_minor || 0),
      String(body.frequency || ""),
      Number(body.day_of_month || 0),
      body.month_of_year ? Number(body.month_of_year) : null,
      String(body.start_date || ""),
      body.end_date ? String(body.end_date) : null,
    );
    return { status: 200, body: { id: recurringMatch[1] } };
  }
  if (method === "DELETE" && recurringMatch) {
    deactivateRecurringRule(db, recurringMatch[1]);
    return { status: 200, body: { status: "deactivated" } };
  }
  if (method === "GET" && path === "/api/stock-holdings") {
    return { status: 200, body: listStockHoldings(db) };
  }
  if (method === "GET" && path === "/api/stock-name-lookup") {
    return { status: 200, body: { name: await lookupStockName(query.ticker || "") } };
  }
  if (method === "GET" && path === "/api/stock-ticker-lookup") {
    return { status: 200, body: { ticker: await lookupStockTicker(query.name || "") } };
  }
  if (method === "POST" && path === "/api/stock-holdings") {
    const holdingId = await createStockHolding(db, String(body.ticker || ""), String(body.name || ""), body.quantity, body.broker_account ?? null);
    return { status: 201, body: { id: holdingId } };
  }
  const stockHoldingMatch = path.match(/^\/api\/stock-holdings\/([^/]+)$/);
  if (method === "PUT" && stockHoldingMatch) {
    updateStockHolding(db, stockHoldingMatch[1], String(body.name || ""), body.quantity, body.broker_account ?? null);
    return { status: 200, body: { id: stockHoldingMatch[1] } };
  }
  if (method === "DELETE" && stockHoldingMatch) {
    deactivateStockHolding(db, stockHoldingMatch[1]);
    return { status: 200, body: { status: "deactivated" } };
  }
  const dividendLookupSaveMatch = path.match(/^\/api\/stock-holdings\/([^/]+)\/dividend-lookup$/);
  if (method === "PUT" && dividendLookupSaveMatch) {
    saveDividendLookup(db, dividendLookupSaveMatch[1], body.result ?? null);
    return { status: 200, body: { id: dividendLookupSaveMatch[1] } };
  }
  if (method === "GET" && path === "/api/categories") {
    return { status: 200, body: listCategories(db, query.type || "expense") };
  }
  if (method === "GET" && path === "/api/category-management") {
    return { status: 200, body: listCategoryManagement(db, query.type || "expense") };
  }
  if (method === "GET" && path === "/api/bank-accounts") {
    return { status: 200, body: listBankAccounts(db, query.type || "asset") };
  }
  if (method === "POST" && path === "/api/categories") {
    let accountId;
    if (body.account_id) {
      accountId = String(body.account_id);
      addShortcut(db, accountId);
    } else {
      accountId = await createCategory(db, String(body.name || ""), String(body.type || ""), body.parent_name);
    }
    return { status: 201, body: { id: accountId } };
  }
  if (method === "POST" && path === "/api/accounts") {
    const accountId = await createBankAccount(db, String(body.name || ""), String(body.type || ""), body.parent_name);
    return { status: 201, body: { id: accountId } };
  }
  if (method === "PUT" && path === "/api/categories/reorder") {
    reorderCategories(db, String(body.account_type || ""), body.parent_name ?? null, Array.isArray(body.ids) ? body.ids.map(String) : []);
    return { status: 200, body: { status: "reordered" } };
  }
  const categoryMatch = path.match(/^\/api\/categories\/([^/]+)$/);
  if (method === "PUT" && categoryMatch) {
    if ("name" in body) renameCategory(db, categoryMatch[1], String(body.name));
    if ("parent_name" in body) moveCategory(db, categoryMatch[1], body.parent_name);
    return { status: 200, body: { id: categoryMatch[1] } };
  }
  if (method === "DELETE" && categoryMatch) {
    if ((query.mode || "shortcut") === "deactivate") {
      deactivateCategory(db, categoryMatch[1]);
      return { status: 200, body: { status: "deactivated" } };
    }
    removeShortcut(db, categoryMatch[1]);
    return { status: 200, body: { status: "removed" } };
  }
  if (method === "GET" && path === "/api/account-balances") {
    return { status: 200, body: accountBalances(db, query.through || null) };
  }
  if (method === "GET" && path === "/api/reports/monthly") {
    return { status: 200, body: monthlyReport(db, query.month || "") };
  }
  if (method === "GET" && path === "/api/reports/annual") {
    const year = parseInt(query.year || String(new Date().getFullYear()), 10);
    const month = parseInt(query.month || "1", 10);
    return { status: 200, body: annualReport(db, year, month, query.type || "expense") };
  }
  if (method === "GET" && path === "/api/exchange-rate") {
    return await fetchExchangeRate(db, query.currency || "");
  }
  if (method === "GET" && path === "/api/transactions") {
    const limit = Math.min(Math.max(parseInt(query.limit || "50", 10), 1), 200);
    const offset = Math.max(parseInt(query.offset || "0", 10), 0);
    const conditions = [];
    const params = [];
    if (query.month) {
      conditions.push("substr(t.transaction_date, 1, 7)=?");
      params.push(query.month);
    }
    if (query.q) {
      const pattern = "%" + query.q.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_") + "%";
      conditions.push(`(coalesce(t.memo, '') LIKE ? ESCAPE '\\' OR EXISTS (
        SELECT 1 FROM entries es JOIN accounts sa ON sa.id=es.account_id
        WHERE es.transaction_id=t.id AND (sa.name LIKE ? ESCAPE '\\' OR coalesce(sa.parent_name, '') LIKE ? ESCAPE '\\')
      ))`);
      params.push(pattern, pattern, pattern);
    }
    if (query.account_id) {
      conditions.push("EXISTS (SELECT 1 FROM entries ef WHERE ef.transaction_id=t.id AND ef.account_id=?)");
      params.push(query.account_id);
    }
    if (query.type === "income" || query.type === "expense") {
      conditions.push("EXISTS (SELECT 1 FROM entries et JOIN accounts at ON at.id=et.account_id WHERE et.transaction_id=t.id AND at.account_type=?)");
      params.push(query.type);
    }
    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    const rows = db.all(
      `SELECT t.id, t.transaction_date, t.memo, t.status, t.debit_total_minor, t.credit_total_minor,
              coalesce(
                group_concat(CASE WHEN a.account_type IN ('expense','income','other') THEN a.name END, ' / '),
                group_concat(a.name, ' / ')
              ) AS accounts,
              ex.currency AS currency,
              ex.foreign_amount AS foreign_amount
       FROM current_transactions t
       JOIN entries e ON e.transaction_id=t.id
       JOIN accounts a ON a.id=e.account_id
       LEFT JOIN transaction_exchange_rates ex ON ex.transaction_id=t.id
       ${where}
       GROUP BY t.id
       ORDER BY t.transaction_date DESC, t.source_order DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return { status: 200, body: rows };
  }
  const detailMatch = method === "GET" && path.match(/^\/api\/transactions\/([^/]+)$/);
  if (detailMatch) {
    const detail = transactionDetail(db, detailMatch[1]);
    return { status: detail ? 200 : 404, body: detail };
  }
  if (method === "POST" && path === "/api/transactions") {
    const id = createTransaction(db, String(body.transaction_date), body.memo ?? null, body.entries || [], body.exchange ?? null);
    return { status: 201, body: { id } };
  }
  const putMatch = method === "PUT" && path.match(/^\/api\/transactions\/([^/]+)$/);
  if (putMatch) {
    const id = updateTransaction(db, putMatch[1], String(body.transaction_date), body.memo ?? null, body.entries || [], body.exchange ?? null);
    return { status: 200, body: { id } };
  }
  const deleteMatch = method === "DELETE" && path.match(/^\/api\/transactions\/([^/]+)$/);
  if (deleteMatch) {
    voidTransaction(db, deleteMatch[1]);
    return { status: 200, body: { status: "voided" } };
  }

  // 裝置對裝置的手動合併（PROJECT_SPEC.md 13.8 第 1 節）：桌面版的 /api/sync/* 是走
  // Google Drive，離線引擎還沒有 PKCE 授權流程可用，故意用不同的路徑命名
  // （/api/offline-sync/*），避免將來接上真正的 Drive 同步時混淆成同一套機制。
  if (method === "GET" && path === "/api/offline-sync/status") {
    const openConflicts = listSyncConflicts(db, "open");
    return { status: 200, body: { device_id: deviceId(db), device_name: deviceName(db), open_conflicts: openConflicts.length } };
  }
  if (method === "POST" && path === "/api/offline-sync/device-name") {
    setDeviceName(db, String(body.name || ""));
    return { status: 200, body: { device_name: deviceName(db) } };
  }
  if (method === "GET" && path === "/api/offline-sync/snapshot") {
    const bytes = exportSnapshot(poolUtil, DB_NAME);
    // toISOString() 是 UTC 時間，凌晨時段（台灣 UTC+8）算出來的日期會是昨天，
    // 檔名只是給人看的參考，改用本地時間的年/月/日組出來比較符合直覺。
    const now = new Date();
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const filename = `accounting-offline-${deviceId(db)}-${localDate}.sqlite3`;
    return { status: 200, binary: true, contentType: "application/x-sqlite3", filename, body: bytes };
  }
  if (method === "POST" && path === "/api/offline-sync/merge") {
    if (!(body instanceof Blob)) throw new SyncError("同步檔案格式不正確");
    const bytes = new Uint8Array(await body.arrayBuffer());
    const result = await mergeRemoteSnapshot(poolUtil, db, bytes);
    return { status: 200, body: result };
  }
  if (method === "GET" && path === "/api/offline-sync/conflicts") {
    return { status: 200, body: listSyncConflicts(db, "open") };
  }
  const resolveMatch = method === "POST" && path.match(/^\/api\/offline-sync\/conflicts\/([^/]+)\/resolve$/);
  if (resolveMatch) {
    resolveSyncConflict(db, resolveMatch[1], String(body.keep_transaction_id));
    return { status: 200, body: { status: "resolved" } };
  }

  // Google Drive 自動同步（PROJECT_SPEC.md 13.10 第 1 項）：走 Desktop app 類型的
  // OAuth 用戶端＋PKCE，見 sync.js 的 resolveClientCredentials 註解說明原因。
  // 頁面（google-auth.js）只需要 client_id 就能組出跳轉去 Google 的授權網址，
  // 不需要、也不會拿到 client_secret——secret 只在下面 drive-connect 這段
  // worker 內部跟 Google 換 token 時才用到。
  if (method === "GET" && path === "/api/offline-sync/google-client-id") {
    const credentials = await resolveClientCredentials(db);
    return { status: 200, body: { client_id: credentials.clientId } };
  }
  if (method === "POST" && path === "/api/offline-sync/drive-connect") {
    const credentials = await resolveClientCredentials(db);
    const tokens = await exchangeCode({
      code: String(body.code),
      codeVerifier: String(body.code_verifier),
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      redirectUri: String(body.redirect_uri),
    });
    if (!tokens.refresh_token) throw new SyncError("Google 未提供長期授權，請先到 Google 帳號設定移除舊的授權後再試一次");
    setDriveRefreshToken(db, tokens.refresh_token, "installed");
    return { status: 200, body: { status: "connected" } };
  }
  if (method === "POST" && path === "/api/offline-sync/drive-store-token") {
    // 手機透過 Tailscale HTTPS 那條路：伺服器已經代為完成整段授權交換，這裡只是
    // 把換到的 refresh token 存進這台裝置自己的資料庫，見 google-auth.js 的
    // handleServerProxiedClaimIfPresent。
    if (!body.refresh_token) throw new SyncError("缺少 refresh token");
    setDriveRefreshToken(db, String(body.refresh_token), "web");
    return { status: 200, body: { status: "connected" } };
  }
  if (method === "POST" && path === "/api/offline-sync/drive-encryption-key") {
    setDriveEncryptionKey(db, String(body.key || ""));
    return { status: 200, body: { status: "saved" } };
  }
  if (method === "GET" && path === "/api/offline-sync/drive-status") {
    const credentials = await resolveDriveCredentials(db);
    const status = await driveStatus(db, credentials);
    const openConflicts = listSyncConflicts(db, "open").length;
    return { status: 200, body: { ...status, encryption_key_set: !!driveEncryptionKey(db), open_conflicts: openConflicts } };
  }
  if (method === "POST" && path === "/api/offline-sync/drive-push") {
    const credentials = await resolveDriveCredentials(db);
    const result = await drivePush(poolUtil, db, DB_NAME, credentials);
    return { status: 200, body: result };
  }
  if (method === "POST" && path === "/api/offline-sync/drive-pull") {
    const credentials = await resolveDriveCredentials(db);
    const result = await drivePull(poolUtil, db, DB_NAME, credentials);
    return { status: 200, body: result };
  }
  if (method === "POST" && path === "/api/offline-sync/drive-sync-now") {
    const credentials = await resolveDriveCredentials(db);
    const result = await driveSyncNow(poolUtil, db, DB_NAME, credentials);
    return { status: 200, body: result };
  }
  if (method === "GET" && path === "/api/offline-sync/auto-sync-settings") {
    return { status: 200, body: { ...autoSyncSettings(db), due: shouldAutoSyncNow(db) } };
  }
  if (method === "POST" && path === "/api/offline-sync/auto-sync-settings") {
    setAutoSyncSettings(db, !!body.enabled, String(body.time || "08:00"));
    return { status: 200, body: { status: "saved" } };
  }

  return { status: 404, body: { error: "offline engine: 尚未支援這個路徑 " + method + " " + path } };
}

self.addEventListener("message", async (event) => {
  const { id, type, sql, bind, request } = event.data || {};
  try {
    const { sqlite3, sqlite3Db, db, poolUtil } = await getState();
    if (type === "reset") {
      // 清掉這台裝置本機的整個帳本，重新從空白開始（例如發現這台裝置在還沒
      // 「下載並合併」前，自己累積了一些跟其他裝置對不起來的測試/雜訊資料，
      // 決定乾脆重來一次）。一定要先關掉這個連線再呼叫 poolUtil.wipeFiles()，
      // 不能直接從外面操作 OPFS 目錄——同一份檔案還被連線占用時操作會被
      // 靜默略過，見 PROJECT_SPEC.md 13.4 的 OPFS SAHPool 單一連線限制。
      try {
        sqlite3Db.close();
        await poolUtil.wipeFiles();
        self.postMessage({ id, ok: true });
      } catch (error) {
        self.postMessage({ id, ok: false, error: String((error && error.message) || error) });
      }
      return;
    }
    if (type === "ready") {
      const tables = db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
      self.postMessage({ id, ok: true, libVersion: sqlite3.version.libVersion, tableCount: tables.length, tables: tables.map((row) => row.name) });
      return;
    }
    if (type === "exec") {
      self.postMessage({ id, ok: true, rows: db.all(sql, bind || []) });
      return;
    }
    if (type === "export") {
      try {
        const bytes = await exportCsv(db);
        self.postMessage({ id, ok: true, bytes }, [bytes.buffer]);
      } catch (error) {
        self.postMessage({ id, ok: false, error: error.message });
      }
      return;
    }
    if (type === "api") {
      try {
        const result = await handleApi(db, poolUtil, request);
        const transfer = result.binary ? [result.body.buffer] : [];
        self.postMessage({ id, ok: true, response: result }, transfer);
      } catch (error) {
        if (error instanceof AccountingValidationError || error instanceof ImportValidationError || error instanceof SyncError) {
          self.postMessage({ id, ok: true, response: { status: 422, body: { error: error.message } } });
        } else {
          throw error;
        }
      }
      return;
    }
    self.postMessage({ id, ok: false, error: "Unknown message type: " + type });
  } catch (error) {
    self.postMessage({ id, ok: false, error: String((error && error.message) || error) });
  }
});
