/**
 * 7-11 商品卡皮夾 - 資料持久化與雙重儲存管理模組 (storage.js)
 * 
 * 設計思路與技術亮點：
 * 1. 雙重保險機制 (LocalStorage + IndexedDB 同步)：雙向防呆，一方遺失另一方自動還原。
 * 2. 永久儲存請求 (Persistent Storage API)：主動告知手機瀏覽器勿自動清理此應用資料。
 * 3. 完整歷程記錄：每次手動改餘額、扣款消費均有時間與金額紀錄。
 * 4. 一鍵 CSV / JSON 匯入匯出：支援備份到本機檔案或 Excel。
 */

const STORAGE_KEY = '711_cards_data_v1';
const SETTINGS_KEY = '711_settings_v1';
const DB_NAME = '711CardWalletDB';
const DB_VERSION = 1;
const STORE_NAME = 'cards';

class CardStorage {
  constructor() {
    this.cards = [];
    this.settings = {
      defaultFaceValue: 100,
      vibrationEnabled: true,
      soundEnabled: true,
      highBrightnessReminder: true,
      duplicateCooldownSeconds: 2,
      theme: 'dark'
    };
    this.db = null;
    this.initialized = false;
  }

  // 初始化儲存庫 (開啟 IndexedDB、LocalStorage 與請求持久化)
  async init() {
    if (this.initialized) return;

    // 1. 請求瀏覽器持久化儲存權限 (防止 iOS/Android 空間清理時被自動回收)
    if (navigator.storage && navigator.storage.persist) {
      try {
        const isPersisted = await navigator.storage.persist();
        console.log(`[Storage] 持久化儲存狀態: ${isPersisted ? '已永久鎖定 (持久)' : '標準模式'}`);
      } catch (e) {
        console.warn('[Storage] 請求持久化失敗:', e);
      }
    }

    // 2. 讀取設定
    try {
      const savedSettings = localStorage.getItem(SETTINGS_KEY);
      if (savedSettings) {
        this.settings = { ...this.settings, ...JSON.parse(savedSettings) };
      }
    } catch (e) {
      console.warn('[Storage] 讀取設定失敗:', e);
    }

    // 3. 連線 IndexedDB
    try {
      this.db = await this.openIndexedDB();
    } catch (e) {
      console.warn('[Storage] IndexedDB 初始化失敗，降級使用 LocalStorage:', e);
    }

    // 4. 雙向同步載入資料
    await this.syncAndLoad();
    this.initialized = true;
  }

