// 手機離線引擎的「帳務備份」畫面：只留一個 Google Drive 同步區塊（連結帳號、
// 加密金鑰、每日自動同步時間、立即同步按鈕、待處理的合併衝突）跟一個清除本機
// 資料的按鈕，其餘桌面版沿用下來但離線引擎裡用不到的東西（舊版
// Google 帳號登入／排程備份、桌面版自己的跨裝置同步 UI）都在離線模式下隱藏。
// 只在離線引擎啟用時生效（見 index.html 條件載入的判斷），桌面版不受影響。
//
// 依賴 google-auth.js 掛在 window 上的 beginGoogleAuth() 與 google-auth-result
// 事件，以及 app.js／sync.js 已經建立好的 #cloud-settings-dialog、$、escapeHtml、
// money、showToast、loadSummary/loadTransactions/loadReport/loadBalances 全域
// 小工具，必須在它們之後載入（見 index.html 的 <script> 順序）。
(function () {
  if (localStorage.getItem("accounting-offline-engine") !== "1") return;

  // 桌面版的「Google 帳號登入」說明、舊版排程備份設定、
  // 以及桌面版自己那套跨裝置同步 UI（sync.js 的 setupDriveSync，走的是
  // /api/sync/*，離線引擎裡完全打不通）——這些在離線引擎裡全部隱藏，
  // 用同一個 display:none 手法，不刪除底層程式碼，之後想恢復都還在。
  function hideUnusedDesktopSections() {
    document.querySelector("#cloud-settings-form > .notice")?.style.setProperty("display", "none");
    document.getElementById("google-drive-status")?.closest("section")?.style.setProperty("display", "none");
    document.getElementById("drive-sync-section")?.style.setProperty("display", "none");
    // 原本表單最下面那顆「儲存設定」，是給上面已經隱藏的舊版排程備份用的，
    // 上面的欄位都不見了，這顆按鈕留著只會讓人不知道在存什麼，一併隱藏。
    document.querySelector('#cloud-settings-form > button[type="submit"]')?.style.setProperty("display", "none");
    // setupGoogleDriveSync() 底下新增的裝置名稱／加密金鑰／自動同步時間這些
    // 輸入框，是直接插進 #cloud-settings-form 這個表單裡面的（沿用同一個表單
    // 容器，方便版面）——但這個表單原本綁的 submit 監聽器（app.js 的
    // upgradeCloudScheduleSettings()）是桌面版舊版排程備份專用，會送到離線
    // 引擎沒有實作的 /api/cloud-settings，在這幾個新輸入框按 Enter 鍵（瀏覽器
    // 對表單裡的輸入框預設行為）就會誤觸發，跳出「尚未支援這個路徑」的錯誤。
    // 用 capture 階段攔截、擋掉整個表單的 submit，早於 app.js 自己掛的（非
    // capture）監聽器執行，離線引擎底下這個表單本來就沒有東西需要「送出」。
    document.getElementById("cloud-settings-form")?.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      true,
    );
  }

  function setupGoogleDriveSync() {
    const anchor = document.getElementById("cloud-settings-form");
    if (!anchor) return;

    const section = document.createElement("section");
    section.id = "offline-drive-sync-section";
    section.style.marginTop = "18px";
    section.innerHTML = `
      <h3>Google Drive 同步</h3>
      <p class="muted">連結你的 Google 帳號後，這台裝置可以直接把帳本推送/下載到你自己的 Google Drive。</p>
      <div id="offline-device-name-row" style="margin-bottom:10px">
        <label>這台裝置的名稱（會出現在 Google Drive 的備份檔名裡，例如「電腦」「手機」「iPad」）
          <input id="offline-device-name" maxlength="40" placeholder="例如：手機">
        </label>
        <button type="button" id="offline-device-name-save" class="secondary">儲存名稱</button>
      </div>
      <p id="offline-drive-status" class="muted">載入中…</p>
      <div class="utility-actions">
        <button type="button" id="offline-drive-connect" class="secondary">連結 Google 帳號</button>
        <button type="button" id="offline-drive-sync-now" disabled>立即同步</button>
      </div>
      <div id="offline-drive-key-row" style="margin-top:10px;display:none">
        <label>同步加密金鑰（至少 12 個字元，必須跟桌面版用的金鑰完全一樣，同步才會成功；金鑰存在電腦的 data\backup-encryption.key 檔案裡，用記事本打開複製貼上即可）
          <input id="offline-drive-key" type="password" autocomplete="off" placeholder="請輸入或貼上加密金鑰">
        </label>
        <button type="button" id="offline-drive-key-save" class="secondary">儲存金鑰</button>
      </div>
      <div id="offline-drive-auto-row" style="margin-top:10px;display:none">
        <label class="schedule-choice" style="grid-template-columns:auto 1fr;align-items:center;margin:0">
          <input type="checkbox" id="offline-drive-auto-enabled" style="width:22px;height:22px"> 每天自動同步
        </label>
        <label>時間（打開 App 時如果已經過了這個時間、今天還沒同步過，就會自動同步一次）
          <input type="time" id="offline-drive-auto-time" value="08:00">
        </label>
        <button type="button" id="offline-drive-auto-save" class="secondary">儲存設定</button>
      </div>
      <p id="offline-drive-message" class="muted"></p>
      <div id="offline-drive-conflicts"></div>
    `;
    anchor.append(section);

    const statusEl = document.getElementById("offline-drive-status");
    const messageEl = document.getElementById("offline-drive-message");
    const conflictsEl = document.getElementById("offline-drive-conflicts");
    const connectButton = document.getElementById("offline-drive-connect");
    const syncNowButton = document.getElementById("offline-drive-sync-now");
    const keyRow = document.getElementById("offline-drive-key-row");
    const keyInput = document.getElementById("offline-drive-key");
    const keySaveButton = document.getElementById("offline-drive-key-save");
    const autoRow = document.getElementById("offline-drive-auto-row");
    const autoEnabled = document.getElementById("offline-drive-auto-enabled");
    const autoTime = document.getElementById("offline-drive-auto-time");
    const autoSaveButton = document.getElementById("offline-drive-auto-save");
    const nameInput = document.getElementById("offline-device-name");
    const nameSaveButton = document.getElementById("offline-device-name-save");

    const formatCandidate = (detail) => {
      if (!detail) return '<span class="muted">（找不到這筆交易的內容）</span>';
      const lines = detail.entries
        .map((entry) => {
          const amount = entry.debit_minor || entry.credit_minor;
          const side = entry.debit_minor ? "借" : "貸";
          return `${escapeHtml(entry.account_name)}（${side} ${money.format(amount)}）`;
        })
        .join("、");
      return `<strong>${escapeHtml(detail.transaction_date)}</strong> ${escapeHtml(detail.memo || "(無摘要)")}<br><span class="muted">${lines}</span>`;
    };

    const renderConflicts = (conflicts) => {
      if (!conflicts.length) {
        conflictsEl.innerHTML = "";
        return;
      }
      const cards = conflicts
        .map((conflict) => {
          if (conflict.conflict_type === "fork_edit") {
            const candidates = conflict.candidate_details
              .map(
                (detail) => `
                  <div class="sync-conflict-candidate">
                    <div>${formatCandidate(detail)}</div>
                    <button type="button" class="secondary" data-offline-resolve="${escapeHtml(conflict.id)}" data-keep="${escapeHtml(detail?.id || "")}">保留這個版本</button>
                  </div>`
              )
              .join("");
            return `
              <article class="sync-conflict">
                <strong>同一筆交易在兩台裝置分別被修改成不同版本，請選一個保留：</strong>
                <div class="sync-conflict-candidates">${candidates}</div>
              </article>`;
          }
          const candidate = conflict.candidate_details[0];
          return `
            <article class="sync-conflict">
              <strong>一台裝置刪除了這筆交易，另一台裝置把它改成下面這樣：</strong>
              <div class="sync-conflict-candidates">
                <div class="sync-conflict-candidate">
                  <div>${formatCandidate(candidate)}</div>
                  <button type="button" class="secondary" data-offline-resolve="${escapeHtml(conflict.id)}" data-keep="${escapeHtml(candidate?.id || "")}">保留這個修改</button>
                </div>
                <div class="sync-conflict-candidate">
                  <div class="muted">維持刪除，放棄上面這個修改</div>
                  <button type="button" data-offline-resolve="${escapeHtml(conflict.id)}" data-keep="${escapeHtml(conflict.transaction_id)}">確認刪除</button>
                </div>
              </div>
            </article>`;
        })
        .join("");
      conflictsEl.innerHTML = `<p class="notice">有 ${conflicts.length} 筆交易需要你確認要保留哪個版本，確認之前不會計入報表金額：</p>${cards}`;
    };

    const refresh = async () => {
      try {
        if (document.activeElement !== nameInput) {
          const deviceStatus = await fetch("/api/offline-sync/status", { cache: "no-store" }).then((response) => response.json());
          nameInput.value = deviceStatus.device_name || "";
        }
        const status = await fetch("/api/offline-sync/drive-status", { cache: "no-store" }).then((response) => response.json());
        connectButton.textContent = status.connected ? "重新連結 Google 帳號" : "連結 Google 帳號";
        keyRow.style.display = status.connected ? "block" : "none";
        autoRow.style.display = status.connected && status.encryption_key_set ? "block" : "none";
        syncNowButton.disabled = !status.connected || !status.encryption_key_set;
        if (status.token_invalid) {
          statusEl.textContent = "Google 連結已失效（可能是在 Google 帳號設定裡移除了授權），請重新連結。";
        } else if (!status.connected) {
          statusEl.textContent = "尚未連結 Google 帳號。";
        } else if (!status.encryption_key_set) {
          statusEl.textContent = "已連結 Google 帳號，請先在下方設定同步加密金鑰。";
        } else {
          const parts = [`本機版本 #${status.local_revision}`];
          parts.push(status.remote_revision <= status.local_revision ? "Google Drive 已是最新" : `Google Drive 上有更新版本 #${status.remote_revision}`);
          if (status.open_conflicts > 0) parts.push(`${status.open_conflicts} 筆待確認`);
          statusEl.textContent = parts.join("・");
        }
        if (status.open_conflicts > 0) {
          const conflicts = await fetch("/api/offline-sync/conflicts", { cache: "no-store" }).then((response) => response.json());
          renderConflicts(conflicts);
        } else {
          renderConflicts([]);
        }
        if (status.connected) {
          const autoSettings = await fetch("/api/offline-sync/auto-sync-settings", { cache: "no-store" }).then((response) => response.json());
          autoEnabled.checked = autoSettings.enabled;
          autoTime.value = autoSettings.time;
        }
      } catch (error) {
        statusEl.textContent = "同步狀態讀取失敗";
      }
    };

    const runSync = async ({ silent } = {}) => {
      syncNowButton.disabled = true;
      let elapsedSeconds = 0;
      let ticker = null;
      if (!silent) {
        messageEl.textContent = "同步中…（0 秒）";
        ticker = setInterval(() => {
          elapsedSeconds += 1;
          messageEl.textContent = `同步中…（${elapsedSeconds} 秒）`;
        }, 1000);
      }
      try {
        const response = await fetch("/api/offline-sync/drive-sync-now", { method: "POST" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "同步失敗");
        const conflicts = result.pull.new_conflicts || 0;
        messageEl.textContent = conflicts
          ? `同步完成，但有 ${conflicts} 筆交易需要你確認要保留哪個版本（見下方）。`
          : `同步完成：版本 #${result.push.revision}。`;
        await Promise.all([loadSummary(), loadTransactions(), loadReport(), loadBalances()]);
        if (silent) showToast("已自動完成每日同步");
      } catch (error) {
        if (!silent) messageEl.textContent = error.message;
      } finally {
        if (ticker) clearInterval(ticker);
        await refresh();
      }
    };

    connectButton.addEventListener("click", async () => {
      connectButton.disabled = true;
      messageEl.textContent = "正在前往 Google 授權頁面…";
      try {
        await window.beginGoogleAuth();
      } catch (error) {
        messageEl.textContent = error.message;
        connectButton.disabled = false;
      }
    });

    keySaveButton.addEventListener("click", async () => {
      const key = keyInput.value;
      if (key.length < 12) {
        messageEl.textContent = "加密金鑰至少需要 12 個字元。";
        return;
      }
      await fetch("/api/offline-sync/drive-encryption-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      keyInput.value = "";
      messageEl.textContent = "加密金鑰已儲存在這台裝置。";
      await refresh();
    });

    nameSaveButton.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      if (!name) {
        messageEl.textContent = "請先輸入裝置名稱。";
        return;
      }
      const response = await fetch("/api/offline-sync/device-name", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const result = await response.json();
      if (!response.ok) {
        messageEl.textContent = result.error || "儲存失敗";
        return;
      }
      messageEl.textContent = "裝置名稱已儲存。";
    });

    autoSaveButton.addEventListener("click", async () => {
      await fetch("/api/offline-sync/auto-sync-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: autoEnabled.checked, time: autoTime.value || "08:00" }),
      });
      messageEl.textContent = "每日自動同步設定已儲存。";
    });

    syncNowButton.addEventListener("click", () => runSync());

    conflictsEl.addEventListener("click", (event) => {
      const button = event.target.closest("[data-offline-resolve]");
      if (!button) return;
      (async () => {
        button.disabled = true;
        messageEl.textContent = "處理中…";
        try {
          const response = await fetch(`/api/offline-sync/conflicts/${button.dataset.offlineResolve}/resolve`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ keep_transaction_id: button.dataset.keep }),
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "處理失敗");
          messageEl.textContent = "已處理這筆衝突。";
          await Promise.all([loadSummary(), loadTransactions(), loadReport(), loadBalances()]);
        } catch (error) {
          messageEl.textContent = error.message;
        } finally {
          await refresh();
        }
      })();
    });

    window.addEventListener("google-auth-result", (event) => {
      connectButton.disabled = false;
      messageEl.textContent = event.detail.ok ? "Google 帳號已連結。" : event.detail.error;
      refresh();
    });

    const dialog = document.getElementById("cloud-settings-dialog");
    if (dialog) {
      new MutationObserver(() => {
        if (dialog.open) refresh();
      }).observe(dialog, { attributes: true, attributeFilter: ["open"] });
    }

    // 「每天自動同步」在 PWA 裡只能做成「打開 App 時，如果已經過了設定時間、
    // 今天還沒同步過，就自動同步一次」，見 sync.js 的 shouldAutoSyncNow 註解。
    // 用 silent 模式跑，不干擾使用者，成功了才跳一個小提示。
    (async () => {
      try {
        const autoSettings = await fetch("/api/offline-sync/auto-sync-settings", { cache: "no-store" }).then((response) => response.json());
        if (autoSettings.due) await runSync({ silent: true });
      } catch (_) {
        // 連不到伺服器或還沒連結 Google 帳號時，靜靜跳過，不用另外提示錯誤。
      }
    })();
  }

  // 新裝置第一次使用的引導畫面（onboarding.js）仍然可能需要「選擇快照檔案來
  // 合併」這個備用起點（例如 Google Drive 還沒設定好之前，先接續另一台裝置的
  // 帳本）；這裡只保留背後真正在做事的隱藏檔案輸入框跟合併邏輯，不在「帳務
  // 備份」畫面上放對應的按鈕——現在 Drive 同步已經可以直接用，不需要平常曝光
  // 這條手動路徑，但底層能力還留著。
  function setupHiddenManualMergeInput() {
    if (document.getElementById("offline-sync-file")) return;
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.id = "offline-sync-file";
    fileInput.accept = ".sqlite3";
    fileInput.hidden = true;
    document.body.append(fileInput);
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files[0];
      fileInput.value = "";
      if (!file) return;
      try {
        const response = await fetch("/api/offline-sync/merge", { method: "POST", body: file });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "合併失敗");
        const insertedTotal = Object.values(result.inserted).reduce((sum, n) => sum + n, 0);
        await Promise.all([loadSummary(), loadTransactions(), loadReport(), loadBalances()]);
        showToast(result.new_conflicts ? `合併完成，新增 ${insertedTotal} 筆資料，有 ${result.new_conflicts} 筆需要確認` : `合併完成，新增 ${insertedTotal} 筆資料`);
      } catch (error) {
        showToast(error.message);
      }
    });
  }

  // 「清除本機資料重新開始」：整台裝置的本機帳本直接清空，通常用在發現這台裝置
  // 在還沒跟其他裝置對齊前，自己累積了一些對不起來的測試/雜訊資料，想乾脆從頭
  // 開始（例如換一支新手機、或先前不小心提早開始用）。這是不可逆的動作，按下去
  // 前一定要先跟使用者確認，且提醒先確認 Google Drive／其他裝置上有保留得住的
  // 最新版本，免得真的清掉還沒同步出去的資料。
  function setupResetButton() {
    const anchor = document.getElementById("offline-drive-sync-section");
    if (!anchor) return;

    const section = document.createElement("section");
    section.id = "offline-reset-section";
    section.style.marginTop = "18px";
    section.innerHTML = `
      <h3>清除本機資料</h3>
      <p class="muted">把這台裝置本機儲存的整份帳本清空、從頭開始。用在這台裝置累積了一些跟其他裝置對不起來的測試或雜訊資料時。清除前請先確認 Google Drive 上（或其他裝置）已經有你要保留的最新版本，這個動作沒辦法復原。</p>
      <button type="button" id="offline-reset-button" style="background:#a43d35">清除本機資料重新開始</button>
      <p id="offline-reset-message" class="muted"></p>
    `;
    anchor.after(section);

    document.getElementById("offline-reset-button").addEventListener("click", async () => {
      if (!confirm("確定要清除這台裝置本機儲存的整份帳本嗎？這個動作無法復原。請先確認 Google Drive 或其他裝置上已經有你要保留的最新版本。")) return;
      const button = document.getElementById("offline-reset-button");
      const messageEl = document.getElementById("offline-reset-message");
      button.disabled = true;
      messageEl.textContent = "清除中…";
      try {
        await window.__offlineResetDevice();
        // 資料庫又變空了，讓新裝置引導畫面（onboarding.js）重新出現，
        // 引導使用者直接「下載並合併」接續其他裝置的帳本，而不是又忘記同步。
        localStorage.removeItem("accounting-offline-onboarded");
        messageEl.textContent = "已清除，正在重新整理頁面…";
        location.reload();
      } catch (error) {
        messageEl.textContent = "清除失敗：" + error.message;
        button.disabled = false;
      }
    });
  }

  // GitHub Pages 複本專用：沒有「帳務同步」對話框可以掛，「清除本機資料」直接
  // 變成主選單裡自己的一個項目，點下去就是原本那組確認/清除流程，不用先繞進
  // 一個裝著一堆 Drive 欄位（这份複本永遠用不到）的設定畫面。
  function setupStandaloneResetButton() {
    const actions = document.querySelector(".menu-actions");
    if (!actions) return;
    const button = document.createElement("button");
    button.type = "button";
    button.id = "menu-clear-data";
    button.innerHTML = '<span>🗑</span>清除本機資料';
    actions.append(button);

    button.addEventListener("click", async () => {
      document.getElementById("main-menu-dialog")?.close();
      if (!confirm("確定要清除這台裝置本機儲存的整份帳本嗎？這個動作無法復原，清除後帳本會變成全新、沒有資料的狀態。")) return;
      button.disabled = true;
      try {
        await window.__offlineResetDevice();
        localStorage.removeItem("accounting-offline-onboarded");
        location.reload();
      } catch (error) {
        alert("清除失敗：" + error.message);
        button.disabled = false;
      }
    });
  }

  // GitHub Pages 複本專用：朋友要求的「外觀設定」——挑一組顏色風格、調整字體
  // 大小。顏色風格靠 app.css 裡 :root[data-theme="..."] 這幾組 CSS 變數覆寫（桌面
  // 版／手機沒有這個 data-theme 屬性，用回預設值，完全不受影響）；字體大小用
  // <html> 的 zoom 屬性整頁縮放（現有樣式幾乎都用 px 寫死，改 root font-size 沒用，
  // zoom 才能連版面間距一起放大，不是只放大文字）。兩個設定都存在 localStorage，
  // 下次打開時由 index.html 最上面那段 bootstrap script 先套用一次，才不會每次
  // 開頁先閃一下預設樣式才變成使用者選的樣式。
  const THEMES = [
    { id: "default", label: "墨綠（預設）", swatch: "#173f35" },
    { id: "navy", label: "靛藍", swatch: "#1c3a5e" },
    { id: "wine", label: "酒紅", swatch: "#5c2233" },
    { id: "purple", label: "深紫", swatch: "#3d2a5c" },
    { id: "charcoal", label: "木炭灰", swatch: "#2b2f33" },
  ];
  const FONT_SCALES = [
    { id: "small", label: "小", value: 0.9 },
    { id: "normal", label: "中（預設）", value: 1 },
    { id: "large", label: "大", value: 1.15 },
    { id: "xlarge", label: "特大", value: 1.3 },
  ];

  function applyTheme(themeId) {
    if (!themeId || themeId === "default") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = themeId;
  }
  function applyFontScale(scaleId) {
    const scale = FONT_SCALES.find((item) => item.id === scaleId) || FONT_SCALES[1];
    document.documentElement.style.zoom = scale.value;
  }

  function setupAppearanceButton() {
    const actions = document.querySelector(".menu-actions");
    if (!actions) return;

    const savedTheme = localStorage.getItem("accounting-theme") || "default";
    const savedFontScale = localStorage.getItem("accounting-font-scale") || "normal";
    applyTheme(savedTheme);
    applyFontScale(savedFontScale);

    const button = document.createElement("button");
    button.type = "button";
    button.id = "menu-appearance";
    button.innerHTML = '<span>🎨</span>外觀設定';
    const clearDataButton = document.getElementById("menu-clear-data");
    if (clearDataButton) clearDataButton.before(button);
    else actions.append(button);

    const dialog = document.createElement("dialog");
    dialog.id = "appearance-dialog";
    dialog.innerHTML = `
      <form method="dialog" style="padding:22px">
        <div class="dialog-title"><h2>外觀設定</h2><button type="button" class="icon-button" id="appearance-close">×</button></div>
        <h3 style="margin-top:0">顏色風格</h3>
        <div id="appearance-theme-row" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:22px">
          ${THEMES.map((theme) => `<button type="button" data-theme-id="${theme.id}" style="width:auto;flex:1 1 auto;min-width:84px;padding:12px 8px;border-radius:12px;background:${theme.swatch};color:#fff;border:3px solid ${theme.id === savedTheme ? "#ffce57" : "transparent"}">${escapeHtml(theme.label)}</button>`).join("")}
        </div>
        <h3>字體大小</h3>
        <div id="appearance-font-row" style="display:flex;gap:10px;flex-wrap:wrap">
          ${FONT_SCALES.map((scale) => `<button type="button" data-font-id="${scale.id}" class="${scale.id === savedFontScale ? "" : "secondary"}" style="width:auto;flex:1 1 auto;min-width:74px">${escapeHtml(scale.label)}</button>`).join("")}
        </div>
      </form>
    `;
    document.body.append(dialog);

    button.addEventListener("click", () => {
      document.getElementById("main-menu-dialog")?.close();
      dialog.showModal();
    });
    document.getElementById("appearance-close").addEventListener("click", () => dialog.close());

    document.getElementById("appearance-theme-row").addEventListener("click", (event) => {
      const target = event.target.closest("[data-theme-id]");
      if (!target) return;
      applyTheme(target.dataset.themeId);
      localStorage.setItem("accounting-theme", target.dataset.themeId);
      dialog.querySelectorAll("[data-theme-id]").forEach((el) => {
        el.style.borderColor = el === target ? "#ffce57" : "transparent";
      });
    });

    document.getElementById("appearance-font-row").addEventListener("click", (event) => {
      const target = event.target.closest("[data-font-id]");
      if (!target) return;
      applyFontScale(target.dataset.fontId);
      localStorage.setItem("accounting-font-scale", target.dataset.fontId);
      dialog.querySelectorAll("[data-font-id]").forEach((el) => {
        el.className = el === target ? "" : "secondary";
      });
    });
  }

  // 主選單頂端（黃色區塊）放一顆快速「立即同步」按鈕，不用先打開「帳務同步」
  // 那個完整畫面——打開主選單時順便檢查一次雲端版本，有新版本就提示，
  // 沒有就直接說「目前已是最新版本」，按下去就跟完整畫面裡的立即同步一樣。
  function setupQuickSyncButton() {
    const actions = document.querySelector(".menu-actions");
    const annualButton = document.getElementById("menu-annual");
    if (!actions) return;

    // 原本是獨立疊在主選單標題列上、絕對定位置中的膠囊；使用者要求改成跟「年度收支
    // 統計」那些選單項目同一種格式（清單裡的一個按鈕），放在清單最上面（年度收支統計
    // 上面）——直接沿用 .menu-actions button 既有的樣式，圖示＋文字兩欄，狀態文字
    // 用 <small> 疊在標題文字下面（跟很早期「立即備份」那顆按鈕的堆疊排版一樣）。
    const button = document.createElement("button");
    button.type = "button";
    button.id = "menu-quick-sync";
    button.className = "menu-quick-sync";
    button.innerHTML = '<span>☁</span><span><b>立即同步</b><small id="menu-sync-status">檢查中…</small></span>';
    if (annualButton) annualButton.before(button);
    else actions.prepend(button);

    const status = document.getElementById("menu-sync-status");

    const checkStatus = async () => {
      try {
        const result = await fetch("/api/offline-sync/drive-status", { cache: "no-store" }).then((response) => response.json());
        if (!result.connected || !result.encryption_key_set) {
          status.textContent = "尚未連結雲端同步";
          button.disabled = true;
          return;
        }
        button.disabled = false;
        status.textContent = result.remote_revision > result.local_revision
          ? (result.remote_name ? `雲端有新版本［${result.remote_name}］` : "雲端有新版本，建議同步")
          : "目前已是最新版本";
      } catch (error) {
        button.disabled = false;
        status.textContent = "";
      }
    };

    button.addEventListener("click", async () => {
      button.disabled = true;
      status.textContent = "同步中…";
      try {
        const response = await fetch("/api/offline-sync/drive-sync-now", { method: "POST" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "同步失敗");
        await Promise.all([loadSummary(), loadTransactions(), loadReport(), loadBalances()]);
        showToast("同步完成");
      } catch (error) {
        showToast(error.message);
      } finally {
        await checkStatus();
      }
    });

    document.getElementById("main-menu-open")?.addEventListener("click", checkStatus);
    checkStatus();
  }

  // GitHub Pages 那份複本（給沒有自己電腦伺服器的朋友用）背後完全沒有 Google
  // Drive 同步能力（沒有後端可以安全處理 OAuth，見 PROJECT_SPEC 13.33）——這台
  // 裝置永遠連不上、按了也只會看到「尚未連結」，「帳務同步」「立即同步」這兩個
  // 入口對這份複本的使用者來說純粹是干擾，只留「清除本機資料」跟朋友要求新增
  // 的「外觀設定」。用網域判斷（kkljman-lab.github.io），桌面版／手機透過
  // Tailscale 連自己電腦的情況網域都不是 *.github.io，完全不受影響。
  const isGithubPagesCopy = location.hostname.endsWith(".github.io");

  if (isGithubPagesCopy) {
    document.getElementById("menu-backup")?.remove();
    setupHiddenManualMergeInput();
    setupStandaloneResetButton();
    setupAppearanceButton();
  } else {
    hideUnusedDesktopSections();
    setupGoogleDriveSync();
    setupHiddenManualMergeInput();
    setupResetButton();
    setupQuickSyncButton();
  }
})();
