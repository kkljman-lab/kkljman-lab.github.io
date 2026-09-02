// 對應桌面版 categories.py 的手機離線版本。
//
// 已知簡化（跟桌面版不完全一樣）：桌面版 rename_category() 會檢查新名稱能不能用 CP950
// 編碼表示（避免以後匯出 CSV 給舊軟體時出現存不下的字元），JS 沒有現成的 CP950
// 編碼器可以做這個檢查，這裡先省略。之後如果要補，需要自己刻一份 CP950 對照表或改用
// 其他偵測方式；在那之前，離線版允許輸入一些桌面版會擋下來的罕見字元。
import { AccountingValidationError } from "/offline/accounting.js";

const LOCAL_BATCH_ID = "local-categories";
// 跟桌面版 categories.py／匯入用的 importer.py 同一套 uuid5 算法（NAMESPACE_DNS
// 這個命名空間 UUID 也完全相同），讓「新增分類」改用固定編號、不再用隨機亂數：
// 手機/電腦各自獨立新增同名分類時會得到相同的內部 id，跨裝置同步合併資料庫時
// 才不會被誤判成兩個不同分類。importer.js 也是 import 這裡的 uuid5，不重複定義。
export const NAMESPACE_DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

function uuidToBytes(value) {
  const hex = value.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

function bytesToUuid(bytes) {
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function uuid5(namespace, name) {
  const namespaceBytes = uuidToBytes(namespace);
  const nameBytes = new TextEncoder().encode(name);
  const combined = new Uint8Array(namespaceBytes.length + nameBytes.length);
  combined.set(namespaceBytes);
  combined.set(nameBytes, namespaceBytes.length);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", combined)).slice(0, 16);
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return bytesToUuid(hash);
}
const EXPENSE_CATEGORY_HIERARCHY = {
  "生活飲食": ["早餐", "午餐", "晚餐", "宵夜", "飲料", "蔬菜水果肉類", "點心零食"],
  "居家物業": ["生活雜物", "住屋裝修", "住屋傢飾", "住屋家飾"],
  "行車交通": ["機車油費", "汽車油費", "汽機腳踏車修理", "停車費", "交通工具"],
  "行動通訊": ["手機+網路費", "手機＋網路費"],
  "服飾美容": ["置裝費"],
  "休閒娛樂": ["聚餐", "運動健身", "電影觀賞", "旅遊度假", "遊戲，軟體，玩具", "遊戲,軟體,玩具"],
  "醫療保健": ["醫療掛號", "健康檢查", "醫療藥物", "保健食品", "美容養生"],
  "教育學習": ["上課進修", "書籍購買"],
  "人情往來": ["婚喪喜慶", "送禮請客", "孝親費用", "慈善捐款"],
  "金融保險": ["汽機車險", "保險", "手續費"],
  "稅金": ["綜所稅"],
};
const MAJOR_EXPENSE_CATEGORIES = [
  "生活飲食", "居家物業", "行車交通", "行動通訊", "服飾美容",
  "休閒娛樂", "醫療保健", "教育學習", "人情往來", "金融保險", "稅金",
];

function ensureDefaults(db) {
  MAJOR_EXPENSE_CATEGORIES.forEach((name, index) => {
    db.run(
      `INSERT OR IGNORE INTO category_major_groups(account_id, display_order)
       SELECT id, ? FROM accounts WHERE account_type='expense' AND name=?`,
      [index + 1, name],
    );
  });
  db.run("DELETE FROM category_shortcuts WHERE account_id IN (SELECT account_id FROM category_major_groups)");
  if (db.one("SELECT 1 AS n FROM app_settings WHERE setting_key='category_shortcuts_v3'")) return;
  for (const [accountType, limit] of [["expense", 12], ["income", 8]]) {
    const current = db.one("SELECT count(*) AS n FROM category_shortcuts s JOIN accounts a ON a.id=s.account_id WHERE a.account_type=?", [accountType]).n;
    const rows = db.all(
      `SELECT id FROM accounts WHERE active=1 AND account_type=?
         AND id NOT IN (SELECT account_id FROM category_major_groups)
         AND id NOT IN (SELECT account_id FROM category_shortcuts)
         ORDER BY source_row_number LIMIT ?`,
      [accountType, Math.max(0, limit - current)],
    );
    const order = db.one("SELECT coalesce(max(shortcut_order), 0) AS n FROM category_shortcuts").n;
    rows.forEach((row, index) => {
      db.run("INSERT OR IGNORE INTO category_shortcuts(account_id, shortcut_order) VALUES (?, ?)", [row.id, order + index + 1]);
    });
  }
  db.run("INSERT INTO app_settings(setting_key, setting_value) VALUES ('category_shortcuts_v3', 'applied')");
}

export function listCategories(db, accountType) {
  if (accountType !== "expense" && accountType !== "income") throw new AccountingValidationError("分類類型必須是 expense 或 income");
  ensureDefaults(db);
  const majorIds = new Set(db.all("SELECT account_id FROM category_major_groups").map((row) => row.account_id));
  const rows = db.all(
    `SELECT a.id, a.name, a.account_type, a.parent_name, a.active, a.icon,
            CASE WHEN s.account_id IS NULL THEN 0 ELSE 1 END AS favorite,
            s.shortcut_order
     FROM accounts a LEFT JOIN category_shortcuts s ON s.account_id=a.id
     WHERE a.account_type=? AND a.active=1
     ORDER BY favorite DESC, s.shortcut_order, a.source_row_number, a.name`,
    [accountType],
  );
  const values = [];
  for (const row of rows) {
    if (majorIds.has(row.id)) continue;
    values.push({ ...row, group_name: row.parent_name });
  }
  return {
    favorites: values.filter((row) => row.favorite),
    available: values.filter((row) => !row.favorite),
  };
}

export function addShortcut(db, accountId) {
  const row = db.one("SELECT name, account_type, active FROM accounts WHERE id=?", [accountId]);
  if (!row || !row.active || (row.account_type !== "expense" && row.account_type !== "income")) {
    throw new AccountingValidationError("找不到可用的收支分類");
  }
  if (db.one("SELECT 1 AS n FROM category_major_groups WHERE account_id=?", [accountId])) {
    throw new AccountingValidationError("大分類只能作為分組，請選擇其下的細項分類");
  }
  const order = db.one("SELECT coalesce(max(shortcut_order), 0) + 1 AS n FROM category_shortcuts").n;
  db.run("INSERT OR IGNORE INTO category_shortcuts(account_id, shortcut_order) VALUES (?, ?)", [accountId, order]);
}

export function removeShortcut(db, accountId) {
  db.run("DELETE FROM category_shortcuts WHERE account_id=?", [accountId]);
}

export function listCategoryManagement(db, accountType) {
  if (accountType !== "expense" && accountType !== "income") throw new AccountingValidationError("分類類型必須是 expense 或 income");
  ensureDefaults(db);
  return db.all(
    `SELECT a.id, a.name, a.account_type, a.parent_name, a.active, a.icon,
            CASE WHEN g.account_id IS NULL THEN 0 ELSE 1 END AS is_major,
            CASE WHEN s.account_id IS NULL THEN 0 ELSE 1 END AS favorite,
            count(e.id) AS usage_count
     FROM accounts a
     LEFT JOIN category_major_groups g ON g.account_id=a.id
     LEFT JOIN category_shortcuts s ON s.account_id=a.id
     LEFT JOIN entries e ON e.account_id=a.id
     WHERE a.account_type=? AND a.active=1
     GROUP BY a.id
     ORDER BY is_major DESC, coalesce(g.display_order, 999), coalesce(a.child_order, 999999), a.source_row_number, a.name`,
    [accountType],
  );
}

export function reorderCategories(db, accountType, parentName, ids) {
  if (accountType !== "expense" && accountType !== "income") throw new AccountingValidationError("分類類型必須是 expense 或 income");
  if (!ids.length) throw new AccountingValidationError("排序清單不可為空");
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.all(
    `SELECT a.id, a.parent_name, CASE WHEN g.account_id IS NULL THEN 0 ELSE 1 END AS is_major
     FROM accounts a LEFT JOIN category_major_groups g ON g.account_id=a.id
     WHERE a.id IN (${placeholders}) AND a.account_type=? AND a.active=1`,
    [...ids, accountType],
  );
  if (rows.length !== ids.length) throw new AccountingValidationError("排序清單包含無效的分類");
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const id of ids) {
    const row = byId.get(id);
    if (parentName === null) {
      if (!row.is_major) throw new AccountingValidationError("排序清單必須全部是大分類");
    } else if (row.is_major || row.parent_name !== parentName) {
      throw new AccountingValidationError("排序清單必須是同一個大分類底下的小分類");
    }
  }
  db.transaction(() => {
    ids.forEach((id, index) => {
      if (parentName === null) {
        db.run("UPDATE category_major_groups SET display_order=? WHERE account_id=?", [index, id]);
      } else {
        db.run("UPDATE accounts SET child_order=? WHERE id=?", [index, id]);
      }
    });
  });
}

export function renameCategory(db, accountId, newName) {
  newName = newName.trim();
  if (!newName || newName.length > 80) throw new AccountingValidationError("分類名稱需為 1 到 80 個字元");
  const account = db.one("SELECT * FROM accounts WHERE id=?", [accountId]);
  if (!account) throw new AccountingValidationError("找不到分類");
  const duplicate = db.one(
    "SELECT 1 AS n FROM accounts WHERE id!=? AND name=? AND account_type=? AND active=1",
    [accountId, newName, account.account_type],
  );
  if (duplicate) throw new AccountingValidationError("已有相同名稱的分類");
  const oldName = account.name;
  if (oldName === newName) return;
  db.transaction(() => {
    const fields = JSON.parse(account.source_fields_json);
    fields[1] = newName;
    fields[5] = newName;
    db.run("UPDATE accounts SET name=?, source_name=?, source_fields_json=? WHERE id=?", [newName, newName, JSON.stringify(fields), accountId]);
    if (db.one("SELECT 1 AS n FROM category_major_groups WHERE account_id=?", [accountId])) {
      db.run("UPDATE accounts SET parent_name=? WHERE account_type=? AND parent_name=?", [newName, account.account_type, oldName]);
    }
    const sourceEntries = db.all("SELECT id, source_fields_json FROM entries WHERE account_id=? AND source_fields_json IS NOT NULL", [accountId]);
    for (const entry of sourceEntries) {
      const entryFields = JSON.parse(entry.source_fields_json);
      entryFields[3] = newName;
      db.run("UPDATE entries SET source_fields_json=? WHERE id=?", [JSON.stringify(entryFields), entry.id]);
    }
    db.run(
      "INSERT INTO audit_events(event_type, entity_type, entity_id, details_json) VALUES ('category_renamed', 'account', ?, ?)",
      [accountId, JSON.stringify({ before: oldName, after: newName })],
    );
  });
}

export function moveCategory(db, accountId, parentName) {
  ensureDefaults(db);
  const account = db.one("SELECT * FROM accounts WHERE id=? AND active=1", [accountId]);
  if (!account || (account.account_type !== "expense" && account.account_type !== "income")) throw new AccountingValidationError("找不到分類");
  if (db.one("SELECT 1 AS n FROM category_major_groups WHERE account_id=?", [accountId])) {
    throw new AccountingValidationError("大分類不能移到其他大分類下");
  }
  parentName = parentName ? parentName.trim() : null;
  if (parentName) {
    const parent = db.one(
      `SELECT a.id FROM accounts a JOIN category_major_groups g ON g.account_id=a.id
       WHERE a.name=? AND a.account_type=? AND a.active=1`,
      [parentName, account.account_type],
    );
    if (!parent) throw new AccountingValidationError("找不到可用的大分類");
  }
  db.transaction(() => {
    const fields = JSON.parse(account.source_fields_json);
    fields[4] = parentName || "";
    db.run("UPDATE accounts SET parent_name=?, source_fields_json=? WHERE id=?", [parentName, JSON.stringify(fields), accountId]);
    db.run(
      "INSERT INTO audit_events(event_type, entity_type, entity_id, details_json) VALUES ('category_moved', 'account', ?, ?)",
      [accountId, JSON.stringify({ parent_name: parentName })],
    );
  });
}

export function deactivateCategory(db, accountId) {
  const account = db.one("SELECT name FROM accounts WHERE id=? AND active=1", [accountId]);
  if (!account) throw new AccountingValidationError("找不到分類");
  db.run("UPDATE accounts SET active=0 WHERE id=?", [accountId]);
  db.run("DELETE FROM category_shortcuts WHERE account_id=?", [accountId]);
  db.run(
    "INSERT INTO audit_events(event_type, entity_type, entity_id, details_json) VALUES ('category_deactivated', 'account', ?, ?)",
    [accountId, JSON.stringify({ name: account.name })],
  );
}

export async function createCategory(db, name, accountType, parentName) {
  name = name.trim();
  if (!name || name.length > 80) throw new AccountingValidationError("分類名稱需為 1 到 80 個字元");
  if (accountType !== "expense" && accountType !== "income") throw new AccountingValidationError("分類類型必須是 expense 或 income");
  ensureDefaults(db);
  parentName = parentName ? parentName.trim() : null;
  if (parentName) {
    const parent = db.one(
      `SELECT a.id FROM accounts a JOIN category_major_groups g ON g.account_id=a.id
       WHERE a.name=? AND a.account_type=? AND a.active=1`,
      [parentName, accountType],
    );
    if (!parent) throw new AccountingValidationError("找不到可用的大分類");
  }
  const existing = db.one("SELECT id, active FROM accounts WHERE name=? AND account_type=? LIMIT 1", [name, accountType]);
  if (existing) {
    if (!existing.active) db.run("UPDATE accounts SET active=1 WHERE id=?", [existing.id]);
    if (parentName) moveCategory(db, existing.id, parentName);
    addShortcut(db, existing.id);
    return existing.id;
  }
  const sourceType = accountType === "expense" ? "支出" : "收入";
  const fields = new Array(31).fill("");
  fields[0] = "1";
  fields[1] = name;
  fields[2] = sourceType;
  fields[3] = "0";
  fields[4] = parentName || "";
  fields[5] = name;
  fields[6] = "1";
  fields[8] = "Y";
  const accountId = await uuid5(NAMESPACE_DNS, `personal-accounting.local/category/${accountType}/${name}`);
  db.transaction(() => {
    db.run(
      `INSERT OR IGNORE INTO import_batches(id, source_name, sha256, encoding, importer_version, status, source_rows, account_rows, completed_at)
       VALUES (?, '本機新增分類', 'local-categories', 'cp950', 'local', 'completed', 0, 0, CURRENT_TIMESTAMP)`,
      [LOCAL_BATCH_ID],
    );
    const rowNumber = db.one("SELECT coalesce(max(source_row_number), 0) + 1 AS n FROM accounts WHERE import_batch_id=?", [LOCAL_BATCH_ID]).n;
    db.run(
      `INSERT INTO accounts(id, import_batch_id, source_row_number, source_name, name, account_type, source_type, parent_name, active, source_fields_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [accountId, LOCAL_BATCH_ID, rowNumber, name, name, accountType, sourceType, parentName, JSON.stringify(fields)],
    );
    const order = db.one("SELECT coalesce(max(shortcut_order), 0) + 1 AS n FROM category_shortcuts").n;
    db.run("INSERT INTO category_shortcuts(account_id, shortcut_order) VALUES (?, ?)", [accountId, order]);
    db.run(
      "INSERT INTO audit_events(event_type, entity_type, entity_id, details_json) VALUES ('category_created', 'account', ?, ?)",
      [accountId, JSON.stringify({ name, account_type: accountType })],
    );
  });
  return accountId;
}

function mergeDuplicateAccount(db, duplicateId, intoId) {
  db.transaction(() => {
    db.run("UPDATE entries SET account_id=? WHERE account_id=?", [intoId, duplicateId]);
    db.run("UPDATE accounts SET active=0 WHERE id=?", [duplicateId]);
    db.run("DELETE FROM category_shortcuts WHERE account_id=?", [duplicateId]);
    db.run("UPDATE recurring_transactions SET category_account_id=? WHERE category_account_id=?", [intoId, duplicateId]);
    db.run("UPDATE recurring_transactions SET counterpart_account_id=? WHERE counterpart_account_id=?", [intoId, duplicateId]);
    db.run(
      "INSERT INTO audit_events(event_type, entity_type, entity_id, details_json) VALUES ('category_duplicate_merged', 'account', ?, ?)",
      [duplicateId, JSON.stringify({ merged_into: intoId })],
    );
  });
}


export function repairKnownCategoryNames(db) {
  const row = db.one("SELECT id FROM accounts WHERE name='汽機[44]腳踏車修理' LIMIT 1");
  if (!row) return;
  const existing = db.one("SELECT id FROM accounts WHERE name='汽機腳踏車修理' AND id!=? LIMIT 1", [row.id]);
  if (existing) {
    mergeDuplicateAccount(db, row.id, existing.id);
  } else {
    renameCategory(db, row.id, "汽機腳踏車修理");
  }
}

export function repairCategoryHierarchy(db) {
  if (db.one("SELECT 1 AS n FROM app_settings WHERE setting_key='category_hierarchy_v2'")) return;
  const knownChildren = Object.values(EXPENSE_CATEGORY_HIERARCHY).flat();
  const placeholders = knownChildren.map(() => "?").join(",");
  const anyPresent = db.one(`SELECT 1 AS n FROM accounts WHERE account_type='expense' AND name IN (${placeholders}) LIMIT 1`, knownChildren);
  if (!anyPresent) return;
  for (const [parentName, children] of Object.entries(EXPENSE_CATEGORY_HIERARCHY)) {
    const childPlaceholders = children.map(() => "?").join(",");
    db.run(`UPDATE accounts SET parent_name=? WHERE account_type='expense' AND name IN (${childPlaceholders})`, [parentName, ...children]);
  }
  db.run("INSERT INTO app_settings(setting_key, setting_value) VALUES ('category_hierarchy_v2', 'applied')");
}
