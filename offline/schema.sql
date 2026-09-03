PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS app_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS import_batches (
    id TEXT PRIMARY KEY,
    source_name TEXT NOT NULL,
    sha256 TEXT NOT NULL UNIQUE,
    encoding TEXT NOT NULL,
    importer_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    source_rows INTEGER NOT NULL DEFAULT 0,
    account_rows INTEGER NOT NULL DEFAULT 0,
    transaction_rows INTEGER NOT NULL DEFAULT 0,
    entry_rows INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    import_batch_id TEXT NOT NULL REFERENCES import_batches(id),
    source_row_number INTEGER NOT NULL,
    source_name TEXT NOT NULL,
    name TEXT NOT NULL,
    account_type TEXT NOT NULL CHECK (
        account_type IN ('asset', 'liability', 'income', 'expense', 'other')
    ),
    source_type TEXT NOT NULL,
    parent_name TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    source_fields_json TEXT NOT NULL,
    child_order INTEGER,
    icon TEXT,
    UNIQUE (import_batch_id, source_row_number)
);

CREATE INDEX IF NOT EXISTS accounts_name_idx ON accounts(name);

CREATE TABLE IF NOT EXISTS category_shortcuts (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    shortcut_order INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS category_major_groups (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    display_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    import_batch_id TEXT REFERENCES import_batches(id),
    source_transaction_number TEXT,
    transaction_date TEXT NOT NULL,
    memo TEXT,
    source_order INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('normal', 'legacy_unbalanced', 'legacy_zero_amount', 'voided')
    ),
    debit_total_minor INTEGER NOT NULL,
    credit_total_minor INTEGER NOT NULL,
    revision_of_id TEXT REFERENCES transactions(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (import_batch_id, source_transaction_number)
);

CREATE INDEX IF NOT EXISTS transactions_date_idx ON transactions(transaction_date);
CREATE INDEX IF NOT EXISTS transactions_revision_of_idx ON transactions(revision_of_id);

-- 「目前有效」的交易：本身未作廢、沒有「未作廢的」更新版本頂替它（見 accounting.update_transaction），
-- 也不是尚未解決的同步衝突候選版本（見 accounting.detect_sync_conflicts）。
-- 編輯一律用新增一列＋revision_of_id 指回舊列的方式進行，舊列原始內容永遠不被覆寫或刪除，
-- 這樣多裝置離線同步時合併資料只需要「新增」，不需要處理同一列被兩端同時覆寫的衝突；
-- 兩端各自把同一筆舊交易編輯出不同新版本時，在使用者於「同步」畫面選定要保留哪個版本之前，
-- 兩個候選版本都先從報表暫時隱藏，避免同一筆交易的兩個版本被誤算成兩筆而虛增金額。
-- 判斷「有沒有更新版本頂替」時只算未作廢的子版本：如果最新的編輯版本後來被作廢（刪除），
-- 舊版本會自動重新變回目前有效版本，等同於「回復上一版」，而不是這筆交易就此從報表消失。
-- 用 DROP+CREATE（而非 IF NOT EXISTS）是因為 view 沒有資料、重新定義沒有風險，
-- 這樣每次 migrate() 都會套用 schema.sql 目前的最新定義，不需要另外寫欄位補丁。
DROP VIEW IF EXISTS current_transactions;
CREATE VIEW current_transactions AS
SELECT * FROM transactions
WHERE status != 'voided'
  AND id NOT IN (SELECT revision_of_id FROM transactions WHERE revision_of_id IS NOT NULL AND status != 'voided')
  AND id NOT IN (
      SELECT candidate.value FROM sync_conflicts, json_each(sync_conflicts.candidate_ids_json) AS candidate
      WHERE sync_conflicts.status = 'open'
  );

CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY,
    transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    source_row_number INTEGER,
    source_entry_id TEXT,
    entry_order INTEGER NOT NULL,
    debit_minor INTEGER NOT NULL DEFAULT 0,
    credit_minor INTEGER NOT NULL DEFAULT 0,
    memo TEXT,
    source_fields_json TEXT,
    CHECK (NOT (debit_minor != 0 AND credit_minor != 0)),
    UNIQUE (transaction_id, entry_order)
);

