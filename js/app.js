/**
 * 7-11 商品卡皮夾 - 主控制器與 UI 互動邏輯 (app.js)
 * 
 * 升級亮點：
 * 1. 支援「雙段條碼模式」與「單段條碼模式」一鍵切換。
 * 2. 掃描中步驟導引（錄完卡號提示掃檢核碼，並支援手動略過第二段）。
 * 3. 卡片清單與手動輸入均支援雙段條碼標註。
 */

class AppController {
  constructor() {
    this.currentFilter = 'all';
    this.currentSort = 'newest';
    this.searchQuery = '';
    this.isAppReady = false;
  }

  async init() {
    await window.cardStorage.init();
    this.bindEvents();
    this.refreshUI();
    this.isAppReady = true;

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js')
        .then(() => console.log('[PWA] Service Worker 註冊成功'))
        .catch(err => console.warn('[PWA] Service Worker 註冊失敗:', err));
    }
  }

  bindEvents() {
    // 篩選標籤
    document.querySelectorAll('.filter-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentFilter = btn.dataset.filter;
        this.renderCardList();
      });
    });

    // 排序
    const sortSelect = document.getElementById('sort-select');
    if (sortSelect) {
      sortSelect.addEventListener('change', (e) => {
        this.currentSort = e.target.value;
        this.renderCardList();
      });
    }

    // 搜尋
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.searchQuery = e.target.value.trim().toLowerCase();
        this.renderCardList();
      });
    }

    // 開啟掃描器
    const startScanBtn = document.getElementById('btn-start-scan');
    if (startScanBtn) {
      startScanBtn.addEventListener('click', () => this.openScannerModal());
    }

    // 關閉掃描器
    const closeScanBtn = document.getElementById('btn-close-scanner');
    if (closeScanBtn) {
      closeScanBtn.addEventListener('click', () => this.closeScannerModal());
    }

    // 模式切換：雙段條碼 vs 單段條碼
    document.querySelectorAll('.mode-toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.mode-toggle-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.dataset.mode;
        window.cardScanner.setScanMode(mode);
        this.updateScannerStepHint(mode === 'dual' ? '請對準第 1 段「卡號條碼」' : '對準條碼即可自動存入');
      });
    });

    // 略過第二段條碼按鈕
    const btnSkipStep2 = document.getElementById('btn-skip-step2');
    if (btnSkipStep2) {
      btnSkipStep2.addEventListener('click', () => {
        window.cardScanner.skipSecondBarcode((res) => this.handleScanResult(res));
      });
    }

    // 預設面額選擇
    document.querySelectorAll('.preset-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        document.querySelectorAll('.preset-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        const val = pill.dataset.value;
        if (val === 'custom') {
          const customVal = prompt('請輸入自訂預設面額 (元)：', '100');
          if (customVal && !isNaN(customVal)) {
            window.cardScanner.setFaceValue(Number(customVal));
            pill.textContent = `$${customVal}`;
          }
        } else {
          window.cardScanner.setFaceValue(Number(val));
        }
      });
    });

    // 手電筒補光
    const torchBtn = document.getElementById('btn-torch');
    if (torchBtn) {
      torchBtn.addEventListener('click', async () => {
        const isOn = await window.cardScanner.toggleTorch();
        torchBtn.classList.toggle('active', isOn);
        this.showToast(isOn ? '💡 補光燈已開啟' : '💡 補光燈已關閉', 'info');
      });
    }

    // 上傳圖片辨識
    const photoUploadInput = document.getElementById('input-photo-upload');
    if (photoUploadInput) {
      photoUploadInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          this.showToast('🔍 正在辨識圖片中的條碼...', 'info');
          await window.cardScanner.scanImageFile(file, (res) => {
            this.handleScanResult(res);
          });
        } catch (err) {
          this.showToast('❌ ' + err.message, 'error');
        }
        photoUploadInput.value = '';
      });
    }

    // 手動輸入卡號
    const manualAddBtn = document.getElementById('btn-manual-add');
    if (manualAddBtn) {
      manualAddBtn.addEventListener('click', () => this.openManualAddModal());
    }

    // 備份彈窗
    const backupBtn = document.getElementById('btn-open-backup');
    if (backupBtn) {
      backupBtn.addEventListener('click', () => this.openBackupModal());
    }

    // 關閉詳情彈窗
    const closeDetailBtn = document.getElementById('btn-close-detail');
    if (closeDetailBtn) {
      closeDetailBtn.addEventListener('click', () => window.barcodePresenter.closeModal());
    }

    // 快捷扣款按鈕
    document.querySelectorAll('.btn-quick-spend').forEach(btn => {
      btn.addEventListener('click', () => {
        const spend = Number(btn.dataset.amount);
        window.barcodePresenter.executeDeduct(spend);
      });
    });

    // 自訂金額扣款
    const btnCustomDeduct = document.getElementById('btn-custom-deduct');
    if (btnCustomDeduct) {
      btnCustomDeduct.addEventListener('click', () => {
        const input = document.getElementById('quick-spend-input');
        const val = input ? Number(input.value) : 0;
        if (val > 0) {
          window.barcodePresenter.executeDeduct(val);
        } else {
          this.showToast('請先輸入扣款金額', 'warning');
        }
      });
    }

    // 直接改餘額
    const btnEditBalanceDirect = document.getElementById('btn-edit-balance-direct');
    if (btnEditBalanceDirect) {
      btnEditBalanceDirect.addEventListener('click', () => {
        const current = window.barcodePresenter.currentCard;
        if (!current) return;
        const newBal = prompt(`修改「${current.name}」的目前餘額：`, current.balance);
        if (newBal !== null && !isNaN(newBal)) {
          window.barcodePresenter.executeSetBalance(Number(newBal));
        }
      });
    }

    // 標記已用完
    const btnMarkDepleted = document.getElementById('btn-mark-depleted');
    if (btnMarkDepleted) {
      btnMarkDepleted.addEventListener('click', () => {
        if (confirm('確定要將此卡片標記為已用完 (餘額設為 0) 嗎？')) {
          window.barcodePresenter.executeSetBalance(0);
        }
      });
    }

    // 刪除此卡
    const btnDeleteCurrentCard = document.getElementById('btn-delete-current-card');
    if (btnDeleteCurrentCard) {
      btnDeleteCurrentCard.addEventListener('click', async () => {
        const current = window.barcodePresenter.currentCard;
        if (!current) return;
        if (confirm(`確定要刪除「${current.name}」嗎？此動作無法復原。`)) {
          await window.cardStorage.deleteCard(current.id);
          window.barcodePresenter.closeModal();
          this.refreshUI();
          this.showToast('🗑️ 卡片已刪除', 'info');
        }
      });
    }

    this.bindBackupEvents();
  }

  bindBackupEvents() {
    const btnExportJSON = document.getElementById('btn-export-json');
    if (btnExportJSON) {
      btnExportJSON.addEventListener('click', () => {
        const dataStr = window.cardStorage.exportJSON();
        this.downloadFile(dataStr, `711_商品卡備份_${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
        this.showToast('💾 已下載 JSON 完整備份檔', 'success');
      });
    }

    const btnExportCSV = document.getElementById('btn-export-csv');
    if (btnExportCSV) {
      btnExportCSV.addEventListener('click', () => {
        const csvStr = window.cardStorage.exportCSV();
        this.downloadFile(csvStr, `711_商品卡清單_${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv;charset=utf-8;');
        this.showToast('📊 已下載 CSV Excel 檔案', 'success');
      });
    }

    const fileImportInput = document.getElementById('input-import-file');
    if (fileImportInput) {
      fileImportInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (event) => {
          try {
            const content = event.target.result;
            if (file.name.endsWith('.json')) {
              const res = await window.cardStorage.importJSON(content, 'merge');
              this.showToast(`✅ 成功匯入 ${res.count} 張卡片`, 'success');
            } else {
              const res = await window.cardStorage.importTextOrCSV(content);
              this.showToast(`✅ 成功匯入 ${res.added.length} 張卡片`, 'success');
            }
            this.refreshUI();
            this.closeBackupModal();
          } catch (err) {
            this.showToast('❌ 匯入失敗：' + err.message, 'error');
          }
        };
        reader.readAsText(file);
        fileImportInput.value = '';
      });
    }

    const btnCleanDepleted = document.getElementById('btn-clean-depleted');
    if (btnCleanDepleted) {
      btnCleanDepleted.addEventListener('click', async () => {
        if (confirm('確定要批次清理所有餘額為 0 的已用完卡片嗎？')) {
          const count = await window.cardStorage.deleteDepletedCards();
          this.refreshUI();
          this.showToast(`🧹 已清理 ${count} 張已用完卡片`, 'info');
        }
      });
    }
  }

  refreshUI() {
    this.renderStats();
    this.renderCardList();
  }

  renderStats() {
    const stats = window.cardStorage.getStats();

    const totalBalanceEl = document.getElementById('stat-total-balance');
    const totalCountEl = document.getElementById('stat-total-count');
    const activeCountEl = document.getElementById('stat-active-count');
    const todaySpentEl = document.getElementById('stat-today-spent');

    if (totalBalanceEl) totalBalanceEl.textContent = `$${stats.totalBalance.toLocaleString()}`;
    if (totalCountEl) totalCountEl.textContent = stats.totalCount;
    if (activeCountEl) activeCountEl.textContent = stats.activeCount;
    if (todaySpentEl) todaySpentEl.textContent = `$${stats.todaySpent}`;
  }

  renderCardList() {
    const container = document.getElementById('cards-grid');
    if (!container) return;

    let cards = window.cardStorage.getCards();

    if (this.currentFilter === 'active') {
      cards = cards.filter(c => c.balance > 0);
    } else if (this.currentFilter === 'depleted') {
      cards = cards.filter(c => c.balance <= 0);
    }

    if (this.searchQuery) {
      cards = cards.filter(c => 
        (c.code && c.code.toLowerCase().includes(this.searchQuery)) ||
        (c.code1 && c.code1.toLowerCase().includes(this.searchQuery)) ||
        (c.code2 && c.code2.toLowerCase().includes(this.searchQuery)) ||
        (c.name && c.name.toLowerCase().includes(this.searchQuery)) ||
        (c.note && c.note.toLowerCase().includes(this.searchQuery))
      );
    }

    cards.sort((a, b) => {
      if (this.currentSort === 'newest') return new Date(b.updatedAt) - new Date(a.updatedAt);
      if (this.currentSort === 'balance-desc') return b.balance - a.balance;
      if (this.currentSort === 'balance-asc') return a.balance - b.balance;
      if (this.currentSort === 'facevalue') return b.faceValue - a.faceValue;
      return 0;
    });

    if (cards.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">💳</div>
          <div class="empty-title">目前沒有符合的商品卡</div>
          <div class="empty-desc">${this.searchQuery ? '請嘗試更換搜尋關鍵字' : '點擊下方按鈕開始批次掃描或手動新增卡片！'}</div>
          <button class="btn-primary" onclick="window.app.openScannerModal()">⚡ 立即掃描卡片</button>
        </div>
      `;
      return;
    }

    container.innerHTML = cards.map(card => {
      const isDepleted = card.balance <= 0;
      const primaryCode = card.code1 || card.code;
      const formattedCode = window.barcodePresenter.formatCardCode(primaryCode);
      const percent = card.faceValue > 0 ? Math.min(100, Math.round((card.balance / card.faceValue) * 100)) : 0;
      const isDual = Boolean(card.code2);

      return `
        <div class="card-item ${isDepleted ? 'card-depleted' : ''}" onclick="window.barcodePresenter.openModal('${card.id}')">
          <div class="card-top-stripe"></div>
          
          <div class="card-header-row">
            <div class="card-title-group">
              <span class="card-brand-badge">7-11</span>
              <span class="card-name-text">${this.escapeHTML(card.name)}</span>
              ${isDual ? '<span class="badge-dual-tag">雙段條碼</span>' : ''}
            </div>
            <span class="card-status-pill ${isDepleted ? 'status-depleted' : 'status-active'}">
              ${isDepleted ? '已用完' : '使用中'}
            </span>
          </div>

          <div class="card-code-display">
            <span class="code-digits">${formattedCode}</span>
            ${card.code2 ? `<span class="code-sub-badge">檢核: ${card.code2}</span>` : ''}
          </div>

          <div class="card-barcode-preview">
            <svg class="mini-barcode-svg" data-code="${primaryCode}" height="36"></svg>
          </div>

          <div class="card-balance-row">
            <div class="balance-info">
              <span class="balance-label">剩餘餘額</span>
              <span class="balance-value ${isDepleted ? 'text-depleted' : 'text-active'}">$${card.balance}</span>
            </div>
            <div class="facevalue-info">
              <span class="facevalue-label">原面額 $${card.faceValue}</span>
              <div class="balance-bar-container">
                <div class="balance-bar-fill" style="width: ${percent}%;"></div>
              </div>
            </div>
          </div>

          <div class="card-action-bar">
            <button class="btn-card-action btn-show-barcode" onclick="event.stopPropagation(); window.barcodePresenter.openModal('${card.id}')">
              📱 出示條碼 / 扣款
            </button>
          </div>
        </div>
      `;
    }).join('');

    setTimeout(() => {
      container.querySelectorAll('.mini-barcode-svg').forEach(svg => {
        const code = svg.dataset.code;
        window.barcodePresenter.renderBarcode(svg, code, 'CODE128', 36);
      });
    }, 50);
  }

  async openScannerModal() {
    const modal = document.getElementById('scanner-modal');
    if (!modal) return;

    modal.classList.add('active');
    document.body.style.overflow = 'hidden';

    const liveCountEl = document.getElementById('scanner-live-count');
    if (liveCountEl) liveCountEl.textContent = '0';

    this.updateScannerStepHint('請對準第 1 段「卡號條碼」');

    const trayEl = document.getElementById('scanner-recent-tray');
    if (trayEl) trayEl.innerHTML = '<div class="tray-placeholder">對準條碼即可自動連續掃入...</div>';

    try {
      this.showToast('📷 正在啟動相機鏡頭...', 'info');
      await window.cardScanner.start(
        'scanner-reader',
        (result) => this.handleScanResult(result),
        () => {}
      );
    } catch (e) {
      this.showToast('❌ 無法開啟相機：' + (e.message || '請確認已授予相機權限'), 'error');
    }
  }

  updateScannerStepHint(text, isStep2 = false) {
    const hintEl = document.getElementById('scanner-step-hint');
    const skipBtn = document.getElementById('btn-skip-step2');
    if (hintEl) {
      hintEl.textContent = text;
      hintEl.classList.toggle('step2-active', isStep2);
    }
    if (skipBtn) {
      skipBtn.style.display = isStep2 ? 'inline-block' : 'none';
    }
  }

  handleScanResult(res) {
    const liveCountEl = document.getElementById('scanner-live-count');
    const trayEl = document.getElementById('scanner-recent-tray');

    if (res.status === 'step1_done') {
      this.updateScannerStepHint('📍 已讀取卡號！請接著對準「第 2 段檢核碼」', true);
      this.showToast(res.message, 'info');
    } else if (res.status === 'success') {
      if (liveCountEl) liveCountEl.textContent = res.batchCount;
      this.updateScannerStepHint(window.cardScanner.scanMode === 'dual' ? '請對準下一張的第 1 段「卡號條碼」' : '對準條碼即可自動存入', false);

      if (trayEl) {
        const placeholder = trayEl.querySelector('.tray-placeholder');
        if (placeholder) placeholder.remove();

        const pill = document.createElement('div');
        pill.className = 'scanned-mini-card animate-slide-in';
        const displayCode = res.card.code1 || res.card.code;
        pill.innerHTML = `
          <span class="scanned-code">...${displayCode.slice(-6)}</span>
          ${res.card.code2 ? '<span class="badge-mini-dual">雙段</span>' : ''}
          <span class="scanned-val">+$${res.card.faceValue}</span>
        `;
        trayEl.prepend(pill);
      }

      this.showToast(res.message, 'success');
      this.refreshUI();
    } else if (res.status === 'duplicate') {
      this.showToast(res.message, 'warning');
    }
  }

  async closeScannerModal() {
    const modal = document.getElementById('scanner-modal');
    if (modal) modal.classList.remove('active');
    document.body.style.overflow = '';
    await window.cardScanner.stop();
    this.refreshUI();
  }

  openManualAddModal() {
    const code1 = prompt('【第一段】請輸入 7-11 商品卡主卡號條碼：');
    if (!code1 || !code1.trim()) return;

    const code2 = prompt('【第二段】請輸入檢核碼條碼 (若無可留空)：', '');
    const faceVal = prompt('請輸入該卡片面額 (預設 100)：', '100');
    const numFaceVal = Number(faceVal) || 100;

    window.cardStorage.addCard({
      code1: code1.trim(),
      code2: code2 ? code2.trim() : '',
      faceValue: numFaceVal,
      balance: numFaceVal,
      note: '手動輸入新增'
    }).then(newCard => {
      this.refreshUI();
      this.showToast(`✅ 已新增：${newCard.name} ($${newCard.faceValue})`, 'success');
    }).catch(err => {
      this.showToast('❌ 新增失敗：' + err.message, 'error');
    });
  }

  openBackupModal() {
    const modal = document.getElementById('backup-modal');
    if (modal) {
      modal.classList.add('active');
      document.body.style.overflow = 'hidden';
    }
  }

  closeBackupModal() {
    const modal = document.getElementById('backup-modal');
    if (modal) modal.classList.remove('active');
    document.body.style.overflow = '';
  }

  downloadFile(content, fileName, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  showToast(message, type = 'info') {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast-pill toast-${type} animate-toast`;
    toast.textContent = message;

    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('toast-fadeout');
      setTimeout(() => toast.remove(), 300);
    }, 2800);
  }

  escapeHTML(str) {
    return String(str || '').replace(/[&<>'"]/g, 
      tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );
  }
}

window.app = new AppController();
document.addEventListener('DOMContentLoaded', () => {
  window.app.init();
});
