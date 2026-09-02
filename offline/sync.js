// 手機離線引擎的裝置對裝置合併，對應桌面版 sync.py 的 merge_remote 核心規則：
// 只新增本機沒有的列（INSERT OR IGNORE），從不覆寫既有列——因為交易編輯／作廢
// 一律是新增新版本（見 accounting.js 的 updateTransaction／voidTransaction），
// 合併永遠安全；真正需要人工判斷的衝突交給 accounting.detectSyncConflicts。
//
// 桌面版的 push/pull 走 Google Drive；離線引擎目前還沒有 Drive 的 PKCE 授權流程
// （見 PROJECT_SPEC.md 13.8 第 2 項，需要使用者先在 Google Cloud Console 設定，
// 不是本機能單方面決定的事），所以這裡先提供一個誠實的替代方案：使用者手動把
// 這台裝置的帳本快照（.sqlite3 檔）匯出，用任何管道（Google Drive 網頁版拖曳、
// 郵件附件、AirDrop……）轉給另一台裝置，另一台裝置再用「選擇快照檔案」匯入合併。
// 核心合併與衝突偵測邏輯跟未來真正接上 Drive 後會用到的完全相同，先把最難的
// 資料正確性部分做完、驗證過，之後只需要換掉「怎麼把檔案搬過去」這一段傳輸方式。
//
// sqlite-wasm 的 OPFS SAHPool VFS 一個 pool 可以同時放好幾個具名檔案（見
// poolUtil.importDb/exportFile/unlink），但同一份檔案同一時間只能有一個連線持有
// （見 PROJECT_SPEC.md 13.4，兩個連線搶同一份檔案會鎖死或讓資料庫看起來是空的）。
// 這裡刻意不用 SQL 的 ATTACH DATABASE 語法合併——直接在 JS 裡逐表 SELECT 兩邊、
// 用 INSERT OR IGNORE 寫回主資料庫，邏輯跟桌面版一樣，只是換一種寫法表達。
import { detectSyncConflicts } from "/offline/accounting.js";
import { DriveError, driveDownloadFile, driveListFiles, driveUploadFile, decryptData, encryptData, refreshAccessToken } from "/offline/drive.js";

export class SyncError extends Error {}

// 幾個存在 app_settings 的小設定，跟 deviceId() 是同一種存法（key/value，沒有的話
// 用 INSERT 補一筆）。跟桌面版不同的地方只有：離線引擎沒有登入 session，所以
// refresh token／加密金鑰直接存在這台裝置自己的資料庫裡，不像桌面版用
// session_secret 再包一層——安全等級大致等同桌面版把它們存在本機檔案系統。
function getSetting(db, key) {
  const row = db.one("SELECT setting_value AS v FROM app_settings WHERE setting_key=?", [key]);
  return row ? row.v : null;
}

function setSetting(db, key, value) {
  db.run(
    "INSERT INTO app_settings(setting_key, setting_value) VALUES (?, ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value",
    [key, value],
  );
}

export function lastSeenRevision(db) {
  const value = getSetting(db, "sync_last_revision");
  return value ? parseInt(value, 10) : 0;
}

function setLastSeenRevision(db, revision) {
  setSetting(db, "sync_last_revision", String(revision));
}

export function driveRefreshToken(db) {
  return getSetting(db, "google_refresh_token");
}

// `source` 記著這個 refresh token 是哪一組 OAuth 用戶端核發的（"installed" 或
// "web"，見下面 resolveDriveCredentials）——refresh token 是綁定在核發它的那個
// 用戶端上的，之後換新 access token 一定要用同一組 client_id／client_secret，
// 用錯會被 Google 拒絕。沒有帶 source 時預設 "installed"，相容這次改動之前
// 就已經連結過（一律走 Desktop app／PKCE）的裝置。
export function setDriveRefreshToken(db, token, source = "installed") {
  setSetting(db, "google_refresh_token", token);
  setSetting(db, "google_auth_source", source);
}

export function driveEncryptionKey(db) {
  return getSetting(db, "sync_encryption_key");
}

export function setDriveEncryptionKey(db, key) {
  setSetting(db, "sync_encryption_key", key);
}

