// 驗證用：確認 SQLite WASM 能在 Worker 裡用 OPFS 建立「真的存在硬碟上」的資料庫，
// 而且資料在分頁關掉、Worker 重開之後還在——這是手機離線帳本能不能做的關鍵前提。
//
// 注意：套件 README 範例用的 `sqlite3.oo1.OpfsDb`／`'opfs' in sqlite3` 是舊版寫法，
// 這個版本（3.53.0-build1）實際上要用 sqlite3.installOpfsSAHPoolVfs() 這個新版 API，
// 舊寫法會靜默失敗（背後的 initOptions() 用 try/catch 吞掉錯誤，完全不會有任何警告訊息），
// 這裡是花了不少力氣一路追進 vendor 原始碼才確定的，記錄下來避免以後又繞回舊寫法。
import sqlite3InitModule from "/vendor/sqlite-wasm/index.mjs";

async function run() {
  const sqlite3 = await sqlite3InitModule();
  if (typeof sqlite3.installOpfsSAHPoolVfs !== "function") {
    self.postMessage({ ok: false, error: "installOpfsSAHPoolVfs not available in this build" });
    return;
  }
  const poolUtil = await sqlite3.installOpfsSAHPoolVfs({ name: "opfs-test-pool" });
  const db = new poolUtil.OpfsSAHPoolDb("/opfs-test.sqlite3");
  db.exec("CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY, note TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)");
  const before = db.selectValue("SELECT count(*) FROM probe");
  db.exec({ sql: "INSERT INTO probe (note) VALUES (?)", bind: ["hello from " + new Date().toISOString()] });
  const after = db.selectValue("SELECT count(*) FROM probe");
  const rows = [];
  db.exec({
    sql: "SELECT id, note, created_at FROM probe ORDER BY id",
    rowMode: "object",
    callback: (row) => rows.push(row),
  });
  db.close();
  self.postMessage({ ok: true, countBefore: before, countAfter: after, rows, libVersion: sqlite3.version.libVersion });
}

run().catch((error) => self.postMessage({ ok: false, error: String((error && error.stack) || error) }));
