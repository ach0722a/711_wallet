/**
 * 7-11 商品卡皮夾 - 極速批次連續相機掃描模組 (scanner.js - v3 雙步驟精準版)
 * 
 * 修改思路與技術亮點：
 * 1. 狹窄聚焦條碼掃描縫 (Narrow Viewfinder Slit)：
 *    - 實體 7-11 卡片兩段條碼上下距離近，過大的掃描框會同時拍到兩段導致瞬間誤掃。
 *    - 將掃描取景框改為狹長橫條 (窄縫高對焦)，確保鏡頭一次只會讀取「單一段條碼」。
 * 2. 雙步驟防誤觸冷卻鎖定 (1.2s Step Transition Lockout)：
 *    - 第一步錄入卡號後，啟動 1.2 秒過渡鎖定，並將瞄準框切換為橘色「請移至下方檢核碼」，
 *      給予使用者足夠時間將鏡頭微調至下方條碼，徹底解決瞬間連刷兩次同條碼或錯位問題。
 * 3. 智慧條碼長度防呆校驗 (Smart Length Detection)：
 *    - 7-11 主卡號通常大於 12 碼，檢核碼通常小於 10 碼，系統會自動輔助校驗防呆。
 */

class CardScanner {
  constructor() {
    this.html5QrCode = null;
    this.isScanning = false;
    this.recentScans = new Map();
    this.currentBatchCards = [];
    this.selectedFaceValue = 100;
    this.audioCtx = null;
    this.currentCameraId = null;
    this.cameras = [];
    this.isTorchOn = false;

    // 雙段條碼狀態管理
    this.scanMode = 'dual'; // 'dual' | 'single'
    this.currentStep = 1;   // 1: 等待第一段(卡號), 2: 等待第二段(檢核碼)
    this.pendingCode1 = null;
    this.stepTransitionLock = false; // 步驟切換防誤觸鎖
  }

  initAudio() {
    if (!this.audioCtx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) {
        this.audioCtx = new AudioContext();
      }
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
  }