// client_id／client_secret 不寫死在原始碼裡，避免這份專案原始碼綁死某一個人的
// Google Cloud 專案——改成第一次需要時跟「當時還連得到的」Python 伺服器要一次，
// 之後存進本機資料庫快取，之後真的離線也能用（前提是使用者之前至少連過一次
// 伺服器，這在「連結 Google 帳號」這個動作本身就需要能連上網路，屬於合理的前提）。
//
// 這裡用的是 Google「Desktop app」類型的 OAuth 用戶端，不是桌面版備份用的
// 「Web application」類型——實測發現 Google 的 token 端點會拒絕「Web
// application」類型不帶 client_secret 的請求（回應："client_secret is
// missing."），但瀏覽器沒有安全的地方可以藏一組真正機密的密鑰。Google 官方
// 文件說「Desktop app」類型雖然也會核發一組 client_secret，但明白指出這組密鑰
// 「並非機密」（因為這類應用程式本來就設計成會安裝在使用者自己的裝置上），
// 可以安全內嵌在前端程式碼裡，所以離線引擎另外用一組這個類型的憑證。
async function resolveCredentialsFrom(db, endpoint, cacheKeyPrefix, notConfiguredMessage) {
  // 每次都先試著跟伺服器要最新設定——這樣使用者之後如果換了 Google Cloud 憑證，
  // 只要這台裝置還連得到伺服器就會自動用新的，不會被本機快取卡住；只有真的連不到
  // 伺服器（離線）時才退回用本機快取，讓已經連結過 Google 帳號的裝置離線時還能用
  // 快取的憑證換 access token。
  let reachable = false;
  try {
    const response = await fetch(endpoint, { cache: "no-store" });
    reachable = true;
    if (response.ok) {
      const body = await response.json();
      if (body.client_id) {
        setSetting(db, `${cacheKeyPrefix}_id`, body.client_id);
        setSetting(db, `${cacheKeyPrefix}_secret`, body.client_secret || "");
        return { clientId: body.client_id, clientSecret: body.client_secret || "" };
      }
    }
  } catch (_) {
    reachable = false;
  }
  // 伺服器連得到、但明確說「還沒設定」，這是真的還沒設定，不該假裝用舊快取蒙混過去；
  // 只有真的連不到伺服器（離線）時，才退回用這台裝置之前快取過的憑證。
  if (reachable) throw new SyncError(notConfiguredMessage);
  const cachedId = getSetting(db, `${cacheKeyPrefix}_id`);
  if (cachedId) return { clientId: cachedId, clientSecret: getSetting(db, `${cacheKeyPrefix}_secret`) || "" };
  throw new SyncError("目前連不到伺服器，且這台裝置還沒有快取過 Google 用戶端設定");
}

// 這裡用的是 Google「Desktop app」類型的 OAuth 用戶端，不是桌面版備份用的
// 「Web application」類型——實測發現 Google 的 token 端點會拒絕「Web
// application」類型不帶 client_secret 的請求（回應："client_secret is
// missing."），但瀏覽器沒有安全的地方可以藏一組真正機密的密鑰。Google 官方
// 文件說「Desktop app」類型雖然也會核發一組 client_secret，但明白指出這組密鑰
// 「並非機密」（因為這類應用程式本來就設計成會安裝在使用者自己的裝置上），
// 可以安全內嵌在前端程式碼裡，所以離線引擎在本機（127.0.0.1）連結時用這組。
export function resolveClientCredentials(db) {
  return resolveCredentialsFrom(db, "/offline/google-installed-client", "google_client", "伺服器尚未設定離線引擎用的 Google OAuth 用戶端（Desktop app 類型）");
}

// 手機透過 Tailscale HTTPS 連進來時，走的是伺服器代為完成授權那條路徑（見
// web.py 的 _offline_google_drive_connect），用的是桌面版備份原本那組「Web
// application」憑證，client_secret 留在伺服器，這裡拿到的只是拿去換新
// access token 用的——跟 PKCE 那條路一樣道理，都不是真正機密的資料在瀏覽器
// 裡流動，只是這組是「伺服器known」而非「瀏覽器自己算出來」的。
function resolveWebClientCredentials(db) {
  return resolveCredentialsFrom(db, "/offline/google-web-client", "google_web_client", "伺服器尚未設定 Google OAuth 用戶端（Web application 類型）");
}

// refresh token 是綁定在核發它的那個 OAuth 用戶端上的，所以要先看這台裝置的
// Google 連結是哪條路建立的（setDriveRefreshToken 存的 google_auth_source），
// 才能用對應的 client_id／client_secret 去換新的 access token，用錯一組
// Google 會直接拒絕。
export async function resolveDriveCredentials(db) {
  const source = getSetting(db, "google_auth_source") || "installed";
  return source === "web" ? resolveWebClientCredentials(db) : resolveClientCredentials(db);
}

