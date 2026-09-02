// 對應桌面版 exporter.py 的手機離線版本：把目前帳本輸出成跟 E-Money test.csv
// 相同的 31 欄、雙引號、CP950、CRLF 格式。
//
// JS 沒有內建的 Big5/CP950「編碼」器（TextEncoder 只會輸出 UTF-8），跟 importer.js
// 解碼用 TextDecoder('big5') 不同方向。這裡改用 cp950-table.json——一份由桌面版
// Python 直接跑 chr(cp).encode('cp950')（0x80~0xFFFF 全範圍嘗試）產生的「字元→
// 原始位元組」對照表，保證跟桌面版 Python 的 cp950 編碼結果逐位元組一致，不是憑
// 印象自己刻一份可能有出入的 Big5 表。已經實測驗證：用這份表整份重新編碼
// import/test.csv 解碼後的文字，結果跟原始檔案位元組完全相同（見開發紀錄）。
let tablePromise = null;
function loadCp950Table() {
  if (!tablePromise) tablePromise = fetch("/offline/cp950-table.json", { cache: "no-store" }).then((response) => response.json());
  return tablePromise;
}

export class ExportValidationError extends Error {}

function encodeCp950(text, table) {
  const bytes = [];
  for (const ch of text) {
    const codePoint = ch.codePointAt(0);
    if (codePoint < 0x80) {
      bytes.push(codePoint);
      continue;
    }
    const hex = table[ch];
    if (!hex) throw new ExportValidationError(`資料含有 CP950 無法表示的字元：${JSON.stringify(ch)}`);
    for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return new Uint8Array(bytes);
}

function quotedRow(row) {
  return row.map((field) => '"' + String(field ?? "").replaceAll('"', '""') + '"').join(",");
}

export async function exportCsv(db) {
  const rows = [];
  const accounts = db.all("SELECT source_fields_json FROM accounts ORDER BY source_row_number, id");
  for (const account of accounts) rows.push(JSON.parse(account.source_fields_json));

  const transactions = db.all(
    `SELECT id, transaction_date, memo, source_transaction_number
     FROM current_transactions
     ORDER BY transaction_date, source_order, created_at, id`,
  );
  for (const transaction of transactions) {
    const entries = db.all(
      `SELECT e.id, e.entry_order, e.debit_minor, e.credit_minor,
              e.memo, e.source_fields_json, a.name, a.source_type
       FROM entries e JOIN accounts a ON a.id=e.account_id
       WHERE e.transaction_id=? ORDER BY e.entry_order`,
      [transaction.id],
    );
    if (entries.length && entries.every((entry) => entry.source_fields_json)) {
      for (const entry of entries) rows.push(JSON.parse(entry.source_fields_json));
      continue;
    }

    const number = "N:" + transaction.id;
    entries.forEach((entry, index) => {
      const row = new Array(31).fill("");
      row[0] = "4";
      row[1] = entry.source_type;
      row[2] = transaction.transaction_date.replaceAll("-", "/");
      row[3] = entry.name;
      row[4] = String(entry.debit_minor);
      row[5] = String(entry.credit_minor);
      row[6] = entry.memo || (index === 0 ? transaction.memo : "") || "";
      row[8] = entry.source_type;
      row[9] = String(index + 1);
      row[14] = "1";
      row[15] = number;
      row[16] = "0";
      row[18] = "P" + entry.id.replaceAll("-", "").slice(0, 18);
      rows.push(row);
    });
  }

  const text = rows.map(quotedRow).join("\r\n") + (rows.length ? "\r\n" : "");
  const table = await loadCp950Table();
  return encodeCp950(text, table);
}
