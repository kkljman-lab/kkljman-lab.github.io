// 對應桌面版 recurring.py 的手機離線版本。
import { AccountingValidationError, createTransaction } from "/offline/accounting.js";

function parseDate(value, field) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) throw new AccountingValidationError(`${field}格式必須是 YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new AccountingValidationError(`${field}格式必須是 YYYY-MM-DD`);
  return date;
}

function toIso(date) {
  return date.toISOString().slice(0, 10);
}

// `new Date().toISOString()` 是 UTC 時間，不是使用者當地的日期——台灣是 UTC+8，
// 每天凌晨 0 點到 8 點之間，UTC 那邊其實還停在「前一天」，用這個算出來的
// 「今天」會晚 8 小時才真正切換到新的一天。這裡跟桌面版的 process_recurring_rules()
// 用 Python `date.today()`（讀本機系統時區）不一樣，導致同一筆固定收支在
// 電腦上已經正確產生今天的帳，手機（離線引擎）在當天一大早查詢時，因為
// 「今天」算錯還停在昨天，會晚 8 小時才產生（使用者凌晨實機回報過這個現象）。
// 改成直接讀本地時間的年/月/日組出 YYYY-MM-DD，不透過 UTC 轉換。
function localTodayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function occurrences(frequency, dayOfMonth, monthOfYear, start, through) {
  if (start > through) return [];
  const results = [];
  if (frequency === "monthly") {
    let year = start.getUTCFullYear(), month = start.getUTCMonth() + 1;
    while (true) {
      const lastDay = lastDayOfMonth(year, month);
      const occurrence = new Date(Date.UTC(year, month - 1, Math.min(dayOfMonth, lastDay)));
      if (occurrence > through) break;
      if (occurrence >= start) results.push(occurrence);
      month += 1;
      if (month > 12) { month = 1; year += 1; }
    }
  } else {
    let year = start.getUTCFullYear();
    while (true) {
      const lastDay = lastDayOfMonth(year, monthOfYear);
      const occurrence = new Date(Date.UTC(year, monthOfYear - 1, Math.min(dayOfMonth, lastDay)));
      if (occurrence > through) break;
      if (occurrence >= start) results.push(occurrence);
      year += 1;
    }
  }
  return results;
}

function validateRuleFields(accountType, categoryAccountId, counterpartAccountId, amountMinor, frequency, dayOfMonth, monthOfYear, startDate, endDate) {
  if (accountType !== "expense" && accountType !== "income") throw new AccountingValidationError("類型必須是支出或收入");
  if (!categoryAccountId || !counterpartAccountId) throw new AccountingValidationError("請選擇分類與帳戶");
  if (categoryAccountId === counterpartAccountId) throw new AccountingValidationError("分類與帳戶不可相同");
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new AccountingValidationError("金額必須大於 0");
  if (frequency !== "monthly" && frequency !== "yearly") throw new AccountingValidationError("週期必須是每月或每年");
  if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) throw new AccountingValidationError("日期必須介於 1 到 31");
  if (frequency === "yearly" && (!Number.isInteger(monthOfYear) || monthOfYear < 1 || monthOfYear > 12)) {
    throw new AccountingValidationError("每年重複必須指定月份");
  }
  const start = parseDate(startDate, "開始日期");
  if (endDate) {
    const end = parseDate(endDate, "結束日期");
    if (end < start) throw new AccountingValidationError("結束日期不可早於開始日期");
  }
}

export function listRecurringRules(db) {
  const rows = db.all(
    `SELECT r.*, c.name AS category_name, c.parent_name AS category_parent_name, a.name AS counterpart_name
     FROM recurring_transactions r
     JOIN accounts c ON c.id=r.category_account_id
     JOIN accounts a ON a.id=r.counterpart_account_id
     WHERE r.active=1
     ORDER BY r.created_at`,
  );
  const today = new Date(localTodayIso() + "T00:00:00Z");
  return rows.map((row) => {
    const through = row.end_date ? parseDate(row.end_date, "結束日期") : new Date(Date.UTC(today.getUTCFullYear() + 5, 11, 31));
    let upcoming = occurrences(row.frequency, row.day_of_month, row.month_of_year, parseDate(row.start_date, "開始日期"), through)
      .filter((item) => item >= today && (!row.last_generated_date || toIso(item) > row.last_generated_date));
    return { ...row, next_date: upcoming.length ? toIso(upcoming[0]) : null };
  });
}

export function createRecurringRule(db, name, accountType, categoryAccountId, counterpartAccountId, amountMinor, frequency, dayOfMonth, monthOfYear, startDate, endDate) {
  name = name.trim();
  if (!name || name.length > 80) throw new AccountingValidationError("名稱需為 1 到 80 個字元");
  validateRuleFields(accountType, categoryAccountId, counterpartAccountId, amountMinor, frequency, dayOfMonth, monthOfYear, startDate, endDate);
  const ruleId = crypto.randomUUID();
  db.transaction(() => {
    db.run(
      `INSERT INTO recurring_transactions(
           id, name, account_type, category_account_id, counterpart_account_id, amount_minor,
           frequency, day_of_month, month_of_year, start_date, end_date
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ruleId, name, accountType, categoryAccountId, counterpartAccountId, amountMinor, frequency, dayOfMonth, monthOfYear ?? null, startDate, endDate ?? null],
    );
    db.run(
      "INSERT INTO audit_events(event_type, entity_type, entity_id, details_json) VALUES ('recurring_created', 'recurring_transaction', ?, ?)",
      [ruleId, JSON.stringify({ name })],
    );
  });
  return ruleId;
}

