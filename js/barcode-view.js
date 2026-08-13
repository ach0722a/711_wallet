/**
 * 7-11 商品卡皮夾 - 條碼出示與實體照片管理模組 (barcode-view.js - v4 極簡純淨版)
 * 
 * 修改思路與設計重點：
 * 1. 移除所有「給店員確認/請店員掃描」等突兀贅字，回歸超商官方卡片的極簡純淨版面。
 * 2. 支援「純淨數位條碼」與「實體卡片照片」雙模式一鍵切換：
 *    - 數位條碼：高對比純黑向量條碼 + 簡潔卡號字體，POS 掃描槍秒讀。
 *    - 實體照片：直接出示當初拍攝的商品卡真實背面照片（店員若有疑慮可直接刷照片）。
 * 3. 支援一鍵拍照上傳/替換實體商品卡照片。
 */

class BarcodePresenter {
  constructor() {
    this.currentCard = null;
    this.currentTab = 'barcode'; // 'barcode' | 'photo'
    this.wakeLock = null;
  }

  async requestWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        this.wakeLock = await navigator.wakeLock.request('screen');
      } catch (err) {}
    }
  }

  releaseWakeLock() {
    if (this.wakeLock) {
      this.wakeLock.release().then(() => {
        this.wakeLock = null;
      }).catch(console.warn);
    }
  }

  // 繪製向量條碼 (保持乾淨銳利)
  renderBarcode(svgElementOrSelector, code, format = 'CODE128', height = 65) {
    const el = typeof svgElementOrSelector === 'string' 
      ? document.querySelector(svgElementOrSelector) 
      : svgElementOrSelector;

    if (!el || !code) return;

    try {
      if (typeof JsBarcode !== 'undefined') {
        JsBarcode(el, String(code).trim(), {
          format: 'CODE128',
          lineColor: '#000000',
          width: 2.1,
          height: height,
          displayValue: false,
          margin: 6,
          background: '#ffffff'
        });
      } else {
        this.renderFallbackBarcode(el, code, height);
      }
    } catch (e) {
      this.renderFallbackBarcode(el, code, height);
    }
  }

  renderFallbackBarcode(svgEl, code, height = 65) {
    const cleanCode = String(code).trim();
    let rects = '';
    let x = 8;
    for (let i = 0; i < cleanCode.length; i++) {
      const charCode = cleanCode.charCodeAt(i);
      const w1 = (charCode % 3) + 1.8;
      const w2 = ((charCode >> 1) % 2) + 1.2;
      rects += `<rect x="${x}" y="0" width="${w1}" height="${height}" fill="#000"/>`;
      x += w1 + w2;
      rects += `<rect x="${x}" y="0" width="${w2 * 1.5}" height="${height}" fill="#000"/>`;
      x += w2 * 1.5 + 2;
    }
    svgEl.setAttribute('viewBox', `0 0 ${Math.max(x + 8, 240)} ${height}`);
    svgEl.innerHTML = `<rect width="100%" height="100%" fill="#fff"/>${rects}`;
  }

  // 開啟卡片詳情
  openModal(cardId) {
    const card = window.cardStorage.getCard(cardId);
    if (!card) return;

    this.currentCard = card;
    this.currentTab = 'barcode';
    this.requestWakeLock();

    const modal = document.getElementById('card-detail-modal');
    if (!modal) return;

    const isItem = card.cardType === 'item';

    // 卡片名稱與編輯提示
    document.getElementById('modal-card-name').textContent = card.name || (isItem ? '商品兌換券' : '7-ELEVEN 商品卡');
    
    // 狀態標籤
    const badgeEl = document.getElementById('modal-card-status-badge');
    if (badgeEl) {
      if (isItem) {
        badgeEl.textContent = card.isRedeemed ? '已使用' : '未兌換 (可出示)';
        badgeEl.className = `status-badge ${card.isRedeemed ? 'badge-depleted' : 'badge-active'}`;
      } else {
        badgeEl.textContent = card.balance > 0 ? '使用中' : '已用完';
        badgeEl.className = `status-badge ${card.balance > 0 ? 'badge-active' : 'badge-depleted'}`;
      }
    }

    // 金額面板 vs 商品券兌換面板切換
    const balancePanel = document.getElementById('modal-balance-panel');
    const itemActionPanel = document.getElementById('modal-item-action-panel');
    const moneyDeductBox = document.getElementById('modal-deduct-calculator');

    if (isItem) {
      if (balancePanel) balancePanel.style.display = 'none';
      if (moneyDeductBox) moneyDeductBox.style.display = 'none';
      if (itemActionPanel) {
        itemActionPanel.style.display = 'block';
        const toggleBtn = document.getElementById('btn-toggle-item-redeem');
        if (toggleBtn) {
          toggleBtn.textContent = card.isRedeemed ? '🔄 重新標記為【未使用】' : '🔘 標記此商品為【已使用】';
          toggleBtn.className = `btn-redeem-action ${card.isRedeemed ? 'btn-redeemed-undo' : 'btn-redeemed-do'}`;
        }
      }
    } else {
      if (balancePanel) balancePanel.style.display = 'block';
      if (moneyDeductBox) moneyDeductBox.style.display = 'block';
      if (itemActionPanel) itemActionPanel.style.display = 'none';

      document.getElementById('modal-card-balance').textContent = card.balance;
      document.getElementById('modal-card-facevalue').textContent = card.faceValue;
    }

    // 渲染出示面板 (純淨條碼 or 實體照片)
    this.renderPresenterContent();

    // 渲染歷史紀錄
    this.renderHistoryList(card.history || []);

    const spendInput = document.getElementById('quick-spend-input');
    if (spendInput) spendInput.value = '';

    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  // 彈出修改卡片/商品名稱對話框
  promptRename() {
    if (!this.currentCard) return;
    const oldName = this.currentCard.name || '';
    const newName = prompt('請輸入新的卡片/商品名稱 (例如：大杯熱拿鐵、100元禮券)：', oldName);
    if (newName !== null && newName.trim() && newName.trim() !== oldName) {
      window.cardStorage.renameCard(this.currentCard.id, newName.trim()).then(updated => {
        this.currentCard = updated;
        document.getElementById('modal-card-name').textContent = updated.name;
        window.app?.refreshUI();
        window.app?.showToast(`✏️ 名稱已更新為：「${updated.name}」`, 'success');
      });
    }
  }

  // 點擊切換商品兌換狀態
  async toggleCurrentItemRedeem() {
    if (!this.currentCard) return;
    const updated = await window.cardStorage.toggleRedeem(this.currentCard.id);
    this.currentCard = updated;
    this.openModal(updated.id);
    window.app?.refreshUI();
    window.app?.showToast(updated.isRedeemed ? '✅ 已標記為【已使用】' : '↩️ 已恢復為【未使用】', 'info');
  }

  // 切換出示模式 (條碼 / 照片)
  switchTab(tab) {
    this.currentTab = tab;
    this.renderPresenterContent();
  }

  // 渲染出示專區內容 (極簡乾淨、無任何多餘提示文字)
  renderPresenterContent() {
    const container = document.getElementById('modal-barcode-container');
    if (!container || !this.currentCard) return;

    const card = this.currentCard;
    const code1 = card.code1 || card.code;
    const code2 = card.code2;
    const hasPhoto = Boolean(card.photoUrl);

    // 頂部模式切換 Tabs (數位條碼 / 實體卡照片)
    const tabHtml = `
      <div class="presenter-tab-switch">
        <button class="presenter-tab-btn ${this.currentTab === 'barcode' ? 'active' : ''}" onclick="window.barcodePresenter.switchTab('barcode')">
          📊 數位條碼
        </button>
        <button class="presenter-tab-btn ${this.currentTab === 'photo' ? 'active' : ''}" onclick="window.barcodePresenter.switchTab('photo')">
          📷 實體卡照片 ${hasPhoto ? '✔' : ''}
        </button>
      </div>
    `;

    if (this.currentTab === 'photo') {
      // ==========================================
      // 實體照片模式 (顯示真實拍攝的卡片背面)
      // ==========================================
      if (hasPhoto) {
        container.innerHTML = `
          ${tabHtml}
          <div class="card-photo-wrapper">
            <img src="${card.photoUrl}" class="card-real-photo" alt="商品卡照片" onclick="window.barcodePresenter.previewPhotoFull('${card.photoUrl}')">
          </div>
          <div class="photo-action-row">
            <label class="btn-retake-photo" style="cursor: pointer;">
              🔄 重拍/更換照片
              <input type="file" accept="image/*" capture="environment" style="display:none;" onchange="window.barcodePresenter.handlePhotoUpload(event)">
            </label>
          </div>
        `;
      } else {
        container.innerHTML = `
          ${tabHtml}
          <div class="card-photo-empty">
            <div style="font-size: 32px; margin-bottom: 8px;">📷</div>
            <div style="font-size: 13px; color: #64748b; margin-bottom: 12px;">尚未拍攝此卡片的實體照片</div>
            <label class="btn-primary" style="cursor: pointer; display: inline-block; padding: 8px 18px; font-size: 13px;">
              📸 立即拍照存入
              <input type="file" accept="image/*" capture="environment" style="display:none;" onchange="window.barcodePresenter.handlePhotoUpload(event)">
            </label>
          </div>
        `;
      }
    } else {
      // ==========================================
      // 數位條碼模式 (純淨高對比、無贅字)
      // ==========================================
      if (code2) {
        // 雙段條碼
        container.innerHTML = `
          ${tabHtml}
          <div class="clean-barcode-card">
            <!-- 第一段條碼 -->
            <div class="clean-barcode-row">
              <svg id="modal-barcode-svg-1" class="clean-svg"></svg>
              <div class="clean-digits">${this.formatCardCode(code1)}</div>
            </div>

            <div class="clean-barcode-sep"></div>

            <!-- 第二段條碼 -->
            <div class="clean-barcode-row">
              <svg id="modal-barcode-svg-2" class="clean-svg"></svg>
              <div class="clean-digits">${this.formatCardCode(code2)}</div>
            </div>
          </div>
        `;
        setTimeout(() => {
          this.renderBarcode('#modal-barcode-svg-1', code1, card.format, 58);
          this.renderBarcode('#modal-barcode-svg-2', code2, card.format, 58);
        }, 30);
      } else {
        // 單段條碼
        container.innerHTML = `
          ${tabHtml}
          <div class="clean-barcode-card">
            <div class="clean-barcode-row">
              <svg id="modal-barcode-svg-single" class="clean-svg"></svg>
              <div class="clean-digits">${this.formatCardCode(code1)}</div>
            </div>
          </div>
        `;
        setTimeout(() => {
          this.renderBarcode('#modal-barcode-svg-single', code1, card.format, 78);
        }, 30);
      }
    }
  }

  // 處理拍照或選擇圖片上傳
  async handlePhotoUpload(e) {
    const file = e.target.files[0];
    if (!file || !this.currentCard) return;

    window.app?.showToast('📸 正在儲存卡片照片...', 'info');

    // 將圖片轉換為壓縮的 Base64 DataURL (限制寬度 1200px 節省容量)
    const dataUrl = await this.compressImage(file, 1200, 0.82);
    
    const updated = await window.cardStorage.updateCard(this.currentCard.id, {
      photoUrl: dataUrl,
      preferredView: 'photo'
    });

    this.currentCard = updated;
    this.currentTab = 'photo';
    this.renderPresenterContent();
    window.app?.refreshUI();
    window.app?.showToast('✅ 卡片照片已成功儲存！', 'success');
  }

  // 壓縮圖片工具函式
  compressImage(file, maxWidth = 1200, quality = 0.82) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let w = img.width;
          let h = img.height;
          if (w > maxWidth) {
            h = Math.round((h * maxWidth) / w);
            w = maxWidth;
          }
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // 全螢幕照片放大預覽
  previewPhotoFull(url) {
    const win = window.open('');
    if (win) {
      win.document.write(`<body style="margin:0;background:#000;display:flex;justify-content:center;align-items:center;height:100vh;"><img src="${url}" style="max-width:100%;max-height:100%;"></body>`);
    }
  }

  closeModal() {
    const modal = document.getElementById('card-detail-modal');
    if (modal) {
      modal.classList.remove('active');
    }
    document.body.style.overflow = '';
    this.releaseWakeLock();
    this.currentCard = null;
  }

  formatCardCode(code) {
    if (!code) return '';
    return String(code).replace(/(\d{4})(?=\d)/g, '$1 ');
  }

  renderHistoryList(history) {
    const container = document.getElementById('modal-history-list');
    if (!container) return;

    if (!history || history.length === 0) {
      container.innerHTML = '<div class="empty-history">尚無異動紀錄</div>';
      return;
    }

    container.innerHTML = history.slice(0, 10).map(h => {
      const date = new Date(h.date);
      const timeStr = `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
      const isDeduct = h.type === 'deduct';

      return `
        <div class="history-item">
          <div class="history-left">
            <span class="history-icon ${isDeduct ? 'icon-deduct' : 'icon-edit'}">
              ${isDeduct ? '🛒' : '✏️'}
            </span>
            <div>
              <div class="history-note">${h.note || (isDeduct ? '消費扣款' : '修改餘額')}</div>
              <div class="history-time">${timeStr}</div>
            </div>
          </div>
          <div class="history-right">
            <div class="history-amount ${isDeduct ? 'amount-minus' : 'amount-neutral'}">
              ${isDeduct ? `-$${h.amount}` : `$${h.balanceAfter}`}
            </div>
            <div class="history-balance">餘額 $${h.balanceAfter}</div>
          </div>
        </div>
      `;
    }).join('');
  }

  async executeDeduct(amount, customNote = '') {
    if (!this.currentCard) return;

    const num = Number(amount);
    if (isNaN(num) || num <= 0) {
      window.app?.showToast('⚠️ 請輸入有效的消費扣款金額', 'warning');
      return;
    }

    if (num > this.currentCard.balance) {
      const confirmOver = confirm(`此卡剩餘 $${this.currentCard.balance}，扣款 $${num} 將使餘額歸零，是否繼續？`);
      if (!confirmOver) return;
    }

    const updated = await window.cardStorage.deductCard(this.currentCard.id, num, customNote);
    this.currentCard = updated;
    this.openModal(updated.id);
    window.app?.refreshUI();
    window.app?.showToast(`✅ 已扣款 $${num}，剩餘餘額 $${updated.balance}`, 'success');
  }

  async executeSetBalance(newBalance) {
    if (!this.currentCard) return;

    const val = Number(newBalance);
    if (isNaN(val) || val < 0) {
      window.app?.showToast('⚠️ 餘額不能小於 0', 'warning');
      return;
    }

    const updated = await window.cardStorage.updateCard(this.currentCard.id, {
      balance: val,
      historyNote: `手動更新餘額為 $${val}`
    });

    this.currentCard = updated;
    this.openModal(updated.id);
    window.app?.refreshUI();
    window.app?.showToast(`✅ 餘額已更新為 $${val}`, 'success');
  }
}

window.barcodePresenter = new BarcodePresenter();
