// GitHub 版（朋友用的那份）的「遮蔽」密碼鎖：打勾遮蔽之後，要取消打勾得輸入密碼。
//
// 這只是擋「旁邊的人順手點掉遮蔽」的簡單鎖，不是真正的資料加密——密碼雜湊存在這台裝置的
// localStorage，懂技術的人用開發者工具就能繞過；帳務資料本身仍然完整存在手機裡。
// 只在 *.github.io 網址啟用；自己的手機／電腦版完全不受影響（沒有這個檔案也一樣能運作）。
(function () {
  if (!location.hostname.endsWith('.github.io')) return;
  const checkbox = document.getElementById('privacy-toggle');
  if (!checkbox) return;

  const LOCK_KEY = 'accounting-privacy-lock';
  // 忘記密碼時的備用救援碼：這裡只放它的 SHA-256，原碼由提供這個網頁的人保管。
  const RECOVERY_HASH = '74cc4e16d4f46f9b9dc75bb8add13de7c3ca45109f5601288fa173a85815f493';

  const storage = {
    get() { try { return localStorage.getItem(LOCK_KEY); } catch (_) { return null; } },
    set(value) { try { localStorage.setItem(LOCK_KEY, value); } catch (_) { /* 存不了就算了，下次打勾再設定 */ } },
    clear() { try { localStorage.removeItem(LOCK_KEY); } catch (_) { /* ignore */ } },
  };

  async function sha256(text) {
    if (window.crypto?.subtle) {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
    }
    // 沒有 crypto.subtle（非安全連線）時的簡單替代：只是擋人用，不需要密碼學強度。
    let hash = 5381;
    for (const ch of text) hash = ((hash * 33) ^ ch.codePointAt(0)) >>> 0;
    return 'x' + hash.toString(16);
  }
  const hashPassword = password => sha256('pa-privacy-lock:' + password);
  const hashRecovery = code => sha256('pa-privacy-recovery:' + code.trim().toUpperCase());

  // 通用的小對話框：fields = [{ placeholder, type }]，回傳輸入值陣列；取消回傳 null。
  // validate(values) 回傳錯誤訊息字串就留在對話框、顯示錯誤；回傳 null/'' 代表通過。
  function askDialog({ title, note, fields, confirmText, validate, extraButton }) {
    return new Promise(resolve => {
      const dialog = document.createElement('dialog');
      dialog.style.cssText = 'border:0;border-radius:18px;padding:0;width:min(88vw,340px);box-shadow:0 12px 40px #0006';
      const form = document.createElement('form');
      form.style.cssText = 'padding:20px;display:grid;gap:12px';
      form.innerHTML = '<h2 style="margin:0;font-size:18px;text-align:center"></h2><p class="muted" style="margin:0;font-size:13px;text-align:center"></p>';
      form.querySelector('h2').textContent = title;
      form.querySelector('p').textContent = note || '';
      const inputs = fields.map(field => {
        const input = document.createElement('input');
        input.type = field.type || 'password';
        input.placeholder = field.placeholder;
        input.autocomplete = 'off';
        if (field.numeric) input.inputMode = 'numeric';
        input.style.cssText = 'width:100%;box-sizing:border-box;padding:12px;font-size:16px';
        form.append(input);
        return input;
      });
      const error = document.createElement('p');
      error.setAttribute('role', 'alert');
      error.style.cssText = 'margin:0;color:#a43d35;font-size:13px;min-height:1em;text-align:center';
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:10px';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'secondary';
      cancel.textContent = '取消';
      cancel.style.cssText = 'flex:1';
      const ok = document.createElement('button');
      ok.type = 'submit';
      ok.textContent = confirmText || '確定';
      ok.style.cssText = 'flex:1';
      row.append(cancel, ok);
      form.append(error, row);
      if (extraButton) {
        const extra = document.createElement('button');
        extra.type = 'button';
        extra.textContent = extraButton.text;
        extra.style.cssText = 'background:none;color:#555;border:0;font-size:13px;text-decoration:underline;padding:4px;width:auto;justify-self:center';
        extra.addEventListener('click', () => { dialog.close(); resolve({ extra: true }); });
        form.append(extra);
      }
      dialog.append(form);
      document.body.append(dialog);
      let settled = false;
      const finish = value => { if (settled) return; settled = true; dialog.close(); dialog.remove(); resolve(value); };
      cancel.addEventListener('click', () => finish(null));
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
      form.addEventListener('submit', async event => {
        event.preventDefault();
        const values = inputs.map(input => input.value);
        const message = validate ? await validate(values) : null;
        if (message) { error.textContent = message; inputs[0].select(); return; }
        finish(values);
      });
      dialog.showModal();
      inputs[0].focus();
    });
  }

  async function chooseNewPassword() {
    const result = await askDialog({
      title: '設定遮蔽密碼',
      note: '之後要取消「遮蔽」就得輸入這組密碼。簡單好記就好（至少 4 個字），請記住它。',
      fields: [{ placeholder: '輸入密碼' }, { placeholder: '再輸入一次密碼' }],
      confirmText: '設定並遮蔽',
      validate: ([first, second]) => {
        if (first.length < 4) return '密碼至少 4 個字';
        if (first !== second) return '兩次輸入的密碼不一樣';
        return null;
      },
    });
    if (!result || result.extra) return false;
    storage.set(await hashPassword(result[0]));
    return true;
  }

  async function verifyPassword() {
    const stored = storage.get();
    if (!stored) return true; // 沒有設定過密碼（例如清除過資料）就直接放行
    const result = await askDialog({
      title: '輸入密碼',
      note: '取消「遮蔽」需要密碼。',
      fields: [{ placeholder: '密碼' }],
      confirmText: '解除遮蔽',
      validate: async ([password]) => (await hashPassword(password)) === stored ? null : '密碼不正確',
      extraButton: { text: '忘記密碼？' },
    });
    if (!result) return false;
    if (result.extra) return recoverPassword();
    return true;
  }

  async function recoverPassword() {
    const result = await askDialog({
      title: '忘記密碼',
      note: '請輸入 8 碼救援碼（向提供這個網頁的人索取）。通過後會清除舊密碼並解除遮蔽，下次打勾時可設定新密碼。',
      fields: [{ placeholder: '救援碼', type: 'text' }],
      confirmText: '重設',
      validate: async ([code]) => (await hashRecovery(code)) === RECOVERY_HASH ? null : '救援碼不正確',
    });
    if (!result || result.extra) return false;
    storage.clear();
    return true;
  }

  function applyChecked(value) {
    checkbox.checked = value;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  }

  let busy = false;
  // 用 capture 階段搶在其他監聽之前處理；先擋下這次點擊（勾選狀態會自動還原），
  // 等密碼通過再自己改勾選並觸發 change，讓 app.js 原本的重新整理邏輯照常執行。
  checkbox.addEventListener('click', async event => {
    // click 事件進來時，勾選狀態已經先被切換成「使用者想要的新狀態」了。
    const wantsChecked = checkbox.checked;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (busy) return;
    busy = true;
    try {
      // 先等這次點擊完整結束：瀏覽器在 click 處理完之後才會把「被 preventDefault 擋下」的勾選
      // 還原成點擊前的狀態，如果在同一個點擊裡就改勾選，會被它還原回去。
      await new Promise(resolve => setTimeout(resolve, 0));
      if (wantsChecked) {
        if (storage.get() || await chooseNewPassword()) applyChecked(true);
      } else if (await verifyPassword()) {
        applyChecked(false);
      }
    } finally {
      busy = false;
    }
  }, true);
})();
