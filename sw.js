const CACHE_NAME = "accounting-shell-v145";
const SHELL_ASSETS = [
  "/",
  "/app.css?v=32",
  "/menu.css?v=20",
  "/app.js?v=95",
  "/offline.js?v=3",
  "/sync.js?v=4",
  "/offline/google-auth.js?v=1",
  "/offline/sync-ui.js?v=10",
  "/offline/onboarding.js?v=1",
  "/manifest.webmanifest",
  // 手機離線引擎（PROJECT_SPEC.md 第 13 節）：這些檔案沒有另外做版本查詢字串，
  // 內容一改就要記得把上面的 CACHE_NAME 數字加一，否則離線裝置會一直用到舊版。
  "/vendor/sqlite-wasm/index.mjs",
  "/vendor/sqlite-wasm/sqlite3.wasm",
  "/vendor/sqlite-wasm/sqlite3-opfs-async-proxy.js",
  "/offline/db-worker.js",
  "/offline/accounting.js",
  "/offline/categories.js",
  "/offline/recurring.js",
  "/offline/stock_holdings.js",
  "/offline/stock-names.json",
  "/offline/importer.js",
  "/offline/exporter.js",
  "/offline/cp950-table.json",
  "/offline/sync.js",
  "/offline/drive.js",
  "/offline/offline-backend.js",
  "/offline/schema.sql",
];

// 分頁有沒有在跑離線引擎，由 offline-backend.js 主動用 postMessage 告知（見該檔案
// announceOfflineEngineActive）。只有記錄「是」才會攔截 /api/export；桌面版分頁
// 從來不會送這個訊息，Map 裡沒有它的紀錄，行為完全不受影響。
const offlineClients = new Map();

self.addEventListener("message", (event) => {
  if (event.data?.type === "offline-engine-state" && event.source) {
    offlineClients.set(event.source.id, !!event.data.active);
  }
});

// 桌面版匯出用 location.href='/api/export' 整頁導向下載，不會經過 fetch()，
// window.fetch 攔截辦法在這裡完全攔不到（見 PROJECT_SPEC.md 13.6 最後一段）。
// 改在這裡攔截這個路徑本身：問頁面上唯一那個 db-worker 連線要 CSV bytes，
// 而不是讓 Service Worker 自己另開一個連線（會撞上 OPFS SAHPool 單一連線限制，
// 見 13.4 節）。
async function exportViaClient(event) {
  const client = await self.clients.get(event.clientId);
  if (!client) {
    return new Response(JSON.stringify({ error: "離線引擎匯出失敗：找不到頁面" }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (message) => {
      const { ok, bytes, error } = message.data || {};
      if (ok) {
        resolve(new Response(bytes, {
          status: 200,
          headers: {
            "Content-Type": "text/csv; charset=big5",
            "Content-Disposition": 'attachment; filename="accounting-export.csv"',
          },
        }));
      } else {
        resolve(new Response(JSON.stringify({ error: error || "離線引擎匯出失敗" }), {
          status: 500,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        }));
      }
    };
    client.postMessage({ type: "offline-export-request" }, [channel.port2]);
  });
}

self.addEventListener("install", (event) => {
  // Promise.allSettled 原本會把每個檔案快取失敗的原因整個吞掉（單一檔案失敗不影響其他
  // 檔案照常快取是刻意設計，但完全不留痕跡會讓「離線引擎為什麼連不上時整個打不開」
  // 這種問題完全無從查起）——這裡把每個結果都印出來，快取失敗至少會留在
  // Service Worker 自己的 console 裡（chrome://inspect 或 Safari 網頁檢閲器可以看到），
  // 而不是無聲無息地讓 SW 回報「安裝成功」卻漏掉關鍵檔案（例如 SQLite WASM 引擎本體）。
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.allSettled(
        SHELL_ASSETS.map((url) => cache.add(new Request(url, { cache: "reload" })))
      ))
      .then((results) => {
        results.forEach((result, index) => {
          if (result.status === "rejected") {
            console.warn("[sw] 快取失敗：", SHELL_ASSETS[index], result.reason);
          }
        });
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith("accounting-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname === "/api/export" && offlineClients.get(event.clientId)) {
    event.respondWith(exportViaClient(event));
    return;
  }

  if (
    url.pathname.startsWith("/api/")
    || url.pathname.startsWith("/oauth/")
    || url.pathname === "/logout"
  ) return;

  if (request.mode === "navigate") {
    // 原本是「先試網路，失敗才退回快取」——手機透過 Tailscale 連到「電腦有開機、
    // 但 start-local.cmd 沒在跑」時，連線不會馬上被拒絕，會安靜卡著等逾時，體感
    // 像當機。改成「快取優先，背景偷偷再更新快取」：只要之前開過一次、已經有快取，
    // 這次一律馬上用快取回應，完全不用等網路、也不用猜逾時要設幾秒——這樣不只是
    //「電腦沒開時」比較快進離線模式，而是每次開啟都一樣快，等於「預設就是離線模式，
    // 背景偷偷確認有沒有新版本」。真正的帳務資料本來就是走 /api/... 即時抓（這條路徑
    // 一開始就被上面的判斷排除、不會被這裡攔截），這裡快取的只是外殼 HTML，新舊差異
    // 頂多是「畫面骨架有沒有換版」，不影響帳務資料本身的即時性。只有從來沒開過、
    // 完全沒有快取的第一次造訪，才會真的等網路回應。
    event.respondWith(
      (async () => {
        const cached = await caches.match("/");
        const networkUpdate = fetch(request)
          .then((response) => {
            if (response.ok) {
              caches.open(CACHE_NAME).then((cache) => cache.put("/", response.clone()));
            }
            return response;
          })
          .catch(() => null);
        if (cached) return cached;
        return (await networkUpdate) || Response.error();
      })()
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
