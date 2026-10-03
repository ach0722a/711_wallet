/**
 * 7-11 商品卡皮夾 - Firebase 雲端同步模組 (cloud-sync.js)
 *
 * 設計思路：
 * 1. 本機仍是主要儲存 (離線可用)，雲端只是跨裝置同步與備份。
 * 2. 使用者在「設定」貼上自己的 Firebase 專案設定，才會載入 Firebase SDK；沒設定完全不影響原功能。
 * 3. 資料結構：users/{uid}/cards/{cardId}，一張卡一份文件；users/{uid}/meta/settings 存品牌設定。
 * 4. 合併規則：同一張卡以 updatedAt 較新的為準；刪除會留下 { deleted: true } 墓碑，其他裝置同步時一併刪除。
 * 5. 省讀取次數：開 App / 回到前景 / 手動按「立即同步」才整批讀取，平常資料變動只上傳有改的卡片。
 */

const FIREBASE_SDK_VERSION = '10.12.5';
const FIREBASE_SDK_FILES = ['firebase-app-compat.js', 'firebase-auth-compat.js', 'firebase-firestore-compat.js'];
// Firestore 單一文件上限 1 MiB，太大的照片只留在本機
const MAX_CLOUD_PHOTO_LENGTH = 700000;
const FIRESTORE_BATCH_LIMIT = 400;

class CloudSync {
  constructor() {
    this.user = null;
    this.auth = null;
    this.db = null;
    this.ready = false;
    this.syncing = false;
    this.applyingRemote = false;
    this.pushTimer = null;
    this.lastPushAt = '';
    this.lastSyncAt = '';
    this.lastError = '';
    this.onStatusChange = null;
  }

