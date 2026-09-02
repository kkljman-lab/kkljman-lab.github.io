// 手機離線引擎的 Google 授權入口，只負責「跳去 Google、跳回來、把換到的長期授權
// 交給 db-worker 存進本機資料庫」這段一定要在頁面（不是 Worker）裡做的事——
// 因為只有頁面能整頁導向 Google 的授權頁面、也只有頁面能在跳回來時讀到網址上的
// 參數。真正的 Drive 存取都在 db-worker.js／sync.js／drive.js。
//
// 只在離線引擎啟用時生效；桌面版走完全不同的 /oauth/google/callback 伺服器端流程
// （web.py），這支檔案對桌面版不會有任何作用。
//
// 這裡其實有兩條不同的連結方式，依目前網址是不是 127.0.0.1 自動切換：
// 1. 在電腦本機（127.0.0.1）：純瀏覽器端 PKCE，用「Desktop app」類型的 OAuth
//    用戶端，交換 token 完全不需要伺服器保管密鑰——已經用真實 Google 帳號驗證過
//    可以動，見 PROJECT_SPEC.md 13.12。
// 2. 手機透過 Tailscale HTTPS 網域連進來時：PKCE 那組「Desktop app」憑證只登記了
//    `http://localhost` 這個回呼網址，換成別的網域 Google 會拒絕；改成請伺服器
//    （這時候伺服器一定連得到，因為手機本來就是連到伺服器才看得到這個頁面）
//    代為完成整段交換——伺服器用桌面版備份原本就有的「Web application」憑證
//    （client_secret 留在伺服器，瀏覽器拿不到），換到 refresh token 後不直接
//    存進伺服器自己的資料庫，而是用一個一次性代碼交給這支頁面領取，領到後才
//    存進手機本機的離線資料庫，讓「這台裝置自己的 Google 連結」這件事的邏輯
//    跟本機版仍然一致。見 web.py 的 _offline_google_drive_connect／
//    _offline_google_drive_callback／_offline_google_claim，PROJECT_SPEC.md 13.13。
import { authorizationUrl, codeChallengeFromVerifier, generateCodeVerifier } from "/offline/drive.js";

const PENDING_KEY = "accounting-google-pkce-pending";
const usesServerProxiedFlow = () => location.hostname !== "127.0.0.1";

window.beginGoogleAuth = async function beginGoogleAuth() {
  if (usesServerProxiedFlow()) {
    location.href = "/oauth/offline-google/connect";
    return;
  }
  const clientResponse = await fetch("/api/offline-sync/google-client-id").then((response) => response.json());
  if (!clientResponse.client_id) throw new Error("尚未取得 Google 用戶端設定");
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await codeChallengeFromVerifier(codeVerifier);
  const state = generateCodeVerifier();
  const redirectUri = location.origin + "/";
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({ codeVerifier, state, redirectUri }));
  location.href = authorizationUrl({ clientId: clientResponse.client_id, redirectUri, codeChallenge, state });
};

function reportResult(ok, error) {
  window.dispatchEvent(new CustomEvent("google-auth-result", { detail: { ok, error } }));
}

async function storeRefreshToken(refreshToken) {
  const response = await fetch("/api/offline-sync/drive-store-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "連結失敗");
}

async function handleServerProxiedClaimIfPresent() {
  const params = new URLSearchParams(location.search);
  const claimCode = params.get("google_claim");
  const claimError = params.get("google_claim_error");
  if (!claimCode && !claimError) return false;
  history.replaceState(null, "", location.pathname);
  if (claimError) {
    reportResult(false, decodeURIComponent(claimError));
    return true;
  }
  try {
    const response = await fetch("/offline/google-claim?code=" + encodeURIComponent(claimCode), { cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "領取失敗，請重新連結");
    await storeRefreshToken(result.refresh_token);
    reportResult(true);
  } catch (err) {
    reportResult(false, err.message);
  }
  return true;
}

async function handlePkceRedirectIfPresent() {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  const state = params.get("state");
  const error = params.get("error");
  if (!code && !error) return;
  // 授權碼跟 state 只用這一次，處理完立刻從網址列拿掉，不留在瀏覽紀錄裡。
  history.replaceState(null, "", location.pathname);
  if (error) {
    reportResult(false, "已取消或拒絕 Google 授權。");
    return;
  }
  const savedRaw = sessionStorage.getItem(PENDING_KEY);
  sessionStorage.removeItem(PENDING_KEY);
  if (!savedRaw) {
    reportResult(false, "授權驗證失敗，請重新連結。");
    return;
  }
  const saved = JSON.parse(savedRaw);
  if (saved.state !== state) {
    reportResult(false, "授權驗證失敗，請重新連結。");
    return;
  }
  try {
    const response = await fetch("/api/offline-sync/drive-connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, code_verifier: saved.codeVerifier, redirect_uri: saved.redirectUri }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "連結失敗");
    reportResult(true);
  } catch (err) {
    reportResult(false, err.message);
  }
}

if (localStorage.getItem("accounting-offline-engine") === "1") {
  // 用巨集任務（setTimeout）延後執行，不能只用微任務（await/Promise.then）：
  // 這支檔案是 <script type="module">，跟 sync-ui.js 這個 <script defer> 之間
  // 沒有真正的先後保證讓 sync-ui.js 一定「先」掛好 google-auth-result 監聽器；
  // 就算用 await 排到微任務佇列，瀏覽器仍然會在執行下一個 <script> 之前把目前
  // 積壓的微任務清空，等於還是可能搶在 sync-ui.js 掛上監聽器之前就把事件送出去、
  // 沒有任何監聽器接到，訊息就這樣消失了（尤其是 google_claim_error 這種完全
  // 不需要 await 就會觸發的同步路徑，最容易撞上）。setTimeout 排到巨集任務，
  // 保證晚於這一輪所有 <script> 執行完（含 sync-ui.js 掛好監聽器）才觸發。
  setTimeout(() => {
    handleServerProxiedClaimIfPresent().then((handled) => {
      if (!handled) handlePkceRedirectIfPresent();
    });
  }, 0);
}
