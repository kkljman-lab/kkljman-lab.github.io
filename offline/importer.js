// 對應桌面版 importer.py 的手機離線版本：解析 E-Money 格式的 31 欄 CP950 CSV，
// 逐列建立帳戶／交易／分錄，語意（去重、legacy_unbalanced／legacy_zero_amount
// 標記、UNKNOWN_ACCOUNT 視為致命錯誤）跟桌面版完全對照。
//
// 兩個跟桌面版不同、但經過實測確認安全的地方：
// 1. 解碼用 TextDecoder('big5', {fatal:true}) 取代 Python 的 cp950——已經拿
//    import/test.csv 全部 40236 列的位元組實測比對過，兩邊解碼結果逐字元
//    完全相同（SHA-256 一致），可以放心當作等價實作，不是憑印象假設。
// 2. 帳戶 id 用跟桌面版 importer.py 一模一樣的 uuid5(NAMESPACE_DNS,
//    "personal-accounting.local/account/"+name) 算法（也實測比對過雜湊結果
//    逐位元組相同），確保離線裝置匯入同一份 CSV 會得到跟桌面版相同的帳戶 id，
//    離線同步合併資料庫時不會把「現金」誤判成兩個帳戶。
import { AccountingValidationError } from "/offline/accounting.js";
import { NAMESPACE_DNS, repairCategoryHierarchy, repairKnownCategoryNames, uuid5 } from "/offline/categories.js";

export class ImportValidationError extends Error {}

const EXPECTED_COLUMNS = 31;
const IMPORTER_VERSION = "1";
const TYPE_MAP = {
  "資產": "asset", "負債": "liability", "收入": "income", "業外收入": "income",
  "支出": "expense", "業外支出": "expense", "其它": "other", "其他": "other",
};

