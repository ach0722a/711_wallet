# Firebase 雲端同步設定

App 平常資料都存在手機本機，設定 Firebase 後可用 Google 帳號登入，跨裝置同步卡片與品牌設定。
沒設定也完全不影響原本功能。

## 1. 建立 Firebase 專案

1. 到 <https://console.firebase.google.com/> →「新增專案」（Google Analytics 可以關掉）。
2. 專案首頁點「</>」新增 **網頁應用程式**，取個名字，**不用**勾 Firebase Hosting。
3. 畫面會出現一段 `const firebaseConfig = { apiKey: "...", authDomain: "...", ... }`，先複製起來。

## 2. 開啟 Google 登入

1. 左側「Authentication」→「開始使用」→「Sign-in method」→ 啟用 **Google**。
2. 「Authentication」→「設定」→「授權網域」→ 加入你放 App 的網域，例如 `ach0722a.github.io`。
   （`localhost` 預設已經有了）

## 3. 建立 Firestore 資料庫

1. 左側「Firestore Database」→「建立資料庫」→ 位置選 `asia-east1`（台灣）→ 以「正式版模式」建立。
2. 到「規則」分頁，整段換成下面這份後按「發布」——**每個人只能讀寫自己的資料**：

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

## 4. 在 App 裡設定

1. 開 App → 右上角 ⚙️ → 「雲端同步 (Firebase)」。
2. 把第 1 步複製的 `firebaseConfig` 整段貼上 → 「儲存設定」。
3. 按「🔑 用 Google 登入」。第一次登入會把手機上現有的卡片全部上傳。

## 同步規則

- 開 App、從背景切回 App、按「🔄 立即同步」時會完整比對一次；平常新增 / 修改 / 刪除卡片後約 2 秒自動上傳有變動的部分。
- 同一張卡兩邊都改過時，以 **修改時間較新** 的為準（依各裝置的時鐘）。
- 刪除的卡片會在雲端留一筆「已刪除」紀錄，其他裝置同步時也會一起刪掉。
- Firestore 單筆資料上限 1 MB，太大的卡片照片只存在原本那支手機。

## 費用

免費方案（Spark）每天 5 萬次讀取、2 萬次寫入、1 GB 儲存空間，個人使用基本上用不完，也不需要綁信用卡。
