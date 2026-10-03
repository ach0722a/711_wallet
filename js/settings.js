/**
 * 7-11 商品卡皮夾 - 設定頁 (settings.js)
 *
 * 1. 通路品牌管理：新增 / 編輯 / 刪除品牌，設定單段或雙段、條碼檢查規則。
 *    規則用按鈕選 (字元種類 + 長度)，存檔時轉成正規表示式字串，所以資料格式與掃描器不用改。
 *    掃描器與手動輸入都只讀這裡的設定，不再寫死 7-11 格式。
 * 2. Firebase 雲端同步：貼上專案設定、Google 登入 / 登出、立即同步。
 */

// 字元種類 ➔ 正規表示式片段
const RULE_CHARS = {
  any:    { label: '不限',       re: '.' },
  digits: { label: '純數字',     re: '\\d' },
  alnum:  { label: '英文 + 數字', re: '[A-Za-z0-9]' }
};
const RULE_LENGTHS = { any: '不限', fixed: '固定', range: '範圍' };

// 選項 ➔ 規則字串。字元與長度都不限時回傳空字串 (不檢查)
function buildPattern(rule) {
  if (rule.chars === 'any' && rule.len === 'any') return '';
  const cls = RULE_CHARS[rule.chars].re;
  let q = '+';
  if (rule.len === 'fixed') q = `{${rule.fixed}}`;
  if (rule.len === 'range') q = `{${Math.min(rule.min, rule.max)},${Math.max(rule.min, rule.max)}}`;
  return `^${cls}${q}$`;
}

// 規則字串 ➔ 選項。認不出來的 (例如舊版手寫的) 回傳 null
function parsePattern(pattern) {
  const base = { chars: 'any', len: 'any', fixed: 8, min: 10, max: 24 };
  if (!pattern) return base;
  const m = /^\^(\\d|\[A-Za-z0-9\]|\.)(\+|\{(\d+)\}|\{(\d+),(\d+)\})\$$/.exec(pattern);
  if (!m) return null;
  const chars = Object.keys(RULE_CHARS).find(k => RULE_CHARS[k].re === m[1]);
  if (m[3]) return { ...base, chars, len: 'fixed', fixed: Number(m[3]) };
  if (m[4]) return { ...base, chars, len: 'range', min: Number(m[4]), max: Number(m[5]) };
  return { ...base, chars };
}

// 規則字串 ➔ 給人看的說明，例如「純數字・10~24 碼」
function describePattern(pattern) {
  const rule = parsePattern(pattern);
  if (!rule) return `自訂規則 ${pattern}`;
  if (rule.chars === 'any' && rule.len === 'any') return '不檢查';
  const len = rule.len === 'fixed' ? `${rule.fixed} 碼`
    : rule.len === 'range' ? `${Math.min(rule.min, rule.max)}~${Math.max(rule.min, rule.max)} 碼` : '長度不限';
  return `${rule.chars === 'any' ? '任何字元' : RULE_CHARS[rule.chars].label}・${len}`;
}

class SettingsPanel {
  constructor() {
    // 兩段規則各自的按鈕狀態；custom 不為 null 代表是認不出的舊規則，原樣保留
    this.rules = { 1: null, 2: null };
  }

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
    ['brand-field-test', 'brand-field-uppercase'].forEach(id => {
      on(id, 'input', () => this.updateTestResult());
    });

    // 條碼段數按鈕
    document.querySelectorAll('#brand-editor .chip-group[data-target]').forEach(group => {
      group.addEventListener('click', (e) => {
        const btn = e.target.closest('.chip-btn');
        if (!btn) return;
        document.getElementById(group.dataset.target).value = btn.dataset.value;
        this.updateEditorVisibility();
        this.updateTestResult();
      });
    });

    // 規則按鈕 (事件委派，按鈕是動態畫的)
    [1, 2].forEach(n => {
      on(`rule-builder-${n}`, 'click', (e) => {
        const btn = e.target.closest('button[data-rule]');
        if (!btn) return;
        const rule = this.rules[n];
        if (btn.dataset.rule === 'reset') {
          this.rules[n] = parsePattern('');
        } else {
          rule[btn.dataset.rule] = btn.dataset.value;
        }
        this.renderRuleBuilder(n);
      });
      on(`rule-builder-${n}`, 'input', (e) => {
        const input = e.target.closest('input[data-rule]');
        if (!input) return;
        this.rules[n][input.dataset.rule] = Math.max(1, Math.min(99, Number(input.value) || 1));
        this.syncRule(n);
      });
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
    on('btn-cloud-sync', 'click', async () => {
      if (window.cloudSync.syncing) {
        window.app.showToast('🔄 正在同步，請稍候...', 'info');
        return;
      }
      await window.cloudSync.syncNow();
      const err = window.cloudSync.lastError;
      window.app.showToast(err ? '❌ 同步失敗：' + err : '✅ 同步完成', err ? 'error' : 'success');
    });

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
        ? `兩段｜① ${esc(describePattern(b.code1Pattern))}　② ${esc(describePattern(b.code2Pattern))}`
        : `一段｜${esc(describePattern(b.code1Pattern))}`;
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
    [1, 2].forEach(n => {
      const pattern = brand[`code${n}Pattern`] || '';
      this.rules[n] = parsePattern(pattern) || { ...parsePattern(''), custom: pattern };
      this.renderRuleBuilder(n);
    });
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
    const mode = document.getElementById('brand-field-mode').value;
    const isDual = mode === 'dual';
    document.querySelectorAll('#brand-editor .chip-group[data-target="brand-field-mode"] .chip-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.value === mode);
    });
    document.getElementById('rule-builder-2').style.display = isDual ? '' : 'none';
    document.getElementById('rule-builder-1-title').textContent = isDual ? '第一段 (卡號) 格式' : '條碼格式';
  }