export function updateRecurringRule(db, ruleId, name, accountType, categoryAccountId, counterpartAccountId, amountMinor, frequency, dayOfMonth, monthOfYear, startDate, endDate) {
  name = name.trim();
  if (!name || name.length > 80) throw new AccountingValidationError("名稱需為 1 到 80 個字元");
  validateRuleFields(accountType, categoryAccountId, counterpartAccountId, amountMinor, frequency, dayOfMonth, monthOfYear, startDate, endDate);
  const existing = db.one("SELECT id FROM recurring_transactions WHERE id=?", [ruleId]);
  if (!existing) throw new AccountingValidationError("找不到這筆固定收支設定");
  db.transaction(() => {
    db.run(
      `UPDATE recurring_transactions SET
           name=?, account_type=?, category_account_id=?, counterpart_account_id=?, amount_minor=?,
           frequency=?, day_of_month=?, month_of_year=?, start_date=?, end_date=?
       WHERE id=?`,
      [name, accountType, categoryAccountId, counterpartAccountId, amountMinor, frequency, dayOfMonth, monthOfYear ?? null, startDate, endDate ?? null, ruleId],
    );
    db.run(
      "INSERT INTO audit_events(event_type, entity_type, entity_id, details_json) VALUES ('recurring_updated', 'recurring_transaction', ?, ?)",
      [ruleId, JSON.stringify({ name })],
    );
  });
}

export function deactivateRecurringRule(db, ruleId) {
  const row = db.one("SELECT name FROM recurring_transactions WHERE id=? AND active=1", [ruleId]);
  if (!row) throw new AccountingValidationError("找不到這筆固定收支設定");
  db.run("UPDATE recurring_transactions SET active=0 WHERE id=?", [ruleId]);
  db.run(
    "INSERT INTO audit_events(event_type, entity_type, entity_id, details_json) VALUES ('recurring_deactivated', 'recurring_transaction', ?, ?)",
    [ruleId, JSON.stringify({ name: row.name })],
  );
}

export function processRecurringRules(db, today) {
  today = today || new Date(localTodayIso() + "T00:00:00Z");
  const rows = db.all("SELECT * FROM recurring_transactions WHERE active=1");
  let created = 0;
  for (const row of rows) {
    // 這個函式在每次 GET /api/accounts 都會跑一次（見 db-worker.js），所以任何一筆
    // 規則處理失敗（例如它指到的分類/帳戶後來被停用或刪除）絕對不能讓整個請求
    // 一起失敗——那樣會讓使用者連「打開分類/固定收支畫面去修正那筆規則」都做
    // 不到，整個帳本永久打不開（實機發生過：朋友的手機每次一開就載入失敗）。
    // 跳過這筆、繼續處理其他規則，並把原因留在 console 方便之後排查。
    try {
      const start = parseDate(row.start_date, "開始日期");
      const through = row.end_date ? (parseDate(row.end_date, "結束日期") < today ? parseDate(row.end_date, "結束日期") : today) : today;
      let due = occurrences(row.frequency, row.day_of_month, row.month_of_year, start, through);
      if (row.last_generated_date) due = due.filter((item) => toIso(item) > row.last_generated_date);
      for (const occurrence of due) {
        const amount = row.amount_minor;
        const entries = row.account_type === "expense"
          ? [{ account_id: row.category_account_id, debit_minor: amount, credit_minor: 0 }, { account_id: row.counterpart_account_id, debit_minor: 0, credit_minor: amount }]
          : [{ account_id: row.counterpart_account_id, debit_minor: amount, credit_minor: 0 }, { account_id: row.category_account_id, debit_minor: 0, credit_minor: amount }];
        createTransaction(db, toIso(occurrence), `${row.name}（定期自動記帳）`, entries);
        db.run("UPDATE recurring_transactions SET last_generated_date=? WHERE id=?", [toIso(occurrence), row.id]);
        created += 1;
      }
    } catch (error) {
      console.error("[recurring] 略過一筆處理失敗的固定收支規則：", row.name, error);
    }
  }
  return created;
}
