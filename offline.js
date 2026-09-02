(() => {
  "use strict";

  const nativeFetch = window.fetch.bind(window);
  const databaseName = "personal-accounting-offline-v1";
  const cacheablePaths = [
    "/api/summary", "/api/transactions", "/api/reports/monthly",
    "/api/account-balances", "/api/accounts", "/api/categories"
  ];
  let flushing = false;

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("queue")) db.createObjectStore("queue", { keyPath: "id" });
        if (!db.objectStoreNames.contains("cache")) db.createObjectStore("cache", { keyPath: "url" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function storePut(storeName, value) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }

  async function storeGet(storeName, key) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const request = tx.objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => db.close();
    });
  }

  async function queueItems() {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("queue", "readonly");
      const request = tx.objectStore("queue").getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => db.close();
    });
  }

  async function queueDelete(id) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("queue", "readwrite");
      tx.objectStore("queue").delete(id);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }

  function requestId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return `offline-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function pathOf(input) {
    try {
      const raw = typeof input === "string" ? input : input.url;
      return new URL(raw, location.href).pathname;
    } catch (_) {
      return "";
    }
  }

  async function updateStatus(_message, _state) {
    // 這個徽章已經拿掉了：它只反映瀏覽器連線與本機待送出佇列，跟畫面上
    // 真正的「Google Drive 同步」徽章（sync.js／sync-ui.js）名稱太像、容易
    // 混淆，且在正常連線下幾乎永遠顯示「已同步」，實際參考價值很低。
    // 底下的離線佇列（存 IndexedDB、連線恢復後自動補送）邏輯本身照常運作，
    // 只是不再把狀態文字寫回畫面。
  }

  async function refreshStatus() {
    const count = (await queueItems()).length;
    if (!navigator.onLine) return updateStatus(count ? `離線・待同步 ${count}` : "離線", "offline");
    if (count) return updateStatus(`待同步 ${count}`, "pending");
    return updateStatus("已同步", "synced");
  }

  async function cacheResponse(url, response) {
    if (!response.ok) return;
    const clone = response.clone();
    await storePut("cache", {
      url,
      body: await clone.text(),
      status: clone.status,
      contentType: clone.headers.get("Content-Type") || "application/json",
      savedAt: Date.now()
    });
  }

  async function cachedResponse(url) {
    const cached = await storeGet("cache", url);
    if (!cached) return null;
    return new Response(cached.body, {
      status: cached.status,
      headers: { "Content-Type": cached.contentType, "X-Offline-Cache": "1" }
    });
  }

  async function flushQueue() {
    if (flushing || !navigator.onLine) return refreshStatus();
    flushing = true;
    try {
      const items = await queueItems();
      for (const item of items) {
        let response;
        try {
          response = await nativeFetch("/api/transactions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(item.payload)
          });
        } catch (_) {
          break;
        }
        if (response.ok) {
          await queueDelete(item.id);
        } else if (response.status >= 400 && response.status < 500) {
          await updateStatus("同步資料需檢查", "error");
          return;
        } else {
          break;
        }
      }
      await refreshStatus();
      window.dispatchEvent(new CustomEvent("accounting-offline-synced"));
    } finally {
      flushing = false;
    }
  }

  window.fetch = async function offlineAwareFetch(input, init = {}) {
    const path = pathOf(input);
    const method = String(init.method || (input && input.method) || "GET").toUpperCase();
    if (method === "POST" && path === "/api/transactions" && typeof init.body === "string") {
      let payload;
      try { payload = JSON.parse(init.body); } catch (_) { return nativeFetch(input, init); }
      payload.client_request_id = payload.client_request_id || requestId();
      const adjusted = { ...init, body: JSON.stringify(payload) };
      try {
        return await nativeFetch(input, adjusted);
      } catch (_) {
        await storePut("queue", { id: payload.client_request_id, payload, createdAt: new Date().toISOString() });
        await refreshStatus();
        return new Response(JSON.stringify({ id: payload.client_request_id, queued: true }), {
          status: 202,
          headers: { "Content-Type": "application/json", "X-Offline-Queued": "1" }
        });
      }
    }

    const cacheable = method === "GET" && cacheablePaths.some(prefix => path.startsWith(prefix));
    if (!cacheable) return nativeFetch(input, init);
    const cacheKey = typeof input === "string" ? new URL(input, location.href).href : input.url;
    try {
      const response = await nativeFetch(input, init);
      cacheResponse(cacheKey, response).catch(() => {});
      return response;
    } catch (error) {
      const cached = await cachedResponse(cacheKey);
      if (cached) return cached;
      throw error;
    }
  };

  window.addEventListener("online", flushQueue);
  window.addEventListener("offline", refreshStatus);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") flushQueue();
  });
  document.addEventListener("DOMContentLoaded", () => {
    refreshStatus().catch(() => {});
    flushQueue().catch(() => {});
  });
  setInterval(() => flushQueue().catch(() => {}), 15 * 60 * 1000);
})();
