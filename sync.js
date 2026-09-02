// 跨裝置同步（透過使用者自己的 Google Drive）。
//
// 這跟 offline.js 裡 header 上的「已同步」徽章是兩件不同的事：
// - offline.js 的「已同步」：這台裝置暫存、還沒送到伺服器的帳務，有沒有送出去。
// - 這支檔案的「跨裝置同步」：這台裝置的整本帳本，有沒有跟 Google Drive 上、
//   由其他裝置（例如手機）上傳的版本合併在一起。
//
// 依賴 app.js 已經定義好的全域小工具（$、escapeHtml、money、showToast、
// loadSummary/loadTransactions/loadReport/loadBalances），以及 app.js 建立好的
// 「帳務備份」對話框（#cloud-settings-dialog）。這支檔案必須在 app.js 之後載入。

function setupDriveSync() {
  const googleSection = document.getElementById("google-connect")?.closest("section");
  if (!googleSection) return;

  const section = document.createElement("section");
  section.id = "drive-sync-section";
  section.style.marginTop = "18px";
  section.innerHTML = `
    <h3>跨裝置同步</h3>
    <p class="muted">把這台裝置的帳本上傳到 Google Drive；其他裝置（例如手機）連上網後可以下載合併，離線時各自都能正常記帳，之後再同步。</p>
    <p id="drive-sync-status" class="muted">載入中…</p>
    <div class="utility-actions">
      <button type="button" id="drive-sync-pull" class="secondary">下載並合併</button>
      <button type="button" id="drive-sync-push">上傳目前版本</button>
    </div>
    <p id="drive-sync-message" class="muted"></p>
    <div id="drive-sync-conflicts"></div>
  `;
  googleSection.after(section);

  const statusEl = document.getElementById("drive-sync-status");
  const messageEl = document.getElementById("drive-sync-message");
  const conflictsEl = document.getElementById("drive-sync-conflicts");
  const pullButton = document.getElementById("drive-sync-pull");
  const pushButton = document.getElementById("drive-sync-push");

  const formatCandidate = (detail) => {
    if (!detail) return "<span class=\"muted\">（找不到這筆交易的內容）</span>";
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
                  <button type="button" class="secondary" data-resolve-conflict="${escapeHtml(conflict.id)}" data-keep="${escapeHtml(detail?.id || "")}">保留這個版本</button>
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
                <button type="button" class="secondary" data-resolve-conflict="${escapeHtml(conflict.id)}" data-keep="${escapeHtml(candidate?.id || "")}">保留這個修改</button>
              </div>
              <div class="sync-conflict-candidate">
                <div class="muted">維持刪除，放棄上面這個修改</div>
                <button type="button" data-resolve-conflict="${escapeHtml(conflict.id)}" data-keep="${escapeHtml(conflict.transaction_id)}">確認刪除</button>
              </div>
            </div>
          </article>`;
      })
      .join("");
    conflictsEl.innerHTML = `<p class="notice">有 ${conflicts.length} 筆交易需要你確認要保留哪個版本，確認之前不會計入報表金額：</p>${cards}`;
  };

  const refresh = async () => {
    try {
      const status = await fetch("/api/sync/status", { cache: "no-store" }).then((response) => response.json());
      if (!status.configured) {
        statusEl.textContent = "尚未設定 Google OAuth 憑證或同步加密金鑰。";
      } else if (!status.connected) {
        statusEl.textContent = "尚未連結 Google 帳號；請先在上方「連結 Google 帳號」完成連結。";
      } else if (status.error) {
        statusEl.textContent = "讀取同步狀態失敗：" + status.error;
      } else {
        const parts = [`本機版本 #${status.local_revision}`];
        if (status.remote_revision !== null) {
          parts.push(status.up_to_date ? "Google Drive 已是最新" : `Google Drive 上有更新版本 #${status.remote_revision}`);
        }
        if (status.open_conflicts > 0) parts.push(`${status.open_conflicts} 筆待確認`);
        statusEl.textContent = parts.join("・");
      }
      pullButton.disabled = !status.connected;
      pushButton.disabled = !status.connected;
      if (status.open_conflicts > 0) {
        const conflicts = await fetch("/api/sync/conflicts", { cache: "no-store" }).then((response) => response.json());
        renderConflicts(conflicts);
      } else {
        renderConflicts([]);
      }
    } catch (error) {
      statusEl.textContent = "同步狀態讀取失敗";
    }
  };

  const withButtonsDisabled = async (task) => {
    pullButton.disabled = true;
    pushButton.disabled = true;
    try {
      await task();
    } finally {
      await refresh();
    }
  };

  pullButton.addEventListener("click", () =>
    withButtonsDisabled(async () => {
      messageEl.textContent = "下載並合併中…";
      try {
        const response = await fetch("/api/sync/pull", { method: "POST" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "同步失敗");
        if (result.status === "up_to_date") {
          messageEl.textContent = "已經是最新，沒有需要合併的資料。";
        } else if (result.status === "empty") {
          messageEl.textContent = "Google Drive 上還沒有任何同步資料，請先按「上傳目前版本」。";
        } else {
          messageEl.textContent = result.new_conflicts
            ? `合併完成，但有 ${result.new_conflicts} 筆交易需要你確認要保留哪個版本（見下方）。`
            : "合併完成，資料已是最新。";
          await Promise.all([loadSummary(), loadTransactions(), loadReport(), loadBalances()]);
        }
      } catch (error) {
        messageEl.textContent = error.message;
      }
    })
  );

  pushButton.addEventListener("click", () =>
    withButtonsDisabled(async () => {
      messageEl.textContent = "上傳中…";
      try {
        const response = await fetch("/api/sync/push", { method: "POST" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "上傳失敗");
        messageEl.textContent = `上傳完成：版本 #${result.revision}`;
      } catch (error) {
        messageEl.textContent = error.message;
      }
    })
  );

  conflictsEl.addEventListener("click", (event) => {
    const button = event.target.closest("[data-resolve-conflict]");
    if (!button) return;
    withButtonsDisabled(async () => {
      button.disabled = true;
      messageEl.textContent = "處理中…";
      try {
        const response = await fetch(`/api/sync/conflicts/${button.dataset.resolveConflict}/resolve`, {
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
      }
    });
  });

  // 這個對話框（#cloud-settings-dialog）被打開時，順便重新整理同步狀態。用 MutationObserver
  // 觀察 open 屬性，而不是在觸發它的按鈕上加 click 監聽——app.js 的 reorganizeMenuAndAppearance()
  // 對同一顆按鈕呼叫了 event.stopImmediatePropagation()，會讓後加的 click 監聽器永遠收不到事件。
  const dialog = document.getElementById("cloud-settings-dialog");
  if (dialog) {
    new MutationObserver(() => {
      if (dialog.open) refresh();
    }).observe(dialog, { attributes: true, attributeFilter: ["open"] });
  }
}

setupDriveSync();