async function driveAccessToken(db, credentials) {
  const refreshToken = driveRefreshToken(db);
  if (!refreshToken) throw new SyncError("尚未連結 Google 帳號");
  return refreshAccessToken(refreshToken, credentials.clientId, credentials.clientSecret);
}

export async function driveStatus(db, credentials) {
  const connected = !!driveRefreshToken(db);
  const localRevision = lastSeenRevision(db);
  if (!connected) return { connected, local_revision: localRevision, remote_revision: null };
  try {
    const accessToken = await driveAccessToken(db, credentials);
    const files = await driveListFiles(accessToken);
    const remoteRevision = files.reduce((max, entry) => Math.max(max, entry.revision), 0);
    return { connected, local_revision: localRevision, remote_revision: remoteRevision, file_count: files.length };
  } catch (error) {
    // 單純查狀態這件事，不該因為 Google 那邊的授權失效（例如使用者自己去 Google
    // 帳號設定裡把這個 App 的存取權限撤銷了）就整個報錯壞掉，讓使用者連「需要
    // 重新連結」這個畫面本身都看不到。真正的操作（同步）失敗時該噴的錯誤，
    // 還是留給 drivePush／drivePull／driveSyncNow 自己去丟。
    if (error instanceof DriveError) return { connected, local_revision: localRevision, remote_revision: null, token_invalid: true };
    throw error;
  }
}

// 對應桌面版 sync.py 的 push()：上傳前檢查 Drive 上目前最新版本編號有沒有超過
// 這台裝置上次看過的版本，避免直接覆蓋另一台裝置先同步過的更新內容。
export async function drivePush(poolUtil, db, dbName, credentials) {
  const encryptionKey = driveEncryptionKey(db);
  if (!encryptionKey) throw new SyncError("尚未設定同步加密金鑰");
  const accessToken = await driveAccessToken(db, credentials);
  const files = await driveListFiles(accessToken);
  const remoteRevision = files.reduce((max, entry) => Math.max(max, entry.revision), 0);
  const localLastSeen = lastSeenRevision(db);
  if (remoteRevision > localLastSeen) throw new SyncError("Google Drive 上有更新的同步版本，請先下載合併後再上傳");
  const nextRevision = remoteRevision + 1;
  const device = deviceId(db);
  const label = deviceName(db) || "未命名裝置";
  const snapshot = exportSnapshot(poolUtil, dbName);
  const encrypted = await encryptData(snapshot, encryptionKey);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
  const name = `${label}-${stamp}-第${nextRevision}版.pacb`;
  const uploaded = await driveUploadFile(accessToken, name, encrypted, { revision: String(nextRevision), device_id: device });
  setLastSeenRevision(db, nextRevision);
  return { status: "pushed", revision: nextRevision, file: uploaded.name || name };
}

// 對應桌面版 sync.py 的 pull()：下載版本編號最新的檔案、解密、合併，最後更新
// 這台裝置記得的版本編號。
export async function drivePull(poolUtil, db, dbName, credentials) {
  const encryptionKey = driveEncryptionKey(db);
  if (!encryptionKey) throw new SyncError("尚未設定同步加密金鑰");
  const accessToken = await driveAccessToken(db, credentials);
  const files = await driveListFiles(accessToken);
  if (!files.length) return { status: "empty", revision: lastSeenRevision(db) };
  const latest = files.reduce((best, entry) => (entry.revision > best.revision ? entry : best));
  const remoteRevision = latest.revision;
  const localLastSeen = lastSeenRevision(db);
  if (remoteRevision <= localLastSeen) return { status: "up_to_date", revision: localLastSeen };
  const raw = await driveDownloadFile(accessToken, latest.id);
  const decrypted = await decryptData(raw, encryptionKey);
  const result = await mergeRemoteSnapshot(poolUtil, db, decrypted);
  setLastSeenRevision(db, remoteRevision);
  return { status: "merged", revision: remoteRevision, ...result };
}

// 畫面上「立即同步」按鈕背後就是這個：先下載合併對方的更新，再把（可能已經合併
// 過的）目前狀態上傳回去，一次動作涵蓋雙向。也是每日自動同步（見下方
// shouldAutoSyncNow）實際執行的動作，兩者共用同一段邏輯，行為完全一致。
export async function driveSyncNow(poolUtil, db, dbName, credentials) {
  const pull = await drivePull(poolUtil, db, dbName, credentials);
  const push = await drivePush(poolUtil, db, dbName, credentials);
  markAutoSyncRanToday(db);
  return { pull, push };
}