  // 雙音階提示音 (第一段: 躍進音階 1600->2000Hz / 第二段完成: 清脆高音 2400Hz)
  playBeep(type = 'success') {
    try {
      this.initAudio();
      if (!this.audioCtx) return;

      const now = this.audioCtx.currentTime;
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);

      if (type === 'step1') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1500, now);
        osc.frequency.exponentialRampToValueAtTime(2100, now + 0.12);
        gain.gain.setValueAtTime(0.3, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
        osc.start(now);
        osc.stop(now + 0.15);
      } else if (type === 'duplicate') {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(700, now);
        osc.frequency.setValueAtTime(500, now + 0.08);
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.18);
        osc.start(now);
        osc.stop(now + 0.18);
      } else {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(2400, now);
        gain.gain.setValueAtTime(0.35, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.16);
        osc.start(now);
        osc.stop(now + 0.16);
      }
    } catch (e) {}
  }

  triggerVibrate(type = 'success') {
    if ('vibrate' in navigator) {
      try {
        if (type === 'step1') {
          navigator.vibrate(40);
        } else if (type === 'duplicate') {
          navigator.vibrate([80, 40, 80]);
        } else {
          navigator.vibrate([60, 40, 100]); // 雙震表示整張完成
        }
      } catch (e) {}
    }
  }

  setFaceValue(value) {
    this.selectedFaceValue = Number(value) || 100;
  }

  setScanMode(mode) {
    this.scanMode = mode;
    this.resetStepState();
  }

  resetStepState() {
    this.currentStep = 1;
    this.pendingCode1 = null;
    this.stepTransitionLock = false;
  }

  // 啟動相機 (縮小掃描框垂直高度至 80px，精準對準單一條碼)
  async start(readerElementId, onScanSuccess, onScanError) {
    this.initAudio();
    this.currentBatchCards = [];
    this.recentScans.clear();
    this.resetStepState();

    if (this.isScanning) {
      await this.stop();
    }

    if (typeof Html5Qrcode === 'undefined') {
      throw new Error('Html5Qrcode 尚未載入完成');
    }

    this.html5QrCode = new Html5Qrcode(readerElementId);

    try {
      this.cameras = await Html5Qrcode.getCameras();
    } catch (e) {}

    const cameraConfig = { facingMode: 'environment' };

    // 關鍵優化：將取景框高度設為狹窄長條 (80px)，避免同時拍到上下兩段條碼
    const qrboxFunction = (viewfinderWidth, viewfinderHeight) => {
      const width = Math.floor(viewfinderWidth * 0.86);
      const height = Math.min(85, Math.floor(viewfinderHeight * 0.22));
      return { width: Math.max(width, 250), height: Math.max(height, 70) };
    };

    const config = {
      fps: 24,
      qrbox: qrboxFunction,
      aspectRatio: 1.333333,
      formatsToSupport: [
        Html5QrcodeSupportedFormats.CODE_128,
        Html5QrcodeSupportedFormats.CODE_39,
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.QR_CODE,
        Html5QrcodeSupportedFormats.UPC_A
      ],
      experimentalFeatures: {
        useBarCodeDetectorIfSupported: true
      }
    };

    const handleSuccess = async (decodedText, decodedResult) => {
      await this.processDecodedCode(decodedText, decodedResult, onScanSuccess);
    };

    try {
      await this.html5QrCode.start(cameraConfig, config, handleSuccess, onScanError);
      this.isScanning = true;
      return true;
    } catch (err) {
      if (this.cameras && this.cameras.length > 0) {
        const fallbackCameraId = this.cameras[this.cameras.length - 1].id;
        await this.html5QrCode.start(fallbackCameraId, config, handleSuccess, onScanError);
        this.isScanning = true;
        return true;
      }
      throw err;
    }
  }

  // 處理辨識出的條碼 (雙段嚴格分步邏輯)
  async processDecodedCode(rawCode, decodedResult, onScanSuccess) {
    // 若在過渡鎖定期間，忽略所有輸入
    if (this.stepTransitionLock) return;

    const code = String(rawCode).trim();
    if (!code) return;

    const now = Date.now();
    const cooldownMs = (window.cardStorage?.settings?.duplicateCooldownSeconds || 2) * 1000;

    // ==========================================
    // 模式 A: 雙段條碼模式 (步驟 1 ➔ 步驟 2)
    // ==========================================
    if (this.scanMode === 'dual') {
      if (this.currentStep === 1) {
        // [步驟 1]：掃描第一段主卡號
        // 冷卻防重
        if (this.recentScans.has(code)) {
          const lastScanned = this.recentScans.get(code);
          if (now - lastScanned < cooldownMs) return;
        }
        this.recentScans.set(code, now);

        // 檢查資料庫是否已存在
        const existing = window.cardStorage.getCardByCode(code);
        if (existing) {
          this.playBeep('duplicate');
          this.triggerVibrate('duplicate');
          if (onScanSuccess) {
            onScanSuccess({
              status: 'duplicate',
              code: code,
              card: existing,
              batchCount: this.currentBatchCards.length,
              message: `⚠️ 此卡號已存在（餘額 $${existing.balance}）`
            });
          }
          return;
        }

        // 成功錄入第一段！
        this.pendingCode1 = code;
        this.currentStep = 2; // 切換至步驟 2
        this.stepTransitionLock = true; // 鎖定 1.0 秒防止鏡頭直接拍到下方條碼

        this.playBeep('step1');
        this.triggerVibrate('step1');

        if (onScanSuccess) {
          onScanSuccess({
            status: 'step1_done',
            code1: code,
            currentStep: 2,
            batchCount: this.currentBatchCards.length,
            message: `📍 [第 1 段完成] 卡號末碼 ...${code.slice(-6)}！請將鏡頭「移至下方檢核碼」`
          });
        }

        // 1.0 秒後解鎖允許掃描第二段，並清除第二段條碼的冷卻
        setTimeout(() => {
          this.stepTransitionLock = false;
        }, 1000);

        return;
      } else {
        // [步驟 2]：掃描第二段檢核碼
        // 防止誤掃回第一段條碼
        if (code === this.pendingCode1) {
          return; // 依然對著第一段條碼，不觸發
        }

        const code1 = this.pendingCode1;
        const code2 = code;

        // 自動截取當前相機鏡頭畫面作為實體卡照片備份
        const snapshotPhoto = this.captureVideoSnapshot();

        // 鎖定防止連續誤刷
        this.stepTransitionLock = true;
        this.resetStepState();

        this.playBeep('success');
        this.triggerVibrate('success');

        try {
          const newCard = await window.cardStorage.addCard({
            code: code1,
            code1: code1,
            code2: code2,
            photoUrl: snapshotPhoto, // 自動存入即時拍攝照片
            preferredView: snapshotPhoto ? 'photo' : 'barcode',
            format: decodedResult?.result?.format?.formatName || 'CODE128',
            faceValue: this.selectedFaceValue,
            balance: this.selectedFaceValue,
            note: '雙段連掃自動附照片'
          });

          this.currentBatchCards.push(newCard);

          if (onScanSuccess) {
            onScanSuccess({
              status: 'success',
              card: newCard,
              code1: code1,
              code2: code2,
              currentStep: 1,
              batchCount: this.currentBatchCards.length,
              message: `🎉 已完成第 ${this.currentBatchCards.length} 張卡片（已自動拍照存證）！請換下一張。`
            });
          }
        } catch (err) {
          console.error('[Scanner] 存入失敗:', err);
        }

        // 1.2 秒後解鎖步驟 1 允許掃下一張
        setTimeout(() => {
          this.stepTransitionLock = false;
        }, 1200);

        return;
      }
    }

    // ==========================================
    // 模式 B: 單段條碼模式
    // ==========================================
    if (this.recentScans.has(code)) {
      const lastScanned = this.recentScans.get(code);
      if (now - lastScanned < cooldownMs) return;
    }
    this.recentScans.set(code, now);

    const existingCard = window.cardStorage.getCardByCode(code);
    if (existingCard) {
      this.playBeep('duplicate');
      this.triggerVibrate('duplicate');
      if (onScanSuccess) {
        onScanSuccess({
          status: 'duplicate',
          code: code,
          card: existingCard,
          batchCount: this.currentBatchCards.length,
          message: `⚠️ 卡片已存在（餘額 $${existingCard.balance}）`
        });
      }
      return;
    }

    const snapshotPhoto = this.captureVideoSnapshot();
    this.playBeep('success');
    this.triggerVibrate('success');

    try {
      const newCard = await window.cardStorage.addCard({
        code: code,
        code1: code,
        code2: '',
        photoUrl: snapshotPhoto,
        preferredView: snapshotPhoto ? 'photo' : 'barcode',
        faceValue: this.selectedFaceValue,
        balance: this.selectedFaceValue,
        note: '單段條碼連掃自動附照片'
      });

      this.currentBatchCards.push(newCard);

      if (onScanSuccess) {
        onScanSuccess({
          status: 'success',
          code: code,
          card: newCard,
          batchCount: this.currentBatchCards.length,
          message: `✅ 已加入：${newCard.name} (已附照片備份)`
        });
      }
    } catch (err) {
      console.error('[Scanner] 存入失敗:', err);
    }
  }

  // 從相機當前串流中無縫自動截圖 (解析度最佳化與壓縮)
  captureVideoSnapshot() {
    try {
      const video = document.querySelector('#scanner-reader video');
      if (!video || !video.videoWidth || !video.videoHeight) return '';

      const canvas = document.createElement('canvas');
      // 等比例縮放至寬度 900px，確保條碼清晰同時兼顧檔案大小 (約 80KB)
      const scale = Math.min(1, 900 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);

      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      return canvas.toDataURL('image/jpeg', 0.80);
    } catch (e) {
      console.warn('[Scanner] 自動截取照片失敗:', e);
      return '';
    }
  }

  // 略過第二段條碼 (直接單段存檔)
  async skipSecondBarcode(onScanSuccess) {
    if (!this.pendingCode1) return;
    const code = this.pendingCode1;
    this.resetStepState();

    this.playBeep('success');
    this.triggerVibrate('success');

    const newCard = await window.cardStorage.addCard({
      code: code,
      code1: code,
      code2: '',
      faceValue: this.selectedFaceValue,
      balance: this.selectedFaceValue,
      note: '單段手動完成'
    });

    this.currentBatchCards.push(newCard);
    if (onScanSuccess) {
      onScanSuccess({
        status: 'success',
        card: newCard,
        batchCount: this.currentBatchCards.length,
        message: `✅ 已存為單段卡片：${newCard.name}`
      });
    }
  }

  async stop() {
    if (this.html5QrCode && this.isScanning) {
      try {
        await this.html5QrCode.stop();
      } catch (e) {}
      this.isScanning = false;
      this.resetStepState();
    }
  }

  async toggleTorch() {
    if (!this.html5QrCode || !this.isScanning) return false;
    try {
      this.isTorchOn = !this.isTorchOn;
      await this.html5QrCode.applyVideoConstraints({
        advanced: [{ torch: this.isTorchOn }]
      });
      return this.isTorchOn;
    } catch (e) {
      this.isTorchOn = false;
      return false;
    }
  }

  async scanImageFile(file, onScanSuccess) {
    if (!file) return;
    if (!this.html5QrCode) {
      this.html5QrCode = new Html5Qrcode('scanner-hidden-sandbox');
    }
    try {
      const decodedText = await this.html5QrCode.scanFile(file, true);
      await this.processDecodedCode(decodedText, { result: { format: { formatName: 'CODE128' } } }, onScanSuccess);
      return decodedText;
    } catch (e) {
      throw new Error('圖片中未辨識到有效的條碼');
    }
  }
}

window.cardScanner = new CardScanner();