  // 開啟 IndexedDB
  openIndexedDB() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        return reject(new Error('IndexedDB not supported'));
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('code', 'code', { unique: false });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // 雙向同步與恢復資料
  async syncAndLoad() {
    let localCards = [];
    try {
      const localData = localStorage.getItem(STORAGE_KEY);
      if (localData) {
        localCards = JSON.parse(localData);
      }
    } catch (e) {
      console.warn('[Storage] 讀取 LocalStorage 失敗:', e);
    }

    let idbCards = [];
    if (this.db) {
      try {
        idbCards = await this.getAllFromIDB();
      } catch (e) {
        console.warn('[Storage] 讀取 IndexedDB 失敗:', e);
      }
    }

    // 交叉比對：取資料較新/較齊全者
    if (localCards.length >= idbCards.length && localCards.length > 0) {
      this.cards = localCards;
      if (this.db) this.saveAllToIDB(this.cards).catch(console.warn);
    } else if (idbCards.length > 0) {
      this.cards = idbCards;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.cards));
      } catch (e) {
        console.warn(e);
      }
    } else {
      this.cards = [];
    }
  }

  // 從 IndexedDB 讀取全部
  getAllFromIDB() {
    return new Promise((resolve, reject) => {
      if (!this.db) return resolve([]);
      const tx = this.db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  // 寫入全部至 IndexedDB
  saveAllToIDB(cards) {
    return new Promise((resolve, reject) => {
      if (!this.db) return resolve();
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.clear();
      cards.forEach(card => store.put(card));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // 統一儲存 (同時寫入 LocalStorage 與 IndexedDB)
  async persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.cards));
    } catch (e) {
      console.error('[Storage] LocalStorage 寫入失敗:', e);
    }

    if (this.db) {
      try {
        await this.saveAllToIDB(this.cards);
      } catch (e) {
        console.error('[Storage] IndexedDB 寫入失敗:', e);
      }
    }
  }

  // 儲存設定
  saveSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch (e) {
      console.error('[Storage] 儲存設定失敗:', e);
    }
  }

  // 取得全部卡片 (依最新更新時間排序)
  getCards() {
    return [...this.cards];
  }

  // 根據 ID 取得單張卡片
  getCard(id) {
    return this.cards.find(c => c.id === id);
  }

  // 根據條碼檢查是否已存在
  getCardByCode(code) {
    return this.cards.find(c => c.code.trim() === code.trim());
  }

  // 新增卡片 (支援單段或雙段條碼)
  async addCard(data) {
    const now = new Date().toISOString();
    const faceValue = Number(data.faceValue) || Number(this.settings.defaultFaceValue) || 100;
    const balance = data.balance !== undefined ? Number(data.balance) : faceValue;

    const code1 = String(data.code1 || data.code || '').trim();
    const code2 = String(data.code2 || '').trim();
    const primaryCode = code1 || code2;

    const newCard = {
      id: 'card_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      code: primaryCode, // 相容主條碼
      code1: code1,      // 第一段 (卡號)
      code2: code2,      // 第二段 (檢核碼/密碼)
      hasDualBarcode: Boolean(code1 && code2),
      format: data.format || 'CODE128',
      name: data.name || `商品卡 ${this.cards.length + 1}`,
      faceValue: faceValue,
      balance: balance,
      status: balance > 0 ? 'active' : 'depleted',
      note: data.note || '',
      createdAt: now,
      updatedAt: now,
      history: [
        {
          date: now,
          type: 'create',
          amount: faceValue,
          balanceAfter: balance,
          note: '初始建立卡片'
        }
      ]
    };

    this.cards.unshift(newCard);
    await this.persist();
    return newCard;
  }

  // 批次快速新增卡片 (針對連掃 20 張優化)
  async batchAddCards(codesArray, defaultFaceValue) {
    const faceVal = Number(defaultFaceValue) || Number(this.settings.defaultFaceValue) || 100;
    const added = [];
    const skipped = [];
    const now = new Date().toISOString();

    for (const code of codesArray) {
      const cleanCode = String(code).trim();
      if (!cleanCode) continue;

      // 檢查是否已存在同一條碼
      const exists = this.cards.some(c => c.code === cleanCode);
      if (exists) {
        skipped.push(cleanCode);
        continue;
      }

      const card = {
        id: 'card_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        code: cleanCode,
        format: 'CODE128',
        name: `商品卡 #${this.cards.length + added.length + 1}`,
        faceValue: faceVal,
        balance: faceVal,
        status: 'active',
        note: '批次連掃匯入',
        createdAt: now,
        updatedAt: now,
        history: [
          {
            date: now,
            type: 'create',
            amount: faceVal,
            balanceAfter: faceVal,
            note: '批次掃描建立'
          }
        ]
      };
      added.push(card);
    }

    if (added.length > 0) {
      this.cards = [...added, ...this.cards];
      await this.persist();
    }

    return { added, skipped };
  }

  // 修改卡片餘額或資訊
  async updateCard(id, updates) {
    const index = this.cards.findIndex(c => c.id === id);
    if (index === -1) return null;

    const current = this.cards[index];
    const now = new Date().toISOString();
    const prevBalance = current.balance;

    let history = [...(current.history || [])];

    // 如果有修改餘額，加入異動紀錄
    if (updates.balance !== undefined && Number(updates.balance) !== prevBalance) {
      const newBal = Number(updates.balance);
      const diff = newBal - prevBalance;
      history.unshift({
        date: now,
        type: diff < 0 ? 'deduct' : 'edit',
        amount: Math.abs(diff),
        balanceAfter: newBal,
        note: updates.historyNote || (diff < 0 ? `消費扣款 $${Math.abs(diff)}` : `手動修改餘額為 $${newBal}`)
      });
      updates.status = newBal <= 0 ? 'depleted' : 'active';
    }

    this.cards[index] = {
      ...current,
      ...updates,
      history,
      updatedAt: now
    };

    await this.persist();
    return this.cards[index];
  }

  // 快速扣款 (例如消費 $35，輸入 35 自動扣減)
  async deductCard(id, spendAmount, note = '') {
    const card = this.getCard(id);
    if (!card) throw new Error('找不到該卡片');

    const spend = Number(spendAmount);
    if (isNaN(spend) || spend <= 0) throw new Error('扣款金額必須大於 0');

    const newBalance = Math.max(0, card.balance - spend);
    return await this.updateCard(id, {
      balance: newBalance,
      historyNote: note || `結帳扣款 $${spend}`
    });
  }

  // 刪除卡片
  async deleteCard(id) {
    const index = this.cards.findIndex(c => c.id === id);
    if (index === -1) return false;
    this.cards.splice(index, 1);
    await this.persist();
    return true;
  }

  // 批次刪除已用完卡片
  async deleteDepletedCards() {
    const initialCount = this.cards.length;
    this.cards = this.cards.filter(c => c.balance > 0);
    const deletedCount = initialCount - this.cards.length;
    if (deletedCount > 0) {
      await this.persist();
    }
    return deletedCount;
  }

  // 清空所有卡片
  async clearAll() {
    this.cards = [];
    await this.persist();
  }

  // 統計總覽數據
  getStats() {
    const totalCount = this.cards.length;
    const activeCards = this.cards.filter(c => c.balance > 0);
    const depletedCards = this.cards.filter(c => c.balance <= 0);

    const totalBalance = this.cards.reduce((sum, c) => sum + (Number(c.balance) || 0), 0);
    const totalFaceValue = this.cards.reduce((sum, c) => sum + (Number(c.faceValue) || 0), 0);

    // 今日消費金額計算
    const todayStr = new Date().toISOString().slice(0, 10);
    let todaySpent = 0;
    this.cards.forEach(c => {
      if (c.history) {
        c.history.forEach(h => {
          if (h.type === 'deduct' && h.date && h.date.startsWith(todayStr)) {
            todaySpent += Number(h.amount) || 0;
          }
        });
      }
    });

    return {
      totalCount,
      activeCount: activeCards.length,
      depletedCount: depletedCards.length,
      totalBalance,
      totalFaceValue,
      todaySpent
    };
  }

  // 匯出為 JSON 備份檔
  exportJSON() {
    const backupData = {
      app: '711-Card-Wallet',
      version: '1.0',
      exportedAt: new Date().toISOString(),
      stats: this.getStats(),
      cards: this.cards,
      settings: this.settings
    };
    return JSON.stringify(backupData, null, 2);
  }

  // 匯出為 CSV 表格 (可用 Excel 開啟)
  exportCSV() {
    const headers = ['卡片名稱', '主條碼', '第一段(卡號)', '第二段(檢核碼)', '面額', '剩餘餘額', '狀態', '備註', '建立時間', '最後更新時間'];
    const rows = this.cards.map(c => [
      `"${(c.name || '').replace(/"/g, '""')}"`,
      `"\t${(c.code || '').replace(/"/g, '""')}"`,
      `"\t${(c.code1 || c.code || '').replace(/"/g, '""')}"`,
      `"\t${(c.code2 || '').replace(/"/g, '""')}"`,
      c.faceValue || 0,
      c.balance || 0,
      c.balance > 0 ? '使用中' : '已用完',
      `"${(c.note || '').replace(/"/g, '""')}"`,
      `"${c.createdAt || ''}"`,
      `"${c.updatedAt || ''}"`
    ]);

    // 加入 UTF-8 BOM，防止 Excel 開啟亂碼
    return '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
  }

  // 從 JSON 匯入備份 (支援合併或覆蓋)
  async importJSON(jsonStr, mode = 'merge') {
    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      throw new Error('JSON 格式錯誤，無法解析備份檔');
    }

    const importedCards = Array.isArray(parsed) ? parsed : (parsed.cards || []);
    if (!Array.isArray(importedCards)) {
      throw new Error('備份檔中找不到有效的卡片資料');
    }

    if (mode === 'overwrite') {
      this.cards = importedCards;
    } else {
      // 合併模式：條碼不重複才加入
      const existingCodes = new Set(this.cards.map(c => c.code));
      let addedCount = 0;
      for (const card of importedCards) {
        if (!card.code) continue;
        if (!existingCodes.has(card.code)) {
          this.cards.push(card);
          existingCodes.add(card.code);
          addedCount++;
        }
      }
    }

    await this.persist();
    return { count: importedCards.length, currentTotal: this.cards.length };
  }

  // 從 CSV / 純條碼文字匯入 (例如每行一個條碼)
  async importTextOrCSV(text, defaultFaceVal = 100) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const codes = [];

    for (const line of lines) {
      // 如果是 CSV 格式，抓取逗號分隔的條碼欄位或直接當條碼
      const parts = line.split(',').map(p => p.trim().replace(/^["'\t]+|["']+$/g, ''));
      if (parts[0] === '卡片名稱' || parts[0] === '條碼內容') continue; // 略過標題行
      
      const code = parts[1] || parts[0];
      if (code && /^[A-Za-z0-9\-_]+$/.test(code)) {
        codes.push(code);
      }
    }

    return await this.batchAddCards(codes, defaultFaceVal);
  }
}

// 建立全域單例物件
window.cardStorage = new CardStorage();
