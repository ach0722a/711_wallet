/**
 * 7-11 商品卡皮夾 - 離線 Service Worker 快取模組 (sw.js - v2)
 * 
 * 升級思路：
 * 採用 Network-First (網路優先) 策略載入 HTML/JS/CSS，確保每次有新版本推送時
 * 只要有網路就能立即獲取最新程式碼，斷網時才使用本地快取。
 */

const CACHE_NAME = '711-wallet-cache-v8';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './css/style.css?v=8.0',
  './js/storage.js?v=8.0',
  './js/scanner.js?v=8.0',
  './js/barcode-view.js?v=8.0',
  './js/app.js?v=8.0',
  './manifest.json',
  './icons/icon-192.svg',
  './icons/icon-512.svg',
  'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js',
  'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js'
];

self.addEventListener('install', (event) => {
  self.skipWaiting(); // 強制立即跳過等待接管
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE).catch(err => {
        console.warn('[SW] 快取部分資產:', err);
      });
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[SW] 清除舊版本快取:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // 網路優先策略 (Network First)：先嘗試向伺服器拿最新檔案，拿不到(離線)才讀快取
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        // 斷網離線時回退至快取
        return caches.match(event.request).then((cachedResponse) => {
          if (cachedResponse) return cachedResponse;
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
        });
      })
  );
});