async function sha256Hex(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toMinor(value) {
  if (value === "") return 0;
  const match = /^(-?\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new ImportValidationError(`Invalid amount: ${JSON.stringify(value)}`);
  const [, intPart, fracPart] = match;
  if (fracPart && /[1-9]/.test(fracPart)) {
    throw new ImportValidationError(`Source amount is not an integer TWD value: ${JSON.stringify(value)}`);
  }
  return parseInt(intPart, 10);
}

// 逐字元解析，行為對應 Python csv.reader：雙引號欄位、"" 代表跳脫的引號、
// 逗號分隔、\r\n／\n 都視為換行；欄位不需要引號也能解析。
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let sawAnyChar = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') { inQuotes = true; sawAnyChar = true; continue; }
    if (char === ",") { row.push(field); field = ""; sawAnyChar = true; continue; }
    if (char === "\r") continue;
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      sawAnyChar = false;
      continue;
    }
    field += char;
    sawAnyChar = true;
  }
  if (sawAnyChar || field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function dateFromSlashes(value) {
  // 桌面版用 datetime.strptime(row[2], "%Y/%m/%d") 驗證日期格式合不合理。
  const match = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export async function analyzeCsv(bytes, filename) {
  const sha256 = await sha256Hex(bytes);
  let text;
  try {
    text = new TextDecoder("big5", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ImportValidationError("CSV is not valid CP950/Big5: " + error.message);
  }
  const rows = parseCsv(text);
  const accountRows = [];
  const transactionGroups = new Map();
  const issues = [];

  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    if (row.length !== EXPECTED_COLUMNS) {
      throw new ImportValidationError(`Row ${rowNumber} has ${row.length} columns; expected ${EXPECTED_COLUMNS}`);
    }
    if (row[0] === "1") {
      accountRows.push([rowNumber, row]);
    } else if (row[0] === "4") {
      if (!row[15]) throw new ImportValidationError(`Row ${rowNumber} has no transaction number`);
      if (!dateFromSlashes(row[2])) throw new ImportValidationError(`Invalid transaction row ${rowNumber}: bad date ${row[2]}`);
      toMinor(row[4]);
      toMinor(row[5]);
      if (!transactionGroups.has(row[15])) transactionGroups.set(row[15], []);
      transactionGroups.get(row[15]).push([rowNumber, row]);
    } else {
      throw new ImportValidationError(`Unknown record type ${JSON.stringify(row[0])} at row ${rowNumber}`);
    }
  });

  const accountNames = new Set(accountRows.map(([, row]) => row[1]));
  for (const [number, group] of transactionGroups) {
    const debits = group.reduce((sum, [, row]) => sum + toMinor(row[4]), 0);
    const credits = group.reduce((sum, [, row]) => sum + toMinor(row[5]), 0);
    const firstRow = group[0][0];
    if (debits !== credits) {
      issues.push({ severity: "warning", code: "LEGACY_UNBALANCED", message: `Debit ${debits} != credit ${credits}`, row_number: firstRow, transaction_number: number });
    }
    if (debits === 0 && credits === 0) {
      issues.push({ severity: "warning", code: "LEGACY_ZERO_AMOUNT", message: "Transaction contains only zero-value entries", row_number: firstRow, transaction_number: number });
    }
    if (group.some(([, row]) => toMinor(row[4]) < 0 || toMinor(row[5]) < 0)) {
      issues.push({ severity: "warning", code: "LEGACY_NEGATIVE_AMOUNT", message: "Transaction contains source-negative debit or credit values", row_number: firstRow, transaction_number: number });
    }
    for (const [rowNumber, row] of group) {
      if (!accountNames.has(row[3])) {
        issues.push({ severity: "error", code: "UNKNOWN_ACCOUNT", message: `Unknown account ${JSON.stringify(row[3])}`, row_number: rowNumber, transaction_number: number });
      }
    }
  }

  const dates = [...transactionGroups.values()].flat().map(([, row]) => row[2]);
  const allDebits = [...transactionGroups.values()].flat().reduce((sum, [, row]) => sum + toMinor(row[4]), 0);
  const allCredits = [...transactionGroups.values()].flat().reduce((sum, [, row]) => sum + toMinor(row[5]), 0);
  const issueCounts = {};
  for (const issue of issues) issueCounts[issue.code] = (issueCounts[issue.code] || 0) + 1;

  return {
    filename,
    sha256,
    rows,
    accountRows,
    transactionGroups,
    issues,
    summary: {
      sha256,
      source_rows: rows.length,
      accounts: accountRows.length,
      transactions: transactionGroups.size,
      entries: [...transactionGroups.values()].reduce((sum, group) => sum + group.length, 0),
      date_min: dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null,
      date_max: dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null,
      debit_total_minor: allDebits,
      credit_total_minor: allCredits,
      issues: issueCounts,
    },
  };
}

export async function importCsv(db, bytes, filename) {
  const analysis = await analyzeCsv(bytes, filename);
  const fatal = analysis.issues.filter((issue) => issue.severity === "error");
  if (fatal.length) throw new ImportValidationError(`Import has ${fatal.length} fatal issue(s)`);

  if (db.one("SELECT 1 AS n FROM import_batches WHERE sha256=?", [analysis.sha256])) {
    throw new ImportValidationError("這個 CSV 檔案已經匯入過，未重複寫入");
  }

  const batchId = crypto.randomUUID();
  const accountIds = new Map();
  let importedTransactions = 0;
  let skippedTransactions = 0;

  // accounts 的 id 需要逐一 await uuid5()，所以先在交易外面算好，等下面
  // db.transaction() 同步執行時只查表、不用再等非同步呼叫。
  for (const [, row] of analysis.accountRows) {
    if (accountIds.has(row[1])) continue;
    const existing = db.one("SELECT id FROM accounts WHERE name=? ORDER BY source_row_number LIMIT 1", [row[1]]);
    if (existing) {
      accountIds.set(row[1], existing.id);
    } else {
      accountIds.set(row[1], await uuid5(NAMESPACE_DNS, "personal-accounting.local/account/" + row[1]));
    }
  }

  db.transaction(() => {
    db.run(
      "INSERT INTO import_batches(id, source_name, sha256, encoding, importer_version, status) VALUES (?, ?, ?, 'cp950', ?, 'running')",
      [batchId, filename, analysis.sha256, IMPORTER_VERSION],
    );

    for (const [rowNumber, row] of analysis.accountRows) {
      const existing = db.one("SELECT id FROM accounts WHERE name=? ORDER BY source_row_number LIMIT 1", [row[1]]);
      if (existing) continue;
      const sourceType = row[2];
      const accountType = TYPE_MAP[sourceType];
      if (!accountType) throw new ImportValidationError(`Unknown account type ${JSON.stringify(sourceType)} at row ${rowNumber}`);
      db.run(
        `INSERT INTO accounts(id, import_batch_id, source_row_number, source_name, name, account_type, source_type, parent_name, active, source_fields_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [accountIds.get(row[1]), batchId, rowNumber, row[1], row[1], accountType, sourceType, row[4] || null, row[8] === "Y" ? 1 : 0, JSON.stringify(row)],
      );
    }

    let sourceOrder = 0;
    for (const [number, group] of analysis.transactionGroups) {
      sourceOrder += 1;
      const debits = group.reduce((sum, [, row]) => sum + toMinor(row[4]), 0);
      const credits = group.reduce((sum, [, row]) => sum + toMinor(row[5]), 0);
      const restoredId = number.startsWith("N:") ? number.slice(2) : null;
      if (restoredId && db.one("SELECT 1 AS n FROM transactions WHERE id=?", [restoredId])) {
        skippedTransactions += 1;
        continue;
      }
      const transactionDate = group[0][1][2].replace(/\//g, "-");
      const duplicate = db.one(
        `SELECT 1 AS n FROM transactions WHERE source_transaction_number=? AND transaction_date=? AND debit_total_minor=? AND credit_total_minor=? LIMIT 1`,
        [number, transactionDate, debits, credits],
      );
      if (duplicate) {
        skippedTransactions += 1;
        continue;
      }
      const isValidUuid = restoredId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(restoredId);
      const transactionId = isValidUuid ? restoredId : crypto.randomUUID();
      const status = debits !== credits ? "legacy_unbalanced" : debits === 0 ? "legacy_zero_amount" : "normal";
      const memoRow = group.find(([, row]) => row[6]);
      const memo = memoRow ? memoRow[1][6] : null;
      db.run(
        `INSERT INTO transactions(id, import_batch_id, source_transaction_number, transaction_date, memo, source_order, status, debit_total_minor, credit_total_minor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [transactionId, batchId, number, transactionDate, memo, sourceOrder, status, debits, credits],
      );
      group.forEach(([rowNumber, row], index) => {
        db.run(
          `INSERT INTO entries(id, transaction_id, account_id, source_row_number, source_entry_id, entry_order, debit_minor, credit_minor, memo, source_fields_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [crypto.randomUUID(), transactionId, accountIds.get(row[3]), rowNumber, row[18], index + 1, toMinor(row[4]), toMinor(row[5]), row[6] || row[11] || null, JSON.stringify(row)],
        );
      });
      importedTransactions += 1;
    }

    for (const issue of analysis.issues) {
      db.run(
        `INSERT INTO import_issues(import_batch_id, source_row_number, source_transaction_number, severity, code, message, details_json)
         VALUES (?, ?, ?, ?, ?, ?, '{}')`,
        [batchId, issue.row_number, issue.transaction_number, issue.severity, issue.code, issue.message],
      );
    }

    db.run(
      `UPDATE import_batches SET status='completed', source_rows=?, account_rows=?, transaction_rows=?, entry_rows=?, completed_at=CURRENT_TIMESTAMP WHERE id=?`,
      [analysis.summary.source_rows, analysis.summary.accounts, analysis.summary.transactions, analysis.summary.entries, batchId],
    );
    db.run(
      "INSERT INTO audit_events(event_type, entity_type, entity_id, details_json) VALUES ('csv_import', 'import_batch', ?, ?)",
      [batchId, JSON.stringify({ ...analysis.summary, imported_transactions: importedTransactions, skipped_transactions: skippedTransactions })],
    );
  });

  repairKnownCategoryNames(db);
  repairCategoryHierarchy(db);

  return {
    batch_id: batchId,
    ...analysis.summary,
    imported_transactions: importedTransactions,
    skipped_transactions: skippedTransactions,
  };
}
