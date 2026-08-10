/**
 * 7-11 商品卡皮夾 - 主控制器與 UI 互動邏輯 (app.js)
 * 
 * 設計思路與技術亮點：
 * 1. 響應式事件中心：管理卡片清單渲染、即時搜尋、智慧排序與篩選分頁。
 * 2. 批次連續掃描整合：無縫串接相機模組，即時更新頂部統計儀表板與卡片庫。
 * 3. 備份與還原管理：提供一鍵 JSON / CSV 下載與檔案匯入。
 * 4. 友善 Toast 彈窗與觸控優化：隨時提供清晰操作反饋。
 */

class AppController {
  constructor() {
    this.currentFilter = 'all'; // 'all' | 'active' | 'depleted'
    this.currentSort = 'newest'; // 'newest' | 'balance-desc' | 'balance-asc' | 'facevalue'
    this.searchQuery = '';
    this.isAppReady = false;
  }

  async init() {
    // 1. 初始化儲存模組
    await window.cardStorage.init();

    // 2. 綁定所有 DOM 事件
    this.bindEvents();

    // 3. 初始畫面渲染
    this.refreshUI();
    this.isAppReady = true;

    // 4. 註冊 Service Worker 實現離線使用
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js')
        .then(() => console.log('[PWA] Service Worker 註冊成功'))
        .catch(err => console.warn('[PWA] Service Worker 註冊失敗:', err));
    }
  }

  // 綁定所有按鈕與互動事件
  bindEvents() {
    // 篩選標籤切換
    document.querySelectorAll('.filter-tab').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentFilter = btn.dataset.filter;
        this.renderCardList();
      });
    });

    // 排序選擇
    const sortSelect = document.getElementById('sort-select');
    if (sortSelect) {
      sortSelect.addEventListener('change', (e) => {
        this.currentSort = e.target.value;
        this.renderCardList();
      });
    }

    // 搜尋輸入框
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.searchQuery = e.target.value.trim().toLowerCase();
        this.renderCardList();
      });
    }

    // 開啟批次掃描相機按鈕
    const startScanBtn = document.getElementById('btn-start-scan');
    if (startScanBtn) {
      startScanBtn.addEventListener('click', () => this.openScannerModal());
    }

    // 關閉相機掃描
    const closeScanBtn = document.getElementById('btn-close-scanner');
    if (closeScanBtn) {
      closeScanBtn.addEventListener('click', () => this.closeScannerModal());
    }

    // 掃描預設面額標籤按鈕 (50, 100, 200, 500)
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

    // 手電筒補光按鈕
    const torchBtn = document.getElementById('btn-torch');
    if (torchBtn) {
      torchBtn.addEventListener('click', async () => {
        const isOn = await window.cardScanner.toggleTorch();
        torchBtn.classList.toggle('active', isOn);
        this.showToast(isOn ? '💡 補光燈已開啟' : '💡 補光燈已關閉', 'info');
      });
    }

    // 上傳圖片掃描按鈕
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

    // 手動輸入卡號按鈕
    const manualAddBtn = document.getElementById('btn-manual-add');
    if (manualAddBtn) {
      manualAddBtn.addEventListener('click', () => this.openManualAddModal());
    }

    // 備份與資料管理按鈕
    const backupBtn = document.getElementById('btn-open-backup');
    if (backupBtn) {
      backupBtn.addEventListener('click', () => this.openBackupModal());
    }

    // 關閉條碼出示彈窗
    const closeDetailBtn = document.getElementById('btn-close-detail');
    if (closeDetailBtn) {
      closeDetailBtn.addEventListener('click', () => window.barcodePresenter.closeModal());
    }

    // 扣款計算機按鈕
    document.querySelectorAll('.btn-quick-spend').forEach(btn => {
      btn.addEventListener('click', () => {
        const spend = Number(btn.dataset.amount);
        window.barcodePresenter.executeDeduct(spend);
      });
    });

    // 自訂金額扣款按鈕
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

    // 直接改餘額按鈕
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

    // 標記為已用完 ($0)
    const btnMarkDepleted = document.getElementById('btn-mark-depleted');
    if (btnMarkDepleted) {
      btnMarkDepleted.addEventListener('click', () => {
        if (confirm('確定要將此卡片標記為已用完 (餘額設為 0) 嗎？')) {
          window.barcodePresenter.executeSetBalance(0);
        }
      });
    }

    // 刪除此卡片
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

    // 備份彈窗功能
    this.bindBackupEvents();
  }

  // 綁定備份與匯出入相關事件
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

  // 刷新整體畫面數據與清單
  refreshUI() {
    this.renderStats();
    this.renderCardList();
  }

  // 渲染頂部統計面板
  renderStats() {
    const stats = window.cardStorage.getStats();

    const totalBalanceEl = document.getElementById('stat-total-balance');
    const totalCountEl = document.getElementById('stat-total-count');
    const activeCountEl = document.getElementById('stat-active-count');
    const depletedCountEl = document.getElementById('stat-depleted-count');
    const todaySpentEl = document.getElementById('stat-today-spent');

    if (totalBalanceEl) totalBalanceEl.textContent = `$${stats.totalBalance.toLocaleString()}`;
    if (totalCountEl) totalCountEl.textContent = stats.totalCount;
    if (activeCountEl) activeCountEl.textContent = stats.activeCount;
    if (depletedCountEl) depletedCountEl.textContent = stats.depletedCount;
    if (todaySpentEl) todaySpentEl.textContent = `$${stats.todaySpent}`;
  }

  // 渲染卡片清單
  renderCardList() {
    const container = document.getElementById('cards-grid');
    if (!container) return;

    let cards = window.cardStorage.getCards();

    // 1. 篩選 (全部 / 使用中 / 已用完)
    if (this.currentFilter === 'active') {
      cards = cards.filter(c => c.balance > 0);
    } else if (this.currentFilter === 'depleted') {
      cards = cards.filter(c => c.balance <= 0);
    }

    // 2. 關鍵字搜尋
    if (this.searchQuery) {
      cards = cards.filter(c => 
        (c.code && c.code.toLowerCase().includes(this.searchQuery)) ||
        (c.name && c.name.toLowerCase().includes(this.searchQuery)) ||
        (c.note && c.note.toLowerCase().includes(this.searchQuery))
      );
    }

    // 3. 排序
    cards.sort((a, b) => {
      if (this.currentSort === 'newest') return new Date(b.updatedAt) - new Date(a.updatedAt);
      if (this.currentSort === 'balance-desc') return b.balance - a.balance;
      if (this.currentSort === 'balance-asc') return a.balance - b.balance;
      if (this.currentSort === 'facevalue') return b.faceValue - a.faceValue;
      return 0;
    });

    // 4. 空狀態處理
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

    // 5. 渲染卡片 HTML
    container.innerHTML = cards.map(card => {
      const isDepleted = card.balance <= 0;
      const formattedCode = window.barcodePresenter.formatCardCode(card.code);
      const percent = card.faceValue > 0 ? Math.min(100, Math.round((card.balance / card.faceValue) * 100)) : 0;

      return `
        <div class="card-item ${isDepleted ? 'card-depleted' : ''}" onclick="window.barcodePresenter.openModal('${card.id}')">
          <div class="card-top-stripe"></div>
          
          <div class="card-header-row">
            <div class="card-title-group">
              <span class="card-brand-badge">7-11</span>
              <span class="card-name-text">${this.escapeHTML(card.name)}</span>
            </div>
            <span class="card-status-pill ${isDepleted ? 'status-depleted' : 'status-active'}">
              ${isDepleted ? '已用完' : '使用中'}
            </span>
          </div>

          <div class="card-code-display">
            <span class="code-digits">${formattedCode}</span>
          </div>

          <!-- 條碼縮圖外觀 -->
          <div class="card-barcode-preview">
            <svg class="mini-barcode-svg" data-code="${card.code}" height="38"></svg>
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

    // 渲染卡片內的迷你條碼
    setTimeout(() => {
      container.querySelectorAll('.mini-barcode-svg').forEach(svg => {
        const code = svg.dataset.code;
        window.barcodePresenter.renderBarcode(svg, code);
      });
    }, 50);
  }

  // 開啟相機掃描彈窗
  async openScannerModal() {
    const modal = document.getElementById('scanner-modal');
    if (!modal) return;

    modal.classList.add('active');
    document.body.style.overflow = 'hidden';

    const liveCountEl = document.getElementById('scanner-live-count');
    if (liveCountEl) liveCountEl.textContent = '0';

    const trayEl = document.getElementById('scanner-recent-tray');
    if (trayEl) trayEl.innerHTML = '<div class="tray-placeholder">對準條碼即可自動連續掃入...</div>';

    try {
      this.showToast('📷 正在啟動相機鏡頭...', 'info');
      await window.cardScanner.start(
        'scanner-reader',
        (result) => this.handleScanResult(result),
        (err) => console.log('掃描中幀錯 (略過):', err)
      );
    } catch (e) {
      this.showToast('❌ 無法開啟相機：' + (e.message || '請確認已授予相機權限'), 'error');
    }
  }

  // 處理相機即時掃描結果
  handleScanResult(res) {
    const liveCountEl = document.getElementById('scanner-live-count');
    const trayEl = document.getElementById('scanner-recent-tray');

    if (res.status === 'success') {
      if (liveCountEl) liveCountEl.textContent = res.batchCount;

      // 在底部預覽列滑入新卡片標籤
      if (trayEl) {
        const placeholder = trayEl.querySelector('.tray-placeholder');
        if (placeholder) placeholder.remove();

        const pill = document.createElement('div');
        pill.className = 'scanned-mini-card animate-slide-in';
        pill.innerHTML = `
          <span class="scanned-code">...${res.code.slice(-6)}</span>
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

  // 關閉相機掃描彈窗
  async closeScannerModal() {
    const modal = document.getElementById('scanner-modal');
    if (modal) modal.classList.remove('active');
    document.body.style.overflow = '';
    await window.cardScanner.stop();
    this.refreshUI();
  }

  // 開啟手動新增卡片彈窗
  openManualAddModal() {
    const code = prompt('請輸入或貼上 7-11 商品卡條碼：');
    if (!code || !code.trim()) return;

    const faceVal = prompt('請輸入該卡片面額 (預設 100)：', '100');
    const numFaceVal = Number(faceVal) || 100;

    window.cardStorage.addCard({
      code: code.trim(),
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

  // 開啟備份資料彈窗
  openBackupModal() {
    const modal = document.getElementById('backup-modal');
    if (modal) {
      modal.classList.add('active');
      document.body.style.overflow = 'hidden';
    }
  }

  // 關閉備份資料彈窗
  closeBackupModal() {
    const modal = document.getElementById('backup-modal');
    if (modal) modal.classList.remove('active');
    document.body.style.overflow = '';
  }

  // 下載檔案輔助工具
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

  // 顯示 Toast 浮動提示
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

  // 簡易 HTML 轉義防止 XSS
  escapeHTML(str) {
    return String(str || '').replace(/[&<>'"]/g, 
      tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );
  }
}

// 實例化並在 DOMContentLoaded 時啟動
window.app = new AppController();
document.addEventListener('DOMContentLoaded', () => {
  window.app.init();
});
