// 手機離線引擎的「假後端」：把 app.js／sync.js 原本打給 Python 伺服器的
// fetch('/api/...') 攔截下來，改成透過 postMessage 問瀏覽器裡的 SQLite Worker。
// app.js／sync.js 完全不用改——它們只在乎 fetch() 回傳一個 Response，不在乎背後是誰在回應。
//
// 只有在啟用離線引擎時才生效（見 index.html 條件式載入這支檔案的判斷），
// 桌面版平常還是走真正的 Python 後端，不受影響。見 PROJECT_SPEC.md 13.3 第 2 項。
(function () {
  const worker = new Worker("/offline/db-worker.js", { type: "module" });
  // 手機第一次載入時最慢的一段，不是網路，是 db-worker.js 裡的 getState()——
  // 要載入 SQLite WASM 引擎、設定 OPFS 儲存池、跑一次 schema.sql，這些都是真正的
  // CPU/瀏覽器工作，不是快取能省掉的。原本要等 app.js 的 initialize() 第一次呼叫
  // fetch('/api/accounts') 才會觸發（getState() 在 db-worker.js 收到任何訊息時都會
  // 執行，見該檔案的 message 監聽器最前面幾行），這裡改成 worker 一建立就先送一個
  // 用不到回應的「暖機」訊息，讓這段初始化提早跟頁面其餘部分（app.js 下載/解析等）
  // 同時進行，而不是排在它們後面才開始——真正呼叫 API 時很可能已經初始化完成或
  // 接近完成，感覺上的等待時間會縮短。這個訊息的 id 沒有加進下面的 pending
  // Map，回應會直接被下面共用的 message 監聽器忽略（跟 __offlineDebugExec／
  // __offlineResetDevice 用不同 id 前綴避開衝突是同一個做法）。
  worker.postMessage({ id: "warmup", type: "ready" });
  let nextId = 0;
  const pending = new Map();
  worker.addEventListener("message", (event) => {
    const { id, ok, response, error } = event.data || {};
    const resolver = pending.get(id);
    if (!resolver) return;
    pending.delete(id);
    if (ok) resolver.resolve(response);
    else resolver.reject(new Error(error));
  });

  // 除錯用：讓 console／測試腳本能直接對「這一頁真正在用的那個 worker」下原始 SQL，
  // 而不是另外開一個新的 worker（另開會跟這個搶 OPFS SAHPool 鎖，見 PROJECT_SPEC.md 13.4）。
  // 故意不共用上面那個 pending／response 機制——exec 型別訊息回傳的是 rows 不是 response。
  window.__offlineDebugExec = (sql, bind) => new Promise((resolve, reject) => {
    const id = "debug-" + Math.random().toString(36).slice(2);
    const handler = (event) => {
      if (event.data?.id !== id) return;
      worker.removeEventListener("message", handler);
      if (event.data.ok) resolve(event.data.rows);
      else reject(new Error(event.data.error));
    };
    worker.addEventListener("message", handler);
    worker.postMessage({ id, type: "exec", sql, bind });
  });

  // 「清除本機資料重新開始」用：整個清掉這台裝置本機的帳本，見 sync-ui.js 的
  // reset 按鈕與 db-worker.js 的 "reset" 訊息型別註解。
  window.__offlineResetDevice = () => new Promise((resolve, reject) => {
    const id = "reset-" + Math.random().toString(36).slice(2);
    const handler = (event) => {
      if (event.data?.id !== id) return;
      worker.removeEventListener("message", handler);
      if (event.data.ok) resolve();
      else reject(new Error(event.data.error));
    };
    worker.addEventListener("message", handler);
    worker.postMessage({ id, type: "reset" });
  });

  function callApi(method, path, query, body, headers) {
    announceOfflineEngineActive();
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, type: "api", request: { method, path, query, body, headers } });
    });
  }

  function requestExportBytes() {
    return new Promise((resolve, reject) => {
      const id = "export-" + Math.random().toString(36).slice(2);
      const handler = (event) => {
        if (event.data?.id !== id) return;
        worker.removeEventListener("message", handler);
        if (event.data.ok) resolve(event.data.bytes);
        else reject(new Error(event.data.error));
      };
      worker.addEventListener("message", handler);
      worker.postMessage({ id, type: "export" });
    });
  }
  // 除錯用，比照上面的 __offlineDebugExec：讓 console 能直接拿到匯出的 CSV bytes，
  // 不用真的透過 Service Worker／location.href 觸發一次瀏覽器下載才能檢查內容。
  window.__offlineDebugExport = requestExportBytes;

  // 告訴 Service Worker「這一頁正在跑離線引擎」，讓 sw.js 攔截 location.href='/api/export'
  // 這種不會經過 fetch() 的整頁下載請求時，知道要問這一頁要 CSV，而不是直接連真正的
  // Python 伺服器（桌面版沒有載入這支檔案，永遠不會送這個訊息，行為不受影響）。
  // Service Worker 閒置一段時間會被瀏覽器整個終止、下次事件才重新啟動一份全新的
  // JS 執行環境，之前記住的「這個分頁是離線引擎」會被忘記——所以除了剛啟動時講一次，
  // 之後每次呼叫 API 也會再講一次（見上面 callApi），順便保持這個狀態不會過期。
  function announceOfflineEngineActive() {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: "offline-engine-state", active: true });
    }
  }
  announceOfflineEngineActive();
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener("controllerchange", announceOfflineEngineActive);
    navigator.serviceWorker.addEventListener("message", async (event) => {
      if (event.data?.type !== "offline-export-request") return;
      const port = event.ports[0];
      try {
        const bytes = await requestExportBytes();
        port.postMessage({ ok: true, bytes }, [bytes.buffer]);
      } catch (error) {
        port.postMessage({ ok: false, error: error.message });
      }
    });
  }

  // 股利查詢（/api/stock-dividend-lookup）本質上是去抓 cmoney.tw 這個外部網站，
  // 瀏覽器裡的 SQLite 完全沒有能力做到這件事——瀏覽器直接連 cmoney.tw 本身也不行
  // （實測過對方沒有回傳允許跨來源讀取的 CORS 標頭，瀏覽器會直接擋下來，不是
  // 程式碼寫法能解決的）。這個路徑刻意不攔截、放行給真正的網路請求：這一頁的
  // 網址（例如透過 Tailscale 連到桌面版）如果背後真的有 Python 伺服器在跑，
  // 用 curl 幫忙查就能正常運作；桌面版沒開著、連不到的話，這裡就會像真的斷線
  // 一樣直接查詢失敗，跟桌面版本身沒網路時的行為一致，不是新的錯誤模式。
  const PASSTHROUGH_API_PATHS = new Set(["/api/stock-dividend-lookup"]);

  const originalFetch = window.fetch.bind(window);
  window.fetch = async function offlineFetch(input, init) {
    const request = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const url = new URL(request, location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/") || PASSTHROUGH_API_PATHS.has(url.pathname)) {
      return originalFetch(input, init);
    }
    const method = (init && init.method) || "GET";
    const query = Object.fromEntries(url.searchParams.entries());
    // CSV 匯入等少數路徑不是傳 JSON，而是直接把整個檔案（File/Blob）當 body 傳過來
    // （比照 app.js 既有寫法：fetch('/api/import',{headers:{'X-Filename':...},body:file})）。
    // File/Blob 可以直接透過 postMessage 結構化複製傳給 worker，不需要另外轉檔。
    let body;
    if (init && init.body) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const headers = {};
    if (init && init.headers) {
      const entries = init.headers instanceof Headers ? [...init.headers.entries()] : Object.entries(init.headers);
      for (const [key, value] of entries) headers[key.toLowerCase()] = value;
    }
    try {
      const result = await callApi(method, url.pathname, query, body, headers);
      // 匯出資料庫快照等二進位回應：body 已經是 Uint8Array，不能塞進 JSON.stringify。
      if (result.binary) {
        const responseHeaders = { "Content-Type": result.contentType || "application/octet-stream" };
        if (result.filename) responseHeaders["Content-Disposition"] = `attachment; filename="${result.filename}"`;
        return new Response(result.body, { status: result.status, headers: responseHeaders });
      }
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: "離線引擎發生錯誤：" + error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
  };

  console.info("[離線引擎] 已啟用，/api/* 全部改由瀏覽器內建的 SQLite 處理，不會連到任何伺服器。");
})();
