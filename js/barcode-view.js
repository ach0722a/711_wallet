/**
 * 7-11 商品卡皮夾 - 條碼出示與快捷扣款計算器模組 (barcode-view.js)
 * 
 * 升級亮點：
 * 1. 雙段條碼店員出示模式：清晰呈現「[1] 主卡號條碼」與「[2] 檢核驗證碼」，店員依序刷讀 100% 成功。
 * 2. 向量 SVG 高清渲染與防休眠常亮鎖定。
 * 3. 智能消費扣款計算機與歷程追蹤。
 */

class BarcodePresenter {
  constructor() {
    this.currentCard = null;
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

  // 繪製單一條碼
  renderBarcode(svgElementOrSelector, code, format = 'CODE128', height = 75) {
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
          margin: 8,
          background: '#ffffff'
        });
      } else {
        this.renderFallbackBarcode(el, code, height);
      }
    } catch (e) {
      this.renderFallbackBarcode(el, code, height);
    }
  }

  renderFallbackBarcode(svgEl, code, height = 75) {
    const cleanCode = String(code).trim();
    let rects = '';
    let x = 10;
    
    for (let i = 0; i < cleanCode.length; i++) {
      const charCode = cleanCode.charCodeAt(i);
      const w1 = (charCode % 3) + 1.8;
      const w2 = ((charCode >> 1) % 2) + 1.2;
      rects += `<rect x="${x}" y="0" width="${w1}" height="${height}" fill="#000"/>`;
      x += w1 + w2;
      rects += `<rect x="${x}" y="0" width="${w2 * 1.5}" height="${height}" fill="#000"/>`;
      x += w2 * 1.5 + 2;
    }

    svgEl.setAttribute('viewBox', `0 0 ${Math.max(x + 10, 240)} ${height}`);
    svgEl.innerHTML = `<rect width="100%" height="100%" fill="#fff"/>${rects}`;
  }

  // 開啟卡片詳情與條碼出示彈窗
  openModal(cardId) {
    const card = window.cardStorage.getCard(cardId);
    if (!card) return;

    this.currentCard = card;
    this.requestWakeLock();

    const modal = document.getElementById('card-detail-modal');
    if (!modal) return;

    // 基本資料
    document.getElementById('modal-card-name').textContent = card.name || '7-11 商品卡';
    document.getElementById('modal-card-balance').textContent = card.balance;
    document.getElementById('modal-card-facevalue').textContent = card.faceValue;
    
    const badgeEl = document.getElementById('modal-card-status-badge');
    if (badgeEl) {
      badgeEl.textContent = card.balance > 0 ? '可使用' : '已用完';
      badgeEl.className = `status-badge ${card.balance > 0 ? 'badge-active' : 'badge-depleted'}`;
    }

    // 判斷是否為雙段條碼並動態渲染出示區
    const code1 = card.code1 || card.code;
    const code2 = card.code2;

    const barcodeContainer = document.getElementById('modal-barcode-container');
    if (barcodeContainer) {
      if (code2) {
        // 雙段條碼模式 (清晰分列第一段與第二段)
        barcodeContainer.innerHTML = `
          <div class="barcode-hint">📱 7-11 結帳時，請店員依序掃描以下【兩段條碼】：</div>
          
          <!-- 第一段：主卡號條碼 -->
          <div class="dual-barcode-section">
            <div class="dual-barcode-label">
              <span class="step-num">1</span>
              <span>第一段：主卡號條碼</span>
            </div>
            <svg id="modal-barcode-svg-1" class="cashier-svg"></svg>
            <div class="barcode-digits-display">${this.formatCardCode(code1)}</div>
          </div>

          <div class="dual-barcode-divider"></div>

          <!-- 第二段：檢核驗證碼 -->
          <div class="dual-barcode-section">
            <div class="dual-barcode-label">
              <span class="step-num">2</span>
              <span>第二段：檢核驗證碼</span>
            </div>
            <svg id="modal-barcode-svg-2" class="cashier-svg"></svg>
            <div class="barcode-digits-display">${this.formatCardCode(code2)}</div>
          </div>
        `;
        
        setTimeout(() => {
          this.renderBarcode('#modal-barcode-svg-1', code1, card.format, 65);
          this.renderBarcode('#modal-barcode-svg-2', code2, card.format, 65);
        }, 30);
      } else {
        // 單段條碼模式
        barcodeContainer.innerHTML = `
          <div class="barcode-hint">📱 請出示此條碼供 7-11 店員掃描</div>
          <svg id="modal-barcode-svg-single" class="cashier-svg"></svg>
          <div class="barcode-digits-display">${this.formatCardCode(code1)}</div>
        `;
        setTimeout(() => {
          this.renderBarcode('#modal-barcode-svg-single', code1, card.format, 85);
        }, 30);
      }
    }

    // 渲染歷史紀錄
    this.renderHistoryList(card.history || []);

    const spendInput = document.getElementById('quick-spend-input');
    if (spendInput) spendInput.value = '';

    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
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
