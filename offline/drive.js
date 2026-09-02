// 手機離線引擎的 Google Drive 存取層，對應桌面版 cloud_backup.py。跟桌面版最大的
//不同：離線引擎沒有伺服器可以保管 client_secret，所以整段都走 PKCE
// （RFC 7636）——授權碼交換 access token 時完全不帶 client_secret，改用只有這次
// 授權自己知道的 code_verifier 證明「我就是發起授權的那個瀏覽器」。這是 Google
// 官方給「純前端應用程式」推薦的做法，見 PROJECT_SPEC.md 13.10 第 1 項。
//
// 這支檔案只負責「跟 Google 對話」（授權碼交換、換新 access token、Drive 檔案
// 上傳/下載/列表）與「加解密」，完全不碰 SQLite；真正的推播/下載後合併邏輯在
// sync.js 的 push/pull，兩者合起來才對應桌面版 sync.py + cloud_backup.py 的組合。
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,createdTime,appProperties";
const LIST_URL = "https://www.googleapis.com/drive/v3/files";
const DOWNLOAD_URL = (fileId) => `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
export const SCOPE = "https://www.googleapis.com/auth/drive.file";
// 跟桌面版 sync.py 的 SYNC_FOLDER 用同一個標籤（appProperties，不是真正的 Drive
// 資料夾），這樣桌面版跟手機離線版以後可以透過同一批 Drive 檔案互相合併，
// 不需要另外接一套轉換。
export const SYNC_FOLDER = "PersonalAccounting-Sync";
const MAGIC = new TextEncoder().encode("PACB1"); // 跟 cloud_backup.py 的 MAGIC 常數一致
const PBKDF2_ITERATIONS = 600_000;

export class DriveError extends Error {}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function generateCodeVerifier() {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

export async function codeChallengeFromVerifier(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

export function authorizationUrl({ clientId, redirectUri, codeChallenge, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });
  return AUTH_URL + "?" + params.toString();
}

async function postForm(url, values) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values).toString(),
  });
  const body = await response.json();
  if (!response.ok) throw new DriveError(body.error_description || body.error || "Google 授權失敗");
  return body;
}

export async function exchangeCode({ code, codeVerifier, clientId, clientSecret, redirectUri }) {
  const values = { code, client_id: clientId, redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: codeVerifier };
  // 「Desktop app」類型的 OAuth 用戶端 Google 還是會核發一組 client_secret，且交換
  // token 時仍要帶著送出——但 Google 自己的文件明白說這組密鑰「並非機密」，因為
  // 這類用戶端本來就設計成會被安裝在使用者自己裝置上、原始碼可能公開。實測發現
  // 桌面版原本那組「Web application」類型的憑證，Google 會拒絕不帶 client_secret
  // 的請求（回應是 "client_secret is missing."），所以純瀏覽器版改用另一組
  // Desktop app 類型的憑證，見 PROJECT_SPEC.md 13.10 第 1 項。
  if (clientSecret) values.client_secret = clientSecret;
  return postForm(TOKEN_URL, values);
}

export async function refreshAccessToken(refreshToken, clientId, clientSecret) {
  const values = { refresh_token: refreshToken, client_id: clientId, grant_type: "refresh_token" };
  if (clientSecret) values.client_secret = clientSecret;
  const result = await postForm(TOKEN_URL, values);
  return String(result.access_token);
}

export async function driveListFiles(accessToken, folderName = SYNC_FOLDER) {
  const query = `appProperties has { key='backup' and value='personal-accounting' } and appProperties has { key='folder' and value='${folderName}' } and trashed=false`;
  const params = new URLSearchParams({
    q: query,
    fields: "files(id,name,createdTime,appProperties)",
    orderBy: "createdTime desc",
    pageSize: "50",
  });
  const response = await fetch(LIST_URL + "?" + params.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new DriveError("Google Drive 檔案列表讀取失敗");
  const body = await response.json();
  const files = body.files || [];
  for (const entry of files) entry.revision = parseInt((entry.appProperties || {}).revision || "0", 10);
  return files;
}

// 找到（或第一次呼叫時建立）一個真正的 Drive 資料夾給備份/同步檔案用。早期版本
// 只把 folderName 寫進 appProperties 當內部標籤，從來沒有真的建立資料夾——
// 程式自己找檔案沒問題，但使用者自己打開 Google Drive 網頁完全看不到、找不到
// 這些檔案收在哪裡。之後上傳都會把檔案放進這個真正、看得到的資料夾。
export async function driveFindOrCreateFolder(accessToken, folderName) {
  const query = `mimeType='${FOLDER_MIME_TYPE}' and name='${folderName}' and trashed=false and appProperties has { key='backup' and value='personal-accounting' }`;
  const params = new URLSearchParams({ q: query, fields: "files(id,name)", pageSize: "1" });
  const response = await fetch(LIST_URL + "?" + params.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new DriveError("Google Drive 資料夾查詢失敗");
  const body = await response.json();
  const existing = body.files || [];
  if (existing.length) return existing[0].id;
  const createResponse = await fetch(LIST_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ name: folderName, mimeType: FOLDER_MIME_TYPE, appProperties: { backup: "personal-accounting" } }),
  });
  if (!createResponse.ok) throw new DriveError("Google Drive 資料夾建立失敗");
  const created = await createResponse.json();
  return created.id;
}

export async function driveUploadFile(accessToken, filename, bytes, extraProperties = {}, folderName = SYNC_FOLDER) {
  const folderId = await driveFindOrCreateFolder(accessToken, folderName);
  const boundary = "accounting-" + crypto.randomUUID().replace(/-/g, "");
  const properties = { backup: "personal-accounting", folder: folderName, ...extraProperties };
  const metadata = JSON.stringify({ name: filename, appProperties: properties, parents: [folderId] });
  const parts = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
    bytes,
    `\r\n--${boundary}--\r\n`,
  ];
  const body = new Blob(parts);
  const response = await fetch(UPLOAD_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!response.ok) throw new DriveError("Google Drive 上傳失敗");
  return response.json();
}

export async function driveDownloadFile(accessToken, fileId) {
  const response = await fetch(DOWNLOAD_URL(fileId), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new DriveError("Google Drive 下載失敗");
  return new Uint8Array(await response.arrayBuffer());
}

// 跟 cloud_backup.py 的 encrypt_data／decrypt_data 位元組完全對應：
// MAGIC(5) + salt(16) + nonce(12) + AES-256-GCM(密文+16 bytes tag)，
// 金鑰由 PBKDF2-HMAC-SHA256（600,000 次疊代）從使用者的加密金鑰字串算出。
// 兩邊都用同一把使用者自訂的金鑰，才能互相解開對方上傳的同步/備份檔。
async function deriveKey(passphrase, salt) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, material, 256);
  return crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptData(bytes, passphrase) {
  if (passphrase.length < 12) throw new DriveError("Google Drive 備份加密金鑰至少需要 12 個字元");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: MAGIC }, key, bytes));
  const out = new Uint8Array(MAGIC.length + salt.length + nonce.length + ciphertext.length);
  out.set(MAGIC, 0);
  out.set(salt, MAGIC.length);
  out.set(nonce, MAGIC.length + salt.length);
  out.set(ciphertext, MAGIC.length + salt.length + nonce.length);
  return out;
}

export async function decryptData(payload, passphrase) {
  const magic = payload.slice(0, MAGIC.length);
  if (magic.length !== MAGIC.length || !magic.every((byte, index) => byte === MAGIC[index]) || payload.length < 34) {
    throw new DriveError("不是有效的帳本加密備份");
  }
  const salt = payload.slice(5, 21);
  const nonce = payload.slice(21, 33);
  const ciphertext = payload.slice(33);
  const key = await deriveKey(passphrase, salt);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: MAGIC }, key, ciphertext));
  } catch (error) {
    throw new DriveError("解密失敗，請確認加密金鑰是否正確");
  }
}