CREATE INDEX IF NOT EXISTS entries_transaction_idx ON entries(transaction_id);
CREATE INDEX IF NOT EXISTS entries_account_idx ON entries(account_id);

CREATE TABLE IF NOT EXISTS import_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_batch_id TEXT NOT NULL REFERENCES import_batches(id),
    source_row_number INTEGER,
    source_transaction_number TEXT,
    severity TEXT NOT NULL CHECK (severity IN ('warning', 'error')),
    code TEXT NOT NULL,
    message TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transaction_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
    revision_number INTEGER NOT NULL,
    before_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (transaction_id, revision_number)
);

CREATE TABLE IF NOT EXISTS exchange_rate_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    currency TEXT NOT NULL CHECK (currency IN ('JPY', 'CNY', 'USD')),
    twd_rate TEXT NOT NULL,
    rate_kind TEXT NOT NULL DEFAULT 'spot_sell',
    source_name TEXT NOT NULL,
    source_url TEXT NOT NULL,
    quoted_at TEXT,
    fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS exchange_rate_currency_time_idx
    ON exchange_rate_snapshots(currency, fetched_at DESC);

CREATE TABLE IF NOT EXISTS transaction_exchange_rates (
    transaction_id TEXT PRIMARY KEY REFERENCES transactions(id) ON DELETE RESTRICT,
    currency TEXT NOT NULL CHECK (currency IN ('JPY', 'CNY', 'USD')),
    foreign_amount TEXT NOT NULL,
    twd_rate TEXT NOT NULL,
    rate_kind TEXT NOT NULL DEFAULT 'spot_sell',
    source_name TEXT NOT NULL,
    source_url TEXT NOT NULL,
    quoted_at TEXT,
    captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 兩端資料合併後偵測到的衝突：同一筆舊交易被兩端各自編輯出不同的新版本（fork_edit），
-- 或一端刪除、另一端編輯了同一筆交易（edit_vs_void）。只記錄、不自動判斷對錯，
-- 由使用者在「同步」畫面手動選擇要保留哪個版本；解決方式是把沒選中的版本作廢。
CREATE TABLE IF NOT EXISTS sync_conflicts (
    id TEXT PRIMARY KEY,
    transaction_id TEXT NOT NULL REFERENCES transactions(id),
    conflict_type TEXT NOT NULL CHECK (conflict_type IN ('fork_edit', 'edit_vs_void')),
    candidate_ids_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    resolved_transaction_id TEXT REFERENCES transactions(id),
    detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS backup_runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    backup_sha256 TEXT,
    encrypted INTEGER NOT NULL DEFAULT 0 CHECK (encrypted IN (0, 1)),
    destination TEXT,
    integrity_ok INTEGER CHECK (integrity_ok IN (0, 1)),
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
);

CREATE TABLE IF NOT EXISTS client_sync_receipts (
    client_request_id TEXT PRIMARY KEY,
    transaction_id TEXT NOT NULL REFERENCES transactions(id),
    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS recurring_transactions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    account_type TEXT NOT NULL CHECK (account_type IN ('expense', 'income')),
    category_account_id TEXT NOT NULL REFERENCES accounts(id),
    counterpart_account_id TEXT NOT NULL REFERENCES accounts(id),
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    frequency TEXT NOT NULL CHECK (frequency IN ('monthly', 'yearly')),
    day_of_month INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
    month_of_year INTEGER CHECK (month_of_year BETWEEN 1 AND 12),
    start_date TEXT NOT NULL,
    end_date TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    last_generated_date TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stock_holdings (
    id TEXT PRIMARY KEY,
    ticker TEXT NOT NULL,
    name TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    broker_account TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- 上次「查詢股利」的完整結果（跟 dividend_lookup.py 的 fetch_dividend_info() 回傳
    -- 的字典結構一樣，失敗時是 {"error": "..."}），存成 JSON 字串。查詢股利改成
    -- 不再每次打開視窗就自動查一次（見 PROJECT_SPEC.md 13.65），存起來才能讓下次
    -- 打開視窗時直接顯示上次查到的結果，不用等網路查詢。
    dividend_lookup_json TEXT
);

INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);