  // 畫出某一段的規則按鈕
  renderRuleBuilder(n) {
    const box = document.getElementById(`rule-builder-${n}`);
    const rule = this.rules[n];
    const title = box.querySelector('.rule-builder-title').outerHTML;
    const chip = (key, value, label) =>
      `<button type="button" class="chip-btn ${rule[key] === value ? 'active' : ''}" data-rule="${key}" data-value="${value}">${label}</button>`;
    const num = (key) => `<input type="number" class="settings-input rule-num" min="1" max="99" inputmode="numeric" data-rule="${key}" value="${rule[key]}">`;

    if (rule.custom) {
      box.innerHTML = `${title}
        <div class="settings-hint">這是之前手動寫的進階規則：<code>${window.app.escapeHTML(rule.custom)}</code></div>
        <button type="button" class="btn-settings-small" data-rule="reset">改用按鈕選擇</button>`;
    } else {
      box.innerHTML = `${title}
        <div class="rule-row"><span class="rule-label">字元</span>
          <div class="chip-group">${Object.keys(RULE_CHARS).map(k => chip('chars', k, RULE_CHARS[k].label)).join('')}</div>
        </div>
        <div class="rule-row"><span class="rule-label">長度</span>
          <div class="chip-group">${Object.keys(RULE_LENGTHS).map(k => chip('len', k, RULE_LENGTHS[k])).join('')}</div>
        </div>
        ${rule.len === 'fixed' ? `<div class="rule-row"><span class="rule-label"></span>剛好 ${num('fixed')} 碼</div>` : ''}
        ${rule.len === 'range' ? `<div class="rule-row"><span class="rule-label"></span>${num('min')} ~ ${num('max')} 碼</div>` : ''}
        <div class="settings-hint rule-summary"></div>`;
    }
    this.syncRule(n);
  }

  // 按鈕狀態 ➔ 隱藏欄位的規則字串，並更新說明與測試結果
  syncRule(n) {
    const rule = this.rules[n];
    const pattern = rule.custom || buildPattern(rule);
    document.getElementById(`brand-field-code${n}`).value = pattern;
    const summary = document.querySelector(`#rule-builder-${n} .rule-summary`);
    if (summary) summary.textContent = pattern ? `→ ${describePattern(pattern)}` : '→ 不檢查，任何條碼都收';
    this.updateTestResult();
  }

  // 即時測試：貼上一個條碼，顯示它會被當成第一段、第二段還是被忽略
  updateTestResult() {
    const out = document.getElementById('brand-test-result');
    const test = document.getElementById('brand-field-test').value;
    if (!out) return;
    out.textContent = this.dualRuleWarning();

    const brand = this.readEditor();
    const storage = window.cardStorage;
    if (!test.trim()) return;
    for (const key of ['code1Pattern', 'code2Pattern']) {
      try {
        if (brand[key]) new RegExp(brand[key]);
      } catch (e) {
        out.textContent = `⚠️ 規則格式錯誤：${brand[key]}`;
        return;
      }
    }

    const code = storage.normalizeCode(brand, test);
    const isDual = brand.mode === 'dual';
    let result;
    if (storage.matchesCode1(brand, code)) {
      result = `✅ 「${code}」符合${isDual ? '第一段 (卡號)' : ''}格式`;
    } else if (isDual && storage.matchesCode2(brand, code)) {
      result = `✅ 「${code}」符合第二段 (檢核碼) 格式`;
    } else {
      result = `❌ 「${code}」不符合格式，掃描時會被忽略`;
    }
    out.textContent = [result, out.textContent].filter(Boolean).join('\n');
  }

  // 兩段時，第一段規則若會吃下所有條碼，第二段永遠不會被認出來
  dualRuleWarning() {
    const brand = this.readEditor();
    if (brand.mode !== 'dual') return '';
    if (!brand.code1Pattern) return '⚠️ 兩段模式下，第一段要設格式，不然所有條碼都會被當成卡號';
    if (brand.code1Pattern === brand.code2Pattern) return '⚠️ 兩段的格式一樣，系統會分不出哪個是卡號、哪個是檢核碼';
    return '';
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

    // 已內建專案設定，平常只需要登入按鈕；沒有設定時才顯示貼上欄位
    configBox.style.display = configured ? 'none' : '';
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
