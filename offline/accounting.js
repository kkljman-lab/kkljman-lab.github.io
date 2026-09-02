// 手機離線引擎的記帳邏輯——對應桌面版 accounting.py，刻意逐函式照著搬，
// 方便日後對照兩邊有沒有邏輯漏掉或兜不起來。目前先搬「新增/編輯/作廢交易、
// 交易明細、月報、帳戶餘額」這幾個畫面上「新增交易」對話框跟交易列表會用到的函式，
// 其餘（年報、分類管理、CSV 匯入匯出…）之後再補。見 PROJECT_SPEC.md 13.3。

export class AccountingValidationError extends Error {}

async function sha256Hex(text) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isoDateValid(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

function cleanMemo(memo) {
  if (memo == null) return null;
  const trimmed = String(memo).trim();
  return trimmed ? trimmed.slice(0, 500) : null;
}

// db 是 db-worker.js 裡包出來的同步風格介面（見底部 makeDbFacade）。
function validateEntries(db, entries) {
  if (!Array.isArray(entries) || entries.length < 2) throw new AccountingValidationError("一筆交易至少需要兩筆分錄");
  if (entries.length > 50) throw new AccountingValidationError("一筆交易最多允許 50 筆分錄");
  let debitTotal = 0;
  let creditTotal = 0;
  const accountIds = new Set();
  for (const entry of entries) {
    const debit = Number(entry.debit_minor || 0);
    const credit = Number(entry.credit_minor || 0);
    if (!Number.isInteger(debit) || !Number.isInteger(credit)) throw new AccountingValidationError("金額必須是整數新台幣");
    if (debit < 0 || credit < 0) throw new AccountingValidationError("新交易不可使用負數金額");
    if ((debit === 0) === (credit === 0)) throw new AccountingValidationError("每筆分錄必須且只能填借方或貸方");
    debitTotal += debit;
    creditTotal += credit;
    accountIds.add(entry.account_id);
  }
  if (debitTotal === 0 || debitTotal !== creditTotal) {
    throw new AccountingValidationError(`借貸不平衡：借方 ${debitTotal}、貸方 ${creditTotal}`);
  }
  const ids = [...accountIds];
  const placeholders = ids.map(() => "?").join(",");
  const accounts = db.all(`SELECT id, active FROM accounts WHERE id IN (${placeholders})`, ids);
  if (accounts.length !== ids.length) throw new AccountingValidationError("分錄包含不存在的帳戶");
  if (accounts.some((row) => !row.active)) throw new AccountingValidationError("分錄不可使用已停用的帳戶");
  return { debitTotal, creditTotal };
}

function isSuperseded(db, transactionId) {
  return db.all("SELECT 1 FROM transactions WHERE revision_of_id=? LIMIT 1", [transactionId]).length > 0;
}

// 對應桌面版 accounting.py 的 _validate_exchange：外幣金額×匯率四捨五入後
// 必須剛好等於這筆交易的入帳金額（分錄早就換算成新台幣了），否則視為資料不一致。
function validateExchange(exchange, totalMinor) {
  if (exchange == null) return null;
  if (!["JPY", "CNY", "USD"].includes(exchange.currency)) throw new AccountingValidationError("幣別僅支援日幣、人民幣或美金");
  const foreignAmount = Number(exchange.foreign_amount);
  const twdRate = Number(exchange.twd_rate);
  if (!Number.isFinite(foreignAmount) || !Number.isFinite(twdRate)) throw new AccountingValidationError("外幣金額或匯率格式不正確");
  if (!(foreignAmount > 0) || !(twdRate > 0)) throw new AccountingValidationError("外幣金額與匯率必須大於 0");
  const converted = Math.round(foreignAmount * twdRate);
  if (converted !== totalMinor) throw new AccountingValidationError(`外幣換算後應為 NT$ ${converted.toLocaleString()}，與入帳金額不符`);
  return { foreignAmount, twdRate };
}

// 對應桌面版 accounting.py 的 _insert_exchange。
function insertExchange(db, transactionId, exchange, values) {
  db.run(
    `INSERT INTO transaction_exchange_rates(
        transaction_id, currency, foreign_amount, twd_rate, rate_kind,
        source_name, source_url, quoted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      transactionId,
      exchange.currency,
      String(values.foreignAmount),
      String(values.twdRate),
      exchange.rate_kind || "reference",
      String(exchange.source_name || "").slice(0, 100),
      String(exchange.source_url || "").slice(0, 500),
      exchange.quoted_at ?? null,
    ],
  );
}

export function transactionDetail(db, transactionId) {
  const rows = db.all(
    `SELECT id, transaction_date, memo, status, debit_total_minor, credit_total_minor,
            source_transaction_number, revision_of_id
     FROM transactions WHERE id=?`,
    [transactionId],
  );
  if (!rows.length) return null;
  const transaction = rows[0];
  const entries = db.all(
    `SELECT e.id, e.entry_order, e.debit_minor, e.credit_minor, e.memo,
            a.id AS account_id, a.name AS account_name, a.account_type
     FROM entries e JOIN accounts a ON a.id=e.account_id
     WHERE e.transaction_id=? ORDER BY e.entry_order`,
    [transactionId],
  );
  const supersededBy = db.all("SELECT id FROM transactions WHERE revision_of_id=?", [transactionId]);
  const exchangeRows = db.all(
    `SELECT currency, foreign_amount, twd_rate, rate_kind, source_name, source_url, quoted_at, captured_at
     FROM transaction_exchange_rates WHERE transaction_id=?`,
    [transactionId],
  );
  return {
    ...transaction,
    entries,
    exchange: exchangeRows.length ? exchangeRows[0] : null,
    superseded_by: supersededBy.length ? supersededBy[0].id : null,
  };
}

export function createTransaction(db, transactionDate, memo, entries, exchange = null) {
  if (!isoDateValid(transactionDate)) throw new AccountingValidationError("交易日期格式必須是 YYYY-MM-DD");
  const { debitTotal, creditTotal } = validateEntries(db, entries);
  const exchangeValues = validateExchange(exchange, debitTotal);
  const transactionId = crypto.randomUUID();
  const cleanedMemo = cleanMemo(memo);
  db.transaction(() => {
    const nextOrder = db.one("SELECT coalesce(max(source_order), 0) + 1 AS n FROM transactions").n;
    db.run(
      `INSERT INTO transactions(id, import_batch_id, source_transaction_number, transaction_date, memo,
              source_order, status, debit_total_minor, credit_total_minor)
       VALUES (?, NULL, NULL, ?, ?, ?, 'normal', ?, ?)`,
      [transactionId, transactionDate, cleanedMemo, nextOrder, debitTotal, creditTotal],
    );
    entries.forEach((entry, index) => {
      db.run(
        `INSERT INTO entries(id, transaction_id, account_id, entry_order, debit_minor, credit_minor, memo)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), transactionId, entry.account_id, index + 1, entry.debit_minor || 0, entry.credit_minor || 0, entry.memo ?? null],
      );
    });
    if (exchange != null && exchangeValues != null) insertExchange(db, transactionId, exchange, exchangeValues);
    db.run(
      "INSERT INTO audit_events(event_type, entity_type, entity_id, details_json) VALUES ('transaction_created', 'transaction', ?, ?)",
      [transactionId, JSON.stringify({ date: transactionDate, debit_total_minor: debitTotal, credit_total_minor: creditTotal })],
    );
  });
  return transactionId;
}