// 「每天自動同步」在離線引擎裡只能做成「打開 App 時，如果現在已經過了設定時間、
// 而且今天還沒同步過，就自動同步一次」——PWA 沒辦法在使用者沒打開它的時候，
// 真的在背景被鬧鐘叫醒執行任何動作，這是瀏覽器的限制，不是這裡故意做得比較弱。
// 手動按「立即同步」也會一起更新「今天同步過了」的記錄，避免同一天再自動觸發一次。
function todayString() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function autoSyncSettings(db) {
  return {
    enabled: getSetting(db, "sync_auto_enabled") === "1",
    time: getSetting(db, "sync_auto_time") || "08:00",
  };
}

export function setAutoSyncSettings(db, enabled, time) {
  setSetting(db, "sync_auto_enabled", enabled ? "1" : "0");
  setSetting(db, "sync_auto_time", time);
}

function markAutoSyncRanToday(db) {
  setSetting(db, "sync_auto_last_date", todayString());
}

export function shouldAutoSyncNow(db) {
  const settings = autoSyncSettings(db);
  if (!settings.enabled) return false;
  if (!driveRefreshToken(db) || !driveEncryptionKey(db)) return false;
  if (getSetting(db, "sync_auto_last_date") === todayString()) return false;
  const [dueHour, dueMinute] = settings.time.split(":").map(Number);
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes() >= dueHour * 60 + dueMinute;
}

// 跟 sync.py 的 MERGE_TABLES 一致：股票、電子發票、對帳單匯入等次要功能表格
// Phase 1 暫不合併，見 PROJECT_SPEC.md 第 12.5 節。
const MERGE_TABLES = [
  "import_batches",
  "accounts",
  "category_major_groups",
  "category_shortcuts",
  "transactions",
  "entries",
  "transaction_exchange_rates",
  "recurring_transactions",
  "client_sync_receipts",
];

const REMOTE_SNAPSHOT_NAME = "/offline-sync-incoming.sqlite3";

export function deviceId(db) {
  const row = db.one("SELECT setting_value AS v FROM app_settings WHERE setting_key='sync_device_id'");
  if (row) return row.v;
  const value = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  db.run("INSERT INTO app_settings(setting_key, setting_value) VALUES ('sync_device_id', ?)", [value]);
  return value;
}

export function deviceName(db) {
  const row = db.one("SELECT setting_value AS v FROM app_settings WHERE setting_key='sync_device_name'");
  return row ? row.v : "";
}

export function setDeviceName(db, name) {
  const trimmed = String(name || "").trim();
  if (!trimmed || trimmed.length > 40) throw new SyncError("裝置名稱需為 1 到 40 個字元");
  db.run(
    "INSERT INTO app_settings(setting_key, setting_value) VALUES ('sync_device_name', ?) "
    + "ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value",
    [trimmed],
  );
}

export async function mergeRemoteSnapshot(poolUtil, db, bytes) {
  await poolUtil.reserveMinimumCapacity(2);
  poolUtil.importDb(REMOTE_SNAPSHOT_NAME, bytes);
  const remoteDb = new poolUtil.OpfsSAHPoolDb(REMOTE_SNAPSHOT_NAME);
  try {
    const integrity = remoteDb.selectValue("PRAGMA integrity_check");
    if (integrity !== "ok") throw new SyncError("選擇的同步檔案完整性檢查失敗，已放棄合併");
    const inserted = {};
    db.transaction(() => {
      for (const table of MERGE_TABLES) {
        const columns = db.all(`PRAGMA table_info(${table})`).map((row) => row.name);
        const columnList = columns.join(",");
        const before = db.one(`SELECT count(*) AS n FROM ${table}`).n;
        const remoteRows = [];
        remoteDb.exec({ sql: `SELECT ${columnList} FROM ${table}`, rowMode: "array", callback: (row) => remoteRows.push(row) });
        const placeholders = columns.map(() => "?").join(",");
        for (const row of remoteRows) {
          db.run(`INSERT OR IGNORE INTO ${table}(${columnList}) VALUES (${placeholders})`, row);
        }
        const after = db.one(`SELECT count(*) AS n FROM ${table}`).n;
        inserted[table] = after - before;
      }
    });
    const conflicts = await detectSyncConflicts(db);
    return { inserted, new_conflicts: conflicts.length };
  } finally {
    remoteDb.close();
    poolUtil.unlink(REMOTE_SNAPSHOT_NAME);
  }
}

export function exportSnapshot(poolUtil, dbName) {
  return poolUtil.exportFile(dbName);
}