  // 解析使用者貼上的 firebaseConfig (可直接貼主控台那整段 JS)
  parseConfig(text) {
    const config = {};
    const re = /["']?(\w+)["']?\s*:\s*["']([^"']+)["']/g;
    let m;
    while ((m = re.exec(String(text || ''))) !== null) {
      config[m[1]] = m[2];
    }
    for (const key of ['apiKey', 'authDomain', 'projectId']) {
      if (!config[key]) throw new Error(`設定缺少 ${key}，請貼上完整的 firebaseConfig`);
    }
    return config;
  }

  isConfigured() {
    return Boolean(window.cardStorage.settings.firebaseConfig);
  }

  notify() {
    if (this.onStatusChange) this.onStatusChange();
  }

  loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = () => reject(new Error('Firebase SDK 載入失敗，請確認網路連線'));
      document.head.appendChild(el);
    });
  }

  async loadSdk() {
    if (window.firebase && window.firebase.firestore) return;
    for (const file of FIREBASE_SDK_FILES) {
      await this.loadScript(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/${file}`);
    }
  }

  // App 啟動時呼叫：有設定才連線
  async init() {
    const storage = window.cardStorage;
    storage.onChange = () => this.schedulePush();
    storage.onSettingsChange = (changes) => {
      if (changes && changes.brands) this.schedulePush();
    };

    if (!this.isConfigured() || this.ready) return;

    try {
      await this.loadSdk();
      const firebase = window.firebase;
      if (!firebase.apps.length) {
        firebase.initializeApp(storage.settings.firebaseConfig);
      }
      this.auth = firebase.auth();
      this.db = firebase.firestore();
      this.ready = true;

      // 從 redirect 登入回來時取結果 (iOS 主畫面 App 不支援彈窗登入)
      this.auth.getRedirectResult().catch(err => {
        this.lastError = err.message;
        this.notify();
      });

      this.auth.onAuthStateChanged(user => {
        this.user = user;
        this.notify();
        if (user) this.syncNow();
      });

      // 從背景切回 App 時拉一次最新資料
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.user) this.syncNow();
      });
    } catch (err) {
      console.warn('[Cloud] 初始化失敗:', err);
      this.lastError = err.message;
      this.notify();
    }
  }

  async signIn() {
    if (!this.ready) await this.init();
    if (!this.ready) throw new Error(this.lastError || 'Firebase 尚未設定');

    const provider = new window.firebase.auth.GoogleAuthProvider();
    try {
      await this.auth.signInWithPopup(provider);
    } catch (err) {
      const needRedirect = ['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/cancelled-popup-request'];
      if (needRedirect.includes(err.code)) {
        await this.auth.signInWithRedirect(provider);
        return;
      }
      throw err;
    }
  }

  async signOut() {
    if (this.auth) await this.auth.signOut();
    this.user = null;
    this.notify();
  }

  userRef() {
    return this.db.collection('users').doc(this.user.uid);
  }

  // 轉成 Firestore 可存的純資料 (去掉 undefined、過大的照片)
  toCloudCard(card) {
    const data = JSON.parse(JSON.stringify(card));
    if (data.photoUrl && data.photoUrl.length > MAX_CLOUD_PHOTO_LENGTH) {
      data.photoUrl = '';
      data.photoLocalOnly = true;
    }
    return data;
  }

  async writeDocs(writes) {
    for (let i = 0; i < writes.length; i += FIRESTORE_BATCH_LIMIT) {
      const batch = this.db.batch();
      writes.slice(i, i + FIRESTORE_BATCH_LIMIT).forEach(({ ref, data }) => batch.set(ref, data));
      await batch.commit();
    }
  }

  // 資料變動後 2 秒內合併成一次上傳 (連續掃描時不會每張都打一次)
  schedulePush() {
    if (!this.user || this.applyingRemote) return;
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => this.pushChanges(), 2000);
  }

  // 只上傳上次同步後有改過的卡片與刪除紀錄 (不讀取雲端)
  async pushChanges() {
    if (!this.user || this.syncing) return;
    const storage = window.cardStorage;
    const cardsRef = this.userRef().collection('cards');
    const since = this.lastPushAt;
    const startedAt = new Date().toISOString();

    const writes = storage.cards
      .filter(c => !since || (c.updatedAt || '') > since)
      .map(c => ({ ref: cardsRef.doc(c.id), data: this.toCloudCard(c) }));
    const deletedIds = Object.keys(storage.deletedIds);
    deletedIds.forEach(id => {
      writes.push({ ref: cardsRef.doc(id), data: { id, deleted: true, updatedAt: storage.deletedIds[id] } });
    });
    if ((storage.settings.brandsUpdatedAt || '') > since) {
      writes.push({ ref: this.userRef().collection('meta').doc('settings'), data: this.settingsPayload() });
    }
    if (writes.length === 0) return;

    try {
      await this.writeDocs(writes);
      deletedIds.forEach(id => delete storage.deletedIds[id]);
      storage.saveDeletedIds();
      this.lastPushAt = startedAt;
      this.lastError = '';
    } catch (err) {
      console.warn('[Cloud] 上傳失敗:', err);
      this.lastError = err.message;
    }
    this.notify();
  }

  settingsPayload() {
    const s = window.cardStorage.settings;
    return {
      brands: JSON.parse(JSON.stringify(s.brands)),
      brandsUpdatedAt: s.brandsUpdatedAt || new Date().toISOString()
    };
  }

  // 完整雙向同步：讀取雲端全部卡片，與本機逐張比較時間後合併
  async syncNow() {
    if (!this.user || this.syncing) return;
    this.syncing = true;
    this.notify();
    clearTimeout(this.pushTimer);

    const storage = window.cardStorage;
    const startedAt = new Date().toISOString();

    try {
      const cardsRef = this.userRef().collection('cards');
      const metaRef = this.userRef().collection('meta').doc('settings');
      // 先把雲端資料都讀完，之後的合併是同步執行的，不會吃掉同步途中新掃的卡
      const [snapshot, metaDoc] = await Promise.all([cardsRef.get(), metaRef.get()]);
      const remote = new Map();
      snapshot.forEach(doc => remote.set(doc.id, doc.data()));

      const local = new Map(storage.cards.map(c => [c.id, c]));
      const tombstoneIds = Object.keys(storage.deletedIds);
      const allIds = new Set([...local.keys(), ...remote.keys(), ...tombstoneIds]);
      const merged = [];
      const writes = [];

      for (const id of allIds) {
        const localCard = local.get(id);
        const deletedAt = storage.deletedIds[id] || '';
        const localAt = localCard ? (localCard.updatedAt || '') : '';
        // 本機版本：卡片本身，或比卡片更新的刪除紀錄
        const localVersion = deletedAt > localAt
          ? { deleted: true, at: deletedAt }
          : (localCard ? { card: localCard, at: localAt } : null);
        const remoteDoc = remote.get(id);
        const remoteAt = remoteDoc ? (remoteDoc.updatedAt || '') : '';

        if (localVersion && (!remoteDoc || localVersion.at > remoteAt)) {
          // 本機較新 ➔ 上傳
          const data = localVersion.deleted
            ? { id, deleted: true, updatedAt: localVersion.at }
            : this.toCloudCard(localVersion.card);
          writes.push({ ref: cardsRef.doc(id), data });
          if (localVersion.card) merged.push(localVersion.card);
        } else if (remoteDoc && !remoteDoc.deleted) {
          // 雲端較新或相同 ➔ 採用雲端，但保留只存在本機的照片
          const card = { ...remoteDoc };
          if (card.photoLocalOnly && localCard && localCard.photoUrl) {
            card.photoUrl = localCard.photoUrl;
          }
          delete card.photoLocalOnly;
          merged.push(card);
        }
        // 其他情況：雲端是刪除墓碑且較新 ➔ 本機也刪除
      }

      // 品牌設定：較新的一方為準
      const remoteMeta = metaDoc.exists ? metaDoc.data() : null;
      const localBrandsAt = storage.settings.brandsUpdatedAt || '';
      let brandsChanged = false;
      if (remoteMeta && Array.isArray(remoteMeta.brands) && (remoteMeta.brandsUpdatedAt || '') > localBrandsAt) {
        this.applyingRemote = true;
        storage.saveSettings({ brands: remoteMeta.brands, brandsUpdatedAt: remoteMeta.brandsUpdatedAt });
        this.applyingRemote = false;
        brandsChanged = true;
      } else if (!remoteMeta || localBrandsAt > (remoteMeta.brandsUpdatedAt || '')) {
        writes.push({ ref: metaRef, data: this.settingsPayload() });
      }

      merged.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      storage.cards = merged;
      this.applyingRemote = true;
      await storage.persist();
      this.applyingRemote = false;

      await this.writeDocs(writes);
      // 刪除紀錄已寫進雲端才清掉
      tombstoneIds.forEach(id => delete storage.deletedIds[id]);
      storage.saveDeletedIds();

      this.lastPushAt = startedAt;
      this.lastSyncAt = startedAt;
      this.lastError = '';
      if (window.app) window.app.refreshUI();
      if (brandsChanged && window.settingsPanel) window.settingsPanel.renderBrandList();
    } catch (err) {
      console.warn('[Cloud] 同步失敗:', err);
      this.lastError = err.code === 'permission-denied'
        ? '沒有權限，請確認 Firestore 安全規則 (見 FIREBASE_SETUP.md)'
        : err.message;
      this.applyingRemote = false;
    }

    this.syncing = false;
    this.notify();
    // 同步途中有新變動 (例如邊掃描邊同步) ➔ 補上傳
    if (storage.cards.some(c => (c.updatedAt || '') > this.lastPushAt) || Object.keys(storage.deletedIds).length) {
      this.schedulePush();
    }
  }
}

window.cloudSync = new CloudSync();