export function updateTransaction(db, transactionId, transactionDate, memo, entries, exchange = null) {
  if (!isoDateValid(transactionDate)) throw new AccountingValidationError("交易日期格式必須是 YYYY-MM-DD");
  const current = transactionDetail(db, transactionId);
  if (!current) throw new AccountingValidationError("找不到交易");
  if (current.status === "voided") throw new AccountingValidationError("交易已經作廢，不可編輯");
  if (isSuperseded(db, transactionId)) throw new AccountingValidationError("這筆交易已經有更新的版本，請對最新版本操作");
  const { debitTotal, creditTotal } = validateEntries(db, entries);
  const exchangeValues = validateExchange(exchange, debitTotal);
  const cleanedMemo = cleanMemo(memo);
  let replacementId;
  db.transaction(() => {
    const revision = db.one("SELECT coalesce(max(revision_number), 0) + 1 AS n FROM transaction_revisions WHERE transaction_id=?", [transactionId]).n;
    db.run(
      "INSERT INTO transaction_revisions(transaction_id, revision_number, before_json) VALUES (?, ?, ?)",
      [transactionId, revision, JSON.stringify(current)],
    );
    replacementId = crypto.randomUUID();
    const nextOrder = db.one("SELECT coalesce(max(source_order), 0) + 1 AS n FROM transactions").n;
    db.run(
      `INSERT INTO transactions(id, import_batch_id, source_transaction_number, transaction_date, memo,
              source_order, status, debit_total_minor, credit_total_minor, revision_of_id)
       VALUES (?, NULL, NULL, ?, ?, ?, 'normal', ?, ?, ?)`,
      [replacementId, transactionDate, cleanedMemo, nextOrder, debitTotal, creditTotal, transactionId],
    );
    entries.forEach((entry, index) => {
      db.run(
        `INSERT INTO entries(id, transaction_id, account_id, entry_order, debit_minor, credit_minor, memo)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), replacementId, entry.account_id, index + 1, entry.debit_minor || 0, entry.credit_minor || 0, entry.memo ?? null],
      );
    });
    if (exchange != null && exchangeValues != null) insertExchange(db, replacementId, exchange, exchangeValues);
    db.run(
      "INSERT INTO audit_events(event_type, entity_type, entity_id, details_json) VALUES ('transaction_updated', 'transaction', ?, ?)",
      [transactionId, JSON.stringify({ replacement_id: replacementId, revision })],
    );
  });
  return replacementId;
}

export function voidTransaction(db, transactionId) {
  const current = transactionDetail(db, transactionId);
  if (!current) throw new AccountingValidationError("找不到交易");
  if (current.source_transaction_number != null) throw new AccountingValidationError("匯入的歷史交易不可直接作廢，請建立調整交易");
  if (current.status === "voided") throw new AccountingValidationError("交易已經作廢");
  if (isSuperseded(db, transactionId)) throw new AccountingValidationError("這筆交易已經有更新的版本，請對最新版本操作");
  db.transaction(() => {
    const revision = db.one("SELECT coalesce(max(revision_number), 0) + 1 AS n FROM transaction_revisions WHERE transaction_id=?", [transactionId]).n;
    db.run(
      "INSERT INTO transaction_revisions(transaction_id, revision_number, before_json) VALUES (?, ?, ?)",
      [transactionId, revision, JSON.stringify(current)],
    );
    db.run("UPDATE transactions SET status='voided' WHERE id=?", [transactionId]);
    db.run(
      "INSERT INTO audit_events(event_type, entity_type, entity_id, details_json) VALUES ('transaction_voided', 'transaction', ?, ?)",
      [transactionId, JSON.stringify({ revision })],
    );
  });
}

export function monthlyReport(db, month) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new AccountingValidationError("月份格式必須是 YYYY-MM");
  const rows = db.all(
    `SELECT a.account_type, a.id AS account_id, a.name,
            sum(e.debit_minor) AS debits, sum(e.credit_minor) AS credits
     FROM entries e
     JOIN current_transactions t ON t.id=e.transaction_id
     JOIN accounts a ON a.id=e.account_id
     WHERE substr(t.transaction_date, 1, 7)=?
     GROUP BY a.id, a.account_type, a.name
     ORDER BY a.source_row_number`,
    [month],
  );
  const categories = [];
  let income = 0;
  let expense = 0;
  for (const row of rows) {
    const amount = row.account_type === "income" || row.account_type === "liability" ? row.credits - row.debits : row.debits - row.credits;
    if (row.account_type === "income") income += amount;
    else if (row.account_type === "expense") expense += amount;
    if ((row.account_type === "income" || row.account_type === "expense") && amount) {
      categories.push({ account_id: row.account_id, name: row.name, type: row.account_type, amount_minor: amount });
    }
  }
  return { month, income_minor: income, expense_minor: expense, net_minor: income - expense, categories };
}

// 找出同一天、借貸總額完全相同的交易——不代表一定是重複，但值得使用者自己核對一次。
// 常見成因：從不同記帳軟體匯入一份涵蓋相同期間的 CSV，原始「交易編號」跟本程式既有
// 資料的編號規則不同，既有的匯入去重機制（比對 source_transaction_number）完全比對
// 不到，導致同一筆真實交易被當成新交易重複插入。這裡只負責「找出來給使用者看」，
// 真的要作廢由使用者自己在畫面上一筆一筆確認、點擊既有的作廢功能，這裡不自動刪除
// 任何資料。
export function accountBalances(db, throughDate) {
  const condition = throughDate ? "AND t.transaction_date<=?" : "";
  const params = throughDate ? [throughDate] : [];
  const rows = db.all(
    `SELECT a.id, a.name, a.parent_name, a.account_type, a.active,
            coalesce(sum(CASE WHEN t.id IS NOT NULL THEN e.debit_minor ELSE 0 END), 0) AS debits,
            coalesce(sum(CASE WHEN t.id IS NOT NULL THEN e.credit_minor ELSE 0 END), 0) AS credits
     FROM accounts a LEFT JOIN entries e ON e.account_id=a.id
     LEFT JOIN current_transactions t ON t.id=e.transaction_id
     ${condition}
     GROUP BY a.id
     ORDER BY CASE WHEN a.name='現金' THEN 0 WHEN a.name='房屋貸款' THEN 2 ELSE 1 END, a.source_row_number`,
    params,
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    parent_name: row.parent_name,
    account_type: row.account_type,
    active: row.active,
    balance_minor: row.account_type === "income" || row.account_type === "liability" ? row.credits - row.debits : row.debits - row.credits,
  }));
}

// 對應桌面版 accounting.py 的 detect_sync_conflicts／list_sync_conflicts／resolve_sync_conflict，
// 見 PROJECT_SPEC.md 第 12.4 節：交易編輯／作廢一律新增新版本、從不覆寫舊列，離線合併
// 資料庫時唯一需要人工判斷的，是同一筆舊交易被兩端分別編輯或刪除，這裡負責找出並記錄
// 這種衝突，不自動選邊。
export async function detectSyncConflicts(db) {
  const forks = db.all(
    `SELECT parent.id AS transaction_id, group_concat(child.id) AS candidates
     FROM transactions parent
     JOIN transactions child ON child.revision_of_id = parent.id
     WHERE child.status != 'voided'
       AND child.id NOT IN (SELECT revision_of_id FROM transactions WHERE revision_of_id IS NOT NULL)
     GROUP BY parent.id
     HAVING count(*) > 1`,
  );
  const editVsVoid = db.all(
    `SELECT parent.id AS transaction_id, child.id AS candidate
     FROM transactions parent
     JOIN transactions child ON child.revision_of_id = parent.id
     WHERE parent.status='voided' AND child.status != 'voided'
       AND child.id NOT IN (SELECT revision_of_id FROM transactions WHERE revision_of_id IS NOT NULL)`,
  );

  // sha256Hex 是非同步的，db.transaction() 裡的 callback 必須同步執行，所以先在交易外面
  // 把每筆衝突的 id 都算好，跟 importer.js 事先算好帳戶 uuid5 是同樣的理由。
  const forkPlans = [];
  for (const row of forks) {
    const candidates = row.candidates.split(",").sort();
    const conflictId = "conflict-fork-" + (await sha256Hex(row.transaction_id + "|" + candidates.join(","))).slice(0, 24);
    forkPlans.push({ conflictId, transactionId: row.transaction_id, candidates });
  }
  const voidPlans = [];
  for (const row of editVsVoid) {
    const conflictId = "conflict-void-" + (await sha256Hex(row.transaction_id + "|" + row.candidate)).slice(0, 24);
    voidPlans.push({ conflictId, transactionId: row.transaction_id, candidates: [row.candidate] });
  }

  const newConflicts = [];
  db.transaction(() => {
    for (const plan of forkPlans) {
      if (db.one("SELECT 1 AS n FROM sync_conflicts WHERE id=?", [plan.conflictId])) continue;
      db.run(
        "INSERT INTO sync_conflicts(id, transaction_id, conflict_type, candidate_ids_json) VALUES (?, ?, 'fork_edit', ?)",
        [plan.conflictId, plan.transactionId, JSON.stringify(plan.candidates)],
      );
      newConflicts.push({ id: plan.conflictId, transaction_id: plan.transactionId, conflict_type: "fork_edit", candidates: plan.candidates });
    }
    for (const plan of voidPlans) {
      if (db.one("SELECT 1 AS n FROM sync_conflicts WHERE id=?", [plan.conflictId])) continue;
      db.run(
        "INSERT INTO sync_conflicts(id, transaction_id, conflict_type, candidate_ids_json) VALUES (?, ?, 'edit_vs_void', ?)",
        [plan.conflictId, plan.transactionId, JSON.stringify(plan.candidates)],
      );
      newConflicts.push({ id: plan.conflictId, transaction_id: plan.transactionId, conflict_type: "edit_vs_void", candidates: plan.candidates });
    }
  });
  return newConflicts;
}

export function listSyncConflicts(db, status = "open") {
  const rows = db.all(
    `SELECT id, transaction_id, conflict_type, candidate_ids_json, status, resolved_transaction_id, detected_at, resolved_at
     FROM sync_conflicts WHERE status=? ORDER BY detected_at`,
    [status],
  );
  return rows.map(({ candidate_ids_json, ...row }) => {
    const candidates = JSON.parse(candidate_ids_json);
    return {
      ...row,
      candidates,
      transaction: transactionDetail(db, row.transaction_id),
      candidate_details: candidates.map((id) => transactionDetail(db, id)),
    };
  });
}

export function resolveSyncConflict(db, conflictId, keepTransactionId) {
  const conflict = db.one("SELECT * FROM sync_conflicts WHERE id=?", [conflictId]);
  if (!conflict) throw new AccountingValidationError("找不到這筆同步衝突");
  if (conflict.status === "resolved") throw new AccountingValidationError("這筆同步衝突已經處理過");
  const candidates = JSON.parse(conflict.candidate_ids_json);
  const confirmingDeletion = conflict.conflict_type === "edit_vs_void" && keepTransactionId === conflict.transaction_id;
  if (!confirmingDeletion && !candidates.includes(keepTransactionId)) {
    throw new AccountingValidationError("選擇的版本不是這筆衝突的候選版本之一");
  }
  for (const candidateId of candidates) {
    if (candidateId === keepTransactionId) continue;
    const row = db.one("SELECT status FROM transactions WHERE id=?", [candidateId]);
    if (row && row.status !== "voided") voidTransaction(db, candidateId);
  }
  db.run(
    "UPDATE sync_conflicts SET status='resolved', resolved_transaction_id=?, resolved_at=CURRENT_TIMESTAMP WHERE id=?",
    [keepTransactionId, conflictId],
  );
}

export function annualReport(db, year, detailMonth = 1, detailType = "expense") {
  if (year < 1900 || year > 2200) throw new AccountingValidationError("年度範圍不正確");
  if (detailMonth < 1 || detailMonth > 12) throw new AccountingValidationError("月份範圍不正確");
  if (detailType !== "expense" && detailType !== "income") throw new AccountingValidationError("明細類型必須是 expense 或 income");

  const rows = db.all(
    `SELECT cast(substr(t.transaction_date, 6, 2) AS integer) AS month,
            coalesce(sum(CASE WHEN a.account_type='income' THEN e.credit_minor-e.debit_minor ELSE 0 END), 0) AS income,
            coalesce(sum(CASE WHEN a.account_type='expense' THEN e.debit_minor-e.credit_minor ELSE 0 END), 0) AS expense
     FROM current_transactions t
     JOIN entries e ON e.transaction_id=t.id
     JOIN accounts a ON a.id=e.account_id
     WHERE substr(t.transaction_date, 1, 4)=?
     GROUP BY month`,
    [String(year)],
  );
  const byMonth = new Map(rows.map((row) => [row.month, row]));
  const months = [];
  for (let month = 1; month <= 12; month += 1) {
    const row = byMonth.get(month);
    const income = row ? Number(row.income) : 0;
    const expense = row ? Number(row.expense) : 0;
    months.push({
      month,
      income_minor: income,
      expense_minor: expense,
      net_minor: income - expense,
      expense_income_ratio: income ? expense / income : null,
    });
  }
  const totalIncome = months.reduce((sum, row) => sum + row.income_minor, 0);
  const totalExpense = months.reduce((sum, row) => sum + row.expense_minor, 0);
  const activeMonths = months.filter((row) => row.income_minor || row.expense_minor).length;
  const monthKey = `${String(year).padStart(4, "0")}-${String(detailMonth).padStart(2, "0")}`;

  const detailRows = db.all(
    `SELECT a.id AS account_id, a.name,
            sum(CASE WHEN a.account_type='income' THEN e.credit_minor-e.debit_minor ELSE e.debit_minor-e.credit_minor END) AS amount
     FROM current_transactions t
     JOIN entries e ON e.transaction_id=t.id
     JOIN accounts a ON a.id=e.account_id
     WHERE substr(t.transaction_date, 1, 7)=? AND a.account_type=?
     GROUP BY a.id, a.name HAVING amount!=0
     ORDER BY abs(amount) DESC, a.source_row_number`,
    [monthKey, detailType],
  );

  const yearDetailRows = db.all(
    `SELECT a.id AS account_id, a.name, a.parent_name,
            cast(substr(t.transaction_date, 6, 2) AS integer) AS month,
            t.id AS transaction_id, t.transaction_date, coalesce(t.memo, '') AS memo,
            CASE WHEN a.account_type='income' THEN e.credit_minor-e.debit_minor ELSE e.debit_minor-e.credit_minor END AS amount
     FROM current_transactions t
     JOIN entries e ON e.transaction_id=t.id
     JOIN accounts a ON a.id=e.account_id
     WHERE substr(t.transaction_date, 1, 4)=? AND a.account_type=? AND (e.debit_minor!=e.credit_minor)
     ORDER BY a.source_row_number, month, t.transaction_date, t.source_order`,
    [String(year), detailType],
  );
  const categoryMap = new Map();
  for (const row of yearDetailRows) {
    let category = categoryMap.get(row.account_id);
    if (!category) {
      category = { account_id: row.account_id, name: row.name, parent_name: row.parent_name, amount_minor: 0, monthsByNumber: new Map() };
      categoryMap.set(row.account_id, category);
    }
    const amount = Number(row.amount);
    category.amount_minor += amount;
    let monthDetail = category.monthsByNumber.get(row.month);
    if (!monthDetail) {
      monthDetail = { month: row.month, amount_minor: 0, transactions: [] };
      category.monthsByNumber.set(row.month, monthDetail);
    }
    monthDetail.amount_minor += amount;
    monthDetail.transactions.push({ id: row.transaction_id, date: row.transaction_date, memo: row.memo, amount_minor: amount });
  }
  const yearCategories = [...categoryMap.values()]
    .map((category) => ({ ...category, months: [...category.monthsByNumber.values()], monthsByNumber: undefined }))
    .map(({ monthsByNumber, ...rest }) => rest)
    .sort((a, b) => Math.abs(b.amount_minor) - Math.abs(a.amount_minor));

  return {
    year,
    months,
    totals: {
      income_minor: totalIncome,
      expense_minor: totalExpense,
      net_minor: totalIncome - totalExpense,
      expense_income_ratio: totalIncome ? totalExpense / totalIncome : null,
      active_months: activeMonths,
      average_income_minor: activeMonths ? Math.round(totalIncome / activeMonths) : 0,
      average_expense_minor: activeMonths ? Math.round(totalExpense / activeMonths) : 0,
      average_net_minor: activeMonths ? Math.round((totalIncome - totalExpense) / activeMonths) : 0,
    },
    detail: {
      month: detailMonth,
      type: detailType,
      categories: detailRows.map((row) => ({ account_id: row.account_id, name: row.name, amount_minor: row.amount })),
    },
    year_detail: { type: detailType, categories: yearCategories },
  };
}
