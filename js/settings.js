/**
 * 7-11 商品卡皮夾 - 設定頁 (settings.js)
 *
 * 1. 通路品牌管理：新增 / 編輯 / 刪除品牌，設定單段或雙段、條碼檢查規則 (正規表示式)。
 *    掃描器與手動輸入都只讀這裡的設定，不再寫死 7-11 格式。
 * 2. Firebase 雲端同步：貼上專案設定、Google 登入 / 登出、立即同步。
 */

class SettingsPanel {
  open() {
    const modal = document.getElementById('settings-modal');
    if (!modal) return;
    this.closeEditor();
    this.renderBrandList();
    this.renderCloudStatus();
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  close() {
    const modal = document.getElementById('settings-modal');
    if (modal) modal.classList.remove('active');
    document.body.style.overflow = '';
    window.app.refreshUI();
  }

  bindEvents() {
    const on = (id, event, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener(event, fn);
    };

    on('btn-close-settings', 'click', () => this.close());
    on('btn-add-brand', 'click', () => this.openEditor(null));
    on('btn-cancel-brand', 'click', () => this.closeEditor());
    on('brand-editor', 'submit', (e) => {
      e.preventDefault();
      this.saveEditor();
    });
    on('brand-field-mode', 'change', () => this.updateEditorVisibility());
    ['brand-field-test', 'brand-field-code1', 'brand-field-code2', 'brand-field-mode', 'brand-field-uppercase'].forEach(id => {
      on(id, 'input', () => this.updateTestResult());
    });

    const list = document.getElementById('settings-brand-list');
    if (list) {
      list.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-action]');
        if (!btn) return;
        const id = btn.dataset.id;
        if (btn.dataset.action === 'edit') this.openEditor(id);
        if (btn.dataset.action === 'delete') this.deleteBrand(id);
      });
    }

    on('btn-cloud-save-config', 'click', () => this.saveCloudConfig());
    on('btn-cloud-clear-config', 'click', () => this.clearCloudConfig());
    on('btn-cloud-login', 'click', async () => {
      try {
        await window.cloudSync.signIn();
      } catch (err) {
        window.app.showToast('❌ 登入失敗：' + err.message, 'error');
      }
    });
    on('btn-cloud-logout', 'click', () => window.cloudSync.signOut());
    on('btn-cloud-sync', 'click', () => window.cloudSync.syncNow());

    window.cloudSync.onStatusChange = () => this.renderCloudStatus();
  }

  // ===== 通路品牌 =====

  renderBrandList() {
    const list = document.getElementById('settings-brand-list');
    if (!list) return;
    const esc = (s) => window.app.escapeHTML(s);
    const cards = window.cardStorage.getCards();

    list.innerHTML = window.cardStorage.getBrands().map(b => {
      const count = cards.filter(c => window.cardStorage.getCardBrand(c).id === b.id).length;
      const rules = b.mode === 'dual'
        ? `雙段｜① ${esc(b.code1Pattern || '不檢查')}　② ${esc(b.code2Pattern || '不檢查')}`
        : `單段｜${esc(b.code1Pattern || '不檢查')}`;
      return `
        <div class="settings-brand-row">
          <span class="card-brand-badge" style="background: ${esc(b.color)};">${esc(b.label)}</span>
          <div class="settings-brand-info">
            <div class="settings-brand-rules">${rules}</div>
            <div class="settings-hint">${count} 張卡片${b.id === window.DEFAULT_BRAND ? '・預設' : ''}</div>
          </div>
          <button class="btn-settings-small" data-action="edit" data-id="${esc(b.id)}">編輯</button>
          ${b.id === window.DEFAULT_BRAND ? '' : `<button class="btn-settings-small btn-settings-danger" data-action="delete" data-id="${esc(b.id)}">刪除</button>`}
        </div>
      `;
    }).join('');
  }

  openEditor(brandId) {
    const brand = brandId ? window.cardStorage.getBrand(brandId) : {
      id: '', label: '', color: '#64748B', mode: 'single', code1Pattern: '', code2Pattern: '', uppercase: false
    };
    const set = (id, value) => { document.getElementById(id).value = value; };
    set('brand-field-id', brand.id);
    set('brand-field-label', brand.label);
    set('brand-field-color', brand.color);
    set('brand-field-mode', brand.mode);
    set('brand-field-code1', brand.code1Pattern || '');
    set('brand-field-code2', brand.code2Pattern || '');
    set('brand-field-test', '');
    document.getElementById('brand-field-uppercase').checked = Boolean(brand.uppercase);
    document.getElementById('brand-editor-title').textContent = brandId ? `編輯「${brand.label}」` : '新增品牌';

    const editor = document.getElementById('brand-editor');
    editor.style.display = '';
    this.updateEditorVisibility();
    this.updateTestResult();
    editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  closeEditor() {
    const editor = document.getElementById('brand-editor');
    if (editor) editor.style.display = 'none';
  }

  readEditor() {
    const get = (id) => document.getElementById(id).value;
    return {
      id: get('brand-field-id'),
      label: get('brand-field-label'),
      color: get('brand-field-color'),
      mode: get('brand-field-mode'),
      code1Pattern: get('brand-field-code1').trim(),
      code2Pattern: get('brand-field-code2').trim(),
      uppercase: document.getElementById('brand-field-uppercase').checked
    };
  }

  updateEditorVisibility() {
    const isDual = document.getElementById('brand-field-mode').value === 'dual';
    document.getElementById('brand-field-code2-row').style.display = isDual ? '' : 'none';
  }

  // 即時測試：貼上一個條碼，顯示它會被當成第一段、第二段還是被忽略
  updateTestResult() {
    const out = document.getElementById('brand-test-result');
    const test = document.getElementById('brand-field-test').value;
    if (!out) return;
    if (!test.trim()) {
      out.textContent = '';
      return;
    }

    const brand = this.readEditor();
    const storage = window.cardStorage;
    for (const key of ['code1Pattern', 'code2Pattern']) {
      try {
        if (brand[key]) new RegExp(brand[key]);
      } catch (e) {
        out.textContent = `⚠️ 規則格式錯誤：${brand[key]}`;
        return;
      }
    }

    const code = storage.normalizeCode(brand, test);
    if (storage.matchesCode1(brand, code)) {
      out.textContent = `✅ 「${code}」符合第一段規則`;
    } else if (brand.mode === 'dual' && storage.matchesCode2(brand, code)) {
      out.textContent = `✅ 「${code}」符合第二段 (檢核碼) 規則`;
    } else {
      out.textContent = `❌ 「${code}」不符合規則，掃描時會被忽略`;
    }
  }

  saveEditor() {
    const brand = this.readEditor();
    const isNew = !brand.id;
    const error = window.cardStorage.saveBrand(brand);
    if (error) {
      window.app.showToast('❌ ' + error, 'error');
      return;
    }
    this.closeEditor();
    this.renderBrandList();
    window.app.showToast(isNew ? `✅ 已新增品牌：${brand.label.trim()}` : '✅ 品牌設定已儲存', 'success');
  }

  deleteBrand(id) {
    const brand = window.cardStorage.getBrand(id);
    if (!confirm(`確定要刪除品牌「${brand.label}」嗎？`)) return;
    const error = window.cardStorage.deleteBrand(id);
    if (error) {
      window.app.showToast('❌ ' + error, 'error');
      return;
    }
    if (window.cardScanner.brandId === id) window.cardScanner.setBrand(window.DEFAULT_BRAND);
    this.renderBrandList();
    window.app.showToast('🗑️ 品牌已刪除', 'info');
  }

  // ===== Firebase 雲端同步 =====

  async saveCloudConfig() {
    const input = document.getElementById('cloud-config-input');
    let config;
    try {
      config = window.cloudSync.parseConfig(input.value);
    } catch (err) {
      window.app.showToast('❌ ' + err.message, 'error');
      return;
    }
    window.cardStorage.saveSettings({ firebaseConfig: config });
    window.app.showToast('☁️ 已儲存 Firebase 設定，正在連線...', 'info');
    await window.cloudSync.init();
    this.renderCloudStatus();
  }

  async clearCloudConfig() {
    if (!confirm('清除 Firebase 設定並登出？(本機資料不會刪除)')) return;
    await window.cloudSync.signOut();
    window.cardStorage.saveSettings({ firebaseConfig: null });
    // Firebase SDK 初始化後無法換專案，重新整理最乾淨
    location.reload();
  }

  renderCloudStatus() {
    const cloud = window.cloudSync;
    const statusEl = document.getElementById('cloud-status-text');
    const configBox = document.getElementById('cloud-config-box');
    const authBox = document.getElementById('cloud-auth-box');
    if (!statusEl) return;

    const configured = cloud.isConfigured();
    const show = (id, visible) => {
      const el = document.getElementById(id);
      if (el) el.style.display = visible ? '' : 'none';
    };

    const configInput = document.getElementById('cloud-config-input');
    if (configured && configInput && !configInput.value) {
      configInput.value = JSON.stringify(window.cardStorage.settings.firebaseConfig, null, 2);
    }

    configBox.style.display = configured && cloud.user ? 'none' : '';
    authBox.style.display = configured && cloud.ready ? '' : 'none';
    show('btn-cloud-login', !cloud.user);
    show('btn-cloud-sync', Boolean(cloud.user));
    show('btn-cloud-logout', Boolean(cloud.user));

    let text;
    if (!configured) {
      text = '尚未設定。貼上 Firebase 專案設定後即可用 Google 帳號登入，跨裝置同步卡片。';
    } else if (!cloud.ready) {
      text = cloud.lastError ? `⚠️ 無法連線：${cloud.lastError}` : '正在連線 Firebase...';
    } else if (!cloud.user) {
      text = '已設定 Firebase，請登入以開始同步。';
    } else if (cloud.syncing) {
      text = `🔄 同步中...（${cloud.user.email}）`;
    } else {
      const when = cloud.lastSyncAt ? new Date(cloud.lastSyncAt).toLocaleString() : '尚未同步';
      text = `✅ 已登入 ${cloud.user.email}｜上次同步：${when}`;
    }
    if (cloud.ready && cloud.lastError && !cloud.syncing) text += `\n⚠️ ${cloud.lastError}`;
    statusEl.textContent = text;
  }
}

window.settingsPanel = new SettingsPanel();
