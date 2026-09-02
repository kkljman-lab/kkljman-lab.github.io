// 新裝置第一次使用離線引擎時的引導畫面。只在離線引擎啟用時生效（自己判斷
// localStorage 旗標），桌面版完全不受影響——桌面版的零設定自動匯入流程刻意不動，
// 見 PROJECT_SPEC.md 12.8 節「這涉及使用者體驗設計，留待下次一起討論再動工」。
//
// 離線引擎第一次執行時是「空的資料庫」（db-worker.js 不會像桌面版 local.py 那樣
// 靜默自動匯入 test.csv），如果使用者這時候就直接開始新增交易，之後才想接續其他
// 裝置的帳本，會出現「這台裝置自己編出來的資料」跟「其他裝置的既有帳本」混在一起
// 分不清楚的問題（見 12.7 節已知限制）。這裡在偵測到空資料庫時，主動請使用者
// 選一個起點：全新開始、匯入 CSV、或合併另一台裝置的快照——都是直接重用既有的
// 匯入／合併輸入框，不重新實作一次匯入/合併邏輯。
(function () {
  if (localStorage.getItem("accounting-offline-engine") !== "1") return;
  if (localStorage.getItem("accounting-offline-onboarded") === "1") return;

  async function isDatabaseEmpty() {
    try {
      const summary = await fetch("/api/summary", { cache: "no-store" }).then((response) => response.json());
      return summary.transaction_count === 0 && summary.active_accounts === 0;
    } catch (_) {
      return false;
    }
  }

  function markOnboarded() {
    localStorage.setItem("accounting-offline-onboarded", "1");
  }

  async function setupOnboarding() {
    if (!(await isDatabaseEmpty())) {
      markOnboarded();
      return;
    }

    const dialog = document.createElement("dialog");
    dialog.id = "onboarding-dialog";
    dialog.innerHTML = `
      <div class="utility-book">
        <div class="dialog-title">
          <div><p class="eyebrow dark">NEW DEVICE</p><h2>這台裝置要怎麼開始？</h2></div>
          <button type="button" class="icon-button" id="onboarding-close">×</button>
        </div>
        <p class="notice">這台裝置目前是空的帳本。如果你其他裝置已經有記帳資料，建議先匯入或合併，避免之後兩邊資料對不起來。</p>
        <div class="utility-actions" style="flex-direction:column;align-items:stretch;gap:10px">
          <button type="button" id="onboarding-import">匯入 CSV 檔案</button>
          <button type="button" id="onboarding-merge" class="secondary">選擇其他裝置的快照檔案來合併</button>
          <button type="button" id="onboarding-blank" class="secondary">不用了，從空白帳本開始</button>
        </div>
      </div>
    `;
    document.body.append(dialog);

    const close = () => {
      markOnboarded();
      dialog.close();
      dialog.remove();
    };

    dialog.querySelector("#onboarding-close").addEventListener("click", close);
    dialog.querySelector("#onboarding-blank").addEventListener("click", close);
    // 匯入／合併都重用既有的隱藏檔案輸入框：選檔之後 app.js／sync-ui.js 自己的
    // change 監聽器會處理匯入或合併，成功後也會各自重新整理畫面或整頁重新載入，
    // 屆時資料庫不再是空的，這個引導畫面自然不會再出現，不需要另外設定旗標。
    dialog.querySelector("#onboarding-import").addEventListener("click", () => {
      dialog.close();
      dialog.remove();
      document.getElementById("transfer-file")?.click();
    });
    dialog.querySelector("#onboarding-merge").addEventListener("click", () => {
      dialog.close();
      dialog.remove();
      document.getElementById("offline-sync-file")?.click();
    });

    dialog.showModal();
  }

  setupOnboarding();
})();
